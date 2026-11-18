// The two interfaces every route reaches data through, and the rules both adapters
// share. Nothing in this file, or in any file outside src/cloudflare/ and src/node/,
// may import a platform API.

/**
 * A bound parameter. Both back ends bind every JS number as REAL, so a TEXT column
 * stores 5 as "5.0": bind a string for a TEXT column. Integral numbers outside
 * ±(2^53 - 1), NaN and infinities are refused.
 */
export type Value = string | number | null;
export type Stmt = { sql: string; params?: Value[] };

/**
 * Rows come back with TEXT as string, INTEGER and REAL as number, BLOB as Uint8Array
 * and NULL as null, on both back ends. A row holding an integral number outside
 * ±(2^53 - 1) is refused with Error("integer out of range") instead of rounded.
 */
export interface Db {
  all<T>(sql: string, params?: Value[]): Promise<T[]>;
  first<T>(sql: string, params?: Value[]): Promise<T | null>;
  run(sql: string, params?: Value[]): Promise<{ changes: number }>;
  /** Every statement commits, or none does. An empty list is a no-op. */
  batch(stmts: Stmt[]): Promise<void>;
}

export type StoredFile = { body: ReadableStream<Uint8Array>; size: number; contentType: string; cacheControl: string | null };

export interface FileStore {
  /** Replaces an existing key. Throws on a key that fails checkKey. */
  put(key: string, body: Uint8Array, meta: { contentType: string; cacheControl?: string }): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  /** Deletes exactly these keys. A key that is already gone is not an error. */
  delete(keys: string[]): Promise<void>;
}

/**
 * The longest key both stores accept, in bytes (R2 allows 1,024). Keys are ASCII, so
 * bytes equal characters.
 */
export const MAX_KEY_BYTES = 512;

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/**
 * Throws Error("bad key") unless the key matches the file key pattern and is at most
 * MAX_KEY_BYTES long. Both adapters accept exactly the keys this accepts.
 */
export function checkKey(key: string): void {
  if (typeof key !== "string" || key.length > MAX_KEY_BYTES || !KEY_PATTERN.test(key)) throw new Error("bad key");
}

/** Throws unless every parameter is one both back ends store without loss. */
export function checkParams(params: readonly Value[]): void {
  for (const v of params) {
    if (typeof v !== "number") continue;
    if (!Number.isFinite(v)) throw new Error("number out of range");
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error("integer out of range");
  }
}

/**
 * Brings one row to the shared shape: blobs (an array of bytes, an ArrayBuffer or a
 * Uint8Array) become a Uint8Array, and an integral number outside the safe range
 * throws rather than being passed on rounded.
 */
export function normalizeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "number") {
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error("integer out of range");
      out[k] = v;
    } else if (v instanceof Uint8Array) {
      out[k] = new Uint8Array(v);
    } else if (v instanceof ArrayBuffer) {
      out[k] = new Uint8Array(v.slice(0));
    } else if (Array.isArray(v)) {
      out[k] = Uint8Array.from(v as number[]);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** True when `err` is a UNIQUE or PRIMARY KEY constraint failure from either adapter. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/\bUNIQUE constraint failed\b/.test(e.message)) return true;
  }
  return false;
}

/** True when `err` is a NOT NULL constraint failure from either adapter. */
export function isNotNullViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/\bNOT NULL constraint failed\b/.test(e.message)) return true;
  }
  return false;
}

export type Config = {
  publicImageBase: string; // "" when the app serves published images itself, else an https origin
  setupCode: string | null; // null or shorter than 16 characters: setup is off
  /** Open (uncommitted, unexpired) uploads a workspace may have at once. Default 5. */
  maxOpenUploads?: number;
  /**
   * How long a published image a re-publish replaced stays served before it is deleted,
   * so a viewer still on the previous page keeps its images. Default 10 minutes.
   */
  retiredGraceMs?: number;
};

export type Deps = { db: Db; drafts: FileStore; pub: FileStore; config: Config; now: () => number };
