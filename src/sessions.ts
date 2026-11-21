// Sessions and sign-in codes: the session cookie, the anti-forgery value, the origin
// check, and making, resolving, revoking and sweeping sessions. Uses only Web Crypto,
// which both targets provide as the global `crypto`. No web framework.
//
// Two secrets are made here, both from the platform's cryptographic random source:
// - a sign-in code, "dpl_" and 40 hex characters (160 random bits), which is mailed or
//   printed, works once and for 15 minutes;
// - a session secret, "dps_" and 64 hex characters (256 random bits), which is the value
//   of the session cookie.
// Neither is ever stored, logged, put in an error or in the audit record: the database
// holds the SHA-256 hex digest of each, and a secret is found by looking its digest up.
//
// src/auth.ts imports this file and this file takes `newId` from it. Neither uses the
// other while it is being loaded (only inside functions), so the two load in either order.
import { workspaceOf } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { newId } from "./auth.ts";
import { onRole, type HostRole } from "./hosts.ts";
import { SESSION_AGE_SQL, sessionEndsAt, sessionParams } from "./lifetimes.ts";
import { isNotNullViolation, type Deps, type Stmt } from "./ports.ts";

/** The cookie's name. The `__Host-` prefix makes browsers refuse it unless it is Secure, has the path / and no Domain: it belongs to one host and no other host can set it. */
export const SESSION_COOKIE = "__Host-dp_session";
/**
 * A session ends 30 days after its last use, and never later than SESSION_MAX_DAYS after it
 * was made (src/lifetimes.ts): its stored expires_at is capped there when it is written.
 */
export const SESSION_MS = 2_592_000_000;
/** A session's last use and its end are written at most once in this long. */
export const SESSION_TOUCH_MS = 3_600_000;
/** A sign-in code works for 15 minutes. */
export const SIGNIN_CODE_MS = 900_000;
/** The most rows of each table one sweep removes. */
export const SWEEP_PAGE = 200;
/** How long a revoked session's row is kept before a sweep removes it. */
export const REVOKED_KEPT_MS = 2_592_000_000;
/** How long a sign-in code's row is kept after the code expired. */
export const CODE_KEPT_MS = 86_400_000;

/**
 * How long a browser keeps the cookie, in seconds: 400 days, the longest browsers allow.
 * The session's real end is in the database (30 days after its last use), so the cookie
 * is not set again on every request to push its own end forward.
 */
const COOKIE_MAX_AGE_S = 34_560_000;

const SECRET_PATTERN = /^dps_[0-9a-f]{64}$/;
const CODE_PATTERN = /^dpl_[0-9a-f]{40}$/;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{24}$/;
const UNKNOWN_LABEL = "Unknown browser";
/** How much of a User-Agent header is looked at. */
const AGENT_CHARS_READ = 1024;

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** A space or a tab: all that is dropped around a cookie pair, its name and its value. */
function stripBlanks(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;
  while (end > start && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  return text.slice(start, end);
}

/**
 * The values of every cookie named SESSION_COOKIE in the request, as sent.
 *
 * Read the way a browser writes the header: pairs separated by ";" and nothing else. A
 * comma is part of a value, so a cookie some other host set for the whole site as
 * `x=a,__Host-dp_session=...` stays that host's cookie `x` and is never ours; browsers
 * refuse to let another host set a cookie whose name starts with `__Host-`, and reading
 * the header any more loosely than they write it would give that protection away. Only
 * spaces and tabs around a pair are dropped (not every character `String.trim` takes),
 * and the name must be SESSION_COOKIE exactly, in its own case, with nothing decoded.
 */
function sessionCookieValues(req: Request): string[] {
  return cookieValues(req, SESSION_COOKIE);
}

/**
 * The values of every cookie named exactly `name` in the request, as sent, read by the rule
 * `sessionCookieValues` states. The viewer cookie (src/viewers.ts) is read with it too, so
 * both cookies are told apart by their whole name and nothing else.
 */
export function cookieValues(req: Request, name: string): string[] {
  const header = req.headers.get("cookie");
  if (header === null) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (stripBlanks(part.slice(0, eq)) === name) values.push(stripBlanks(part.slice(eq + 1)));
  }
  return values;
}

/**
 * True when the request carries a cookie named SESSION_COOKIE at all: one or several,
 * well-formed or not. A request that also has an Authorization header then presents two
 * credentials, whatever either is worth.
 */
export function sessionCookiePresent(req: Request): boolean {
  return sessionCookieValues(req).length > 0;
}

