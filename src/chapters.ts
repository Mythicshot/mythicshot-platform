// A tour's chapters, listed, reordered and removed: the dashboard's Chapters box (0.1.55).
//
//   GET /api/v1/tours/:id/chapters  -> 200 {revision, chapters: [{id, title, position, steps, pictures, uploaded_at}]}
//   PUT /api/v1/tours/:id/chapters  {revision, chapters: [ids to keep, in their new order]}
//                                   -> 200 the same as GET, as the tour is now
//
// One list to keep, rather than separate move and remove routes: a person edits the whole
// order in one box and saves once, so the change is one request and one batch, checked whole
// against one revision, and nothing can land half-way between a move and a removal.
//
// `revision` is the tour's draft_version, which every change of its draft raises: an upload's
// commit (a new chapter), a chapter replace, and a change made here. A rename does not, and
// is no change of the chapters. GET reads the revision with the chapters in one statement;
// PUT takes effect only while the revision is still the one the list was read at, so a list
// read before someone uploaded, replaced or reordered is refused (409 tour_changed) and
// changes nothing: the client reads the chapters again.
//
// A chapter not in the list is removed. In ONE batch, which takes effect only while the
// revision is the one stated (its first statement sets draft_version to NULL otherwise, which
// fails NOT NULL and rolls the whole batch back):
// - the draft moves on by one version, so a published tour shows "Changes waiting"
//   (unpublished_changes in GET /api/v1/tours) exactly as after a chapter replace, and a
//   publish whose start read the older draft records no job and starts again (src/publish.ts);
// - every open replace of a removed chapter, and of the first chapter before and after when
//   the first chapter changes, is closed: such a replace was created against a chapter that
//   is gone, or decided whether it carries the tour's settings (src/replace.ts) against
//   another first chapter, so it can never commit (404 upload) and is removed like an abort;
// - the removed chapters' pictures go to replaced_object at the new version, and are deleted
//   by the existing clean-up (clearReplaced): files first, then rows, and a row waits while a
//   publish job of an older draft exists, so a publish in progress finishes from the draft it
//   started from. A picture a kept step uses is never queued;
// - their steps and the chapters go;
// - the kept chapters are numbered from 0 in the order given.
// The tour's settings (theme, cover, logo, end card and the rest) are on the tour row and stay
// as they are; the public snapshot is not touched, so visitors see the change only once the
// tour is published again. Storage usage counts the steps that remain (src/usage.ts).
//
// Refused, with nothing changed: a list that would leave no chapter (400 last_chapter: a
// tour's last chapter is removed by deleting the tour), an id that is not a chapter of this
// tour (404 not_found "no such chapter", whether it is another tour's, another workspace's or
// none at all), an id listed twice, more than MAX_CHAPTERS ids, and a stale revision. A tour
// of another workspace answers 404 "no such tour", as an unknown one does, before anything
// else is looked at. A list with the order unchanged and nothing removed changes nothing and
// answers the tour as it is.
//
// Who may call: a token or a session, as rename, publish, unpublish and delete take either.
// A token can already delete the whole tour, so taking it here protects nothing; the one
// tour route that is session-only (PUT .../access) is so because it could make a restricted
// tour public with a stolen token, which nothing here can. A session's change needs the
// anti-forgery header and an Origin of the site (requireAuth).
//
// However many steps a tour has, PUT makes the same few calls: the batch is a fixed set of
// statements, and the files are deleted a page at a time, CLEAR_PAGES pages here and the rest
// by later requests (the tour list, every replace commit), as for a replace.
import type { Hono } from "hono";
import { requireAuth, type Auth } from "./auth.ts";
import { apiError, json, readCapped } from "./http.ts";
import { isNotNullViolation, type Deps, type Stmt } from "./ports.ts";
import { REPLACED_FILES_PER_CALL, clearReplaced } from "./replace.ts";
import { MAX_CHAPTERS, removeClosedReplaces } from "./uploads.ts";

/**
 * The most ids one PUT lists: the most chapters a tour has, which uploads hold it to
 * (src/uploads.ts). A tour that got more before 0.1.56 is brought down to it by one PUT that
 * removes the rest, and from then on takes any change.
 */
