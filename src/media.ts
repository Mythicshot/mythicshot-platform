// Shared items: a workspace shares a single image (a PNG or a JPEG) or a short clip (a GIF
// or an MP4). This file is the authenticated API only: start an item, send its parts and
// an optional preview picture, commit it, read it, list a workspace's items and delete
// one. Every query is scoped by the workspace of the caller (a token or a session, through
// requireAuth exactly as the upload routes take it), and another workspace's item answers
// as one that never existed. A disabled account's workspace is refused by requireAuth
// itself, before any of this runs, as for the uploads.
//
// The protocol:
// - POST /api/v1/media declares the item. One statement checks the storage allowance and
//   writes the row, whose declared bytes from then on count as used (src/usage.ts), so two
//   creates at the same moment can never pass the allowance together. The answer says how
//   many parts to send and how long each is: PART_BYTES each, the last one the rest.
// - PUT .../parts/:n stores part n as its own object. Part 0 is checked against the
//   declared type (and, for a PNG, JPEG or GIF, the declared width and height) from its
//   own bytes. Sending a part again replaces it.
// - PUT .../preview stores the optional preview picture, checked like a logo.
// - POST .../commit checks that every part is stored and that they add up to the declared
//   bytes, and puts the item online. From then on nothing of it changes until it is deleted.
// - DELETE removes the item in any state, its rows and every object it could have written.
//
// Bookkeeping that keeps a delete exact and a commit all-or-nothing:
// - A part's row is written before its object, with a random claim token, and marked
//   stored (claim cleared) once the object is written, only by the request whose claim it
//   holds. A commit takes effect only while no part and no preview is claimed, so a part
//   still being written can never land in an item that is already online.
// - A delete (and the sweep) first sets the item `closing`. Every statement that writes
//   for an item takes effect only while it is `uploading`, so a request that finds the item
//   closing or gone after it wrote an object removes that object itself; anything left is
//   under a key the item's row names, which the delete or a later sweep removes.
// - Keys are `m/<item id>/part-NNN` (n from 000) and `m/<item id>/preview.png` or `.jpg`,
//   named from the row alone, so a delete names every key the item could have written,
//   even one whose request was cut off before its row was finished, and never another's.
//
// Where the objects live: the private store (`deps.drafts`), never the public one. The
// public store can be a bucket with a public domain of its own (PUBLIC_IMAGE_BASE), where
// an object is reachable without the app: an unfinished item, one being deleted, one of a
// disabled account, and every online item would then be served past the checks the
// serving route makes. Items are always served through the app (a later task reads the
// parts and sets its own fixed headers), so nothing needs them in the public store, and
// nothing is copied at commit. Their keys are under `m/`; everything else in the private
// store is under `u/` (src/uploads.ts writes every draft key there, and the upload abort
// and sweep, the tour delete and the replaced-picture clean-up delete only keys taken from
// step, upload and replaced rows, which are those `u/` keys), so no other clean-up can
// reach an item's object, and an item's delete names only its own `m/<id>/` keys.
import type { Hono } from "hono";
import { newId, newLinkId, requireAuth, type Auth } from "./auth.ts";
import { mediaOrigin } from "./hosts.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { isUniqueViolation, type Config, type Deps } from "./ports.ts";
import { LIMITS_MEDIA, hitLimit, workspaceKey } from "./rate.ts";
import { checkImage, mediaInfo, type ImageType, type MediaType } from "./sniff.ts";
import { ALLOWANCE_OF_SQL, USED_SQL, allowanceParams, storageFull, usageOf } from "./usage.ts";

