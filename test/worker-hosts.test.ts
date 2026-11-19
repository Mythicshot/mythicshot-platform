/// <reference types="vite/client" />
// The Cloudflare target's two address settings: what hostsFromWorkerEnv makes of the
// Worker's vars, and what the Worker answers on a pair it cannot use. No test here needs
// a database or a bucket, so the same file runs under both configurations.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hosts, HostsResult } from "../src/hosts.ts";
import type { Deps } from "../src/ports.ts";

type HostVars = { TOURS_HOST?: unknown; APP_HOST?: unknown };
type Entry = {
  hostsFromWorkerEnv(env: HostVars): HostsResult;
  depsFromEnv(env: Record<string, unknown>, hosts: Hosts | null, storageAllowanceBytes?: number | null): Deps;
  allowanceFromWorkerEnv(env: { STORAGE_ALLOWANCE_BYTES?: unknown }): { ok: true; bytes: number | null } | { ok: false; problem: string };
  default: { fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Response | Promise<Response> };
};

// src/cloudflare is outside the Node type check (it uses the Workers types), so the
// module is loaded through a glob and given its shape here.
const ENTRY_PATH = "../src/cloudflare/entry.ts";
const load = import.meta.glob("../src/cloudflare/entry.ts");
const entry = (await load[ENTRY_PATH]()) as Entry;

const ONLY_TOURS = "TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one.";
const ONLY_APP = "APP_HOST is set but TOURS_HOST is not. Set both for two addresses, or neither for one.";
const BAD_TOURS = "TOURS_HOST is not a host name. Write it like tours.example.com, without https:// and without a path.";
const BAD_APP = "APP_HOST is not a host name. Write it like app.example.com, without https:// and without a path.";
const SAME = "TOURS_HOST and APP_HOST name the same host. Two addresses need two different host names.";

/** Each bad pair with its problem; `secret` is a made-up part of a value that must never be logged. */
const BAD_PAIRS: [string, HostVars, string][] = [
  ["the tours address alone", { TOURS_HOST: "made-up-tours.example.com", APP_HOST: "" }, ONLY_TOURS],
  ["the app address alone", { APP_HOST: "made-up-app.example.com" }, ONLY_APP],
  ["a tours address that is not a host name", { TOURS_HOST: "https://made-up-tours.example.com", APP_HOST: "app.example.com" }, BAD_TOURS],
  ["an app address that is not a host name", { TOURS_HOST: "tours.example.com", APP_HOST: "made-up-app.example.com/setup" }, BAD_APP],
  ["the same name twice", { TOURS_HOST: "made-up.example.com:8443", APP_HOST: "Made-Up.Example.com." }, SAME],
];

/** Stand-ins for the bindings: any use of one fails the request, so a test that passes used none. */
const untouched = (name: string) =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(`the ${name} binding was used`);
      },
    },
  );
const bindings = () => ({ DB: untouched("DB"), DRAFTS: untouched("DRAFTS"), PUB: untouched("PUB"), PUBLIC_IMAGE_BASE: "" });
const CTX = {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hostsFromWorkerEnv", () => {
  it("neither var set is one-address mode", () => {
    for (const env of [{}, { TOURS_HOST: "", APP_HOST: "" }, { TOURS_HOST: "  ", APP_HOST: "" }, { TOURS_HOST: undefined, APP_HOST: undefined }]) {
      expect(entry.hostsFromWorkerEnv(env)).toEqual({ ok: true, hosts: null });
    }
  });

  it("both vars give both names normalised", () => {
    expect(entry.hostsFromWorkerEnv({ TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" })).toEqual({ ok: true, hosts: { tours: "tours.example.com", app: "app.example.com" } });
    expect(entry.hostsFromWorkerEnv({ TOURS_HOST: " Tours.Example.com. ", APP_HOST: "app.example.com:443" })).toEqual({ ok: true, hosts: { tours: "tours.example.com", app: "app.example.com" } });
  });

  it("each bad pair gives its problem", () => {
    for (const [label, env, problem] of BAD_PAIRS) expect(entry.hostsFromWorkerEnv(env), label).toEqual({ ok: false, problem });
  });
});

/** A var that is present but is not text (a JSON var, or a binding under that name) is never read as unset. */
const NOT_TEXT: [string, HostVars, string][] = [
  ["a number for the tours address", { TOURS_HOST: 42, APP_HOST: "app.example.com" }, BAD_TOURS],
  ["an object for the app address", { TOURS_HOST: "tours.example.com", APP_HOST: { host: "made-up-app.example.com" } }, BAD_APP],
  ["null for the tours address, the app address unset", { TOURS_HOST: null }, BAD_TOURS],
  ["false for the app address, the tours address empty", { TOURS_HOST: "", APP_HOST: false }, BAD_APP],
  ["a list for both", { TOURS_HOST: ["made-up-tours.example.com"], APP_HOST: ["made-up-app.example.com"] }, BAD_TOURS],
];

describe("a var that is present but not text", () => {
  it("is a bad pair, not an unset one", () => {
    for (const [label, env, problem] of NOT_TEXT) expect(entry.hostsFromWorkerEnv(env), label).toEqual({ ok: false, problem });
  });

  it("answers 500 misconfigured, health included, and logs the fixed line", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [label, vars, problem] of NOT_TEXT) {
      for (const url of ["https://tours.example.com/healthz", "https://tours.example.com/api/v1/me", "https://evil.example.net/t/abc"]) {
        logged.mockClear();
        const res = await entry.default.fetch(new Request(url), { ...bindings(), ...vars }, CTX);
        expect(res.status, label).toBe(500);
        expect(await res.text(), label).toBe('{"error":"misconfigured"}');
        expect(logged.mock.calls, label).toEqual([[`hosts: ${problem}`]]);
      }
    }
  });
});

