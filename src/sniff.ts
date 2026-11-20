// Image type and size from the file's own bytes, never from its name or Content-Type.
// Pure functions with no I/O, so both targets run the same code.

export type ImageType = "png" | "jpg";
export type ImageInfo = { type: ImageType; width: number; height: number };

/** A step image: at most 2,000,000 bytes and 4096 pixels on either side. */
export const STEP_IMAGE_RULE = { maxBytes: 2_000_000, maxSide: 4096 } as const;
/** The cover logo: at most 200,000 bytes and 512 pixels on either side. */
export const LOGO_RULE = { maxBytes: 200_000, maxSide: 512 } as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

function u16(data: Uint8Array, i: number): number {
  return (data[i] << 8) | data[i + 1];
}

function u32(data: Uint8Array, i: number): number {
  return data[i] * 0x1000000 + ((data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]);
}

/** PNG (89 50 4E 47 0D 0A 1A 0A) or JPEG (FF D8 FF) by the first bytes; anything else is null. */
export function sniffImage(head: Uint8Array): ImageType | null {
  if (startsWith(head, PNG_SIGNATURE)) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpg";
  return null;
}

/** Width and height from a PNG's first chunk, which must be a well-formed IHDR. */
function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24) return null;
  if (u32(data, 8) !== 13) return null;
  if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) return null; // "IHDR"
  return { width: u32(data, 16), height: u32(data, 20) };
}

/**
 * Width and height from a JPEG's first start-of-frame segment. Walks the segment headers
 * once from the start; every step moves forward, so the walk is linear in the input.
 */
function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i < data.length) {
    if (data[i] !== 0xff) return null;
    while (i < data.length && data[i] === 0xff) i++; // fill bytes
    if (i >= data.length) return null;
    const marker = data[i++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length field
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null; // end or scan data before any frame
    if (i + 2 > data.length) return null;
    const len = u16(data, i);
    if (len < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (len < 8 || i + 7 > data.length) return null;
      return { height: u16(data, i + 3), width: u16(data, i + 5) };
    }
    i += len;
  }
  return null;
}

/** Type, width and height read from the image header, or null when it is not a readable PNG or JPEG header or a side is 0. */
export function imageInfo(data: Uint8Array): ImageInfo | null {
  const type = sniffImage(data);
  const size = type === "png" ? pngSize(data) : type === "jpg" ? jpegSize(data) : null;
  if (type === null || size === null || size.width < 1 || size.height < 1) return null;
  return { type, width: size.width, height: size.height };
}

/** The types a shared item may be: a PNG or JPEG image, or a GIF or MP4 clip. */
export type MediaType = ImageType | "gif" | "mp4";
/** Type and, for every type but MP4, width and height read from the file's own first bytes. */
export type MediaInfo = { type: ImageType | "gif"; width: number; height: number } | { type: "mp4"; width: null; height: null };

const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
/** The longest `ftyp` box taken as plausible: a major brand, a version and up to 1,020 compatible brands. */
const MAX_FTYP_BYTES = 4096;

/**
 * True when the bytes start with an MP4 `ftyp` box: a 32-bit size at offset 0 that is at
 * least 16 (size, type, major brand, minor version), a multiple of 4 (the compatible
 * brands are 4 bytes each), at most MAX_FTYP_BYTES and within the bytes given; "ftyp" at
 * offset 4; and a major brand of four printable ASCII characters at offset 8.
 */
function isMp4(head: Uint8Array): boolean {
  if (head.length < 16) return false;
  if (head[4] !== 0x66 || head[5] !== 0x74 || head[6] !== 0x79 || head[7] !== 0x70) return false; // "ftyp"
  const size = u32(head, 0);
  if (size < 16 || size % 4 !== 0 || size > MAX_FTYP_BYTES || size > head.length) return false;
  for (let i = 8; i < 12; i++) if (head[i] < 0x20 || head[i] > 0x7e) return false;
  return true;
}

/** PNG, JPEG, GIF (GIF87a or GIF89a) or MP4 (an `ftyp` box at offset 4) by the first bytes; anything else is null. */
export function sniffMedia(head: Uint8Array): MediaType | null {
  const image = sniffImage(head);
  if (image !== null) return image;
  if (startsWith(head, GIF87A) || startsWith(head, GIF89A)) return "gif";
  if (isMp4(head)) return "mp4";
  return null;
}

/** Width and height from a GIF's logical screen descriptor: two little-endian 16-bit numbers after the signature. */
function gifSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 10) return null;
  return { width: data[6] | (data[7] << 8), height: data[8] | (data[9] << 8) };
}

/**
 * Type and size read from the file's own first bytes, or null when they are not those of a
 * PNG, JPEG, GIF or MP4, or a PNG, JPEG or GIF header gives no size or a side of 0. For an
 * MP4 only the type is read: its size and duration are taken as the client declares them.
 *
 * As with checkImage, only the header is read: a valid header followed by anything passes.
 * Whatever serves these bytes must use the fixed Content-Type of the checked type and
 * `X-Content-Type-Options: nosniff`.
 */
export function mediaInfo(data: Uint8Array): MediaInfo | null {
  const type = sniffMedia(data);
  if (type === null) return null;
  if (type === "mp4") return { type, width: null, height: null };
  const size = type === "png" ? pngSize(data) : type === "jpg" ? jpegSize(data) : gifSize(data);
  if (size === null || size.width < 1 || size.height < 1) return null;
  return { type, width: size.width, height: size.height };
}

export type ImageRule = {
  maxBytes: number;
  maxSide: number;
  /** When given, each must equal what the file itself says. */
  type?: ImageType;
  width?: number;
  height?: number;
  bytes?: number;
};

/**
 * Checks an uploaded image against its caps and against what the manifest declared, using
 * only the file's bytes. The error never contains any of the file's content.
 *
 * Obligation for every later task that serves an image: only the header is read here, so a
 * valid PNG or JPEG header followed by HTML passes. Always serve images with the fixed
 * Content-Type that matches the checked type (`image/png` or `image/jpeg`, never one taken
 * from the request) and with `X-Content-Type-Options: nosniff`.
 */
export function checkImage(data: Uint8Array, rule: ImageRule): { ok: true; info: ImageInfo } | { ok: false; error: string } {
  if (data.length > rule.maxBytes) return { ok: false, error: `image is over ${rule.maxBytes} bytes` };
  if (rule.bytes !== undefined && data.length !== rule.bytes) return { ok: false, error: "image length differs from the manifest's bytes" };
  const info = imageInfo(data);
  if (info === null) return { ok: false, error: "not a PNG or JPEG image" };
  if (rule.type !== undefined && info.type !== rule.type) return { ok: false, error: `image is not a ${rule.type === "png" ? "PNG" : "JPEG"}` };
  if (info.width > rule.maxSide || info.height > rule.maxSide) return { ok: false, error: `image is over ${rule.maxSide} pixels on a side` };
  if ((rule.width !== undefined && info.width !== rule.width) || (rule.height !== undefined && info.height !== rule.height)) {
    return { ok: false, error: "image size differs from the manifest's width and height" };
  }
  return { ok: true, info };
}
