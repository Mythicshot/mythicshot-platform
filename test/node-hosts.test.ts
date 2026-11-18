// Real Host headers on the Node target: a real server on a free port, asked with raw
// node:http requests, so the host the app sees is the one @hono/node-server makes of the
// request. Then the real startup file, and the startup file of the cPanel route.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { createApp } from "../src/app.ts";
import { guardTarget } from "../src/node/config.ts";
import type { Config } from "../src/ports.ts";

const ENTRY = fileURLToPath(new URL("../src/node/entry.ts", import.meta.url));
const APP_CJS = fileURLToPath(new URL("../deploy/cpanel/app.cjs", import.meta.url));
const HOSTS = { tours: "tours.example.com", app: "app.example.com" };
const UNKNOWN = "evil.example.net";
const AS_TOURS = '{"ok":true,"address":"tours"}';
const AS_APP = '{"ok":true,"address":"app"}';
const NO_ROLE = '{"ok":true}';

type Answer = { status: number; body: string; headers: Record<string, string | string[] | undefined> };

/** One request on its own connection, with exactly the Host header and request target given. */
function ask(port: number, host: string, target: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: target, headers: { host, connection: "close", ...headers }, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The app behind a real server, behind the same guard src/node/entry.ts puts in front of it. */
async function listen(config: Partial<Config>): Promise<{ port: number; close: () => Promise<void> }> {
  const { deps } = await makeDeps(config);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: guardTarget(deps.config.hosts, (req) => createApp(deps).fetch(req)), port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((done) => server.close(() => done())) };
}

describe("real Host headers on the Node target, two addresses", () => {
  let port = 0;
  let close: () => Promise<void> = async () => {};
  beforeAll(async () => {
    ({ port, close } = await listen({ hosts: HOSTS }));
  });
  afterAll(() => close());

  it("Host in capitals, with a trailing dot, with :443 and with :80 all reach the tours role", async () => {
    for (const host of ["tours.example.com", "TOURS.Example.COM", "tours.example.com.", "tours.example.com:443", "tours.example.com:80", "Tours.Example.com.:443"]) {
      const r = await ask(port, host, "/healthz");
      expect(r.status, host).toBe(200);
      expect(r.body, host).toBe(AS_TOURS);
    }
    expect((await ask(port, "APP.example.com:443", "/healthz")).body).toBe(AS_APP);
  });

  it("the roles decide what each address answers, as in the matrix", async () => {
    expect((await ask(port, "tours.example.com", "/api/v1/me")).status).toBe(401);
    expect((await ask(port, "app.example.com", "/api/v1/me")).status).toBe(401);
    const moved = await ask(port, "app.example.com", "/t/abc?x=1");
    expect(moved.status).toBe(308);
    expect(moved.headers.location).toBe("https://tours.example.com/t/abc?x=1");
  });

  it("an unknown Host is 421", async () => {
    for (const host of [UNKNOWN, "tours.example.com.evil.example.net", "xtours.example.com", "tours.example.com:8443", "127.0.0.1", "localhost"]) {
      const r = await ask(port, host, "/api/v1/me");
      expect(r.status, host).toBe(421);
      expect(r.body, host).toBe("");
    }
    // Health answers on any host, without a role.
    expect((await ask(port, UNKNOWN, "/healthz")).body).toBe(NO_ROLE);
  });

  it("x-forwarded-host naming the tours host with an unknown Host is 421", async () => {
    const forged = { "x-forwarded-host": "tours.example.com", forwarded: "host=tours.example.com", "x-original-host": "tours.example.com", "x-host": "tours.example.com" };
    for (const [name, value] of Object.entries(forged)) {
      const r = await ask(port, UNKNOWN, "/api/v1/me", { [name]: value });
      expect(r.status, name).toBe(421);
    }
    const all = await ask(port, UNKNOWN, "/api/v1/me", forged);
    expect(all.status).toBe(421);
    expect(all.body).toBe("");
    expect((await ask(port, UNKNOWN, "/healthz", forged)).body).toBe(NO_ROLE);
    // On the app address the same headers do not turn a redirect into the page.
    expect((await ask(port, "app.example.com", "/t/abc", forged)).status).toBe(308);
  });

  it("an absolute request target naming the tours host with an unknown Host is 421 (or the server's own 400), never 200", async () => {
    for (const target of ["http://tours.example.com/api/v1/me", "http://tours.example.com/healthz", "https://tours.example.com/healthz", "http://tours.example.com/setup", "http://tours.example.com/t/abc"]) {
      const r = await ask(port, UNKNOWN, target);
      expect([421, 400], target).toContain(r.status);
      expect(r.body, target).not.toContain("address");
    }
    // Nor does it let the app address show what only the tours address has.
    const viaApp = await ask(port, "app.example.com", "http://tours.example.com/setup");
    expect([421, 400]).toContain(viaApp.status);
  });
});

describe("real Host headers on the Node target, one address", () => {
  it("answers on any Host as before, an absolute request target included", async () => {
    const { port, close } = await listen({});
    try {
      for (const host of ["tours.example.com", UNKNOWN, "127.0.0.1:3000"]) {
        expect((await ask(port, host, "/healthz")).body, host).toBe(NO_ROLE);
        expect((await ask(port, host, "/api/v1/me")).status, host).toBe(401);
      }
      const absolute = await ask(port, UNKNOWN, "http://tours.example.com/healthz");
      expect(absolute.status).toBe(200);
      expect(absolute.body).toBe(NO_ROLE);
    } finally {
      await close();
    }
  });
});

