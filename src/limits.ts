// Limits more than one module needs, kept in a module that imports nothing, so any file
// may import it whatever the order the modules load in.

/**
 * How long an upload may stay unfinished: one older than this no longer counts against the
 * open-upload cap and is swept by the workspace's next create.
 */
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
