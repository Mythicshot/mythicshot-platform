// The zip writer (src/zip.ts), read back by the independent reader in test/zip-reader.ts, on
// both targets: an empty archive, files of every size streamed in chunks, many files, the
// ZIP64 forms (with small limits passed in, so no gigabytes are written), names it refuses,
// the times, and that it reads a file only when its reader wants the bytes.
import { describe, expect, it } from "vitest";
import { checkZipName, crc32, dosTime, zipStream, ZIP_LIMITS, type ZipEntry } from "../src/zip.ts";
import { crc32Reference, filesOf, readZip } from "./zip-reader.ts";

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A stream of `bytes` in chunks of `chunk`. */
function chunked(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

function pattern(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) out[i] = x = (x * 1103515245 + 12345) & 0xff;
  return out;
}

const file = (name: string, bytes: Uint8Array, chunk = 7, modified: number | null = null): ZipEntry => ({ name, modified, size: bytes.length, open: async () => chunked(bytes, chunk) });

describe("the zip writer", () => {
  it("computes CRC-32 as zip does, whatever the chunks", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    for (const n of [1, 7, 8, 9, 63, 64, 65, 1000, 4097]) {
      const b = pattern(n, n);
      expect(crc32(b), `${n}`).toBe(crc32Reference(b));
      // Continued over two pieces at every cut is the same.
      for (const cut of [0, 1, 5, Math.floor(n / 2), n]) expect(crc32(b.subarray(cut), crc32(b.subarray(0, cut))), `${n} at ${cut}`).toBe(crc32Reference(b));
    }
  });

  it("writes an empty archive that a reader opens: only the end record", async () => {
    const zip = await bytesOf(zipStream([]));
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual({ entries: [], zip64End: false });
  });

  it("writes files of every size, streamed in chunks, each with its own CRC-32, sizes and time, and no ZIP64", async () => {
    const sizes = [0, 1, 7, 8, 100, 65_536, 300_001];
    const when = Date.UTC(2026, 10, 23, 18, 4, 31);
    const entries = sizes.map((n, i) => file(`folder/f-${i}.bin`, pattern(n, i + 1), 4096 + i, when));
    entries.push({ name: "whole.txt", modified: null, size: 5, open: async () => new TextEncoder().encode("hello") });
    const zip = readZip(await bytesOf(zipStream(entries)));
    expect(zip.zip64End).toBe(false);
    expect(zip.entries.map((e) => e.name)).toEqual([...sizes.map((_, i) => `folder/f-${i}.bin`), "whole.txt"]);
    sizes.forEach((n, i) => {
      const e = zip.entries[i];
      expect(e.bytes).toEqual(pattern(n, i + 1));
      expect([e.method, e.flags, e.zip64Local, e.zip64Central]).toEqual([0, 0x0808, false, false]);
      // 2026-11-23 18:04:30 in MS-DOS form (seconds in twos).
      expect([e.dosDate, e.dosTime]).toEqual([((2026 - 1980) << 9) | (11 << 5) | 23, (18 << 11) | (4 << 5) | 15]);
    });
    expect(new TextDecoder().decode(zip.entries[sizes.length].bytes)).toBe("hello");
    // An unknown time is 1 January 1980, 00:00.
    expect([zip.entries[sizes.length].dosDate, zip.entries[sizes.length].dosTime]).toEqual([(1 << 5) | 1, 0]);
  });

  it("writes many files, in order, each where the directory says", async () => {
    const entries = Array.from({ length: 1500 }, (_, i) => file(`many/${String(i).padStart(4, "0")}.txt`, new TextEncoder().encode(`file ${i}\n`), 3));
    const files = filesOf(await bytesOf(zipStream(entries)));
    expect(files.size).toBe(1500);
    expect(new TextDecoder().decode(files.get("many/0042.txt"))).toBe("file 42\n");
    expect(new TextDecoder().decode(files.get("many/1499.txt"))).toBe("file 1499\n");
  });

  it("uses ZIP64 exactly where a value passes its field: a large file, offsets past 4 GiB, and 65,535 files or more (limits passed in small)", async () => {
    const limits = { u16: 10, u32: 1000 };
    const big = pattern(2500, 9);
    const entries = [file("small.bin", pattern(100, 2)), file("big.bin", big, 333), ...Array.from({ length: 10 }, (_, i) => file(`after-${i}.bin`, pattern(50, i)))];
    const zip = readZip(await bytesOf(zipStream(entries, limits)));
    expect(zip.zip64End).toBe(true);
    expect(zip.entries).toHaveLength(12);
    const [small, large, ...after] = zip.entries;
    // The first file: small, at offset 0: nothing of ZIP64.
    expect([small.zip64Local, small.zip64Central]).toEqual([false, false]);
    // The large one: ZIP64 in its local header (so 8-byte sizes in its descriptor) and its central entry.
    expect([large.zip64Local, large.zip64Central]).toEqual([true, true]);
    expect(large.bytes).toEqual(big);
    // Every later file starts past the small limit: its offset is in its central ZIP64 field.
    for (const e of after) expect([e.zip64Local, e.zip64Central]).toEqual([false, true]);
    // The same files with the real limits: no ZIP64 anywhere, the same bytes.
    const plain = readZip(await bytesOf(zipStream(entries.map((e) => ({ ...e })), ZIP_LIMITS)));
    expect(plain.zip64End).toBe(false);
    expect(plain.entries.map((e) => [e.name, e.zip64Local, e.zip64Central])).toEqual(zip.entries.map((e) => [e.name, false, false]));
    expect(plain.entries.map((e) => e.bytes)).toEqual(zip.entries.map((e) => e.bytes));
  });

  it("refuses a file that grows past 4 GiB without ZIP64 in its local header (limits passed in small)", async () => {
    const lying: ZipEntry = { name: "liar.bin", modified: null, size: 10, open: async () => chunked(pattern(2000), 100) };
    await expect(bytesOf(zipStream([lying], { u16: 10, u32: 1000 }))).rejects.toThrow("zip: a file larger than its local header allows");
  });

  it("takes only plain relative ASCII names, each once whatever its case", async () => {
    for (const ok of ["README.txt", "tours/a-b/index.html", "tours/x/pictures/step-001.png", "a_b.c-d"]) expect(() => checkZipName(ok), ok).not.toThrow();
    const bad = ["", "/abs", "../up", "a/../b", "a/./b", ".", "..", "a//b", "a/", "C:/x", "c:x", "a\\b", "a b", "ü.txt", "a\u0000b", "x".repeat(101), `${"a/".repeat(130)}b`];
    for (const name of bad) expect(() => checkZipName(name), JSON.stringify(name)).toThrow("zip: a name that cannot be written");
    await expect(bytesOf(zipStream([file("../evil", pattern(3))]))).rejects.toThrow("zip: a name that cannot be written");
    await expect(bytesOf(zipStream([file("Same.txt", pattern(3)), file("same.TXT", pattern(3))]))).rejects.toThrow("zip: a name given twice");
  });

  it("leaves out a file that cannot be opened, and tells its done", async () => {
    const told: (number | null)[] = [];
    const entries: ZipEntry[] = [
      { name: "gone.bin", modified: null, size: 5, open: async () => null, done: (n) => told.push(n) },
      { name: "here.bin", modified: null, size: 3, open: async () => chunked(pattern(3), 1), done: (n) => told.push(n) },
    ];
    const zip = readZip(await bytesOf(zipStream(entries)));
    expect(zip.entries.map((e) => e.name)).toEqual(["here.bin"]);
    expect(told).toEqual([null, 3]);
  });

  it("opens a file only when its reader wants the bytes, and cancelling stops the file being read and opens no other", async () => {
    const opened: string[] = [];
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: (c) => c.enqueue(new Uint8Array(1000)),
      cancel: () => {
        cancelled = true;
      },
    });
    const entries: ZipEntry[] = [
      { name: "a.bin", modified: null, size: 1e6, open: async () => (opened.push("a"), endless) },
      { name: "b.bin", modified: null, size: 1, open: async () => (opened.push("b"), new Uint8Array(1)) },
    ];
    const reader = zipStream(entries).getReader();
    expect(opened).toEqual([]);
    await reader.read(); // the local header of a.bin
    await reader.read(); // its first chunk
    expect(opened).toEqual(["a"]);
    await reader.cancel();
    expect(cancelled).toBe(true);
    expect(opened).toEqual(["a"]);
  });

  it("writes MS-DOS times in UTC, and the first or last such time outside its range", () => {
    expect(dosTime(null)).toEqual({ time: 0, date: (1 << 5) | 1 });
    expect(dosTime(Date.UTC(1975, 0, 1))).toEqual({ time: 0, date: (1 << 5) | 1 });
    expect(dosTime(Date.UTC(2200, 0, 1))).toEqual({ time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 });
    expect(dosTime(Date.UTC(1980, 0, 1, 0, 0, 1))).toEqual({ time: 0, date: (1 << 5) | 1 });
  });
});
