// The player's script and stylesheet, served by the app on both targets.
import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { PLAYER_CSS, PLAYER_CSS_ETAG, PLAYER_CSS_PATH, PLAYER_JS, PLAYER_JS_ETAG, PLAYER_JS_PATH } from "../src/player/assets.ts";
import { send } from "./bundle.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";
const SHORT = "public, max-age=300";

const FILES = [
  { plain: "/player.js", hashed: PLAYER_JS_PATH, ext: "js", type: "text/javascript; charset=utf-8", body: PLAYER_JS, etag: PLAYER_JS_ETAG },
  { plain: "/player.css", hashed: PLAYER_CSS_PATH, ext: "css", type: "text/css; charset=utf-8", body: PLAYER_CSS, etag: PLAYER_CSS_ETAG },
];

describe("the player files", () => {
  it("the hashed address names the file's content", () => {
    for (const f of FILES) {
      expect(f.hashed).toMatch(new RegExp(`^/player\\.[0-9a-f]{16}\\.${f.ext}$`));
      // The ETag is the same digest, so both change together.
      expect(f.etag.slice(1, 17)).toBe(f.hashed.split(".")[1]);
    }
  });

  it("the hashed address is cached for good, the plain one briefly, and both serve the same bytes on every target", async () => {
    const { deps } = await makeDeps();
    for (const f of FILES) {
      for (const [path, cache] of [[f.hashed, IMMUTABLE], [f.plain, SHORT]] as const) {
        const r = await send(deps, "GET", path);
        expect(r.status, path).toBe(200);
        expect(r.text).toBe(f.body);
        expect(r.headers.get("content-type")).toBe(f.type);
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        expect(r.headers.get("cache-control"), path).toBe(cache);
        expect(r.headers.get("etag")).toBe(f.etag);
        expect(r.headers.get("set-cookie")).toBeNull();
        const again = await send(deps, "GET", path, { headers: { "if-none-match": f.etag } });
        expect(again.status).toBe(304);
        expect(again.text).toBe("");
        expect(again.headers.get("cache-control")).toBe(cache);
      }
    }
  });

  it("another deploy's hash gets the current file with the short cache, never the immutable one", async () => {
    const { deps } = await makeDeps();
    for (const f of FILES) {
      const r = await send(deps, "GET", `/player.0123456789abcdef.${f.ext}`);
      expect(r.status).toBe(200);
      expect(r.text).toBe(f.body);
      expect(r.headers.get("cache-control")).toBe(SHORT);
    }
  });

  it("anything else near those names is not found", async () => {
    const { deps } = await makeDeps();
    for (const path of ["/player.ABCDEF0123456789.js", "/player.0123.js", "/player.0123456789abcdef.png", "/player..js", "/playerx.js", "/player.js.map", "/player.0123456789abcdef0.css"]) {
      expect((await send(deps, "GET", path)).status, path).toBe(404);
    }
  });

  it("need no token and ignore one", async () => {
    const { deps } = await makeDeps();
    const r = await send(deps, "GET", PLAYER_JS_PATH, { token: "dp_" + "0".repeat(40) });
    expect(r.status).toBe(200);
    expect(r.text).toBe(PLAYER_JS);
  });

  it("the script stores nothing, sends nothing and never parses text as HTML", () => {
    for (const bad of [
      /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/,
      /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/,
      /setAttribute\(\s*["']style["']/, /\.cssText/, /setAttribute\(\s*["']on/, /\bpostMessage\b/,
    ]) {
      expect(bad.test(PLAYER_JS), String(bad)).toBe(false);
    }
  });

  it("the stylesheet loads nothing from anywhere", () => {
    expect(PLAYER_CSS).not.toMatch(/url\s*\(|@import|@font-face/i);
  });
});
