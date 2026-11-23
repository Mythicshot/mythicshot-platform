// The upload protocol: create, one request per step image (and the logo), then commit;
// or abort. Every query is scoped by the workspace of the authenticated token, and an
// upload only ever deletes the objects under its own random id, named from its own rows
// and manifest, never found by listing.
//
// Bookkeeping that keeps an abort exact and a commit all-or-nothing:
// - A step's row is written before its object, claiming the step number, and marked
//   stored_at once the object is written. The logo works the same way with logo_key and
//   logo_bytes on the upload row. A second send of the same step is refused before it
//   can replace the first object.
// - An abort first sets closing_at. Commit statements only take effect while closing_at
//   is null, so an abort and a commit can never both act on one upload.
// - A draft key is `u/<upload_id>/step-<NNN>.<ext>` or `u/<upload_id>/logo.<ext>`, so
//   abort can name every key the upload could have written, even one whose request was
//   cut off before its row was finished.
// - A step claim left unfinished for STALE_CLAIM_MS (its request died) may be taken over
//   by a resend. Each claim carries a random token, and only the current holder may mark
//   the step stored or release it.
// - An upload that makes a new tour takes a logo, and so does one that replaces a tour's
//   first chapter (it carries the tour's settings). Any other upload into an existing
//   tour keeps that tour's logo and refuses one, so no logo object is ever left unrecorded.
// - Every stored step records the SHA-256 of the bytes the server accepted, in the same
//   statement that marks it stored, and commit copies it to the step. A hash is either
//   that of the bytes in the store or null (unknown): a writer that lost its claim after
//   writing its object clears it, since which bytes the store kept cannot be told.
// - An upload that replaces a chapter (src/replace.ts) may hold steps marked reused, whose
//   key is a picture the chapter already has, under another upload's id. An abort leaves
//   those out: it deletes only the keys under the upload's own id.
import type { Hono } from "hono";
import { newId, newSlug, requireAuth, type Auth } from "./auth.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { UPLOAD_MAX_AGE_MS } from "./limits.ts";
import { LIMITS, parseManifest, type Manifest } from "./manifest.ts";
import { isNotNullViolation, isUniqueViolation, type Deps, type Stmt } from "./ports.ts";
import { MAX_PUBLISH_STEPS, housekeeping } from "./publish.ts";
import { chapterPictures, chapterTimesMissing, clearReplaced, findChapter, firstChapterSql, parseHashes, replaceAnswer, replaceStatements, replacedBytes, reusedStatement, reusedSteps, type Reused } from "./replace.ts";
import { LOGO_RULE, STEP_IMAGE_RULE, checkImage, type ImageType } from "./sniff.ts";
import { ALLOWANCE_OF_SQL, USED_SQL, allowanceParams, reservedFor, storageFull, usageOf } from "./usage.ts";

/** An upload older than this is swept by the workspace's next create. It lives in src/limits.ts; the name stays here for the files that import it from this one. */
export { UPLOAD_MAX_AGE_MS };
/** At most this many stale uploads are swept per create, to bound the work of one request. */
const SWEEP_LIMIT = 5;
/** The create body without a hash list: the manifest's cap plus room for the envelope around it. */
const CREATE_BODY_BYTES = LIMITS.manifestBytes + 4096;
/**
 * The create body with the hash list of a replace: a fixed 14,000 bytes more (200 hashes
 * of 64 characters, quoted and separated). Only a body that carries `sha256` may use them.
 */
const CREATE_BODY_WITH_HASHES_BYTES = CREATE_BODY_BYTES + 14_000;
/** Attempts at a fresh slug when a new tour's slug collides. */
const SLUG_ATTEMPTS = 5;
/** Open uploads per workspace when the config sets no other number. */
export const DEFAULT_MAX_OPEN_UPLOADS = 5;
/**
 * The most chapters a tour has (0.1.56). Every chapter has at least one step and a tour
 * publishes at most MAX_PUBLISH_STEPS, so a tour with more could never be published, and a
 * change of its chapters (src/chapters.ts) lists at most this many ids. A new chapter is
 * refused at its create and, for uploads started side by side, at its commit, once the tour
 * has this many; a replace keeps the number and a new tour has one.
 */
export const MAX_CHAPTERS = MAX_PUBLISH_STEPS;
/** Seconds a client refused by the open-upload cap is told to wait. */
const CAP_RETRY_AFTER_S = 60;
/** An unfinished step claim older than this may be taken over by a resend. */
export const STALE_CLAIM_MS = 60_000;

const UPLOAD_ID = /^up_[0-9a-f]{24}$/;
const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const CHAPTER_ID = /^ch_[0-9a-f]{24}$/;
const STEP_NUMBER = /^[1-9][0-9]{0,2}$/;

const DRAFT_META = (type: ImageType) => ({ contentType: type === "png" ? "image/png" : "image/jpeg", cacheControl: "private, no-store" });

type UploadRow = {
  id: string;
  tour_id: string | null;
  manifest: string;
  logo_key: string | null;
  logo_bytes: number | null;
  /** The logo's size as the create declared it (`logo_bytes` in its body), or null: then any size within the rule is taken. */
  logo_declared_bytes: number | null;
  closing_at: number | null;
  /** The chapter this upload replaces, or null for a new tour or a new chapter. */
  replaces_chapter_id: string | null;
  /** True for a replace of the tour's first chapter: it carries the tour's settings and logo. */
  settings: boolean;
};

