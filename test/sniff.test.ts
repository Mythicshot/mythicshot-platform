import { describe, expect, it } from "vitest";
import { LOGO_RULE, STEP_IMAGE_RULE, checkImage, imageInfo, mediaInfo, sniffImage, sniffMedia } from "../src/sniff.ts";

const bytes = (...xs: number[]) => new Uint8Array(xs);
const ascii = (s: string) => new TextEncoder().encode(s);
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];

/** A PNG signature and IHDR chunk, then `pad` bytes, the way every PNG starts. */
function png(width: number, height: number, pad = 40): Uint8Array {
  return bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...new Array(pad).fill(0));
}

function segment(marker: number, body: number[]): number[] {
  return [0xff, marker, ...be16(body.length + 2), ...body];
}

/** SOI, an APP0, optional extra segments, a start-of-frame, then scan data. */
function jpeg(width: number, height: number, opts: { sof?: number; before?: number[] } = {}): Uint8Array {
  const app0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = segment(opts.sof ?? 0xc0, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const sos = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  return new Uint8Array([0xff, 0xd8, ...app0, ...(opts.before ?? []), ...sof, ...sos, 1, 2, 3, 0xff, 0xd9]);
}

describe("sniffImage", () => {
  it("sniffs PNG and JPEG and nothing else", () => {
    expect(sniffImage(png(4, 3))).toBe("png");
    expect(sniffImage(jpeg(4, 3))).toBe("jpg");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff))).toBe("jpg");
    expect(sniffImage(ascii("<html><body>x</body></html>"))).toBeNull();
    expect(sniffImage(ascii("GIF89a\x01\x00\x01\x00"))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(sniffImage(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffImage(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBeNull(); // WebP
  });
});

describe("imageInfo", () => {
  it("reads the size from a PNG's IHDR", () => {
    expect(imageInfo(png(1280, 720))).toEqual({ type: "png", width: 1280, height: 720 });
    expect(imageInfo(png(0x7fffffff, 1))).toEqual({ type: "png", width: 0x7fffffff, height: 1 });
  });

  it("refuses a PNG whose first chunk is not a well-formed IHDR, or with a zero side", () => {
    const wrongType = png(4, 3);
    wrongType[12] = 0x69; // "iHDR"
    expect(imageInfo(wrongType)).toBeNull();
    const wrongLength = png(4, 3);
    wrongLength[11] = 14;
    expect(imageInfo(wrongLength)).toBeNull();
    expect(imageInfo(png(4, 3).slice(0, 23))).toBeNull();
    expect(imageInfo(png(0, 3))).toBeNull();
    expect(imageInfo(png(4, 0))).toBeNull();
  });

  it("reads the size from a JPEG's start of frame, baseline or progressive", () => {
    expect(imageInfo(jpeg(1920, 1080))).toEqual({ type: "jpg", width: 1920, height: 1080 });
    expect(imageInfo(jpeg(640, 480, { sof: 0xc2 }))).toEqual({ type: "jpg", width: 640, height: 480 });
  });

  it("skips other segments, including large ones and huffman tables, to find the frame", () => {
    const exif = segment(0xe1, new Array(60_000).fill(7));
    const dht = segment(0xc4, new Array(20).fill(1));
    const fill = [0xff, 0xff]; // fill bytes before a marker are allowed
    expect(imageInfo(jpeg(800, 600, { before: [...exif, ...dht, ...fill] }))).toEqual({ type: "jpg", width: 800, height: 600 });
  });

  it("refuses a JPEG with no frame before the scan, a truncated one, a broken segment length or a zero side", () => {
    expect(imageInfo(bytes(0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0xff, 0xd9))).toBeNull();
    expect(imageInfo(bytes(0xff, 0xd8, 0xff, 0xd9))).toBeNull();
    expect(imageInfo(jpeg(800, 600).slice(0, 25))).toBeNull();
    expect(imageInfo(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 1))).toBeNull(); // length below 2
    expect(imageInfo(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2))).toBeNull(); // segment runs past the end
    expect(imageInfo(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 2, 0x12, 0x34))).toBeNull(); // garbage where a marker belongs
    expect(imageInfo(jpeg(0, 600))).toBeNull();
    expect(imageInfo(jpeg(800, 0))).toBeNull();
  });

  it("walks a long run of fill bytes or empty segments quickly", () => {
    const started = Date.now();
    const fill = new Uint8Array(2_000_000).fill(0xff);
    fill.set([0xff, 0xd8], 0);
    expect(imageInfo(fill)).toBeNull();
    const empties = new Uint8Array(2_000_000);
    empties.set([0xff, 0xd8]);
    for (let i = 2; i + 4 <= empties.length; i += 4) empties.set([0xff, 0xfe, 0, 2], i);
    expect(imageInfo(empties)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns null for anything that is not PNG or JPEG", () => {
    expect(imageInfo(ascii("<html>"))).toBeNull();
    expect(imageInfo(new Uint8Array(0))).toBeNull();
  });
});

