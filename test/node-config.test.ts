// The Node target's settings: what configFromEnv makes of the environment, and what the
// real startup does with a bad pair of addresses.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkOrigin, NO_MAIL, type Mailer } from "../src/mail.ts";
import { PROXY_HINT, clientAddressFrom, clientAddressReader, configFromEnv, guardTarget, isPathTarget, mailFromEnv, proxyHint } from "../src/node/config.ts";
import type { ClosableMailer } from "../src/node/mail-thread.ts";
import type { SmtpSettings } from "../src/node/smtp.ts";
import type { Config } from "../src/ports.ts";

const ENTRY = fileURLToPath(new URL("../src/node/entry.ts", import.meta.url));

const ONLY_TOURS = "TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one.";
const ONLY_APP = "APP_HOST is set but TOURS_HOST is not. Set both for two addresses, or neither for one.";
const BAD_TOURS = "TOURS_HOST is not a host name. Write it like tours.example.com, without https:// and without a path.";
const BAD_APP = "APP_HOST is not a host name. Write it like app.example.com, without https:// and without a path.";
const SAME = "TOURS_HOST and APP_HOST name the same host. Two addresses need two different host names.";
const ONLY_IMG = "IMG_HOST is set but TOURS_HOST and APP_HOST are not. IMG_HOST is an extra address beside those two: set them too, or leave IMG_HOST empty.";
const BAD_IMG = "IMG_HOST is not a host name. Write it like img.example.com, without https:// and without a path.";
const SAME_IMG = "APP_HOST and IMG_HOST name the same host. Two addresses need two different host names.";

