// What a workspace uses against its storage allowance, and the allowance itself.
//
// Counted, from sizes the site records, in one statement for one workspace:
// - the bytes of every step of its tours (a draft picture a step uses, published or not);
// - the recorded size of each tour's logo (null, counted as nothing, for a logo stored
//   before the size was recorded);
// - what each open upload reserved at create: one that is not closing and was created
//   within UPLOAD_MAX_AGE_MS, the same uploads the open-upload cap counts.
// Not counted: published copies (no size is recorded for them), pictures a replace took
// out and files of a deleted tour that still wait to be cleaned up, uploads that are
// closing or older than that, and upload_step.bytes (the reservation already holds the
// declared bytes). Two steps that reuse one stored picture count twice.
//
// Nothing here refuses or deletes anything: this file only says how much is used.
import type { Manifest } from "./manifest.ts";
import type { Deps } from "./ports.ts";
import { LOGO_RULE } from "./sniff.ts";
import { UPLOAD_MAX_AGE_MS } from "./uploads.ts";

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
// as p.ws and the oldest created_at an open upload may have as p.floor. Both USED_SQL and
// usageOf are built from these, so the number a create is held against is the number shown.
const PICTURES = "(SELECT coalesce(sum(s.bytes), 0) FROM tour t JOIN step s ON s.tour_id = t.id WHERE t.workspace_id = p.ws)";
const LOGOS = "(SELECT coalesce(sum(t.logo_bytes), 0) FROM tour t WHERE t.workspace_id = p.ws)";
const UPLOADS = "(SELECT coalesce(sum(u.reserved_bytes), 0) FROM upload u WHERE u.workspace_id = p.ws AND u.closing_at IS NULL AND u.created_at >= p.floor)";
const PARAMS = "(SELECT ? AS ws, ? AS floor) p";

/**
 * The bytes a workspace uses, as a scalar subquery for use inside another statement. It
 * takes two parameters, in this order: the workspace id, and the 24-hour floor
 * (`deps.now() - UPLOAD_MAX_AGE_MS`). It is 0, never null, for a workspace with nothing.
 */
export const USED_SQL = `(SELECT ${PICTURES} + ${LOGOS} + ${UPLOADS} FROM ${PARAMS})`;

/**
 * The allowance of the row of `workspace` in scope: its own number, else the one
 * parameter this takes, the site's default (`deps.config.storageAllowanceBytes ?? null`).
 * Null means no limit.
 */
export const ALLOWANCE_SQL = "coalesce(workspace.storage_allowance_bytes, ?)";

/**
 * `used` is pictures + logos + uploads. `allowance` is null when there is no limit, and
 * `over` is true only when there is one and more than it is used: exactly the allowance
 * is not over it.
 */
export type Usage = { pictures: number; logos: number; uploads: number; used: number; allowance: number | null; over: boolean; tours: number };

/** The usage of one workspace and the allowance it is held against, in one database call. */
export async function usageOf(deps: Deps, workspaceId: string): Promise<Usage> {
  const row = await deps.db.first<{ pictures: number; logos: number; uploads: number; tours: number; allowance: number | null }>(
    `SELECT ${PICTURES} AS pictures, ${LOGOS} AS logos, ${UPLOADS} AS uploads,
            (SELECT count(*) FROM tour t WHERE t.workspace_id = p.ws) AS tours,
            (SELECT ${ALLOWANCE_SQL} FROM workspace WHERE workspace.id = p.ws) AS allowance
       FROM ${PARAMS}`,
    // In the order the placeholders stand in the text: the default, then the row p.
    [deps.config.storageAllowanceBytes ?? null, workspaceId, deps.now() - UPLOAD_MAX_AGE_MS],
  );
  const { pictures, logos, uploads, tours, allowance } = row!;
  const used = pictures + logos + uploads;
  return { pictures, logos, uploads, used, allowance, over: allowance !== null && used > allowance, tours };
}

/**
 * What an upload reserves at create: the declared bytes of all its steps, plus the most a
 * logo may weigh when the upload takes a logo and its manifest names one (a logo's size
 * is not declared, so the room for the largest is held until commit records the real one).
 */
export function reservedFor(m: Manifest, takesLogo: boolean): number {
  let bytes = 0;
  for (const step of m.steps) bytes += step.bytes;
  if (takesLogo && m.cover?.logo) bytes += LOGO_RULE.maxBytes;
  return bytes;
}

const UNITS = ["KB", "MB", "GB"] as const;

/**
 * A size for a person to read: 1024-based, three significant digits (`0 bytes`,
 * `512 KB`, `14.2 MB`, `1.02 GB`). Under 1024 it is the exact number of bytes; GB is the
 * largest unit, so a larger size is a longer number of GB.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return n === 1 ? "1 byte" : `${n} bytes`;
  let value = n;
  for (const [i, unit] of UNITS.entries()) {
    value /= 1024;
    const text = value < 9.995 ? value.toFixed(2) : value < 99.95 ? value.toFixed(1) : String(Math.round(value));
    // 1023.5 KB and up would read "1024 KB": that is 1.00 of the next unit.
    if (Number(text) < 1024 || i === UNITS.length - 1) return `${text} ${unit}`;
  }
  return `${n} bytes`;
}
