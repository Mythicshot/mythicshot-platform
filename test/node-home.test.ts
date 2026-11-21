// HOME_URL on the Node target: read from the environment into the config, listed in
// NODE_SETTINGS, and a value that cannot be used stops the start with its one line. Also the
// mark's file in the repository and the module that carries its bytes, and where the setting
// is passed on and written down. The validation table and the pages are in test/home.test.ts,
// on both targets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MARK_PNG } from "../src/dash/mark.ts";
import { HOME_URL_UNUSABLE } from "../src/https-address.ts";
import { NODE_SETTINGS, configFromEnv } from "../src/node/config.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("HOME_URL on Node", () => {
  it("reaches the config when usable; unset or empty leaves it out", () => {
    expect(configFromEnv({ HOME_URL: " https://www.example.com " }).homeUrl).toBe("https://www.example.com/");
    expect(configFromEnv({ HOME_URL: "http://localhost:3000/" }).homeUrl).toBe("http://localhost:3000/");
    for (const v of [undefined, "", "   "]) {
      expect(() => configFromEnv({ HOME_URL: v }), String(v)).not.toThrow();
      expect("homeUrl" in configFromEnv({ HOME_URL: v }), String(v)).toBe(false);
    }
    expect(NODE_SETTINGS).toContain("HOME_URL");
  });

  it("a value that cannot be used stops the start with the one fixed line, which holds no value", () => {
    for (const v of ["http://made-up.example.com/", "javascript:alert(1)", "https://u:made-up@example.com/", "https://www.example.com/#made-up", "www.example.com"]) {
      expect(() => configFromEnv({ HOME_URL: v }), v).toThrow(new Error(HOME_URL_UNUSABLE));
    }
    expect(HOME_URL_UNUSABLE).not.toContain("made-up");
    // The entry writes a start-up error's message alone, as one line, and exits.
    expect(read("../src/node/entry.ts")).toContain('console.error(err instanceof Error ? err.message : "startup failed");');
  });

  it("is passed on by the cPanel startup file, the tunnel stack and its copy in install.sh, and kept by the Cloudflare update", () => {
    expect(read("../deploy/cpanel/app.cjs")).toContain("HOME_URL");
    expect(read("../deploy/tunnel/docker-compose.yml")).toContain("      HOME_URL: ${HOME_URL:-}\n");
    expect(read("../deploy/install.sh")).toContain("      HOME_URL: ${HOME_URL:-}\n");
    expect(read("../scripts/setup-cloudflare.ts")).toMatch(/const KEPT_VARS = \[[^\]]*"HOME_URL"[^\]]*\] as const;/);
  });

  it("is written down for every target and in the browser check", () => {
    for (const guide of ["../docs/hosting/cpanel.md", "../docs/runbook-docker.md", "../docs/runbook-cloudflare.md", "../docs/dashboard-browser-check.md"]) expect(read(guide), guide).toContain("HOME_URL");
    // One line for the settings file in the cPanel guide.
    expect(read("../docs/hosting/cpanel.md")).toMatch(/^HOME_URL=/m);
  });
});

describe("the mark's file", () => {
  it("is src/dash/mark.png in the repository, and the module carries exactly its bytes", () => {
    const file = readFileSync(fileURLToPath(new URL("../src/dash/mark.png", import.meta.url)));
    expect(file.length).toBeGreaterThan(0);
    expect(Buffer.from(MARK_PNG).equals(file)).toBe(true);
  });
});
