// A zip archive written as a stream, one file after another, never held whole in memory.
// Pure: no platform API, no database, no store. src/export.ts feeds it the files of a
// workspace; the tests read what it writes with a reader of their own.
//
// The form, from PKWARE's APPNOTE (version 6.3.10):
// - Every file is "stored" (method 0, no compression): the pictures and clips it carries
//   are compressed already, and stored needs no state but a CRC-32.
// - Every file has general-purpose flag 3 (a data descriptor follows the bytes, with the
//   CRC-32 and the sizes, so a file is streamed once and never read twice) and flag 11
//   (the name is UTF-8; every name this module takes is ASCII anyway, see ZIP_NAME).
// - ZIP64 (APPNOTE 4.3.9, 4.4.3.2, 4.5.3, 4.3.14 and 4.3.15) where a value does not fit:
//   a file whose expected size reaches 4 GiB gets the ZIP64 extra field in its local header
//   and 8-byte sizes in its descriptor; a central directory entry gets the extra field with
//   each of its size and offset that does not fit in 4 bytes; and an archive with 65,535
//   files or more, or whose directory or its offset passes 4 GiB, gets the ZIP64 end
//   record and its locator before the usual end record. Below those, nothing of ZIP64 is
//   written, so every reader opens an ordinary archive.
// - The time of a file is its own when known, written as MS-DOS date and time in UTC; else
//   1 January 1980 00:00, the first time that form has.
//
// The stream asks for the next file only when its reader has taken what came before, and a
// file's bytes are passed on a chunk at a time as its own stream gives them, so memory stays
// at about one chunk whatever the archive's size. Cancelling the stream cancels the file
// being read and asks for no further file.

/** One file of the archive. */
export type ZipEntry = {
  /** Its path in the archive: ZIP_NAME's form, folders separated by "/". */
  name: string;
  /** When it was last changed, in ms since 1970, or null when that is not known. */
  modified: number | null;
  /** How many bytes it is expected to have: decides whether its local header needs ZIP64. */
  size: number;
  /**
   * Its bytes, opened only when the archive reaches it. null: the file is left out, and
   * nothing of it is written.
   */
  open: () => Promise<ReadableStream<Uint8Array> | Uint8Array | null>;
  /**
   * Told once the archive is past it: the bytes written, or null when it was left out.
   * A file whose stream ended early is written as far as it went, with that length.
   */
  done?: (written: number | null) => void;
};

/**
 * The largest values the short fields hold. A value at or past one is written as the marker
 * (all bits set) with the real value in a ZIP64 field. Tests pass smaller ones, so the ZIP64
 * forms can be checked without gigabytes.
 */
export type ZipLimits = { u16: number; u32: number };
export const ZIP_LIMITS: ZipLimits = { u16: 0xffff, u32: 0xffffffff };

/**
 * A name the writer takes: ASCII letters, digits, ".", "_" and "-" in parts of 1 to 100
 * characters separated by "/" (so no control character and no space), and at most 240
 * characters in all; and no part a folder on Windows or macOS could not hold as written: one
 * made only of dots (".", ".." and more), one ending in a dot, or a Windows device name (CON,
 * PRN, AUX, NUL, COM0 to COM9, LPT0 to LPT9) in any case, alone or before an extension.
 * Nothing that could leave the folder it is unpacked into, on any system.
 */
export const ZIP_NAME = /^[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100})*$/;
const ZIP_NAME_MAX = 240;
const DEVICE_PART = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** Throws unless `name` is a name the writer takes. */
export function checkZipName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length > ZIP_NAME_MAX ||
    !ZIP_NAME.test(name) ||
    name.split("/").some((p) => /^\.+$/.test(p) || p.endsWith(".") || DEVICE_PART.test(p))
  ) {
    throw new Error("zip: a name that cannot be written");
  }
}

// ---- CRC-32 (the polynomial 0xEDB88320, as zip uses it), eight bytes at a time ----------

const CRC_TABLES: Uint32Array[] = (() => {
  const t0 = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c >>> 0;
  }
  const tables = [t0];
  for (let k = 1; k < 8; k++) {
    const prev = tables[k - 1];
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) t[n] = (t0[prev[n] & 0xff] ^ (prev[n] >>> 8)) >>> 0;
    tables.push(t);
  }
  return tables;
})();

