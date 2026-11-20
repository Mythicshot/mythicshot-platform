// Connecting the desktop app to a workspace with a pair of codes, the way a television signs
// in: the app asks for the codes, shows the short one and opens the dashboard; a signed-in
// person types the short code there and confirms; the app, which has been asking with the
// long secret code all along, then receives a token for that person's workspace, once.
//
// The two codes:
// - the device code, "dpd_" and 40 hex characters (160 random bits), a prefix of its own so it
//   is never taken for a token ("dp_"), a sign-in code ("dpl_") or an email-change code
//   ("dpe_"). Only the app ever holds it. Stored as its SHA-256 digest, as tokens are.
// - the user code, 8 characters from USER_CODE_ALPHABET, shown as XXXX-XXXX. It is typed by a
//   person, so it is short: 30^8, about 2^39 codes. Stored as an HMAC-SHA256 under the
//   install's own random key (table connect_key, made by migration 0011), so a copy of the
//   table cannot be read back by looking its values up in a table made once for every
//   install: a search must start after the copy was taken, for this install alone, and is
//   worth something only while the code is open, for at most CONNECT_MS. Guessing online is
//   held off by the wrong-try limits (LIMITS_CONNECT in src/rate.ts).
// Neither code is ever put in a URL, a log line or the audit record.
//
// The routes:
// - POST /api/v1/connect/start and POST /api/v1/connect/token are for the app, which has no
//   credential yet: a request that carries one (an Authorization header or a session cookie)
//   is refused with 400 `credentials_not_allowed`, the way a request with both credentials is
//   refused with `mixed_credentials`, so no client comes to rely on sending one. They answer on
//   the tours and the app address, whichever the app is set up with.
// - GET /api/v1/connect/requests/:code, POST /api/v1/connect/confirm and POST
//   /api/v1/connect/refuse are for the dashboard: a session alone (a token is the one 401),
//   with the anti-forgery header for a change, on the app address.
//
// The token is made when the app collects it, in the one batch that marks the request
// collected, never at confirmation: a confirmed request nobody collects leaves no token, and
// of two collections at once only one can make it (the request's token id is the token's
// primary key, and the batch is guarded). Confirming picks the token's id, so the record of
// the confirmation can name it.
//
// Every answer to a device code that cannot give a token (unknown, expired, refused, already
// collected, or not a device code at all) is the one 410 `expired_code`, byte for byte, after
// the same database calls: the network's count and one read.
import type { Hono } from "hono";
import { auditStatement } from "./audit.ts";
import { hashToken, newId, newToken, requireAuth } from "./auth.ts";
import { clientAddressOf } from "./client.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { linkOrigin } from "./mail.ts";
import { isNotNullViolation, isUniqueViolation, type Deps } from "./ports.ts";
import { LIMITS_CONNECT, accountKey, hitLimit, hitLimitRefundable, networkKey, refundStatement, sweepCounters, type CountedHit, type Limit } from "./rate.ts";
import { sessionCookiePresent } from "./sessions.ts";
import { ownJsonBody, withHeader } from "./signin.ts";
import { VERSION } from "./version.ts";

/** How long a request lives: 10 minutes. */
export const CONNECT_MS = 600_000;
/** How often the app may ask for the token, in seconds. */
export const POLL_INTERVAL_S = 5;
/** The shortest gap between two asks that is not `slow_down`: the interval less a second, for a clock that runs a little fast. */
export const POLL_GAP_MS = 4_000;
/** Open requests (neither refused nor collected, not expired) one network may have at once. */
export const OPEN_PER_NETWORK = 5;
/** Open requests all callers whose network is not known may have at once, together. */
export const OPEN_UNKNOWN_NETWORK = 100;
/** The most expired requests one sweep removes. */
export const CONNECT_SWEEP_PAGE = 50;
/** The longest device name, in characters. */
export const DEVICE_NAME_MAX = 60;
/** The dashboard's connect page, where a person types the short code. */
export const VERIFY_PATH = "/connect";

/**
 * The user code's characters: the capital letters and digits without the ones that look
 * alike or are read alike, so a code read off a screen is typed right. Left out: 0 and O, 1,
 * I and L, and U (taken for V). 30 characters, so 8 of them are about 39 bits.
 */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export const DEVICE_CODE_PATTERN = /^dpd_[0-9a-f]{40}$/;

/** The longest body the routes here read: a device name is at most 240 bytes, a code 44 characters. */
const MAX_BODY_BYTES = 2048;