describe("the Worker with a bad pair of addresses", () => {
  const REQUESTS: [string, string][] = [
    ["GET", "https://tours.example.com/healthz"],
    ["GET", "https://tours.example.com/"],
    ["GET", "https://tours.example.com/api/v1/me"],
    ["GET", "https://tours.example.com/setup"],
    ["POST", "https://tours.example.com/setup/claim"],
    ["GET", "https://tours.example.com/t/abc"],
    ["GET", "https://tours.example.com/p/a.png"],
    ["HEAD", "https://app.example.com/healthz"],
    ["GET", "https://evil.example.net/healthz"],
    ["GET", "https://demo-platform.example-account.workers.dev/no/such/path"],
  ];

  for (const [label, vars, problem] of BAD_PAIRS) {
    it(`a bad pair answers 500 misconfigured on every path, health included, and logs one fixed line without the values (${label})`, async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const [method, url] of REQUESTS) {
        logged.mockClear();
        const res = await entry.default.fetch(new Request(url, { method, headers: { authorization: "Bearer made-up-token" } }), { ...bindings(), ...vars }, CTX);
        expect(res.status, url).toBe(500);
        expect(res.headers.get("content-type"), url).toBe("application/json");
        expect(res.headers.get("cache-control"), url).toBe("no-store");
        expect(res.headers.get("set-cookie"), url).toBeNull();
        expect(res.headers.get("access-control-allow-origin"), url).toBeNull();
        expect(await res.text(), url).toBe('{"error":"misconfigured"}');
        expect(logged.mock.calls, url).toEqual([[`hosts: ${problem}`]]);
        expect(String(logged.mock.calls[0][0]).toLowerCase(), url).not.toContain("made-up");
      }
    });
  }
});