describe("checkImage", () => {
  const step = { ...STEP_IMAGE_RULE, type: "png" as const, width: 1280, height: 720 };

  it("accepts an image matching what the manifest declared", () => {
    const img = png(1280, 720);
    expect(checkImage(img, { ...step, bytes: img.length })).toEqual({ ok: true, info: { type: "png", width: 1280, height: 720 } });
  });

  it("refuses a size that differs from the declared width and height", () => {
    const r = checkImage(png(1281, 720), step);
    expect(r.ok).toBe(false);
    expect(checkImage(png(1280, 721), step).ok).toBe(false);
  });

  it("refuses a small file whose header claims a huge image", () => {
    const r = checkImage(png(100_000, 100_000), { ...STEP_IMAGE_RULE });
    expect(r).toEqual({ ok: false, error: "image is over 4096 pixels on a side" });
    expect(checkImage(png(4097, 10), { ...STEP_IMAGE_RULE }).ok).toBe(false);
    expect(checkImage(png(4096, 4096), { ...STEP_IMAGE_RULE }).ok).toBe(true);
    expect(checkImage(jpeg(10, 4097), { ...STEP_IMAGE_RULE }).ok).toBe(false);
  });

  it("refuses the wrong type, a body that is not an image, a wrong length and a file over the cap", () => {
    expect(checkImage(jpeg(1280, 720), step).ok).toBe(false);
    expect(checkImage(ascii("<html>" + " ".repeat(100)), step)).toEqual({ ok: false, error: "not a PNG or JPEG image" });
    const img = png(1280, 720);
    expect(checkImage(img, { ...step, bytes: img.length + 1 }).ok).toBe(false);
    const big = new Uint8Array(2_000_001);
    big.set(png(1280, 720));
    expect(checkImage(big, step)).toEqual({ ok: false, error: "image is over 2000000 bytes" });
  });

  it("applies the logo's own caps: 200,000 bytes and 512 pixels", () => {
    expect(checkImage(png(512, 128), LOGO_RULE).ok).toBe(true);
    expect(checkImage(png(513, 128), LOGO_RULE).ok).toBe(false);
    expect(checkImage(jpeg(128, 513), LOGO_RULE).ok).toBe(false);
    const big = new Uint8Array(200_001);
    big.set(png(10, 10));
    expect(checkImage(big, LOGO_RULE).ok).toBe(false);
    expect(checkImage(ascii("<html>"), LOGO_RULE).ok).toBe(false);
  });

  it("an error never contains the file's content", () => {
    const r = checkImage(ascii("<script>S3CRET</script>"), step);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("S3CRET");
  });
});

describe("a shared item's first bytes", () => {
  const gifHead = (sig: string, w: number, h: number) => bytes(...ascii(sig), w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0, ...new Array(20).fill(0));
  const ftyp = (size: number, brand = "isom", pad = 64) => bytes(...be32(size), ...ascii("ftyp"), ...ascii(brand), ...be32(0), ...ascii("isom"), ...ascii("mp41"), ...new Array(pad).fill(0));

  it("knows PNG, JPEG, GIF87a, GIF89a and an MP4 ftyp box", () => {
    expect(sniffMedia(png(10, 10))).toBe("png");
    expect(sniffMedia(jpeg(10, 10))).toBe("jpg");
    expect(sniffMedia(gifHead("GIF87a", 1, 1))).toBe("gif");
    expect(sniffMedia(gifHead("GIF89a", 1, 1))).toBe("gif");
    expect(sniffMedia(ftyp(24))).toBe("mp4");
    expect(sniffMedia(ftyp(16, "mp42"))).toBe("mp4");
  });

  it("reads a GIF's size from its logical screen descriptor, and takes an MP4's from nobody", () => {
    expect(mediaInfo(gifHead("GIF89a", 640, 480))).toEqual({ type: "gif", width: 640, height: 480 });
    expect(mediaInfo(gifHead("GIF87a", 0x1234, 1))).toEqual({ type: "gif", width: 0x1234, height: 1 });
    expect(mediaInfo(png(300, 200))).toEqual({ type: "png", width: 300, height: 200 });
    expect(mediaInfo(jpeg(30, 20))).toEqual({ type: "jpg", width: 30, height: 20 });
    expect(mediaInfo(ftyp(24))).toEqual({ type: "mp4", width: null, height: null });
    // A side of 0 or a cut-off header gives nothing.
    expect(mediaInfo(gifHead("GIF89a", 0, 10))).toBeNull();
    expect(mediaInfo(ascii("GIF89a\x01"))).toBeNull();
  });

  it("refuses HTML, SVG, scripts, executables, archives, other GIF versions and implausible ftyp boxes", () => {
    for (const text of ["<!DOCTYPE html><html>", "<html><body>", "<svg xmlns='http://www.w3.org/2000/svg'>", "<?xml version='1.0'?><svg>", "#!/bin/sh\nrm -rf /", "GIF88a\x01\x00\x01\x00", "gif89a\x01\x00\x01\x00", "%PDF-1.7", ""]) {
      expect(sniffMedia(ascii(text)), text).toBeNull();
      expect(mediaInfo(ascii(text)), text).toBeNull();
    }
    expect(sniffMedia(bytes(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0, 0xb8))).toBeNull(); // an executable
    expect(sniffMedia(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0))).toBeNull(); // ELF
    expect(sniffMedia(bytes(0x50, 0x4b, 3, 4, ...new Array(30).fill(0)))).toBeNull(); // a zip
    expect(sniffMedia(ftyp(8))).toBeNull(); // too short for a brand
    expect(sniffMedia(ftyp(22))).toBeNull(); // not a whole number of brands
    expect(sniffMedia(ftyp(8192, "isom", 9000))).toBeNull(); // implausibly long
    expect(sniffMedia(ftyp(4000, "isom", 10))).toBeNull(); // longer than the bytes there are
    expect(sniffMedia(ftyp(24, "is\x00m"))).toBeNull(); // a brand that is no text
    expect(sniffMedia(bytes(...be32(24), ...ascii("moov"), ...new Array(30).fill(0)))).toBeNull(); // another box first
    expect(sniffMedia(bytes(...ascii("<ht"), ...ascii("ftyp"), ...new Array(30).fill(0x41)))).toBeNull(); // HTML with ftyp at offset 4: size is "<ht" + "f", far too large
  });
});
