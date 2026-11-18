// The Node target's settings: what configFromEnv makes of the environment, and what the
// real startup does with a bad pair of addresses.
import { spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv, guardTarget, isPathTarget } from "../src/node/config.ts";

const ENTRY = fileURLToPath(new URL("../src/node/entry.ts", import.meta.url));

const ONLY_TOURS = "TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one.";
const ONLY_APP = "APP_HOST is set but TOURS_HOST is not. Set both for two addresses, or neither for one.";
const BAD_TOURS = "TOURS_HOST is not a host name. Write it like tours.example.com, without https:// and without a path.";
const BAD_APP = "APP_HOST is not a host name. Write it like app.example.com, without https:// and without a path.";
const SAME = "TOURS_HOST and APP_HOST name the same host. Two addresses need two different host names.";

/** Each bad pair with the one line it must give. */
const BAD_PAIRS: [string, Record<string, string>, string][] = [
  ["the tours address alone", { TOURS_HOST: "tours.example.com" }, ONLY_TOURS],
  ["the app address alone", { APP_HOST: "app.example.com", TOURS_HOST: "  " }, ONLY_APP],
  ["a tours address that is not a host name", { TOURS_HOST: "https://tours.example.com", APP_HOST: "app.example.com" }, BAD_TOURS],
  ["an app address that is not a host name", { TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com/setup" }, BAD_APP],
  ["the same name twice", { TOURS_HOST: "tours.example.com:8443", APP_HOST: "Tours.Example.com." }, SAME],
];

describe("configFromEnv", () => {
  it("configFromEnv with neither setting is today's config", () => {
    expect(configFromEnv({})).toEqual({ publicImageBase: "", setupCode: null, hosts: null });
    expect(configFromEnv({ TOURS_HOST: "", APP_HOST: "   " })).toEqual({ publicImageBase: "", setupCode: null, hosts: null });
    // The two settings the app already had are read as before.
    expect(configFromEnv({ PUBLIC_IMAGE_BASE: "https://images.example.com", SETUP_CODE: "  correct-horse-battery-staple \n" })).toEqual({
      publicImageBase: "https://images.example.com",
      setupCode: "correct-horse-battery-staple",
      hosts: null,
    });
    expect(configFromEnv({ SETUP_CODE: "   " }).setupCode).toBeNull();
  });

  it("configFromEnv reads TOURS_HOST and APP_HOST", () => {
    expect(configFromEnv({ TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" }).hosts).toEqual({ tours: "tours.example.com", app: "app.example.com" });
    // As written by hand: capitals, spaces, a trailing dot and a default port are normalised.
    expect(configFromEnv({ TOURS_HOST: " Tours.Example.com. ", APP_HOST: "app.example.com:443", SETUP_CODE: "correct-horse-battery-staple" })).toEqual({
      publicImageBase: "",
      setupCode: "correct-horse-battery-staple",
      hosts: { tours: "tours.example.com", app: "app.example.com" },
    });
    expect(configFromEnv({ TOURS_HOST: "tours.localhost:8787", APP_HOST: "app.localhost:8787" }).hosts).toEqual({ tours: "tours.localhost:8787", app: "app.localhost:8787" });
  });

  it("configFromEnv throws the exact line for each bad pair", () => {
    for (const [label, env, line] of BAD_PAIRS) {
      let thrown: unknown = null;
      try {
        configFromEnv(env);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, label).toBeInstanceOf(Error);
      expect((thrown as Error).message, label).toBe(line);
    }
  });

  it("isPathTarget takes a path and nothing that names a host", () => {
    for (const ok of ["/", "/healthz", "/t/abc?x=1", "/p/a.png", "//double"]) expect(isPathTarget(ok), ok).toBe(true);
    for (const bad of ["http://tours.example.com/healthz", "https://tours.example.com/", "HTTP://tours.example.com/", "tours.example.com:443", "*", "", undefined]) expect(isPathTarget(bad), String(bad)).toBe(false);
  });
});

describe("guardTarget", () => {
  const HOSTS = { tours: "tours.example.com", app: "app.example.com" };
  const req = new Request("http://tours.example.com/healthz");
  const served = () => new Response("served");

  it("with two addresses serves a path and answers 421 to a request line that names a host, without serving it", async () => {
    let calls = 0;
    const guarded = guardTarget(HOSTS, () => (calls++, served()));
    expect(await (await guarded(req, { incoming: { url: "/healthz" } })).text()).toBe("served");
    expect(calls).toBe(1);
    for (const url of ["http://tours.example.com/healthz", "https://tours.example.com/t/abc", "*", "", undefined]) {
      const res = await guarded(req, { incoming: { url } });
      expect(res.status, String(url)).toBe(421);
      expect(await res.text(), String(url)).toBe("");
      expect(res.headers.get("cache-control"), String(url)).toBe("no-store");
    }
    expect(calls).toBe(1);
  });

  it("with one address serves every request as before", async () => {
    for (const hosts of [null, undefined]) {
      const guarded = guardTarget(hosts, served);
      for (const url of ["/healthz", "http://tours.example.com/healthz", "*", undefined]) expect(await (await guarded(req, { incoming: { url } })).text(), String(url)).toBe("served");
    }
  });
});

/** A port that was free a moment ago. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

describe("the Node startup with a bad pair of addresses", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  for (const [label, env, line] of BAD_PAIRS) {
    it(`${label}: exits 1 with only the problem line, before the data folder is touched`, async () => {
      const root = mkdtempSync(join(tmpdir(), "dp-node-config-"));
      made.push(root);
      const dataDir = join(root, "data");
      // Only what Node itself needs, so nothing from the test runner's environment leaks in.
      const base: Record<string, string> = {};
      for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
      // A free port, so a start that wrongly went on would collide with nothing.
      const port = await freePort();
      const r = spawnSync(process.execPath, [ENTRY], { env: { ...base, DATA_DIR: dataDir, PORT: String(port), NODE_NO_WARNINGS: "1", ...env }, encoding: "utf8", timeout: 60_000, windowsHide: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(line + "\n");
      expect(r.stdout).toBe("");
      expect(existsSync(dataDir)).toBe(false);
    }, 90_000);
  }
});