/** The longest request body: a part. Every part but the last is exactly this long. */
export const PART_BYTES = 2_000_000;
/** The limits a deployment may change in its config (see Config in src/ports.ts), with their defaults. */
export const DEFAULT_MEDIA_LIMITS = { imageMaxBytes: 10 * 1024 * 1024, imageMaxSide: 8192, clipMaxBytes: 50 * 1024 * 1024 } as const;
/** The most pixels a clip may declare on a side. A ceiling against nonsense, not a setting. */
export const CLIP_MAX_SIDE = 8192;
/** The longest duration a clip may declare: 10 minutes. A ceiling against nonsense, not a setting. */
export const CLIP_MAX_DURATION_MS = 600_000;
/** The preview picture: a PNG or a JPEG of at most 100,000 bytes and 512 pixels on a side. */
export const PREVIEW_RULE = { maxBytes: 100_000, maxSide: 512 } as const;
/** The longest title, in characters. */
export const TITLE_MAX = 120;
/** An item not committed within this long is swept by the workspace's next create. */
export const MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Items one list page holds. */
export const LIST_PAGE = 50;
/** Items one create removes at most while sweeping, to bound its work: two calls each. */
const SWEEP_LIMIT = 5;
/** The create's JSON body: a few short fields and a title. */
const CREATE_BODY_BYTES = 4096;
/** Attempts at a fresh link id when one collides with an existing item's. */
const LINK_ATTEMPTS = 5;

const ITEM_ID = /^med_[0-9a-f]{24}$/;
const PART_NUMBER = /^(0|[1-9][0-9]{0,2})$/;

export type MediaKind = "image" | "clip";
const CONTENT_TYPES: Record<MediaKind, readonly string[]> = { image: ["image/png", "image/jpeg"], clip: ["image/gif", "video/mp4"] };
const TYPE_OF: Record<string, MediaType> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "video/mp4": "mp4" };
const TYPE_NAME: Record<MediaType, string> = { png: "PNG", jpg: "JPEG", gif: "GIF", mp4: "MP4" };
const PREVIEW_TYPE: Record<ImageType, string> = { png: "image/png", jpg: "image/jpeg" };
/** A control, format or surrogate character, or a line or paragraph separator: none may be in a title. */
const FORBIDDEN_IN_TITLE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
/** Every object is written as not to be cached; whatever serves an item later sets its own headers. */
const NO_CACHE = "no-store";

/** The limits this deployment uses. */
export function mediaLimits(config: Config): { imageMaxBytes: number; imageMaxSide: number; clipMaxBytes: number } {
  return {
    imageMaxBytes: config.mediaImageMaxBytes ?? DEFAULT_MEDIA_LIMITS.imageMaxBytes,
    imageMaxSide: config.mediaImageMaxSide ?? DEFAULT_MEDIA_LIMITS.imageMaxSide,
    clipMaxBytes: config.mediaClipMaxBytes ?? DEFAULT_MEDIA_LIMITS.clipMaxBytes,
  };
}

/** How many parts an item of `bytes` is sent in. */
export function partsOf(bytes: number): number {
  return Math.ceil(bytes / PART_BYTES);
}

/** The length part `n` must have: PART_BYTES for every part but the last, the rest for the last. */
function partLength(bytes: number, parts: number, n: number): number {
  return n < parts - 1 ? PART_BYTES : bytes - PART_BYTES * (parts - 1);
}

function partKey(id: string, n: number): string {
  return `m/${id}/part-${String(n).padStart(3, "0")}`;
}

function previewKey(id: string, type: ImageType): string {
  return `m/${id}/preview.${type}`;
}

/** Every key an item could have written: one per part and a preview of either type. */
function possibleKeys(id: string, parts: number): string[] {
  const keys: string[] = [];
  for (let n = 0; n < parts; n++) keys.push(partKey(id, n));
  keys.push(previewKey(id, "png"), previewKey(id, "jpg"));
  return keys;
}

/** The path of an item's public page: /i/<link id> for an image, /r/<link id> for a clip. */
export function mediaPath(item: { kind: MediaKind; link_id: string }): string {
  return `${item.kind === "image" ? "/i/" : "/r/"}${item.link_id}`;
}