export { MAX_CHAPTERS };
/** The PUT body: MAX_CHAPTERS ids of 27 characters, quoted and separated, and the revision. */
export const CHAPTERS_BODY_BYTES = 16_384;
/** Pages of the removed pictures' files one PUT deletes (three calls each); later requests delete the rest. */
const CLEAR_PAGES = 3;
/** Closed replaces one PUT removes (three calls each); the sweep removes any others once they are old. */
const CLOSED_REMOVED = 4;

const TOUR_ID = /^tour_[0-9a-f]{24}$/;

/** One chapter as both routes answer it. `pictures` counts its distinct picture files, which removing it deletes. */
export type ChapterInfo = { id: string; title: string; position: number; steps: number; pictures: number; uploaded_at: number | null };
export type ChapterList = { revision: number; chapters: ChapterInfo[] };

const noSuchTour = () => apiError(404, "not_found", "no such tour");
const noSuchChapter = () => apiError(404, "not_found", "no such chapter");
const changed = () => apiError(409, "tour_changed", "the tour changed since its chapters were read (an upload, a replace or another change of its chapters); read them again");

/**
 * The tour's revision and its chapters in the order a publish reads them (position, then id),
 * numbered from 0, in ONE statement, for a tour of this workspace; null for any other.
 */
export async function readChapters(deps: Deps, auth: Auth, tourId: string): Promise<ChapterList | null> {
  const rows = await deps.db.all<{ revision: number; id: string | null; title: string | null; uploaded_at: number | null; steps: number; pictures: number }>(
    `SELECT t.draft_version AS revision, c.id, c.title, c.uploaded_at,
            (SELECT count(*) FROM step s WHERE s.chapter_id = c.id AND s.tour_id = t.id) AS steps,
            (SELECT count(DISTINCT s.image_key) FROM step s WHERE s.chapter_id = c.id AND s.tour_id = t.id) AS pictures
       FROM tour t LEFT JOIN chapter c ON c.tour_id = t.id
      WHERE t.id = ? AND t.workspace_id = ?
      ORDER BY c.position, c.id`,
    [tourId, auth.workspaceId],
  );
  if (rows.length === 0) return null;
  const chapters: ChapterInfo[] = [];
  for (const r of rows) {
    if (r.id === null) continue;
    chapters.push({ id: r.id, title: r.title ?? "", position: chapters.length, steps: r.steps, pictures: r.pictures, uploaded_at: r.uploaded_at ?? null });
  }
  return { revision: rows[0].revision, chapters };
}