/** Whether this upload takes a logo: one that makes a new tour, or replaces a tour's first chapter. */
const takesLogo = (up: UploadRow) => up.tour_id === null || up.settings;

function extOf(name: string): ImageType {
  return name.endsWith(".png") ? "png" : "jpg";
}

function stepKey(uploadId: string, n: number, type: ImageType): string {
  return `u/${uploadId.toLowerCase()}/step-${String(n).padStart(3, "0")}.${type}`;
}

function logoKey(uploadId: string, type: ImageType): string {
  return `u/${uploadId.toLowerCase()}/logo.${type}`;
}

/** The chapter a commit creates is named after its upload, so a repeated commit finds it. */
function chapterIdFor(uploadId: string): string {
  return "ch_" + uploadId.slice(3);
}

const notFound = (what: string) => apiError(404, "not_found", `no such ${what}`);

async function loadUpload(deps: Deps, auth: Auth, id: string): Promise<UploadRow | null> {
  if (!UPLOAD_ID.test(id)) return null;
  const row = await deps.db.first<Omit<UploadRow, "settings"> & { first: number }>(
    `SELECT id, tour_id, manifest, logo_key, logo_bytes, logo_declared_bytes, closing_at, replaces_chapter_id,
            (replaces_chapter_id IS NOT NULL AND ${firstChapterSql("upload.replaces_chapter_id", "upload.tour_id")}) AS first
       FROM upload WHERE id = ? AND workspace_id = ?`,
    [id, auth.workspaceId],
  );
  if (row === null) return null;
  const { first, ...rest } = row;
  return { ...rest, settings: first === 1 };
}

/** Every draft key this upload could have written: one per step, and the logo if its manifest names one. */
function possibleKeys(id: string, manifest: Manifest): string[] {
  const keys = manifest.steps.map((s, i) => stepKey(id, i + 1, extOf(s.image)));
  if (manifest.cover?.logo) keys.push(logoKey(id, extOf(manifest.cover.logo)));
  return keys;
}

/**
 * Removes an upload of this workspace: marks it closing (so no commit can take it any
 * more), deletes exactly its own objects, then its rows. An upload that is already gone,
 * or was committed meanwhile, is left alone. A step of a replace that reuses a picture of
 * the chapter names a key the chapter still uses, so reused rows are left out of the keys.
 */
export async function abortUpload(deps: Deps, workspaceId: string, id: string): Promise<void> {
  const row = await deps.db.first<Closing>("SELECT id, manifest, logo_key FROM upload WHERE id = ? AND workspace_id = ?", [id, workspaceId]);
  if (row === null) return;
  const marked = await deps.db.run("UPDATE upload SET closing_at = coalesce(closing_at, ?) WHERE id = ? AND workspace_id = ?", [deps.now(), id, workspaceId]);
  if (marked.changes === 0) return; // committed (or aborted) since the read: nothing of it is ours to delete
  await removeClosing(deps, workspaceId, row);
}

/** What removing an upload needs of its row. */
type Closing = { id: string; manifest: string; logo_key: string | null };

/**
 * Removes an upload of this workspace that is already marked closing: exactly its own
 * objects, then its rows. Three calls. Only for a row whose closing_at is set: from then
 * on no commit can take it, so what it stored is nobody else's.
 */
async function removeClosing(deps: Deps, workspaceId: string, row: Closing): Promise<void> {
  const id = row.id;
  const recorded = await deps.db.all<{ image_key: string }>(
    "SELECT s.image_key FROM upload_step s JOIN upload u ON u.id = s.upload_id WHERE s.upload_id = ? AND u.workspace_id = ? AND s.reused = 0",
    [id, workspaceId],
  );
  const keys = new Set(possibleKeys(id, JSON.parse(row.manifest) as Manifest));
  for (const r of recorded) keys.add(r.image_key);
  if (row.logo_key !== null) keys.add(row.logo_key);
  await deps.drafts.delete([...keys]);
  await deps.db.batch([
    { sql: "DELETE FROM upload_step WHERE upload_id IN (SELECT id FROM upload WHERE id = ? AND workspace_id = ?)", params: [id, workspaceId] },
    { sql: "DELETE FROM upload WHERE id = ? AND workspace_id = ?", params: [id, workspaceId] },
  ]);
}

/**
 * Removes up to `limit` replaces of the tour `tourId` that are closing and replace one of
 * `chapterIds` (the replaces a change of the tour's chapters closed, src/chapters.ts): their
 * own files, then their rows, as an abort does. One call, then three per upload. What fails
 * stays closed, and the sweep removes it once it is old. Never throws.
 */
export async function removeClosedReplaces(deps: Deps, workspaceId: string, tourId: string, chapterIds: string[], limit: number): Promise<void> {
  if (chapterIds.length === 0 || limit < 1) return;
  try {
    const rows = await deps.db.all<Closing>(
      "SELECT id, manifest, logo_key FROM upload WHERE workspace_id = ? AND tour_id = ? AND closing_at IS NOT NULL AND replaces_chapter_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id LIMIT ?",
      [workspaceId, tourId, JSON.stringify(chapterIds), limit],
    );
    for (const row of rows) await removeClosing(deps, workspaceId, row);
  } catch {
    // The error itself is not logged: it could carry anything a back end put in its message.
    console.error("chapters: could not remove a closed upload yet; the sweep removes it later");
  }
}

