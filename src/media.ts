// Shared items: a workspace shares a single image (a PNG or a JPEG) or a short clip (a GIF
// or an MP4). This file is the authenticated API, and the one lookup the public serving
// routes use (onlineItemFiles): start an item, send its parts and an optional preview
// picture, commit it, read it, list a workspace's items and delete one. Every query is
// scoped by the workspace of the caller (a token or a session, through requireAuth exactly
// as the upload routes take it), and another workspace's item answers as one that never
// existed. A disabled account's workspace is refused by requireAuth itself, before any of
// this runs, as for the uploads.
//
// The protocol:
// - POST /api/v1/media declares the item. One statement checks the storage allowance and
//   writes the row, whose declared bytes from then on count as used (src/usage.ts), so two
//   creates at the same moment can never pass the allowance together. The answer says how
//   many parts to send and how long each is: PART_BYTES each, the last one the rest.
// - PUT .../parts/:n stores part n. Part 0 is checked against the declared type (and, for
//   a PNG, JPEG or GIF, the declared width and height) from its own bytes. Sending a part
//   again replaces it.
// - PUT .../preview stores the optional preview picture, checked like a logo.
// - POST .../commit checks that every part is stored and that they add up to the declared
//   bytes, and puts the item online. From then on none of the bytes it serves can change.
// - DELETE removes the item in any state, its rows and every object it wrote.
// An item not committed within MEDIA_MAX_AGE_MS answers as one that was swept, whether or
// not a sweep has run yet, and is swept by the workspace's next create.
//
// Every object is written under a key of its own claim, and a row names it before it is
// written. That gives three things, whatever the order requests meet in:
// (a) Every object under `m/` is named by a row until it has been deleted. A request first
//     inserts a `media_object` row (item, part number or -1 for the preview, a random claim
//     token, the time), only while the item is uploading, and only then writes the object
//     at `m/<id>/part-NNN.<claim>` or `m/<id>/preview.<claim>.<png|jpg>`. A delete or the
//     sweep deletes the key of every claim row, and removes a claim row only once its object
//     cannot appear any more: it was stored (written before the item closed), or it is
//     older than CLAIM_LIFETIME_MS, longer than any request lives. The item row goes only
//     with its last claim row; a younger claim keeps it closing until a later delete, a
//     later sweep, or that request's own clean-up finishes it.
// (b) Once online, none of the bytes an item serves can change. The object a part or the
//     preview serves is its `current` claim, made current only by the statement that marks
//     that claim stored, which takes effect only while the item is uploading. A request that
//     lost or came late writes under its own key, so it can never overwrite what is served,
//     and deletes its own object. Only claims that are no longer current are ever deleted
//     while an item is online, and a claim that was current once never becomes current again.
// (c) An item's bytes count toward the allowance until its row is removed, which happens
//     only with its last object: the usage counts every item row, closing ones too, and
//     every claim row but the current part claims, which the item's bytes already hold
//     (src/usage.ts). A delete frees the room when it answers 204; one answered
//     cleanup_pending (a store that failed, or a send still under way) counts until it is
//     finished by a later delete, the sweep, or that send's own clean-up.
// A send that dies after its object landed leaves a claim that is not current: it counts,
// an item may hold at most MAX_LOOSE_CLAIMS of them before a further send is refused with
// 429, and every later send, commit and sweep that meets one older than CLAIM_LIFETIME_MS
// removes it, object first.
//
// Where the objects live: the private store (`deps.drafts`), never the public one. The
// public store can be a bucket with a public domain of its own (PUBLIC_IMAGE_BASE), where
// an object is reachable without the app: an unfinished item, one being deleted, one of a
// disabled account, and every online item would then be served past the checks the
// serving route makes. Items are always served through the app (it reads the parts through
// onlineItemFiles and sets its own fixed headers), so nothing needs them in the public
// store, and nothing is copied at commit. Their keys are under `m/`; everything else in
// the private store is under `u/` (src/uploads.ts writes every draft key there, and the
// upload abort and sweep, the tour delete and the replaced-picture clean-up delete only
// keys taken from step, upload and replaced rows, which are those `u/` keys) or `v/` (a
// restricted tour's live pictures, src/access.ts, deleted only by keys taken from
// snapshot_object and public_object rows, which are those `v/` keys), so no other
// clean-up can reach an item's object, and an item's delete names only its own claims.
import type { Hono } from "hono";
import { newId, newLinkId, requireAuth, type Auth } from "./auth.ts";
import { mediaOrigin } from "./hosts.ts";
import { MAX_PARTS, PART_BYTES, mediaLimitsProblem } from "./limits.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { isNotNullViolation, isUniqueViolation, type Config, type Deps, type Stmt } from "./ports.ts";
import { LIMITS_MEDIA, hitLimit, workspaceKey, type Limit } from "./rate.ts";
import { checkImage, mediaInfo, type ImageType, type MediaType } from "./sniff.ts";
import { ALLOWANCE_OF_SQL, USED_SQL, allowanceParams, storageFull, usageOf } from "./usage.ts";
import { itemCreationAccess } from "./media-access.ts";
import { ACCESS_BODY_BYTES, creationAccess, hasAccessFields, type Access } from "./viewing.ts";

/** The longest request body (a part: every part but the last is exactly this long), and the most parts an item may have. */
export { MAX_PARTS, PART_BYTES, mediaLimitsProblem };
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
/** An item not committed within this long answers as swept, and is swept by the workspace's next create. */
export const MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long a claim that was never marked stored may still see its object written: longer
 * than any request that writes one lives. After it, a delete takes the claim as dead.
 */
