// The admin command's two file tools (0.1.71), for the move of the files between the data
// folder and R2 (src/node/admin.ts runs them):
// - r2Probe: write one small file to a bucket under a key no real file can have, read it
//   back, compare bytes and metadata, delete it and check that it is gone.
// - mirror: make one store hold exactly what another holds, every file with its content
//   type and cache control, each copy read back and compared by size and SHA-256; a file
//   already the same at the destination is left alone, and a file the source does not hold
//   is removed from the destination, so running it again changes nothing. Counts only.
// They take stores, never settings, and say nothing themselves: the command prints fixed
// lines from what they return. Nothing here ever holds a key's secret.
import { createHash, randomBytes } from "node:crypto";
import { checkKey, type FileStore, type StoredFile } from "../ports.ts";
import type { ListableStore } from "./file-stores.ts";
import { R2Error, REASONS } from "./r2-files.ts";

/** The words for why a step failed: the R2 store's fixed reason, else a fixed line. Never an error's own text. */
export function reasonWords(err: unknown): string {
  if (err instanceof R2Error) return REASONS[err.reason];
  if (err instanceof Error && err.message === "bad key") return "a key the store does not take";
  return "an unexpected error";
}

async function bytesOf(file: StoredFile): Promise<Uint8Array> {
  return new Uint8Array(await new Response(file.body).arrayBuffer());
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The prefix of the probe's key: no file the app stores starts with it (its keys start u/, v/, m/ or p/). */
export const PROBE_PREFIX = "r2-check/";

export type ProbeStep = "write" | "read back" | "compare" | "delete" | "check it is gone";
export type ProbeResult = { ok: true } | { ok: false; step: ProbeStep; reason: string };

/** Writes, reads back, compares, deletes and looks again for one probe file in `store`. */
export async function r2Probe(store: FileStore): Promise<ProbeResult> {
  const key = `${PROBE_PREFIX}probe-${randomBytes(16).toString("hex")}.txt`;
  checkKey(key);
  const body = new TextEncoder().encode(`demo-platform r2-check ${randomBytes(8).toString("hex")}\n`);
  const meta = { contentType: "text/plain", cacheControl: "private, max-age=0" };
  let step: ProbeStep = "write";
  let written = false;
  try {
    await store.put(key, body, meta);
    written = true;
    step = "read back";
    const got = await store.get(key);
    if (got === null) return await failedAfter(store, key, written, "read back", "the file just written was not there");
    const bytes = await bytesOf(got);
    step = "compare";
    const same = got.size === body.byteLength && bytes.byteLength === body.byteLength && sha256(bytes) === sha256(body) && got.contentType === meta.contentType && got.cacheControl === meta.cacheControl;
    if (!same) return await failedAfter(store, key, written, "compare", "the file read back was not the one written, or lost its content type or cache control");
    step = "delete";
    await store.delete([key]);
    written = false;
    step = "check it is gone";
    if ((await store.get(key)) !== null) return { ok: false, step, reason: "the file was still there after it was deleted" };
    return { ok: true };
  } catch (err) {
    return await failedAfter(store, key, written, step, reasonWords(err));
  }
}

/** A failed probe, after one try to remove a probe file that was written. */
async function failedAfter(store: FileStore, key: string, written: boolean, step: ProbeStep, reason: string): Promise<ProbeResult> {
  if (written) await store.delete([key]).catch(() => {});
  return { ok: false, step, reason };
}

export type MirrorCounts = { copied: number; already: number; removed: number; failed: number; listed: boolean; listReason: string | null };

/** How many keys one delete call is given while removing what the source does not hold. */
const REMOVE_BATCH = 1000;

/**
 * Makes `to` hold exactly what `from` holds. With `dryRun` nothing is written or removed, and
 * `copied` and `removed` count what would be. A file that cannot be read, copied, checked or
 * removed counts as failed and the run goes on; a store that cannot be listed stops this pair
 * with `listed` false and nothing changed.
 */
export async function mirror(from: ListableStore, to: ListableStore, dryRun: boolean): Promise<MirrorCounts> {
  const counts: MirrorCounts = { copied: 0, already: 0, removed: 0, failed: 0, listed: true, listReason: null };
  let sourceKeys: string[];
  let destKeys: Set<string>;
  try {
    sourceKeys = await from.keys();
    destKeys = new Set(await to.keys());
  } catch (err) {
    return { ...counts, listed: false, listReason: reasonWords(err) };
  }
  const held = new Set(sourceKeys);
  for (const key of sourceKeys) {
    try {
      checkKey(key);
      const src = await from.get(key);
      if (src === null) {
        counts.failed++;
        continue;
      }
      const bytes = await bytesOf(src);
      if (bytes.byteLength !== src.size) {
        counts.failed++;
        continue;
      }
      const digest = sha256(bytes);
      if (destKeys.has(key)) {
        const dst = await to.get(key);
        if (dst !== null) {
          const there = await bytesOf(dst);
          if (dst.size === src.size && there.byteLength === src.size && sha256(there) === digest && dst.contentType === src.contentType && dst.cacheControl === src.cacheControl) {
            counts.already++;
            continue;
          }
        }
      }
      if (dryRun) {
        counts.copied++;
        continue;
      }
      await to.put(key, bytes, src.cacheControl === null ? { contentType: src.contentType } : { contentType: src.contentType, cacheControl: src.cacheControl });
      const check = await to.get(key);
      const back = check === null ? null : await bytesOf(check);
      if (check === null || back === null || check.size !== src.size || back.byteLength !== src.size || sha256(back) !== digest) {
        counts.failed++;
        continue;
      }
      counts.copied++;
    } catch {
      counts.failed++;
    }
  }
  const extra = [...destKeys].filter((k) => !held.has(k));
  if (dryRun) {
    counts.removed += extra.length;
    return counts;
  }
  for (let i = 0; i < extra.length; i += REMOVE_BATCH) {
    const batch = extra.slice(i, i + REMOVE_BATCH);
    try {
      await to.delete(batch);
      counts.removed += batch.length;
    } catch {
      // One by one, so each key that cannot go is counted, and the others still go.
      for (const key of batch) {
        try {
          await to.delete([key]);
          counts.removed++;
        } catch {
          counts.failed++;
        }
      }
    }
  }
  return counts;
}