/**
 * The session secret the request's cookie holds, or null unless there is exactly one
 * cookie of that name and its value is a well-formed secret. Two session cookies are no
 * session, also when they are equal. Never throws.
 */
export function readSessionCookie(req: Request): string | null {
  const values = sessionCookieValues(req);
  if (values.length !== 1 || !SECRET_PATTERN.test(values[0])) return null;
  return values[0];
}

/**
 * The roles whose address takes a session cookie: the app address alone. The tours
 * address holds what users publish and the img address shared media, so neither does,
 * and nor does a role added later until it is listed here.
 */
export const SESSION_ROLES: readonly HostRole[] = ["app"];

/**
 * True when a session may be used on the address this request was sent to: always in
 * one-address mode, and with addresses configured only on an address of SESSION_ROLES.
 * The address is the request's own, never a header.
 */
export function sessionHost(req: Request, deps: Deps): boolean {
  return onRole(deps.config.hosts, req, SESSION_ROLES);
}

/**
 * The Set-Cookie value that signs a browser in. Host-only (no Domain), for every path,
 * sent over HTTPS only, hidden from scripts, and not sent with another site's requests
 * except a top-level navigation. Always Secure, also on a development host: browsers
 * take a Secure cookie from `http://localhost`, and the `__Host-` prefix requires it.
 * Throws for anything that is not a session secret, so nothing else can reach a header.
 */