/**
 * The address of an item's public page: mediaOrigin (the img address when it is set, else
 * the tours address, else SITE_HOST, from the configuration alone) followed by mediaPath.
 * When the configuration names no address the origin is "" and the link is the path, as a
 * tour's link is, for the client to put after the address it was given. Nothing of the
 * request is read, so no Host header can put another site's name into a link. Every
 * answer that carries `link` gets it from this function.
 */
export function mediaLink(config: Config, item: { kind: MediaKind; link_id: string }): string {
  return mediaOrigin({ hosts: config.hosts ?? null, ...(typeof config.siteHost === "string" ? { siteHost: config.siteHost } : {}) }) + mediaPath(item);
}

/** A random token naming one request's claim on a part or a preview: 24 hex characters. */
function claimToken(): string {
  return newId("med").slice(4);
}

type ItemRow = {
  id: string;
  link_id: string;
  kind: MediaKind;
  content_type: string;
  bytes: number;
  parts: number;
  width: number;
  height: number;
  duration_ms: number | null;
  title: string | null;
  state: "uploading" | "online" | "closing";
  preview_type: ImageType | null;
  preview_bytes: number | null;
  preview_claim: string | null;
  preview_stored_at: number | null;
  created_at: number;
};

const ITEM_COLUMNS = "id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, preview_type, preview_bytes, preview_claim, preview_stored_at, created_at";

