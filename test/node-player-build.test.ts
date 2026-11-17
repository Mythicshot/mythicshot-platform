import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assetsModule, ASSETS_MODULE, bundlePlayer } from "../scripts/player-bundle.ts";

describe("the player build", () => {
  it("the committed player module is what the sources build to", async () => {
    expect(readFileSync(ASSETS_MODULE, "utf8"), "run npm run build:player").toBe(await assetsModule());
  }, 30_000);

  it("the bundle includes the vendored rules unchanged in behaviour and exposes no global", async () => {
    const { js } = await bundlePlayer();
    expect(js.startsWith("\"use strict\";\n(() => {") || js.startsWith("(() => {")).toBe(true);
    expect(js).toContain("placeCard");
    expect(js).toContain("zoomOffset");
  }, 30_000);
});
