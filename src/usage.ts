// What a workspace uses against its storage allowance, and the allowance itself.
//
// Counted, from sizes the site records, in one statement for one workspace:
// - the bytes of every step of its tours (a draft picture a step uses, published or not);
// - the recorded size of each tour's logo (null, counted as nothing, for a logo stored
//   before the size was recorded);
// - what each open upload reserved at create: every upload that is not closing, whatever
//   its age. An upload can be committed until it is swept, so it holds its room until
//   then; otherwise one that outlived the day could land on top of a newer one, past the
//   allowance.
// - every shared item (src/media.ts): the bytes its create declared, reserved from that
//   create on (they hold its current parts), and every other object it has a claim row
//   for: its current preview, and each claim that is not current (a send under way, a part
//   or preview it replaced that is not removed yet, a send that died). An item that is being
//   deleted or swept (closing) still counts until its row is removed, which happens only
//   with its last object: a delete that finishes frees the room at once, and one that was
//   cut off counts until it is retried.
//   GET /api/v1/usage gives this sum in two parts by the item's kind, images and GIFs
//   (clips), each with all of the above for its items in every state; an item still being
//   sent counts in its kind's part, never in uploads_in_progress, which stays the tours'
//   uploads alone.
// Not counted: published copies (no size is recorded for them), pictures a replace took
// out and files of a deleted tour that still wait to be cleaned up, uploads that are
// closing, and upload_step.bytes (the reservation already holds the declared bytes). Two
// steps that reuse one stored picture count twice.
//
// Nothing here deletes anything. The refusals are made by the statements that create an
// upload (src/uploads.ts) or an item (src/media.ts), or claim an item's preview, built
// from USED_SQL and ALLOWANCE_OF_SQL; this file words their
// answer (storageFull) and serves a workspace its own numbers (GET /api/v1/usage)
// and its largest tours, images and GIFs (GET /api/v1/usage/largest).
//
// This file imports no route module (src/uploads.ts imports it), so the settings, which
// read allowanceFromSetting, and the routes can load in either order.
import type { Hono } from "hono";
import { requireAuth } from "./auth.ts";
import { json } from "./http.ts";
import type { Manifest } from "./manifest.ts";
import type { Deps, Value } from "./ports.ts";
import { LOGO_RULE } from "./sniff.ts";

/** The line shown when STORAGE_ALLOWANCE_BYTES cannot be used. It never repeats the value. */
const BAD_SETTING = "STORAGE_ALLOWANCE_BYTES is not a number of bytes. Write digits only, such as 1073741824, or leave it out for no limit.";

/**
 * The site's default allowance from the STORAGE_ALLOWANCE_BYTES setting. Unset, empty or
 * only spaces is no limit (null). Otherwise it must be digits only, from 0 to
 * 9007199254740991, with nothing but spaces or a line end around them; 0 is a limit.
 * Anything else is a problem, never "no limit": a mistyped limit must not lift the limit.
 */
export function allowanceFromSetting(raw: string | undefined): { ok: true; bytes: number | null } | { ok: false; problem: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, bytes: null };
  if (!/^[0-9]+$/.test(text)) return { ok: false, problem: BAD_SETTING };
  const digits = text.replace(/^0+(?=[0-9])/, "");
  // 9007199254740991 has 16 digits; a longer number is past it, and is not parsed at all.
  if (digits.length > 16) return { ok: false, problem: BAD_SETTING };
  const bytes = Number(digits);
  if (!Number.isSafeInteger(bytes)) return { ok: false, problem: BAD_SETTING };
  return { ok: true, bytes };
}

// The four sums, each a scalar subquery over the row `p`, which holds the workspace id
// as p.ws. Both USED_SQL and usageOf are built from these, so the number a create is held
// against is the number shown. MEDIA and its two parts for the usage answer are one
// template (mediaBytes), which differs only in the kind it is held to; as the kind is image
// or clip and nothing else (migrations/0010_media.sql), the two parts add up to MEDIA, and
// test/usage.test.ts holds them to that.
const PICTURES = "(SELECT coalesce(sum(s.bytes), 0) FROM tour t JOIN step s ON s.tour_id = t.id WHERE t.workspace_id = p.ws)";
const LOGOS = "(SELECT coalesce(sum(t.logo_bytes), 0) FROM tour t WHERE t.workspace_id = p.ws)";
const UPLOADS = "(SELECT coalesce(sum(u.reserved_bytes), 0) FROM upload u WHERE u.workspace_id = p.ws AND u.closing_at IS NULL)";
/**
 * Which of an item's claim rows (`o`, of media_object) count beside its declared bytes:
 * every claim that is not current, and the current preview (n = -1). The current parts are
 * the declared bytes themselves.
 */
