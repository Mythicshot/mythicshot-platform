import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkKey, type FileStore, type StoredFile } from "../ports.ts";

const META_SUFFIX = ".meta.json";

type Meta = { contentType: string; cacheControl: string | null; size: number };

/**
 * Resolves `key` against `root` and refuses any path that does not stay strictly
 * inside it. This is the second line of defence: callers run checkKey first.
 */
export function resolveInside(root: string, key: string): string {
  const base = resolve(root);
  const full = resolve(base, key);
  const rel = relative(base, full);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("bad key");
  return full;
}

/** A key may never name another object's metadata file. */
function checkStoreKey(key: string): void {
  checkKey(key);
  if (key.endsWith(META_SUFFIX)) throw new Error("bad key");
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT" || (err as NodeJS.ErrnoException)?.code === "ENOTDIR";
}

/**
 * `FileStore` on one folder. Each object is a file plus `<file>.meta.json` beside it.
 * Writes go to a temporary name (with a `~`, which no key can contain) and are
 * renamed into place.
 */
export class NodeFileStore implements FileStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    checkStoreKey(key);
    return resolveInside(this.root, key);
  }

  async put(key: string, body: Uint8Array, meta: { contentType: string; cacheControl?: string }): Promise<void> {
    const file = this.path(key);
    await mkdir(resolve(file, ".."), { recursive: true });
    const record: Meta = { contentType: meta.contentType, cacheControl: meta.cacheControl ?? null, size: body.byteLength };
    const tag = `~tmp-${randomBytes(6).toString("hex")}`;
    const tmpFile = `${file}${tag}`;
    const tmpMeta = `${file}${META_SUFFIX}${tag}`;
    try {
      await writeFile(tmpFile, body);
      await writeFile(tmpMeta, JSON.stringify(record));
      await rename(tmpMeta, file + META_SUFFIX);
      await rename(tmpFile, file);
    } catch (err) {
      await rm(tmpFile, { force: true });
      await rm(tmpMeta, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<StoredFile | null> {
    checkKey(key);
    if (key.endsWith(META_SUFFIX)) return null;
    const file = resolveInside(this.root, key);
    let meta: Meta;
    let bytes: Buffer;
    try {
      meta = JSON.parse(await readFile(file + META_SUFFIX, "utf8")) as Meta;
      bytes = await readFile(file);
    } catch (err) {
      if (isMissing(err) || (err as NodeJS.ErrnoException)?.code === "EISDIR") return null;
      throw err;
    }
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    return { body, size: data.byteLength, contentType: meta.contentType, cacheControl: meta.cacheControl };
  }

  async delete(keys: string[]): Promise<void> {
    // Check every key before deleting any.
    const files = keys.map((k) => this.path(k));
    for (const file of files) {
      for (const p of [file, file + META_SUFFIX]) {
        try {
          await unlink(p);
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      }
    }
  }

  /** Every stored key, for tests and the harness. Not part of `FileStore`. */
  async keys(): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return out;
      throw err;
    }
    for (const e of entries) {
      if (!e.isFile() || e.name.endsWith(META_SUFFIX) || e.name.includes("~")) continue;
      out.push(relative(this.root, join(e.parentPath, e.name)).split(sep).join("/"));
    }
    return out.sort();
  }
}
