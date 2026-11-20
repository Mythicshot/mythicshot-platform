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
/** The most pixels a setting may allow a shared image on a side: what a GIF's or JPEG's header can say. */
const MAX_SIDE_SETTING = 65_535;

/**
 * What is wrong with a deployment's limit settings for shared items (the Config fields of
 * the same names), as one fixed line, or null. A size must be a whole number of bytes from
 * 1 that needs at most MAX_PARTS parts, and a side a whole number of pixels from 1 to
 * 65,535. The entries refuse to serve with a problem (the Node server does not start, the
 * Worker answers misconfigured), so no request meets one.
 */
export function mediaLimitsProblem(config: { mediaImageMaxBytes?: number; mediaImageMaxSide?: number; mediaClipMaxBytes?: number }): string | null {
  const most = MAX_PARTS * PART_BYTES;
  const size = (v: number | undefined) => v === undefined || (Number.isSafeInteger(v) && v >= 1 && v <= most);
  if (!size(config.mediaImageMaxBytes) || !size(config.mediaClipMaxBytes)) {
    return `media settings: the most bytes of a shared image or clip must be a whole number from 1 to ${most} (${MAX_PARTS} parts of ${PART_BYTES} bytes)`;
  }
  const side = config.mediaImageMaxSide;
  if (side !== undefined && !(Number.isSafeInteger(side) && side >= 1 && side <= MAX_SIDE_SETTING)) {
    return `media settings: the most pixels of a shared image on a side must be a whole number from 1 to ${MAX_SIDE_SETTING}`;
  }
  return null;
}