/** Each bad pair with the one line it must give. */
const BAD_PAIRS: [string, Record<string, string>, string][] = [
  ["the tours address alone", { TOURS_HOST: "tours.example.com" }, ONLY_TOURS],
  ["the app address alone", { APP_HOST: "app.example.com", TOURS_HOST: "  " }, ONLY_APP],
  ["a tours address that is not a host name", { TOURS_HOST: "https://tours.example.com", APP_HOST: "app.example.com" }, BAD_TOURS],
  ["an app address that is not a host name", { TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com/setup" }, BAD_APP],
  ["the same name twice", { TOURS_HOST: "tours.example.com:8443", APP_HOST: "Tours.Example.com." }, SAME],
  ["the img address alone", { IMG_HOST: "img.example.com" }, ONLY_IMG],
  ["an img address that is not a host name", { TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com", IMG_HOST: "img.example.com/i" }, BAD_IMG],
  ["the img address naming the app address", { TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com", IMG_HOST: "App.Example.com" }, SAME_IMG],
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

  it("configFromEnv reads the optional IMG_HOST beside the other two", () => {
    expect(configFromEnv({ TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com", IMG_HOST: " IMG.Example.com. " }).hosts).toEqual({
      tours: "tours.example.com",
      app: "app.example.com",
      img: "img.example.com",
    });
    // Empty or only spaces is not set: two addresses, with no img key at all.
    for (const img of ["", "   "]) expect(Object.keys(configFromEnv({ TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com", IMG_HOST: img }).hosts!)).toEqual(["tours", "app"]);
    expect(configFromEnv({ IMG_HOST: "" }).hosts).toBeNull();
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

const BAD_ALLOWANCE = "STORAGE_ALLOWANCE_BYTES is not a number of bytes. Write digits only, such as 1073741824, or leave it out for no limit.";

describe("the storage allowance setting on the Node target", () => {
  it("configFromEnv reads STORAGE_ALLOWANCE_BYTES, and leaves the config as it was without it", () => {
    expect(configFromEnv({ STORAGE_ALLOWANCE_BYTES: "1073741824" })).toEqual({ publicImageBase: "", setupCode: null, hosts: null, storageAllowanceBytes: 1_073_741_824 });
    expect(configFromEnv({ STORAGE_ALLOWANCE_BYTES: "0" }).storageAllowanceBytes).toBe(0);
    expect(configFromEnv({ STORAGE_ALLOWANCE_BYTES: " 500 ", TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" })).toEqual({
      publicImageBase: "",
      setupCode: null,
      hosts: { tours: "tours.example.com", app: "app.example.com" },
      storageAllowanceBytes: 500,
    });
    // Unset or empty is no limit: the key is not there at all, so the config is 0.1.7's.
    for (const env of [{}, { STORAGE_ALLOWANCE_BYTES: "" }, { STORAGE_ALLOWANCE_BYTES: "  " }]) {
      const config = configFromEnv(env);
      expect(config.storageAllowanceBytes ?? null).toBeNull();
      expect(Object.keys(config).sort()).toEqual(["hosts", "publicImageBase", "setupCode"]);
    }
  });

  it("configFromEnv throws the fixed line for a bad allowance", () => {
    for (const raw of ["-1", "1.5", "1GB", "9007199254740992", "12made-up34"]) {
      let thrown: unknown = null;
      try {
        configFromEnv({ STORAGE_ALLOWANCE_BYTES: raw });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, raw).toBeInstanceOf(Error);
      expect((thrown as Error).message, raw).toBe(BAD_ALLOWANCE);
    }
  });

  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("a bad allowance stops the start with one line that does not repeat the value", async () => {
    for (const raw of ["12made-up34", "1GB", "-5"]) {
      const root = mkdtempSync(join(tmpdir(), "dp-node-config-"));
      made.push(root);
      const dataDir = join(root, "data");
      // Only what Node itself needs, so nothing from the test runner's environment leaks in.
      const base: Record<string, string> = {};
      for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
      const port = await freePort();
      const r = spawnSync(process.execPath, [ENTRY], { env: { ...base, DATA_DIR: dataDir, PORT: String(port), NODE_NO_WARNINGS: "1", STORAGE_ALLOWANCE_BYTES: raw }, encoding: "utf8", timeout: 60_000, windowsHide: true });
      expect(r.status, raw).toBe(1);
      expect(r.stderr, raw).toBe(BAD_ALLOWANCE + "\n");
      expect(r.stderr, raw).not.toContain(raw);
      expect(r.stdout, raw).toBe("");
      // Stopped before the data folder was made or the database opened.
      expect(existsSync(dataDir), raw).toBe(false);
    }
  }, 180_000);
});

const mailOff = (setting: string) => `mail: off, because ${setting} is missing or not usable. The site runs; sign-in mails are not sent.`;
const NO_LINK_HOST = "mail: off, because no address for sign-in links is set. Set APP_HOST and TOURS_HOST, or SITE_HOST.";
const BAD_HEADER = "client address: unknown, because CLIENT_ADDRESS_HEADER is not a usable header name. The site runs; no request is counted by its network address.";

/** A mail block that can be used, with a made-up password that must never be shown. */
const PASSWORD = "made-up-password-9f3c";
const BLOCK: Record<string, string> = { MAIL_MODE: "smtp", MAIL_FROM: "no-reply@example.com", SMTP_HOST: "mail.example.com", SMTP_USER: "no-reply@example.com", SMTP_PASSWORD: PASSWORD };
const TWO = { TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" };
const ONE = { SITE_HOST: "tours.example.com" };

/** mailFromEnv on this environment, with a maker that records the settings instead of making a client. */
function mailOf(env: Record<string, string>): { result: ReturnType<typeof mailFromEnv>; settings: SmtpSettings[]; made: Mailer } {
  const settings: SmtpSettings[] = [];
  const made: Mailer = { send: () => Promise.reject(new Error("a test mailer sends nothing")) };
  const result = mailFromEnv(env, configFromEnv(env), (s) => {
    settings.push(s);
    return made;
  });
  return { result, settings, made };
}

describe("the link host setting on the Node target", () => {
  it("configFromEnv reads SITE_HOST for a one-address install, and leaves the config as it was without it", () => {
    expect(configFromEnv({ SITE_HOST: " Tours.Example.com. " })).toEqual({ publicImageBase: "", setupCode: null, hosts: null, siteHost: "tours.example.com" });
    expect(linkOrigin(configFromEnv({ SITE_HOST: "tours.example.com:443" }))).toBe("https://tours.example.com");
    expect(linkOrigin(configFromEnv({ SITE_HOST: "localhost:3000" }))).toBe("http://localhost:3000");
    // Unset, empty, or not a host name: the key is not there, the start goes on, and there is no link host.
    for (const env of [{}, { SITE_HOST: "" }, { SITE_HOST: "  " }, { SITE_HOST: "https://made-up.example.com" }, { SITE_HOST: "made-up.example.com/path" }, { SITE_HOST: "made up" }]) {
      const config = configFromEnv(env);
      expect(Object.keys(config).sort()).toEqual(["hosts", "publicImageBase", "setupCode"]);
      expect(linkOrigin(config)).toBeNull();
    }
  });

  it("SITE_HOST is ignored when APP_HOST is set", () => {
    for (const site of ["site.example.com", "https://made-up.example.com", ""]) {
      const env = { ...TWO, SITE_HOST: site };
      const config = configFromEnv(env);
      expect(Object.keys(config).sort(), site).toEqual(["hosts", "publicImageBase", "setupCode"]);
      expect(linkOrigin(config), site).toBe("https://app.example.com");
      // Also for mail: a SITE_HOST that is not a host name is no problem beside two addresses.
      const { result, settings } = mailOf({ ...BLOCK, ...env });
      expect([result.mode, result.problem], site).toEqual(["smtp", null]);
      expect(settings[0].helo, site).toBe("app.example.com");
    }
  });
});

describe("the mail settings on the Node target", () => {
  it("with no mail setting mail is off and nothing is logged", () => {
    const lines: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args)));
    const quiet: Record<string, string>[] = [
      {},
      TWO,
      ONE,
      { MAIL_MODE: "" },
      { MAIL_MODE: "  " },
      { MAIL_MODE: "off" },
      { MAIL_MODE: " OFF " },
      // Off is off, whatever else is written, usable or not.
      { ...BLOCK, ...TWO, MAIL_MODE: "off" },
      { ...BLOCK, ...TWO, MAIL_MODE: "" },
      { MAIL_MODE: "off", MAIL_FROM: "not an address", SMTP_PORT: "made-up", SITE_HOST: "https://made-up.example.com" },
      // Without a mode the rest of a block switches nothing on.
      { MAIL_FROM: "no-reply@example.com", SMTP_HOST: "mail.example.com", SMTP_USER: "no-reply@example.com", SMTP_PASSWORD: PASSWORD, ...TWO },
    ];
    for (const env of quiet) {
      const { result, settings } = mailOf(env);
      expect(result, JSON.stringify(Object.keys(env))).toEqual({ mailer: NO_MAIL, mode: "off", problem: null, setting: null });
      expect(result.mailer).toBe(NO_MAIL);
      expect(settings).toEqual([]);
    }
    expect(lines).toEqual([]);
    for (const spy of spies) spy.mockRestore();
  });

  it("a full SMTP block gives the SMTP mailer", () => {
    const two = mailOf({ ...BLOCK, ...TWO });
    expect(two.result).toEqual({ mailer: two.made, mode: "smtp", problem: null, setting: null });
    expect(two.result.mailer).toBe(two.made);
    // TLS from the first byte on port 465 unless another port is written; the site names itself by its link host.
    expect(two.settings).toEqual([{ host: "mail.example.com", port: 465, user: "no-reply@example.com", password: PASSWORD, from: "no-reply@example.com", helo: "app.example.com" }]);

    const one = mailOf({ MAIL_MODE: " SMTP ", MAIL_FROM: " No-Reply@Example.com ", SMTP_HOST: " Mail.Example.com. ", SMTP_PORT: " 2465 ", SMTP_USER: " mailbox-user ", SMTP_PASSWORD: " pass word with spaces ", SITE_HOST: "tours.example.com:8443" });
    expect([one.result.mode, one.result.problem]).toEqual(["smtp", null]);
    // Names and the address are tidied; the password is taken as written, and the name given to the server has no port.
    expect(one.settings).toEqual([{ host: "mail.example.com", port: 2465, user: "mailbox-user", password: " pass word with spaces ", from: "no-reply@example.com", helo: "tours.example.com" }]);
    expect(mailOf({ ...BLOCK, ...TWO, SMTP_PORT: "" }).settings[0].port).toBe(465);
    expect(mailOf({ ...BLOCK, ...TWO, SMTP_HOST: "192.0.2.25" }).settings[0].host).toBe("192.0.2.25");

    // With the real maker the mailer is the SMTP client in a worker thread. Nothing is sent,
    // so nothing is contacted, and the worker is not even made: the first send makes it.
    const env = { ...BLOCK, ...TWO };
    const real = mailFromEnv(env, configFromEnv(env));
    expect([real.mode, real.problem]).toEqual(["smtp", null]);
    expect(real.mailer).not.toBe(NO_MAIL);
    expect(typeof real.mailer.send).toBe("function");
    const threaded = real.mailer as ClosableMailer;
    expect(typeof threaded.close).toBe("function");
    expect(threaded.stats()).toEqual({ starts: 0, running: false, busy: false, queued: 0 });
    // The result holds the mailer and three words about it: no setting's value, no password.
    expect(Object.keys(real).sort()).toEqual(["mailer", "mode", "problem", "setting"]);
    expect(JSON.stringify(real)).not.toContain(PASSWORD);
  });

  /** Each missing or malformed value, with the setting its line must name. `made-up` marks what must never be repeated. */
  const BAD: [string, Record<string, string | undefined>, string][] = [
    ["a mode that is neither off nor smtp", { MAIL_MODE: "made-up-mode" }, "MAIL_MODE"],
    ["a mode of another kind of server", { MAIL_MODE: "sendmail" }, "MAIL_MODE"],
    ["no sender", { MAIL_FROM: undefined }, "MAIL_FROM"],
    ["an empty sender", { MAIL_FROM: "  " }, "MAIL_FROM"],
    ["a sender that is not an address", { MAIL_FROM: "made-up-sender" }, "MAIL_FROM"],
    ["a sender with a name around it", { MAIL_FROM: "Made-Up <no-reply@example.com>" }, "MAIL_FROM"],
    ["a sender with a line break", { MAIL_FROM: "no-reply@example.com\r\nBcc: made-up@example.com" }, "MAIL_FROM"],
    ["no server", { SMTP_HOST: undefined }, "SMTP_HOST"],
    ["a server with a scheme", { SMTP_HOST: "smtps://made-up.example.com" }, "SMTP_HOST"],
    ["a server with its port in the name", { SMTP_HOST: "made-up.example.com:465" }, "SMTP_HOST"],
    // A port the host rule would drop: refused, never connected on 465 instead.
    ["a server with the web port in the name", { SMTP_HOST: "made-up.example.com:443" }, "SMTP_HOST"],
    ["a server with port 80 in the name", { SMTP_HOST: " made-up.example.com:80 " }, "SMTP_HOST"],
    ["a server with an empty port", { SMTP_HOST: "made-up.example.com:" }, "SMTP_HOST"],
    ["a server written as an IPv6 address", { SMTP_HOST: "2001:db8::25" }, "SMTP_HOST"],
    ["a server with a line break", { SMTP_HOST: "mail.example.com\r\nmade-up" }, "SMTP_HOST"],
    ["a port that is not a number", { SMTP_PORT: "made-up" }, "SMTP_PORT"],
    ["a port of zero", { SMTP_PORT: "0" }, "SMTP_PORT"],
    ["a port past the last one", { SMTP_PORT: "65536" }, "SMTP_PORT"],
    ["a port with a sign", { SMTP_PORT: "-465" }, "SMTP_PORT"],
    ["a port with a decimal", { SMTP_PORT: "465.0" }, "SMTP_PORT"],
    ["no mailbox name", { SMTP_USER: undefined }, "SMTP_USER"],
    ["an empty mailbox name", { SMTP_USER: "   " }, "SMTP_USER"],
    ["a mailbox name with a line break", { SMTP_USER: "made-up\nuser" }, "SMTP_USER"],
    ["a mailbox name with a NUL", { SMTP_USER: "made-up\0user" }, "SMTP_USER"],
    ["no password", { SMTP_PASSWORD: undefined }, "SMTP_PASSWORD"],
    ["an empty password", { SMTP_PASSWORD: "" }, "SMTP_PASSWORD"],
    ["a password with a line break", { SMTP_PASSWORD: "made-up\r\npassword" }, "SMTP_PASSWORD"],
    ["a password with a NUL", { SMTP_PASSWORD: "made-up\0password" }, "SMTP_PASSWORD"],
    ["a link host that is not a host name", { TOURS_HOST: undefined, APP_HOST: undefined, SITE_HOST: "https://made-up.example.com" }, "SITE_HOST"],
  ];

  it("each missing or malformed value leaves mail off with one line that names the setting and repeats no value", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [label, change, setting] of BAD) {
      const env: Record<string, string> = { ...BLOCK, ...TWO };
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      const { result, settings } = mailOf(env);
      expect(result, label).toEqual({ mailer: NO_MAIL, mode: "off", problem: mailOff(setting), setting });
      expect(result.mailer, label).toBe(NO_MAIL);
      // No client was made, so the password went nowhere.
      expect(settings, label).toEqual([]);
      const line = result.problem as string;
      expect(line.split("\n").length, label).toBe(1);
      expect(line.toLowerCase(), label).not.toContain("made-up");
      for (const value of Object.values(env)) if (value.trim().length > 3) expect(line, `${label}: ${setting}`).not.toContain(value.trim());
      expect(line, label).not.toContain(PASSWORD);
    }
    // The function itself writes nothing: the entry writes the line, once.
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    // The first setting that cannot be used is the one named.
    expect(mailOf({ MAIL_MODE: "smtp" }).result.problem).toBe(mailOff("MAIL_FROM"));
    expect(mailOf({ MAIL_MODE: "smtp", MAIL_FROM: "no-reply@example.com", SMTP_PASSWORD: PASSWORD }).result.problem).toBe(mailOff("SMTP_HOST"));
  });

  it("SMTP without a link host leaves mail off", () => {
    for (const hosts of [{}, { SITE_HOST: "" }, { SITE_HOST: "   " }] as Record<string, string>[]) {
      const { result, settings } = mailOf({ ...BLOCK, ...hosts });
      // No setting is wrong: one is missing, and the line says which to set.
      expect(result).toEqual({ mailer: NO_MAIL, mode: "off", problem: NO_LINK_HOST, setting: null });
      expect(settings).toEqual([]);
    }
    // A configuration handed in without a usable link host is refused the same way, whatever the environment says.
    const forged: Config = { publicImageBase: "", setupCode: null, hosts: null, siteHost: "https://made-up.example.com" };
    expect(mailFromEnv({ ...BLOCK }, forged, () => ({ send: () => Promise.resolve() })).problem).toBe(NO_LINK_HOST);
    // With either address setting it is on.
    expect(mailOf({ ...BLOCK, ...ONE }).result.mode).toBe("smtp");
    expect(mailOf({ ...BLOCK, ...TWO }).result.mode).toBe("smtp");
  });
});

describe("the client address on the Node target", () => {
  const incoming = (headers: Record<string, string | string[] | undefined>, remoteAddress?: string) => ({ headers, socket: { remoteAddress } });

  it("the client address is the socket's, or the last value of the named header", () => {
    // No header named: the socket's address, whatever the request claims.
    const claims = { "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.8", forwarded: "for=203.0.113.9" };
    expect(clientAddressFrom(undefined, incoming(claims, "198.51.100.4"))).toBe("198.51.100.4");
    expect(clientAddressFrom(undefined, incoming({}, "2001:db8::1"))).toBe("2001:db8::1");
    // An IPv4 address written as IPv6 is the IPv4 address, in the short form and the long one.
    expect(clientAddressFrom(undefined, incoming({}, "::ffff:198.51.100.4"))).toBe("198.51.100.4");
    expect(clientAddressFrom(undefined, incoming({}, "0:0:0:0:0:FFFF:198.51.100.4"))).toBe("198.51.100.4");
    expect(clientAddressFrom(undefined, incoming({}, "::ffff:c633:6404"))).toBe("198.51.100.4");
    // One form for every address: lower case, shortened, and without the zone of a local interface.
    expect(clientAddressFrom(undefined, incoming({}, "2001:DB8:0:0:0:0:0:1"))).toBe("2001:db8::1");
    expect(clientAddressFrom(undefined, incoming({}, "fe80::1%eth0"))).toBe("fe80::1");
    expect(clientAddressFrom("x-real-ip", incoming({ "x-real-ip": "192.0.2.66, 2001:DB8::A%7" }, "127.0.0.1"))).toBe("2001:db8::a");
    expect(clientAddressFrom("x-real-ip", incoming({ "x-real-ip": "0:0:0:0:0:ffff:c633:6404" }, "127.0.0.1"))).toBe("198.51.100.4");
    // The value must be the bare address: brackets, a port or a label make it no address.
    for (const value of ["[2001:db8::1]", "[2001:db8::1]:4711", "for=203.0.113.7", "203.0.113.7;proto=https"]) {
      expect(clientAddressFrom("x-real-ip", incoming({ "x-real-ip": value }, "198.51.100.4")), value).toBeNull();
    }
    expect(clientAddressFrom(undefined, incoming({}, undefined))).toBeNull();
    expect(clientAddressFrom(undefined, incoming({}, "not an address"))).toBeNull();

    // A header named: its last value, which is the one the nearest proxy wrote.
    expect(clientAddressFrom("x-forwarded-for", incoming({ "x-forwarded-for": "203.0.113.7" }, "127.0.0.1"))).toBe("203.0.113.7");
    expect(clientAddressFrom("x-forwarded-for", incoming({ "x-forwarded-for": "192.0.2.66, 203.0.113.7" }, "127.0.0.1"))).toBe("203.0.113.7");
    expect(clientAddressFrom("x-forwarded-for", incoming({ "x-forwarded-for": "192.0.2.66,198.51.100.1 ,  2001:db8::7 " }, "127.0.0.1"))).toBe("2001:db8::7");
    expect(clientAddressFrom("x-real-ip", incoming({ "x-real-ip": ["192.0.2.66", "192.0.2.67, 203.0.113.7"] }, "127.0.0.1"))).toBe("203.0.113.7");
    // The name is matched as Node writes header names, in lower case.
    expect(clientAddressFrom("X-Real-IP", incoming({ "x-real-ip": "203.0.113.7" }, "127.0.0.1"))).toBe("203.0.113.7");
    // The header is missing, empty, or its last value is no address: no address, never the socket's, which is the proxy's.
    for (const headers of [{}, { "x-real-ip": "" }, { "x-real-ip": "203.0.113.7, " }, { "x-real-ip": "203.0.113.7, made-up" }, { "x-real-ip": "203.0.113.7:4711" }, { "x-real-ip": [] as string[] }, { "x-forwarded-for": "203.0.113.7" }]) {
      expect(clientAddressFrom("x-real-ip", incoming(headers, "198.51.100.4")), JSON.stringify(headers)).toBeNull();
    }
  });

  it("CLIENT_ADDRESS_HEADER unset reads the socket, set reads the header, and a value that is no header name reads nothing and says so once", () => {
    const from = incoming({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.8" }, "198.51.100.4");
    for (const raw of [undefined, "", "   "]) {
      const reader = clientAddressReader(raw);
      expect(reader.problem).toBeNull();
      expect(reader.read(from)).toBe("198.51.100.4");
    }
    const named = clientAddressReader(" X-Real-IP ");
    expect(named.problem).toBeNull();
    expect(named.read(from)).toBe("203.0.113.7");
    expect(named.read(incoming({}, "198.51.100.4"))).toBeNull();
    for (const raw of ["x real ip", "x-real-ip: made-up", "made-up\r\nheader", "x-real-ip,x-forwarded-for", "é-made-up", "x".repeat(65)]) {
      const reader = clientAddressReader(raw);
      expect(reader.problem, raw).toBe(BAD_HEADER);
      expect(reader.problem, raw).not.toContain("made-up");
      // Unknown is the safe reading: the socket's address could be a proxy's, shared by every visitor.
      expect(reader.read(from), raw).toBeNull();
    }
  });

  it("a header of which Node keeps only the first value, or joins in its own way, cannot be the client address header", () => {
    // For these Node drops every occurrence after the first, so the "last value" would be the first: the one a visitor sends.
    const single = ["age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after", "server", "user-agent"];
    // Cookie values are joined with "; " and Set-Cookie is a list of its own.
    const other = ["cookie", "set-cookie"];
    for (const name of [...single, ...other, "From", " REFERER ", "User-Agent"]) {
      const reader = clientAddressReader(name);
      expect(reader.problem, name).toBe(BAD_HEADER);
      const key = name.trim().toLowerCase();
      expect(reader.read(incoming({ [key]: "203.0.113.7" }, "198.51.100.4")), name).toBeNull();
    }
    // A header Node joins with ", " is taken, whatever its name.
    for (const name of ["x-real-ip", "x-forwarded-for", "cf-connecting-ip", "x-client-address", "true-client-ip", "forwarded-for"]) expect(clientAddressReader(name).problem, name).toBeNull();
  });

  it("without CLIENT_ADDRESS_HEADER, the first request from a private, local or missing socket address writes one line naming the setting, once per process, and changes nothing", () => {
    expect(PROXY_HINT).toContain("CLIENT_ADDRESS_HEADER");
    expect(PROXY_HINT).not.toMatch(/[0-9]+\.[0-9]+\.[0-9]+|::/);
    for (const address of ["127.0.0.1", "::1", "10.1.2.3", "192.168.0.9", "172.18.0.4", "fd00::7", "::ffff:127.0.0.1", undefined]) {
      for (const raw of [undefined, "", "  "]) {
        const lines: string[] = [];
        const hint = proxyHint(raw, (line) => lines.push(line));
        for (let i = 0; i < 5; i++) hint(incoming({}, address));
        hint(incoming({}, "203.0.113.7"));
        expect(lines, `${address} ${JSON.stringify(raw)}`).toEqual([PROXY_HINT]);
      }
    }
    // A public address says nothing, and nor does anything once the header is set.
    const quiet: string[] = [];
    const publicHint = proxyHint(undefined, (line) => quiet.push(line));
    for (const address of ["203.0.113.7", "2001:db8::1", "8.8.8.8"]) publicHint(incoming({}, address));
    for (const raw of ["X-Real-IP", "not a header"]) {
      const hint = proxyHint(raw, (line) => quiet.push(line));
      hint(incoming({}, "127.0.0.1"));
    }
    expect(quiet).toEqual([]);
    // What the reader gives is unchanged by it.
    expect(clientAddressReader(undefined).read(incoming({}, "127.0.0.1"))).toBe("127.0.0.1");
  });
});

describe("the real Node startup with mail settings", () => {
  const made: string[] = [];
  let child: ChildProcess | null = null;
  const end = async () => {
    if (child !== null && child.exitCode === null) {
      const gone = new Promise((done) => child!.once("exit", done));
      child.kill();
      await gone;
    }
    child = null;
  };
  afterEach(async () => {
    await end();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Starts src/node/entry.ts with these settings, waits until it listens, and returns the port and what it wrote. */
  async function start(settings: Record<string, string>): Promise<{ port: number; out: () => { stdout: string; stderr: string } }> {
    const root = mkdtempSync(join(tmpdir(), "dp-node-mail-"));
    made.push(root);
    const base: Record<string, string> = {};
    for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
    const port = await freePort();
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, [ENTRY], { env: { ...base, DATA_DIR: join(root, "data"), PORT: String(port), NODE_NO_WARNINGS: "1", ...settings }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
        if (stdout.includes(`listening on port ${port}`)) resolve();
      });
      child!.once("exit", (code) => reject(new Error(`the app stopped with code ${code}: ${stderr}`)));
    });
    return { port, out: () => ({ stdout, stderr }) };
  }

  const health = async (port: number) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    return { status: res.status, body: await res.text() };
  };

  it("a mail block that cannot be used leaves the site up, with one line that holds no value", async () => {
    const plain = await start({});
    const expected = await health(plain.port);
    expect(expected.status).toBe(200);
    // The test asks from 127.0.0.1 with no CLIENT_ADDRESS_HEADER: the one line about a proxy, at the first request.
    expect(plain.out().stderr).toBe(PROXY_HINT + "\n");
    await end();

    const cases: [Record<string, string>, string][] = [
      [{ ...BLOCK, SMTP_HOST: "smtps://made-up.example.com", ...ONE }, mailOff("SMTP_HOST") + "\n" + PROXY_HINT + "\n"],
      [{ ...BLOCK }, NO_LINK_HOST + "\n" + PROXY_HINT + "\n"],
      [{ ...BLOCK, ...ONE, CLIENT_ADDRESS_HEADER: "made-up header" }, BAD_HEADER + "\n"],
      // A block that can be used, and mail that is off, write nothing about mail; neither contacts the mail server at the start.
      [{ ...BLOCK, ...ONE, SMTP_HOST: "127.0.0.1", SMTP_PORT: "9", CLIENT_ADDRESS_HEADER: "x-real-ip" }, ""],
      [{ ...BLOCK, MAIL_MODE: "off" }, PROXY_HINT + "\n"],
    ];
    for (const [settings, line] of cases) {
      const site = await start(settings);
      // Health answers exactly as without any mail setting: it says nothing about mail.
      expect(await health(site.port)).toEqual(expected);
      const { stdout, stderr } = site.out();
      expect(stderr).toBe(line);
      expect(stdout + stderr).not.toContain(PASSWORD);
      expect((stdout + stderr).toLowerCase()).not.toContain("made-up");
      await end();
    }
  }, 240_000);
});

describe("the settings reach the app on every install path", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  /** Every setting the Node target reads from its environment, from the source of its settings and its entry. */
  function settingsRead(): string[] {
    const names = new Set<string>();
    for (const file of ["../src/node/config.ts", "../src/node/entry.ts"]) for (const m of read(file).matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
    return [...names].sort();
  }

  it("the Node target reads the settings this test knows, so a new one cannot be forgotten here", () => {
    expect(settingsRead()).toEqual(
      ["APP_HOST", "CLIENT_ADDRESS_HEADER", "DATA_DIR", "MAIL_FROM", "MAIL_MODE", "PORT", "PUBLIC_IMAGE_BASE", "SETUP_CODE", "SITE_HOST", "SMTP_HOST", "SMTP_PASSWORD", "SMTP_PORT", "SMTP_USER", "STORAGE_ALLOWANCE_BYTES", "TOURS_HOST", "INVITE_CONTACT", "IMG_HOST", "DOWNLOAD_URL", "SESSION_MAX_DAYS", "CONNECTION_IDLE_DAYS", "CONNECTION_MAX_DAYS", "HOME_URL", "STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "STRIPE_PUBLISHABLE_KEY", "MAIL_FOOTER", "SOURCE_URL", "FILE_STORE", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PRIVATE_BUCKET", "R2_PUBLIC_BUCKET"].sort(),
    );
  });

  it("the tunnel stack, which names the app's settings one by one, names every one the app reads", () => {
    const stack = read("../deploy/tunnel/docker-compose.yml");
    const app = stack.match(/^  app:\n((?:(?:    .*)?\n)*)/m)?.[1] ?? "";
    expect(app).not.toMatch(/^\s*env_file:/m);
    // Set by the stack itself, from other lines of .env or as fixed values.
    const own = ["APP_HOST", "TOURS_HOST", "DATA_DIR", "PORT", "SETUP_CODE"];
    for (const name of own) expect(app, name).toMatch(new RegExp(`^      ${name}: `, "m"));
    // Every other one is optional: passed on as written in .env, empty without a line there.
    for (const name of settingsRead().filter((n) => !own.includes(n))) expect(app, name).toContain(`      ${name}: \${${name}:-}\n`);
    // The admin command, run in this container with `docker compose exec`, reads the container's environment: its recovery setting is passed on too.
    expect(app).toContain("      RECOVERY_LINKS: ${RECOVERY_LINKS:-}\n");
    // The mailbox password goes to the app only, as the tunnel token goes to cloudflared only.
    expect(stack.match(/SMTP_PASSWORD/g)?.length).toBe(app.match(/SMTP_PASSWORD/g)?.length);
    // The copy inside install.sh is the same file (test/docs.test.ts holds them equal).
    expect(read("../deploy/install.sh")).toContain("      SMTP_PASSWORD: ${SMTP_PASSWORD:-}\n");
  });

  it("the direct stack hands the app its whole .env, so every setting written there arrives", () => {
    const app = read("../deploy/docker-compose.yml").match(/^  app:\n((?:(?:    .*)?\n)*)/m)?.[1] ?? "";
    expect(app).toContain("    env_file: .env\n");
    // What the stack sets itself wins over .env; none of the optional settings is among it.
    const set = [...app.matchAll(/^      ([A-Z][A-Z0-9_]*): /gm)].map((m) => m[1]).sort();
    expect(set).toEqual(["APP_HOST", "DATA_DIR", "PORT", "TOURS_HOST"]);
  });

  it("the cPanel startup file passes every NAME=value line on, whatever the name", () => {
    const startup = read("../deploy/cpanel/app.cjs");
    expect(startup).toContain("const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);");
    expect(startup).toContain("out.push([m[1], quoted ? quoted[1] : m[2]]);");
    // The app gets every line the environment does not already set.
    expect(startup).toContain("for (const [name, value] of settingsLines()) if (process.env[name] === undefined) process.env[name] = value;");
  });
});