/** Only what Node itself needs, so nothing from the test runner's environment leaks in. */
function baseEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
  return base;
}

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

describe("the real Node startup", () => {
  const made: string[] = [];
  let child: ChildProcess | null = null;
  let stderr = "";
  afterEach(async () => {
    if (child !== null && child.exitCode === null) {
      const gone = new Promise((done) => child!.once("exit", done));
      child.kill();
      await gone;
    }
    child = null;
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Starts src/node/entry.ts with these settings on a free port and waits until it listens. */
  async function start(settings: Record<string, string>): Promise<number> {
    const root = mkdtempSync(join(tmpdir(), "dp-node-hosts-"));
    made.push(root);
    const port = await freePort();
    stderr = "";
    child = spawn(process.execPath, [ENTRY], {
      env: { ...baseEnv(), DATA_DIR: join(root, "data"), PORT: String(port), NODE_NO_WARNINGS: "1", ...settings },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      child!.stdout!.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
        if (stdout.includes(`listening on port ${port}`)) resolve();
      });
      child!.once("exit", (code) => reject(new Error(`the app stopped with code ${code}: ${stderr}`)));
    });
    return port;
  }

  it("with two addresses reads TOURS_HOST and APP_HOST, reports each role, and takes no host from the request target", async () => {
    const port = await start({ TOURS_HOST: "Tours.Example.com.", APP_HOST: "app.example.com:443" });
    expect((await ask(port, "tours.example.com", "/healthz")).body).toBe(AS_TOURS);
    expect((await ask(port, "APP.example.com", "/healthz")).body).toBe(AS_APP);
    expect((await ask(port, `127.0.0.1:${port}`, "/healthz")).body).toBe(NO_ROLE);
    expect((await ask(port, UNKNOWN, "/api/v1/me", { "x-forwarded-host": "tours.example.com" })).status).toBe(421);
    for (const target of ["http://tours.example.com/api/v1/me", "http://tours.example.com/healthz"]) {
      const r = await ask(port, UNKNOWN, target);
      expect([421, 400], target).toContain(r.status);
      expect(r.body, target).not.toContain("address");
    }
    expect(stderr).toBe("");
  }, 90_000);

  it("with one address answers an absolute request target as before", async () => {
    const port = await start({});
    const absolute = await ask(port, UNKNOWN, "http://tours.example.com/healthz");
    expect(absolute.status).toBe(200);
    expect(absolute.body).toBe(NO_ROLE);
    expect((await ask(port, UNKNOWN, "http://tours.example.com/api/v1/me")).status).toBe(401);
    expect((await ask(port, UNKNOWN, "/healthz")).body).toBe(NO_ROLE);
    expect(stderr).toBe("");
  }, 90_000);
});

describe("the cPanel startup file", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The startup file in `<home>/apps/tours` with a stand-in app that prints the two settings it was started with. */
  function started(settings: string, env: Record<string, string> = {}): { status: number | null; stderr: string; seen: Record<string, string | null> | null } {
    const home = mkdtempSync(join(tmpdir(), "dp-cpanel-hosts-"));
    made.push(home);
    const app = join(home, "apps", "tours");
    mkdirSync(join(app, "dist", "node"), { recursive: true });
    copyFileSync(APP_CJS, join(app, "app.cjs"));
    writeFileSync(join(app, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(app, "dist", "node", "entry.js"), 'const pick = (k) => process.env[k] ?? null;\nconsole.log("STARTED " + JSON.stringify({ TOURS_HOST: pick("TOURS_HOST"), APP_HOST: pick("APP_HOST") }));\n');
    writeFileSync(join(home, "apps", "tours-config.env"), settings);
    const r = spawnSync(process.execPath, [join(app, "app.cjs")], { env: { ...baseEnv(), ...env }, encoding: "utf8", timeout: 60_000, windowsHide: true });
    const line = r.stdout.split("\n").find((l) => l.startsWith("STARTED "));
    return { status: r.status, stderr: r.stderr, seen: line ? (JSON.parse(line.slice(8)) as Record<string, string | null>) : null };
  }

  it("the startup file passes TOURS_HOST and APP_HOST from the settings file", () => {
    const r = started("DATA_DIR=/home/user/apps/tours-data\nTOURS_HOST=tours.example.com\nAPP_HOST=app.example.com\n");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.seen).toEqual({ TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" });
  }, 90_000);

  it("leaves both unset when the settings file does not name them", () => {
    const r = started("DATA_DIR=/home/user/apps/tours-data\n");
    expect(r.status).toBe(0);
    expect(r.seen).toEqual({ TOURS_HOST: null, APP_HOST: null });
  }, 90_000);

  it("names the two optional settings in its header", () => {
    const header = readFileSync(APP_CJS, "utf8").split("const fs =")[0];
    expect(header).toContain("TOURS_HOST");
    expect(header).toContain("APP_HOST");
  });
});
