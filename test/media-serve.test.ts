// The Range header and the part stream (src/media-serve.ts) on their own, with a store
// that hands every part over in small chunks, as an R2 body streams, so every way a
// chunk can lie across a range's ends is reached.
import { describe, expect, it } from "vitest";
import { capRange, parseRange, partAt, rangeStream, type FilePart } from "../src/media-serve.ts";
import type { FileStore, StoredFile } from "../src/ports.ts";

const PARTS: FilePart[] = [
  { key: "p0", bytes: 10 },
  { key: "p1", bytes: 10 },
  { key: "p2", bytes: 5 },
];
const FILE = Uint8Array.from({ length: 25 }, (_, i) => i);

/** A store holding the file's parts, each streamed in chunks of `chunk` bytes, recording every get and how many chunks were read. */
function chunkedStore(chunk: number, overrides: Record<string, Uint8Array | null> = {}) {
  const gets: string[] = [];
  let pulled = 0;
  const bytesOf: Record<string, Uint8Array | null> = { p0: FILE.subarray(0, 10), p1: FILE.subarray(10, 20), p2: FILE.subarray(20, 25), ...overrides };
  const file = (key: string): StoredFile | null => {
    const data = bytesOf[key];
    if (data === null || data === undefined) return null;
    let at = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (at >= data.length) return c.close();
          pulled++;
          c.enqueue(data.slice(at, at + chunk));
          at += chunk;
        },
      },
      { highWaterMark: 0 },
    );
    return { body, size: data.length, contentType: "video/mp4", cacheControl: null };
  };
  const store: FileStore = {
    put: async () => {},
    delete: async () => {},
    get: async (key) => (gets.push(key), file(key)),
  };
  return { store, gets, pulled: () => pulled, file };
}

async function read(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("parseRange", () => {
  it("reads one byte range, a suffix and an open end, and refuses what cannot be satisfied", () => {
    expect(parseRange(null, 25)).toEqual({ kind: "full" });
    expect(parseRange("bytes=0-0", 25)).toEqual({ kind: "range", start: 0, end: 0 });
    expect(parseRange("bytes=24-", 25)).toEqual({ kind: "range", start: 24, end: 24 });
    expect(parseRange("bytes=-1", 25)).toEqual({ kind: "range", start: 24, end: 24 });
    expect(parseRange("bytes=-100", 25)).toEqual({ kind: "range", start: 0, end: 24 });
    expect(parseRange("bytes=3-1000", 25)).toEqual({ kind: "range", start: 3, end: 24 });
    expect(parseRange("BYTES=3-4", 25)).toEqual({ kind: "range", start: 3, end: 4 });
    for (const h of ["bytes=25-", "bytes=25-30", "bytes=-0"]) expect(parseRange(h, 25), h).toEqual({ kind: "unsatisfiable" });
    for (const h of ["bytes=0-1,3-4", "bytes=4-3", "bytes=", "bytes=-", "bytes=a-b", "items=0-1", "0-1", "bytes=1-2-3", "bytes=999999999999999999999-"]) expect(parseRange(h, 25), h).toEqual({ kind: "full" });
  });

  it("finds parts by their lengths and caps a range at a number of parts", () => {
    expect([0, 9, 10, 19, 20, 24].map((b) => partAt(PARTS, b))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(capRange(PARTS, 0, 24, 3)).toBe(24);
    expect(capRange(PARTS, 0, 24, 2)).toBe(19);
    expect(capRange(PARTS, 5, 24, 1)).toBe(9);
    expect(capRange(PARTS, 12, 22, 1)).toBe(19);
  });
});

describe("rangeStream", () => {
  it("gives exactly the bytes asked for, with chunks of any size lying across the range's ends and the parts' boundaries", async () => {
    for (const chunk of [1, 3, 4, 7, 10, 64]) {
      for (let start = 0; start < 25; start++) {
        for (let end = start; end < 25; end++) {
          const { store, gets } = chunkedStore(chunk);
          const first = PARTS[partAt(PARTS, start)];
          const got = await read(rangeStream(store, PARTS, start, end, (await store.get(first.key))!));
          expect([...got], `${chunk} ${start}-${end}`).toEqual([...FILE.subarray(start, end + 1)]);
          // Only the parts the range covers were asked for, each once.
          const want = PARTS.slice(partAt(PARTS, start), partAt(PARTS, end) + 1).map((p) => p.key);
          expect(gets, `${chunk} ${start}-${end}`).toEqual(want);
        }
      }
    }
  });

  it("asks for a later part only when the reader wants its bytes, and stops reading at the range's end", async () => {
    const { store, gets, pulled } = chunkedStore(2);
    const stream = rangeStream(store, PARTS, 0, 24, (await store.get("p0"))!);
    const reader = stream.getReader();
    await reader.read();
    expect(gets).toEqual(["p0"]);
    await reader.cancel();
    expect(gets).toEqual(["p0"]);
    // A range ending early in a part leaves the rest of that part unread.
    const s2 = chunkedStore(1);
    await read(rangeStream(s2.store, PARTS, 0, 2, (await s2.store.get("p0"))!));
    expect(s2.pulled()).toBe(3);
    expect(pulled()).toBe(1);
  });

  it("errors, rather than sending other bytes, when a later part is missing or of the wrong length", async () => {
    for (const p1 of [null, FILE.subarray(10, 19), FILE.subarray(10, 21)]) {
      const { store } = chunkedStore(4, { p1 });
      await expect(read(rangeStream(store, PARTS, 0, 24, (await store.get("p0"))!))).rejects.toThrow(/missing or has the wrong length/);
    }
  });
});
