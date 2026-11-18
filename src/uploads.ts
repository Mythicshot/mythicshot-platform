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
// - Only an upload that makes a new tour takes a logo; an upload into an existing tour
//   keeps that tour's logo and refuses one, so no logo object is ever left unrecorded.
// - Every stored step records the SHA-256 of the bytes the server accepted, in the same
//   statement that marks it stored, and commit copies it to the step. A hash is either
//   that of the bytes in the store or null (unknown): a writer that lost its claim after
//   writing its object clears it, since which bytes the store kept cannot be told.
import type { Hono } from "hono";
import { newId, newSlug, requireAuth, type Auth } from "./auth.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { LIMITS, parseManifest, type Manifest } from "./manifest.ts";
import { isNotNullViolation, isUniqueViolation, type Deps, type Stmt } from "./ports.ts";
import { housekeeping } from "./publish.ts";
import { LOGO_RULE, STEP_IMAGE_RULE, checkImage, type ImageType } from "./sniff.ts";

/** An upload older than this is swept by the workspace's next create. */
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** At most this many stale uploads are swept per create, to bound the work of one request. */
const SWEEP_LIMIT = 5;
/** The create body: the manifest's cap plus room for the envelope around it. */
const CREATE_BODY_BYTES = LIMITS.manifestBytes + 4096;
/** Attempts at a fresh slug when a new tour's slug collides. */
const SLUG_ATTEMPTS = 5;
/** Open uploads per workspace when the config sets no other number. */
export const DEFAULT_MAX_OPEN_UPLOADS = 5;
/** Seconds a client refused by the open-upload cap is told to wait. */
const CAP_RETRY_AFTER_S = 60;
/** An unfinished step claim older than this may be taken over by a resend. */
export const STALE_CLAIM_MS = 60_000;

const UPLOAD_ID = /^up_[0-9a-f]{24}$/;
const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const STEP_NUMBER = /^[1-9][0-9]{0,2}$/;

const DRAFT_META = (type: ImageType) => ({ contentType: type === "png" ? "image/png" : "image/jpeg", cacheControl: "private, no-store" });

type UploadRow = { id: string; tour_id: string | null; manifest: string; logo_key: string | null; logo_bytes: number | null; closing_at: number | null };

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
  return deps.db.first<UploadRow>(
    "SELECT id, tour_id, manifest, logo_key, logo_bytes, closing_at FROM upload WHERE id = ? AND workspace_id = ?",
    [id, auth.workspaceId],
  );
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
 * or was committed meanwhile, is left alone.
 */