/**
 * Closes every upload of the workspace older than UPLOAD_MAX_AGE_MS, in one statement, then
 * removes up to SWEEP_LIMIT of them (files and rows). Closing comes first and covers all of
 * them, however many there are and whether or not their files can be deleted: from then on
 * none can be committed, and none holds room against the storage allowance or a place
 * under the open-upload cap. What could not be removed now is tried again by a later sweep.
 */
async function sweep(deps: Deps, workspaceId: string): Promise<void> {
  const now = deps.now();
  const floor = now - UPLOAD_MAX_AGE_MS;
  await deps.db.run("UPDATE upload SET closing_at = ? WHERE workspace_id = ? AND created_at < ? AND closing_at IS NULL", [now, workspaceId, floor]);
  const stale = await deps.db.all<Closing>(
    "SELECT id, manifest, logo_key FROM upload WHERE workspace_id = ? AND created_at < ? AND closing_at IS NOT NULL ORDER BY created_at LIMIT ?",
    [workspaceId, floor, SWEEP_LIMIT],
  );
  for (const row of stale) {
    const id = row.id;
    try {
      await removeClosing(deps, workspaceId, row);
    } catch {
      // The upload stays closed to commits and is tried again by a later sweep. The error
      // itself is not logged: it could carry anything a back end put in its message.
      console.error(`sweep: could not remove abandoned upload ${id}; will retry later`);
    }
  }
}

/** A new chapter for a tour that already has MAX_CHAPTERS. */
const tourFull = () => apiError(409, "too_many_chapters", `the tour already has ${MAX_CHAPTERS} chapters, the most a tour may have; remove a chapter first (PUT /api/v1/tours/{id}/chapters)`);

/** A random token naming one request's claim on a step. */
function claimToken(): string {
  return newId("up").slice(3);
}

/** The result of a commit that already happened, found by its chapter, or null. */
async function committed(deps: Deps, auth: Auth, uploadId: string): Promise<{ tour_id: string; chapter_id: string; steps: number } | null> {
  if (!UPLOAD_ID.test(uploadId)) return null;
  const row = await deps.db.first<{ chapter_id: string; tour_id: string; steps: number }>(
    `SELECT c.id AS chapter_id, c.tour_id, (SELECT count(*) FROM step s WHERE s.chapter_id = c.id AND s.tour_id = c.tour_id) AS steps
       FROM chapter c JOIN tour t ON t.id = c.tour_id WHERE c.id = ? AND t.workspace_id = ?`,
    [chapterIdFor(uploadId), auth.workspaceId],
  );
  return row === null ? null : { tour_id: row.tour_id, chapter_id: row.chapter_id, steps: row.steps };
}

/** Whether the upload is still open and its tour, of this workspace, has MAX_CHAPTERS. One statement. */
async function tourIsFull(deps: Deps, auth: Auth, uploadId: string): Promise<boolean> {
  const row = await deps.db.first<{ full: number }>(
    `SELECT (SELECT count(*) FROM chapter c WHERE c.tour_id = t.id) >= ? AS full
       FROM upload u JOIN tour t ON t.id = u.tour_id WHERE u.id = ? AND u.workspace_id = ? AND u.closing_at IS NULL AND t.workspace_id = ?`,
    [MAX_CHAPTERS, uploadId, auth.workspaceId, auth.workspaceId],
  );
  return row !== null && row.full === 1;
}

/** The lowercase hex SHA-256 of `bytes`. Web Crypto, so not a storage or database call. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

const json01 = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

/**
 * The commit's statements. Each insert of a tour or chapter takes a value only an open upload of this workspace supplies, so it fails (NOT NULL) once the upload is closing or gone,
 * and a new chapter's also only while its tour has fewer than MAX_CHAPTERS.
 * With `stamped` the new chapter records when it was uploaded (migration 0019); without, on a
 * database before it, as before.
 */