const NEEDS_NAME = 'the body must be JSON such as {"device_name": "Work laptop"}';
const NEEDS_DEVICE_CODE = 'the body must be JSON such as {"device_code": "…"}';
const NEEDS_USER_CODE = 'the body must be JSON such as {"user_code": "ABCD-EFGH"}';

/** The sentences the routes answer with. Fixed text: never a code or a name. */
export const CONNECT_SAYS = {
  credentials: "send no token and no session cookie with this request",
  badName: "the device name must be 1 to 60 characters of text, without control or formatting characters",
  rateLimited: "too many requests; wait a few minutes and try again",
  tooManyOpen: "this network has too many requests waiting to be confirmed; finish one, or wait until one expires",
  expired: "this code has expired or was already used; start again",
  slowDown: `ask at most once every ${POLL_INTERVAL_S} seconds`,
  noRequest: "no such request",
} as const;

// Control characters, formatting characters (zero-width characters, bidi controls, the
// BOM, the soft hyphen), lone surrogates and the line and paragraph separators.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * A device name or a token's name as it is stored: trimmed, 1 to DEVICE_NAME_MAX characters
 * (code points), with no control, formatting or separator character. Null for anything else.
 * It is only ever shown as text.
 */
export function parseDeviceName(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 4 * DEVICE_NAME_MAX + 64) return null;
  const name = v.trim();
  const chars = [...name].length;
  if (chars < 1 || chars > DEVICE_NAME_MAX || HIDDEN.test(name)) return null;
  return name;
}

/** A new user code: 8 characters of USER_CODE_ALPHABET, each equally likely. */
export function newUserCode(): string {
  let s = "";
  while (s.length < 8) {
    // 240 is 8 × 30: bytes from 240 up are dropped, so every character is equally likely.
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 240 && s.length < 8) s += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
    }
  }
  return s;
}

/** A user code as it is shown: XXXX-XXXX. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A user code as typed, in its one stored form (8 capitals, no dash), or null: outer blanks
 * dropped, any case, with or without the one dash in the middle. Only ASCII is looked at, so
 * no other letter can be turned into one of the alphabet by changing its case.
 */
export function parseUserCode(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 32) return null;
  let s = v.trim();
  if (!/^[\x21-\x7e]+$/.test(s)) return null;
  s = s.toUpperCase();
  if (s.length === 9 && s[4] === "-") s = s.slice(0, 4) + s.slice(5);
  if (s.length !== 8) return null;
  for (const ch of s) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** The key type Web Crypto gives, named the same way on both targets' type libraries. */
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The install's HMAC key for user codes. One database call. Throws when the row is missing or broken: a code must never be stored under no key. */
async function codeKey(deps: Deps): Promise<HmacKey> {
  const row = await deps.db.first<{ key: string }>("SELECT key FROM connect_key WHERE id = 1");
  if (row === null || typeof row.key !== "string" || !/^[0-9a-f]{64}$/.test(row.key)) throw new Error("connect: no key");
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = Number.parseInt(row.key.slice(2 * i, 2 * i + 2), 16);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** The stored form of a user code (as parseUserCode gives it): 64 hex characters. */
async function userCodeHash(key: HmacKey, code: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("connect user code\n" + code))));
}

/** The 401 of `requireAuth`, for a session that resolved without its part (never, in practice). */
function unauthorized(): Response {
  return new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The one answer to every device code that cannot give a token. */
function expired(): Response {
  return apiError(410, "expired_code", CONNECT_SAYS.expired);
}

/** The one answer to every short code that names no open request, also another workspace's. */
function noRequest(): Response {
  return apiError(404, "not_found", CONNECT_SAYS.noRequest);
}

function tooMany(retryAfterSeconds: number, detail: string = CONNECT_SAYS.rateLimited): Response {
  return withHeader(apiError(429, "rate_limited", detail), "retry-after", String(retryAfterSeconds));
}

/** True when the request carries any credential: an Authorization header or a session cookie, whatever either is worth. */
function carriesCredential(req: Request): boolean {
  return req.headers.get("authorization") !== null || sessionCookiePresent(req);
}

/** The body of a request from the app: labelled JSON, a JSON object of at most MAX_BODY_BYTES. */
async function appJsonBody(req: Request, needs: string): Promise<Record<string, unknown> | Response> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return apiError(400, "bad_request", needs);
  const bytes = await readCapped(req, MAX_BODY_BYTES);
  if (bytes === "too_large") return apiError(400, "bad_request", needs);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return apiError(400, "bad_request", needs);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return apiError(400, "bad_request", needs);
  return body as Record<string, unknown>;
}