export async function abortUpload(deps: Deps, workspaceId: string, id: string): Promise<void> {
  const row = await deps.db.first<UploadRow>("SELECT id, manifest, logo_key FROM upload WHERE id = ? AND workspace_id = ?", [id, workspaceId]);
  if (row === null) return;
  const marked = await deps.db.run("UPDATE upload SET closing_at = coalesce(closing_at, ?) WHERE id = ? AND workspace_id = ?", [deps.now(), id, workspaceId]);
  if (marked.changes === 0) return; // committed (or aborted) since the read: nothing of it is ours to delete
  const recorded = await deps.db.all<{ image_key: string }>(
    "SELECT s.image_key FROM upload_step s JOIN upload u ON u.id = s.upload_id WHERE s.upload_id = ? AND u.workspace_id = ?",
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

/** Aborts up to SWEEP_LIMIT of the workspace's uploads older than UPLOAD_MAX_AGE_MS. */
async function sweep(deps: Deps, workspaceId: string): Promise<void> {
  const stale = await deps.db.all<{ id: string }>(
    "SELECT id FROM upload WHERE workspace_id = ? AND created_at < ? ORDER BY created_at LIMIT ?",
    [workspaceId, deps.now() - UPLOAD_MAX_AGE_MS, SWEEP_LIMIT],
  );
  for (const { id } of stale) {
    try {
      await abortUpload(deps, workspaceId, id);
    } catch {
      // The upload stays closed to commits and is tried again by a later sweep. The error
      // itself is not logged: it could carry anything a back end put in its message.
      console.error(`sweep: could not remove abandoned upload ${id}; will retry later`);
    }
  }
}

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

/** The lowercase hex SHA-256 of `bytes`. Web Crypto, so not a storage or database call. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

const json01 = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

/** The commit's statements. Each insert of a tour or chapter takes a value only an open upload of this workspace supplies, so it fails (NOT NULL) once the upload is closing or gone. */
function commitStatements(deps: Deps, auth: Auth, up: UploadRow, m: Manifest, tourId: string, slug: string): Stmt[] {
  const now = deps.now();
  const chapterId = chapterIdFor(up.id);
  const openUpload = "FROM upload WHERE id = ? AND workspace_id = ? AND closing_at IS NULL";
  const stmts: Stmt[] = [];
  if (up.tour_id === null) {
    const logoType = m.cover?.logo ? extOf(m.cover.logo) : null;
    stmts.push({
      sql: `INSERT INTO tour (id, workspace_id, title, slug, status, spotlight_dim, theme, zoom, cover, cta, end_card, autoplay, logo_key, logo_type, created_at, updated_at, draft_version)
            VALUES (?, (SELECT workspace_id ${openUpload}), ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      params: [
        tourId, up.id, auth.workspaceId, m.title, slug, m.spotlight_dim,
        JSON.stringify(m.theme), JSON.stringify(m.zoom), json01(m.cover), json01(m.cta), json01(m.end), JSON.stringify(m.autoplay),
        logoType === null ? null : up.logo_key, logoType, now, now,
      ],
    });
    stmts.push({
      sql: `INSERT INTO chapter (id, tour_id, title, description, position) VALUES (?, (SELECT ? ${openUpload}), ?, NULL, 0)`,
      params: [chapterId, tourId, up.id, auth.workspaceId, m.title],
    });
  } else {
    stmts.push({
      sql: `INSERT INTO chapter (id, tour_id, title, description, position)
            VALUES (?, (SELECT t.id FROM upload u JOIN tour t ON t.id = u.tour_id WHERE u.id = ? AND u.workspace_id = ? AND u.closing_at IS NULL AND t.workspace_id = ?), ?, NULL,
                    (SELECT coalesce(max(position) + 1, 0) FROM chapter WHERE tour_id = ?))`,
      params: [chapterId, up.id, auth.workspaceId, auth.workspaceId, m.title, tourId],
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
    const raw = await readCapped(c.req.raw, CREATE_BODY_BYTES);
    if (raw === "too_large") return apiError(413, "too_large", `the request is over ${CREATE_BODY_BYTES} bytes`);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    } catch {
      return apiError(400, "bad_request", "the body is not JSON");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return apiError(400, "bad_request", "the body must be an object");
    const b = body as Record<string, unknown>;
    if (!Object.hasOwn(b, "manifest")) return apiError(400, "bad_manifest", "manifest is required");
    const parsed = parseManifest(b.manifest);
    if (!parsed.ok) return apiError(400, "bad_manifest", parsed.error);
    const target = Object.hasOwn(b, "target") ? b.target : undefined;
    if (target === null || typeof target !== "object" || Array.isArray(target)) return apiError(400, "bad_target", "target must be an object");
    const t = target as Record<string, unknown>;
    let tourId: string | null = null;
    if (t.kind === "chapter") {
      const id = t.tour_id;
      if (typeof id !== "string" || !TOUR_ID.test(id)) return notFound("tour");
      const tour = await deps.db.first<{ id: string }>("SELECT id FROM tour WHERE id = ? AND workspace_id = ?", [id, auth.workspaceId]);
      if (tour === null) return notFound("tour");
      tourId = tour.id;
    } else if (t.kind !== "new") {
      return apiError(400, "bad_target", 'target.kind must be "new" or "chapter"');
    }

    // Housekeeping only: whatever goes wrong in it, this request carries on.
    try {
      await sweep(deps, auth.workspaceId);
    } catch {
      console.error("sweep: could not look for abandoned uploads; will retry later");
    }
    // And the publish housekeeping of the workspace (at most 4 calls; it never throws).
    await housekeeping(deps, auth.workspaceId, null, 1);

    // One statement, so creates at the same moment can never pass the cap together.
    const id = newId("up");
    const now = deps.now();
    const cap = deps.config.maxOpenUploads ?? DEFAULT_MAX_OPEN_UPLOADS;
    const inserted = await deps.db.run(
      `INSERT INTO upload (id, workspace_id, tour_id, manifest, created_at) SELECT ?, ?, ?, ?, ?
        WHERE (SELECT count(*) FROM upload WHERE workspace_id = ? AND closing_at IS NULL AND created_at >= ?) < ?`,
      [id, auth.workspaceId, tourId, JSON.stringify(parsed.manifest), now, auth.workspaceId, now - UPLOAD_MAX_AGE_MS, cap],
    );
    if (inserted.changes === 0) {
      const res = apiError(429, "too_many_uploads", `this workspace already has ${cap} open uploads; finish or cancel one first`);
      res.headers.set("retry-after", String(CAP_RETRY_AFTER_S));
      return res;
    }
    return json(201, { upload_id: id, steps: parsed.manifest.steps.length });
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
      const prior = await committed(deps, auth, up.id);
      if (prior !== null) {
        await deps.db.run("UPDATE step SET sha256 = NULL WHERE tour_id = ? AND image_key = ?", [prior.tour_id, key]);
        return taken();
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
    if (up.tour_id !== null) {
      await c.req.raw.body?.cancel().catch(() => {});
      return apiError(409, "logo_not_used", "an upload into an existing tour keeps that tour's logo; do not send one");
    }
    if (up.logo_key !== null) return apiError(409, "already_sent", "the logo was already sent");
    const type = extOf(m.cover.logo);

    const data = await readImage(c.req.raw, LOGO_RULE.maxBytes);
    if (data instanceof Response) return data;
    const checked = checkImage(data, { ...LOGO_RULE, type });
    if (!checked.ok) return apiError(400, "bad_image", `logo: ${checked.error}`);

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
      const prior = up === null ? await committed(deps, auth, id) : null;
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
    // Only a new tour takes the logo; an upload into an existing tour keeps that tour's.
    if (up.tour_id === null && m.cover?.logo && (up.logo_key === null || up.logo_bytes === null)) {
      return apiError(409, "incomplete", "the logo has not been sent");
    }

    const result = { tour_id: up.tour_id ?? "", chapter_id: chapterIdFor(up.id), steps: m.steps.length };
    for (let attempt = 1; ; attempt++) {
      const tourId = up.tour_id ?? newId("tour");
      try {
        await deps.db.batch(commitStatements(deps, auth, up, m, tourId, newSlug()));
        result.tour_id = tourId;
        break;
      } catch (err) {
        const unique = isUniqueViolation(err);
        if (!unique && !isNotNullViolation(err)) throw err;
        // Another commit of this upload may have won; then this one answers the same.
        const prior = await committed(deps, auth, up.id);
        if (prior !== null) return json(201, prior);
        if (!unique) return notFound("upload"); // aborted meanwhile
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