const COUNTED_OBJECT = "(o.current = 0 OR o.n = -1)";
/**
 * The bytes of a workspace's items in every state, closing too: their declared bytes and
 * their counted claim rows. With a kind, those of that kind's items alone.
 */
const mediaBytes = (kind?: "image" | "clip") => {
  const only = kind === undefined ? "" : ` AND m.kind = '${kind}'`;
  return `((SELECT coalesce(sum(m.bytes), 0) FROM media m WHERE m.workspace_id = p.ws${only}) + (SELECT coalesce(sum(o.bytes), 0) FROM media_object o JOIN media m ON m.id = o.media_id WHERE m.workspace_id = p.ws${only} AND ${COUNTED_OBJECT}))`;
};
const MEDIA = mediaBytes();
const TOURS = "(SELECT count(*) FROM tour t WHERE t.workspace_id = p.ws)";

/** How many items of one kind are online: an unfinished item and a closing one are not counted. */
const mediaCountOf = (kind: "image" | "clip") => `(SELECT count(*) FROM media m WHERE m.workspace_id = p.ws AND m.kind = '${kind}' AND m.state = 'online')`;

/**
 * The size of one tour in bytes, as a scalar expression over the row `t` of `tour` in
 * scope: the bytes of its steps and the recorded size of its logo (null counts as
 * nothing). It is PICTURES and LOGOS for one tour, so over a workspace's tours these sizes
 * add up to exactly the usage's pictures plus logos; the usage's used_bytes is that plus
 * the room open uploads hold, which belongs to no tour yet, plus the shared images and GIFs
 * (MEDIA). Like the usage, it counts no
 * published copy and no file that waits to be cleaned up. It takes no parameter.
 */
export const TOUR_BYTES_SQL = "((SELECT coalesce(sum(s.bytes), 0) FROM step s WHERE s.tour_id = t.id) + coalesce(t.logo_bytes, 0))";

/** How many tours GET /api/v1/usage/largest answers, and how many things of every kind. */
export const LARGEST_TOURS = 10;

/**
 * The size of one shared item in bytes, as a scalar expression over the row `m` of `media`
 * in scope: what deleting it frees, as MEDIA counts it for this item: its declared bytes and
 * its counted claim rows (its current preview and every claim that is not current).
 */
export const ITEM_BYTES_SQL = `(m.bytes + (SELECT coalesce(sum(o.bytes), 0) FROM media_object o WHERE o.media_id = m.id AND ${COUNTED_OBJECT}))`;

const PARAMS = "(SELECT ? AS ws) p";

/**
 * The sums and the counts as the columns `pictures`, `logos`, `uploads`, `image_bytes`,
 * `gif_bytes` (MEDIA in its two parts), `tours`, `images` and `gifs` (online items), for a
 * SELECT whose FROM has a row `p` that holds the workspace id as p.ws. It takes no parameter. usageOf reads one workspace's numbers with it, and the admin's list
 * of accounts reads every workspace's with it (src/admin-api.ts), so the two can never
 * disagree.
 */
export const USAGE_COLUMNS = `${PICTURES} AS pictures, ${LOGOS} AS logos, ${UPLOADS} AS uploads, ${mediaBytes("image")} AS image_bytes, ${mediaBytes("clip")} AS gif_bytes, ${TOURS} AS tours, ${mediaCountOf("image")} AS images, ${mediaCountOf("clip")} AS gifs`;

/**
 * The bytes a workspace uses, as a scalar subquery for use inside another statement. It
 * takes one parameter: the workspace id. It is 0, never null, for a workspace with nothing.
 */
export const USED_SQL = `(SELECT ${PICTURES} + ${LOGOS} + ${UPLOADS} + ${MEDIA} FROM ${PARAMS})`;

