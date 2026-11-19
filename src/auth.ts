// API tokens, ids, slugs and the request guard. Uses only Web Crypto, which both
// targets provide as the global `crypto`.
//
// `requireAuth` is the only way a route learns its caller. It takes one credential, a
// token or a session cookie, and resolves it to exactly one workspace.
import { json } from "./http.ts";
import type { Deps } from "./ports.ts";
import { csrfFor, readSessionCookie, resolveSession, sameOriginChange, sessionCookiePresent, sessionHost } from "./sessions.ts";

/**
 * Who a request is. `workspaceId` is the one workspace it may act in. `tokenId` is the
 * token's id, and empty for a session. `session` is present only for a session: its id,
 * its account, and whether that account is a site admin.
 */
export type Auth = { workspaceId: string; tokenId: string; session?: { id: string; userId: string; admin: boolean } };

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
export function newId(prefix: "ws" | "usr" | "tok" | "tour" | "ch" | "st" | "up"): string {
  return prefix + "_" + hex(randomBytes(12));
}

/** A new public slug: 10 characters from a-z and 2-7 (50 random bits). */
export function newSlug(): string {
  // 256 is a multiple of 32, so masking each byte keeps every character equally likely.
  let s = "";
  for (const b of randomBytes(10)) s += SLUG_ALPHABET[b & 31];
  return s;
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

/** A token and a session cookie in one request: never resolved, whatever either is worth. */
  // Built with json, not apiError: the API description lists these three codes from the
  // merge that adds the session routes on, and its test reads apiError calls.
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
 * 1. An Authorization header together with a session cookie (any cookie of that name,
 *    well-formed or not) is 400 `mixed_credentials`. Nothing is looked up.
 * 2. With an Authorization header: `Bearer <token>` resolves to the token's workspace
 *    and, unless `touch` is false, records when the token was last used. A token is
 *    refused when it is malformed, unknown or revoked, and when an account of its
 *    workspace is disabled.
 * 3. With a session cookie: in two-address mode it counts only on the app address. For
 *    any method but GET and HEAD the request must come from a page of this host
 *    (`sameOriginChange`, else 403 `bad_origin`) and carry the session's anti-forgery
 *    value in X-Csrf-Token (else 403 `bad_csrf`); both are decided from the request
 *    alone, before the database is asked. Then the session must be live, of an active
 *    account, and that account a member of a workspace: that one workspace is the answer.
 * 4. Anything else, and every refusal not named above, is the one 401.
 *
 * `only: "token"` refuses a session and `only: "session"` a token, with the 401 and no
 * lookup. `admin: true` takes only the session of a site admin and answers everyone else
 * (no credential, a token, a member) 404 `not_found`; the 400 and the two 403s stay.
 *
 * No token, cookie, code or digest is ever logged or put in an answer: only digests
 * reach the database.
 */
export async function requireAuth(
  req: Request,
  deps: Deps,
  opts: { touch?: boolean; only?: "token" | "session"; admin?: boolean } = {},
): Promise<Auth | Response> {
  const refused = opts.admin === true ? notFound : unauthorized;
  const header = req.headers.get("authorization");
  const cookie = sessionCookiePresent(req);
  if (header !== null && cookie) return mixedCredentials();
  if (cookie) return opts.only === "token" ? refused() : sessionAuth(req, deps, opts.admin === true, refused);
  if (opts.only === "session" || opts.admin === true) return refused();
  return tokenAuth(header ?? "", deps, opts.touch !== false);
}

/** The session path of `requireAuth`: the request has a session cookie and no Authorization header. */
async function sessionAuth(req: Request, deps: Deps, adminOnly: boolean, refused: () => Response): Promise<Auth | Response> {
  if (!sessionHost(req, deps)) return refused();
  const secret = readSessionCookie(req);
  if (secret === null) return refused();
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
  if (session === null) return refused();
  if (adminOnly && !session.admin) return refused();
  return { workspaceId: session.workspaceId, tokenId: "", session: { id: session.sessionId, userId: session.userId, admin: session.admin } };
}

/**
 * The token path of `requireAuth`, as it has always been, with one more condition in the
 * lookup: no account of the token's workspace is disabled. An account belongs to a
 * workspace by its membership or, for a row an older build wrote without one, by the
 * workspace its own row names. A workspace with no account at all still resolves.
 */
async function tokenAuth(header: string, deps: Deps, touch: boolean): Promise<Auth | Response> {
  const sp = header.indexOf(" ");
  const scheme = sp < 0 ? "" : header.slice(0, sp);
  const token = sp < 0 ? "" : header.slice(sp + 1);
  if (scheme.toLowerCase() !== "bearer" || !TOKEN_PATTERN.test(token)) return unauthorized();

  // The lookup compares SHA-256 digests, not the token, so its timing tells a caller
  // nothing useful about any stored token; the row's hash is compared again in
  // constant time before it is trusted.
  const hash = await hashToken(token);
  const row = await deps.db.first<{ id: string; workspace_id: string; hash: string }>(
    "SELECT id, workspace_id, hash FROM api_token WHERE hash = ? AND revoked_at IS NULL" +
      " AND NOT EXISTS (SELECT 1 FROM user u WHERE u.status = 'disabled'" +
      " AND (u.workspace_id = api_token.workspace_id OR u.id IN (SELECT m.user_id FROM membership m WHERE m.workspace_id = api_token.workspace_id)))",
    [hash],
  );
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