/** Counts one request of a known network against each limit, every one counted; 429 when any is over. A network that is not known is not counted. */
async function countNetwork(deps: Deps, network: string | null, limits: Limit[]): Promise<Response | null> {
  if (network === null) return null;
  const counted = [];
  for (const limit of limits) counted.push(await hitLimit(deps, limit, network));
  const over = counted.filter((x) => x.over);
  return over.length > 0 ? tooMany(Math.max(...over.map((x) => x.retryAfterSeconds))) : null;
}

/**
 * Counts one try of a short code, before anything is looked up: first against the account,
 * and only when the account is not over, against its network (so an account that is over
 * adds nothing to its network's count and cannot fill it for others); when the network is
 * over, the account's count is given back. Answers the hits, to be given back once the code
 * turns out right, or the 429.
 */
async function countTry(req: Request, deps: Deps, userId: string): Promise<CountedHit[] | Response> {
  const account = await hitLimitRefundable(deps, LIMITS_CONNECT.wrongAccount, await accountKey(userId));
  if (account.over) return tooMany(account.retryAfterSeconds);
  const network = await networkKey(clientAddressOf(req));
  if (network === null) return [account];
  const net = await hitLimitRefundable(deps, LIMITS_CONNECT.wrongNetwork, network);
  if (net.over) {
    const back = refundStatement(account);
    await deps.db.run(back.sql, back.params);
    return tooMany(net.retryAfterSeconds);
  }
  return [account, net];
}

/** Removes up to CONNECT_SWEEP_PAGE expired requests, the oldest first. Never rejects: a row left is for the next sweep. */
async function sweepRequests(deps: Deps): Promise<void> {
  try {
    await deps.db.run("DELETE FROM connect_request WHERE id IN (SELECT id FROM connect_request WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)", [deps.now(), CONNECT_SWEEP_PAGE]);
  } catch {
    // Left for the next sweep.
  }
}

/** The request a short code names while it is open: neither confirmed nor refused, and not expired. */
const OPEN_BY_CODE = "FROM connect_request WHERE user_code_hash = ? AND confirmed_at IS NULL AND refused_at IS NULL AND expires_at > ?";