/** The PUT body, checked for its shape alone (nothing is looked up), or the refusal. */
async function readBody(req: Request): Promise<{ revision: number; chapters: string[] } | Response> {
  const bad = (detail: string) => apiError(400, "bad_request", detail);
  const raw = await readCapped(req, CHAPTERS_BODY_BYTES);
  if (raw === "too_large") return apiError(413, "too_large", `the request is over ${CHAPTERS_BODY_BYTES} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return bad('the body must be JSON such as {"revision": 3, "chapters": ["ch_...", "ch_..."]}');
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad('the body must be JSON such as {"revision": 3, "chapters": ["ch_...", "ch_..."]}');
  const b = body as Record<string, unknown>;
  const revision = Object.hasOwn(b, "revision") ? b.revision : undefined;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return bad("revision must be the whole number GET /api/v1/tours/{id}/chapters answered");
  const list = Object.hasOwn(b, "chapters") ? b.chapters : undefined;
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) return bad("chapters must be a list of chapter ids");
  if (list.length === 0) return apiError(400, "last_chapter", "a tour keeps at least one chapter; to remove them all, delete the tour");
  if (list.length > MAX_CHAPTERS) return apiError(400, "too_many_chapters", `chapters lists more than ${MAX_CHAPTERS} ids`);
  if (new Set(list).size !== list.length) return bad("chapters lists a chapter more than once");
  return { revision, chapters: list as string[] };
}

/**
 * The change, one batch (see the top of this file). `affected` are the chapters whose open
 * replaces are closed. Every statement is scoped to the tour of this workspace.
 */
export function changeStatements(ws: string, tourId: string, revision: number, keep: string[], removed: string[], affected: string[], now: number): Stmt[] {
  const owned = "tour_id IN (SELECT id FROM tour WHERE id = ? AND workspace_id = ?)";
  const gone = JSON.stringify(removed);
  const kept = JSON.stringify(keep);
  return [
    // The guard and the new version: NULL, which fails NOT NULL and rolls everything back,
    // unless the draft is still at the revision the list was read at.
    { sql: "UPDATE tour SET draft_version = CASE WHEN draft_version = ? THEN draft_version + 1 END, updated_at = ? WHERE id = ? AND workspace_id = ?", params: [revision, now, tourId, ws] },
    {
      sql: "UPDATE upload SET closing_at = ? WHERE workspace_id = ? AND tour_id = ? AND closing_at IS NULL AND replaces_chapter_id IN (SELECT value FROM json_each(?))",
      params: [now, ws, tourId, JSON.stringify(affected)],
    },
    // At the new version (the bump ran first), so a publish job of an older draft holds them.
    {
      sql: `INSERT OR IGNORE INTO replaced_object (tour_id, image_key, draft_version, created_at)
            SELECT s.tour_id, s.image_key, t.draft_version, ? FROM step s JOIN tour t ON t.id = s.tour_id
             WHERE s.tour_id = ? AND t.workspace_id = ? AND s.chapter_id IN (SELECT value FROM json_each(?))
               AND NOT EXISTS (SELECT 1 FROM step k WHERE k.tour_id = s.tour_id AND k.image_key = s.image_key AND k.chapter_id NOT IN (SELECT value FROM json_each(?)))`,
      params: [now, tourId, ws, gone, gone],
    },
    { sql: `DELETE FROM step WHERE chapter_id IN (SELECT value FROM json_each(?)) AND ${owned}`, params: [gone, tourId, ws] },
    { sql: `DELETE FROM chapter WHERE id IN (SELECT value FROM json_each(?)) AND ${owned}`, params: [gone, tourId, ws] },
    {
      sql: `UPDATE chapter SET position = (SELECT CAST(j.key AS INTEGER) FROM json_each(?) j WHERE j.value = chapter.id)
             WHERE id IN (SELECT value FROM json_each(?)) AND ${owned}`,
      params: [kept, kept, tourId, ws],
    },
  ];
}

export function chapterRoutes(app: Hono, deps: Deps): void {
  // The chapters, for the tour's own workspace. One call after the credential.
  app.get("/api/v1/tours/:id/chapters", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    if (!TOUR_ID.test(id)) return noSuchTour();
    const list = await readChapters(deps, auth, id);
    return list === null ? noSuchTour() : json(200, list);
  });

  // Reorder and remove. At most 2 calls for the credential, 1 read, 1 batch, 1 + 3 x
  // CLOSED_REMOVED for closed replaces, 3 x CLEAR_PAGES for the files, 1 read: 27.
  app.put("/api/v1/tours/:id/chapters", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const body = await readBody(c.req.raw);
    if (body instanceof Response) return body;
    const id = c.req.param("id");
    if (!TOUR_ID.test(id)) return noSuchTour();
    const ws = auth.workspaceId;

    const now = await readChapters(deps, auth, id);
    if (now === null) return noSuchTour();
    if (body.revision !== now.revision) return changed();
    const have = now.chapters.map((ch) => ch.id);
    for (const chapterId of body.chapters) if (!have.includes(chapterId)) return noSuchChapter();
    const keep = new Set(body.chapters);
    const removed = have.filter((chapterId) => !keep.has(chapterId));
    if (removed.length === 0 && body.chapters.every((chapterId, i) => have[i] === chapterId)) return json(200, now);
    // The first chapter carries the tour's settings when it is replaced (src/replace.ts): its
    // open replaces, and the new first chapter's, were decided against the order before.
    const affected = [...removed];
    if (have[0] !== body.chapters[0]) affected.push(have[0], body.chapters[0]);

    try {
      await deps.db.batch(changeStatements(ws, id, body.revision, body.chapters, removed, [...new Set(affected)], deps.now()));
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      // The draft moved on since the read (an upload, a replace or another change landed in
      // between): nothing of the batch took effect.
      return changed();
    }

    // Housekeeping only: neither throws, and what is left is done by later requests.
    await removeClosedReplaces(deps, ws, id, [...new Set(affected)], CLOSED_REMOVED);
    for (let page = 0; page < CLEAR_PAGES; page++) {
      if ((await clearReplaced(deps, ws, id)) < REPLACED_FILES_PER_CALL) break;
    }
    const after = await readChapters(deps, auth, id);
    return after === null ? noSuchTour() : json(200, after);
  });
}
