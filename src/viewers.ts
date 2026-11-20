// Viewers: how a visitor proves an email address on the tours address, so that a tour shared
// with a list of addresses can be shown to them. No platform API and no web framework but
// the route table.
//
// A viewer session says one thing: "this browser proved it can read mail at this address".
// It is not an account. It has no user row, no workspace, no dashboard and no API: nothing but
// the routes here and `provedEmail`, which the tour pages call, ever reads its cookie.
//
// Two secrets are made here, both from the platform's cryptographic random source, each with
// a prefix of its own so neither is ever taken for a token ("dp_"), a sign-in code ("dpl_"),
// a session secret ("dps_") or any other code:
// - a viewer code, "dpv_" and 40 hex characters (160 random bits), mailed in the fragment of
//   `<tours origin>/view#<code>`; it works once and for VIEWER_CODE_MS, and is bound to the
//   address it was mailed to and the tour slug it was asked for (where the browser lands);
// - a viewer secret, "dpw_" and 64 hex characters (256 random bits), the value of the viewer
//   cookie. The session it names is for no one tour: each tour page asks whether its list
//   holds the proved address.
// Neither is ever stored, logged, put in an error or in the audit record: the database holds
// the SHA-256 hex digest of each (migration 0015).
//
// The viewer cookie, VIEWER_COOKIE, is a cookie of its own beside the account's session
// cookie (src/sessions.ts): another name, set and read only on the tours address (on a site
// with one address, on that address, where the two live side by side and are told apart by
// their whole name). `requireAuth` reads only the account's cookie, so a viewer cookie is
// never a credential of the API or the dashboard, and an account's cookie is never a viewer.
// A request that carries a token (an Authorization header) and the viewer cookie proves
// nothing: `provedEmail` answers null, so a restricted tour stays closed (it fails closed),
// and the viewer routes refuse any request with a token.
//
// The routes, all on the tours address (rule `tours`), JSON in and out:
// - POST /api/v1/view/request {email, slug}: always 202 {"ok":true} for a JSON object from a
//   page of this address, after the same database calls in the same order, whatever the tour
//   or the address; a link is mailed only when the gate (below) says the address may view the
//   tour, mail is on, and every limit allows. The address is never mailed more than its own
//   limits (LIMITS_VIEWER) allow, however many tours or networks ask.
// - POST /api/v1/view/check {code}: 200 {email, slug} for a live code; the one 404
//   `view_link_invalid` for a used, expired, unknown or malformed one. Changes nothing, so a
//   mail scanner that opens the link uses nothing up.
// - POST /api/v1/view/complete {code}: 200 {slug} and a viewer cookie with a new session;
//   the cookie the browser had is replaced and its session ends, never merged. The one 404
//   otherwise. Of two completions of one code exactly one wins.
// - POST /api/v1/view/signout: ends the session of the viewer cookie (its row is removed) and
//   clears the cookie; 204. Without a viewer cookie it answers 204 and sets nothing.
// - GET /api/v1/view/session: 200 {email} for a live viewer session, else 401.
// The three POSTs that carry a body, and sign-out, must come from a page of this address
// (`sameOriginChange`), and the three with a body must carry `application/json`, which no
// form of another site can send: so another site can neither complete a code into a visitor's
// browser (viewer login forgery) nor sign it out.
//
// The gate. Whether an address may view a tour is the tour's own setting, which this module
// does not hold: ViewerGate is the one question it asks, through the one registered gate
// (`useViewerGate`). Until a real one is registered every answer is no, so no viewer mail is
// ever sent.
//
// Disabling or deleting an account does not end viewer sessions or codes for the same
// address: they are not the account's. A viewer session only ever shows tours whose own list
// holds the address, which their owners decide.
import type { Hono } from "hono";
import { parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { hashToken, newId } from "./auth.ts";
import { onRole, type HostRole } from "./hosts.ts";
import { apiError, json, noContent } from "./http.ts";
import { NO_MAIL, viewerLink, viewerLinkOrigin, viewerMail } from "./mail.ts";
import { deferOf, isNotNullViolation, mailOf, type Deps } from "./ports.ts";
import { LIMITS_VIEWER, SITE_KEY, SITE_QUIET_KEY, hitLimit, recipientKey, sweepCounters, viewerPairKey, viewerWorkspaceKey } from "./rate.ts";
import { SWEEP_PAGE, cookieValues, sameOriginChange } from "./sessions.ts";
import { MAIL_REASONS, afterTheAnswer, networkLimit, ownJsonBody, padStatement, withHeader } from "./signin.ts";

/** The viewer cookie's name: not the account session's. `__Host-` makes browsers take it only Secure, with the path / and no Domain, from this one host. */
export const VIEWER_COOKIE = "__Host-dp_viewer";

/**
 * The roles whose address takes the viewer cookie: the tours address alone, where tours are
 * shown. The app address holds accounts and the img address shared media; neither reads it,
 * nor does a role added later until it is listed here. In one-address mode the one address
 * takes it. Compare SESSION_ROLES (src/sessions.ts) and CREDENTIAL_ROLES (src/auth.ts): a
 * viewer cookie is neither of those credentials.
 */
export const VIEWER_ROLES: readonly HostRole[] = ["tours"];

/** A viewer code works for 15 minutes. */
export const VIEWER_CODE_MS = 900_000;
/** A viewer session ends 30 days after its last use. */
export const VIEWER_IDLE_MS = 2_592_000_000;
/** ... and never later than 180 days after it was made (migration 0015 holds the same cap). */
export const VIEWER_MAX_MS = 15_552_000_000;
/** A session's last use and its end are written at most once in this long: once a day. */
export const VIEWER_TOUCH_MS = 86_400_000;
/** How long a code's row is kept after it ran out, before a sweep removes it. */
export const VIEWER_CODE_KEPT_MS = 86_400_000;

/** How long a browser keeps the cookie, in seconds: the session's longest life. Its real end is in the database. */
const COOKIE_MAX_AGE_S = VIEWER_MAX_MS / 1000;

/** The form of a viewer code. */
export const VIEWER_CODE_PATTERN = /^dpv_[0-9a-f]{40}$/;
/** The form of a viewer secret, the cookie's value. */
export const VIEWER_SECRET_PATTERN = /^dpw_[0-9a-f]{64}$/;
/** A slug as newSlug makes it; anything else is asked about as "", which no tour has. */
const SLUG = /^[a-z2-7]{10}$/;

const NEEDS_REQUEST = 'the body must be JSON such as {"email": "name@example.com", "slug": "…"}';
const NEEDS_CODE = 'the body must be JSON such as {"code": "…"}';

/** The sentences the routes answer with. Fixed text: never a code, an address or a slug. */
export const VIEWER_SAYS = {
  invalid: "this link no longer works; open the tour's own link again and ask for a new one",
  credentials: "send no token with this request",
  badOrigin: "this request must come from the site's own pages",
} as const;

/** The fixed log lines of asking for a viewer link. None holds an address, a slug, a code or a count. */
export const VIEWER_LINES = {
  recipient: "viewer: an address asked for more viewer links than its limit; none was sent",
  hour: "viewer: an hourly limit of viewer mails was reached; none was sent",
  notMade: "viewer: a viewer link could not be made; none was sent",
  mailFailed: "mail: a viewer mail could not be sent",
} as const;

// ---- The gate ----

/**
 * The one question this module asks about a tour. `mayRequest` allows only when `slug` names a
 * published tour of a workspace with no disabled account, that tour is restricted to a list of
 * addresses, and `email` may view it. A yes carries `workspaceKey`, an opaque key for the tour's
 * workspace that the gate derives (a digest of the workspace id, say): this module never sees a
 * workspace id, and counts the workspace's viewer mails under it. It is asked for every request
 * that reaches that point, with "" for a slug or an address that is malformed (a yes is then
 * never right), and must make the same database calls whatever it answers, so the request's
 * answer cannot be timed: one read is the expected shape.
 */
export type ViewerGate = {
  mayRequest(deps: Deps, slug: string, email: string): Promise<{ allowed: false } | { allowed: true; workspaceKey: string }>;
};

/** The gate before any is registered: no address may ask for any tour, and it asks the database nothing. */
export const NO_VIEWER_GATE: ViewerGate = { mayRequest: async () => ({ allowed: false }) };

let gate: ViewerGate = NO_VIEWER_GATE;

/** Registers the gate every later request asks; null puts back NO_VIEWER_GATE. The one place a gate is set. */
export function useViewerGate(next: ViewerGate | null): void {
  gate = next ?? NO_VIEWER_GATE;
}

// ---- The cookie ----

/** True when the viewer cookie may be used on the address this request was sent to: always in one-address mode, else only on an address of VIEWER_ROLES. */
export function viewerHost(req: Request, deps: Deps): boolean {
  return onRole(deps.config.hosts, req, VIEWER_ROLES);
}

/**
 * The Set-Cookie value that gives a browser a viewer session: host-only (no Domain), for every
 * path, over HTTPS only, hidden from scripts, not sent with another site's requests except a
 * top-level navigation, and kept as long as a session can live. Throws for anything that is
 * not a viewer secret, so nothing else can reach the header.
 */
export function viewerCookie(secret: string): string {
  if (typeof secret !== "string" || !VIEWER_SECRET_PATTERN.test(secret)) throw new Error("not a viewer secret");
  return `${VIEWER_COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
}

/** The Set-Cookie value that removes the viewer cookie at once: the same name and attributes, no value, and an end in the past. */
export function clearedViewerCookie(): string {
  return `${VIEWER_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** The viewer secret the request's cookie holds, or null unless there is exactly one cookie of that name and it is well formed. */
function readViewerCookie(req: Request): string | null {
  const values = cookieValues(req, VIEWER_COOKIE);
  return values.length === 1 && VIEWER_SECRET_PATTERN.test(values[0]) ? values[0] : null;
}

/**
 * The address the request's viewer cookie proved, or null: for an address that does not take
 * the cookie, no viewer cookie, a request that also carries a token (two credentials: neither
 * counts, so a restricted tour stays closed), two viewer cookies, a malformed one, and a
 * session that is unknown, signed out or over. The account's session cookie plays no part.
 *
 * No database call without a viewer cookie; one read with one. When the session's last use was
 * written a day ago or longer, it is written again (and its end moved to 30 days from now, never
 * past 180 days after it was made) by one more statement handed to `deps.defer`, which runs
 * after the answer: at most once a day per session, so the hottest public routes write almost
 * never.
 */
export async function provedEmail(req: Request, deps: Deps): Promise<string | null> {
  if (!viewerHost(req, deps)) return null;
  const values = cookieValues(req, VIEWER_COOKIE);
  if (values.length === 0) return null;
  if (req.headers.get("authorization") !== null) return null;
  if (values.length !== 1 || !VIEWER_SECRET_PATTERN.test(values[0])) return null;
  const now = deps.now();
  const row = await deps.db.first<{ id: string; email: string; last_used_at: number }>(
    "SELECT id, email, last_used_at FROM viewer_session WHERE hash = ? AND expires_at > ?",
    [await hashToken(values[0]), now],
  );
  if (row === null) return null;
  if (now - row.last_used_at >= VIEWER_TOUCH_MS) {
    // Started only once the current task is over, so the answer never waits for it.
    deferOf(deps)(
      afterTheAnswer().then(() =>
        deps.db.run("UPDATE viewer_session SET last_used_at = ?, expires_at = min(?, created_at + ?) WHERE id = ? AND expires_at > ? AND last_used_at <= ?", [
          now,
          now + VIEWER_IDLE_MS,
          VIEWER_MAX_MS,
          row.id,
          now,
          now - VIEWER_TOUCH_MS,
        ]),
      ),
    );
  }
  return row.email;
}

// ---- Housekeeping ----

/**
 * Removes rows nothing can use any more: sessions that are over, and codes that ran out more
 * than VIEWER_CODE_KEPT_MS ago. At most SWEEP_PAGE of each in one batch, so it can ride on a
 * request. Never rejects: a row left for the next sweep is no reason to fail a request.
 */
export async function sweepViewers(deps: Deps): Promise<void> {
  const now = deps.now();
  try {
    await deps.db.batch([
      { sql: "DELETE FROM viewer_session WHERE id IN (SELECT id FROM viewer_session WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)", params: [now, SWEEP_PAGE] },
      { sql: "DELETE FROM viewer_code WHERE id IN (SELECT id FROM viewer_code WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)", params: [now - VIEWER_CODE_KEPT_MS, SWEEP_PAGE] },
    ]);
  } catch {
    // Left for the next sweep.
  }
}

// ---- The routes ----

function randomHex(bytes: number): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The one answer for every code that cannot be used. */
function invalid(): Response {
  return apiError(404, "view_link_invalid", VIEWER_SAYS.invalid);
}

/** What the job after a link request does: write lines, and for an address that may get a link, make it and mail it. */
type LinkJob = { overRecipient: boolean; overHour: boolean; link: { to: string; slug: string; origin: string } | null };

/**
 * The work of a link request that runs after the answer, in one job, the way sign-in's job
 * does it (src/signin.ts): one write and then one batch for every request, each changing one
 * row. With a link they store its code and the audit row and then send one mail; without one
 * they add twice to sign-in's pad counter, so a request that sends nothing costs the database
 * what one that sends does. Nothing is ever tried twice.
 */
async function linkJob(deps: Deps, job: LinkJob): Promise<void> {
  await afterTheAnswer();
  if (job.overRecipient) console.error(VIEWER_LINES.recipient);
  if (job.overHour) console.error(VIEWER_LINES.hour);
  if (job.link === null) {
    try {
      // Making a code waits once for its digest before the write; so does this.
      await crypto.subtle.digest("SHA-256", crypto.getRandomValues(new Uint8Array(24)));
      const pad = padStatement(deps);
      await deps.db.run(pad.sql, pad.params);
      await deps.db.batch([padStatement(deps)]);
    } catch {
      // A pad that could not be written changes nothing anyone asked for.
    }
    return;
  }
  const { to, slug, origin } = job.link;
  let link: string;
  try {
    const code = "dpv_" + randomHex(20);
    const id = newId("vco");
    const now = deps.now();
    await deps.db.run("INSERT INTO viewer_code (id, email, slug, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [id, to, slug, await hashToken(code), now, now + VIEWER_CODE_MS]);
    await deps.db.batch([auditStatement(deps, { event: "viewer_link_sent", subject: id })]);
    link = viewerLink(origin, code);
  } catch {
    console.error(VIEWER_LINES.notMade);
    return;
  }
  try {
    await mailOf(deps).send(viewerMail(to, link));
  } catch (err) {
    // Only a mail client's own fixed word is repeated: an error's text could hold the address.
    const reason = (err as { reason?: unknown } | null)?.reason;
    console.error(`${VIEWER_LINES.mailFailed} (${typeof reason === "string" && MAIL_REASONS.includes(reason) ? reason : "failed"})`);
  }
}

/** The body of a request from a page of the tours address, and no token; or the refusal. */
async function viewerBody(req: Request, deps: Deps, needs: string): Promise<Record<string, unknown> | Response> {
  const body = await ownJsonBody(req, deps, needs, viewerHost);
  if (body instanceof Response) return body;
  if (req.headers.get("authorization") !== null) return apiError(400, "credentials_not_allowed", VIEWER_SAYS.credentials);
  return body;
}

export function viewerRoutes(app: Hono, deps: Deps): void {
  /**
   * Asks for a viewer link for a tour: `{"email": "…", "slug": "…"}`. Every JSON object from a
   * page of this address answers 202 `{"ok":true}`, a malformed address or slug included.
   *
   * Before the answer, the same database calls for every such request, in this order: with a
   * known network its count; the address's two counts and the count for the address and the
   * tour (under the address "" when it is malformed); the gate's question; the count of the
   * tour's workspace's viewer mails and the site's backstop (each under the quiet key when
   * nothing will be sent); the two sweeps. Then one job for every request, which waits until the
   * answer is out (linkJob). Neither cap says to the requester that it was reached.
   */
  app.post("/api/v1/view/request", async (c) => {
    const req = c.req.raw;
    const body = await viewerBody(req, deps, NEEDS_REQUEST);
    if (body instanceof Response) return body;
    const email = parseEmail(body.email);
    const slug = typeof body.slug === "string" && SLUG.test(body.slug) ? body.slug : "";

    const limited = await networkLimit(req, deps, LIMITS_VIEWER.linkNetwork);
    if (limited !== null) return limited;

    // Every count is made for every request, whatever the one before it says.
    const recipient = await recipientKey(email ?? "");
    const quarter = await hitLimit(deps, LIMITS_VIEWER.linkRecipient, recipient);
    const day = await hitLimit(deps, LIMITS_VIEWER.linkRecipientDay, recipient);
    const pair = await hitLimit(deps, LIMITS_VIEWER.linkPair, await viewerPairKey(email ?? "", slug));

    // The one question about the tour, asked for every request. Nothing of the answer depends on it.
    const answer = await gate.mayRequest(deps, slug, email ?? "");
    const workspace = answer.allowed === true && typeof answer.workspaceKey === "string" && answer.workspaceKey !== "" ? answer.workspaceKey : null;
    // The digest is made for every request, so a yes costs no time a no does not.
    const workspaceCounter = await viewerWorkspaceKey(workspace ?? "none");
    // The link's address comes from the settings alone, never from this request.
    const origin = viewerLinkOrigin(deps.config);
    const overRecipient = quarter.over || day.over || pair.over;
    const wanted = email !== null && slug !== "" && workspace !== null && origin !== null && mailOf(deps) !== NO_MAIL && !overRecipient;

    // The caps count only a mail about to be sent; any other request makes the same calls under the quiet key.
    // The workspace's own cap first: a workspace's owner can fill no count but their own.
    const ownCap = await hitLimit(deps, LIMITS_VIEWER.mailWorkspace, wanted ? workspaceCounter : SITE_QUIET_KEY);
    const backstop = await hitLimit(deps, LIMITS_VIEWER.mailSite, wanted && !ownCap.over ? SITE_KEY : SITE_QUIET_KEY);
    const cap = { over: ownCap.over || backstop.over };

    await sweepViewers(deps);
    await sweepCounters(deps);

    const link = wanted && !cap.over && email !== null && origin !== null ? { to: email, slug, origin } : null;
    deferOf(deps)(linkJob(deps, { overRecipient, overHour: wanted && cap.over, link }));
    return json(202, { ok: true });
  });

  /**
   * What the page a viewer link opens shows before the button is pressed: the address the code
   * was mailed to and the tour it was asked for. Changes nothing. One read.
   */
  app.post("/api/v1/view/check", async (c) => {
    const req = c.req.raw;
    const body = await viewerBody(req, deps, NEEDS_CODE);
    if (body instanceof Response) return body;
    const limited = await networkLimit(req, deps, LIMITS_VIEWER.codeNetwork);
    if (limited !== null) return limited;
    const code = body.code;
    if (typeof code !== "string" || !VIEWER_CODE_PATTERN.test(code)) return invalid();
    const found = await deps.db.first<{ email: string; slug: string }>("SELECT email, slug FROM viewer_code WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?", [
      await hashToken(code),
      deps.now(),
    ]);
    if (found === null) return invalid();
    return json(200, { email: found.email, slug: found.slug });
  });

  /**
   * Turns a viewer code into a viewer session, once, and sets the viewer cookie. One read and
   * one batch, which decides and is all-or-nothing on both targets:
   * 1. the code is marked as used by the new session's id, only while it is unused and unexpired;
   * 2. the session is inserted with the address of the code that names that id: for any other
   *    request that address is NULL, the insert fails on the NOT NULL column, and the whole
   *    batch is undone, so the address always comes from the code row, never from the request;
   * 3. the session of the cookie the browser had is removed (replaced, never merged);
   * 4. the audit row.
   * Of two requests with one code, the batch that runs second finds it used and makes nothing.
   */
  app.post("/api/v1/view/complete", async (c) => {
    const req = c.req.raw;
    const body = await viewerBody(req, deps, NEEDS_CODE);
    if (body instanceof Response) return body;
    const limited = await networkLimit(req, deps, LIMITS_VIEWER.codeNetwork);
    if (limited !== null) return limited;
    const code = body.code;
    if (typeof code !== "string" || !VIEWER_CODE_PATTERN.test(code)) return invalid();
    const codeHash = await hashToken(code);
    const now = deps.now();
    const found = await deps.db.first<{ slug: string }>("SELECT slug FROM viewer_code WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?", [codeHash, now]);
    if (found === null) return invalid();

    const sessionId = newId("vse");
    const secret = "dpw_" + randomHex(32);
    const replaces = readViewerCookie(req);
    try {
      await deps.db.batch([
        { sql: "UPDATE viewer_code SET used_at = ?, session_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?", params: [now, sessionId, codeHash, now] },
        {
          sql: "INSERT INTO viewer_session (id, email, hash, created_at, last_used_at, expires_at) VALUES (?, (SELECT email FROM viewer_code WHERE code_hash = ? AND session_id = ?), ?, ?, ?, ?)",
          params: [sessionId, codeHash, sessionId, await hashToken(secret), now, now, now + VIEWER_IDLE_MS],
        },
        ...(replaces === null ? [] : [{ sql: "DELETE FROM viewer_session WHERE hash = ?", params: [await hashToken(replaces)] }]),
        auditStatement(deps, { event: "viewer_signin", subject: sessionId }),
      ]);
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      return invalid();
    }
    return withHeader(json(200, { slug: found.slug }), "set-cookie", viewerCookie(secret));
  });

  /**
   * Ends the viewer session of this browser (its row is removed) and clears the cookie: 204.
   * A request with no viewer cookie at all answers 204 too, and sets and asks nothing.
   */
  app.post("/api/v1/view/signout", async (c) => {
    const req = c.req.raw;
    if (req.headers.get("authorization") !== null) return apiError(400, "credentials_not_allowed", VIEWER_SAYS.credentials);
    if (!sameOriginChange(req)) return apiError(403, "bad_origin", VIEWER_SAYS.badOrigin);
    if (!viewerHost(req, deps) || cookieValues(req, VIEWER_COOKIE).length === 0) return noContent();
    const secret = readViewerCookie(req);
    if (secret !== null) await deps.db.run("DELETE FROM viewer_session WHERE hash = ?", [await hashToken(secret)]);
    return withHeader(noContent(), "set-cookie", clearedViewerCookie());
  });

  /** The address this browser proved, for the pages to show "viewing as"; 401 without a live viewer session. */
  app.get("/api/v1/view/session", async (c) => {
    const req = c.req.raw;
    if (req.headers.get("authorization") !== null) return apiError(400, "credentials_not_allowed", VIEWER_SAYS.credentials);
    const email = await provedEmail(req, deps);
    if (email === null) return json(401, { error: "unauthorized" });
    return json(200, { email });
  });
}
