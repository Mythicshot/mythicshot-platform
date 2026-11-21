// The workspace's tokens, for the dashboard: list them, rename one, revoke one.
//
// All three take a session and nothing else, with the anti-forgery header for a change, on
// the app address: a token is the one 401 here, so a token that was copied off a computer can
// neither list the workspace's other tokens, nor revoke them, nor rename itself. An answer
// never holds a token or its digest, nor any part of either: only its id, its name, when it
// was made and last used, when it expires (src/lifetimes.ts), and how it was made (`setup`: by the setup wizard or with a new
// account; `sign_in`: by connecting the app, src/connect.ts).
//
// Revoking sets revoked_at. requireAuth reads that column on every request a token makes, in
// the one lookup that resolves the token, so the first request whose lookup runs after the
// revoke has committed is refused (401). A request whose lookup ran before, and which is still
// being answered, is not stopped: it finishes as the caller it was resolved to. That is what
// "at once" means here.
import type { Hono } from "hono";
import { auditStatement } from "./audit.ts";
import { requireAuth } from "./auth.ts";
import { parseDeviceName } from "./connect.ts";
import { apiError, json, noContent } from "./http.ts";
import { tokenExpiry } from "./lifetimes.ts";
import { isNotNullViolation, type Deps } from "./ports.ts";
import { ownJsonBody } from "./signin.ts";

/** The most tokens the list answers, newest first. */
export const MAX_TOKENS_LISTED = 200;

const TOKEN_ID = /^tok_[0-9a-f]{24}$/;
const NEEDS_NAME = 'the body must be JSON such as {"name": "Work laptop"}';
const NAME_RULE = "the name must be 1 to 60 characters of text, without control or formatting characters";

type Row = { id: string; name: string; created_at: number; last_used_at: number | null; kind: string };
const COLUMNS = "id, name, created_at, last_used_at, kind";
/**
 * One token as the answers give it. `expires_at` is when it stops working unless something
 * changes (tokenExpiry, src/lifetimes.ts: for kind `sign_in`, the earlier of its idle and its
 * age end; null for kind `setup` and when neither limit is on), and `expired` is true from
 * then on. A lapsed connection is still listed, so its owner sees why that computer asks to
 * sign in again, and can disconnect it; it is never brought back by being listed.
 */
const entry = (deps: Deps, now: number, r: Row) => {
  const end = tokenExpiry(deps.config, r).at;
  return { id: r.id, name: r.name, created_at: r.created_at, last_used_at: r.last_used_at, kind: r.kind, expires_at: end, expired: end !== null && now >= end };
};

/** The 401 of `requireAuth`, for a session that resolved without its part (never, in practice). */
function unauthorized(): Response {
  return new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Another workspace's token, a revoked one, one that never was and an id that is not one: the one 404. */
function noToken(): Response {
  return apiError(404, "not_found", "no such token");
}

export function tokenRoutes(app: Hono, deps: Deps): void {
  /** The workspace's tokens that are not revoked, newest first, lapsed connections included and marked. */
  app.get("/api/v1/tokens", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const rows = await deps.db.all<Row>(`SELECT ${COLUMNS} FROM api_token WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id LIMIT ?`, [auth.workspaceId, MAX_TOKENS_LISTED]);
    // One reading of the clock for the whole answer, so every entry is judged at the same time.
    const now = deps.now();
    return json(200, { tokens: rows.map((r) => entry(deps, now, r)) });
  });

  /**
   * Renames one of the workspace's tokens that is not revoked, and answers it. The change and
   * its record are one batch, and the record guards it: unless exactly one token of this
   * workspace was renamed, nothing is written.
   */
  app.patch("/api/v1/tokens/:id", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const id = c.req.param("id");
    if (!TOKEN_ID.test(id)) return noToken();
    const body = await ownJsonBody(req, deps, NEEDS_NAME);
    if (body instanceof Response) return body;
    const name = parseDeviceName(body.name);
    if (name === null) return apiError(400, "bad_name", NAME_RULE);
    try {
      await deps.db.batch([
        { sql: "UPDATE api_token SET name = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL", params: [name, id, auth.workspaceId] },
        auditStatement(deps, { event: "token_renamed", userId: auth.session.userId, workspaceId: auth.workspaceId, subject: id }, { onlyAfterOneChange: true }),
      ]);
    } catch (err) {
      if (isNotNullViolation(err)) return noToken();
      throw err;
    }
    const row = await deps.db.first<Row>(`SELECT ${COLUMNS} FROM api_token WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`, [id, auth.workspaceId]);
    // Revoked between the two calls: it is gone, as it would be a moment later.
    return row === null ? noToken() : json(200, entry(deps, deps.now(), row));
  });

  /** Revokes one of the workspace's tokens, once: the change and its record are one batch, which the record guards. */
  app.delete("/api/v1/tokens/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const id = c.req.param("id");
    if (!TOKEN_ID.test(id)) return noToken();
    try {
      await deps.db.batch([
        { sql: "UPDATE api_token SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL", params: [deps.now(), id, auth.workspaceId] },
        auditStatement(deps, { event: "token_revoked", userId: auth.session.userId, workspaceId: auth.workspaceId, subject: id }, { onlyAfterOneChange: true }),
      ]);
    } catch (err) {
      if (isNotNullViolation(err)) return noToken();
      throw err;
    }
    return noContent();
  });
}
