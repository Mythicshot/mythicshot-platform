import { checkKey, type FileStore, type StoredFile } from "../ports.ts";

/** R2 deletes at most 1,000 keys per call. */
const DELETE_CHUNK = 1000;

/** `FileStore` on one R2 bucket, with content type and cache control as HTTP metadata. */
export class R2FileStore implements FileStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: Uint8Array, meta: { contentType: string; cacheControl?: string }): Promise<void> {
    checkKey(key);
    const httpMetadata: R2HTTPMetadata = { contentType: meta.contentType };
    if (meta.cacheControl !== undefined) httpMetadata.cacheControl = meta.cacheControl;
    await this.bucket.put(key, body, { httpMetadata });
  }

  async get(key: string): Promise<StoredFile | null> {
    checkKey(key);
    const obj = await this.bucket.get(key);
    if (obj === null) return null;
    return {
      body: obj.body,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      cacheControl: obj.httpMetadata?.cacheControl ?? null,
    };
  }

  async delete(keys: string[]): Promise<void> {
    // Check every key before deleting any.
    for (const k of keys) checkKey(k);
    for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
      await this.bucket.delete(keys.slice(i, i + DELETE_CHUNK));
    }
  }
}
