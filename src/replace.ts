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
import { newId, type Auth } from "./auth.ts";
import type { Manifest } from "./manifest.ts";
import type { Deps, Stmt } from "./ports.ts";

const UPLOAD_ID = /^up_[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type ImageType = "png" | "jpg";
const typeOf = (name: string): ImageType => (name.endsWith(".png") ? "png" : "jpg");
const json01 = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

/** The part of an upload row a replace needs. */
export type ReplaceUpload = { id: string; tour_id: string | null; replaces_chapter_id: string | null };

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
 * Whether the tour is this workspace's, whether the chapter is a chapter of it, and the
 * chapter's revision (the upload that last replaced it, or null). One statement.
 */
export async function findChapter(deps: Deps, auth: Auth, tourId: string, chapterId: string): Promise<{ tour: boolean; chapter: boolean; revision: string | null }> {
  const row = await deps.db.first<{ chapter_id: string | null; revision: string | null }>(
    `SELECT c.id AS chapter_id, c.revision FROM tour t LEFT JOIN chapter c ON c.tour_id = t.id AND c.id = ?
      WHERE t.id = ? AND t.workspace_id = ?`,
    [chapterId, tourId, auth.workspaceId],
  );
  return { tour: row !== null, chapter: row !== null && row.chapter_id !== null, revision: row?.revision ?? null };
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
 */
export function replaceStatements(deps: Deps, auth: Auth, up: ReplaceUpload, m: Manifest): Stmt[] {
  const now = deps.now();
  const ws = auth.workspaceId;
  const tourId = up.tour_id ?? "";
  const chapterId = up.replaces_chapter_id ?? "";
  const guardedTour = `(SELECT t.id FROM upload u JOIN tour t ON t.id = u.tour_id JOIN chapter c ON c.id = u.replaces_chapter_id AND c.tour_id = t.id
                         WHERE u.id = ? AND u.workspace_id = ? AND u.closing_at IS NULL AND t.workspace_id = ? AND c.revision IS u.base_revision)`;
  const stmts: Stmt[] = [
    // The draft moves on by one version: the version that orphans the pictures recorded next.
    { sql: "UPDATE tour SET updated_at = ?, draft_version = draft_version + 1 WHERE id = ? AND workspace_id = ?", params: [now, tourId, ws] },
    // Every old key of the chapter that no new step uses. A key belongs to one chapter only
    // (a step's key is under the id of the upload that sent it, and a replace reuses keys of
    // its own chapter only); the last condition holds that against any mistake.
    {
      sql: `INSERT OR IGNORE INTO replaced_object (tour_id, image_key, draft_version, created_at)
            SELECT s.tour_id, s.image_key, t.draft_version, ? FROM step s JOIN tour t ON t.id = s.tour_id
             WHERE s.chapter_id = ? AND s.tour_id = ? AND t.workspace_id = ?
               AND s.image_key NOT IN (SELECT image_key FROM upload_step WHERE upload_id = ?)
               AND NOT EXISTS (SELECT 1 FROM step o WHERE o.tour_id = s.tour_id AND o.chapter_id <> s.chapter_id AND o.image_key = s.image_key)`,
      params: [now, chapterId, tourId, ws, up.id],
    },
    {
      sql: "DELETE FROM step WHERE chapter_id = ? AND tour_id IN (SELECT id FROM tour WHERE id = ? AND workspace_id = ?)",
      params: [chapterId, tourId, ws],
    },
  ];
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
  stmts.push({
    sql: `UPDATE chapter SET revision = ?, replaced_version = (SELECT draft_version FROM tour WHERE id = ? AND workspace_id = ?)
           WHERE id = ? AND tour_id IN (SELECT id FROM tour WHERE id = ? AND workspace_id = ?)`,
    params: [up.id, tourId, ws, chapterId, tourId, ws],
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
 *   the live snapshot was built from the draft just before the replace (or already from
 *   the one it made): publishing now puts this replace live and nothing else.
 * - "other_changes": anything else, a snapshot whose draft version is not known included.
 *   Publishing would also put other changes live that were never published.
 */
export async function replaceAnswer(deps: Deps, auth: Auth, uploadId: string): Promise<ReplaceAnswer | null> {
  if (!UPLOAD_ID.test(uploadId)) return null;
  const row = await deps.db.first<{ chapter_id: string; tour_id: string; replaced_version: number | null; status: string; draft_version: number; steps: number; live_version: number | null }>(
    `SELECT c.id AS chapter_id, c.tour_id, c.replaced_version, t.status, t.draft_version,
            (SELECT count(*) FROM step s WHERE s.chapter_id = c.id AND s.tour_id = c.tour_id) AS steps,
            (SELECT n.draft_version FROM snapshot n WHERE n.tour_id = t.id) AS live_version
       FROM chapter c JOIN tour t ON t.id = c.tour_id WHERE c.revision = ? AND t.workspace_id = ?`,
    [uploadId, auth.workspaceId],
  );
  if (row === null) return null;
  const made = row.replaced_version;
  let publish: ReplaceAnswer["publish"] = "other_changes";
  if (row.status !== "published") publish = "draft";
  else if (made !== null && row.draft_version === made && (row.live_version === made - 1 || row.live_version === made)) publish = "ready";
  return { tour_id: row.tour_id, chapter_id: row.chapter_id, steps: row.steps, publish };
}