describe("the Worker with a good pair of addresses", () => {
  const vars = { TOURS_HOST: "Tours.Example.com.", APP_HOST: "app.example.com:443" };

  it("hands both addresses to the app: an unknown host is 421 and the app address redirects a tour page", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = await entry.default.fetch(new Request("https://demo-platform.example-account.workers.dev/api/v1/me", { headers: { "x-forwarded-host": "tours.example.com" } }), { ...bindings(), ...vars }, CTX);
    expect(unknown.status).toBe(421);
    expect(await unknown.text()).toBe("");
    const moved = await entry.default.fetch(new Request("https://app.example.com/t/abc?x=1"), { ...bindings(), ...vars }, CTX);
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe("https://tours.example.com/t/abc?x=1");
    for (const origin of ["https://tours.example.com", "https://app.example.com"]) {
      expect((await entry.default.fetch(new Request(`${origin}/api/v1/me`), { ...bindings(), ...vars }, CTX)).status, origin).toBe(401);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("with neither var the Worker checks no host, as before", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of [bindings(), { ...bindings(), TOURS_HOST: "", APP_HOST: "" }]) {
      for (const origin of ["https://demo-platform.example-account.workers.dev", "https://evil.example.net"]) {
        expect((await entry.default.fetch(new Request(`${origin}/api/v1/me`), env, CTX)).status, origin).toBe(401);
      }
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("depsFromEnv carries the addresses it is given and the settings it had", () => {
    const hosts = { tours: "tours.example.com", app: "app.example.com" };
    expect(entry.depsFromEnv({ ...bindings(), SETUP_CODE: " correct-horse-battery-staple " }, hosts).config).toEqual({ publicImageBase: "", setupCode: "correct-horse-battery-staple", hosts });
    expect(entry.depsFromEnv({ ...bindings(), PUBLIC_IMAGE_BASE: "https://images.example.com" }, null).config).toEqual({ publicImageBase: "https://images.example.com", setupCode: null, hosts: null });
  });
});

const BAD_ALLOWANCE = "STORAGE_ALLOWANCE_BYTES is not a number of bytes. Write digits only, such as 1073741824, or leave it out for no limit.";

/** Each value the Worker cannot use as an allowance; text ones hold a made-up part that must never be logged. */
const BAD_ALLOWANCES: [string, unknown][] = [
  ["a unit", "1GB-made-up"],
  ["a sign", "-1"],
  ["a decimal", "1.5"],
  ["past the safe range", "9007199254740992"],
  // Present but not text (a JSON var): never read as unset, which would quietly lift the limit.
  ["a number", 1073741824],
  ["null", null],
  ["an object", { bytes: "made-up" }],
];

describe("the Worker's storage allowance", () => {
  const REQUESTS: [string, string][] = [
    ["GET", "https://tours.example.com/healthz"],
    ["GET", "https://tours.example.com/"],
    ["GET", "https://tours.example.com/api/v1/me"],
    ["POST", "https://tours.example.com/api/v1/uploads"],
    ["GET", "https://tours.example.com/setup"],
    ["GET", "https://tours.example.com/t/abc"],
    ["GET", "https://tours.example.com/p/a.png"],
    ["HEAD", "https://app.example.com/healthz"],
    ["GET", "https://demo-platform.example-account.workers.dev/no/such/path"],
  ];

  it("a bad allowance answers 500 misconfigured on every path", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [label, value] of BAD_ALLOWANCES) {
      // With one address and with a good pair of addresses alike.
      for (const hosts of [{}, { TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" }]) {
        for (const [method, url] of REQUESTS) {
          logged.mockClear();
          const res = await entry.default.fetch(new Request(url, { method, headers: { authorization: "Bearer made-up-token" } }), { ...bindings(), ...hosts, STORAGE_ALLOWANCE_BYTES: value }, CTX);
          expect(res.status, `${label} ${url}`).toBe(500);
          expect(res.headers.get("content-type"), label).toBe("application/json");
          expect(res.headers.get("cache-control"), label).toBe("no-store");
          expect(await res.text(), label).toBe('{"error":"misconfigured"}');
          // One fixed line, without the value; no binding was used (each would have thrown).
          expect(logged.mock.calls, label).toEqual([[`storage: ${BAD_ALLOWANCE}`]]);
          expect(String(logged.mock.calls[0][0]).toLowerCase(), label).not.toContain("made-up");
        }
      }
    }
  });

  it("no allowance, or an empty one, leaves the Worker as it was", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const extra of [{}, { STORAGE_ALLOWANCE_BYTES: "" }, { STORAGE_ALLOWANCE_BYTES: "  " }, { STORAGE_ALLOWANCE_BYTES: undefined }]) {
      expect((await entry.default.fetch(new Request("https://tours.example.com/api/v1/me"), { ...bindings(), ...extra }, CTX)).status).toBe(401);
    }
    // A good one serves too.
    expect((await entry.default.fetch(new Request("https://tours.example.com/api/v1/me"), { ...bindings(), STORAGE_ALLOWANCE_BYTES: "1073741824" }, CTX)).status).toBe(401);
    expect(logged).not.toHaveBeenCalled();
  });

  it("allowanceFromWorkerEnv reads the var, and depsFromEnv carries the number", () => {
    expect(entry.allowanceFromWorkerEnv({})).toEqual({ ok: true, bytes: null });
    expect(entry.allowanceFromWorkerEnv({ STORAGE_ALLOWANCE_BYTES: "" })).toEqual({ ok: true, bytes: null });
    expect(entry.allowanceFromWorkerEnv({ STORAGE_ALLOWANCE_BYTES: "0" })).toEqual({ ok: true, bytes: 0 });
    expect(entry.allowanceFromWorkerEnv({ STORAGE_ALLOWANCE_BYTES: "1073741824" })).toEqual({ ok: true, bytes: 1_073_741_824 });
    for (const [label, value] of BAD_ALLOWANCES) expect(entry.allowanceFromWorkerEnv({ STORAGE_ALLOWANCE_BYTES: value }), label).toEqual({ ok: false, problem: BAD_ALLOWANCE });
    const hosts = { tours: "tours.example.com", app: "app.example.com" };
    expect(entry.depsFromEnv(bindings(), hosts, 1_073_741_824).config).toEqual({ publicImageBase: "", setupCode: null, hosts, storageAllowanceBytes: 1_073_741_824 });
    expect(entry.depsFromEnv(bindings(), null, 0).config).toEqual({ publicImageBase: "", setupCode: null, hosts: null, storageAllowanceBytes: 0 });
    // No limit: the config is exactly what it was before the setting existed.
    expect(Object.keys(entry.depsFromEnv(bindings(), null, null).config).sort()).toEqual(["hosts", "publicImageBase", "setupCode"]);
    expect(Object.keys(entry.depsFromEnv(bindings(), null).config).sort()).toEqual(["hosts", "publicImageBase", "setupCode"]);
  });
});
