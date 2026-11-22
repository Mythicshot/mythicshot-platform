// src/brand-assets.ts is generated from src/brand-files/ (scripts/build-brand.ts) and must be
// current; the files there are the brand's own, the font with its licence beside it, and the
// wordmark's pictures are what scripts/build-wordmark.py draws, to the byte, on every run.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { brandFile, brandModule, BRAND_MODULE } from "../scripts/brand-bundle.ts";
import { icoOf } from "../scripts/build-icons.ts";

describe("the brand's generated module", () => {
  it("is current: npm run build:brand would write exactly what is committed", () => {
    expect(readFileSync(BRAND_MODULE, "utf8")).toBe(brandModule());
  });

  it("holds the brand's files: the two marks, the ICO, the wordmark's two pictures, the font and its licence, all under src/brand-files/; Cinzel only as the wordmark builder's input", () => {
    for (const name of ["mythicshot-mark-small.svg", "mythicshot-mark.svg", "favicon.ico", "wordmark-dark.png", "wordmark-light.png", "fonts/manrope/Manrope-VariableFont_wght.ttf", "fonts/manrope/OFL.txt"]) expect(brandFile(name).length, name).toBeGreaterThan(400);
    expect(existsSync(fileURLToPath(new URL("../src/brand-files/fonts/cinzel", import.meta.url)))).toBe(false);
    expect(readFileSync(new URL("../scripts/wordmark/OFL.txt", import.meta.url), "utf8").split("\n")[0]).toBe("Copyright 2020 The Cinzel Project Authors (https://github.com/NDISCOVER/Cinzel)");
    expect(readFileSync(new URL("../scripts/wordmark/Cinzel-VariableFont_wght.ttf", import.meta.url)).length).toBe(125_468);
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

  // Python with Pillow and FreeType draws the wordmark (no browser): where it is missing, the
  // committed pictures cannot be checked here, and the test says so instead of passing.
  const python = spawnSync("python", ["-c", "import PIL.features, sys; sys.exit(0 if PIL.features.check('freetype2') else 1)"], { encoding: "utf8" });
  it.skipIf(python.status !== 0)("the wordmark's pictures are what scripts/build-wordmark.py draws, the same bytes on two runs (needs Python with Pillow and FreeType)", () => {
    const outs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "demo-platform-wordmark-")));
    try {
      for (const out of outs) {
        const run = spawnSync("python", [fileURLToPath(new URL("../scripts/build-wordmark.py", import.meta.url)), out], { encoding: "utf8" });
        expect(run.status, run.stderr).toBe(0);
      }
      for (const name of ["wordmark-dark.png", "wordmark-light.png"]) {
        const [a, b] = outs.map((out) => readFileSync(join(out, name)));
        expect(a.equals(b), `${name}: two runs`).toBe(true);
        expect(a.equals(brandFile(name)), `${name}: as committed`).toBe(true);
      }
    } finally {
      for (const out of outs) rmSync(out, { recursive: true, force: true });
    }
  });

  it("the font and the pictures as base64 add a known amount to the Worker's script", () => {
    const text = brandModule();
    const gz = gzipSync(Buffer.from(text, "utf8"), { level: 9 }).length;
    console.log(`brand module: ${text.length} bytes, ${gz} gzipped`);
    expect(gz).toBeLessThan(200_000);
  });
});