export function sessionCookie(secret: string): string {
  if (typeof secret !== "string" || !SECRET_PATTERN.test(secret)) throw new Error("not a session secret");
  return `${SESSION_COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
}

/** The Set-Cookie value that removes the session cookie at once: the same name and attributes, no value, and an end in the past. */
export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * The anti-forgery value of a session: the SHA-256 hex digest of "csrf\n" and the
 * session secret. The site's own page reads it from the session answer and sends it back
 * in the X-Csrf-Token header; another site can read neither the cookie nor that answer.
 * It does not reveal the secret, and it is not the digest the database holds.
 */
export function csrfFor(secret: string): Promise<string> {
  return sha256Hex("csrf\n" + secret);
}

/** True for the development hosts that have no https: `localhost`, `*.localhost` and `127.0.0.1`, the rule `originOf` in src/hosts.ts has. */
function isLocalName(name: string): boolean {
  return name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1";
}

/**
 * True when a changing request came from a page of the host it was sent to: it has an
 * Origin header whose host (name and port) equals the request's own host, whose scheme
 * is `https:` (or `http:` on `localhost`, `*.localhost` and `127.0.0.1` only), and
 * Sec-Fetch-Site, when the browser sent it, is exactly `same-origin`. The tours address
 * is another host, so a page there fails this although the two share a site; and a page
 * of this host that was loaded without https fails it, since anyone on the network can
 * have written that page. The request's own scheme is not compared, since a proxy may
 * end TLS. No Referer and no forwarded header is read.
 */
export function sameOriginChange(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (origin === null || origin === "null") return false;
  try {
    const from = new URL(origin);
    if (from.protocol !== "https:" && !(from.protocol === "http:" && isLocalName(from.hostname))) return false;
    // An Origin is a scheme, a host and a port: anything more is not one.
    if (from.origin !== origin.toLowerCase() || from.username !== "" || from.password !== "") return false;
    return from.host === new URL(req.url).host;
  } catch {
    return false;
  }
}

const BROWSERS: readonly [RegExp, string][] = [
  // Order matters: these browsers also name the ones below them.
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/.*\bSafari\//, "Safari"],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\bAndroid\b/, "Android"],
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\b(?:Macintosh|Mac OS X)\b/, "macOS"],
  [/\b(?:Linux|X11)\b/, "Linux"],
];

/**
 * A short name for a browser, for the list of sessions: "Firefox on Linux", the browser
 * alone when the system is not known, and "Unknown browser" otherwise. It is built from
 * the fixed words above only: no version and nothing else of the User-Agent header is
 * ever copied, so the label is plain ASCII of at most 40 characters whatever was sent.
 */
export function sessionLabel(userAgent: string | null): string {
  if (typeof userAgent !== "string") return UNKNOWN_LABEL;
  const agent = userAgent.slice(0, AGENT_CHARS_READ);
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent));
  if (browser === undefined) return UNKNOWN_LABEL;
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent));
  return system === undefined ? browser[1] : `${browser[1]} on ${system[1]}`;
}

/**
 * The end a new session made at `now` is stored with: 30 days on (SESSION_MS), or
 * SESSION_MAX_DAYS on when that is sooner. src/invites.ts makes its session with it too.
 */
export function firstEnd(deps: Deps, now: number): number {
  const max = sessionEndsAt(deps.config, now);
  return max === null ? now + SESSION_MS : Math.min(now + SESSION_MS, max);
}

/**
 * Makes a sign-in code for the account and returns it; only its digest is stored. The
 * code works once, until SIGNIN_CODE_MS from now. One call. Whether the account may sign
 * in at all is decided when the code is redeemed, not here. Throws when there is no such
 * account.
 */
export async function createSignInCode(deps: Deps, userId: string): Promise<string> {
  const code = "dpl_" + randomHex(20);
  const now = deps.now();
  await deps.db.run("INSERT INTO signin_code (id, user_id, hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", [
    newId("sic"),
    userId,
    await sha256Hex(code),
    now,
    now + SIGNIN_CODE_MS,
  ]);
  return code;
}

/**
 * As `createSignInCode`, for a link mailed to `email`: the code is stored only while that
 * is still the account's address, decided inside the one statement that stores it, and null
 * is returned when it is not (nothing is then stored). So a link asked for an address the
 * account has just left, by an email change that committed between the request and this
 * call, is never made, and none can reach the old mailbox. One call either way.
 */
export async function createSignInCodeFor(deps: Deps, userId: string, email: string): Promise<string | null> {
  const code = "dpl_" + randomHex(20);
  const now = deps.now();
  const stored = await deps.db.run("INSERT INTO signin_code (id, user_id, hash, created_at, expires_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM user WHERE id = ? AND email = ?)", [
    newId("sic"),
    userId,
    await sha256Hex(code),
    now,
    now + SIGNIN_CODE_MS,
    userId,
    email,
  ]);
  return stored.changes === 1 ? code : null;
}

/**
 * Turns a sign-in code into a session, once. Returns the new session's secret (for the
 * cookie), its id and the account's id, or null when the code is malformed, unknown,
 * already used or expired, when the account is disabled or a member of no workspace, and
 * while the site has no admin. `userAgent` is the request's User-Agent header as it
 * came, or null: the stored label is made from it here by `sessionLabel`, so only that
 * function's fixed words can ever be stored, never a caller's text. `replaces` is the
 * value of the session cookie the browser already had, or null: that session ends when,
 * and only when, the new one is made.
 *
 * One read and one batch. The batch is what decides, and it is all-or-nothing on both
 * targets:
 * 1. the code is marked as used by this session's id, only while it is unused and unexpired;
 * 2. the session is inserted with the account of the code that names this session's id,
 *    and only for an active account with a workspace on a site with an admin. For any
 *    other request that account is NULL, the insert fails on the NOT NULL column and the
 *    whole batch is undone;
 * 3. the session the browser had is revoked;
 * 4. the audit row.
 * Of two requests with one code, the batch that runs second finds the code used and makes
 * nothing. A refused press of a code that exists spends it (one more call).
 */
export async function redeemSignInCode(
  deps: Deps,
  code: string,
  userAgent: string | null,
  replaces: string | null,
): Promise<{ secret: string; sessionId: string; userId: string } | null> {
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) return null;
  const codeHash = await sha256Hex(code);
  const found = await deps.db.first<{ user_id: string; workspace_id: string | null }>(
    "SELECT c.user_id, (SELECT m.workspace_id FROM membership m WHERE m.user_id = c.user_id) AS workspace_id FROM signin_code c WHERE c.hash = ?",
    [codeHash],
  );
  if (found === null) return null;

  const now = deps.now();
  const spend = () => deps.db.run("UPDATE signin_code SET used_at = ? WHERE hash = ? AND used_at IS NULL", [now, codeHash]);
  if (found.workspace_id === null) {
    await spend();
    return null;
  }

  const sessionId = newId("ses");
  const secret = "dps_" + randomHex(32);
  const label = sessionLabel(userAgent);
  const stmts: Stmt[] = [
    {
      sql: "UPDATE signin_code SET used_at = ?, session_id = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?",
      params: [now, sessionId, codeHash, now],
    },
    {
      sql: `INSERT INTO session (id, user_id, hash, label, created_at, last_used_at, expires_at)
            VALUES (?,
                    (SELECT c.user_id
                       FROM signin_code c
                       JOIN user u ON u.id = c.user_id
                       JOIN membership m ON m.user_id = u.id
                      WHERE c.hash = ? AND c.session_id = ? AND c.user_id = ? AND m.workspace_id = ?
                        AND u.status = 'active'
                        AND EXISTS (SELECT 1 FROM user WHERE is_admin = 1)),
                    ?, ?, ?, ?, ?)`,
      params: [sessionId, codeHash, sessionId, found.user_id, found.workspace_id, await sha256Hex(secret), label, now, now, firstEnd(deps, now)],
    },
  ];
  if (typeof replaces === "string" && SECRET_PATTERN.test(replaces)) {
    stmts.push({
      // The new session cannot be the one named here: its secret was made a moment ago
      // and its digest is unique in the table.
      sql: "UPDATE session SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL",
      params: [now, await sha256Hex(replaces)],
    });
  }
  stmts.push(auditStatement(deps, { event: "signin", userId: found.user_id, workspaceId: found.workspace_id, subject: sessionId }));
  try {
    await deps.db.batch(stmts);
  } catch (err) {
    if (!isNotNullViolation(err)) throw err;
    await spend();
    return null;
  }
  return { secret, sessionId, userId: found.user_id };
}

/**
 * The session the request's cookie names, with the account's one workspace, or null:
 * for no cookie, two session cookies, a malformed one, a secret nobody has, a revoked or
 * expired session, one made longer ago than SESSION_MAX_DAYS (checked here, in the one
 * lookup, from its created_at and the request's clock, so a smaller setting applies to it at
 * once; such a session is refused exactly as a revoked one), a disabled account, an account that is a member of no workspace, and
 * in two-address mode for every address but the app address. At most two calls: one read,
 * and one write when the session's last use was written an hour ago or longer.
 *
 * This says who holds the cookie and nothing more: it does not check that a changing
 * request came from the site's own page. `requireAuth` does, and is what a route calls.
 *
 * The secret itself is not handed back: nothing needs it once the session is found.
 * `csrf` is the session's anti-forgery value (`csrfFor` of the secret), which the session
 * answer gives the site's own page; it does not reveal the secret. `termsPending` is true
 * while the site's current terms wait for this account's agreement (src/terms.ts), read in
 * the same one read.
 */
export async function resolveSession(
  req: Request,
  deps: Deps,
): Promise<{ sessionId: string; userId: string; workspaceId: string; admin: boolean; csrf: string; termsPending: boolean } | null> {
  if (!sessionHost(req, deps)) return null;
  const secret = readSessionCookie(req);
  if (secret === null) return null;
  const now = deps.now();
  // The workspace comes from membership alone. An account has at most one membership (a
  // unique index holds that); should that ever change, more than one row is nobody.
  //
  // The same query says whether the site's current terms (the newest version, migration
  // 0018) still wait for this account's agreement: terms_pending is 1 only when there is a
  // version and the account has not agreed to it. Read here, from the database on every
  // request and never kept, so the gate in requireAuth costs no call and no account's state
  // can reach another's request. A database before 0018 has no terms, and so nothing waits.
  type Row = { id: string; user_id: string; last_used_at: number; is_admin: number; workspace_id: string; terms_pending?: number };
  const params = [await sha256Hex(secret), now, ...sessionParams(deps.config, now)];
  let rows: Row[];
  try {
    rows = await deps.db.all<Row>(SESSION_LOOKUP.replace("/*terms*/", TERMS_PENDING_SQL), params);
  } catch (err) {
    if (!isBeforeTerms(err)) throw err;
    rows = await deps.db.all<Row>(SESSION_LOOKUP.replace("/*terms*/", ""), params);
  }
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (now - row.last_used_at >= SESSION_TOUCH_MS) {
    // The new end is 30 days on, capped at created_at + SESSION_MAX_DAYS (no cap when that is
    // off: created_at + NULL is NULL), so the stored end stays truthful.
    const max = sessionEndsAt(deps.config, 0);
    await deps.db.run("UPDATE session SET last_used_at = ?, expires_at = min(?, coalesce(created_at + ?, ?)) WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND last_used_at <= ?", [
      now,
      now + SESSION_MS,
      max,
      now + SESSION_MS,
      row.id,
      row.user_id,
      now - SESSION_TOUCH_MS,
    ]);
  }
  return { sessionId: row.id, userId: row.user_id, workspaceId: row.workspace_id, admin: row.is_admin === 1, csrf: await csrfFor(secret), termsPending: row.terms_pending === 1 };
}

/** The lookup of resolveSession; `/*terms*\/` is where the terms column goes, or nothing. */
const SESSION_LOOKUP = `SELECT s.id, s.user_id, s.last_used_at, u.is_admin, m.workspace_id/*terms*/
       FROM session s
       JOIN user u ON u.id = s.user_id
       JOIN membership m ON m.user_id = u.id
      WHERE s.hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND ${SESSION_AGE_SQL} AND u.status = 'active'
      LIMIT 2`;

/**
 * 1 when the site has terms and the session's account has not agreed to the current version
 * (the one with the highest seq), else 0. It names the row's own account (s.user_id) only.
 */
const TERMS_PENDING_SQL = `,
            (SELECT CASE WHEN t.id IS NULL THEN 0
                         WHEN EXISTS (SELECT 1 FROM terms_agreement a WHERE a.user_id = s.user_id AND a.terms_id = t.id) THEN 0
                         ELSE 1 END
               FROM (SELECT (SELECT id FROM terms_version ORDER BY seq DESC LIMIT 1) AS id) t) AS terms_pending`;

/**
 * True for the error of a database the terms migration (0018) has not reached yet, in the
 * words each target uses: `no such table: terms_version` (Node), with D1's own prefix and
 * suffix around it on Workers. Such a database has no terms.
 */
export function isBeforeTerms(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/(?:^|: )no such table: (?:main\.)?terms_(?:version|agreement)(?:$|:| at offset )/.test(e.message)) return true;
  }
  return false;
}

