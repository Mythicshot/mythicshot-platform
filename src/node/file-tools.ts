// The admin command's file tools (0.1.71), for the move of the files between the data folder
// and R2 (src/node/admin.ts runs them):
// - r2Probe: write one small file to a bucket under a key no real file can have, read it
//   back, compare bytes and metadata, delete it and check that it is gone.
// - The role markers: one small object per bucket, ROLE_MARKER_KEY, whose text names the
//   bucket's role, so a bucket named in the wrong setting is found before anything is copied
//   or served (r2-check writes them; files-copy and the app's start check them).
// - listFor and mirror: make one store hold every file another holds, each with its content
//   type and cache control and each copy read back and compared by size and SHA-256; a file
//   already the same is left alone. A file at the destination that the source does not hold
//   is left in place and counted, and removed only when asked. An object file that can never
//   be copied is named, not a reason to stop the rest. Counts only.
// They take stores, never settings, and say nothing themselves: the command prints fixed
// lines from what they return. Nothing here ever holds a key's secret.
import { createHash, randomBytes } from "node:crypto";
import { checkKey, type FileStore, type StoredFile } from "../ports.ts";
import type { ListableStore } from "./file-stores.ts";
import { NodeFileStore } from "./files.ts";
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

/** The prefix of r2-check's own objects: no file the app stores starts with it (its keys start u/, v/, m/ or p/). */
export const PROBE_PREFIX = "r2-check/";

/** The key of a bucket's role marker. */
export const ROLE_MARKER_KEY = `${PROBE_PREFIX}role.txt`;

/** The text of the role marker of a bucket of this role. */
export function markerText(role: "private" | "public"): string {
  return `demo-platform bucket role: ${role}\n`;
}

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

/** What a bucket's marker says: absent, one of the two roles, or something r2-check never writes. Throws what the store throws. */
export async function readMarker(store: FileStore): Promise<"absent" | "private" | "public" | "unknown"> {
  const got = await store.get(ROLE_MARKER_KEY);
  if (got === null) return "absent";
  if (got.size > 256) {
    await got.body.cancel().catch(() => {});
    return "unknown";
  }
  const text = new TextDecoder().decode(await bytesOf(got));
  if (text === markerText("private")) return "private";
  if (text === markerText("public")) return "public";
  return "unknown";
}

export async function writeMarker(store: FileStore, role: "private" | "public"): Promise<void> {
  await store.put(ROLE_MARKER_KEY, new TextEncoder().encode(markerText(role)), { contentType: "text/plain", cacheControl: "no-store" });
}

/** Whether a bucket of `role` holds a file of the other kind: a public picture in the private one, anything else in the public one. */
export function holdsOtherKind(role: "private" | "public", keys: readonly string[]): boolean {
  const own = keys.filter((k) => !k.startsWith(PROBE_PREFIX));
  return role === "private" ? own.some((k) => k.startsWith("p/")) : own.some((k) => !k.startsWith("p/"));
}

export type MarkerCheck =
  | { ok: true }
  | { ok: false; problem: "missing" | "wrong" | "unknown"; role: "private" | "public" }
  | { ok: false; problem: "unreadable"; reason: string };

/** Both markers, as files-copy and the app's start check them: the first problem, or ok. */
export async function checkMarkers(stores: { drafts: FileStore; pub: FileStore }): Promise<MarkerCheck> {
  for (const [role, store] of [["private", stores.drafts], ["public", stores.pub]] as const) {
    let found: Awaited<ReturnType<typeof readMarker>>;
    try {
      found = await readMarker(store);
    } catch (err) {
      return { ok: false, problem: "unreadable", reason: reasonWords(err) };
    }
    if (found === "absent") return { ok: false, problem: "missing", role };
    if (found === "unknown") return { ok: false, problem: "unknown", role };
    if (found !== role) return { ok: false, problem: "wrong", role };
  }
  return { ok: true };
}

/** One store's contents for files-copy: its keys, the object files that can never be copied, and whether it is there at all. */
export type Listing = { keys: string[]; bad: string[]; missing: boolean; all: string[] };

/** A key from a bucket made safe to print: no control or direction characters, at most 200 characters. */
function printable(key: string): string {
  const safe = key.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, "\ufffd");
  return safe.length > 200 ? `${safe.slice(0, 200)}...` : safe;
}

/** Whether a key belongs on the side of `role`: public pictures (p/) on the public side only, everything else on the private side. */
function ofRole(role: "private" | "public", key: string): boolean {
  return role === "public" ? key.startsWith("p/") : !key.startsWith("p/");
}

/**
 * Lists a store for files-copy. A folder store names each object file that cannot be read as
 * `<folder>/<2 hex>/<64 hex>`; a bucket names each key that fails the key check as `key <key>`.
 * A key that is not of the side's role (a public picture among the private files, anything else
 * among the public ones), which the role guard of the site's R2 stores refuses, is named the same
 * way, as `key <key>, which the <role> side never holds`: it can never be copied nor removed, so it
 * is reported once instead of failing every run. r2-check's own objects are left out: they are
 * never copied. Throws what the store throws.
 */