/**
 * The allowance of the row of `workspace` in scope: its own number, else the one
 * parameter this takes, the site's default (`deps.config.storageAllowanceBytes ?? null`).
 * Null means no limit. With no row in scope there is no value at all: use
 * ALLOWANCE_OF_SQL to ask by id.
 */
export const ALLOWANCE_SQL = "coalesce(workspace.storage_allowance_bytes, ?)";

/**
 * The allowance of a workspace by id, as a scalar expression for use inside another
 * statement: the workspace's own number, else the site's default, and the site's default
 * also when no workspace has that id, so a missing row never reads as "no limit" on a
 * site that has one. Its three parameters are allowanceParams(), in that order: the
 * default, the workspace id, the default again.
 */
export const ALLOWANCE_OF_SQL = `coalesce((SELECT ${ALLOWANCE_SQL} FROM workspace WHERE workspace.id = ?), ?)`;

/** The parameters of ALLOWANCE_OF_SQL for this workspace, in order. */
export function allowanceParams(deps: Deps, workspaceId: string): Value[] {
  const site = deps.config.storageAllowanceBytes ?? null;
  return [site, workspaceId, site];
}

/**
 * `media` is MEDIA, imageBytes + gifBytes: the shared items in every state with their
 * counted claim rows. `used` is pictures + logos + uploads + media. `allowance` is null when there is
 * no limit, and `over` is true only when there is one and more than it is used: exactly the
 * allowance is not over it. `tours` counts every tour; `images` and `gifs` count online
 * items only.
 */
export type Usage = {
  pictures: number;
  logos: number;
  uploads: number;
  media: number;
  imageBytes: number;
  gifBytes: number;
  used: number;
  allowance: number | null;
  over: boolean;
  tours: number;
  images: number;
  gifs: number;
};

/** A row read with USAGE_COLUMNS and the allowance. */
export type UsageRow = { pictures: number; logos: number; uploads: number; image_bytes: number; gif_bytes: number; tours: number; images: number; gifs: number; allowance: number | null };

/** The numbers a row read with USAGE_COLUMNS and the allowance hold, as a Usage. usageOf and the admin's list both make theirs here. */
export function usageFromRow(row: UsageRow): Usage {
  const { pictures, logos, uploads, tours, images, gifs, allowance } = row;
  const imageBytes = row.image_bytes;
  const gifBytes = row.gif_bytes;
  const media = imageBytes + gifBytes;
  const used = pictures + logos + uploads + media;
  return { pictures, logos, uploads, media, imageBytes, gifBytes, used, allowance, over: allowance !== null && used > allowance, tours, images, gifs };
}

/** The usage of one workspace and the allowance it is held against, in one database call. */
export async function usageOf(deps: Deps, workspaceId: string): Promise<Usage> {
  const site = deps.config.storageAllowanceBytes ?? null;
  const row = await deps.db.first<UsageRow>(
    `SELECT ${USAGE_COLUMNS},
            coalesce((SELECT ${ALLOWANCE_SQL} FROM workspace WHERE workspace.id = p.ws), ?) AS allowance
       FROM ${PARAMS}`,
    // In the order the placeholders stand in the text: the site's default twice (for a
    // workspace without a number of its own, and for an id no workspace has), then the row p.
    [site, site, workspaceId],
  );
  return usageFromRow(row!);
}

/** What an entry of GET /api/v1/usage/largest is: a tour, a shared image, or a shared clip, which people call a GIF. */
export type LargestKind = "tour" | "image" | "gif";

/** What a storage-full answer is about: a tour's upload, a shared image, a shared clip, or an item's preview picture. */
export type StorageFullOf = "tour" | "image" | "clip" | "preview";

/**
 * The answer to a create that would take the workspace over its allowance: 413 with the
 * code storage_full, the three numbers in bytes, and one sentence a client can show as it
 * is. The sentence continues "Could not start the upload: " and is closed by the client,
 * so it starts in lower case and ends without a full stop; with the longest sizes there
 * are it stays under 200 characters. It says how much the upload needs (for a replace:
 * how much the chapter grows), how much of the allowance is left, that nothing was
 * uploaded, and what makes room. The site itself never deletes anything to make room.
 *
 * `of` names what needs the room: a tour by default (that sentence is unchanged since it
 * was first written), "this image" or "this GIF" for a shared item of either kind (a clip
 * is a GIF or an MP4; people call both a GIF), "this preview" for an item's preview.
 */
