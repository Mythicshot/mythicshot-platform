// API tokens, ids, slugs and the request guard. Uses only Web Crypto, which both
// targets provide as the global `crypto`.
//
// `requireAuth` is the only way a route learns its caller. It takes one credential, a
// token or a session cookie, and resolves it to exactly one workspace.
import { isBeforeAccounts } from "./accounts.ts";
import { onRole, type HostRole } from "./hosts.ts";
import { json } from "./http.ts";
import type { Deps } from "./ports.ts";
import { csrfFor, readSessionCookie, resolveSession, sameOriginChange, sessionCookiePresent, sessionHost } from "./sessions.ts";

/**
 * Who a request is. `workspaceId` is the one workspace it may act in. `tokenId` is the
 * token's id, and empty for a session. `session` is present only for a session: its id,
 * its account, and whether that account is a site admin.
 */
export type Auth = { workspaceId: string; tokenId: string; session?: { id: string; userId: string; admin: boolean } };

/**
 * The roles whose address takes any credential, a token or a session: the tours and the
 * app address (a session only the app address: SESSION_ROLES). The img address serves
 * shared media to anyone and takes none, nor does a role added later until it is listed.
 */
export const CREDENTIAL_ROLES: readonly HostRole[] = ["tours", "app"];

/** The header a page sends the anti-forgery value in. */
const CSRF_HEADER = "x-csrf-token";

const TOKEN_PATTERN = /^dp_[0-9a-f]{40}$/;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A new API token: "dp_" and 40 lowercase hex characters (160 random bits). */
export function newToken(): string {
  return "dp_" + hex(randomBytes(20));
}

/** The SHA-256 hex digest of the token, the only form in which a token is stored. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

/** A new row id: the prefix, "_" and 24 lowercase hex characters (96 random bits). */
export function newId(prefix: "ws" | "usr" | "tok" | "tour" | "ch" | "st" | "up" | "ses" | "sic" | "emc" | "med" | "crq" | "inv"): string {
  return prefix + "_" + hex(randomBytes(12));
}

/** `n` characters from a-z and 2-7, each 5 random bits. */
function slugOf(n: number): string {
  // 256 is a multiple of 32, so masking each byte keeps every character equally likely.
  let s = "";
  for (const b of randomBytes(n)) s += SLUG_ALPHABET[b & 31];
  return s;
}

/** A new public slug: 10 characters from a-z and 2-7 (50 random bits). */
export function newSlug(): string {
  return slugOf(10);
}

/**
 * A new public name for a shared item: 20 characters from the alphabet of newSlug (100
 * random bits). Random by itself, never made from the item's id or anything else.
 */
export function newLinkId(): string {
  return slugOf(20);
}

/**
 * True when the strings are equal. Runs through every character of the longer string
 * whatever the inputs, so the time taken does not reveal where they first differ.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** The one answer for a missing, malformed, unknown, expired or revoked credential. */
