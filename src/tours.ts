// The workspace name, the tour list the desktop app shows, renaming and deleting a tour,
// and draft step images. Every query is scoped by the workspace of the authenticated
// token; another workspace's tour or step answers 404.
//
// Rename changes the title only: the slug, and so the public link, stays. The public page
// reads the published snapshot, never the draft, so a rename also sets the title inside
// the live snapshot (and inside a publish in progress), in one batch with the tour row:
// the page shows the new title on its next request. Nothing else of the snapshot changes.
//
// Delete works in bounded steps, so that no request makes more than SUBREQUEST_BUDGET
// database and storage calls however large the tour (see src/budget.ts and migration
// 0005). The client calls the delete route again and again:
// - The first call removes every row of the tour in ONE batch: the snapshot and its
//   object rows, public_object rows, unfinished uploads into the tour, the rows of pictures
//   a chapter replace left for removal, steps, chapters and the tour row itself. The same batch records every file those rows named in
//   deleted_object under a tour_deletion row. So from that call on the tour does not
//   exist for any other route (list, publish, unpublish, rename, upload, the public page
//   and its images all answer as for an unknown tour), and every file it owned is still
//   named by exactly one row. A half-deleted tour is that tour_deletion row and its
//   files, nothing else.
// - That call and each later one delete the next DELETE_FILES_PER_CALL files from the two
//   stores, then their rows. A call that is cut off between the two leaves the rows, and
//   the next call deletes the same keys again (a key that is already gone is not an error).
// - The call that finds no file left drops the tour_deletion row and answers 200. After
//   that the tour id answers 404, like any unknown id.
// The files deleted are exactly those the tour's own rows named; nothing is found by
// listing a store, so no other tour's file can be reached.
//
// A tour with a publish in progress is not deleted (409 publish_busy): the publish is
// writing public files this request could not account for. The batch itself re-checks
// that no publish job exists, so a publish that starts at the same moment either makes
// the batch a no-op (409) or, landing after it, finds no tour and writes nothing.
import type { Hono } from "hono";
import { readOnlyRefusal } from "./billing.ts";
import { isBeforeAccounts } from "./accounts.ts";
import { isBeforeTokenAccount, requireAuth, type Auth } from "./auth.ts";
import { apiError, json, readCapped } from "./http.ts";
import { parseTitle } from "./manifest.ts";
import { CARRY_CALLS } from "./access.ts";
import { housekeeping } from "./publish.ts";
import { clearReplaced } from "./replace.ts";
import type { Deps, Stmt } from "./ports.ts";
import { TOUR_BYTES_SQL } from "./usage.ts";
import { VERSION } from "./version.ts";

const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const STEP_ID = /^st_[0-9a-f]{24}$/;

/** The rename body: {"title": "..."}. A title is at most 200 characters, each at most 12 bytes when escaped. */
const RENAME_BODY_BYTES = 4096;
/**
 * Files one delete request removes from the stores (both together). One store delete call
 * takes up to 1,000 keys, so this is not the budget's limit: it keeps each request short
 * on a server that deletes files one by one, and gives the client progress to show.
 */
export const DELETE_FILES_PER_CALL = 250;

/**
 * Headers for a draft image. The type comes from the step row, which holds the type
 * sniffed from the file's own bytes at upload; the stored object's metadata and the
 * uploader's Content-Type are never used. Nothing may cache it but the browser that
 * asked, and only for this response.
 */
