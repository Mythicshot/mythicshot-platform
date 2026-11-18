// The shared tour rules, vendored from the recorder, against the recorder's own cases.
// Node only: the file is loaded the way a page loads it, as a classic script in a bare
// context, which the Workers runtime does not allow.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** Printed by `npm run sync:core`. A change to either file must come with a new hash here. */
const CORE_SHA256 = "fb94624416ad0d6f9085659be4c48bcca956223c061566cf673f03331ce0f543";
const CASES_SHA256 = "5d3d99b1ecd37b261d6269692fbc66a5d675a49a4046720ca15dd18daf9aecdb";

const corePath = new URL("../src/player/vendor/tour-core.js", import.meta.url);
const casesPath = new URL("./fixtures/tour-core-cases.json", import.meta.url);
const src = readFileSync(corePath, "utf8");
const cases = JSON.parse(readFileSync(casesPath, "utf8"));

const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const TourCore = ctx.TourCore;

/** The cases write non-finite numbers as strings, since JSON has none. */
const n = (v: unknown) => (v === "NaN" ? NaN : v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v);
const close = (a: number, b: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(0.01);
const sha = (u: URL) => createHash("sha256").update(readFileSync(u)).digest("hex");

describe("the vendored tour rules", () => {
  it("the vendored file and its cases match the recorded hashes", () => {
    expect(sha(corePath)).toBe(CORE_SHA256);
    expect(sha(casesPath)).toBe(CASES_SHA256);
  });

  it("loads as a classic script with TourCore as its only global", () => {
    expect(Object.keys(ctx)).toEqual(["TourCore"]);
    expect(Object.keys(TourCore).sort()).toEqual(["cleanText", "color", "num", "parseBold", "placeCard", "safeUrl", "zoomOffset"]);
  });

  it("the vendored rules pass every shared case", () => {
    expect(Object.keys(cases).filter((k) => k !== "about").sort()).toEqual(["bold", "color", "place", "text", "url", "zoom"]);
    for (const c of cases.place) {
      const [x0, y0, x1, y1] = (c.avoid || []).map(n);
      // A picked spot ("aim") is passed when the case has one, as the player does.
      const aim = c.aim ? { x: n(c.aim[0]), y: n(c.aim[1]) } : undefined;
      const p = TourCore.placeCard(c.image[0], c.image[1], c.card[0], c.card[1], c.avoid && { x0, y0, x1, y1 }, c.placement, aim);
      close(p.x, c.expect.x, `${c.name} x`);
      close(p.y, c.expect.y, `${c.name} y`);
      expect(p.side, c.name).toBe(c.expect.side);
    }
    for (const c of cases.zoom) {
      const z = TourCore.zoomOffset(n(c.view[0]), n(c.view[1]), n(c.focus[0]), n(c.focus[1]), n(c.k));
      close(z.tx, c.expect.tx, `${c.name} tx`);
      close(z.ty, c.expect.ty, `${c.name} ty`);
    }
    for (const c of cases.bold) expect([...TourCore.parseBold(c.text)].map((p: { text: string; bold: boolean }) => [p.text, p.bold]), c.name).toEqual(c.expect);
    for (const c of cases.url) expect(TourCore.safeUrl(c.input), JSON.stringify(c.input)).toBe(c.expect);
    for (const c of cases.text) expect(TourCore.cleanText(c.input, c.max, c.multiline), c.name).toBe(c.expect);
    for (const c of cases.color) expect(TourCore.color(c.input, null), JSON.stringify(c.input)).toBe(c.expect);
  });

  it("the server's link rule agrees with the player's on every shared case", async () => {
    const { safeUrl } = await import("../src/manifest.ts");
    for (const c of cases.url) expect(safeUrl(c.input), JSON.stringify(c.input)).toBe(c.expect);
  });
});
