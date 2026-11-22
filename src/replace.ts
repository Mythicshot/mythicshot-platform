// Replacing a chapter of an existing tour: the third upload target, on the same create /
// PUT / commit protocol as a new tour or a new chapter (src/uploads.ts routes here).
//
// - Create reads which pictures the chapter has now. Every stored picture carries the
//   SHA-256 the server computed from its bytes; the client sends one hash per new step,
//   and a new step whose hash, type, size and byte count equal a picture of the chapter is
//   recorded at once as an upload_step row that is stored, marked reused, and names that
//   picture's existing key. The client then sends only the other steps.
// - Commit swaps the chapter's steps in ONE batch: the old keys no new step uses go to
//   replaced_object, the old step rows go, the new ones come (new ids, positions from 0),
//   and the chapter records the upload as its revision. The chapter keeps its id, title
//   and position; the tour keeps its title, slug, status and snapshot. So the public page
//   changes only when the tour is published again.
// - The batch takes effect only while the upload is open, the chapter is still the tour's
//   and its revision is the one the upload was created against. Otherwise the first step
//   insert fails (NOT NULL) and the whole batch rolls back: two replaces of one chapter
//   can never mix, and a replace built on pictures another replace took away never lands.
// - A repeated commit finds its result by the chapter's revision.
// - A replace of the tour's FIRST chapter (lowest position) also carries the tour's
//   settings: the same batch replaces the tour's spotlight dim, theme, zoom, cover, button,
//   end card, autoplay and logo from the manifest, and the upload takes a logo like a new
//   tour's does. The previous logo goes to replaced_object. The title and slug never
//   change. A replace of any other chapter leaves all of that alone and refuses a logo.
// - The files of replaced_object are removed a page at a time (clearReplaced): by the
//   commit that recorded them, and by the workspace's tour list. Files first, then rows,
//   so a file is named by a row until it is gone. A publish copies from the draft keys of
//   the version it started from, so a row waits while a publish job of an older draft
//   exists for its tour. Deleting the tour takes whatever is left (src/tours.ts).
import { newId, type Auth } from "./auth.ts";
import type { Manifest } from "./manifest.ts";
import type { Deps, Stmt, Value } from "./ports.ts";

/**
 * Replaced pictures one request removes: the same page a tour delete removes per call
 * (DELETE_FILES_PER_CALL in src/tours.ts, which imports this file). One replace leaves at
 * most 200, so its own commit clears them in one page.
 */
export const REPLACED_FILES_PER_CALL = 250;

