// Test only: a zip reader written apart from src/zip.ts, from PKWARE's APPNOTE, to check what
// the writer makes. It shares no code with the writer: its CRC-32 is the plain bit-by-bit
// one, it finds the archive from its end records as an unzip program does, follows ZIP64
// markers wherever they are, and checks that every local header, every file's bytes and
// every data descriptor agree with the central directory, and that nothing in the archive is
// unaccounted for. Any disagreement throws.

export type ReadEntry = {
  name: string;
  bytes: Uint8Array;
  crc: number;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  /** The local header had the ZIP64 extra field (and so the descriptor 8-byte sizes). */
  zip64Local: boolean;
  /** The central entry had the ZIP64 extra field. */
  zip64Central: boolean;
};
export type ReadZip = { entries: ReadEntry[]; zip64End: boolean };

/** CRC-32 bit by bit, the reference way. */
export function crc32Reference(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function fail(what: string): never {
  throw new Error(`zip reader: ${what}`);
}

export function readZip(data: Uint8Array): ReadZip {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => v.getUint16(at, true);
  const u32 = (at: number) => v.getUint32(at, true);
  const u64 = (at: number) => {
    const n = v.getUint32(at, true) + v.getUint32(at + 4, true) * 0x100000000;
    if (!Number.isSafeInteger(n)) fail("a 64-bit value out of range");
    return n;
  };
  // The end record: 22 bytes, no comment, at the very end.
  const end = data.length - 22;
  if (end < 0 || u32(end) !== 0x06054b50) fail("no end record at the end");
  if (u16(end + 20) !== 0) fail("an archive comment");
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0) fail("more than one disk");
  let count = u16(end + 10);
  if (u16(end + 8) !== count) fail("entry counts differ");
  let dirSize = u32(end + 12);
  let dirOffset = u32(end + 16);
  let zip64End = false;
  let dirEnd = end;
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const loc = end - 20;
    if (loc < 0 || u32(loc) !== 0x07064b50) fail("a ZIP64 marker without the locator");
    if (u32(loc + 16) !== 1) fail("the locator names more than one disk");
    const at = u64(loc + 8);
    if (at !== loc - 56) fail("the ZIP64 end record is not right before its locator");
    if (u32(at) !== 0x06064b50) fail("no ZIP64 end record where the locator says");
    if (u64(at + 4) !== 44) fail("a ZIP64 end record of another size");
    if (u64(at + 24) !== u64(at + 32)) fail("ZIP64 entry counts differ");
    count = u64(at + 32);
    dirSize = u64(at + 40);
    dirOffset = u64(at + 48);
    zip64End = true;
    dirEnd = at;
  }
  if (dirOffset + dirSize !== dirEnd) fail("the central directory does not end where the end records start");

  const entries: ReadEntry[] = [];
  let p = dirOffset;
  let expectLocal = 0;
  const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  for (let i = 0; i < count; i++) {
    if (u32(p) !== 0x02014b50) fail(`no central header ${i}`);
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const dosTime = u16(p + 12);
    const dosDate = u16(p + 14);
    const crc = u32(p + 16);
    let csize = u32(p + 20);
    let usize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    let offset = u32(p + 42);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nameLen));
    // The ZIP64 field holds, in this order, only the values marked in the header.
    let zip64Central = false;
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = u16(e);
      const len = u16(e + 2);
      if (id === 0x0001) {
        zip64Central = true;
        let q = e + 4;
        if (usize === 0xffffffff) (usize = u64(q)), (q += 8);
        if (csize === 0xffffffff) (csize = u64(q)), (q += 8);
        if (offset === 0xffffffff) (offset = u64(q)), (q += 8);
        if (q !== e + 4 + len) fail(`${name}: a ZIP64 field of the wrong length`);
      }
      e += 4 + len;
    }
    if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) fail(`${name}: a marker with no ZIP64 value`);
    if (method !== 0) fail(`${name}: not stored`);
    if (csize !== usize) fail(`${name}: stored sizes differ`);
    if (offset !== expectLocal) fail(`${name}: not right after the file before it`);
    // The local header.
    if (u32(offset) !== 0x04034b50) fail(`${name}: no local header`);
    if (u16(offset + 6) !== flags || u16(offset + 8) !== method || u16(offset + 10) !== dosTime || u16(offset + 12) !== dosDate) fail(`${name}: the local header disagrees`);
    const lNameLen = u16(offset + 26);
    const lExtraLen = u16(offset + 28);
    if (dec.decode(data.subarray(offset + 30, offset + 30 + lNameLen)) !== name) fail(`${name}: the local name differs`);
    let zip64Local = false;
    for (let e = offset + 30 + lNameLen; e < offset + 30 + lNameLen + lExtraLen; ) {
      if (u16(e) === 0x0001) zip64Local = true;
      e += 4 + u16(e + 2);
    }
    const start = offset + 30 + lNameLen + lExtraLen;
    if (start + usize > dirOffset) fail(`${name}: runs into the directory`);
    const bytes = data.slice(start, start + usize);
    if (crc32Reference(bytes) !== crc) fail(`${name}: wrong CRC-32`);
    let next = start + usize;
    if (flags & 0x0008) {
      if (u32(offset + 14) !== 0) fail(`${name}: a CRC in the local header with flag 3`);
      if (u32(next) !== 0x08074b50) fail(`${name}: no data descriptor`);
      if (u32(next + 4) !== crc) fail(`${name}: the descriptor's CRC differs`);
      if (zip64Local) {
        if (u64(next + 8) !== usize || u64(next + 16) !== usize) fail(`${name}: the descriptor's sizes differ`);
        next += 24;
      } else {
        if (u32(next + 8) !== usize || u32(next + 12) !== usize) fail(`${name}: the descriptor's sizes differ`);
        next += 16;
      }
    } else if (u32(offset + 14) !== crc || u32(offset + 22) !== usize) fail(`${name}: the local header's CRC or size differs`);
    expectLocal = next;
    entries.push({ name, bytes, crc, flags, method, dosTime, dosDate, zip64Local, zip64Central });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== dirOffset + dirSize) fail("the directory holds more than its entries");
  if (expectLocal !== dirOffset) fail("bytes between the last file and the directory");
  return { entries, zip64End };
}

/** The files of a zip by name, read by readZip. */
export function filesOf(data: Uint8Array): Map<string, Uint8Array> {
  return new Map(readZip(data).entries.map((e) => [e.name, e.bytes]));
}
