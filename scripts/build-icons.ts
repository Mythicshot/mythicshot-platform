// node scripts/build-icons.ts: makes src/brand-files/favicon.ico from the brand's marks, by
// the brand's size rule: the small mark (mythicshot-mark-small.svg) for 16 and 32 pixels,
// the standard mark (mythicshot-mark.svg) for 48. Each size is a PNG inside the ICO file,
// which every browser of the last decade reads.
//
// It borrows the `sharp` image library from node_modules, where it is installed as a
// dependency of the test tools (@cloudflare/vitest-plugin, through miniflare). The platform
// does not depend on it: the ICO is committed, so this runs only when a mark changes, and
// `npm run build:brand` (scripts/build-brand.ts) then carries the committed file into
// src/brand-assets.ts. test/node-brand-build.test.ts checks the ICO is these three PNGs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILES = fileURLToPath(new URL("../src/brand-files/", import.meta.url));
/** The sizes in the file, with the mark each is drawn from. */
export const ICON_SIZES: readonly { size: number; mark: string }[] = [
  { size: 16, mark: "mythicshot-mark-small.svg" },
  { size: 32, mark: "mythicshot-mark-small.svg" },
  { size: 48, mark: "mythicshot-mark.svg" },
];

/**
 * The mark as a picture for mails (0.1.66, the storage mail): mail apps show no SVG, so the small
 * mark is drawn once as a PNG, three times the 30 pixels the mail shows it at, and committed.
 */
export const MAIL_MARK = { size: 90, mark: "mythicshot-mark-small.svg", file: "mythicshot-mark-mail.png" } as const;

/** An ICO file holding the given PNGs, each `size` pixels square, in the order given. */
export function icoOf(images: readonly { size: number; png: Uint8Array }[]): Uint8Array {
  const header = 6;
  const entry = 16;
  let offset = header + entry * images.length;
  const total = offset + images.reduce((n, i) => n + i.png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // 1: an icon
  view.setUint16(4, images.length, true);
  images.forEach((img, k) => {
    const at = header + entry * k;
    out[at] = img.size >= 256 ? 0 : img.size; // width
    out[at + 1] = img.size >= 256 ? 0 : img.size; // height
    out[at + 2] = 0; // no palette
    out[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // colour planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, img.png.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(img.png, offset);
    offset += img.png.length;
  });
  return out;
}

async function main(): Promise<void> {
  const sharp = (await import("sharp" as string)).default as (input: Buffer, opts: { density: number }) => {
    resize(w: number, h: number): { png(opts: { compressionLevel: number; palette: boolean }): { toBuffer(): Promise<Buffer> } };
  };
  const images: { size: number; png: Uint8Array }[] = [];
  for (const { size, mark } of ICON_SIZES) {
    const svg = readFileSync(FILES + mark);
    // Drawn large, then scaled down, so the edges are smooth at every size.
    const png = await sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9, palette: false }).toBuffer();
    images.push({ size, png: new Uint8Array(png) });
  }
  writeFileSync(FILES + "favicon.ico", icoOf(images));
  console.log("wrote src/brand-files/favicon.ico");
  const mailMark = await sharp(readFileSync(FILES + MAIL_MARK.mark), { density: 384 }).resize(MAIL_MARK.size, MAIL_MARK.size).png({ compressionLevel: 9, palette: false }).toBuffer();
  writeFileSync(FILES + MAIL_MARK.file, mailMark);
  console.log(`wrote src/brand-files/${MAIL_MARK.file}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main();
