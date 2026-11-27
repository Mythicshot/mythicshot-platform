// SOURCE_URL on the Node target: read from the environment into the config, listed in
// NODE_SETTINGS, and a value that cannot be used stops the start with its one line, as the
// target's other refused settings do. Also where the setting is passed on and written down.
// The validation table, the pages and the Worker's var are in test/source-link.test.ts, on
// both targets.
//
// With SOURCE_LINK_SAMPLES=1 in the environment, this file also writes static copies of the
// sign-in page and the Tours page with the footer, for a person to look at, into
// <temp>/demo-platform-source-link-samples/ (the stylesheets, the mark, the wordmark and the
// font beside them; no script). Without it nothing is written.
import { spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { SOURCE_URL_DEFAULT, SOURCE_URL_UNUSABLE } from "../src/https-address.ts";
import { NODE_SETTINGS, configFromEnv } from "../src/node/config.ts";
import { SOURCE_FOOTER, sourceFooterHtml } from "../src/source.ts";
import { send } from "./bundle.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const ENTRY = fileURLToPath(new URL("../src/node/entry.ts", import.meta.url));
const CUSTOM = "https://code.example.com/our-copy";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("SOURCE_URL on Node", () => {
  it("reaches the config when it is another usable address; unset, empty or the default leaves the config as it was", () => {
    expect(configFromEnv({ SOURCE_URL: ` ${CUSTOM} ` }).sourceUrl).toBe(CUSTOM);
    for (const v of [undefined, "", "   ", SOURCE_URL_DEFAULT]) {
      expect(configFromEnv({ SOURCE_URL: v }), String(v)).toEqual({ publicImageBase: "", setupCode: null, hosts: null });
    }
    expect(NODE_SETTINGS).toContain("SOURCE_URL");
  });

  it("a value that cannot be used throws the one fixed line, which never repeats the value", () => {
    for (const v of ["http://made-up.example.com/", "javascript:alert(1)", "https://u:made-up@example.com/", "https://www.example.com/#made-up", "www.example.com", 'https://made-up.example.com/"><b>']) {
      let thrown: unknown = null;
      try {
        configFromEnv({ SOURCE_URL: v });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, v).toBeInstanceOf(Error);
      expect((thrown as Error).message, v).toBe(SOURCE_URL_UNUSABLE);
    }
    expect(SOURCE_URL_UNUSABLE).not.toContain("made-up");
  });

  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("a value that cannot be used stops the start with one line that does not repeat the value, before the data folder is made", async () => {
    for (const raw of ["http://made-up.example.com/", "https://made-up.example.com/#x"]) {
      const root = mkdtempSync(join(tmpdir(), "dp-node-source-"));
      made.push(root);
      const dataDir = join(root, "data");
      const base: Record<string, string> = {};
      for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
      const port = await freePort();
      const r = spawnSync(process.execPath, [ENTRY], { env: { ...base, DATA_DIR: dataDir, PORT: String(port), NODE_NO_WARNINGS: "1", SOURCE_URL: raw }, encoding: "utf8", timeout: 60_000, windowsHide: true });
      expect(r.status, raw).toBe(1);
      expect(r.stderr, raw).toBe(SOURCE_URL_UNUSABLE + "\n");
      expect(r.stderr, raw).not.toContain("made-up");
      expect(r.stdout, raw).toBe("");
      expect(existsSync(dataDir), raw).toBe(false);
    }
  }, 180_000);

  it("a usable value reaches the pages", async () => {
    const { deps } = await makeDeps(configFromEnv({ SOURCE_URL: CUSTOM }));
    for (const path of ["/signin", "/tours", "/terms"]) {
      const r = await send(deps, "GET", path);
      expect([r.status, r.calls], path).toEqual([200, 0]);
      expect(r.text, path).toContain(sourceFooterHtml(CUSTOM));
      expect(r.text, path).not.toContain(SOURCE_FOOTER);
    }
  });

  it("is passed on by the cPanel startup file, the tunnel stack and its copy in install.sh, and kept by the Cloudflare update", () => {
    expect(read("../deploy/cpanel/app.cjs")).toContain("SOURCE_URL");
    for (const f of ["../deploy/tunnel/docker-compose.yml", "../deploy/install.sh"]) expect(read(f), f).toContain("      SOURCE_URL: ${SOURCE_URL:-}\n");
    // A SOURCE_URL left in the shell is taken out before Compose could read it, as HOME_URL is,
    // and deploy/test-install.sh holds that (it needs Docker's stand-ins and Bash, so it is not run here).
    expect(read("../deploy/install.sh")).toContain("unset HOME_URL\nunset SOURCE_URL\n");
    expect(read("../deploy/test-install.sh")).toContain("test_source_url_in_the_environment_does_not_reach_the_stack() {");
    expect(read("../deploy/test-install.sh")).toContain(`printf '%s\\n' "\${SOURCE_URL-unset}" >>"$STUB_STATE/up-source-url"`);
    expect(read("../scripts/setup-cloudflare.ts")).toMatch(/const KEPT_VARS = \[[^\]]*"SOURCE_URL"[^\]]*\] as const;/);
  });

  it("is written down for every target and in the browser check", () => {
    for (const guide of ["../README.md", "../docs/hosting/cpanel.md", "../docs/runbook-docker.md", "../docs/runbook-cloudflare.md"]) {
      expect(read(guide), guide).toContain("SOURCE_URL");
      expect(read(guide), guide).toContain(SOURCE_URL_UNUSABLE);
    }
    expect(read("../docs/hosting/cpanel.md")).toMatch(/^SOURCE_URL=/m);
    expect(read("../docs/dashboard-browser-check.md")).toMatch(/Source code/);
  });
});

describe("static samples for a person to look at", () => {
  const wanted = process.env.SOURCE_LINK_SAMPLES === "1";

  it.runIf(wanted)("writes the sign-in page and the Tours page with the footer, and what they load, into the temp folder", async () => {
    const out = join(tmpdir(), "demo-platform-source-link-samples");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const { deps } = await makeDeps();
    const save = (path: string, bytes: Uint8Array | string) => {
      const file = join(out, path.replace(/^\//, ""));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    };
    // Absolute paths of the app become paths beside the copy; scripts are left out, so the copy runs nothing.
    const local = (text: string) => text.replace(/(href|src|srcset)="\/(?!\/)/g, '$1="./').replace(/url\("\/(?!\/)/g, 'url("../');
    const files = ["/signin/signin.css", "/dash/dash.css", "/dash/mark.svg", "/dash/wordmark-light.png", "/dash/wordmark-dark.png", "/favicon.svg", "/favicon.ico"];
    for (const path of files) {
      const r = await send(deps, "GET", path);
      expect(r.status, path).toBe(200);
      save(path, path.endsWith(".css") ? local(r.text) : r.bytes);
    }
    const css = (await send(deps, "GET", "/dash/dash.css")).text;
    const font = /url\("(\/fonts\/[^"]+)"\)/.exec(css)?.[1];
    expect(font).toBeDefined();
    save(font!, (await send(deps, "GET", font!)).bytes);
    for (const [path, name] of [["/signin", "sample-signin.html"], ["/tours", "sample-tours.html"]] as const) {
      const r = await send(deps, "GET", path);
      expect(r.text).toContain(SOURCE_FOOTER);
      save(name, local(r.text.replace(/<script\b[^>]*><\/script>\n?/g, "")));
    }
    console.log(`samples: ${join(out, "sample-signin.html")} and ${join(out, "sample-tours.html")}`);
  });
});