/** The CRC-32 of `bytes` continued from `crc` (0 to start). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES;
  let c = ~crc >>> 0;
  let i = 0;
  const n = bytes.length;
  for (; i + 8 <= n; i += 8) {
    const a = (c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24))) >>> 0;
    c =
      t7[a & 0xff] ^
      t6[(a >>> 8) & 0xff] ^
      t5[(a >>> 16) & 0xff] ^
      t4[a >>> 24] ^
      t3[bytes[i + 4]] ^
      t2[bytes[i + 5]] ^
      t1[bytes[i + 6]] ^
      t0[bytes[i + 7]];
  }
  for (; i < n; i++) c = t0[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ---- Writing the records ---------------------------------------------------------------

/** A little-endian record being written. */
class Bytes {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private at = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }
  u16(v: number): this {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number): this {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(v: number): this {
    // Safe integers only: every size and offset here is one.
    this.view.setUint32(this.at, v % 0x100000000, true);
    this.view.setUint32(this.at + 4, Math.floor(v / 0x100000000), true);
    this.at += 8;
    return this;
  }
  raw(b: Uint8Array): this {
    this.buf.set(b, this.at);
    this.at += b.length;
    return this;
  }
  done(): Uint8Array {
    if (this.at !== this.buf.length) throw new Error("zip: a record of the wrong length");
    return this.buf;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_END = 0x06054b50;
/** Flag 3 (a data descriptor follows) and flag 11 (the name is UTF-8). */
const FLAGS = 0x0008 | 0x0800;
/** "Version needed": 2.0 for an ordinary file, 4.5 for one that uses ZIP64. */
const V20 = 20;
const V45 = 45;
const ZIP64_EXTRA = 0x0001;
const MARK16 = 0xffff;
const MARK32 = 0xffffffff;

/** MS-DOS time and date of `ms` in UTC; the first one that form has for an unknown or earlier time, the last for a later one. */
export function dosTime(ms: number | null): { time: number; date: number } {
  if (ms === null || !Number.isFinite(ms)) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

type Written = { name: Uint8Array; time: number; date: number; crc: number; size: number; offset: number; zip64Local: boolean };

function localHeader(name: Uint8Array, time: number, date: number, zip64: boolean): Uint8Array {
  const extra = zip64 ? 20 : 0;
  const b = new Bytes(30 + name.length + extra)
    .u32(SIG_LOCAL)
    .u16(zip64 ? V45 : V20)
    .u16(FLAGS)
    .u16(0) // stored
    .u16(time)
    .u16(date)
    .u32(0) // the CRC-32 and the sizes are in the descriptor (flag 3)
    .u32(zip64 ? MARK32 : 0)
    .u32(zip64 ? MARK32 : 0)
    .u16(name.length)
    .u16(extra)
    .raw(name);
  // APPNOTE 4.5.3: the local header's ZIP64 field holds both sizes; with flag 3 they are 0 here.
  if (zip64) b.u16(ZIP64_EXTRA).u16(16).u64(0).u64(0);
  return b.done();
}

function descriptor(crc: number, size: number, zip64: boolean): Uint8Array {
  const b = new Bytes(zip64 ? 24 : 16).u32(SIG_DESCRIPTOR).u32(crc);
  return (zip64 ? b.u64(size).u64(size) : b.u32(size).u32(size)).done();
}

function centralHeader(w: Written, limits: ZipLimits): Uint8Array {
  const bigSize = w.size >= limits.u32;
  const bigOffset = w.offset >= limits.u32;
  const fields = (bigSize ? 2 : 0) + (bigOffset ? 1 : 0);
  const extra = fields === 0 ? 0 : 4 + 8 * fields;
  const zip64 = fields > 0 || w.zip64Local;
  const b = new Bytes(46 + w.name.length + extra)
    .u32(SIG_CENTRAL)
    .u16(zip64 ? V45 : V20) // made by: MS-DOS, this version
    .u16(zip64 ? V45 : V20)
    .u16(FLAGS)
    .u16(0)
    .u16(w.time)
    .u16(w.date)
    .u32(w.crc)
    .u32(bigSize ? MARK32 : w.size)
    .u32(bigSize ? MARK32 : w.size)
    .u16(w.name.length)
    .u16(extra)
    .u16(0) // no comment
    .u16(0) // disk 0
    .u16(0) // internal attributes
    .u32(0) // external attributes
    .u32(bigOffset ? MARK32 : w.offset)
    .raw(w.name);
  // APPNOTE 4.5.3: only the fields marked above, in this order.
  if (fields > 0) {
    b.u16(ZIP64_EXTRA).u16(8 * fields);
    if (bigSize) b.u64(w.size).u64(w.size);
    if (bigOffset) b.u64(w.offset);
  }
  return b.done();
}

function endRecords(count: number, dirSize: number, dirOffset: number, limits: ZipLimits): Uint8Array[] {
  const out: Uint8Array[] = [];
  const bigCount = count >= limits.u16;
  const bigSize = dirSize >= limits.u32;
  const bigOffset = dirOffset >= limits.u32;
  if (bigCount || bigSize || bigOffset) {
    const end64At = dirOffset + dirSize;
    out.push(
      new Bytes(56)
        .u32(SIG_END64)
        .u64(44) // the size of the rest of this record
        .u16(V45)
        .u16(V45)
        .u32(0)
        .u32(0)
        .u64(count)
        .u64(count)
        .u64(dirSize)
        .u64(dirOffset)
        .done(),
    );
    out.push(new Bytes(20).u32(SIG_LOCATOR64).u32(0).u64(end64At).u32(1).done());
  }
  out.push(
    new Bytes(22)
      .u32(SIG_END)
      .u16(0)
      .u16(0)
      .u16(bigCount ? MARK16 : count)
      .u16(bigCount ? MARK16 : count)
      .u32(bigSize ? MARK32 : dirSize)
      .u32(bigOffset ? MARK32 : dirOffset)
      .u16(0)
      .done(),
  );
  return out;
}

/**
 * The archive of `entries`, in their order, as a stream. A name the writer does not take,
 * or a name given twice, errors the stream when it is reached; so does a file that grows
 * past 4 GiB without ZIP64 in its local header, which a file whose expected size was
 * given right never does. A file that cannot be read (its stream errors) errors the stream.
 */
export function zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>, limits: ZipLimits = ZIP_LIMITS): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  async function* chunks(): AsyncGenerator<Uint8Array> {
    const written: Written[] = [];
    const names = new Set<string>();
    let offset = 0;
    for await (const entry of entries) {
      if (cancelled) return;
      checkZipName(entry.name);
      // Case is folded: two names that differ only in case are one file on Windows and macOS.
      const folded = entry.name.toLowerCase();
      if (names.has(folded)) throw new Error("zip: a name given twice");
      const body = await entry.open();
      if (body === null) {
        entry.done?.(null);
        continue;
      }
      names.add(folded);
      const name = encoder.encode(entry.name);
      const { time, date } = dosTime(entry.modified);
      const zip64Local = entry.size >= limits.u32;
      const header = localHeader(name, time, date, zip64Local);
      const start = offset;
      yield header;
      offset += header.length;
      let crc = 0;
      let size = 0;
      if (body instanceof Uint8Array) {
        crc = crc32(body);
        size = body.length;
        if (size > 0) yield body;
      } else {
        reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.length === 0) continue;
            crc = crc32(value, crc);
            size += value.length;
            if (!zip64Local && size >= limits.u32) throw new Error("zip: a file larger than its local header allows");
            yield value;
          }
        } finally {
          reader.releaseLock();
          reader = null;
        }
      }
      offset += size;
      const desc = descriptor(crc, size, zip64Local);
      yield desc;
      offset += desc.length;
      written.push({ name, time, date, crc, size, offset: start, zip64Local });
      entry.done?.(size);
    }
    const dirOffset = offset;
    let dirSize = 0;
    for (const w of written) {
      const c = centralHeader(w, limits);
      dirSize += c.length;
      yield c;
    }
    for (const r of endRecords(written.length, dirSize, dirOffset, limits)) yield r;
  }

  const gen = chunks();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await gen.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel(reason) {
        cancelled = true;
        await reader?.cancel(reason).catch(() => {});
        await gen.return(undefined).catch(() => {});
      },
    },
    // One chunk at a time: the next file is not read before the reader wants its bytes.
    { highWaterMark: 0 },
  );
}