export function storageFull(u: Usage, needed: number, of: StorageFullOf = "tour"): Response {
  const allowance = u.allowance ?? 0;
  const left = Math.max(0, allowance - u.used);
  const sizes = roomSizes(needed, left);
  const room = `needs ${sizes.needed} of room, but the workspace has ${sizes.left} left of its ${formatBytes(allowance)} allowance. Nothing was uploaded.`;
  const detail =
    of === "tour"
      ? `this tour ${room} Delete tours you no longer need, or ask the site's admin for more room`
      : `this ${of === "image" ? "image" : of === "clip" ? "GIF" : "preview"} ${room} Delete what you no longer need, or ask the site's admin for more room`;
  return json(413, { error: "storage_full", detail, used_bytes: u.used, allowance_bytes: allowance, needed_bytes: needed });
}

/** GET /api/v1/usage: what the caller's own workspace uses, and its allowance. It only reads. */
export function usageRoutes(app: Hono, deps: Deps): void {
  app.get("/api/v1/usage", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    // The workspace is the caller's own, from the credential: nothing in the request names one.
    const u = await usageOf(deps, auth.workspaceId);
    // Fields are only ever added: images and gifs beside tours, and the items' bytes in
    // counted, whose numbers add up to used_bytes.
    return json(200, {
      used_bytes: u.used,
      allowance_bytes: u.allowance,
      over: u.over,
      tours: u.tours,
      images: u.images,
      gifs: u.gifs,
      counted: { pictures: u.pictures, logos: u.logos, uploads_in_progress: u.uploads, images: u.imageBytes, gifs: u.gifBytes },
    });
  });
  /**
   * GET /api/v1/usage/largest: two lists of the caller's own workspace, each largest first,
   * things of the same size in the order of their ids:
   * - `tours`, as in the first version: the LARGEST_TOURS largest tours, each with its id,
   *   title and size (TOUR_BYTES_SQL);
   * - `largest`: the LARGEST_TOURS largest things of every kind, each a tour (`kind` "tour",
   *   sized as in `tours`) or a shared item that is online or still being sent (`kind`
   *   "image", or "gif" for a clip), sized by ITEM_BYTES_SQL: what deleting it frees. An
   *   item still being sent is listed, as it holds room and can be deleted; a closing one is
   *   not, as it is being deleted already (it counts in the usage until its files are gone).
   *   An item without a title has null.
   * One statement, whatever the number of tours and items. It only reads.
   */
  app.get("/api/v1/usage/largest", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    type Row = { list: "tours" | "largest"; kind: LargestKind; id: string; title: string | null; bytes: number };
    const rows = await deps.db.all<Row>(
      `WITH p AS (SELECT ? AS ws),
            tours AS (SELECT 'tour' AS kind, t.id AS id, t.title AS title, ${TOUR_BYTES_SQL} AS bytes FROM tour t, p WHERE t.workspace_id = p.ws),
            items AS (SELECT CASE m.kind WHEN 'image' THEN 'image' ELSE 'gif' END AS kind, m.id AS id, m.title AS title, ${ITEM_BYTES_SQL} AS bytes
                        FROM media m, p WHERE m.workspace_id = p.ws AND m.state <> 'closing')
       SELECT 'tours' AS list, kind, id, title, bytes FROM (SELECT kind, id, title, bytes FROM tours ORDER BY bytes DESC, id LIMIT ?)
       UNION ALL
       SELECT 'largest' AS list, kind, id, title, bytes FROM (SELECT kind, id, title, bytes FROM (SELECT kind, id, title, bytes FROM tours UNION ALL SELECT kind, id, title, bytes FROM items) ORDER BY bytes DESC, id LIMIT ?)`,
      [auth.workspaceId, LARGEST_TOURS, LARGEST_TOURS],
    );
    // A compound SELECT promises no order between or inside its parts, so each list is put
    // in its order again here; the subqueries chose which rows.
    const order = (a: Row, b: Row) => b.bytes - a.bytes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const of = (list: Row["list"]) => rows.filter((r) => r.list === list).sort(order);
    return json(200, {
      tours: of("tours").map((r) => ({ id: r.id, title: r.title, bytes: r.bytes })),
      largest: of("largest").map((r) => ({ kind: r.kind, id: r.id, title: r.title, bytes: r.bytes })),
    });
  });
}

