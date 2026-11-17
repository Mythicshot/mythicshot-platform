// The player's script and stylesheet, served by the app on both targets.
import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { PLAYER_CSS, PLAYER_CSS_ETAG, PLAYER_JS, PLAYER_JS_ETAG } from "../src/player/assets.ts";
import { send } from "./bundle.ts";

const FILES = [
  { path: "/player.js", type: "text/javascript; charset=utf-8", body: PLAYER_JS, etag: PLAYER_JS_ETAG },
  { path: "/player.css", type: "text/css; charset=utf-8", body: PLAYER_CSS, etag: PLAYER_CSS_ETAG },
];

describe("the player files", () => {
  it("are served with their type, nosniff, a short cache and an ETag, the same bytes on every target", async () => {
    const { deps } = await makeDeps();
    for (const f of FILES) {
      const r = await send(deps, "GET", f.path);
      expect(r.status, f.path).toBe(200);
      expect(r.text).toBe(f.body);
      expect(r.headers.get("content-type")).toBe(f.type);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("cache-control")).toBe("public, max-age=300");
      expect(r.headers.get("etag")).toBe(f.etag);
      expect(r.headers.get("set-cookie")).toBeNull();
      const again = await send(deps, "GET", f.path, { headers: { "if-none-match": f.etag } });
      expect(again.status).toBe(304);
      expect(again.text).toBe("");
    }
  });

  it("need no token and ignore one", async () => {
    const { deps } = await makeDeps();
    const r = await send(deps, "GET", "/player.js", { token: "dp_" + "0".repeat(40) });
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