export const CLAIM_LIFETIME_MS = 5 * 60 * 1000;
/**
 * A claim is stored only while younger than CLAIM_LIFETIME_MS less this, and taken as dead
 * only once older than CLAIM_LIFETIME_MS: the gap covers clocks that differ a little.
 */
export const CLAIM_STORE_MARGIN_MS = 60_000;
/** Items one list page holds. */
export const LIST_PAGE = 50;
/** Items one create removes at most while sweeping, to bound its work: three calls each. */
const SWEEP_LIMIT = 5;
/** Online items whose loose claims one create removes at most while sweeping: three calls each. */
const PRUNE_LIMIT = 2;
/**
 * The most claims of an item that are not current (sends under way, or left by a send that
 * died) a new send may find: one more is refused with 429 until they finish or expire. So an
 * item holds at most parts + 1 + MAX_LOOSE_CLAIMS claim rows, and a delete stays bounded.
 */
export const MAX_LOOSE_CLAIMS = 4;
/** The create's JSON body: a few short fields and a title. */
const CREATE_BODY_BYTES = 4096;
/** Attempts at a fresh link id when one collides with an existing item's. */
const LINK_ATTEMPTS = 5;
/** The part number a preview's claim row carries. */
const PREVIEW = -1;

export const ITEM_ID = /^med_[0-9a-f]{24}$/;
const PART_NUMBER = /^(0|[1-9][0-9]{0,2})$/;

export type MediaKind = "image" | "clip";
const CONTENT_TYPES: Record<MediaKind, readonly string[]> = { image: ["image/png", "image/jpeg"], clip: ["image/gif", "video/mp4"] };
const TYPE_OF: Record<string, MediaType> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "video/mp4": "mp4" };
const TYPE_NAME: Record<MediaType, string> = { png: "PNG", jpg: "JPEG", gif: "GIF", mp4: "MP4" };
const PREVIEW_TYPE: Record<ImageType, string> = { png: "image/png", jpg: "image/jpeg" };
/** A control, format or surrogate character, or a line or paragraph separator: none may be in a title. */
const FORBIDDEN_IN_TITLE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
/** Every object is written as not to be cached; whatever serves an item sets its own headers. */
const NO_CACHE = "no-store";

type Limits = { imageMaxBytes: number; imageMaxSide: number; clipMaxBytes: number };