/**
 * What an upload reserves at create: the declared bytes of all its steps and, when the
 * upload takes a logo and its manifest names one, room for the logo: `logoBytes` when the
 * create declared the logo's size, else the most a logo may weigh, held until commit
 * records the real size.
 */
export function reservedFor(m: Manifest, takesLogo: boolean, logoBytes: number | null = null): number {
  let bytes = 0;
  for (const step of m.steps) bytes += step.bytes;
  if (takesLogo && m.cover?.logo) bytes += logoBytes ?? LOGO_RULE.maxBytes;
  return bytes;
}

const UNITS = ["KB", "MB", "GB"] as const;

/**
 * A size for a person to read, written as the site's pages write it: under 1024 the exact
 * number of bytes (`0 bytes`, `1 byte`, `1023 bytes`); otherwise 1024 to the next unit,
 * at most one decimal and no trailing ".0" (`512 KB`, `14.2 MB`, `1.2 GB`, `5 GB`). A value
 * that rounds to 1024 of a unit is 1 of the next. GB is the largest unit, so a larger size
 * is a longer number of GB. The dashboard's shared script (src/dash/script.ts) cannot
 * import this, so both are held to the one table in test/sizes.ts.
 */
export function formatBytes(n: number): string {
  // No caller passes a negative or non-finite size; if one did, it reads as nothing rather
  // than "-5 bytes" or "NaN GB". The dashboard's script has no such guard and is left as
  // it is: it only ever shows numbers the API answered.
  if (!Number.isFinite(n) || n < 0) return "0 bytes";
  if (n < 1024) return n === 1 ? "1 byte" : `${n} bytes`;
  let value = n;
  for (const [i, unit] of UNITS.entries()) {
    value /= 1024;
    const rounded = Math.round(value * 10) / 10;
    if (rounded < 1024 || i === UNITS.length - 1) return `${rounded} ${unit}`;
  }
  return `${n} bytes`;
}

/** The most decimals roomSizes tries before it gives both sizes as exact bytes. */
const MAX_ROOM_DECIMALS = 12;

/**
 * A size written by formatBytes's rule (1024 to a unit, GB the largest, no trailing zeros),
 * but with `decimals` decimals and rounded the way given: "up" never shows less than the
 * size, "down" never more. Exact, in whole numbers, so no binary fraction tips a rounding.
 * Under 1024 it is the exact number of bytes. Rounding up to 1024 of a unit is 1 of the next.
 */
function directedBytes(n: number, way: "up" | "down", decimals: number): string {
  if (!Number.isSafeInteger(n) || n < 0) return "0 bytes";
  if (n < 1024) return n === 1 ? "1 byte" : `${n} bytes`;
  const scale = 10n ** BigInt(decimals);
  const scaled = BigInt(n) * scale;
  let unit = 1n;
  for (const [i, name] of UNITS.entries()) {
    unit *= 1024n;
    const q = way === "up" ? (scaled + unit - 1n) / unit : scaled / unit;
    if (q < 1024n * scale || i === UNITS.length - 1) {
      const whole = q / scale;
      const frac = (q % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
      return `${whole}${frac === "" ? "" : "." + frac} ${name}`;
    }
  }
  return `${n} bytes`;
}

/**
 * The two sizes of the storage-full sentence: the room needed rounded up and the room left
 * rounded down, so the sentence never understates the need or overstates what is left.
 * With one decimal first, and while the two would read the same, more decimals for both;
 * past MAX_ROOM_DECIMALS both are given as exact bytes. Whenever more is needed than is
 * left the two differ already at one decimal (a rounding up and a rounding down of two
 * different numbers in one unit cannot meet), so the loop only matters for equal or
 * smaller needs. Used for this sentence only; every other size is formatBytes.
 */
export function roomSizes(needed: number, left: number): { needed: string; left: string } {
  for (let decimals = 1; decimals <= MAX_ROOM_DECIMALS; decimals++) {
    const sizes = { needed: directedBytes(needed, "up", decimals), left: directedBytes(left, "down", decimals) };
    if (sizes.needed !== sizes.left) return sizes;
  }
  const exact = (n: number) => (n === 1 ? "1 byte" : `${n} bytes`);
  return { needed: exact(needed), left: exact(left) };
}