/**
 * Ends one session of the account. True for the one call that ended it; false, with
 * nothing written, for another account's session id, an unknown one and one already
 * revoked, also when another call revoked it a moment before this one. `event` is what
 * the audit record calls it: "signout" for the caller's own session, "session_revoked"
 * for another of its sessions.
 *
 * One read and one batch that holds the change and its audit row. The batch decides: its
 * update writes NULL into the NOT NULL label of a session that is already revoked, which
 * fails and undoes the whole batch, so of two calls at once only the first writes the
 * time and the audit row. (A batch reports no row count, and the audit row must be
 * written with the change or not at all, so the count cannot be what decides.)
 */
export async function revokeSession(deps: Deps, userId: string, sessionId: string, event: "signout" | "session_revoked" = "session_revoked"): Promise<boolean> {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return false;
  const found = await deps.db.first<{ workspace_id: string | null }>(
    "SELECT (SELECT m.workspace_id FROM membership m WHERE m.user_id = s.user_id) AS workspace_id FROM session s WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL",
    [sessionId, userId],
  );
  if (found === null) return false;
  try {
    await deps.db.batch([
      {
        sql: "UPDATE session SET label = CASE WHEN revoked_at IS NULL THEN label ELSE NULL END, revoked_at = coalesce(revoked_at, ?) WHERE id = ? AND user_id = ?",
        params: [deps.now(), sessionId, userId],
      },
      auditStatement(deps, { event, userId, workspaceId: found.workspace_id, subject: sessionId }),
    ]);
  } catch (err) {
    if (!isNotNullViolation(err)) throw err;
    return false;
  }
  return true;
}