function commitStatements(deps: Deps, auth: Auth, up: UploadRow, m: Manifest, tourId: string, slug: string, stamped = true): Stmt[] {
  const now = deps.now();
  const chapterId = chapterIdFor(up.id);
  const openUpload = "FROM upload WHERE id = ? AND workspace_id = ? AND closing_at IS NULL";
  const timeColumn = stamped ? ", uploaded_at" : "";
  const timeValue = stamped ? ", ?" : "";
  const time = stamped ? [now] : [];
  const stmts: Stmt[] = [];
  if (up.tour_id === null) {
    const logoType = m.cover?.logo ? extOf(m.cover.logo) : null;
    stmts.push({
      // The logo's size comes over from the upload with its key: from here on the storage
      // count holds what the logo weighs, in place of the room the upload reserved for it.
      sql: `INSERT INTO tour (id, workspace_id, title, slug, status, spotlight_dim, theme, zoom, cover, cta, end_card, autoplay, logo_key, logo_type, logo_bytes, created_at, updated_at, draft_version)
            VALUES (?, (SELECT workspace_id ${openUpload}), ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      params: [
        tourId, up.id, auth.workspaceId, m.title, slug, m.spotlight_dim,
        JSON.stringify(m.theme), JSON.stringify(m.zoom), json01(m.cover), json01(m.cta), json01(m.end), JSON.stringify(m.autoplay),
        logoType === null ? null : up.logo_key, logoType, logoType === null ? null : up.logo_bytes, now, now,
      ],
    });
    stmts.push({
      sql: `INSERT INTO chapter (id, tour_id, title, description, position${timeColumn}) VALUES (?, (SELECT ? ${openUpload}), ?, NULL, 0${timeValue})`,
      params: [chapterId, tourId, up.id, auth.workspaceId, m.title, ...time],
    });
  } else {
    stmts.push({
      sql: `INSERT INTO chapter (id, tour_id, title, description, position${timeColumn})
            VALUES (?, (SELECT t.id FROM upload u JOIN tour t ON t.id = u.tour_id WHERE u.id = ? AND u.workspace_id = ? AND u.closing_at IS NULL AND t.workspace_id = ?
                                AND (SELECT count(*) FROM chapter fc WHERE fc.tour_id = t.id) < ?), ?, NULL,
                    (SELECT coalesce(max(position) + 1, 0) FROM chapter WHERE tour_id = ?)${timeValue})`,
      params: [chapterId, up.id, auth.workspaceId, auth.workspaceId, MAX_CHAPTERS, m.title, tourId, ...time],
    });
    stmts.push({
      sql: "UPDATE tour SET spotlight_dim = coalesce(spotlight_dim, ?), updated_at = ?, draft_version = draft_version + 1 WHERE id = ? AND workspace_id = ?",
      params: [m.spotlight_dim, now, tourId, auth.workspaceId],
    });
  }
  m.steps.forEach((s, i) => {
    stmts.push({
      // The hash is the one recorded when the step's bytes were stored ('' never reaches a step).
      sql: `INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, click_x, click_y, spotlight, notes, card, advance, zoom, sha256)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT nullif(sha256, '') FROM upload_step WHERE upload_id = ? AND n = ?))`,
      params: [
        newId("st"), tourId, chapterId, i, stepKey(up.id, i + 1, extOf(s.image)), extOf(s.image), s.width, s.height, s.bytes,
        s.click?.x ?? null, s.click?.y ?? null, json01(s.spotlight), JSON.stringify(s.notes), json01(s.card), s.advance,
        s.zoom === null ? null : s.zoom ? 1 : 0, up.id, i + 1,
      ],
    });
  });
  stmts.push({ sql: "DELETE FROM upload_step WHERE upload_id IN (SELECT id FROM upload WHERE id = ? AND workspace_id = ?)", params: [up.id, auth.workspaceId] });
  stmts.push({ sql: "DELETE FROM upload WHERE id = ? AND workspace_id = ?", params: [up.id, auth.workspaceId] });
  return stmts;
}

/**
 * A commit's batch with the chapter's upload time, or, on a database migration 0019 has not
 * reached (the batch then fails on the column and changes nothing), the same batch without
 * it, as before. One call, two only on such a database.
 */
async function stampedBatch(deps: Deps, make: (stamped: boolean) => Stmt[]): Promise<void> {
  try {
    await deps.db.batch(make(true));
  } catch (err) {
    if (!chapterTimesMissing(err)) throw err;
    await deps.db.batch(make(false));
  }
}

/** Reads an image body for an upload: 413 over the cap, else the bytes. */
async function readImage(req: Request, maxBytes: number): Promise<Uint8Array | Response> {
  const body = await readCapped(req, maxBytes);
  if (body === "too_large") return apiError(413, "too_large", `the image is over ${maxBytes} bytes`);
  return body;
}

export function uploadRoutes(app: Hono, deps: Deps): void {
  app.post("/api/v1/uploads", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const raw = await readCapped(c.req.raw, CREATE_BODY_WITH_HASHES_BYTES);
    if (raw === "too_large") return apiError(413, "too_large", `the request is over ${CREATE_BODY_WITH_HASHES_BYTES} bytes`);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    } catch {
      return apiError(400, "bad_request", "the body is not JSON");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return apiError(400, "bad_request", "the body must be an object");
    const b = body as Record<string, unknown>;
    // The larger cap is for the hash list alone: without one, the cap is what it always was.
    if (!Object.hasOwn(b, "sha256") && raw.byteLength > CREATE_BODY_BYTES) return apiError(413, "too_large", `the request is over ${CREATE_BODY_BYTES} bytes`);
    if (!Object.hasOwn(b, "manifest")) return apiError(400, "bad_manifest", "manifest is required");
    const parsed = parseManifest(b.manifest);
    if (!parsed.ok) return apiError(400, "bad_manifest", parsed.error);
    const target = Object.hasOwn(b, "target") ? b.target : undefined;
    if (target === null || typeof target !== "object" || Array.isArray(target)) return apiError(400, "bad_target", "target must be an object");
    const t = target as Record<string, unknown>;
    if (t.kind !== "new" && t.kind !== "chapter" && t.kind !== "replace") {
      return apiError(400, "bad_target", 'target.kind must be "new", "chapter" or "replace"');
    }
    // The hash list of a replace: one per step, checked before anything is looked up.
    let hashes: string[] | null = null;
    if (Object.hasOwn(b, "sha256")) {
      if (t.kind !== "replace") return apiError(400, "bad_request", 'sha256 is only allowed with target.kind "replace"');
      hashes = parseHashes(b.sha256, parsed.manifest.steps.length);
      if (hashes === null) return apiError(400, "bad_request", "sha256 must be a list of one lowercase hex SHA-256 (64 characters) per step");
    }
    // The logo's size, when the client says it: then exactly that much room is held for the
    // logo, not the most a logo may weigh, and the logo sent must have that length.
    let logoBytes: number | null = null;
    if (Object.hasOwn(b, "logo_bytes")) {
      const v = b.logo_bytes;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > LOGO_RULE.maxBytes) {
        return apiError(400, "bad_request", `logo_bytes must be a whole number of bytes from 1 to ${LOGO_RULE.maxBytes}`);
      }
      logoBytes = v;
    }
    let tourId: string | null = null;
    let replaces: { chapterId: string; revision: string | null; first: boolean } | null = null;
    if (t.kind === "chapter") {
      const id = t.tour_id;
      if (typeof id !== "string" || !TOUR_ID.test(id)) return notFound("tour");
      const tour = await deps.db.first<{ id: string; chapters: number }>(
        "SELECT t.id, (SELECT count(*) FROM chapter c WHERE c.tour_id = t.id) AS chapters FROM tour t WHERE t.id = ? AND t.workspace_id = ?",
        [id, auth.workspaceId],
      );
      if (tour === null) return notFound("tour");
      if (tour.chapters >= MAX_CHAPTERS) return tourFull();
      tourId = tour.id;
    } else if (t.kind === "replace") {
      const id = t.tour_id;
      if (typeof id !== "string" || !TOUR_ID.test(id)) return notFound("tour");
      // A malformed chapter id is looked up as no chapter, so an unknown tour still answers as one.
      const chapterId = typeof t.chapter_id === "string" && CHAPTER_ID.test(t.chapter_id) ? t.chapter_id : "";
      const found = await findChapter(deps, auth, id, chapterId);
      if (!found.tour) return notFound("tour");
      if (!found.chapter) return notFound("chapter");
      tourId = id;
      replaces = { chapterId, revision: found.revision, first: found.first };
    }

    // Housekeeping only: whatever goes wrong in it, this request carries on.
    try {
      await sweep(deps, auth.workspaceId);
    } catch {
      console.error("sweep: could not look for abandoned uploads; will retry later");
    }
    // And the publish housekeeping of the workspace (at most 4 calls; it never throws).
    await housekeeping(deps, auth.workspaceId, null, 1);

    // A replace with hashes: which of the new steps the chapter already has a picture for.
    // The chapter's revision was read before its pictures, so if another replace lands in
    // between, this upload is created against the older revision and its commit is refused.
    let reused: Reused[] = [];
    if (replaces !== null && hashes !== null && tourId !== null) {
      reused = reusedSteps(parsed.manifest, hashes, await chapterPictures(deps, auth, tourId, replaces.chapterId));
    }

    // One statement, so creates at the same moment can never pass the cap together, nor
    // the storage allowance. It works out what the upload reserves (`r.reserved`): all of
    // its declared bytes and the room for a logo it takes; for a replace, only what that
    // comes to above what the chapter holds now (and the logo it replaces), never below 0.
    // The row is written only when the open-upload cap allows it and the reservation is 0,
    // or the workspace has no limit, or what it uses plus the reservation is within its
    // allowance. Parameters, in the order they stand in the text: the row's eight values;
    // what the upload needs; the replaced chapter's (none for another target); the
    // workspace id of USED_SQL; ALLOWANCE_OF_SQL's three; the cap's three.
    const id = newId("up");
    const now = deps.now();
    const floor = now - UPLOAD_MAX_AGE_MS;
    const cap = deps.config.maxOpenUploads ?? DEFAULT_MAX_OPEN_UPLOADS;
    // A new tour takes a logo, and so does a replace of a tour's first chapter. A declared
    // logo size counts only for an upload that takes a logo and whose manifest names one;
    // then the room held for the logo is that size, else the most a logo may weigh.
    const takes = tourId === null || replaces?.first === true;
    const declared = takes && parsed.manifest.cover?.logo ? logoBytes : null;
    const wanted = reservedFor(parsed.manifest, takes, declared);
    const current = replaces === null || tourId === null ? null : replacedBytes(auth.workspaceId, tourId, replaces.chapterId, replaces.first);
    // A replace is written only while its chapter is still the tour's and still is, or is not,
    // the tour's first, as it was read above: a change of the tour's chapters (src/chapters.ts)
    // that lands in between, which closes the open replaces it affects, cannot miss this one.
    const stillAsRead =
      replaces === null || tourId === null
        ? null
        : {
            sql: `EXISTS (SELECT 1 FROM chapter sc WHERE sc.id = ? AND sc.tour_id = ?) AND (${firstChapterSql("?", "?")}) = ?`,
            params: [replaces.chapterId, tourId, replaces.chapterId, tourId, replaces.first ? 1 : 0],
          };
    const insert: Stmt = {
      sql: `INSERT INTO upload (id, workspace_id, tour_id, manifest, created_at, replaces_chapter_id, base_revision, logo_declared_bytes, reserved_bytes)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, r.reserved
              FROM (SELECT CAST(max(0, ? - ${current === null ? "0" : current.sql}) AS INTEGER) AS reserved, ${USED_SQL} AS used, ${ALLOWANCE_OF_SQL} AS allowance) r
             WHERE (SELECT count(*) FROM upload WHERE workspace_id = ? AND closing_at IS NULL AND created_at >= ?) < ?
               AND (r.reserved = 0 OR r.allowance IS NULL OR r.used + r.reserved <= r.allowance)${stillAsRead === null ? "" : ` AND ${stillAsRead.sql}`}`,
      params: [
        id, auth.workspaceId, tourId, JSON.stringify(parsed.manifest), now, replaces?.chapterId ?? null, replaces?.revision ?? null, declared,
        wanted, ...(current?.params ?? []), auth.workspaceId, ...allowanceParams(deps, auth.workspaceId),
        auth.workspaceId, floor, cap, ...(stillAsRead?.params ?? []),
      ],
    };
    const attempt = async (): Promise<boolean> => {
      if (reused.length === 0) return (await deps.db.run(insert.sql, insert.params)).changes === 1;
      // The upload and its reused steps in one batch, so an upload never exists without
      // them; the batch tells no row count, so one look says whether it was let in.
      await deps.db.batch([insert, reusedStatement(auth.workspaceId, id, reused, now)]);
      return (await deps.db.first("SELECT 1 AS x FROM upload WHERE id = ? AND workspace_id = ?", [id, auth.workspaceId])) !== null;
    };
    // A refused statement does not say why, so the reason is read afterwards: the open
    // uploads and, for a replace, what the chapter holds now, then usage. When the upload
    // does not fit the allowance the answer is the storage one, also when the cap is full
    // as well, since waiting does not make room. When the cap is reached it is the cap's.
    // When neither is so, room appeared between the statement and the look (an upload was
    // finished or aborted at that moment): the statement is tried once more, and its own
    // refusal is read again. The storage answer is only ever given when the upload does not
    // fit at the moment of the look. The cap's answer is given when the cap is reached, and
    // in one more case: the second statement was refused too and the second look found
    // room again, so uploads of this workspace are being opened and closed around this
    // request. No answer says that exactly; the cap's 429 with its `retry-after` is what
    // such a create was answered before the allowance existed, and "send it again in a
    // minute" is the right thing to do. It is an answer, never an error.
    const capReached = (): Response => {
      const res = apiError(429, "too_many_uploads", `this workspace already has ${cap} open uploads; finish or cancel one first`);
      res.headers.set("retry-after", String(CAP_RETRY_AFTER_S));
      return res;
    };
    let made = await attempt();
    for (let tries = 1; !made; tries++) {
      const state = await deps.db.first<{ open: number; held: number; as_read: number }>(
        `SELECT (SELECT count(*) FROM upload WHERE workspace_id = ? AND closing_at IS NULL AND created_at >= ?) AS open, ${current === null ? "0" : current.sql} AS held,
                ${stillAsRead === null ? "1" : `(${stillAsRead.sql})`} AS as_read`,
        [auth.workspaceId, floor, ...(current?.params ?? []), ...(stillAsRead?.params ?? [])],
      );
      // The tour's chapters were reordered or removed since the chapter was read: its own
      // answer, before the room and the cap are looked at. Nothing was written.
      if (state !== null && state.as_read !== 1) return apiError(409, "chapter_changed", "the tour's chapters were reordered or removed while this upload was being created; start again");
      const needed = Math.max(0, wanted - (state?.held ?? 0));
      const usage = await usageOf(deps, auth.workspaceId);
      if (needed > 0 && usage.allowance !== null && usage.used + needed > usage.allowance) return storageFull(usage, needed);
      if ((state?.open ?? 0) >= cap) return capReached();
      // Refused twice with room both times it was looked for: the client is told to come back.
      if (tries >= 2) return capReached();
      made = await attempt();
    }
    if (replaces === null) return json(201, { upload_id: id, steps: parsed.manifest.steps.length });
    // `have`: the step numbers not to send. `settings`: whether this replace also carries
    // the tour's settings and logo, which it does when the chapter is the tour's first.
    return json(201, { upload_id: id, steps: parsed.manifest.steps.length, have: reused.map((r) => r.n), settings: replaces.first });
  });

  app.put("/api/v1/uploads/:id/steps/:n", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const up = await loadUpload(deps, auth, c.req.param("id"));
    if (up === null || up.closing_at !== null) return notFound("upload");
    const m = JSON.parse(up.manifest) as Manifest;
    const nText = c.req.param("n");
    const n = STEP_NUMBER.test(nText) ? Number(nText) : 0;
    if (n < 1 || n > m.steps.length) return notFound("step");
    const declared = m.steps[n - 1];
    const type = extOf(declared.image);

    const alreadySent = () => apiError(409, "already_sent", `step ${n} was already sent`);
    const isStale = (row: { stored_at: number | null; claimed_at: number | null }) =>
      row.stored_at === null && (row.claimed_at === null || deps.now() - row.claimed_at >= STALE_CLAIM_MS);
    const sent = await deps.db.first<{ stored_at: number | null; claimed_at: number | null }>(
      "SELECT stored_at, claimed_at FROM upload_step WHERE upload_id = ? AND n = ?",
      [up.id, n],
    );
    if (sent !== null && !isStale(sent)) return alreadySent();

    const length = c.req.header("content-length");
    if (length !== undefined && Number(length) <= STEP_IMAGE_RULE.maxBytes && Number(length) !== declared.bytes) {
      await c.req.raw.body?.cancel().catch(() => {});
      return apiError(400, "bad_image", `step ${n}: image length differs from the manifest's bytes`);
    }
    const data = await readImage(c.req.raw, STEP_IMAGE_RULE.maxBytes);
    if (data instanceof Response) return data;
    const checked = checkImage(data, { ...STEP_IMAGE_RULE, type, width: declared.width, height: declared.height, bytes: declared.bytes });
    if (!checked.ok) return apiError(400, "bad_image", `step ${n}: ${checked.error}`);

    const key = stepKey(up.id, n, type);
    const hash = await sha256Hex(data);
    const token = claimToken();
    const claimedAt = deps.now();
    const openUpload = "SELECT id FROM upload WHERE id = ? AND workspace_id = ? AND closing_at IS NULL";
    if (sent === null) {
      try {
        const claim = await deps.db.run(
          `INSERT INTO upload_step (upload_id, n, image_key, bytes, claim, claimed_at) SELECT id, ?, ?, ?, ?, ? FROM upload WHERE id = ? AND workspace_id = ? AND closing_at IS NULL`,
          [n, key, data.byteLength, token, claimedAt, up.id, auth.workspaceId],
        );
        if (claim.changes === 0) return notFound("upload");
      } catch (err) {
        if (isUniqueViolation(err)) return alreadySent();
        throw err;
      }
    } else {
      // Take over a claim whose request died: only while it is still unfinished and stale,
      // in one statement, so of two resends at most one wins.
      const takeover = await deps.db.run(
        `UPDATE upload_step SET claim = ?, claimed_at = ?, image_key = ?, bytes = ?, sha256 = NULL
          WHERE upload_id = ? AND n = ? AND stored_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?) AND upload_id IN (${openUpload})`,
        [token, claimedAt, key, data.byteLength, up.id, n, claimedAt - STALE_CLAIM_MS, up.id, auth.workspaceId],
      );
      if (takeover.changes === 0) return alreadySent();
    }
    try {
      await deps.drafts.put(key, data, DRAFT_META(type));
    } catch (err) {
      // Release the claim so the step can be sent again. The object is removed only if the
      // claim was still this request's: after a takeover the key belongs to the new holder.
      const released = await deps.db.run("DELETE FROM upload_step WHERE upload_id = ? AND n = ? AND claim = ? AND stored_at IS NULL", [up.id, n, token]);
      if (released.changes === 1) await deps.drafts.delete([key]).catch(() => {});
      throw err;
    }
    // The hash goes in with stored_at, in one statement. A hash already there is the mark
    // of a writer that lost this claim and wrote the key anyway (see below): then which
    // bytes the store kept is not known, and the hash stays unknown.
    const done = await deps.db.run(
      `UPDATE upload_step SET stored_at = ?, sha256 = CASE WHEN sha256 IS NULL THEN ? ELSE NULL END
        WHERE upload_id = ? AND n = ? AND claim = ? AND upload_id IN (${openUpload})`,
      [deps.now(), hash, up.id, n, token, up.id, auth.workspaceId],
    );
    if (done.changes === 0) {
      // Either a resend took the claim over (the key is now its holder's), or the upload
      // was committed after that holder finished, or it was aborted. Only in the last case
      // is the object nobody's, and only then is it removed. In the other two this request
      // wrote the key after losing it and may have replaced the holder's bytes, so the
      // hash recorded for the key is made unknown: '' until the holder marks the step
      // stored (which turns it into null), null once it has.
      const taken = () => apiError(409, "already_sent", `step ${n} was taken over by a later send`);
      const holder = await deps.db.first("SELECT 1 AS x FROM upload_step WHERE upload_id = ? AND n = ?", [up.id, n]);
      if (holder !== null) {
        await deps.db.run("UPDATE upload_step SET sha256 = CASE WHEN stored_at IS NULL THEN '' ELSE NULL END WHERE upload_id = ? AND n = ?", [up.id, n]);
        return taken();
      }
      if (up.replaces_chapter_id !== null && up.tour_id !== null) {
        // A committed replace is not found by a chapter named after it. The key is spoken
        // for while a step of the tour uses it, or while it waits in replaced_object (a
        // later replace took it out; a publish in progress may still copy from it).
        const used = await deps.db.first<{ step: number | null; replaced: number | null }>(
          `SELECT (SELECT 1 FROM step WHERE tour_id = ? AND image_key = ? LIMIT 1) AS step,
                  (SELECT 1 FROM replaced_object WHERE tour_id = ? AND image_key = ?) AS replaced`,
          [up.tour_id, key, up.tour_id, key],
        );
        if (used?.step === 1) await deps.db.run("UPDATE step SET sha256 = NULL WHERE tour_id = ? AND image_key = ?", [up.tour_id, key]);
        if (used?.step === 1 || used?.replaced === 1) return taken();
      } else {
        const prior = await committed(deps, auth, up.id);
        if (prior !== null) {
          await deps.db.run("UPDATE step SET sha256 = NULL WHERE tour_id = ? AND image_key = ?", [prior.tour_id, key]);
          return taken();
        }
      }
      await deps.drafts.delete([key]);
      return notFound("upload");
    }
    return noContent();
  });

  app.put("/api/v1/uploads/:id/logo", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const up = await loadUpload(deps, auth, c.req.param("id"));
    if (up === null || up.closing_at !== null) return notFound("upload");
    const m = JSON.parse(up.manifest) as Manifest;
    if (!m.cover?.logo) return apiError(404, "not_found", "this upload's manifest names no logo");
    if (!takesLogo(up)) {
      await c.req.raw.body?.cancel().catch(() => {});
      return apiError(409, "logo_not_used", "an upload into an existing tour keeps that tour's logo; do not send one");
    }
    if (up.logo_key !== null) return apiError(409, "already_sent", "the logo was already sent");
    const type = extOf(m.cover.logo);

    // A size the create declared is the size the room was held for: any other is refused,
    // as a step whose length differs from its manifest's is, before anything is stored.
    const wrongLength = () => apiError(400, "bad_image", "logo: image length differs from the declared logo_bytes");
    const declared = up.logo_declared_bytes;
    const length = c.req.header("content-length");
    if (declared !== null && length !== undefined && Number(length) <= LOGO_RULE.maxBytes && Number(length) !== declared) {
      await c.req.raw.body?.cancel().catch(() => {});
      return wrongLength();
    }
    const data = await readImage(c.req.raw, LOGO_RULE.maxBytes);
    if (data instanceof Response) return data;
    const checked = checkImage(data, { ...LOGO_RULE, type });
    if (!checked.ok) return apiError(400, "bad_image", `logo: ${checked.error}`);
    if (declared !== null && data.byteLength !== declared) return wrongLength();

    const key = logoKey(up.id, type);
    const claim = await deps.db.run(
      "UPDATE upload SET logo_key = ? WHERE id = ? AND workspace_id = ? AND closing_at IS NULL AND logo_key IS NULL",
      [key, up.id, auth.workspaceId],
    );
    if (claim.changes === 0) {
      const now = await loadUpload(deps, auth, up.id);
      return now === null || now.closing_at !== null ? notFound("upload") : apiError(409, "already_sent", "the logo was already sent");
    }
    try {
      await deps.drafts.put(key, data, DRAFT_META(type));
    } catch (err) {
      await deps.db.run("UPDATE upload SET logo_key = NULL WHERE id = ? AND workspace_id = ? AND logo_bytes IS NULL", [up.id, auth.workspaceId]);
      await deps.drafts.delete([key]).catch(() => {});
      throw err;
    }
    const done = await deps.db.run("UPDATE upload SET logo_bytes = ? WHERE id = ? AND workspace_id = ? AND closing_at IS NULL", [
      data.byteLength, up.id, auth.workspaceId,
    ]);
    if (done.changes === 0) {
      await deps.drafts.delete([key]);
      return notFound("upload");
    }
    return noContent();
  });

  app.post("/api/v1/uploads/:id/commit", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    const up = await loadUpload(deps, auth, id);
    if (up === null || up.closing_at !== null) {
      // A commit that already happened answers the same again: a new tour or chapter is
      // found by the chapter named after the upload, a replace by the chapter's revision.
      const prior = up === null ? ((await committed(deps, auth, id)) ?? (await replaceAnswer(deps, auth, id))) : null;
      return prior !== null ? json(201, prior) : notFound("upload");
    }
    const m = JSON.parse(up.manifest) as Manifest;
    const stored = await deps.db.all<{ n: number }>(
      "SELECT s.n FROM upload_step s JOIN upload u ON u.id = s.upload_id WHERE s.upload_id = ? AND u.workspace_id = ? AND s.stored_at IS NOT NULL",
      [up.id, auth.workspaceId],
    );
    const have = new Set(stored.map((r) => r.n));
    for (let n = 1; n <= m.steps.length; n++) {
      if (!have.has(n)) return apiError(409, "incomplete", `step ${n} has not been sent`);
    }
    // A new tour and a replace of a tour's first chapter take the logo; any other upload
    // into an existing tour keeps that tour's.
    if (takesLogo(up) && m.cover?.logo && (up.logo_key === null || up.logo_bytes === null)) {
      return apiError(409, "incomplete", "the logo has not been sent");
    }

    if (up.replaces_chapter_id !== null) {
      try {
        await stampedBatch(deps, (stamped) => replaceStatements(deps, auth, up, m, stamped));
      } catch (err) {
        if (!isUniqueViolation(err) && !isNotNullViolation(err)) throw err;
        // Another commit of this upload may have won; then this one answers the same.
        const prior = await replaceAnswer(deps, auth, up.id);
        if (prior !== null) return json(201, prior);
        const still = await loadUpload(deps, auth, up.id);
        if (still === null || still.closing_at !== null) return notFound("upload"); // aborted meanwhile
        return apiError(409, "chapter_changed", "the chapter was changed by another upload since this one started; start again");
      }
      const answer = await replaceAnswer(deps, auth, up.id);
      // The pictures this replace took out of the chapter go now (3 calls at most; it never
      // throws), unless a publish of the older draft is still copying from them.
      await clearReplaced(deps, auth.workspaceId, up.tour_id);
      // Not found only if yet another replace of the chapter landed since the batch: then
      // the draft holds more than this replace, and publishing is not this client's call.
      return json(201, answer ?? { tour_id: up.tour_id ?? "", chapter_id: up.replaces_chapter_id, steps: m.steps.length, publish: "other_changes" });
    }

    const result = { tour_id: up.tour_id ?? "", chapter_id: chapterIdFor(up.id), steps: m.steps.length };
    for (let attempt = 1; ; attempt++) {
      const tourId = up.tour_id ?? newId("tour");
      try {
        const slug = newSlug();
        await stampedBatch(deps, (stamped) => commitStatements(deps, auth, up, m, tourId, slug, stamped));
        result.tour_id = tourId;
        break;
      } catch (err) {
        const unique = isUniqueViolation(err);
        if (!unique && !isNotNullViolation(err)) throw err;
        // Another commit of this upload may have won; then this one answers the same.
        const prior = await committed(deps, auth, up.id);
        if (prior !== null) return json(201, prior);
        if (!unique) {
          // Aborted meanwhile, or (a new chapter) its tour reached MAX_CHAPTERS since the
          // create, by another upload started beside this one: then the upload stays open,
          // to be cancelled, and nothing of it was written.
          if (up.tour_id !== null && (await tourIsFull(deps, auth, up.id))) return tourFull();
          return notFound("upload");
        }
        if (up.tour_id !== null || attempt >= SLUG_ATTEMPTS) throw err;
        // A new tour's slug or id collided: try again with fresh ones.
      }
    }

    return json(201, result);
  });

  app.delete("/api/v1/uploads/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    if (UPLOAD_ID.test(id)) await abortUpload(deps, auth.workspaceId, id);
    return noContent();
  });
}
