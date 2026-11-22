// The brand's files and what the pages say about them: the fonts with their licences, the
// tab icon and the mark, each on the addresses whose pages use it and nowhere else, with no
// database or storage call; every page family's full policy, which only gains font-src 'self';
// and the tab icon's links on the platform's own pages.
import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { FAVICON_ICO, MANROPE_ETAG, MANROPE_LICENCE, MANROPE_PATH, MANROPE_TTF, MARK_SMALL_SVG, WORDMARK_DARK_PNG, WORDMARK_HEIGHT, WORDMARK_LIGHT_PNG, WORDMARK_WIDTH } from "../src/brand-assets.ts";
import { FAVICON_ICO_PATH, FAVICON_LINKS, FAVICON_SVG_PATH, MANROPE_LICENCE_PATH, PICTURE_CSP } from "../src/brand-routes.ts";
import { MARK_PATH, WORDMARK_DARK_PATH, WORDMARK_HTML, WORDMARK_LIGHT_PATH } from "../src/brand.ts";
import { DASH_LINK_PAGES, DASH_PAGES, TERMS_PAGE } from "../src/dash/routes.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { DOCS_CSP } from "../src/docs/page.ts";
import { DOCS_CSS } from "../src/docs/site-assets.ts";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { SHARE_CSS } from "../src/media-assets.ts";
import { RESTRICTED_FILE_CSP, SHARE_FILE_CSP, SHARE_NOT_FOUND_HTML, SHARE_PAGE_CSP } from "../src/media-page.ts";
import { MEDIA_DENIED_HTML, MEDIA_GATE_HTML, MEDIA_LINK_HTML, MEDIA_SIGNOUT_HTML } from "../src/media-view-page.ts";
import { contentSecurityPolicy, NOT_FOUND_HTML } from "../src/page.ts";
import { ACCOUNT_PAGE_HEADERS } from "../src/pages.ts";
import { PLAYER_CSS } from "../src/player/assets.ts";
import { RESTRICTED_PAGE_CSP } from "../src/restricted.ts";
import { SETUP_CSS, SETUP_HTML } from "../src/setup/page.ts";
import { INVITE_HTML } from "../src/signin/accept.ts";
import { LINK_HTML, SIGNIN_CSS, SIGNIN_HTML } from "../src/signin/page.ts";
import { SHARED_CSS, VIEW_CSS, VIEW_DENIED_HTML, VIEW_GATE_HTML, VIEW_LINK_HTML, VIEW_SIGNOUT_HTML } from "../src/view-page.ts";
import { send } from "./bundle.ts";

const TWO: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...TWO, img: "img.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const IMG = "https://img.example.com";
const UNKNOWN = "https://evil.example.net";
/** Two byte arrays with the same bytes. */
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const NOT_FOUND = '{"error":"not_found"}';