/**
 * Ends every session of the account that is not yet revoked, and no other account's.
 * Tokens are not sessions and are untouched. One read and one batch that holds the
 * change and its audit row.
 */
export async function revokeAll(deps: Deps, userId: string): Promise<void> {
  const workspaceId = await workspaceOf(deps, userId);
  await deps.db.batch([
    { sql: "UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", params: [deps.now(), userId] },
    auditStatement(deps, { event: "signout_everywhere", userId, workspaceId }),
  ]);
}

/**
 * Removes rows nothing can use any more: sessions that expired or are older than
 * SESSION_MAX_DAYS (src/lifetimes.ts), sessions revoked longer
 * ago than REVOKED_KEPT_MS, and sign-in codes that expired longer ago than CODE_KEPT_MS.
 * At most SWEEP_PAGE rows of each table per call, in one batch, so it can ride on a
 * request. A live session, a recently revoked one and an unexpired code are never
 * removed, and neither is any audit row.
 */
export async function sweepSessions(deps: Deps): Promise<void> {
  const now = deps.now();
  await deps.db.batch([
    {
      sql: "DELETE FROM session WHERE id IN (SELECT id FROM session s WHERE s.expires_at <= ? OR NOT " + SESSION_AGE_SQL + " OR (s.revoked_at IS NOT NULL AND s.revoked_at <= ?) LIMIT ?)",
      params: [now, ...sessionParams(deps.config, now), now - REVOKED_KEPT_MS, SWEEP_PAGE],
    },
    {
      sql: "DELETE FROM signin_code WHERE id IN (SELECT id FROM signin_code WHERE expires_at <= ? LIMIT ?)",
      params: [now - CODE_KEPT_MS, SWEEP_PAGE],
    },
  ]);
}
