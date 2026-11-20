// Serving a shared item's file from its parts: the Range header, which parts a byte range
// covers, and one stream that reads those parts in order, one at a time. Pure apart from
// the FileStore it is handed: no route, no header but Range and If-Range, no database.
//
// Parts are listed with their lengths (every part but the last is PART_BYTES long today,
// but nothing here relies on that), so the parts a range covers are computed from the
// lengths, and only those parts are ever read. A part is read as a stream and passed on a
// chunk at a time: on Workers an R2 body streams, so memory stays at a chunk; the Node
// store hands a part over as one buffer, so memory stays at about one part (2,000,000
// bytes). The stream asks the store for a part only when the reader wants its bytes, so
// a client that stops reading stops the reads.
import type { FileStore, StoredFile } from "./ports.ts";

/** One stored part of a file: its key in the private store and its length. */
export type FilePart = { key: string; bytes: number };

/** What a request's Range header asks of a file of `size` bytes. `end` is inclusive. */
export type RangeAsk = { kind: "full" } | { kind: "range"; start: number; end: number } | { kind: "unsatisfiable" };

const SINGLE_RANGE = /^\s*(\d*)\s*-\s*(\d*)\s*$/;

/**
 * The Range header read for one file. Only `bytes=` with ONE range is honoured: a header
 * in another unit, a malformed one and a list of several ranges answer the whole file
 * (RFC 9110 lets a server ignore Range, and the whole file is always a correct answer), so
 * no multipart answer is ever built. A first byte at or past the end, and a suffix of 0
 * bytes, cannot be satisfied (416). A last byte past the end is the end.
 */
export function parseRange(header: string | null, size: number): RangeAsk {
  if (header === null) return { kind: "full" };
  const m = /^\s*bytes\s*=(.*)$/i.exec(header);
  if (m === null || m[1].includes(",")) return { kind: "full" };
  const r = SINGLE_RANGE.exec(m[1]);
  if (r === null || (r[1] === "" && r[2] === "")) return { kind: "full" };
  const first = r[1] === "" ? null : Number(r[1]);
  const last = r[2] === "" ? null : Number(r[2]);
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return { kind: "full" };
  if (first === null) {
    // A suffix: the last `last` bytes.
    if (last === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - (last as number)), end: size - 1 };
  }
  if (last !== null && last < first) return { kind: "full" };
  if (first >= size) return { kind: "unsatisfiable" };
  return { kind: "range", start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

/** The index of the part that holds byte `at`, from the parts' lengths. */
export function partAt(parts: readonly FilePart[], at: number): number {
  let offset = 0;
  for (let n = 0; n < parts.length; n++) {
    if (at < offset + parts[n].bytes) return n;
    offset += parts[n].bytes;
  }
  return parts.length - 1;
}

/** Where part `n` starts in the file. */
function offsetOf(parts: readonly FilePart[], n: number): number {
  let offset = 0;
  for (let i = 0; i < n; i++) offset += parts[i].bytes;
  return offset;
}

/**
 * Shortens a range so it covers at most `maxParts` parts, keeping its first byte. A client
 * that asked for more gets a shorter 206 whose Content-Range says what it holds, and asks
 * again from there, as browsers do for audio and video.
 */
export function capRange(parts: readonly FilePart[], start: number, end: number, maxParts: number): number {
  const first = partAt(parts, start);
  const last = partAt(parts, end);
  if (last - first < maxParts) return end;
  return offsetOf(parts, first + maxParts) - 1;
}

/** The parts bytes `start` to `end` (inclusive) cover, first and last, by index. */
export function partsCovered(parts: readonly FilePart[], start: number, end: number): { first: number; last: number } {
  return { first: partAt(parts, start), last: partAt(parts, end) };
}

/** A part was missing from the store, or shorter or longer than its row says. Carries no key, so it is safe to log. */
export class BrokenPart extends Error {
  constructor() {
    super("a part of a shared item is missing or has the wrong length");
  }
}

/**
 * Bytes `start` to `end` (inclusive) of the file the parts make up, read from `store` part
 * by part. `first` is the first covered part, already fetched by the caller (so a missing
 * object is found before an answer is given); every later part is fetched only when the
 * reader has taken everything before it. A part that is missing, or whose length differs
 * from its row's, errors the stream rather than sending bytes the Content-Length does not
 * describe. Reading stops at `end`: the rest of the last part is cancelled, not read.
 */
export function rangeStream(store: FileStore, parts: readonly FilePart[], start: number, end: number, first: StoredFile): ReadableStream<Uint8Array> {
  const span = partsCovered(parts, start, end);
  let n = span.first;
  let offset = offsetOf(parts, n); // where part n starts in the file
  let pos = 0; // bytes of part n read so far
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let pending: StoredFile | null = first;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          if (reader === null) {
            if (n > span.last) {
              controller.close();
              return;
            }
            const file = pending ?? (await store.get(parts[n].key));
            pending = null;
            if (file === null || file.size !== parts[n].bytes) {
              await file?.body.cancel().catch(() => {});
              throw new BrokenPart();
            }
            reader = file.body.getReader();
            pos = 0;
          }
          const { done, value } = await reader.read();
          if (done) {
            if (pos !== parts[n].bytes) throw new BrokenPart();
            reader = null;
            offset += parts[n].bytes;
            n++;
            continue;
          }
          const at = offset + pos;
          pos += value.byteLength;
          if (pos > parts[n].bytes) throw new BrokenPart();
          const lo = Math.max(0, start - at);
          const hi = Math.min(value.byteLength, end + 1 - at);
          if (hi > lo) controller.enqueue(value.subarray(lo, hi));
          if (offset + pos > end) {
            // Past the last byte asked for: the rest of this part is not wanted.
            await reader.cancel().catch(() => {});
            reader = null;
            n = span.last + 1;
            if (hi <= lo) continue;
          }
          if (hi > lo) return;
        }
      },
      async cancel(reason) {
        await reader?.cancel(reason).catch(() => {});
        await pending?.body.cancel(reason).catch(() => {});
      },
    },
    // Nothing is fetched before a reader asks for it.
    { highWaterMark: 0 },
  );
}
