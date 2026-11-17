import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { checkKey, type FileStore, type StoredFile } from "../ports.ts";

/**
 * On-disk layout: each object is ONE file at `<root>/<h[0..2]>/<h>`, where `h` is the
 * SHA-256 hex of its key. The file is `MAGIC`, a 4-byte big-endian header length, a
 * JSON header `{ key, contentType, cacheControl }`, then the bytes.
 *
 * Hashed names mean no key can collide with a folder, another object's file, a
 * temporary file or a reserved device name, and no key can reach outside the root.
 * One file per object means a replace is one rename, so a reader never sees new
 * metadata beside old bytes.
 */
const MAGIC = Buffer.from("DPF1", "ascii");
const NAME = /^[0-9a-f]{64}$/;
const SHARD = /^[0-9a-f]{2}$/;

type Header = { key: string; contentType: string; cacheControl: string | null };

/**
 * The file path for `key`. Every path is `<root>/<2 hex>/<64 hex>`, whatever the key,
 * so a hostile key cannot name a path outside the root even if checkKey were bypassed.
 * The containment check below is a second line of defence that should never fire.
 */
export function objectPath(root: string, key: string): string {
  const base = resolve(root);
  const h = createHash("sha256").update(key, "utf8").digest("hex");
  const full = join(base, h.slice(0, 2), h);
  if (relative(base, full) !== `${h.slice(0, 2)}${sep}${h}`) throw new Error("bad key");
  return full;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** Windows refuses a rename onto a file another rename is replacing at that moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = errCode(err);
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      await new Promise((r) => setTimeout(r, 5 + attempt * 5));
    }
  }
}

function encode(header: Header, body: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.byteLength);
  return Buffer.concat([MAGIC, len, json, body]);
}

function decode(file: Buffer): { header: Header; body: Uint8Array } {
  if (file.byteLength < 8 || !file.subarray(0, 4).equals(MAGIC)) throw new Error("corrupt object file");
  const len = file.readUInt32BE(4);
  if (8 + len > file.byteLength) throw new Error("corrupt object file");
  const header = JSON.parse(file.subarray(8, 8 + len).toString("utf8")) as Header;
  const body = file.subarray(8 + len);
  return { header, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) };
}

/** `FileStore` on one folder, one file per object under a hashed name. */
export class NodeFileStore implements FileStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, body: Uint8Array, meta: { contentType: string; cacheControl?: string }): Promise<void> {
    checkKey(key);
    const file = objectPath(this.root, key);
    const dir = resolve(file, "..");
    await mkdir(dir, { recursive: true });
    const data = encode({ key, contentType: meta.contentType, cacheControl: meta.cacheControl ?? null }, body);
    // The temporary name is in the same folder, so the rename is atomic, and it is
    // not 64 hex characters, so it is never read as an object.
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const fh = await open(tmp, "wx");
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await renameWithRetry(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await syncDir(dir);
  }

  async get(key: string): Promise<StoredFile | null> {
    checkKey(key);
    let raw: Buffer;
    try {
      raw = await readFile(objectPath(this.root, key));
    } catch (err) {
      if (errCode(err) === "ENOENT") return null;
      throw err;
    }
    const { header, body } = decode(raw);
    if (header.key !== key) throw new Error("corrupt object file");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
    return { body: stream, size: body.byteLength, contentType: header.contentType, cacheControl: header.cacheControl };
  }

  async delete(keys: string[]): Promise<void> {
    // Check every key before deleting any.
    for (const k of keys) checkKey(k);
    for (const k of keys) {
      try {
        await unlink(objectPath(this.root, k));
      } catch (err) {
        if (errCode(err) !== "ENOENT") throw err;
      }
    }
  }

  /** Every stored key, read from the object headers. For tests and the harness only. */
  async keys(): Promise<string[]> {
    const out: string[] = [];
    let shards: string[];
    try {
      shards = await readdir(this.root);
    } catch (err) {
      if (errCode(err) === "ENOENT") return out;
      throw err;
    }
    for (const shard of shards.filter((s) => SHARD.test(s))) {
      for (const name of await readdir(join(this.root, shard))) {
        if (!NAME.test(name)) continue;
        out.push(decode(await readFile(join(this.root, shard, name))).header.key);
      }
    }
    return out.sort();
  }
}

/** Makes a rename durable on POSIX systems. Windows cannot open a folder for this. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
