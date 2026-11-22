// HOME_URL on the Node target: read from the environment into the config, listed in
// NODE_SETTINGS, and a value that cannot be used switches the link off with one line at the
// start and never stops the site or the admin commands. Also the
// mark's file in the repository and the module that carries its bytes, and where the setting
// is passed on and written down. The validation table and the pages are in test/home.test.ts,
// on both targets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MARK_PNG } from "../src/dash/mark.ts";
import { HOME_URL_UNUSABLE } from "../src/https-address.ts";
import { NODE_SETTINGS, configFromEnv } from "../src/node/config.ts";
import { BRAND_PLAIN } from "../src/brand.ts";
import { makeDeps } from "#harness";
import { send } from "./bundle.ts";

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

  it("a value that cannot be used never stops the start: the link is left out, and the site and its health check answer", async () => {
    for (const v of ["http://made-up.example.com/", "javascript:alert(1)", "https://u:made-up@example.com/", "https://www.example.com/#made-up", "www.example.com"]) {
      expect(() => configFromEnv({ HOME_URL: v }), v).not.toThrow();
      const config = configFromEnv({ HOME_URL: v });
      expect("homeUrl" in config, v).toBe(false);
      const { deps } = await makeDeps(config);
      const health = await send(deps, "GET", "/healthz");
      expect([health.status, health.json], v).toEqual([200, { ok: true }]);
      for (const path of ["/tours", "/terms"]) {
        const page = await send(deps, "GET", path);
        expect(page.status, `${v} ${path}`).toBe(200);
        expect(page.text, `${v} ${path}`).toContain(BRAND_PLAIN);
        expect(page.text, `${v} ${path}`).not.toContain("made-up");
      }
    }
    expect(HOME_URL_UNUSABLE).not.toContain("made-up");
  });

  it("the entry writes the one fixed line for a value it cannot use, beside the download page's, and goes on", () => {
    const entry = read("../src/node/entry.ts");
    expect(entry).toContain("const download = downloadUrlSetting(process.env.DOWNLOAD_URL);\n  if (download.problem !== null) console.error(download.problem);\n");
    expect(entry).toContain("const home = homeUrlSetting(process.env.HOME_URL);\n  if (home.problem !== null) console.error(home.problem);\n");
    expect(HOME_URL_UNUSABLE).toBe("home page: off, because HOME_URL is not a usable address. The site runs; the logo is not a link.");
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

describe("what the guides say about a HOME_URL the app cannot use", () => {
  /** The paragraphs of a file that name HOME_URL (a table's row is a paragraph of its own). */
  const around = (text: string) =>
    text
      .split(/\n\s*\n/)
      .flatMap((block) => block.split(/\n(?=\|)/))
      .filter((block) => block.includes("HOME_URL"))
      .join("\n\n");

  it("no guide, comment or entry says it stops the site; each guide gives the one line", () => {
    const files = ["../README.md", "../docs/hosting/cpanel.md", "../docs/runbook-docker.md", "../docs/runbook-cloudflare.md", "../deploy/cpanel/app.cjs", "../deploy/tunnel/docker-compose.yml", "../deploy/install.sh", "../CHANGELOG.md", "../docs/dashboard-browser-check.md"];
    for (const f of files) {
      const text = around(read(f));
      expect(text.length, f).toBeGreaterThan(0);
      expect(text, f).not.toMatch(/stops? (?:the start|it from starting|the app from starting|from starting)|misconfigured|does not start|cannot be reached/);
    }
    for (const f of ["../README.md", "../docs/hosting/cpanel.md", "../docs/runbook-docker.md", "../docs/runbook-cloudflare.md", "../docs/dashboard-browser-check.md"]) expect(read(f), f).toContain(HOME_URL_UNUSABLE);
    // Both copies of the tunnel stack say the same.
    for (const f of ["../deploy/tunnel/docker-compose.yml", "../deploy/install.sh"]) expect(read(f), f).toContain("      # an https address. A value the app cannot use leaves the logo without a link.\n      HOME_URL: ${HOME_URL:-}\n");
  });

  it("the Docker runbook and the changelog tell a tunnel install from before 0.1.52 to run install once", () => {
    const sentence = "A tunnel install set up before 0.1.52 runs `sudo bash install.sh install` once before `HOME_URL` takes effect: `update` does not rewrite the stack file, and `install` does (it keeps the old one as a `.bak` copy).";
    expect(read("../docs/runbook-docker.md")).toContain(sentence);
    expect(read("../CHANGELOG.md")).toContain(sentence);
  });
});