async function loadItem(deps: Deps, auth: Auth, id: string): Promise<ItemRow | null> {
  if (!ITEM_ID.test(id)) return null;
  return deps.db.first<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM media WHERE id = ? AND workspace_id = ?`, [id, auth.workspaceId]);
}

const noItem = () => apiError(404, "not_found", "no such item");
const alreadyOnline = () => apiError(409, "already_online", "the item is online and cannot change any more; delete it and start again to change it");

/** What every answer about one item says: the fields of the list, from its row. */
function itemOut(deps: Deps, row: ItemRow) {
  return {
    id: row.id,
    link_id: row.link_id,
    kind: row.kind,
    title: row.title,
    content_type: row.content_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    has_preview: row.preview_stored_at !== null,
    path: mediaPath(row),
    link: mediaLink(deps.config, row),
  };
}

/** The commit's answer, the same each time it is asked. */
function committedOut(deps: Deps, row: ItemRow) {
  return { id: row.id, link_id: row.link_id, kind: row.kind, path: mediaPath(row), link: mediaLink(deps.config, row) };
}

/**
 * Removes an item of this workspace that is already marked closing: every object it could
 * have written, then its rows. Two calls, whatever the number of parts: one store delete
 * takes up to 1,000 keys (src/budget.ts counts it as one call, R2 deletes them in one
 * operation, and the Node store deletes them one by one within that call) and an item has at most 999 parts and two possible previews. The rows go only
 * while the item is still closing, and only once its objects have.
 */
async function removeClosing(deps: Deps, workspaceId: string, item: { id: string; parts: number }): Promise<void> {
  await deps.drafts.delete(possibleKeys(item.id, item.parts));
  await deps.db.batch([
    { sql: "DELETE FROM media_part WHERE media_id IN (SELECT id FROM media WHERE id = ? AND workspace_id = ? AND state = 'closing')", params: [item.id, workspaceId] },
    { sql: "DELETE FROM media WHERE id = ? AND workspace_id = ? AND state = 'closing'", params: [item.id, workspaceId] },
  ]);
}

/**
 * Closes every item of the workspace still unfinished after MEDIA_MAX_AGE_MS, in one
 * statement, then removes up to SWEEP_LIMIT of its closing items (objects and rows), the
 * oldest first: those just closed, and any whose delete was cut off. Closing comes first
 * and covers all of them: from then on none can be committed and none counts against the
 * allowance. What could not be removed now is tried again by a later sweep.
 */
async function sweep(deps: Deps, workspaceId: string): Promise<void> {
  await deps.db.run("UPDATE media SET state = 'closing' WHERE workspace_id = ? AND state = 'uploading' AND created_at < ?", [workspaceId, deps.now() - MEDIA_MAX_AGE_MS]);
  const closing = await deps.db.all<{ id: string; parts: number }>(
    "SELECT id, parts FROM media WHERE workspace_id = ? AND state = 'closing' ORDER BY created_at, id LIMIT ?",
    [workspaceId, SWEEP_LIMIT],
  );
  for (const item of closing) {
    try {
      await removeClosing(deps, workspaceId, item);
    } catch {
      // Fixed text only: the error could carry anything a back end put in its message.
      console.error(`sweep: could not remove a closing item ${item.id}; will retry later`);
    }
  }
}

type Declared = { kind: MediaKind; contentType: string; bytes: number; width: number; height: number; durationMs: number | null; title: string | null };

const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** The create's body checked, or the answer that refuses it. Every detail is fixed text or a number of the site's own, never the request's content. */
function parseCreate(raw: unknown, config: Config): Declared | Response {
  const bad = (detail: string) => apiError(400, "bad_request", detail);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad("the body must be a JSON object");
  const b = raw as Record<string, unknown>;
  const kind = b.kind;
  if (kind !== "image" && kind !== "clip") return bad('kind must be "image" or "clip"');
  const contentType = b.content_type;
  const allowed = CONTENT_TYPES[kind];
  if (typeof contentType !== "string" || !allowed.includes(contentType)) return bad(`content_type must be ${allowed.map((t) => `"${t}"`).join(" or ")} for kind "${kind}"`);
  const limits = mediaLimits(config);
  const maxBytes = kind === "image" ? limits.imageMaxBytes : limits.clipMaxBytes;
  const maxSide = kind === "image" ? limits.imageMaxSide : CLIP_MAX_SIDE;
  const tooLarge = (what: string) => json(413, { error: "media_too_large", detail: `${what}: ${kind === "image" ? "an image" : "a clip"} may have at most ${maxBytes} bytes and ${maxSide} pixels on a side`, max_bytes: maxBytes, max_side: maxSide });
  if (!isWhole(b.bytes) || b.bytes < 1) return bad("bytes must be a whole number of bytes from 1");
  if (!isWhole(b.width) || b.width < 1 || !isWhole(b.height) || b.height < 1) return bad("width and height must be whole numbers of pixels from 1");
  if (b.bytes > maxBytes) return tooLarge("the file is too long");
  if (b.width > maxSide || b.height > maxSide) return tooLarge("the picture is too large");
  let durationMs: number | null = null;
  if (kind === "clip") {
    const d = b.duration_ms;
    if (!isWhole(d) || d < 1 || d > CLIP_MAX_DURATION_MS) return bad(`duration_ms must be a whole number of milliseconds from 1 to ${CLIP_MAX_DURATION_MS} for a clip`);
    durationMs = d;
  } else if (Object.hasOwn(b, "duration_ms")) {
    return bad("duration_ms is for a clip only; leave it out for an image");
  }
  let title: string | null = null;
  if (Object.hasOwn(b, "title") && b.title !== null) {
    if (typeof b.title !== "string") return bad("title must be text");
    const t = b.title.trim();
    if (FORBIDDEN_IN_TITLE.test(t)) return bad("title contains a control or format character");
    if ([...t].length > TITLE_MAX) return bad(`title must be at most ${TITLE_MAX} characters`);
    title = t === "" ? null : t;
  }
  return { kind, contentType, bytes: b.bytes, width: b.width, height: b.height, durationMs, title };
}

/** The headers a preview picture is answered with: its sniffed type and nothing a browser could run. */
function previewHeaders(type: ImageType, size: number): Record<string, string> {
  return {
    "content-type": PREVIEW_TYPE[type],
    "content-length": String(size),
    "content-disposition": `inline; filename="preview.${type}"`,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
  };
}

/** A list cursor: the last item's time and id, in base64url, opaque to the client. */
function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}.${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The time and id of a cursor encodeCursor made, or null for anything else. */
function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(cursor)) return null;
  let text: string;
  try {
    text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const m = /^(0|[1-9][0-9]{0,15})\.(med_[0-9a-f]{24})$/.exec(text);
  if (m === null || !Number.isSafeInteger(Number(m[1]))) return null;
  return { createdAt: Number(m[1]), id: m[2] };
}

export function mediaRoutes(app: Hono, deps: Deps): void {
  // Start an item. 201 {id, parts, part_bytes}.
  app.post("/api/v1/media", async (c) => {
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
    const d = parseCreate(body, deps.config);
    if (d instanceof Response) return d;

    const limit = await hitLimit(deps, LIMITS_MEDIA.create, await workspaceKey(auth.workspaceId));
    if (limit.over) {
      const res = apiError(429, "too_many_items", `this workspace started ${LIMITS_MEDIA.create.most} items in the last hour; try again later`);
      res.headers.set("retry-after", String(limit.retryAfterSeconds));
      return res;
    }

    // Housekeeping only: whatever goes wrong in it, this request carries on.
    try {
      await sweep(deps, auth.workspaceId);
    } catch {
      console.error("sweep: could not look for unfinished items; will retry later");
    }

    // One statement checks the allowance and writes the row, whose bytes are then counted
    // as used: a create at the same moment sees this one's, so two can never pass together.
    // The row is written only when the workspace has no limit, or what it uses plus this
    // item's bytes is within its allowance. Parameters, in the order they stand in the
    // text: the row's twelve values; the workspace id of USED_SQL; ALLOWANCE_OF_SQL's three;
    // the item's bytes once more.
    const parts = partsOf(d.bytes);
    const now = deps.now();
    for (let attempt = 1; ; attempt++) {
      const id = newId("med");
      let made: boolean;
      try {
        const r = await deps.db.run(
          `INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?
             FROM (SELECT ${USED_SQL} AS used, ${ALLOWANCE_OF_SQL} AS allowance) r
            WHERE r.allowance IS NULL OR r.used + ? <= r.allowance`,
          [
            id, auth.workspaceId, newLinkId(), d.kind, d.contentType, d.bytes, parts, d.width, d.height, d.durationMs, d.title, now,
            auth.workspaceId, ...allowanceParams(deps, auth.workspaceId), d.bytes,
          ],
        );
        made = r.changes === 1;
      } catch (err) {
        // A link id (or, far less likely, an id) another item has: try again with fresh ones.
        if (isUniqueViolation(err) && attempt < LINK_ATTEMPTS) continue;
        throw err;
      }
      if (made) return json(201, { id, parts, part_bytes: PART_BYTES });
      // A refused statement does not say why, so the usage is read. The storage answer is
      // given only when the item does not fit at the moment of the look; otherwise room
      // appeared in between (something was deleted at that moment) and the statement is
      // tried again. Three refusals with room every time is not a state the site can
      // reach; it is an error then, never a storage answer that would not be true.
      const usage = await usageOf(deps, auth.workspaceId);
      if (usage.allowance !== null && usage.used + d.bytes > usage.allowance) return storageFull(usage, d.bytes, d.kind);
      if (attempt >= 3) throw new Error("media create refused with room to spare");
    }
  });

  // Store part n. 204 once it is stored.
  app.put("/api/v1/media/:id/parts/:n", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null || item.state === "closing") return noItem();
    if (item.state === "online") return alreadyOnline();
    const nText = c.req.param("n");
    const n = PART_NUMBER.test(nText) ? Number(nText) : -1;
    if (n < 0 || n >= item.parts) return apiError(404, "not_found", "no such part");
    const length = partLength(item.bytes, item.parts, n);

    const wrongLength = () => apiError(400, "bad_part", `part ${n} must be exactly ${length} bytes`);
    const declared = c.req.header("content-length");
    if (declared !== undefined && Number(declared) <= PART_BYTES && Number(declared) !== length) {
      await c.req.raw.body?.cancel().catch(() => {});
      return wrongLength();
    }
    const data = await readCapped(c.req.raw, PART_BYTES);
    if (data === "too_large") return apiError(413, "too_large", `a part is at most ${PART_BYTES} bytes`);
    if (data.byteLength !== length) return wrongLength();
    if (n === 0) {
      // The file's own first bytes, never its name or a Content-Type, say what it is.
      const want = TYPE_OF[item.content_type];
      const info = mediaInfo(data);
      if (info === null) return apiError(400, "bad_media", "part 0 does not start like a PNG, JPEG, GIF or MP4 file");
      if (info.type !== want) return apiError(400, "bad_media", `part 0 is not a ${TYPE_NAME[want]} file, which the item was declared as`);
      if (info.width !== null && (info.width !== item.width || info.height !== item.height)) {
        return apiError(400, "bad_media", "the picture's width and height differ from the declared ones");
      }
    }

    // Claim the part: only while the item is still uploading. Sending a part again takes
    // the claim over, so a request that died never blocks its part.
    const token = claimToken();
    const key = partKey(item.id, n);
    const claim = await deps.db.run(
      `INSERT INTO media_part (media_id, n, bytes, claim, stored_at)
       SELECT id, ?, ?, ?, NULL FROM media WHERE id = ? AND workspace_id = ? AND state = 'uploading'
       ON CONFLICT (media_id, n) DO UPDATE SET bytes = excluded.bytes, claim = excluded.claim, stored_at = NULL`,
      [n, data.byteLength, token, item.id, auth.workspaceId],
    );
    if (claim.changes === 0) {
      const now = await loadItem(deps, auth, item.id);
      return now?.state === "online" ? alreadyOnline() : noItem();
    }
    try {
      await deps.drafts.put(key, data, { contentType: item.content_type, cacheControl: NO_CACHE });
    } catch (err) {
      // The part is not stored: its row goes, if it is still this request's, so a commit
      // asks for it again. Whatever the store holds under the key is the item's to delete.
      await deps.db.run("DELETE FROM media_part WHERE media_id = ? AND n = ? AND claim = ?", [item.id, n, token]);
      throw err;
    }
    const done = await deps.db.run(
      `UPDATE media_part SET claim = NULL, stored_at = ?
        WHERE media_id = ? AND n = ? AND claim = ? AND media_id IN (SELECT id FROM media WHERE id = ? AND workspace_id = ? AND state = 'uploading')`,
      [deps.now(), item.id, n, token, item.id, auth.workspaceId],
    );
    if (done.changes === 1) return noContent();
    // A later send of this part took the claim over (it marks the part stored itself; both
    // were checked the same way, so either's bytes will do), or the item was deleted or
    // swept meanwhile: then the object is nobody's, and this request removes it, since the
    // delete may have run before the object was written.
    const after = await loadItem(deps, auth, item.id);
    if (after === null || after.state === "closing") {
      await deps.drafts.delete([key]);
      return noItem();
    }
    return noContent();
  });

  // Store the preview picture. 204 once it is stored.
  app.put("/api/v1/media/:id/preview", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null || item.state === "closing") return noItem();
    if (item.state === "online") return alreadyOnline();
    const data = await readCapped(c.req.raw, PREVIEW_RULE.maxBytes);
    if (data === "too_large") return apiError(413, "too_large", `the preview is over ${PREVIEW_RULE.maxBytes} bytes`);
    const checked = checkImage(data, PREVIEW_RULE);
    if (!checked.ok) return apiError(400, "bad_image", `preview: ${checked.error}`);
    const type = checked.info.type;

    // Claim the preview, in one statement with the allowance: its size counts as used from
    // here on, in place of the size of a preview it replaces. Parameters, in the order they
    // stand in the text: type, size and token; the item; the size once more; the workspace
    // id of USED_SQL; ALLOWANCE_OF_SQL's three.
    const token = claimToken();
    const claim = await deps.db.run(
      `UPDATE media SET preview_type = ?, preview_bytes = ?, preview_claim = ?, preview_stored_at = NULL
        WHERE id = ? AND workspace_id = ? AND state = 'uploading'
          AND (SELECT r.allowance IS NULL OR r.used - coalesce(media.preview_bytes, 0) + ? <= r.allowance
                 FROM (SELECT ${USED_SQL} AS used, ${ALLOWANCE_OF_SQL} AS allowance) r)`,
      [type, data.byteLength, token, item.id, auth.workspaceId, data.byteLength, auth.workspaceId, ...allowanceParams(deps, auth.workspaceId)],
    );
    if (claim.changes === 0) {
      const now = await loadItem(deps, auth, item.id);
      if (now === null || now.state === "closing") return noItem();
      if (now.state === "online") return alreadyOnline();
      const usage = await usageOf(deps, auth.workspaceId);
      return storageFull(usage, Math.max(0, data.byteLength - (now.preview_bytes ?? 0)), "preview");
    }
    const key = previewKey(item.id, type);
    try {
      await deps.drafts.put(key, data, { contentType: PREVIEW_TYPE[type], cacheControl: NO_CACHE });
    } catch (err) {
      await deps.db.run("UPDATE media SET preview_type = NULL, preview_bytes = NULL, preview_claim = NULL WHERE id = ? AND workspace_id = ? AND preview_claim = ?", [
        item.id, auth.workspaceId, token,
      ]);
      throw err;
    }
    const done = await deps.db.run("UPDATE media SET preview_claim = NULL, preview_stored_at = ? WHERE id = ? AND workspace_id = ? AND preview_claim = ? AND state = 'uploading'", [
      deps.now(), item.id, auth.workspaceId, token,
    ]);
    if (done.changes === 0) {
      const after = await loadItem(deps, auth, item.id);
      if (after === null || after.state === "closing") {
        await deps.drafts.delete([key]);
        return noItem();
      }
      // A later send of the preview took the claim over and finishes it.
      return noContent();
    }
    // A preview of the other type that this one replaces is removed, so an item holds one.
    if (item.preview_type !== null && item.preview_type !== type) await deps.drafts.delete([previewKey(item.id, item.preview_type)]);
    return noContent();
  });

  // Put the item online. 200 {id, link_id, kind, path, link}, the same again when repeated.
  app.post("/api/v1/media/:id/commit", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null || item.state === "closing") return noItem();
    if (item.state === "online") return json(200, committedOut(deps, item));
    const incomplete = (detail: string) => apiError(409, "incomplete", detail);
    const rows = await deps.db.all<{ n: number; bytes: number; stored_at: number | null }>(
      "SELECT p.n, p.bytes, p.stored_at FROM media_part p JOIN media m ON m.id = p.media_id WHERE p.media_id = ? AND m.workspace_id = ?",
      [item.id, auth.workspaceId],
    );
    const stored = new Map(rows.filter((r) => r.stored_at !== null).map((r) => [r.n, r.bytes]));
    for (let n = 0; n < item.parts; n++) if (!stored.has(n)) return incomplete(`part ${n} has not been sent, or is still being sent`);
    let sum = 0;
    for (let n = 0; n < item.parts; n++) sum += stored.get(n) ?? 0;
    if (sum !== item.bytes) return incomplete(`the parts add up to ${sum} bytes, not the ${item.bytes} declared`);
    if (item.preview_claim !== null) return incomplete("the preview is still being sent; wait for it or send it again");

    // Only while the item is uploading, every part is stored and none is claimed, the
    // stored parts add up to the declared bytes, and no preview is being sent: checked
    // again in the statement itself, so a send that started after the look above is
    // either finished by then or makes this a no-op.
    const done = await deps.db.run(
      `UPDATE media SET state = 'online', online_at = ?
        WHERE id = ? AND workspace_id = ? AND state = 'uploading' AND preview_claim IS NULL
          AND (SELECT count(*) FROM media_part p WHERE p.media_id = media.id AND p.n < media.parts AND p.stored_at IS NOT NULL AND p.claim IS NULL) = media.parts
          AND (SELECT coalesce(sum(p.bytes), 0) FROM media_part p WHERE p.media_id = media.id AND p.n < media.parts AND p.stored_at IS NOT NULL) = media.bytes`,
      [deps.now(), item.id, auth.workspaceId],
    );
    const now = await loadItem(deps, auth, item.id);
    if (now === null || now.state === "closing") return noItem();
    if (now.state === "online") return json(200, committedOut(deps, now));
    if (done.changes === 0) return incomplete("a part or the preview was being sent again while finishing; finish it once more");
    return json(200, committedOut(deps, now));
  });

  // Delete an item in any state. 204 once nothing of it is left; repeat on 500 cleanup_pending.
  app.delete("/api/v1/media/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    if (!ITEM_ID.test(id)) return noItem();
    const item = await deps.db.first<{ id: string; parts: number }>("SELECT id, parts FROM media WHERE id = ? AND workspace_id = ?", [id, auth.workspaceId]);
    if (item === null) return noItem();
    // Closing first: from here on the item counts for nothing and nothing can change it.
    await deps.db.run("UPDATE media SET state = 'closing' WHERE id = ? AND workspace_id = ?", [item.id, auth.workspaceId]);
    try {
      await removeClosing(deps, auth.workspaceId, item);
    } catch {
      console.error("delete: could not remove some files of a deleted item; the next delete call retries");
      return apiError(500, "cleanup_pending", "the item is deleted, but some of its files could not be removed yet; delete it again to retry");
    }
    return noContent();
  });

  // The workspace's online items of one kind, newest first, a page at a time.
  app.get("/api/v1/media", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const kind = c.req.query("kind");
    if (kind !== "image" && kind !== "clip") return apiError(400, "bad_request", 'kind must be "image" or "clip"');
    const cursorText = c.req.query("cursor");
    const cursor = cursorText === undefined || cursorText === "" ? null : decodeCursor(cursorText);
    if (cursor === null && cursorText !== undefined && cursorText !== "") return apiError(400, "bad_cursor", "the cursor is not one this list gave");
    const after = cursor === null ? "" : " AND (created_at < ? OR (created_at = ? AND id < ?))";
    const rows = await deps.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM media WHERE workspace_id = ? AND kind = ? AND state = 'online'${after} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [auth.workspaceId, kind, ...(cursor === null ? [] : [cursor.createdAt, cursor.createdAt, cursor.id]), LIST_PAGE + 1],
    );
    const page = rows.slice(0, LIST_PAGE);
    const last = page.at(-1);
    const next = rows.length > LIST_PAGE && last !== undefined ? encodeCursor(last.created_at, last.id) : null;
    return json(200, { items: page.map((r) => itemOut(deps, r)), next });
  });

  // One item, in any state but closing.
  app.get("/api/v1/media/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null || item.state === "closing") return noItem();
    return json(200, { ...itemOut(deps, item), state: item.state });
  });

  // The preview picture, to its own workspace only.
  app.get("/api/v1/media/:id/preview", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null || item.state === "closing") return noItem();
    if (item.preview_type === null || item.preview_stored_at === null) return apiError(404, "not_found", "this item has no preview");
    const file = await deps.drafts.get(previewKey(item.id, item.preview_type));
    if (file === null) return apiError(404, "not_found", "this item has no preview");
    return new Response(file.body, { status: 200, headers: previewHeaders(item.preview_type, file.size) });
  });
}
