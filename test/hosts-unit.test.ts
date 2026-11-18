import { describe, expect, it } from "vitest";
import { HOST_ROLES, normaliseHost, originOf, requestHost, resolveHosts, roleOf, type Hosts } from "../src/hosts.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };

describe("host names", () => {
  it("normaliseHost lowercases, drops one trailing dot and the default ports", () => {
    expect(normaliseHost("TOURS.Example.COM.")).toBe("tours.example.com");
    expect(normaliseHost("tours.example.com:443")).toBe("tours.example.com");
    expect(normaliseHost("tours.example.com:80")).toBe("tours.example.com");
    expect(normaliseHost("  tours.example.com  ")).toBe("tours.example.com");
    expect(normaliseHost("Tours.Example.com.:443")).toBe("tours.example.com");
    expect(normaliseHost("localhost:8787")).toBe("localhost:8787");
    expect(normaliseHost("tours.example.com:65535")).toBe("tours.example.com:65535");
    expect(normaliseHost("tours.example.com:1")).toBe("tours.example.com:1");
    // Names for local development pass.
    expect(normaliseHost("localhost")).toBe("localhost");
    expect(normaliseHost("tours.localhost:8787")).toBe("tours.localhost:8787");
    expect(normaliseHost("127.0.0.1:3000")).toBe("127.0.0.1:3000");
    // The longest label and the longest name still pass.
    const label = "a".repeat(63);
    expect(normaliseHost(label + ".example.com")).toBe(label + ".example.com");
    const longest = [label, label, label, "a".repeat(61)].join(".");
    expect(longest.length).toBe(253);
    expect(normaliseHost(longest)).toBe(longest);
  });

  it("normaliseHost refuses what is not a plain host name", () => {
    const refused = [
      "https://tours.example.com",
      "//tours.example.com",
      "tours.example.com/t/abc",
      "tours.example.com/",
      "tours.example.com?x=1",
      "tours.example.com#x",
      "user@tours.example.com",
      "*.example.com",
      "a_b.example.com",
      "[::1]",
      "[::1]:8787",
      "::1",
      "tours.exämple.com",
      "tours.example.comK", // the Kelvin sign lowercases to an ASCII k
      "",
      "   ",
      "a..b",
      ".example.com",
      "-a.example.com",
      "a-.example.com",
      ":443",
      "tours.example.com:0",
      "tours.example.com:65536",
      "tours.example.com:",
      "tours.example.com:80:80",
      "tours.example.com:8o",
      "tours.example.com:-1",
      "tours.example.com:1e3",
      "tours.example.com..",
      "tours example.com",
      "tours.example.com,app.example.com",
      "a".repeat(64) + ".example.com",
      [("a".repeat(63)), "a".repeat(63), "a".repeat(63), "a".repeat(62)].join("."), // 254 characters
    ];
    for (const raw of refused) expect(normaliseHost(raw), JSON.stringify(raw)).toBeNull();
  });

  it("resolveHosts gives one-address mode when neither is set", () => {
    const one = { ok: true, hosts: null };
    expect(resolveHosts({})).toEqual(one);
    expect(resolveHosts({ tours: undefined, app: undefined })).toEqual(one);
    expect(resolveHosts({ tours: "", app: "" })).toEqual(one);
    expect(resolveHosts({ tours: "   ", app: "\t" })).toEqual(one);
    expect(resolveHosts({ tours: "", app: undefined })).toEqual(one);
  });

  it("resolveHosts refuses one without the other", () => {
    const toursOnly = { ok: false, problem: "TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one." };
    const appOnly = { ok: false, problem: "APP_HOST is set but TOURS_HOST is not. Set both for two addresses, or neither for one." };
    expect(resolveHosts({ tours: "tours.example.com" })).toEqual(toursOnly);
    expect(resolveHosts({ tours: "tours.example.com", app: "" })).toEqual(toursOnly);
    expect(resolveHosts({ tours: "tours.example.com", app: "  " })).toEqual(toursOnly);
    expect(resolveHosts({ app: "app.example.com" })).toEqual(appOnly);
    expect(resolveHosts({ tours: "", app: "app.example.com" })).toEqual(appOnly);
    // A lone value is reported as lone even when it is not a host name either.
    expect(resolveHosts({ tours: "https://tours.example.com" })).toEqual(toursOnly);
  });

  it("resolveHosts refuses a value that is not a host name", () => {
    const tours = { ok: false, problem: "TOURS_HOST is not a host name. Write it like tours.example.com, without https:// and without a path." };
    const app = { ok: false, problem: "APP_HOST is not a host name. Write it like app.example.com, without https:// and without a path." };
    expect(resolveHosts({ tours: "https://tours.example.com", app: "app.example.com" })).toEqual(tours);
    expect(resolveHosts({ tours: "tours.example.com", app: "app.example.com/app" })).toEqual(app);
    expect(resolveHosts({ tours: "*.example.com", app: "app_1.example.com" })).toEqual(tours);
    // The problem never repeats the value.
    for (const r of [resolveHosts({ tours: "https://secret.example.com", app: "app.example.com" })]) {
      expect(JSON.stringify(r)).not.toContain("secret");
    }
  });

  it("resolveHosts refuses the same name twice", () => {
    const same = { ok: false, problem: "TOURS_HOST and APP_HOST name the same host. Two addresses need two different host names." };
    expect(resolveHosts({ tours: "tours.example.com", app: "tours.example.com" })).toEqual(same);
    expect(resolveHosts({ tours: "localhost:3000", app: "localhost:3001" })).toEqual(same);
    expect(resolveHosts({ tours: "tours.example.com", app: "tours.example.com:8443" })).toEqual(same);
    expect(resolveHosts({ tours: "Tours.Example.com", app: "tours.example.com" })).toEqual(same);
    expect(resolveHosts({ tours: "tours.example.com.", app: "tours.example.com" })).toEqual(same);
    expect(resolveHosts({ tours: "tours.example.com:443", app: "tours.example.com:80" })).toEqual(same);
  });

  it("resolveHosts returns both names normalised", () => {
    expect(resolveHosts({ tours: " Tours.Example.COM. ", app: "app.example.com:443" })).toEqual({
      ok: true,
      hosts: { tours: "tours.example.com", app: "app.example.com" },
    });
    expect(resolveHosts({ tours: "tours.localhost:8787", app: "app.localhost:8787" })).toEqual({
      ok: true,
      hosts: { tours: "tours.localhost:8787", app: "app.localhost:8787" },
    });
    expect(HOST_ROLES).toEqual(["tours", "app"]);
  });

  it("requestHost reads the address the request was sent to and no header", () => {
    const forged = { "x-forwarded-host": "tours.example.com", forwarded: "host=tours.example.com", "x-original-host": "tours.example.com" };
    expect(requestHost(new Request("https://app.example.com/t/abc?x=1", { headers: forged }))).toBe("app.example.com");
    expect(requestHost(new Request("https://APP.Example.com:443/"))).toBe("app.example.com");
    expect(requestHost(new Request("http://app.example.com:80/"))).toBe("app.example.com");
    expect(requestHost(new Request("http://app.example.com./"))).toBe("app.example.com");
    expect(requestHost(new Request("http://localhost:8787/healthz"))).toBe("localhost:8787");
    // A bracketed IPv6 address is not a host this app is configured with.
    expect(requestHost(new Request("http://[::1]:8787/healthz", { headers: forged }))).toBeNull();
  });

  it("roleOf matches exactly", () => {
    expect(roleOf(HOSTS, "tours.example.com")).toBe("tours");
    expect(roleOf(HOSTS, "app.example.com")).toBe("app");
    expect(roleOf(HOSTS, "tours.example.com.evil.example")).toBeNull();
    expect(roleOf(HOSTS, "xtours.example.com")).toBeNull();
    expect(roleOf(HOSTS, "example.com")).toBeNull();
    expect(roleOf(HOSTS, "tours.example.com:8443")).toBeNull();
    expect(roleOf(HOSTS, "")).toBeNull();
    expect(roleOf(HOSTS, null)).toBeNull();
    const local: Hosts = { tours: "tours.localhost:8787", app: "app.localhost:8787" };
    expect(roleOf(local, "tours.localhost:8787")).toBe("tours");
    expect(roleOf(local, "tours.localhost")).toBeNull();
    expect(roleOf(local, "tours.localhost:8788")).toBeNull();
    // A name that is a property of every object is not a role.
    expect(roleOf(HOSTS, "constructor")).toBeNull();
  });

  it("originOf is https, and http only for localhost names and 127.0.0.1", () => {
    expect(originOf("tours.example.com")).toBe("https://tours.example.com");
    expect(originOf("tours.example.com:8443")).toBe("https://tours.example.com:8443");
    expect(originOf("localhost")).toBe("http://localhost");
    expect(originOf("localhost:8787")).toBe("http://localhost:8787");
    expect(originOf("tours.localhost:8787")).toBe("http://tours.localhost:8787");
    expect(originOf("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(originOf("127.0.0.1")).toBe("http://127.0.0.1");
    // Names that only look local stay https.
    expect(originOf("localhost.example.com")).toBe("https://localhost.example.com");
    expect(originOf("notlocalhost")).toBe("https://notlocalhost");
    expect(originOf("127.0.0.10")).toBe("https://127.0.0.10");
    expect(originOf("192.168.1.10:3000")).toBe("https://192.168.1.10:3000");
  });
});
