// src/brand-assets.ts is generated from src/brand-files/ (scripts/build-brand.ts) and must be
// current; the files there are the brand's own, the fonts with their licences beside them.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { brandFile, brandModule, BRAND_MODULE } from "../scripts/brand-bundle.ts";
import { icoOf } from "../scripts/build-icons.ts";

describe("the brand's generated module", () => {
  it("is current: npm run build:brand would write exactly what is committed", () => {
    expect(readFileSync(BRAND_MODULE, "utf8")).toBe(brandModule());
  });

  it("holds the brand's files: the two marks, the ICO, the two fonts and their licences, all under src/brand-files/", () => {
    for (const name of ["mythicshot-mark-small.svg", "mythicshot-mark.svg", "favicon.ico", "fonts/manrope/Manrope-VariableFont_wght.ttf", "fonts/manrope/OFL.txt", "fonts/cinzel/Cinzel-VariableFont_wght.ttf", "fonts/cinzel/OFL.txt"]) expect(brandFile(name).length, name).toBeGreaterThan(400);
    // The marks as the brand gives them: the small one's three purple faces, gold front and lens.
    const small = brandFile("mythicshot-mark-small.svg").toString("utf8");
    expect(small.match(/fill="#6D4AE8"/g)).toHaveLength(3);
    expect(small).toContain('fill="#F5B841"');
    expect(small).toContain('fill="#16121C"');
  });

  it("the ICO is three PNGs, 16, 32 and 48 pixels, and icoOf writes the header every reader expects", () => {
    const ico = new Uint8Array(brandFile("favicon.ico"));
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    const pngs = [0, 1, 2].map((k) => ({ size: ico[6 + 16 * k], png: ico.slice(view.getUint32(6 + 16 * k + 12, true), view.getUint32(6 + 16 * k + 12, true) + view.getUint32(6 + 16 * k + 8, true)) }));
    expect(pngs.map((p) => p.size)).toEqual([16, 32, 48]);
    for (const p of pngs) {
      const v = new DataView(p.png.buffer, p.png.byteOffset, p.png.byteLength);
      expect([v.getUint32(16), v.getUint32(20)], String(p.size)).toEqual([p.size, p.size]);
    }
    // Writing the same PNGs again gives the same file.
    expect(Buffer.from(icoOf(pngs)).equals(Buffer.from(ico))).toBe(true);
  });

  it("the fonts as base64 add a known amount to the Worker's script", () => {
    const text = brandModule();
    const gz = gzipSync(Buffer.from(text, "utf8"), { level: 9 }).length;
    console.log(`brand module: ${text.length} bytes, ${gz} gzipped`);
    expect(gz).toBeLessThan(330_000);
  });
});
