import { describe, expect, it } from "vitest";
import { HOST_ROLES, mediaOrigin, mediaRole, normaliseHost, onRole, OPTIONAL_HOST_ROLES, originOf, requestHost, resolveHosts, roleOf, type Hosts } from "../src/hosts.ts";
import { linkOrigin } from "../src/mail.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...HOSTS, img: "img.example.com" };

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
    expect(HOST_ROLES).toEqual(["tours", "app", "img"]);
    expect(OPTIONAL_HOST_ROLES).toEqual(["img"]);
    // Two addresses have no img key at all, not one that is undefined.
    const two = resolveHosts({ tours: "tours.example.com", app: "app.example.com", img: "  " });
    expect(two.ok && two.hosts !== null && Object.keys(two.hosts)).toEqual(["tours", "app"]);
  });

  it("resolveHosts takes the img address beside the other two, normalised", () => {
    expect(resolveHosts({ tours: "tours.example.com", app: "app.example.com", img: " IMG.Example.com.:443 " })).toEqual({
      ok: true,
      hosts: { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" },
    });
    expect(resolveHosts({ tours: "tours.localhost:8787", app: "app.localhost:8787", img: "img.localhost:8787" })).toEqual({
      ok: true,
      hosts: { tours: "tours.localhost:8787", app: "app.localhost:8787", img: "img.localhost:8787" },
    });
  });

  it("resolveHosts refuses the img address without the other two", () => {
    const imgOnly = { ok: false, problem: "IMG_HOST is set but TOURS_HOST and APP_HOST are not. IMG_HOST is an extra address beside those two: set them too, or leave IMG_HOST empty." };
    expect(resolveHosts({ img: "img.example.com" })).toEqual(imgOnly);
    expect(resolveHosts({ tours: "", app: " ", img: "img.example.com" })).toEqual(imgOnly);
    expect(resolveHosts({ img: "https://img.example.com/" })).toEqual(imgOnly);
    // With one of the two, the problem is the missing one, as without the img address.
    expect(resolveHosts({ tours: "tours.example.com", img: "img.example.com" })).toEqual({
      ok: false,
      problem: "TOURS_HOST is set but APP_HOST is not. Set both for two addresses, or neither for one.",
    });
    expect(resolveHosts({ app: "app.example.com", img: "img.example.com" })).toEqual({
      ok: false,
      problem: "APP_HOST is set but TOURS_HOST is not. Set both for two addresses, or neither for one.",
    });
  });

  it("resolveHosts checks the img address like the other two", () => {
    expect(resolveHosts({ tours: "tours.example.com", app: "app.example.com", img: "https://img.example.com" })).toEqual({
      ok: false,
      problem: "IMG_HOST is not a host name. Write it like img.example.com, without https:// and without a path.",
    });
    for (const img of ["img.example.com/i", "*.example.com", "img_1.example.com", "[::1]"]) {
      const r = resolveHosts({ tours: "tours.example.com", app: "app.example.com", img });
      expect(r.ok, img).toBe(false);
      expect(JSON.stringify(r), img).not.toContain(img);
    }
    const sameAsTours = { ok: false, problem: "TOURS_HOST and IMG_HOST name the same host. Two addresses need two different host names." };
    const sameAsApp = { ok: false, problem: "APP_HOST and IMG_HOST name the same host. Two addresses need two different host names." };
    expect(resolveHosts({ tours: "tours.example.com", app: "app.example.com", img: "tours.example.com" })).toEqual(sameAsTours);
    expect(resolveHosts({ tours: "tours.example.com", app: "app.example.com", img: "Tours.Example.com.:8443" })).toEqual(sameAsTours);
    expect(resolveHosts({ tours: "tours.example.com", app: "app.example.com", img: "app.example.com:80" })).toEqual(sameAsApp);
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
    // The img address is a role only when it is set.
    expect(roleOf(THREE, "img.example.com")).toBe("img");
    expect(roleOf(THREE, "tours.example.com")).toBe("tours");
    expect(roleOf(THREE, "app.example.com")).toBe("app");
    expect(roleOf(HOSTS, "img.example.com")).toBeNull();
    expect(roleOf(THREE, "img.example.com:8443")).toBeNull();
  });

  it("onRole holds only on an address of the roles listed, and always with one address", () => {
    const at = (origin: string) => new Request(origin + "/x", { headers: { "x-forwarded-host": "app.example.com" } });
    expect(onRole(THREE, at("https://app.example.com"), ["app"])).toBe(true);
    expect(onRole(THREE, at("https://tours.example.com"), ["app"])).toBe(false);
    expect(onRole(THREE, at("https://img.example.com"), ["tours", "app"])).toBe(false);
    expect(onRole(THREE, at("https://img.example.com"), ["img"])).toBe(true);
    expect(onRole(THREE, at("https://evil.example.net"), ["tours", "app", "img"])).toBe(false);
    expect(onRole(THREE, at("https://app.example.com"), [])).toBe(false);
    for (const hosts of [null, undefined]) expect(onRole(hosts, at("https://evil.example.net"), [])).toBe(true);
  });

  it("mediaRole is the img address when it is set, else the tours address", () => {
    expect(mediaRole(THREE)).toBe("img");
    expect(mediaRole(HOSTS)).toBe("tours");
  });

  it("mediaOrigin is the img address, else the tours address, else SITE_HOST, else empty for a relative link, from configuration only", () => {
    expect(mediaOrigin({ hosts: THREE })).toBe("https://img.example.com");
    expect(mediaOrigin({ hosts: THREE, siteHost: "site.example.com" })).toBe("https://img.example.com");
    expect(mediaOrigin({ hosts: HOSTS })).toBe("https://tours.example.com");
    expect(mediaOrigin({ hosts: { tours: "tours.localhost:8787", app: "app.localhost:8787", img: "img.localhost:8787" } })).toBe("http://img.localhost:8787");
    expect(mediaOrigin({ hosts: { tours: "tours.example.com:8443", app: "app.example.com" } })).toBe("https://tours.example.com:8443");
    // One address: the origin of SITE_HOST by the rule sign-in links use, else nothing,
    // so the caller builds a relative link as tour links are.
    for (const hosts of [null, undefined]) {
      expect(mediaOrigin({ hosts })).toBe("");
      expect(mediaOrigin({ hosts, siteHost: "tours.example.com" })).toBe("https://tours.example.com");
      expect(mediaOrigin({ hosts, siteHost: "localhost:3000" })).toBe("http://localhost:3000");
      expect(mediaOrigin({ hosts, siteHost: "https://not-a-host.example.com/" })).toBe("");
      for (const siteHost of ["tours.example.com", "localhost:3000", "192.168.1.10:8080"]) {
        expect(mediaOrigin({ hosts, siteHost }), siteHost).toBe(linkOrigin({ publicImageBase: "", setupCode: null, hosts: null, siteHost }));
      }
    }
    expect(mediaOrigin({})).toBe("");
    // It takes no request, so nothing a client sends (Host, X-Forwarded-Host, Forwarded) can reach it.
    expect(mediaOrigin.length).toBe(1);
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