export async function listFor(store: ListableStore, folder: string, role: "private" | "public"): Promise<Listing> {
  let found: string[];
  const bad: string[] = [];
  let missing = false;
  if (store instanceof NodeFileStore) {
    const s = await store.scan();
    found = s.keys;
    bad.push(...s.bad.map((b) => `${folder}/${b}`));
    missing = !s.exists;
  } else {
    found = await store.keys();
  }
  const keys: string[] = [];
  // Every key but r2-check's own, of whatever side: what the line by key prefix shows.
  const all: string[] = [];
  for (const k of found) {
    if (k.startsWith(PROBE_PREFIX)) continue;
    all.push(k);
    try {
      checkKey(k);
    } catch {
      bad.push(`key ${printable(k)}`);
      continue;
    }
    if (!ofRole(role, k)) {
      bad.push(`key ${printable(k)}, which the ${role} side never holds`);
      continue;
    }
    keys.push(k);
  }
  return { keys, bad, missing, all };
}

/** copied: new at the destination; replaced: there before with other bytes or metadata. */
export type MirrorCounts = { copied: number; replaced: number; already: number; failed: number; extra: number; removed: number };

/** How many keys one delete call is given while removing what the source does not hold. */
const REMOVE_BATCH = 1000;

/**
 * Copies to `to` every file of `from` that it does not hold the same. With `removeExtra` it
 * also removes from `to` every file the source does not hold; without, those are counted in
 * `extra` and left in place. With `dryRun` nothing is written or removed, and the counts are of
 * what would be. A file that cannot be read, copied, checked or removed counts as failed and
 * the run goes on.
 */
export async function mirror(from: ListableStore, to: ListableStore, source: Listing, dest: Listing, opts: { dryRun: boolean; removeExtra: boolean }): Promise<MirrorCounts> {
  const counts: MirrorCounts = { copied: 0, replaced: 0, already: 0, failed: 0, extra: 0, removed: 0 };
  const there = new Set(dest.keys);
  const held = new Set(source.keys);
  for (const key of source.keys) {
    try {
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
      if (there.has(key)) {
        const dst = await to.get(key);
        if (dst !== null) {
          const was = await bytesOf(dst);
          if (dst.size === src.size && was.byteLength === src.size && sha256(was) === digest && dst.contentType === src.contentType && dst.cacheControl === src.cacheControl) {
            counts.already++;
            continue;
          }
        }
      }
      const replacing = there.has(key);
      if (opts.dryRun) {
        if (replacing) counts.replaced++;
        else counts.copied++;
        continue;
      }
      await to.put(key, bytes, src.cacheControl === null ? { contentType: src.contentType } : { contentType: src.contentType, cacheControl: src.cacheControl });
      const check = await to.get(key);
      const back = check === null ? null : await bytesOf(check);
      if (check === null || back === null || check.size !== src.size || back.byteLength !== src.size || sha256(back) !== digest) {
        counts.failed++;
        continue;
      }
      if (replacing) counts.replaced++;
      else counts.copied++;
    } catch {
      counts.failed++;
    }
  }
  const extra = dest.keys.filter((k) => !held.has(k));
  counts.extra = extra.length;
  if (!opts.removeExtra || opts.dryRun) return counts;
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

/** Keys counted by their first part (`p/`, `u/`, …), sorted, for the line that shows what a store holds. */
export function byPrefix(keys: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const k of keys) {
    const slash = k.indexOf("/");
    const prefix = slash < 0 ? "(no prefix)" : k.slice(0, slash + 1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  if (counts.size === 0) return "none";
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([p, n]) => `${printable(p)} ${n}`)
    .join(", ");
}

/**
 * The app's check of the two markers at its start, with FILE_STORE=r2: `stop` for a marker that
 * is missing, wrong or not r2-check's (the start stops with that line), `warn` when R2 could
 * not be asked (the start goes on with that line: a short outage must not keep the site down
 * at a restart), null when both are right. Fixed lines, never a value.
 */
export async function startMarkerCheck(stores: { drafts: FileStore; pub: FileStore }): Promise<{ stop: string } | { warn: string } | null> {
  const m = await checkMarkers(stores);
  if (m.ok) return null;
  if (m.problem === "unreadable") return { warn: `files: the role markers of the two R2 buckets could not be checked at the start (${m.reason}). The site starts; run the admin command r2-check.` };
  if (m.problem === "missing") return { stop: `files: the ${m.role} bucket has no role marker. Run the admin command r2-check, then start the site again.` };
  if (m.problem === "wrong") {
    return { stop: m.role === "private" ? "files: the private bucket is marked as the public one: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET are swapped." : "files: the public bucket is marked as the private one: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET are swapped." };
  }
  return { stop: `files: the ${m.role} bucket's role marker holds something r2-check never writes. Run the admin command r2-check.` };
}