function draftImageHeaders(type: "png" | "jpg", size: number): Record<string, string> {
  return {
    "content-type": type === "png" ? "image/png" : "image/jpeg",
    "content-length": String(size),
    "content-disposition": `inline; filename="step.${type}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
  };
}

const noSuchTour = () => apiError(404, "not_found", "no such tour");
const publishBusy = () =>
  apiError(409, "publish_busy", "a publish of this tour is in progress; wait for it to finish, or unpublish the tour to stop it, then delete it again");

/** Whether the tour exists in this workspace, whether a publish job of it exists, and the file count of its deletion (null when it has none). */
async function deletionState(deps: Deps, auth: Auth, id: string): Promise<{ tour: boolean; job: boolean; total: number | null }> {
  const ws = auth.workspaceId;
  const row = await deps.db.first<{ tour: number | null; job: number | null; total: number | null }>(
    `SELECT (SELECT 1 FROM tour WHERE id = ? AND workspace_id = ?) AS tour,
            (SELECT 1 FROM publish_job j JOIN tour t ON t.id = j.tour_id WHERE j.tour_id = ? AND t.workspace_id = ?) AS job,
            (SELECT total FROM tour_deletion WHERE tour_id = ? AND workspace_id = ?) AS total`,
    [id, ws, id, ws, id, ws],
  );
  return { tour: row?.tour === 1, job: row?.job === 1, total: row?.total ?? null };
}

/**
 * The first delete call's batch: records the deletion and every file the tour's rows name,
 * then removes those rows and the tour. Nothing happens unless the tour is this
 * workspace's and has no publish job: the first statement then records nothing, and every
 * later one acts only while both the deletion row and the tour row exist, which is true
 * only inside the batch that recorded it.
 */
export function removeTourStatements(ws: string, id: string, now: number): Stmt[] {
  const live = "EXISTS (SELECT 1 FROM tour_deletion d JOIN tour t ON t.id = d.tour_id AND t.workspace_id = d.workspace_id WHERE d.tour_id = ? AND d.workspace_id = ?)";
  const record = (store: "drafts" | "public", from: string): Stmt => ({
    sql: `INSERT OR IGNORE INTO deleted_object (tour_id, store, image_key) SELECT ?, '${store}', ${from} AND ${live}`,
    params: [id, id, id, ws],
  });
  // A live picture's store is told by its key (src/publish.ts, storeOfKey): `p/` in the
  // public store, a restricted tour's `v/` in the private one.
  const liveStore = (column: string) => `CASE WHEN substr(${column}, 1, 2) = 'p/' THEN 'public' ELSE 'drafts' END`;
  const recordLive = (from: string): Stmt => ({
    sql: `INSERT OR IGNORE INTO deleted_object (tour_id, store, image_key) SELECT ?, ${liveStore("o.image_key")}, ${from} AND ${live}`,
    params: [id, id, id, ws],
  });
  const remove = (table: string, where: string): Stmt => ({ sql: `DELETE FROM ${table} WHERE ${where} AND ${live}`, params: [id, id, ws] });
  return [
    {
      sql: `INSERT INTO tour_deletion (tour_id, workspace_id, total, created_at)
            SELECT t.id, t.workspace_id, 0, ? FROM tour t
             WHERE t.id = ? AND t.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM publish_job j WHERE j.tour_id = t.id)`,
      params: [now, id, ws],
    },
    // Draft files: every step's image, the logo, and whatever unfinished uploads into the tour have claimed or written.
    record("drafts", "s.image_key FROM step s WHERE s.tour_id = ?"),
    record("drafts", "t.logo_key FROM tour t WHERE t.id = ? AND t.logo_key IS NOT NULL"),
    record("drafts", "s.image_key FROM upload_step s JOIN upload u ON u.id = s.upload_id WHERE u.tour_id = ?"),
    record("drafts", "u.logo_key FROM upload u WHERE u.tour_id = ? AND u.logo_key IS NOT NULL"),
    // And the pictures a chapter replace took out of the tour that are still in the store.
    record("drafts", "r.image_key FROM replaced_object r WHERE r.tour_id = ?"),
    // Live files: the live snapshot's, and those a publish or an access switch replaced,
    // retired or left pending, each in its own store.
    recordLive("o.image_key FROM snapshot_object o WHERE o.tour_id = ?"),
    recordLive("o.image_key FROM public_object o WHERE o.tour_id = ?"),
    { sql: `UPDATE tour_deletion SET total = (SELECT count(*) FROM deleted_object WHERE tour_id = ?) WHERE tour_id = ? AND ${live}`, params: [id, id, id, ws] },
    // The rows, children before parents (foreign keys never cascade). Removing the snapshot
    // and the object rows is what stops the page and the images being served.
    remove("snapshot_object", "tour_id = ?"),
    remove("snapshot", "tour_id = ?"),
    remove("public_object", "tour_id = ?"),
    // Its viewing list and a switch of its live pictures in progress (whose request, if one
    // is still running, finds its rows gone and deletes what it wrote).
    remove("tour_viewer", "tour_id = ?"),
    remove("access_switch", "tour_id = ?"),
    remove("upload_step", "upload_id IN (SELECT id FROM upload WHERE tour_id = ?)"),
    remove("upload", "tour_id = ?"),
    remove("replaced_object", "tour_id = ?"),
    remove("step", "tour_id = ?"),
    remove("chapter", "tour_id = ?"),
    {
      sql: "DELETE FROM tour WHERE id = ? AND workspace_id = ? AND EXISTS (SELECT 1 FROM tour_deletion WHERE tour_id = ? AND workspace_id = ?)",
      params: [id, ws, id, ws],
    },
  ];
}

/**
 * One page of a deleted tour's files: deletes the next DELETE_FILES_PER_CALL files its
 * deleted_object rows name from the two stores, then those rows, and once no row is left,
 * the tour_deletion row. Returns how many files are left. At most six calls: the page, a
 * delete per store, the rows, a count (only after a full page) and the last row. Throws
 * when a store or the database fails; a row only goes after its file has, so the next call
 * deletes the same keys again (a key already gone is not an error). Only rows of a
 * deletion of this workspace are read, so no other workspace's file can be reached.
 */
export async function clearDeletionPage(deps: Deps, workspaceId: string, id: string): Promise<number> {
  const files = await deps.db.all<{ store: "drafts" | "public"; image_key: string }>(
    "SELECT o.store, o.image_key FROM deleted_object o JOIN tour_deletion d ON d.tour_id = o.tour_id WHERE o.tour_id = ? AND d.workspace_id = ? ORDER BY o.store, o.image_key LIMIT ?",
    [id, workspaceId, DELETE_FILES_PER_CALL],
  );
  const drafts = files.filter((f) => f.store === "drafts").map((f) => f.image_key);
  const pub = files.filter((f) => f.store === "public").map((f) => f.image_key);
  // The files first, then their rows: a row only goes once its file has.
  if (drafts.length > 0) await deps.drafts.delete(drafts);
  if (pub.length > 0) await deps.pub.delete(pub);
  const forget = (store: string, keys: string[]): Stmt => ({
    sql: "DELETE FROM deleted_object WHERE tour_id = ? AND store = ? AND image_key IN (SELECT value FROM json_each(?))",
    params: [id, store, JSON.stringify(keys)],
  });
  if (files.length > 0) await deps.db.batch([forget("drafts", drafts), forget("public", pub)]);
  const left = files.length < DELETE_FILES_PER_CALL ? 0 : ((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM deleted_object WHERE tour_id = ?", [id]))?.n ?? 0);
  if (left === 0) {
    // Only while no file row is left, so a call racing this one can never strand a file.
    await deps.db.run("DELETE FROM tour_deletion WHERE tour_id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM deleted_object WHERE tour_id = ?)", [id, workspaceId, id]);
  }
  return left;
}

export function tourRoutes(app: Hono, deps: Deps): void {
  app.get("/api/v1/me", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    // The answer describes the caller's own credential and nothing else: its workspace (the one
    // requireAuth resolved it to) and the account it belongs to. For a session that is the
    // signed-in account, which requireAuth has already found a member of the workspace. For a
    // token it is the account its row names (migration 0023), read in this same statement and
    // only while that account belongs to the token's own workspace, by its membership or, for a
    // row an older build wrote without one, its own row (the rule of the token's lookup); a
    // token nothing names an account of (one an older build made) gets null, never a guess.
    // Both ids are random row ids ("ws_"/"usr_" and 96 random bits), never an email or a name.
    type Row = { name: string; account_id: string | null };
    let row: Row | null;
    try {
      row = await deps.db.first<Row>(
        `SELECT w.name,
                (SELECT k.user_id FROM api_token k
                  WHERE k.id = ? AND k.workspace_id = w.id
                    AND k.user_id IN (SELECT u.id FROM user u WHERE u.workspace_id = w.id
                                      UNION SELECT m.user_id FROM membership m WHERE m.workspace_id = w.id)) AS account_id
           FROM workspace w WHERE w.id = ?`,
        [auth.tokenId, auth.workspaceId],
      );
    } catch (err) {
      // A database migration 0023 (or 0008, before accounts) has not reached: no token names
      // an account there yet, and the name alone is read as before.
      if (!isBeforeTokenAccount(err) && !isBeforeAccounts(err)) throw err;
      row = await deps.db.first<Row>("SELECT name, NULL AS account_id FROM workspace WHERE id = ?", [auth.workspaceId]);
    }
    if (row === null) return apiError(404, "not_found", "no such workspace");
    const accountId = auth.session !== undefined ? auth.session.userId : row.account_id;
    // In two-address mode the answer also names both addresses, as host names without a
    // scheme; in one-address mode the key is absent, meaning "use the address you were given".
    const hosts = deps.config.hosts ?? null;
    return json(200, { workspace: row.name, workspace_id: auth.workspaceId, account_id: accountId, version: VERSION, ...(hosts === null ? {} : { addresses: { tours: hosts.tours, app: hosts.app } }) });
  });

  app.get("/api/v1/tours", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    // Publish housekeeping rides on this frequent, cheap request too (at most 4 calls), so
    // an abandoned publish or an image past its grace is cleared without a later publish.
    // With the calls to carry on a switch its client left (src/access.ts, CARRY_CALLS).
    await housekeeping(deps, auth.workspaceId, null, 1, CARRY_CALLS);
    // And one page of the draft pictures chapter replaces left behind (at most 3 calls).
    await clearReplaced(deps, auth.workspaceId, null);
    // live_version is the draft_version the live snapshot was built from: null when the
    // tour has no snapshot, and for a snapshot from before migration 0006 that is not known
    // to hold the whole draft. It is read in this same statement, so the list makes no
    // extra call for it.
    // bytes is the tour's size as the usage counts storage (TOUR_BYTES_SQL in src/usage.ts),
    // read in this same statement too.
    // access is the tour's viewing setting and viewers the count of addresses on its list
    // (src/access.ts), never the addresses themselves: both in this same statement.
    const rows = await deps.db.all<{ id: string; title: string; status: "draft" | "published"; slug: string; chapters: number; steps: number; bytes: number; updated_at: number; published_at: number | null; draft_version: number; live_version: number | null; access: "public" | "people" | "me"; viewers: number }>(
      `SELECT t.id, t.title, t.status, t.slug, t.access,
              (SELECT count(*) FROM tour_viewer v WHERE v.tour_id = t.id) AS viewers,
              (SELECT count(*) FROM chapter c WHERE c.tour_id = t.id) AS chapters,
              (SELECT count(*) FROM step s WHERE s.tour_id = t.id) AS steps,
              ${TOUR_BYTES_SQL} AS bytes,
              t.updated_at, t.published_at, t.draft_version,
              (SELECT n.draft_version FROM snapshot n WHERE n.tour_id = t.id) AS live_version
         FROM tour t WHERE t.workspace_id = ? ORDER BY t.updated_at DESC, t.id`,
      [auth.workspaceId],
    );
    // `url` is the public link in the form publish answers it: a path on this server, for
    // the client to put after the server address it was given. The server does not build a
    // full address, because behind a proxy it cannot know the scheme visitors use. A draft
    // has no link.
    // `unpublished_changes` says the live page is behind the draft, so a publish would
    // change what visitors see: the snapshot was built from an older draft version than the
    // tour's (every upload commit, chapter replace and change of the chapters raises it; a rename does not, since
    // it writes its title into the snapshot too), or from one that was never recorded.
    // Always false for a draft, which has no live page.
    const tours = rows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      slug: t.slug,
      url: t.status === "published" ? `/t/${t.slug}` : null,
      chapters: t.chapters,
      steps: t.steps,
      bytes: t.bytes,
      updated_at: t.updated_at,
      published_at: t.status === "published" ? t.published_at : null,
      unpublished_changes: t.status === "published" && (t.live_version === null || t.live_version < t.draft_version),
      access: t.access,
      viewers: t.viewers,
    }));
    return json(200, { tours });
  });

  // Rename. Request: PATCH {"title": "New name"}. Answers 200 {id, title} with the title
  // as saved (trimmed); 400 bad_title when it is not text, empty after trimming, over 200
  // characters or holds a control or format character. The slug does not change.
  app.patch("/api/v1/tours/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    // Billing (src/billing.ts): a rename changes the live title, so a read-only workspace cannot; no call without billing.
    const ended = await readOnlyRefusal(deps, auth.workspaceId);
    if (ended !== null) return ended;
    const bad = () => apiError(400, "bad_request", 'the body must be JSON such as {"title": "New name"}');
    const raw = await readCapped(c.req.raw, RENAME_BODY_BYTES);
    if (raw === "too_large") return apiError(413, "too_large", `the request is over ${RENAME_BODY_BYTES} bytes`);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    } catch {
      return bad();
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return bad();
    const parsed = parseTitle(Object.hasOwn(body, "title") ? (body as Record<string, unknown>).title : undefined);
    if (!parsed.ok) return apiError(400, "bad_title", `the title ${parsed.error}`);
    const id = c.req.param("id");
    if (!TOUR_ID.test(id)) return noSuchTour();

    const owned = "SELECT id FROM tour WHERE id = ? AND workspace_id = ?";
    const ws = auth.workspaceId;
    // One batch, so the list, the live page and a publish about to go live never disagree.
    // (A publish that has read the draft but not yet recorded its job takes the title from
    // the tour row when it records it, so it cannot miss this either.)
    // A longer title can take a snapshot that was just under MAX_SNAPSHOT_BYTES a little
    // over it: by at most 200 characters, about 2,400 bytes escaped. That is harmless. The
    // cap bounds the work of building a snapshot at the start of a publish, which this does
    // not repeat; the database stores a value four times that size, and the page reads a
    // snapshot of any size. The next publish measures the tour again with its new title.
    // A snapshot that is not JSON (the page answers 404 for it) is left as it is.
    await deps.db.batch([
      { sql: "UPDATE tour SET title = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", params: [parsed.title, deps.now(), id, ws] },
      // A restricted tour's text is in private_data; its data is the stub, which holds no title and keeps none.
      { sql: `UPDATE snapshot SET data = json_set(data, '$.title', ?) WHERE tour_id IN (${owned}) AND private_data IS NULL AND json_valid(data)`, params: [parsed.title, id, ws] },
      { sql: `UPDATE snapshot SET private_data = json_set(private_data, '$.title', ?) WHERE tour_id IN (${owned}) AND json_valid(private_data)`, params: [parsed.title, id, ws] },
      { sql: `UPDATE publish_job SET data = json_set(data, '$.title', ?) WHERE tour_id IN (${owned}) AND json_valid(data)`, params: [parsed.title, id, ws] },
    ]);
    const row = await deps.db.first<{ id: string; title: string }>("SELECT id, title FROM tour WHERE id = ? AND workspace_id = ?", [id, ws]);
    if (row === null) return noSuchTour();
    return json(200, { id: row.id, title: row.title });
  });

  // Delete in bounded steps. Request: DELETE with no body, repeated until done. Answers
  // 202 {status: "in_progress", done, total} (files removed so far, of how many) while
  // files remain; 200 {deleted: true} once nothing of the tour is left; 404 for an unknown
  // tour, another workspace's, or one already deleted; 409 publish_busy while a publish
  // of it is in progress. At most 16 calls: 2 authentication, 3 looks at the tour, 4
  // housekeeping (only when a publish job is found), 1 batch, 4 for the files, 1 count, 1 to finish.
  app.delete("/api/v1/tours/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    if (!TOUR_ID.test(id)) return noSuchTour();

    let state = await deletionState(deps, auth, id);
    if (state.tour && state.job) {
      // A publish abandoned for STALE_PUBLISH_MS no longer counts: housekeeping drops its
      // job and retires its rows, whose files this delete then removes with the rest.
      await housekeeping(deps, auth.workspaceId, id, 1);
      state = await deletionState(deps, auth, id);
      if (state.tour && state.job) return publishBusy();
    }
    if (state.tour) {
      await deps.db.batch(removeTourStatements(auth.workspaceId, id, deps.now()));
      state = await deletionState(deps, auth, id);
      // Still there: a publish started between the look and the batch, which then did nothing.
      if (state.tour) return publishBusy();
    }
    if (state.total === null) return noSuchTour();

    let left: number;
    try {
      left = await clearDeletionPage(deps, auth.workspaceId, id);
    } catch {
      // Fixed text only: the error could carry anything a back end put in its message.
      console.error("delete: could not remove some files of a deleted tour; the next delete call retries");
      return apiError(500, "cleanup_pending", "the tour is deleted, but some of its files could not be removed yet; delete it again to retry");
    }
    if (left === 0) return json(200, { deleted: true });
    return json(202, { status: "in_progress", done: Math.max(0, state.total - left), total: state.total });
  });

  app.get("/api/v1/tours/:id/steps/:step_id/image", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const tourId = c.req.param("id");
    const stepId = c.req.param("step_id");
    if (!TOUR_ID.test(tourId) || !STEP_ID.test(stepId)) return apiError(404, "not_found", "no such step");
    const step = await deps.db.first<{ image_key: string; image_type: "png" | "jpg" }>(
      "SELECT s.image_key, s.image_type FROM step s JOIN tour t ON t.id = s.tour_id WHERE s.id = ? AND s.tour_id = ? AND t.workspace_id = ?",
      [stepId, tourId, auth.workspaceId],
    );
    if (step === null) return apiError(404, "not_found", "no such step");
    const file = await deps.drafts.get(step.image_key);
    if (file === null) return apiError(404, "not_found", "no such step");
    return new Response(file.body, { status: 200, headers: draftImageHeaders(step.image_type, file.size) });
  });
}