const UPLOAD_ID = /^up_[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type ImageType = "png" | "jpg";
const typeOf = (name: string): ImageType => (name.endsWith(".png") ? "png" : "jpg");
const json01 = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

/** The part of an upload row a replace needs. */
export type ReplaceUpload = {
  id: string;
  tour_id: string | null;
  replaces_chapter_id: string | null;
  /** The key of the logo this upload stored, if any. */
  logo_key: string | null;
  /** The size of that logo, which the tour records for its storage count. */
  logo_bytes: number | null;
  /** Whether the replaced chapter is the tour's first, so the tour's settings and logo come with it. */
  settings: boolean;
};

/**
 * SQL that is true when the chapter `chapterId` of tour `tourId` (two SQL expressions) is
 * the tour's first: no chapter of the tour comes before it in the order a publish reads
 * them (position, then id). A new chapter goes last, so only reordering or removing
 * chapters (src/chapters.ts) changes the answer for a chapter; that change closes the open
 * replaces of the chapters whose answer it changes, in the same batch, so a replace never
 * commits with settings decided against another first chapter.
 */
export function firstChapterSql(chapterId: string, tourId: string): string {
  return `NOT EXISTS (SELECT 1 FROM chapter fc JOIN chapter fo ON fo.tour_id = fc.tour_id AND (fo.position < fc.position OR (fo.position = fc.position AND fo.id < fc.id))
                       WHERE fc.id = ${chapterId} AND fc.tour_id = ${tourId})`;
}

/**
 * The bytes a replace of this chapter takes out of the workspace's storage count when it
 * commits, as a scalar SQL expression with its parameters: the bytes of the chapter's
 * steps as they are now and, for the tour's first chapter (`first`), the recorded size of
 * the tour's logo, which such a replace always replaces or removes. It is 0, never null,
 * for a chapter or tour that is gone or another workspace's. The create statement sets it
 * against what the new chapter needs, inside that statement, so a replace is held to its
 * growth as the chapter is at that moment.
 */
export function replacedBytes(workspaceId: string, tourId: string, chapterId: string, first: boolean): { sql: string; params: Value[] } {
  const steps = "(SELECT coalesce(sum(s.bytes), 0) FROM step s JOIN tour t ON t.id = s.tour_id WHERE s.chapter_id = ? AND s.tour_id = ? AND t.workspace_id = ?)";
  if (!first) return { sql: steps, params: [chapterId, tourId, workspaceId] };
  const logo = "coalesce((SELECT t.logo_bytes FROM tour t WHERE t.id = ? AND t.workspace_id = ?), 0)";
  return { sql: `(${steps} + ${logo})`, params: [chapterId, tourId, workspaceId, tourId, workspaceId] };
}

/** A picture a chapter has now whose bytes the server has hashed. */
export type ChapterPicture = { image_key: string; image_type: ImageType; width: number; height: number; bytes: number; sha256: string };

/** A new step that points at a picture the chapter already has. `n` counts from 1. */
export type Reused = { n: number; image_key: string; bytes: number; sha256: string };

/** What a replace commit answers. `publish` says whether publishing the tour now is safe. */
export type ReplaceAnswer = { tour_id: string; chapter_id: string; steps: number; publish: "draft" | "ready" | "other_changes" };

/**
 * The create body's `sha256`: exactly one lowercase hex SHA-256 per manifest step, or null
 * when it is anything else.
 */
export function parseHashes(value: unknown, steps: number): string[] | null {
  if (!Array.isArray(value) || value.length !== steps) return null;
  for (const h of value) if (typeof h !== "string" || !SHA256.test(h)) return null;
  return value as string[];
}

/**
 * Whether the tour is this workspace's, whether the chapter is a chapter of it, the
 * chapter's revision (the upload that last replaced it, or null), and whether it is the
 * tour's first chapter. One statement.
 */
export async function findChapter(deps: Deps, auth: Auth, tourId: string, chapterId: string): Promise<{ tour: boolean; chapter: boolean; revision: string | null; first: boolean }> {
  const row = await deps.db.first<{ chapter_id: string | null; revision: string | null; first: number }>(
    `SELECT c.id AS chapter_id, c.revision, ${firstChapterSql("c.id", "t.id")} AS first FROM tour t LEFT JOIN chapter c ON c.tour_id = t.id AND c.id = ?
      WHERE t.id = ? AND t.workspace_id = ?`,
    [chapterId, tourId, auth.workspaceId],
  );
  const chapter = row !== null && row.chapter_id !== null;
  return { tour: row !== null, chapter, revision: row?.revision ?? null, first: chapter && row.first === 1 };
}

/**
 * The pictures the chapter has now, in step order, for a chapter of a tour of this
 * workspace. A picture without a hash (stored before hashes were recorded, or one whose
 * bytes are not known for certain) is left out: it is never reused.
 */
export async function chapterPictures(deps: Deps, auth: Auth, tourId: string, chapterId: string): Promise<ChapterPicture[]> {
  return deps.db.all<ChapterPicture>(
    `SELECT s.image_key, s.image_type, s.width, s.height, s.bytes, s.sha256
       FROM step s JOIN tour t ON t.id = s.tour_id
      WHERE s.chapter_id = ? AND s.tour_id = ? AND t.workspace_id = ? AND s.sha256 IS NOT NULL AND s.sha256 <> ''
      ORDER BY s.position, s.id`,
    [chapterId, tourId, auth.workspaceId],
  );
}

/**
 * The new steps the chapter already has a picture for: same hash, type, width, height and
 * byte count. The hash alone is not trusted to say what a picture is, since the client
 * names it: the declared type and size must be those the server checked when it stored
 * the picture, so a step row never claims a size its picture does not have.
 */
export function reusedSteps(m: Manifest, hashes: string[], pictures: ChapterPicture[]): Reused[] {
  const signature = (sha256: string, type: ImageType, width: number, height: number, bytes: number) => `${sha256}/${type}/${width}/${height}/${bytes}`;
  const have = new Map<string, ChapterPicture>();
  for (const p of pictures) {
    const sig = signature(p.sha256, p.image_type, p.width, p.height, p.bytes);
    if (!have.has(sig)) have.set(sig, p);
  }
  const out: Reused[] = [];
  m.steps.forEach((s, i) => {
    const p = have.get(signature(hashes[i], typeOf(s.image), s.width, s.height, s.bytes));
    if (p !== undefined) out.push({ n: i + 1, image_key: p.image_key, bytes: p.bytes, sha256: p.sha256 });
  });
  return out;
}

/**
 * Records the reused steps of a new replace upload: stored, marked reused, under the
 * existing keys. Runs in the batch that creates the upload, and writes nothing unless
 * that upload row exists.
 */
export function reusedStatement(workspaceId: string, uploadId: string, reused: Reused[], now: number): Stmt {
  return {
    sql: `INSERT INTO upload_step (upload_id, n, image_key, bytes, sha256, reused, stored_at)
          SELECT u.id, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), 1, ?
            FROM json_each(?) j JOIN upload u ON u.id = ? AND u.workspace_id = ?`,
    params: [now, JSON.stringify(reused.map((r) => [r.n, r.image_key, r.bytes, r.sha256])), uploadId, workspaceId],
  };
}

/**
 * The replace commit's statements, one batch. The first step insert takes its tour id from
 * the upload, tour and chapter rows themselves, so it fails (NOT NULL) and rolls the whole
 * batch back unless the upload is open and this workspace's, the tour is this workspace's,
 * the chapter is still a chapter of that tour, and the chapter's revision is the one the
 * upload was created against. Each new step takes its key and hash from its upload_step
 * row: the upload's own key for a picture that was sent, the existing one for a reused step.
 * With `up.settings` (the chapter is the tour's first) the tour's settings and logo are
 * replaced from the manifest too, and the previous logo is recorded for removal.
 */
export function replaceStatements(deps: Deps, auth: Auth, up: ReplaceUpload, m: Manifest, stamped = true): Stmt[] {
  const now = deps.now();
  const ws = auth.workspaceId;
  const tourId = up.tour_id ?? "";
  const chapterId = up.replaces_chapter_id ?? "";
  const guardedTour = `(SELECT t.id FROM upload u JOIN tour t ON t.id = u.tour_id JOIN chapter c ON c.id = u.replaces_chapter_id AND c.tour_id = t.id
                         WHERE u.id = ? AND u.workspace_id = ? AND u.closing_at IS NULL AND t.workspace_id = ? AND c.revision IS u.base_revision)`;
  const stmts: Stmt[] = [
    // The draft moves on by one version: the version that orphans the pictures recorded next.
    { sql: "UPDATE tour SET updated_at = ?, draft_version = draft_version + 1 WHERE id = ? AND workspace_id = ?", params: [now, tourId, ws] },
    // Every old key of the chapter that no new step uses. A key belongs to one chapter only:
    // a step's key is under the id of the upload that sent it, each upload fills one
    // chapter, and a replace reuses keys of its own chapter only (chapterPictures reads no
    // other). So no step outside the chapter can use one of these keys, and none is looked for.
    {
      sql: `INSERT OR IGNORE INTO replaced_object (tour_id, image_key, draft_version, created_at)
            SELECT s.tour_id, s.image_key, t.draft_version, ? FROM step s JOIN tour t ON t.id = s.tour_id
             WHERE s.chapter_id = ? AND s.tour_id = ? AND t.workspace_id = ?
               AND s.image_key NOT IN (SELECT image_key FROM upload_step WHERE upload_id = ?)`,
      params: [now, chapterId, tourId, ws, up.id],
    },
    {
      sql: "DELETE FROM step WHERE chapter_id = ? AND tour_id IN (SELECT id FROM tour WHERE id = ? AND workspace_id = ?)",
      params: [chapterId, tourId, ws],
    },
  ];
  if (up.settings) {
    // Both act only for the tour's first chapter, whatever the caller believed. The title
    // and slug are not among the columns: an update never renames a tour or moves its link.
    const first = firstChapterSql("?", "tour.id");
    const logoType = m.cover?.logo ? typeOf(m.cover.logo) : null;
    stmts.push({
      sql: `INSERT OR IGNORE INTO replaced_object (tour_id, image_key, draft_version, created_at)
            SELECT tour.id, tour.logo_key, tour.draft_version, ? FROM tour WHERE tour.id = ? AND tour.workspace_id = ? AND tour.logo_key IS NOT NULL AND ${first}`,
      params: [now, tourId, ws, chapterId],
    });
    stmts.push({
      // The spotlight dim is replaced only when the manifest sets one, as for a chapter
      // upload: the other chapters' spotlights are dimmed by the tour's value too. The
      // logo's size goes with its key, so the storage count holds the new logo, or none.
      sql: `UPDATE tour SET spotlight_dim = coalesce(?, spotlight_dim), theme = ?, zoom = ?, cover = ?, cta = ?, end_card = ?, autoplay = ?, logo_key = ?, logo_type = ?, logo_bytes = ?
             WHERE tour.id = ? AND tour.workspace_id = ? AND ${first}`,
      params: [
        m.spotlight_dim, JSON.stringify(m.theme), JSON.stringify(m.zoom), json01(m.cover), json01(m.cta), json01(m.end), JSON.stringify(m.autoplay),
        logoType === null ? null : up.logo_key, logoType, logoType === null ? null : up.logo_bytes, tourId, ws, chapterId,
      ],
    });
  }
  m.steps.forEach((s, i) => {
    const sent = "FROM upload_step WHERE upload_id = ? AND n = ?";
    stmts.push({
      sql: `INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, click_x, click_y, spotlight, notes, card, advance, zoom, sha256)
            VALUES (?, ${i === 0 ? guardedTour : "?"}, ?, ?, (SELECT image_key ${sent}), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT nullif(sha256, '') ${sent}))`,
      params: [
        newId("st"), ...(i === 0 ? [up.id, ws, ws] : [tourId]), chapterId, i, up.id, i + 1, typeOf(s.image), s.width, s.height, s.bytes,
        s.click?.x ?? null, s.click?.y ?? null, json01(s.spotlight), JSON.stringify(s.notes), json01(s.card), s.advance,
        s.zoom === null ? null : s.zoom ? 1 : 0, up.id, i + 1,
      ],
    });
  });
  // The tour's new draft version (the bump ran first) is this replace's. replaced_from
  // keeps the version of the first replace of a run: it stays when the chapter's previous
  // replace made the version just before this one, so nothing else changed the draft in
  // between, and starts again at this version otherwise. (Every right-hand side reads the
  // row as it was before this statement.) With `stamped` the chapter also records when it
  // was uploaded (migration 0019; chapterTimesMissing tells a database before it).
  const version = "(SELECT draft_version FROM tour WHERE id = ? AND workspace_id = ?)";
  stmts.push({
    sql: `UPDATE chapter SET revision = ?, replaced_version = ${version},
                             replaced_from = CASE WHEN replaced_version = ${version} - 1 THEN replaced_from ELSE ${version} END${stamped ? ", uploaded_at = ?" : ""}
           WHERE id = ? AND tour_id IN (SELECT id FROM tour WHERE id = ? AND workspace_id = ?)`,
    params: [up.id, tourId, ws, tourId, ws, tourId, ws, ...(stamped ? [now] : []), chapterId, tourId, ws],
  });
  stmts.push({ sql: "DELETE FROM upload_step WHERE upload_id IN (SELECT id FROM upload WHERE id = ? AND workspace_id = ?)", params: [up.id, ws] });
  stmts.push({ sql: "DELETE FROM upload WHERE id = ? AND workspace_id = ?", params: [up.id, ws] });
  return stmts;
}

/**
 * The result of a replace commit that already happened, found by the chapter that records
 * the upload as its revision, or null. `publish` is worked out from the tour as it is now:
 * - "draft": the tour is not published, so there is nothing to publish again.
 * - "ready": the tour is published, nothing has changed its draft since this replace, and
 *   the live snapshot was built from the draft just before the chapter's current run of
 *   replaces (replaced_from) or from a later one: the only changes that are not public
 *   are replaces of this chapter, so publishing puts this replace live and nothing else.
 *   A second update with no publish in between (the publish after the first failed, say)
 *   is therefore ready too.
 * - "other_changes": anything else, a snapshot whose draft version is not known included.
 *   Publishing would also put other changes live that were never published.
 * A rename never counts as a change here: it does not move the draft version, and it
 * writes the title into the live snapshot itself (src/tours.ts).
 */
export async function replaceAnswer(deps: Deps, auth: Auth, uploadId: string): Promise<ReplaceAnswer | null> {
  if (!UPLOAD_ID.test(uploadId)) return null;
  const row = await deps.db.first<{ chapter_id: string; tour_id: string; replaced_version: number | null; replaced_from: number | null; status: string; draft_version: number; steps: number; live_version: number | null }>(
    `SELECT c.id AS chapter_id, c.tour_id, c.replaced_version, c.replaced_from, t.status, t.draft_version,
            (SELECT count(*) FROM step s WHERE s.chapter_id = c.id AND s.tour_id = c.tour_id) AS steps,
            (SELECT n.draft_version FROM snapshot n WHERE n.tour_id = t.id) AS live_version
       FROM chapter c JOIN tour t ON t.id = c.tour_id WHERE c.revision = ? AND t.workspace_id = ?`,
    [uploadId, auth.workspaceId],
  );
  if (row === null) return null;
  let publish: ReplaceAnswer["publish"] = "other_changes";
  if (row.status !== "published") publish = "draft";
  else if (row.replaced_version !== null && row.draft_version === row.replaced_version && row.replaced_from !== null && row.live_version !== null && row.live_version >= row.replaced_from - 1) {
    publish = "ready";
  }
  return { tour_id: row.tour_id, chapter_id: row.chapter_id, steps: row.steps, publish };
}

/**
 * Removes one page of replaced pictures of the workspace: at most REPLACED_FILES_PER_CALL
 * keys, this tour's first (when `tourId` is given), then the oldest. A key is taken only
 * while no publish job of an older draft exists for its tour: such a publish still copies
 * from it. The files go from the drafts store first, then their rows, so a call cut off
 * in between leaves the rows and a later call deletes the same keys again (a key that is
 * already gone is not an error). Three calls at most. Housekeeping only: an error is
 * logged as fixed text and never thrown. Answers how many keys it removed (0 after an
 * error), so a caller with room left can tell whether a full page may have more behind it.
 */
export async function clearReplaced(deps: Deps, workspaceId: string, tourId: string | null): Promise<number> {
  const free = "NOT EXISTS (SELECT 1 FROM publish_job j WHERE j.tour_id = replaced_object.tour_id AND j.draft_version < replaced_object.draft_version)";
  const owned = "tour_id IN (SELECT id FROM tour WHERE workspace_id = ?)";
  try {
    const rows = await deps.db.all<{ image_key: string }>(
      `SELECT image_key FROM replaced_object WHERE ${owned} AND ${free}
        ORDER BY tour_id <> ?, created_at, tour_id, image_key LIMIT ?`,
      [workspaceId, tourId ?? "", REPLACED_FILES_PER_CALL],
    );
    if (rows.length === 0) return 0;
    const keys = rows.map((r) => r.image_key);
    await deps.drafts.delete(keys);
    await deps.db.run(`DELETE FROM replaced_object WHERE image_key IN (SELECT value FROM json_each(?)) AND ${owned} AND ${free}`, [JSON.stringify(keys), workspaceId]);
    return keys.length;
  } catch {
    // The error itself is not logged: it could carry anything a back end put in its message.
    console.error("replace: could not remove replaced pictures; will retry later");
    return 0;
  }
}

/**
 * True for the error of a statement naming chapter.uploaded_at on a database migration 0019
 * has not reached (a build started before its migration ran): a commit then runs again
 * without the time, as before.
 */
export function chapterTimesMissing(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/(?:no such column: (?:chapter\.)?uploaded_at|has no column named uploaded_at)(?:$|:| at offset |\s)/.test(e.message)) return true;
  }
  return false;
}
