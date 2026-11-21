// Limits more than one module needs, kept in a module that imports nothing, so any file
// may import it whatever the order the modules load in.

/**
 * How long an upload may stay unfinished: one older than this no longer counts against the
 * open-upload cap and is swept by the workspace's next create.
 */
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The longest part of a shared item, and so the longest request body (src/media.ts). */
export const PART_BYTES = 2_000_000;
/** The most parts a shared item may have: the database's own cap (migration 0010). */
export const MAX_PARTS = 999;
/**
 * The most parts one answer of the public file route may read (src/media-page.ts): with
 * the lookup's two database calls (onlineItemFiles in src/media.ts) it fills the 40-call
 * budget of src/budget.ts exactly, so a whole item can always be sent in one answer.
 * Tests hold SERVE_LOOKUP_CALLS + MAX_SERVED_PARTS to SUBREQUEST_BUDGET.
 */
export const SERVE_LOOKUP_CALLS = 2;
export const MAX_SERVED_PARTS = 38;
/**
 * A restricted item (src/media-page.ts) makes three calls more before any part: the viewer
 * session (provedEmail), the check of its list (mayView), and the session's last use written
 * after the answer, at most once a day. So one of its answers reads at most this many parts,
 * and an item of more parts cannot be restricted (src/media-access.ts refuses it): its whole
 * file could not be sent within the budget. Tests hold the sum to SUBREQUEST_BUDGET.
 */
export const RESTRICTED_EXTRA_CALLS = 3;
export const RESTRICTED_SERVED_PARTS = MAX_SERVED_PARTS - RESTRICTED_EXTRA_CALLS;
/** The most pixels a setting may allow a shared image on a side: what a GIF's or JPEG's header can say. */
const MAX_SIDE_SETTING = 65_535;

/**
 * What is wrong with a deployment's limit settings for shared items (the Config fields of
 * the same names), as one fixed line, or null. A size must be a whole number of bytes from
 * 1 that needs at most MAX_SERVED_PARTS parts (fewer than the database's MAX_PARTS), so
 * the public file route can send a whole item within the call budget, and a side a whole
 * number of pixels from 1 to 65,535. The entries refuse to serve with a problem (the Node server does not start, the
 * Worker answers misconfigured), so no request meets one.
 */
export function mediaLimitsProblem(config: { mediaImageMaxBytes?: number; mediaImageMaxSide?: number; mediaClipMaxBytes?: number }): string | null {
  const parts = Math.min(MAX_PARTS, MAX_SERVED_PARTS);
  const most = parts * PART_BYTES;
  const size = (v: number | undefined) => v === undefined || (Number.isSafeInteger(v) && v >= 1 && v <= most);
  if (!size(config.mediaImageMaxBytes) || !size(config.mediaClipMaxBytes)) {
    return `media settings: the most bytes of a shared image or clip must be a whole number from 1 to ${most} (${parts} parts of ${PART_BYTES} bytes, which one answer can send within the call budget)`;
  }
  const side = config.mediaImageMaxSide;
  if (side !== undefined && !(Number.isSafeInteger(side) && side >= 1 && side <= MAX_SIDE_SETTING)) {
    return `media settings: the most pixels of a shared image on a side must be a whole number from 1 to ${MAX_SIDE_SETTING}`;
  }
  return null;
}
