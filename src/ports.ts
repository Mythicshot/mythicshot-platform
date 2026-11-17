// The two interfaces every route reaches data through. Nothing in this file, or in
// any file outside src/cloudflare/ and src/node/, may import a platform API.

export type Value = string | number | null;
export type Stmt = { sql: string; params?: Value[] };

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

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** Throws Error("bad key") unless the key matches the file key pattern. */
export function checkKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) throw new Error("bad key");
}

export type Config = {
  publicImageBase: string; // "" when the app serves published images itself, else an https origin
  setupCode: string | null; // null or shorter than 16 characters: setup is off
};

export type Deps = { db: Db; drafts: FileStore; pub: FileStore; config: Config; now: () => number };