/** The limits this deployment uses. Throws the problem for settings mediaLimitsProblem refuses. */
export function mediaLimits(config: Config): Limits {
  const problem = mediaLimitsProblem(config);
  if (problem !== null) throw new Error(problem);
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

/** The key of one claim's object: a part's, or (n = -1) the preview's of type `ext`. */
function objectKey(id: string, o: { n: number; claim: string; ext: ImageType | null }): string {
  return o.n === PREVIEW ? `m/${id}/preview.${o.claim}.${o.ext ?? "png"}` : `m/${id}/part-${String(o.n).padStart(3, "0")}.${o.claim}`;
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

/** A random token naming one request's claim: 24 hex characters. */
function claimToken(): string {
  return newId("med").slice(4);
}

export type ItemRow = {
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
  created_at: number;
  /** Who may view it (src/media-access.ts), and how many addresses its list holds. */
  access: Access;
  viewers: number;
  /** The current preview's type, its size and its claim, or null when the item has none. */
  preview_type: ImageType | null;
  preview_bytes: number | null;
  preview_claim: string | null;
};

/** The current preview claim of the item row `m` in scope, one column of it. */
const currentPreview = (column: string) => `(SELECT o.${column} FROM media_object o WHERE o.media_id = m.id AND o.n = -1 AND o.current = 1)`;
/**
 * An item's columns. Its link id is its real one: a restricted item's is in private_link_id,
 * and its link_id then holds a name nothing ever gives out (migration 0016), which no answer
 * of this build carries.
 */
const ITEM_COLUMNS = `m.id, coalesce(m.private_link_id, m.link_id) AS link_id, m.kind, m.content_type, m.bytes, m.parts, m.width, m.height, m.duration_ms, m.title, m.state, m.created_at,
  m.access, (SELECT count(*) FROM media_viewer v WHERE v.media_id = m.id) AS viewers,
  ${currentPreview("ext")} AS preview_type, ${currentPreview("bytes")} AS preview_bytes, ${currentPreview("claim")} AS preview_claim`;

/** An item of this workspace that requests may still act on: not closing, and not left unfinished past MEDIA_MAX_AGE_MS. */
export async function loadItem(deps: Deps, auth: Auth, id: string): Promise<ItemRow | null> {
  if (!ITEM_ID.test(id)) return null;
  const row = await deps.db.first<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM media m WHERE m.id = ? AND m.workspace_id = ?`, [id, auth.workspaceId]);
  if (row === null || row.state === "closing") return null;
  if (row.state === "uploading" && row.created_at < deps.now() - MEDIA_MAX_AGE_MS) return null;
  return row;
}

/** The condition, over an item row `media` in scope, that it is uploading and not past its age. Two parameters: the workspace id, the age floor. */
const OPEN_ITEM = "media.workspace_id = ? AND media.state = 'uploading' AND media.created_at >= ?";
/** The condition, over an item row `media` in scope, that it holds fewer than MAX_LOOSE_CLAIMS claims that are not current. No parameter. */
const FEW_LOOSE = `(SELECT count(*) FROM media_object l WHERE l.media_id = media.id AND l.current = 0) < ${MAX_LOOSE_CLAIMS}`;

const noItem = () => apiError(404, "not_found", "no such item");
const alreadyOnline = () => apiError(409, "already_online", "the item is online and cannot change any more; delete it and start again to change it");
const tooMany = (limit: Limit, what: string, retryAfter: number) => {
  const res = apiError(429, "too_many_items", `this workspace ${what} ${limit.most} times in the last hour; try again later`);
  res.headers.set("retry-after", String(retryAfter));
  return res;
};

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
    has_preview: row.preview_claim !== null,
    path: mediaPath(row),
    link: mediaLink(deps.config, row),
    access: row.access,
    viewers: row.viewers,
  };
}

/** The commit's answer, the same each time it is asked. */
function committedOut(deps: Deps, row: ItemRow) {
  return { id: row.id, link_id: row.link_id, kind: row.kind, path: mediaPath(row), link: mediaLink(deps.config, row) };
}

type ClaimRow = { n: number; claim: string; ext: ImageType | null; stored_at: number | null; claimed_at: number };

/**
 * Removes what it can of an item of this workspace that is already closing: deletes the
 * object of every claim row, then removes the claim rows whose object cannot appear any
 * more (stored, or older than CLAIM_LIFETIME_MS when this call began: the one time taken
 * before the read decides, so a claim that was young when its key was deleted keeps its
 * row), and the item row once none is left. Three calls, whatever the number of parts:
 * one store delete takes up to 1,000 keys (src/budget.ts counts it as one call, R2
 * deletes them in one operation, and the Node store deletes them one by one within that
 * call), and an item holds at most parts + 1 + MAX_LOOSE_CLAIMS rows. True when the item
 * is gone.
 */
export async function removeClosing(deps: Deps, workspaceId: string, id: string): Promise<boolean> {
  const floor = deps.now() - CLAIM_LIFETIME_MS;
  const rows = await deps.db.all<ClaimRow>(
    "SELECT o.n, o.claim, o.ext, o.stored_at, o.claimed_at FROM media_object o JOIN media m ON m.id = o.media_id WHERE o.media_id = ? AND m.workspace_id = ? AND m.state = 'closing'",
    [id, workspaceId],
  );
  if (rows.length > 0) await deps.drafts.delete(rows.map((o) => objectKey(id, o)));
  const done = rows.filter((o) => o.stored_at !== null || o.claimed_at < floor).map((o) => o.claim);
  await deps.db.batch([
    // Its list of who may view it goes at the first try: a closing item is served to nobody,
    // and the row it names can then go with its last object (foreign keys never cascade).
    { sql: "DELETE FROM media_viewer WHERE media_id IN (SELECT id FROM media WHERE id = ? AND workspace_id = ? AND state = 'closing')", params: [id, workspaceId] },
    {
      sql: "DELETE FROM media_object WHERE media_id IN (SELECT id FROM media WHERE id = ? AND workspace_id = ? AND state = 'closing') AND claim IN (SELECT value FROM json_each(?))",
      params: [id, workspaceId, JSON.stringify(done)],
    },
    { sql: "DELETE FROM media WHERE id = ? AND workspace_id = ? AND state = 'closing' AND NOT EXISTS (SELECT 1 FROM media_object WHERE media_id = ?)", params: [id, workspaceId, id] },
  ]);
  return done.length === rows.length;
}

/**
 * The claims of an item that are not current and can no longer become so or see their
 * object written: stored (a newer claim took their place), or older than the floor (their
 * request is gone). Of `rows`, the claim rows of one item.
 */
function looseClaims<T extends ClaimRow & { current: number }>(rows: T[], floor: number): T[] {
  return rows.filter((r) => r.current === 0 && (r.stored_at !== null || r.claimed_at < floor));
}

/**
 * Removes the loose claims of an item of this workspace (see looseClaims), in any state but
 * closing (removeClosing takes those): their objects first, then their rows, each row only
 * while it is still loose. Three calls at most. The number removed.
 */
async function pruneClaims(deps: Deps, workspaceId: string, id: string): Promise<number> {
  const floor = deps.now() - CLAIM_LIFETIME_MS;
  const rows = await deps.db.all<ClaimRow & { current: number }>(
    `SELECT o.n, o.claim, o.ext, o.stored_at, o.claimed_at, o.current FROM media_object o JOIN media m ON m.id = o.media_id
      WHERE o.media_id = ? AND m.workspace_id = ? AND m.state <> 'closing' AND o.current = 0`,
    [id, workspaceId],
  );
  const loose = looseClaims(rows, floor);
  if (loose.length === 0) return 0;
  await deps.drafts.delete(loose.map((o) => objectKey(id, o)));
  await deps.db.run(
    "DELETE FROM media_object WHERE media_id = ? AND current = 0 AND (stored_at IS NOT NULL OR claimed_at < ?) AND claim IN (SELECT value FROM json_each(?))",
    [id, floor, JSON.stringify(loose.map((o) => o.claim))],
  );
  return loose.length;
}

/**
 * Closes every item of the workspace still unfinished after MEDIA_MAX_AGE_MS, in one
 * statement, then removes up to SWEEP_LIMIT of its closing items, the oldest first: those
 * just closed, and any whose delete was cut off. An item that still holds a claim younger
 * than CLAIM_LIFETIME_MS is skipped by the LIMIT, so it cannot keep the others waiting.
 * Then it removes the loose claims of up to PRUNE_LIMIT online items (a send that died
 * after the item was finished leaves one). What could not be removed now is tried again
 * by a later sweep. At most 2 + 3 × SWEEP_LIMIT + 1 + 3 × PRUNE_LIMIT calls.
 */
async function sweep(deps: Deps, workspaceId: string): Promise<void> {
  const now = deps.now();
  const floor = now - CLAIM_LIFETIME_MS;
  await deps.db.run("UPDATE media SET state = 'closing' WHERE workspace_id = ? AND state = 'uploading' AND created_at < ?", [workspaceId, now - MEDIA_MAX_AGE_MS]);
  const closing = await deps.db.all<{ id: string }>(
    `SELECT m.id FROM media m WHERE m.workspace_id = ? AND m.state = 'closing'
        AND NOT EXISTS (SELECT 1 FROM media_object o WHERE o.media_id = m.id AND o.stored_at IS NULL AND o.claimed_at >= ?)
      ORDER BY m.created_at, m.id LIMIT ?`,
    [workspaceId, floor, SWEEP_LIMIT],
  );
  for (const item of closing) {
    try {
      await removeClosing(deps, workspaceId, item.id);
    } catch {
      // Fixed text only: the error could carry anything a back end put in its message.
      console.error(`sweep: could not remove a closing item ${item.id}; will retry later`);
    }
  }
  const online = await deps.db.all<{ id: string }>(
    `SELECT m.id FROM media m WHERE m.workspace_id = ? AND m.state = 'online'
        AND EXISTS (SELECT 1 FROM media_object o WHERE o.media_id = m.id AND o.current = 0 AND (o.stored_at IS NOT NULL OR o.claimed_at < ?))
      ORDER BY m.created_at, m.id LIMIT ?`,
    [workspaceId, floor, PRUNE_LIMIT],
  );
  for (const item of online) {
    try {
      await pruneClaims(deps, workspaceId, item.id);
    } catch {
      console.error(`sweep: could not remove the loose files of an item ${item.id}; will retry later`);
    }
  }
}

/**
 * Stores one object for an item under a new claim of its own: the claim row (one statement
 * that holds the item's conditions and refuses a claim while the item already holds
 * MAX_LOOSE_CLAIMS claims that are not current), the object, then one batch that marks
 * the claim stored and current in place of the claim that was, only while the item is
 * uploading. Then the item's loose claims (the one this replaced, and any of a request
 * that is gone) are removed, objects first. At most seventeen calls, auth included: auth
 * (2), the item (1) and the rate limit (1) before it; the claim (1); when that is refused
 * at the bound of loose claims, a look (1), their removal (3) and a second try (1), or
 * instead of the second try a look (1), the item (1) and, for a preview, the usage (1)
 * before the answer; then the object (1), the batch (1), the read (1) and the removal of
 * what it replaced (2), or, when the claim was not stored, a look at its row (1), its
 * removal (2) and the item (1). Answers 204, or what the item has become meanwhile.
 *
 * Expiry is final: a claim old enough to be taken as dead (older than CLAIM_LIFETIME_MS,
 * which pruneClaims and removeClosing remove, object first) can never be stored. The batch
 * marks a claim stored only while it is younger than CLAIM_LIFETIME_MS less
 * CLAIM_STORE_MARGIN_MS, one value taken once after the object was written, so the two
 * ages never overlap the wrong way even between clocks that differ by up to the margin.
 * A send past it ends in the clean-up, and answers 409 superseded.
 */
async function storeClaim(
  deps: Deps,
  auth: Auth,
  item: ItemRow,
  o: { n: number; ext: ImageType | null; bytes: number; data: Uint8Array; contentType: string },
  claim: (token: string, now: number) => Stmt,
  refused: () => Promise<Response>,
  /** For a claim counted against the allowance (the preview): the storage answer when it does not fit, else null. */
  full: (now: ItemRow) => Promise<Response | null> = async () => null,
): Promise<Response> {
  const token = claimToken();
  const key = objectKey(item.id, { n: o.n, claim: token, ext: o.ext });
  const insert = async () => {
    const stmt = claim(token, deps.now());
    return (await deps.db.run(stmt.sql, stmt.params)).changes === 1;
  };
  const loose = () =>
    deps.db.first<{ held: number; oldest: number | null }>(
      "SELECT count(*) AS held, min(CASE WHEN stored_at IS NULL THEN claimed_at END) AS oldest FROM media_object WHERE media_id = ? AND current = 0",
      [item.id],
    );
  if (!(await insert())) {
    // Refused: the item changed, the allowance is full (a preview), or too many sends of it
    // have not finished. Loose claims are removed and the claim is tried once more.
    let held = await loose();
    if ((held?.held ?? 0) < MAX_LOOSE_CLAIMS) return refused();
    // Housekeeping: an error removing them falls through to the answer below, never a 500.
    let pruned = 0;
    try {
      pruned = await pruneClaims(deps, auth.workspaceId, item.id);
    } catch {
      console.error("media: could not remove loose files of an item; a later send, commit or sweep removes them");
    }
    if (pruned > 0 && (await insert())) {
      held = null;
    } else {
      held = await loose();
      if ((held?.held ?? 0) < MAX_LOOSE_CLAIMS) return refused();
      // Still at the bound: what the item has become comes first (finished or gone), then
      // the allowance for a preview, and only then the bound itself.
      const now = await loadItem(deps, auth, item.id);
      if (now === null) return noItem();
      if (now.state === "online") return alreadyOnline();
      const storage = await full(now);
      if (storage !== null) return storage;
      const wait = held?.oldest === null || held?.oldest === undefined ? CLAIM_LIFETIME_MS : held.oldest + CLAIM_LIFETIME_MS - deps.now();
      const res = apiError(429, "too_many_items", `${MAX_LOOSE_CLAIMS} sends of this item have not finished; wait for them, or try again later`);
      res.headers.set("retry-after", String(Math.min(CLAIM_LIFETIME_MS / 1000, Math.max(1, Math.ceil(wait / 1000)))));
      return res;
    }
  }
  // The object goes under this claim's own key: nothing it writes can replace what another
  // claim stored, whatever the order of the two.
  // "claimed": the batch was not sent, so the claim is certainly not stored. "sent": it was
  // sent, and whether it took effect is known only from a successful read of the claim row.
  let phase: "claimed" | "sent" | "stored" = "claimed";
  try {
    await deps.drafts.put(key, o.data, { contentType: o.contentType, cacheControl: NO_CACHE });
    const open = `EXISTS (SELECT 1 FROM media WHERE media.id = ? AND ${OPEN_ITEM})`;
    const floor = deps.now() - MEDIA_MAX_AGE_MS;
    // The youngest a claim may be stored at: one value for both statements.
    const fresh = deps.now() - CLAIM_LIFETIME_MS + CLAIM_STORE_MARGIN_MS;
    phase = "sent";
    await deps.db.batch([
      {
        sql: `UPDATE media_object SET current = 0 WHERE media_id = ? AND n = ? AND current = 1 AND ${open}
                AND EXISTS (SELECT 1 FROM media_object c WHERE c.media_id = ? AND c.claim = ? AND c.stored_at IS NULL AND c.claimed_at >= ?)`,
        params: [item.id, o.n, item.id, auth.workspaceId, floor, item.id, token, fresh],
      },
      {
        sql: `UPDATE media_object SET stored_at = ?, current = 1 WHERE media_id = ? AND claim = ? AND stored_at IS NULL AND claimed_at >= ? AND ${open}`,
        params: [deps.now(), item.id, token, fresh, item.id, auth.workspaceId, floor],
      },
    ]);
    const rows = await deps.db.all<ClaimRow & { current: number }>("SELECT n, claim, ext, stored_at, claimed_at, current FROM media_object WHERE media_id = ? AND (n = ? OR current = 0)", [item.id, o.n]);
    if (rows.some((r) => r.claim === token && r.current === 1)) {
      phase = "stored";
      // What this claim replaced is served no more and can never be served again, and a
      // claim older than its lifetime has no request left: both go. Housekeeping: a failure
      // leaves them to the next touch, and this answer stands.
      try {
        const gone = looseClaims(rows.filter((r) => r.claim !== token), deps.now() - CLAIM_LIFETIME_MS);
        if (gone.length > 0) {
          await deps.drafts.delete(gone.map((r) => objectKey(item.id, r)));
          await deps.db.run("DELETE FROM media_object WHERE media_id = ? AND current = 0 AND claim IN (SELECT value FROM json_each(?))", [item.id, JSON.stringify(gone.map((r) => r.claim))]);
        }
      } catch {
        console.error("media: could not remove replaced files; a later send, commit or sweep removes them");
      }
      return noContent();
    }
  } finally {
    if (phase !== "stored") await dropClaim(deps, auth, item.id, token, key, phase === "sent");
  }
  // Not stored: the item was finished, deleted or swept meanwhile, or this claim's row was
  // removed as too old. A live item is answered as such, so the client does not give it up.
  const after = await loadItem(deps, auth, item.id);
  if (after === null) return noItem();
  if (after.state === "online") return alreadyOnline();
  return apiError(409, "superseded", "this send did not take its place (it took too long, or a newer send replaced it); check the item and send again what is missing");
}

/**
 * Removes the object and row of a claim this request made and did not see stored. When the
 * batch that stores it was sent, the claim row is read first, and the object is deleted
 * only when that read succeeds and shows the row gone or not stored: a batch that took
 * effect although its answer was lost leaves a stored claim, which may be current and
 * served, and is left alone; a read that fails deletes nothing, and the row still names
 * the object for the delete or the sweep. Nothing is thrown from here.
 */
async function dropClaim(deps: Deps, auth: Auth, itemId: string, token: string, key: string, sent: boolean): Promise<void> {
  try {
    if (sent) {
      const row = await deps.db.first<{ stored_at: number | null }>("SELECT stored_at FROM media_object WHERE media_id = ? AND claim = ?", [itemId, token]);
      if (row !== null && row.stored_at !== null) return;
    }
    await deps.drafts.delete([key]);
    await deps.db.batch([
      { sql: "DELETE FROM media_object WHERE media_id = ? AND claim = ? AND stored_at IS NULL", params: [itemId, token] },
      { sql: "DELETE FROM media WHERE id = ? AND workspace_id = ? AND state = 'closing' AND NOT EXISTS (SELECT 1 FROM media_object WHERE media_id = ?)", params: [itemId, auth.workspaceId, itemId] },
    ]);
  } catch {
    console.error("media: could not remove an object that was not stored; the item's delete or sweep removes it");
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

/** What the public serving routes need of an online item: its fields, and the private store's keys of its parts (in order) and preview. */
export type OnlineItemFiles = {
  id: string;
  /** Its workspace, for the viewer gate's opaque key (src/media-access.ts); never answered. */
  workspaceId: string;
  kind: MediaKind;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  durationMs: number | null;
  title: string | null;
  /** When the item went online (its commit), for the page's "shared" date. */
  sharedAt: number;
  /** Who may view it: anything but `public` is served only past the viewer check (src/media-page.ts). */
  access: Access;
  /** The keys in `deps.drafts` of parts 0 to parts - 1, in order: read and send them one after another. */
  parts: string[];
  /** The preview's key in `deps.drafts` and its type as read from its bytes, or null. */
  preview: { key: string; type: ImageType } | null;
};

/**
 * The files of the online item with this link id, for the public serving routes: null for
 * a link id no item has, an item that is not online (unfinished, or being deleted), and an
 * item of a workspace with a disabled account (the same condition the token lookup holds,
 * src/auth.ts). Exactly two database calls and no store call for every input, a malformed
 * link id and one no item has included (each is looked up as "", which finds nothing), so
 * the work done does not tell which ids exist. What it answers cannot change while the
 * item is online: the keys are its current claims, which change only while uploading.
 */
export async function onlineItemFiles(deps: Deps, linkId: string): Promise<OnlineItemFiles | null> {
  const wellFormed = /^[a-z2-7]{20}$/.test(linkId);
  const asked = wellFormed ? linkId : "";
  // A public item by its link id; a restricted one by its real link id alone, which is in
  // private_link_id (its link_id is a name nobody was given, and finds nothing here).
  const item = await deps.db.first<ItemRow & { online_at: number | null; workspace_id: string }>(
    `SELECT ${ITEM_COLUMNS}, m.online_at, m.workspace_id FROM media m
      WHERE ((m.link_id = ? AND m.access = 'public') OR (m.private_link_id = ? AND m.access <> 'public')) AND m.state = 'online'
        AND NOT EXISTS (SELECT 1 FROM user u WHERE u.status = 'disabled'
                          AND (u.workspace_id = m.workspace_id OR u.id IN (SELECT ms.user_id FROM membership ms WHERE ms.workspace_id = m.workspace_id)))`,
    [asked, asked],
  );
  // The second call is made for every input, with "" when there is no item, which finds nothing.
  const parts = await deps.db.all<{ n: number; claim: string }>("SELECT n, claim FROM media_object WHERE media_id = ? AND current = 1 AND n >= 0 ORDER BY n", [item?.id ?? ""]);
  if (item === null) return null;
  if (parts.length !== item.parts || parts.some((p, i) => p.n !== i)) return null;
  return {
    id: item.id,
    workspaceId: item.workspace_id,
    kind: item.kind,
    contentType: item.content_type,
    bytes: item.bytes,
    width: item.width,
    height: item.height,
    durationMs: item.duration_ms,
    title: item.title,
    sharedAt: item.online_at ?? item.created_at,
    access: item.access,
    parts: parts.map((p) => objectKey(item.id, { n: p.n, claim: p.claim, ext: null })),
    preview: item.preview_claim === null || item.preview_type === null ? null : { key: objectKey(item.id, { n: PREVIEW, claim: item.preview_claim, ext: item.preview_type }), type: item.preview_type },
  };
}

export function mediaRoutes(app: Hono, deps: Deps): void {
  // Start an item. 201 {id, parts, part_bytes}, and, when the request stated who may view
  // it, `access` and `viewers` (how many addresses; never the addresses) after them.
  app.post("/api/v1/media", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    // A body that states who may view the item may carry up to MAX_VIEWERS addresses, so it
    // may be longer than CREATE_BODY_BYTES by up to ACCESS_BODY_BYTES; every other body is
    // held to CREATE_BODY_BYTES exactly as before, with the same answer.
    const overCap = () => apiError(413, "too_large", `the request is over ${CREATE_BODY_BYTES} bytes`);
    const raw = await readCapped(c.req.raw, CREATE_BODY_BYTES + ACCESS_BODY_BYTES);
    if (raw === "too_large") return overCap();
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    } catch {
      return raw.byteLength > CREATE_BODY_BYTES ? overCap() : apiError(400, "bad_request", "the body is not JSON");
    }
    if (raw.byteLength > CREATE_BODY_BYTES && !hasAccessFields(body)) return overCap();
    const d = parseCreate(body, deps.config);
    if (d instanceof Response) return d;
    const asked = creationAccess(body as Record<string, unknown>, "an item's");
    if (asked instanceof Response) return asked;
    const parts = partsOf(d.bytes);
    // Decided before anything is counted or written: a restricted setting this site or this
    // item cannot have refuses the create, and nothing of it exists.
    const stated = itemCreationAccess(deps, asked, parts);
    if (stated instanceof Response) return stated;

    const limit = await hitLimit(deps, LIMITS_MEDIA.create, await workspaceKey(auth.workspaceId));
    if (limit.over) return tooMany(LIMITS_MEDIA.create, "started items", limit.retryAfterSeconds);

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
    // text: the row's values; the workspace id of USED_SQL; ALLOWANCE_OF_SQL's three; the
    // item's bytes once more. With a stated setting the row is written with it (and, when
    // restricted, its link id kept apart), and the audit row and the list follow in the same
    // batch: the audit row fails the batch unless the row was written.
    const now = deps.now();
    for (let attempt = 1; ; attempt++) {
      const id = newId("med");
      const access = stated === null ? null : attempt === 1 ? stated : itemCreationAccess(deps, asked, parts);
      if (access instanceof Response) return access; // cannot happen: decided above, and nothing it reads changed
      const insert: Stmt = {
        sql: `INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, created_at${access === null ? "" : ", access, private_link_id"})
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?${access === null ? "" : ", ?, ?"}
             FROM (SELECT ${USED_SQL} AS used, ${ALLOWANCE_OF_SQL} AS allowance) r
            WHERE r.allowance IS NULL OR r.used + ? <= r.allowance`,
        params: [
          id, auth.workspaceId, access === null ? newLinkId() : access.rowLinkId, d.kind, d.contentType, d.bytes, parts, d.width, d.height, d.durationMs, d.title, now,
          ...(access === null ? [] : [access.access, access.privateLinkId]),
          auth.workspaceId, ...allowanceParams(deps, auth.workspaceId), d.bytes,
        ],
      };
      let made: boolean;
      try {
        if (access === null) {
          made = (await deps.db.run(insert.sql, insert.params)).changes === 1;
        } else {
          await deps.db.batch([insert, ...access.after(deps, auth, id, now)]);
          made = true;
        }
      } catch (err) {
        // A link id (or, far less likely, an id) another item has: try again with fresh ones.
        if (isUniqueViolation(err) && attempt < LINK_ATTEMPTS) continue;
        // The audit row's guard: the allowance refused the row, so nothing was written.
        if (access !== null && isNotNullViolation(err)) made = false;
        else throw err;
      }
      if (made) return json(201, { id, parts, part_bytes: PART_BYTES, ...(access === null ? (asked === null ? {} : { access: "public", viewers: 0 }) : { access: access.access, viewers: access.viewers }) });
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
    if (item === null) return noItem();
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
    const limit = await hitLimit(deps, LIMITS_MEDIA.part, await workspaceKey(auth.workspaceId));
    if (limit.over) return tooMany(LIMITS_MEDIA.part, "sent parts", limit.retryAfterSeconds);

    return storeClaim(
      deps,
      auth,
      item,
      { n, ext: null, bytes: data.byteLength, data, contentType: item.content_type },
      (token, now) => ({
        sql: `INSERT INTO media_object (media_id, n, claim, ext, bytes, claimed_at, current) SELECT id, ?, ?, NULL, ?, ?, 0 FROM media WHERE id = ? AND ${OPEN_ITEM} AND ${FEW_LOOSE}`,
        params: [n, token, data.byteLength, now, item.id, auth.workspaceId, now - MEDIA_MAX_AGE_MS],
      }),
      async () => {
        const now = await loadItem(deps, auth, item.id);
        return now?.state === "online" ? alreadyOnline() : noItem();
      },
    );
  });

  // Store the preview picture. 204 once it is stored.
  app.put("/api/v1/media/:id/preview", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null) return noItem();
    if (item.state === "online") return alreadyOnline();
    const data = await readCapped(c.req.raw, PREVIEW_RULE.maxBytes);
    if (data === "too_large") return apiError(413, "too_large", `the preview is over ${PREVIEW_RULE.maxBytes} bytes`);
    const checked = checkImage(data, PREVIEW_RULE);
    if (!checked.ok) return apiError(400, "bad_image", `preview: ${checked.error}`);
    const type = checked.info.type;
    const limit = await hitLimit(deps, LIMITS_MEDIA.preview, await workspaceKey(auth.workspaceId));
    if (limit.over) return tooMany(LIMITS_MEDIA.preview, "sent previews", limit.retryAfterSeconds);

    // The claim row is written in one statement with the allowance: its size counts as used
    // from here on (src/usage.ts counts every preview claim), and it is let in when what is
    // used, less the preview it would replace, plus its size is within the allowance.
    // Parameters, in the order they stand in the text: the row's four values; the item and
    // its conditions; the size once more; the workspace id of USED_SQL; ALLOWANCE_OF_SQL's three.
    return storeClaim(
      deps,
      auth,
      item,
      { n: PREVIEW, ext: type, bytes: data.byteLength, data, contentType: PREVIEW_TYPE[type] },
      (token, now) => ({
        sql: `INSERT INTO media_object (media_id, n, claim, ext, bytes, claimed_at, current)
              SELECT id, -1, ?, ?, ?, ?, 0 FROM media WHERE id = ? AND ${OPEN_ITEM} AND ${FEW_LOOSE}
                AND (SELECT r.allowance IS NULL
                            OR r.used - coalesce((SELECT o.bytes FROM media_object o WHERE o.media_id = media.id AND o.n = -1 AND o.current = 1), 0) + ? <= r.allowance
                       FROM (SELECT ${USED_SQL} AS used, ${ALLOWANCE_OF_SQL} AS allowance) r)`,
        params: [token, type, data.byteLength, now, item.id, auth.workspaceId, now - MEDIA_MAX_AGE_MS, data.byteLength, auth.workspaceId, ...allowanceParams(deps, auth.workspaceId)],
      }),
      async () => {
        const now = await loadItem(deps, auth, item.id);
        if (now === null) return noItem();
        if (now.state === "online") return alreadyOnline();
        const usage = await usageOf(deps, auth.workspaceId);
        return storageFull(usage, Math.max(0, data.byteLength - (now.preview_bytes ?? 0)), "preview");
      },
      async (now) => {
        const usage = await usageOf(deps, auth.workspaceId);
        const needed = Math.max(0, data.byteLength - (now.preview_bytes ?? 0));
        return usage.allowance !== null && usage.used + needed > usage.allowance ? storageFull(usage, needed, "preview") : null;
      },
    );
  });

  // Put the item online. 200 {id, link_id, kind, path, link}, the same again when repeated.
  app.post("/api/v1/media/:id/commit", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null) return noItem();
    if (item.state === "online") return json(200, committedOut(deps, item));
    const incomplete = (detail: string) => apiError(409, "incomplete", detail);
    const rows = await deps.db.all<{ n: number; bytes: number }>(
      "SELECT o.n, o.bytes FROM media_object o JOIN media m ON m.id = o.media_id WHERE o.media_id = ? AND m.workspace_id = ? AND o.current = 1 AND o.n >= 0",
      [item.id, auth.workspaceId],
    );
    const stored = new Map(rows.map((r) => [r.n, r.bytes]));
    for (let n = 0; n < item.parts; n++) if (!stored.has(n)) return incomplete(`part ${n} has not been sent, or is still being sent`);
    let sum = 0;
    for (let n = 0; n < item.parts; n++) sum += stored.get(n) ?? 0;
    if (sum !== item.bytes) return incomplete(`the parts add up to ${sum} bytes, not the ${item.bytes} declared`);

    // Only while the item is uploading and within its age, every part has a current stored
    // claim, and those add up to the declared bytes: checked again in the statement itself.
    // A send still under way after this lands under its own key, finds the item online, and
    // removes its own object: what the item serves stays as committed.
    const done = await deps.db.run(
      `UPDATE media SET state = 'online', online_at = ?
        WHERE id = ? AND ${OPEN_ITEM}
          AND (SELECT count(*) FROM media_object o WHERE o.media_id = media.id AND o.current = 1 AND o.n BETWEEN 0 AND media.parts - 1) = media.parts
          AND (SELECT coalesce(sum(o.bytes), 0) FROM media_object o WHERE o.media_id = media.id AND o.current = 1 AND o.n >= 0) = media.bytes`,
      [deps.now(), item.id, auth.workspaceId, deps.now() - MEDIA_MAX_AGE_MS],
    );
    const now = await loadItem(deps, auth, item.id);
    if (now === null) return noItem();
    if (now.state === "online") {
      // An online item keeps no claim that is not current and older than its lifetime, nor
      // one that was replaced: they go now (housekeeping; a failure leaves them to the
      // sweep). A send still under way removes its own when it finds the item online.
      try {
        await pruneClaims(deps, auth.workspaceId, item.id);
      } catch {
        console.error("media: could not remove replaced files of a finished item; the sweep removes them");
      }
      return json(200, committedOut(deps, now));
    }
    if (done.changes === 0) return incomplete("a part was being sent again while finishing; finish it once more");
    return json(200, committedOut(deps, now));
  });

  // Delete an item in any state. 204 once nothing of it is left; 500 cleanup_pending when it
  // is deleted but some of its files are still to go (a store that failed, or a send still
  // under way that may yet write one): send it again.
  app.delete("/api/v1/media/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    if (!ITEM_ID.test(id)) return noItem();
    const item = await deps.db.first<{ id: string; state: string }>("SELECT id, state FROM media WHERE id = ? AND workspace_id = ?", [id, auth.workspaceId]);
    if (item === null) return noItem();
    // Closing first: from here on nothing can change it, and no request finds it. Its bytes
    // count until its row goes, which removeClosing does with its last object.
    if (item.state !== "closing") await deps.db.run("UPDATE media SET state = 'closing' WHERE id = ? AND workspace_id = ?", [item.id, auth.workspaceId]);
    const pending = () => apiError(500, "cleanup_pending", "the item is deleted, but some of its files could not be removed yet; delete it again to retry");
    let gone: boolean;
    try {
      // When a send still holds a young claim, the row stays (closing, and counted) until
      // that send's own clean-up, a later delete or a sweep: the item is deleted for everyone already.
      gone = await removeClosing(deps, auth.workspaceId, item.id);
    } catch {
      console.error("delete: could not remove some files of a deleted item; the next delete call retries");
      return pending();
    }
    return gone ? noContent() : pending();
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
    const after = cursor === null ? "" : " AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))";
    const rows = await deps.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM media m WHERE m.workspace_id = ? AND m.kind = ? AND m.state = 'online'${after} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      [auth.workspaceId, kind, ...(cursor === null ? [] : [cursor.createdAt, cursor.createdAt, cursor.id]), LIST_PAGE + 1],
    );
    const page = rows.slice(0, LIST_PAGE);
    const last = page.at(-1);
    const next = rows.length > LIST_PAGE && last !== undefined ? encodeCursor(last.created_at, last.id) : null;
    return json(200, { items: page.map((r) => itemOut(deps, r)), next });
  });

  // One item, unless it is closing or was left unfinished past its age.
  app.get("/api/v1/media/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null) return noItem();
    return json(200, { ...itemOut(deps, item), state: item.state });
  });

  // The preview picture, to its own workspace only.
  app.get("/api/v1/media/:id/preview", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const item = await loadItem(deps, auth, c.req.param("id"));
    if (item === null) return noItem();
    if (item.preview_type === null || item.preview_claim === null) return apiError(404, "not_found", "this item has no preview");
    const file = await deps.drafts.get(objectKey(item.id, { n: PREVIEW, claim: item.preview_claim, ext: item.preview_type }));
    if (file === null) return apiError(404, "not_found", "this item has no preview");
    return new Response(file.body, { status: 200, headers: previewHeaders(item.preview_type, file.size) });
  });
}
