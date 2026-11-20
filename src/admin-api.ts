// The admin API: the site's storage in all, how each account uses its storage, and the allowance of one workspace.
// No platform API.
//
// The site's admin needs an overview of how every account's storage allowance is used,
// and must not be able to open any account's links or content. So these routes are the one
// place a caller sees beyond its own workspace. The summary answers three numbers: the
// number of accounts, the bytes all workspaces use together and the site's standard
// allowance. The list answers only this, per account: its
// id, username, email, status, whether it is the admin, when it was made, its workspace's
// id and name (the admin page's Workspace column), its tour count, the bytes it uses with the breakdown GET /api/v1/usage gives the
// account itself (the shared images' and GIFs' bytes as two totals), and its allowance (the workspace's own number or null for the site's,
// and the number in force). Never a tour's id, title, slug or link, a chapter or step, a
// picture's address or file name, a shared item's id, title or link, a token, a session, or anything a tour's address could
// be built from; and the one change they take is a number.
//
// What holds for every route here:
// - The caller is learnt from `requireAuth(..., { admin: true })` alone: only the session
//   of a site admin passes. A member's session, any token (the admin's own workspace's
//   too), no credential, a session on the tours address, a token sent with a cookie, and a
//   change without the anti-forgery header or from another origin all get the one 404
//   `not_found`, with the same status, headers and body, and nothing is changed.
// - Each answers on the app address only (in one-address mode, on the one address): the
//   host gate keeps them there, and a session counts nowhere else.
// - Every answer is `cache-control: no-store`.
// - The numbers are read with the SQL of the account's own usage answer (USAGE_COLUMNS
//   and usageFromRow in src/usage.ts), so the two can never disagree.
import type { Hono } from "hono";
import { auditStatement } from "./audit.ts";
import { requireAuth } from "./auth.ts";
import { apiError, json, readCapped } from "./http.ts";
import { isNotNullViolation, type Deps } from "./ports.ts";
import { ALLOWANCE_SQL, USAGE_COLUMNS, usageFromRow, usageOf, type Usage } from "./usage.ts";

/** The most accounts one page of the list holds. */
export const ADMIN_PAGE = 100;

/** The largest allowance there is: the largest whole number a JSON number keeps exactly. */
export const MAX_ALLOWANCE_BYTES = Number.MAX_SAFE_INTEGER;

/** The longest body a change reads: `{"storage_allowance_bytes": 9007199254740991}` is 46 bytes. */
const MAX_BODY_BYTES = 1024;

/** How often a change is tried when another change of the same workspace lands between its read and its write. */
const SET_TRIES = 3;

const USER_ID = /^usr_[0-9a-f]{24}$/;
const WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;

const NEEDS_BODY = 'the body must be JSON such as {"storage_allowance_bytes": 1073741824}, with nothing else in it';
const BAD_ALLOWANCE = "storage_allowance_bytes must be a whole number of bytes from 0 to 9007199254740991, or null for the site's default";

/** What an admin route answers to an unknown or malformed workspace id: the 404 every refusal here is, so it tells nothing more. */
function notFound(): Response {
  return json(404, { error: "not_found" });
}

/** The numbers of one workspace, in the shape GET /api/v1/usage gives them. */
function numbers(u: Usage) {
  return { tours: u.tours, used_bytes: u.used, allowance_bytes: u.allowance, over: u.over, counted: { pictures: u.pictures, logos: u.logos, uploads_in_progress: u.uploads, images: u.imageBytes, gifs: u.gifBytes } };
}

/**
 * The allowance a change asks for: a whole number of bytes from 0 to MAX_ALLOWANCE_BYTES,
 * or null for the site's own number. Anything else is undefined: a negative number, a
 * fraction, a number past that range (which JSON cannot carry exactly), text, true or
 * false, a list, an object, or no value at all.
 */
function allowanceOf(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > MAX_ALLOWANCE_BYTES) return undefined;
  // -0 is 0.
  return v + 0;
}