function unauthorized(): Response {
  return new Response('{"error":"unauthorized"}', {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

// The three refusals new with sessions (this one and the two 403s below) are built with
// json, in the shape apiError gives: the API description gains their codes in the merge
// that adds the session routes, and its test counts the modules that call apiError.

/** A token and a session cookie in one request: never resolved, whatever either is worth. */
function mixedCredentials(): Response {
  return json(400, { error: "mixed_credentials", detail: "send a token or a session cookie, not both" });
}

/** What an admin route answers to everyone who is not a signed-in admin. */
function notFound(): Response {
  return json(404, { error: "not_found" });
}

/**
 * Resolves the request's one credential to its workspace, or answers a refusal. This is
 * the only way a route learns its caller.
 *
 * In this order:
 * 0. With addresses configured, a request sent to an address outside CREDENTIAL_ROLES
 *    (the img address) is the one 401 before anything else is read. The host gate keeps
 *    every credential route off that address already; this holds without it.
 * 1. With `only: "token"` no cookie is looked at: the Authorization header is judged
 *    alone, exactly as in the version before sessions, and without one the answer is the
 *    401. The setup wizard's own page asks this way, and a cookie left in the browser
 *    must not break it.
 * 2. An Authorization header together with a session cookie (any cookie of that name,
 *    well-formed or not) is 400 `mixed_credentials`. Nothing is looked up.
 * 3. With an Authorization header: `Bearer <token>` resolves to the token's workspace
 *    and, unless `touch` is false, records when the token was last used. A token is
 *    refused when it is malformed, unknown or revoked, and when an account of its
 *    workspace is disabled. `only: "session"` refuses every token, with no lookup.
 * 4. With a session cookie: with addresses configured it counts only on the app address. For
 *    any method but GET and HEAD the request must come from a page of this host
 *    (`sameOriginChange`, else 403 `bad_origin`) and carry the session's anti-forgery
 *    value in X-Csrf-Token (else 403 `bad_csrf`); both are decided from the request
 *    alone, before the database is asked. Then the session must be live, of an active
 *    account, and that account a member of a workspace: that one workspace is the answer.
 * 5. Anything else, and every refusal not named above, is the one 401.
 *
 * `admin: true` takes only the session of a site admin, and every refusal there, the 400
 * and the two 403s too, is the one 404 `not_found` a member gets: an admin route says
 * nothing about itself to anyone else.
 *
 * No token, cookie, code or digest is ever logged or put in an answer: only digests
 * reach the database.
 */
export async function requireAuth(
  req: Request,
  deps: Deps,
  opts: { touch?: boolean; only?: "token" | "session"; admin?: boolean } = {},
): Promise<Auth | Response> {
  if (opts.admin === true) {
    const who = await callerOf(req, deps, { touch: opts.touch, only: "session" });
    return who instanceof Response || who.session?.admin !== true ? notFound() : who;
  }
  return callerOf(req, deps, opts);
}

/** `requireAuth` without the admin rule: the caller, or the refusal a route that is no admin route answers. */
async function callerOf(req: Request, deps: Deps, opts: { touch?: boolean; only?: "token" | "session" }): Promise<Auth | Response> {
  if (!onRole(deps.config.hosts, req, CREDENTIAL_ROLES)) return unauthorized();
  const header = req.headers.get("authorization");
  // Before any cookie is read: a token-only route has no session to mix a token with.
  if (opts.only === "token") return tokenAuth(header ?? "", deps, opts.touch !== false);
  const cookie = sessionCookiePresent(req);
  if (header !== null && cookie) return mixedCredentials();
  if (cookie) return sessionAuth(req, deps);
  if (opts.only === "session") return unauthorized();
  return tokenAuth(header ?? "", deps, opts.touch !== false);
}

/** The session path of `requireAuth`: the request has a session cookie and no Authorization header. */
async function sessionAuth(req: Request, deps: Deps): Promise<Auth | Response> {
  if (!sessionHost(req, deps)) return unauthorized();
  const secret = readSessionCookie(req);
  if (secret === null) return unauthorized();
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (!sameOriginChange(req)) return json(403, { error: "bad_origin", detail: "this request must come from the site's own pages" });
    // Both sides are digests of one length; the comparison still takes the same time
    // wherever they differ.
    if (!constantTimeEqual(req.headers.get(CSRF_HEADER) ?? "", await csrfFor(secret))) {
      return json(403, { error: "bad_csrf", detail: "the anti-forgery header is missing or wrong" });
    }
  }
  const session = await resolveSession(req, deps);
  if (session === null) return unauthorized();
  return { workspaceId: session.workspaceId, tokenId: "", session: { id: session.sessionId, userId: session.userId, admin: session.admin } };
}

/**
 * The token path of `requireAuth`, as it has always been, with one more condition in the
 * lookup: no account of the token's workspace is disabled. An account belongs to a
 * workspace by its membership or, for a row an older build wrote without one, by the
 * workspace its own row names. A workspace with no account at all still resolves.
 */
const TOKEN_LOOKUP_BEFORE_ACCOUNTS = "SELECT id, workspace_id, hash FROM api_token WHERE hash = ? AND revoked_at IS NULL";
const TOKEN_LOOKUP =
  TOKEN_LOOKUP_BEFORE_ACCOUNTS +
  " AND NOT EXISTS (SELECT 1 FROM user u WHERE u.status = 'disabled'" +
  " AND (u.workspace_id = api_token.workspace_id OR u.id IN (SELECT m.user_id FROM membership m WHERE m.workspace_id = api_token.workspace_id)))";

async function tokenAuth(header: string, deps: Deps, touch: boolean): Promise<Auth | Response> {
  const sp = header.indexOf(" ");
  const scheme = sp < 0 ? "" : header.slice(0, sp);
  const token = sp < 0 ? "" : header.slice(sp + 1);
  if (scheme.toLowerCase() !== "bearer" || !TOKEN_PATTERN.test(token)) return unauthorized();

  // The lookup compares SHA-256 digests, not the token, so its timing tells a caller
  // nothing useful about any stored token; the row's hash is compared again in
  // constant time before it is trusted.
  const hash = await hashToken(token);
  type Row = { id: string; workspace_id: string; hash: string };
  let row: Row | null;
  try {
    row = await deps.db.first<Row>(TOKEN_LOOKUP, [hash]);
  } catch (err) {
    // A database the accounts migration has not reached yet (a build started before its
    // migration ran) has no account that could be disabled, so the lookup of the version
    // before accounts is the whole rule there. Any other failure is a failure.
    if (!isBeforeAccounts(err)) throw err;
    row = await deps.db.first<Row>(TOKEN_LOOKUP_BEFORE_ACCOUNTS, [hash]);
  }
  if (row === null || !constantTimeEqual(row.hash, hash)) return unauthorized();

  if (touch) {
    await deps.db.run("UPDATE api_token SET last_used_at = ? WHERE id = ? AND workspace_id = ?", [
      deps.now(),
      row.id,
      row.workspace_id,
    ]);
  }
  return { workspaceId: row.workspace_id, tokenId: row.id };
}