export function connectRoutes(app: Hono, deps: Deps): void {
  /**
   * Starts a request: the device code, the user code and where to type it. verify_url is the
   * dashboard's connect page on the address from the settings (the app address, else
   * SITE_HOST), never one taken from the request; with neither it is the bare path, which
   * the app joins to the address it is set up with. Neither code is put in it.
   *
   * Counted per network (10 in 15 minutes, 40 in a day), and a network may have
   * OPEN_PER_NETWORK requests open at once (callers whose network is not known,
   * OPEN_UNKNOWN_NETWORK together), decided in the one statement that stores the request.
   * Expired requests and old counters are swept, a few at a time.
   */
  app.post("/api/v1/connect/start", async (c) => {
    const req = c.req.raw;
    if (carriesCredential(req)) return apiError(400, "credentials_not_allowed", CONNECT_SAYS.credentials);
    const body = await appJsonBody(req, NEEDS_NAME);
    if (body instanceof Response) return body;
    const name = parseDeviceName(body.device_name);
    if (name === null) return apiError(400, "bad_device_name", CONNECT_SAYS.badName);

    const network = await networkKey(clientAddressOf(req));
    const limited = await countNetwork(deps, network, [LIMITS_CONNECT.startNetwork, LIMITS_CONNECT.startNetworkDay]);
    if (limited !== null) return limited;

    const key = await codeKey(deps);
    const now = deps.now();
    let made: { deviceCode: string; userCode: string } | null = null;
    // A user code another request has is refused by the unique index, and another is drawn.
    for (let attempt = 0; attempt < 3 && made === null; attempt++) {
      const deviceCode = "dpd_" + hex(crypto.getRandomValues(new Uint8Array(20)));
      const userCode = newUserCode();
      try {
        const stored = await deps.db.run(
          `INSERT INTO connect_request (id, device_code_hash, user_code_hash, device_name, network_key, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE (SELECT count(*) FROM connect_request WHERE network_key IS ? AND expires_at > ? AND refused_at IS NULL AND collected_at IS NULL) < ?`,
          [newId("crq"), await hashToken(deviceCode), await userCodeHash(key, userCode), name, network, now, now + CONNECT_MS, network, now, network === null ? OPEN_UNKNOWN_NETWORK : OPEN_PER_NETWORK],
        );
        if (stored.changes !== 1) return tooMany(CONNECT_MS / 1000, CONNECT_SAYS.tooManyOpen);
        made = { deviceCode, userCode };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    if (made === null) throw new Error("connect: no free user code");

    await sweepRequests(deps);
    await sweepCounters(deps);

    const origin = linkOrigin(deps.config);
    return json(201, {
      device_code: made.deviceCode,
      user_code: formatUserCode(made.userCode),
      verify_url: (origin ?? "") + VERIFY_PATH,
      expires_in: CONNECT_MS / 1000,
      interval: POLL_INTERVAL_S,
    });
  });

  /**
   * Asks for the token with the device code. Pending until a person confirms; then the token,
   * made now, once; 410 `expired_code` for every code that cannot give one. Asking again
   * within POLL_GAP_MS of the last ask of an open request is 429 `slow_down`, and nothing is
   * looked at or changed; that answer only ever goes to a code that is open, which is what
   * `pending` says already, so it tells nothing more. Counted per network.
   */
  app.post("/api/v1/connect/token", async (c) => {
    const req = c.req.raw;
    if (carriesCredential(req)) return apiError(400, "credentials_not_allowed", CONNECT_SAYS.credentials);
    const body = await appJsonBody(req, NEEDS_DEVICE_CODE);
    if (body instanceof Response) return body;
    const given = body.device_code;
    const wellFormed = typeof given === "string" && DEVICE_CODE_PATTERN.test(given);

    const limited = await countNetwork(deps, await networkKey(clientAddressOf(req)), [LIMITS_CONNECT.pollNetwork]);
    if (limited !== null) return limited;

    // A code that is not one is looked up all the same, by the digest of the empty text, which
    // no request has: the same calls as for any code nobody has.
    const hash = await hashToken(wellFormed ? given : "");
    const now = deps.now();
    type Row = { id: string; confirmed_at: number | null; last_poll_at: number | null; confirmed_by: string | null; workspace_id: string | null; token_id: string | null; workspace_name: string | null };
    const row = await deps.db.first<Row>(
      `SELECT r.id, r.confirmed_at, r.last_poll_at, r.confirmed_by, r.workspace_id, r.token_id, w.name AS workspace_name
         FROM connect_request r
         LEFT JOIN workspace w ON w.id = r.workspace_id
        WHERE r.device_code_hash = ? AND r.expires_at > ? AND r.refused_at IS NULL AND r.collected_at IS NULL`,
      [hash, now],
    );
    if (row === null) return expired();
    if (row.last_poll_at !== null && now - row.last_poll_at < POLL_GAP_MS) {
      return withHeader(apiError(429, "slow_down", CONNECT_SAYS.slowDown), "retry-after", String(POLL_INTERVAL_S));
    }
    if (row.confirmed_at === null || row.confirmed_by === null || row.workspace_id === null || row.token_id === null) {
      await deps.db.run("UPDATE connect_request SET last_poll_at = ? WHERE id = ? AND collected_at IS NULL", [now, row.id]);
      return json(200, { status: "pending" });
    }

    // The token is made here, in the batch that marks the request collected:
    // 1. the token row, named by the id confirming picked, for the confirmed workspace, only
    //    while the request is confirmed, uncollected, not refused and not expired, and its
    //    confirming account is active, a member of that workspace, and no account of the
    //    workspace is disabled (the rule a token's lookup has);
    // 2. the record, which is also the guard: unless 1 made exactly one row, it fails and the
    //    whole batch is undone;
    // 3. the request is marked collected.
    // Of two collections at once the second finds the request collected (and the token's id
    // taken) and makes nothing.
    const token = newToken();
    try {
      await deps.db.batch([
        {
          sql: `INSERT INTO api_token (id, workspace_id, name, hash, created_at, kind)
                SELECT r.token_id, r.workspace_id, r.device_name, ?, ?, 'sign_in'
                  FROM connect_request r
                  JOIN user u ON u.id = r.confirmed_by
                  JOIN membership m ON m.user_id = u.id AND m.workspace_id = r.workspace_id
                 WHERE r.id = ? AND r.confirmed_at IS NOT NULL AND r.refused_at IS NULL AND r.collected_at IS NULL AND r.expires_at > ?
                   AND u.status = 'active'
                   AND NOT EXISTS (SELECT 1 FROM user d WHERE d.status = 'disabled'
                                     AND (d.workspace_id = r.workspace_id OR d.id IN (SELECT m2.user_id FROM membership m2 WHERE m2.workspace_id = r.workspace_id)))`,
          params: [await hashToken(token), now, row.id, now],
        },
        auditStatement(deps, { event: "connection_collected", userId: row.confirmed_by, workspaceId: row.workspace_id, subject: row.token_id, detail: { request: row.id } }, { onlyAfterOneChange: true }),
        { sql: "UPDATE connect_request SET collected_at = ?, last_poll_at = ? WHERE id = ? AND collected_at IS NULL", params: [now, now, row.id] },
      ]);
    } catch (err) {
      if (isNotNullViolation(err) || isUniqueViolation(err)) return expired();
      throw err;
    }
    const hosts = deps.config.hosts ?? null;
    return json(200, {
      status: "connected",
      token,
      workspace: { id: row.workspace_id, name: row.workspace_name },
      version: VERSION,
      ...(hosts === null ? {} : { addresses: { tours: hosts.tours, app: hosts.app } }),
    });
  });

  /**
   * What the dashboard shows before a person confirms: the device's name and when it asked,
   * for an open request (neither confirmed nor refused, not expired) and nothing else; every
   * other code, and one that is not a code, is the one 404. Each lookup counts as a wrong try
   * until it is found right.
   */
  app.get("/api/v1/connect/requests/:code", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const tries = await countTry(req, deps, auth.session.userId);
    if (tries instanceof Response) return tries;
    const code = parseUserCode(c.req.param("code"));
    if (code === null) return noRequest();
    const row = await deps.db.first<{ device_name: string; created_at: number }>(`SELECT device_name, created_at ${OPEN_BY_CODE}`, [await userCodeHash(await codeKey(deps), code), deps.now()]);
    if (row === null) return noRequest();
    await deps.db.batch(tries.map(refundStatement));
    return json(200, { device_name: row.device_name, asked_at: row.created_at });
  });

  /**
   * Settles an open request once, for the caller: confirm binds it to the caller's account
   * and its one workspace, and picks the id its token will have; refuse ends it. The change,
   * its record (which guards it: unless the change was made, nothing is) and the giving back
   * of the try are one batch. Every code that names no open request, also one settled a
   * moment ago by someone else, is the one 404, and nothing changes.
   */
  const settle = (how: "confirm" | "refuse") => async (c: { req: { raw: Request } }) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const body = await ownJsonBody(req, deps, NEEDS_USER_CODE);
    if (body instanceof Response) return body;
    const userId = auth.session.userId;
    const tries = await countTry(req, deps, userId);
    if (tries instanceof Response) return tries;
    const code = parseUserCode(body.user_code);
    if (code === null) return noRequest();
    const hash = await userCodeHash(await codeKey(deps), code);
    const now = deps.now();
    const row = await deps.db.first<{ id: string }>(`SELECT id ${OPEN_BY_CODE}`, [hash, now]);
    if (row === null) return noRequest();
    const open = "id = ? AND confirmed_at IS NULL AND refused_at IS NULL AND expires_at > ?";
    // The caller's account must still be active and a member of the workspace the session resolved to.
    const active = "EXISTS (SELECT 1 FROM user u JOIN membership m ON m.user_id = u.id WHERE u.id = ? AND m.workspace_id = ? AND u.status = 'active')";
    const tokenId = newId("tok");
    const change =
      how === "confirm"
        ? {
            sql: `UPDATE connect_request SET confirmed_at = ?, confirmed_by = ?, workspace_id = ?, token_id = ? WHERE ${open} AND ${active}`,
            params: [now, userId, auth.workspaceId, tokenId, row.id, now, userId, auth.workspaceId],
          }
        : { sql: `UPDATE connect_request SET refused_at = ? WHERE ${open} AND ${active}`, params: [now, row.id, now, userId, auth.workspaceId] };
    const record =
      how === "confirm"
        ? auditStatement(deps, { event: "connection_confirmed", userId, workspaceId: auth.workspaceId, subject: tokenId, detail: { request: row.id } }, { onlyAfterOneChange: true })
        : auditStatement(deps, { event: "connection_refused", userId, workspaceId: auth.workspaceId, subject: row.id }, { onlyAfterOneChange: true });
    try {
      await deps.db.batch([change, record, ...tries.map(refundStatement)]);
    } catch (err) {
      if (isNotNullViolation(err)) return noRequest();
      throw err;
    }
    return noContent();
  };
  app.post("/api/v1/connect/confirm", settle("confirm"));
  app.post("/api/v1/connect/refuse", settle("refuse"));
}