export function adminRoutes(app: Hono, deps: Deps): void {
  /**
   * The summary line of the admin's page: how many accounts there are, the bytes every
   * workspace uses in all (each counted with the account's own usage SQL, USAGE_COLUMNS, so
   * the sum is the sum of the list's used_bytes), and the site's standard allowance from
   * its settings, null when none is set. Three numbers, nothing of any workspace. One
   * statement, whatever the number of accounts. It only reads.
   */
  app.get("/api/v1/admin/summary", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    const row = await deps.db.first<{ accounts: number; used: number }>(
      `SELECT (SELECT count(*) FROM user) AS accounts,
              (SELECT coalesce(sum(w.pictures + w.logos + w.uploads + w.image_bytes + w.gif_bytes), 0) FROM (SELECT ${USAGE_COLUMNS} FROM (SELECT id AS ws FROM workspace) p) w) AS used`,
    );
    return json(200, { accounts: row?.accounts ?? 0, used_bytes: row?.used ?? 0, standard_allowance_bytes: deps.config.storageAllowanceBytes ?? null });
  });

  /**
   * Every account, in the order they were made, ADMIN_PAGE at a time: who it is, its
   * workspace's id and name, its tour count, its usage and its allowance. `?after=<account id>`
   * starts after that account; `next` is the id to pass for the page after this one, or
   * null when there is none. A cursor that is not an account id is refused; one that names
   * no account lists nobody. It only reads.
   */
  app.get("/api/v1/admin/accounts", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    const after = c.req.query("after") ?? null;
    if (after !== null && !USER_ID.test(after)) return apiError(400, "bad_request", "after must be the id of an account, as next gives it");

    type Row = {
      id: string;
      username: string | null;
      email: string;
      status: string;
      is_admin: number;
      created_at: number;
      workspace_id: string;
      workspace_name: string;
      own: number | null;
      allowance: number | null;
      pictures: number;
      logos: number;
      uploads: number;
      image_bytes: number;
      gif_bytes: number;
      tours: number;
      images: number;
      gifs: number;
    };
    // One read. The page of accounts is chosen first, one more than a page to tell whether
    // another follows; then each account's numbers, with the account's own usage SQL, over
    // its workspace (its one membership) as p.ws. An account belongs to a workspace by its
    // membership only, as everywhere else; every account has one (the migration and the
    // start of the server give it one).
    //
    // For a later phase, when an account can be deleted: the cursor is found by looking the
    // account up, so a cursor that names an account deleted since the previous page lists
    // nobody, and the list is cut short there. Such a phase must page by the cursor's
    // (created_at, id) values themselves, or keep deleted accounts' positions.
    const rows = await deps.db.all<Row>(
      `SELECT p.id, p.username, p.email, p.status, p.is_admin, p.created_at, p.ws AS workspace_id, p.ws_name AS workspace_name, p.own, p.allowance, ${USAGE_COLUMNS}
         FROM (SELECT u.id, u.username, u.email, u.status, u.is_admin, u.created_at, m.workspace_id AS ws, workspace.name AS ws_name,
                      workspace.storage_allowance_bytes AS own, ${ALLOWANCE_SQL} AS allowance
                 FROM user u
                 JOIN membership m ON m.user_id = u.id
                 JOIN workspace ON workspace.id = m.workspace_id
                WHERE ? IS NULL OR (u.created_at, u.id) > (SELECT a.created_at, a.id FROM user a WHERE a.id = ?)
                ORDER BY u.created_at, u.id
                LIMIT ?) p
        ORDER BY p.created_at, p.id`,
      // In the order the placeholders stand in the text: the site's default, the cursor twice, the page.
      [deps.config.storageAllowanceBytes ?? null, after, after, ADMIN_PAGE + 1],
    );
    const page = rows.slice(0, ADMIN_PAGE);
    const accounts = page.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      status: r.status,
      admin: r.is_admin === 1,
      created_at: r.created_at,
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      ...numbers(usageFromRow(r)),
      storage_allowance_bytes: r.own,
    }));
    return json(200, { accounts, next: rows.length > ADMIN_PAGE ? page[page.length - 1].id : null });
  });

  /**
   * Sets one workspace's allowance: `{"storage_allowance_bytes": <whole number of bytes>}`,
   * or null to go back to the site's own number. The workspace is named by its id. The
   * change and its audit row (`allowance_set`, with the old and the new number) are one
   * batch. An allowance below what the workspace already uses is taken: nothing is deleted
   * or unpublished, and only an upload that needs more room is refused from then on.
   * Answers the workspace's numbers after the change.
   */
  app.patch("/api/v1/admin/workspaces/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    // requireAuth with admin passes only a session; without one there is nobody to record.
    if (auth.session === undefined) return notFound();
    const adminId = auth.session.userId;

    const raw = await readCapped(c.req.raw, MAX_BODY_BYTES);
    if (raw === "too_large") return apiError(400, "bad_request", NEEDS_BODY);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    } catch {
      return apiError(400, "bad_request", NEEDS_BODY);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return apiError(400, "bad_request", NEEDS_BODY);
    // The one field and nothing else: this route takes no other value of any kind.
    if (Object.keys(body).some((k) => k !== "storage_allowance_bytes")) return apiError(400, "bad_request", NEEDS_BODY);
    const wanted = allowanceOf((body as Record<string, unknown>).storage_allowance_bytes);
    if (wanted === undefined) return apiError(400, "bad_allowance", BAD_ALLOWANCE);

    const id = c.req.param("id");
    if (!WORKSPACE_ID.test(id)) return notFound();

    // For a later phase, when a workspace can be deleted: a workspace deleted between the read
    // below and the batch is not updated (no row matches), but the batch still writes its
    // audit row, which then records a change that never happened. Such a phase must make the
    // batch fail when no row was updated, as the old value's check does here.
    for (let attempt = 1; ; attempt++) {
      const found = await deps.db.first<{ own: number | null }>("SELECT storage_allowance_bytes AS own FROM workspace WHERE id = ?", [id]);
      if (found === null) return notFound();
      const old = found.own;
      try {
        // The write takes effect only while the workspace still has the number just read,
        // so the audit row's old number is the one replaced. Otherwise the name is set to
        // null, which the database refuses, and the whole batch, audit row too, is undone
        // and read again.
        await deps.db.batch([
          {
            sql: "UPDATE workspace SET storage_allowance_bytes = ?, name = CASE WHEN storage_allowance_bytes IS ? THEN name ELSE NULL END WHERE id = ?",
            params: [wanted, old, id],
          },
          auditStatement(deps, { event: "allowance_set", userId: adminId, workspaceId: id, subject: id, detail: { old_bytes: old, new_bytes: wanted } }),
        ]);
        break;
      } catch (err) {
        if (!isNotNullViolation(err) || attempt >= SET_TRIES) throw err;
      }
    }

    const u = await usageOf(deps, id);
    return json(200, { workspace_id: id, allowance_bytes: u.allowance, storage_allowance_bytes: wanted, used_bytes: u.used, over: u.over });
  });
}
