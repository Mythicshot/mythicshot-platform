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
// Not counted: published copies (no size is recorded for them), pictures a replace took
// out and files of a deleted tour that still wait to be cleaned up, uploads that are
// closing, and upload_step.bytes (the reservation already holds the declared bytes). Two
// steps that reuse one stored picture count twice.
//
// Nothing here deletes anything. The one refusal is made by the statement that creates an
// upload (src/uploads.ts), built from USED_SQL and ALLOWANCE_OF_SQL; this file words its
// answer (storageFull) and serves a workspace its own numbers (GET /api/v1/usage)
// and its largest tours (GET /api/v1/usage/largest).
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

// The three sums, each a scalar subquery over the row `p`, which holds the workspace id
// as p.ws. Both USED_SQL and usageOf are built from these, so the number a create is held
// against is the number shown.
const PICTURES = "(SELECT coalesce(sum(s.bytes), 0) FROM tour t JOIN step s ON s.tour_id = t.id WHERE t.workspace_id = p.ws)";
const LOGOS = "(SELECT coalesce(sum(t.logo_bytes), 0) FROM tour t WHERE t.workspace_id = p.ws)";
const UPLOADS = "(SELECT coalesce(sum(u.reserved_bytes), 0) FROM upload u WHERE u.workspace_id = p.ws AND u.closing_at IS NULL)";
const TOURS = "(SELECT count(*) FROM tour t WHERE t.workspace_id = p.ws)";

/**
 * The size of one tour in bytes, as a scalar expression over the row `t` of `tour` in
 * scope: the bytes of its steps and the recorded size of its logo (null counts as
 * nothing). It is PICTURES and LOGOS for one tour, so over a workspace's tours these sizes
 * add up to exactly the usage's pictures plus logos; the usage's used_bytes is that plus
 * the room open uploads hold, which belongs to no tour yet. Like the usage, it counts no
 * published copy and no file that waits to be cleaned up. It takes no parameter.
 */
export const TOUR_BYTES_SQL = "((SELECT coalesce(sum(s.bytes), 0) FROM step s WHERE s.tour_id = t.id) + coalesce(t.logo_bytes, 0))";

/** How many tours GET /api/v1/usage/largest answers. */
export const LARGEST_TOURS = 10;

const PARAMS = "(SELECT ? AS ws) p";

/**
 * The three sums and the tour count as the columns `pictures`, `logos`, `uploads` and
 * `tours`, for a SELECT whose FROM has a row `p` that holds the workspace id as p.ws. It
 * takes no parameter. usageOf reads one workspace's numbers with it, and the admin's list
 * of accounts reads every workspace's with it (src/admin-api.ts), so the two can never
 * disagree.
 */
export const USAGE_COLUMNS = `${PICTURES} AS pictures, ${LOGOS} AS logos, ${UPLOADS} AS uploads, ${TOURS} AS tours`;

/**
 * The bytes a workspace uses, as a scalar subquery for use inside another statement. It
 * takes one parameter: the workspace id. It is 0, never null, for a workspace with nothing.
 */
export const USED_SQL = `(SELECT ${PICTURES} + ${LOGOS} + ${UPLOADS} FROM ${PARAMS})`;

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
 * `used` is pictures + logos + uploads. `allowance` is null when there is no limit, and
 * `over` is true only when there is one and more than it is used: exactly the allowance
 * is not over it.
 */
export type Usage = { pictures: number; logos: number; uploads: number; used: number; allowance: number | null; over: boolean; tours: number };

/** The numbers a row read with USAGE_COLUMNS and the allowance hold, as a Usage. usageOf and the admin's list both make theirs here. */
export function usageFromRow(row: { pictures: number; logos: number; uploads: number; tours: number; allowance: number | null }): Usage {
  const { pictures, logos, uploads, tours, allowance } = row;
  const used = pictures + logos + uploads;
  return { pictures, logos, uploads, used, allowance, over: allowance !== null && used > allowance, tours };
}

/** The usage of one workspace and the allowance it is held against, in one database call. */
export async function usageOf(deps: Deps, workspaceId: string): Promise<Usage> {
  const site = deps.config.storageAllowanceBytes ?? null;
  const row = await deps.db.first<{ pictures: number; logos: number; uploads: number; tours: number; allowance: number | null }>(
    `SELECT ${USAGE_COLUMNS},
            coalesce((SELECT ${ALLOWANCE_SQL} FROM workspace WHERE workspace.id = p.ws), ?) AS allowance
       FROM ${PARAMS}`,
    // In the order the placeholders stand in the text: the site's default twice (for a
    // workspace without a number of its own, and for an id no workspace has), then the row p.
    [site, site, workspaceId],
  );
  return usageFromRow(row!);
}

/**
 * The answer to a create that would take the workspace over its allowance: 413 with the
 * code storage_full, the three numbers in bytes, and one sentence a client can show as it
 * is. The sentence continues "Could not start the upload: " and is closed by the client,
 * so it starts in lower case and ends without a full stop; with the longest sizes there
 * are it stays under 200 characters. It says how much the upload needs (for a replace:
 * how much the chapter grows), how much of the allowance is left, that nothing was
 * uploaded, and what makes room. The site itself never deletes anything to make room.
 */
export function storageFull(u: Usage, needed: number): Response {
  const allowance = u.allowance ?? 0;
  const left = Math.max(0, allowance - u.used);
  const sizes = roomSizes(needed, left);
  const detail = `this tour needs ${sizes.needed} of room, but the workspace has ${sizes.left} left of its ${formatBytes(allowance)} allowance. Nothing was uploaded. Delete tours you no longer need, or ask the site's admin for more room`;
  return json(413, { error: "storage_full", detail, used_bytes: u.used, allowance_bytes: allowance, needed_bytes: needed });
}

/** GET /api/v1/usage: what the caller's own workspace uses, and its allowance. It only reads. */
export function usageRoutes(app: Hono, deps: Deps): void {
  app.get("/api/v1/usage", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    // The workspace is the caller's own, from the credential: nothing in the request names one.
    const u = await usageOf(deps, auth.workspaceId);
    return json(200, {
      used_bytes: u.used,
      allowance_bytes: u.allowance,
      over: u.over,
      tours: u.tours,
      counted: { pictures: u.pictures, logos: u.logos, uploads_in_progress: u.uploads },
    });
  });
  /**
   * GET /api/v1/usage/largest: the LARGEST_TOURS largest tours of the caller's own
   * workspace, each with its id, title and size (TOUR_BYTES_SQL), largest first; tours of
   * the same size in the order of their ids. One statement, whatever the number of tours.
   * It only reads.
   */
  app.get("/api/v1/usage/largest", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const rows = await deps.db.all<{ id: string; title: string; bytes: number }>(
      `SELECT t.id, t.title, ${TOUR_BYTES_SQL} AS bytes FROM tour t WHERE t.workspace_id = ? ORDER BY bytes DESC, t.id LIMIT ?`,
      [auth.workspaceId, LARGEST_TOURS],
    );
    return json(200, { tours: rows.map((r) => ({ id: r.id, title: r.title, bytes: r.bytes })) });
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
 * is a longer number of GB. The account page's script (src/signin/page.ts) cannot import
 * this, so both are held to the one table in test/sizes.ts.
 */
export function formatBytes(n: number): string {
  // No caller passes a negative or non-finite size; if one did, it reads as nothing rather
  // than "-5 bytes" or "NaN GB". The account page's script has no such guard and is left as
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
