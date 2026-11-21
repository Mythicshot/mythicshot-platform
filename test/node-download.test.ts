// DOWNLOAD_URL on the Node target: read from the environment into the config, listed in
// NODE_SETTINGS, never a reason to stop, and said in one fixed line by the entry when it
// cannot be used. The validation table itself is in test/download.test.ts, on both targets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOWNLOAD_URL_UNUSABLE } from "../src/https-address.ts";
import { NODE_SETTINGS, configFromEnv } from "../src/node/config.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("DOWNLOAD_URL on Node", () => {
  it("reaches the config when usable; unset, empty or unusable leaves it out and never stops the start", () => {
    expect(configFromEnv({ DOWNLOAD_URL: " https://downloads.example.com/mythicshot " }).downloadUrl).toBe("https://downloads.example.com/mythicshot");
    for (const v of [undefined, "", "   ", "http://downloads.example.com/", "javascript:alert(1)", "https://u:p@downloads.example.com/", "https://downloads.example.com/#x"]) {
      expect(() => configFromEnv({ DOWNLOAD_URL: v }), String(v)).not.toThrow();
      expect("downloadUrl" in configFromEnv({ DOWNLOAD_URL: v }), String(v)).toBe(false);
    }
    expect(NODE_SETTINGS).toContain("DOWNLOAD_URL");
  });

  it("the entry writes the one fixed line for a value it cannot use, and goes on", () => {
    const entry = read("../src/node/entry.ts");
    expect(entry).toContain("const download = downloadUrlSetting(process.env.DOWNLOAD_URL);\n  if (download.problem !== null) console.error(download.problem);");
    expect(DOWNLOAD_URL_UNUSABLE).toContain("DOWNLOAD_URL");
  });

  it("is passed on by the cPanel startup file, the tunnel stack and its copy in install.sh, and kept by the Cloudflare update", () => {
    expect(read("../deploy/cpanel/app.cjs")).toContain("DOWNLOAD_URL");
    expect(read("../deploy/tunnel/docker-compose.yml")).toContain("      DOWNLOAD_URL: ${DOWNLOAD_URL:-}\n");
    expect(read("../deploy/install.sh")).toContain("      DOWNLOAD_URL: ${DOWNLOAD_URL:-}\n");
    expect(read("../scripts/setup-cloudflare.ts")).toMatch(/const KEPT_VARS = \[[^\]]*"DOWNLOAD_URL"[^\]]*\] as const;/);
    for (const guide of ["../docs/hosting/cpanel.md", "../docs/runbook-docker.md", "../docs/runbook-cloudflare.md"]) expect(read(guide), guide).toContain("DOWNLOAD_URL");
  });
});