/** Every page family's policy, written out in full. Each is 0.1.53's with `font-src 'self'` after style-src, and nothing else changed. */
const POLICY = {
  account: "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  tour: "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'",
  tourWithBase: "default-src 'none'; img-src https://pub.example.com; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'",
  restrictedTour: "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  share: "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  docs: "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
/** 0.1.53's policies, to show the one difference. */
const BEFORE = {
  account: "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  tour: "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'",
  tourWithBase: "default-src 'none'; img-src https://pub.example.com; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'",
  restrictedTour: "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  share: "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  docs: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** The pixels of an 8-bit RGBA PNG, unfiltered, through the platform's own DecompressionStream. */
async function rgbaOf(png: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const [width, height] = [view.getUint32(16), view.getUint32(20)];
  const parts: Uint8Array[] = [];
  for (let at = 8; at < png.length; at += 12 + view.getUint32(at)) if (String.fromCharCode(...png.slice(at + 4, at + 8)) === "IDAT") parts.push(png.slice(at + 8, at + 8 + view.getUint32(at)));
  const raw = new Uint8Array(await new Response(new Blob(parts).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const kind = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * stride + x] = (v + [0, a, b, (a + b) >> 1, paeth][kind]) & 255;
    }
  }
  return out;
}

describe("the pages' policies", () => {
  it("each family's policy is 0.1.53's with font-src 'self' after style-src, every other directive as it was", () => {
    expect(ACCOUNT_PAGE_HEADERS["content-security-policy"]).toBe(POLICY.account);
    expect(contentSecurityPolicy("")).toBe(POLICY.tour);
    expect(contentSecurityPolicy("https://pub.example.com/")).toBe(POLICY.tourWithBase);
    expect(RESTRICTED_PAGE_CSP).toBe(POLICY.restrictedTour);
    expect(SHARE_PAGE_CSP).toBe(POLICY.share);
    expect(DOCS_CSP).toBe(POLICY.docs);
    for (const k of Object.keys(POLICY) as (keyof typeof POLICY)[]) expect(POLICY[k], k).toBe(BEFORE[k].replace("style-src 'self'; ", "style-src 'self'; font-src 'self'; "));
  });

  it("the pages answer with them: the dashboard, sign-in, invite, gate, setup, tour, share and documentation pages", async () => {
    const { deps } = await makeDeps({ hosts: THREE, publicImageBase: "" });
    const cases: [string, string, string][] = [
      [APP, "/tours", POLICY.account],
      [APP, "/signin", POLICY.account],
      [APP, "/invite", POLICY.account],
      [APP, "/terms", POLICY.account],
      [TOURS, "/view?t=aaaaaaaaaa", POLICY.account],
      [IMG, "/s/view", POLICY.account],
      [TOURS, "/t/aaaaaaaaaa", POLICY.tour],
      [IMG, "/i/aaaaaaaaaaaaaaaaaaaa", POLICY.share],
      [APP, "/docs", POLICY.docs],
    ];
    for (const [origin, path, policy] of cases) {
      const r = await send(deps, "GET", path, { origin });
      expect(r.headers.get("content-security-policy"), path).toBe(policy);
      expect(r.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    const setup = await makeDeps({ setupCode: "brand-setup-code" });
    const wizard = await send(setup.deps, "GET", "/setup");
    expect(wizard.headers.get("content-security-policy")).toBe(POLICY.account);
  });

  it("the policies of files that are never pages keep no font-src: pictures, files and previews stay sandboxed as before", () => {
    expect(SHARE_FILE_CSP).toBe("default-src 'none'; sandbox");
    expect(RESTRICTED_FILE_CSP).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
  });
});

describe("the font", () => {
  it("is the brand's variable TrueType file of Manrope, with its licence and copyright line; no other font is served", () => {
    for (const [what, ttf, licence, line] of [
      ["Manrope", MANROPE_TTF(), MANROPE_LICENCE, "Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope)"],
    ] as const) {
      expect([...ttf.slice(0, 4)], what).toEqual([0, 1, 0, 0]);
      expect(licence.split("\n")[0], what).toBe(line);
      expect(licence, what).toContain("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
      // No Reserved Font Name is declared beside the copyright line, so the files may be served as they are, under their own names.
      expect(licence.split("\n").slice(0, 3).join("\n"), what).not.toContain("Reserved Font Name");
    }
    expect(MANROPE_TTF().length).toBe(164_700);
    expect(MANROPE_PATH).toMatch(/^\/fonts\/manrope\.[0-9a-f]{16}\.ttf$/);
    expect(MANROPE_ETAG.slice(1, 17)).toBe(MANROPE_PATH.slice(15, 31));
  });

  it("Manrope and its licence answer on every address whose pages use it, with no call; the name's font (Cinzel) answers nowhere", async () => {
    const three = await makeDeps({ hosts: THREE });
    const two = await makeDeps({ hosts: TWO });
    const one = await makeDeps();
    for (const [deps, origin] of [[three.deps, APP], [three.deps, TOURS], [three.deps, IMG], [two.deps, TOURS], [two.deps, APP], [one.deps, "http://localhost:3000"]] as const) {
      const font = await send(deps, "GET", MANROPE_PATH, { origin });
      expect([font.status, font.calls, font.headers.get("set-cookie")], origin).toEqual([200, 0, null]);
      expect(Object.fromEntries(font.headers.entries()), origin).toEqual({ "content-type": "font/ttf", "cache-control": "public, max-age=31536000, immutable", etag: MANROPE_ETAG, "x-content-type-options": "nosniff" });
      expect(same(font.bytes, MANROPE_TTF()), origin).toBe(true);
      const licence = await send(deps, "GET", MANROPE_LICENCE_PATH, { origin });
      expect([licence.status, licence.text, licence.calls, licence.headers.get("content-type"), licence.headers.get("cache-control")], origin).toEqual([200, MANROPE_LICENCE, 0, "text/plain; charset=utf-8", "public, max-age=86400"]);
    }
    for (const [deps, origin] of [[three.deps, APP], [three.deps, TOURS], [three.deps, IMG], [two.deps, APP], [one.deps, "http://localhost:3000"]] as const) {
      for (const path of ["/fonts/cinzel.ttf", "/fonts/cinzel.0123456789abcdef.ttf", "/fonts/cinzel-OFL.txt"]) expect((await send(deps, "GET", path, { origin })).status, `${origin}${path}`).toBe(404);
    }
    for (const path of [MANROPE_PATH, MANROPE_LICENCE_PATH]) expect((await send(three.deps, "GET", path, { origin: UNKNOWN })).status, path).toBe(421);
  });

  it("only the current file's address may be kept for good; another hash gets today's file briefly, and a matching ETag gets 304", async () => {
    const { deps } = await makeDeps();
    const other = await send(deps, "GET", "/fonts/manrope.0123456789abcdef.ttf");
    expect([other.status, other.headers.get("cache-control"), other.bytes.length]).toEqual([200, "public, max-age=300", MANROPE_TTF().length]);
    const plain = await send(deps, "GET", "/fonts/manrope.ttf");
    expect([plain.status, plain.headers.get("cache-control")]).toEqual([200, "public, max-age=300"]);
    const again = await send(deps, "GET", MANROPE_PATH, { headers: { "if-none-match": MANROPE_ETAG } });
    expect([again.status, again.bytes.length, again.headers.get("etag")]).toEqual([304, 0, MANROPE_ETAG]);
    for (const path of ["/fonts/manrope.TTF", "/fonts/manrope.0123.ttf", "/fonts/other.ttf", "/fonts/manrope.0123456789abcdef.woff2"]) expect((await send(deps, "GET", path)).status, path).toBe(404);
  });

  it("is declared with font-display: swap and a system font behind it, by the address the app serves, and no stylesheet declares another font", () => {
    for (const [what, css] of [["dash", DASH_CSS], ["signin", SIGNIN_CSS], ["view", VIEW_CSS], ["share", SHARE_CSS], ["setup", SETUP_CSS], ["docs", DOCS_CSS], ["player", PLAYER_CSS]] as const) {
      expect(css, what).toContain(`src: url("${MANROPE_PATH}") format("truetype");`);
      expect(css, what).toContain("font-display: swap;");
      expect([...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]), what).toEqual([MANROPE_PATH]);
      expect(css.match(/@font-face/g), what).toHaveLength(1);
      expect(css, what).not.toMatch(/cinzel|--font-display/i);
    }
    expect(SHARED_CSS).not.toContain("@font-face");
  });
});

describe("the tab icon, the mark and the wordmark", () => {
  it("the tab icon answers on every address, as SVG and as ICO, with no call, and never on an unknown host", async () => {
    const three = await makeDeps({ hosts: THREE });
    const one = await makeDeps();
    for (const [deps, origin] of [[three.deps, APP], [three.deps, TOURS], [three.deps, IMG], [one.deps, "http://localhost:3000"]] as const) {
      const svg = await send(deps, "GET", FAVICON_SVG_PATH, { origin });
      expect([svg.status, svg.text, svg.calls], origin).toEqual([200, MARK_SMALL_SVG, 0]);
      expect(Object.fromEntries(svg.headers.entries()), origin).toEqual({ "content-type": "image/svg+xml", "cache-control": "public, max-age=3600", "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff" });
      const ico = await send(deps, "GET", FAVICON_ICO_PATH, { origin });
      expect([ico.status, ico.calls, ico.headers.get("content-type"), ico.headers.get("cache-control")], origin).toEqual([200, 0, "image/x-icon", "public, max-age=3600"]);
      expect(same(ico.bytes, FAVICON_ICO()), origin).toBe(true);
    }
    expect((await send(three.deps, "GET", FAVICON_ICO_PATH, { origin: UNKNOWN })).status).toBe(421);
    // Three sizes, 16, 32 and 48 pixels, each a PNG.
    const ico = FAVICON_ICO();
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 3]);
    expect([0, 1, 2].map((k) => ico[6 + 16 * k])).toEqual([16, 32, 48]);
    for (const k of [0, 1, 2]) expect([...ico.slice(view.getUint32(6 + 16 * k + 12, true), view.getUint32(6 + 16 * k + 12, true) + 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("the mark is the brand's small mark as SVG, on the app address only, as the PNG was, with a picture's policy: it runs nothing opened on its own", async () => {
    expect(MARK_PATH).toBe("/dash/mark.svg");
    expect(MARK_SMALL_SVG.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img">')).toBe(true);
    expect(MARK_SMALL_SVG).not.toMatch(/<script|on[a-z]+=|href|<style|url\(/i);
    expect(HOST_RULES["GET /dash/mark.svg"]).toBe("app");
    expect(HOST_RULES["GET /dash/mark.png"]).toBeUndefined();
    const { deps } = await makeDeps({ hosts: THREE });
    const r = await send(deps, "GET", MARK_PATH, { origin: APP });
    expect([r.status, r.text, r.calls]).toEqual([200, MARK_SMALL_SVG, 0]);
    expect(Object.fromEntries(r.headers.entries())).toEqual({ ...ACCOUNT_PAGE_HEADERS, "content-security-policy": "default-src 'none'; sandbox", "content-type": "image/svg+xml" });
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(PICTURE_CSP).toBe("default-src 'none'; sandbox");
    for (const origin of [TOURS, IMG]) expect((await send(deps, "GET", MARK_PATH, { origin })).text, origin).toBe(NOT_FOUND);
    expect((await send(deps, "GET", "/dash/mark.png", { origin: APP })).status).toBe(404);
  });

  it("the wordmark is two PNG pictures, gold for dark grounds and ink for light ones, at three times its size, on the app address only, with a picture's policy", async () => {
    expect([WORDMARK_DARK_PATH, WORDMARK_LIGHT_PATH]).toEqual(["/dash/wordmark-dark.png", "/dash/wordmark-light.png"]);
    expect([WORDMARK_WIDTH, WORDMARK_HEIGHT]).toEqual([153, 24]);
    const { deps } = await makeDeps({ hosts: THREE });
    for (const [path, png, colour] of [[WORDMARK_DARK_PATH, WORDMARK_DARK_PNG(), [0xf5, 0xb8, 0x41]], [WORDMARK_LIGHT_PATH, WORDMARK_LIGHT_PNG(), [0x1d, 0x18, 0x28]]] as const) {
      const r = await send(deps, "GET", path, { origin: APP });
      expect([r.status, r.calls], path).toEqual([200, 0]);
      expect(same(r.bytes, png), path).toBe(true);
      expect(Object.fromEntries(r.headers.entries()), path).toEqual({ ...ACCOUNT_PAGE_HEADERS, "content-security-policy": "default-src 'none'; sandbox", "content-type": "image/png" });
      for (const origin of [TOURS, IMG]) expect((await send(deps, "GET", path, { origin })).text, `${origin}${path}`).toBe(NOT_FOUND);
      // A PNG of IHDR, IDAT and IEND only (no text, time or other metadata), 8-bit RGBA, three times the shown size.
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      const chunks: string[] = [];
      for (let at = 8; at < png.length; at += 12 + view.getUint32(at)) chunks.push(String.fromCharCode(...png.slice(at + 4, at + 8)));
      expect(chunks, path).toEqual(["IHDR", "IDAT", "IEND"]);
      expect([view.getUint32(16), view.getUint32(20), png[24], png[25]], path).toEqual([WORDMARK_WIDTH * 3, WORDMARK_HEIGHT * 3, 8, 6]);
      // Its colour is the wordmark token's of that scheme: every pixel is that colour, only its alpha varies.
      const pixels = await rgbaOf(png);
      const seen = new Set<string>();
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 0) seen.add([pixels[i], pixels[i + 1], pixels[i + 2]].join());
      expect([...seen], path).toEqual([colour.join()]);
    }
    for (const path of ["/dash/wordmark.png", "/dash/wordmark-dark.svg", "/dash/wordmark-blue.png"]) expect((await send(deps, "GET", path, { origin: APP })).status, path).toBe(404);
    expect(WORDMARK_HTML).toBe(`<picture><source srcset="/dash/wordmark-dark.png" media="(prefers-color-scheme: dark)"><img src="/dash/wordmark-light.png" alt="Mythicshot" width="153" height="24"></picture>`);
  });

  it("every new route is in the host rules and left out of the API description with its reason", () => {
    const every = [`GET /favicon.svg`, `GET /favicon.ico`, "GET /fonts/:file{manrope(?:\\.[0-9a-f]{16})?\\.ttf}", "GET /fonts/manrope-OFL.txt"];
    const app = ["GET /dash/mark.svg", "GET /dash/wordmark-dark.png", "GET /dash/wordmark-light.png"];
    for (const key of every) expect(HOST_RULES[key], key).toBe("every");
    for (const key of app) expect(HOST_RULES[key], key).toBe("app");
    for (const key of [...every, ...app]) expect(UNDOCUMENTED_ROUTES[key]?.length ?? 0, key).toBeGreaterThan(10);
  });

  it("the platform's own pages link the tab icon; the pages that show what people publish keep their bytes and get /favicon.ico by the browser's own request", () => {
    expect(FAVICON_LINKS).toBe('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    const linked = [
      ...[...DASH_PAGES, ...DASH_LINK_PAGES, TERMS_PAGE].map((p) => [p.path, p.html] as const),
      ["/signin", SIGNIN_HTML], ["/signin/link", LINK_HTML], ["/invite", INVITE_HTML], ["/setup", SETUP_HTML],
    ] as const;
    for (const [what, html] of linked) {
      expect(html.split(FAVICON_LINKS).length - 1, what).toBe(1);
      expect(html.indexOf(FAVICON_LINKS), what).toBeLessThan(html.indexOf("</head>"));
    }
    // The pages on the tours and img addresses, whose bytes the upgrade keeps: no icon markup.
    const kept = [
      ["tour not found", NOT_FOUND_HTML], ["share not found", SHARE_NOT_FOUND_HTML],
      ["gate", VIEW_GATE_HTML], ["denied", VIEW_DENIED_HTML], ["view link", VIEW_LINK_HTML], ["view signout", VIEW_SIGNOUT_HTML],
      ["media gate", MEDIA_GATE_HTML.image], ["media gate clip", MEDIA_GATE_HTML.clip], ["media denied", MEDIA_DENIED_HTML.image], ["media link", MEDIA_LINK_HTML], ["media signout", MEDIA_SIGNOUT_HTML],
    ] as const;
    for (const [what, html] of kept) expect(html, what).not.toContain('rel="icon"');
  });

  it("the API documentation page links the tab icon too", async () => {
    const { deps } = await makeDeps({ hosts: TWO });
    const page = await send(deps, "GET", "/docs", { origin: APP });
    expect(page.text.split(FAVICON_LINKS).length - 1).toBe(1);
  });
});
