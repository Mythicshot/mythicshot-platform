// The optional DOWNLOAD_URL setting: the address of the public page the desktop app is
// downloaded from. Its validation table, the one line said when it cannot be used, the
// session answer's download_url, the Worker's var, and that the page script checks the
// address with the same shape rule the server uses. What the pages do with it when they run
// is tested under Node in test/node-dash-account.test.ts and test/node-dash-connections.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { DOWNLOAD_URL_MAX, DOWNLOAD_URL_UNUSABLE, STRICT_HTTPS_SHAPE, downloadUrlSetting, httpsAddressFrom } from "../src/https-address.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { openapi } from "../src/docs/openapi.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { inviteContactFrom } from "../src/signin/invite.ts";
import { send } from "./bundle.ts";

const APP = "https://app.example.com";
const TWO = { hosts: { tours: "tours.example.com", app: "app.example.com" } };
const PAGE = "https://downloads.example.com/mythicshot/";

/** Good values, as written, and what they become. */
const GOOD: [string, string][] = [
  [PAGE, PAGE],
  ["https://downloads.example.com", "https://downloads.example.com/"],
  ["  https://downloads.example.com/get  ", "https://downloads.example.com/get"],
  ["HTTPS://Downloads.Example.COM/Get", "https://downloads.example.com/Get"],
  ["https://downloads.example.com:8443/get?os=windows&v=1", "https://downloads.example.com:8443/get?os=windows&v=1"],
  ["https://downloads.example.com:443/get", "https://downloads.example.com/get"],
  ["https://example.com/a/b-c_d.e~f/%20x", "https://example.com/a/b-c_d.e~f/%20x"],
  ["https://xn--bcher-kva.example/", "https://xn--bcher-kva.example/"],
];

/** Every bad form: none of them is used, and each gives the one fixed line. */
const BAD: [string, string][] = [
  ["http", "http://downloads.example.com/"],
  ["credentials", "https://user:secret@downloads.example.com/"],
  ["a user name", "https://user@downloads.example.com/"],
  ["a fragment", "https://downloads.example.com/get#latest"],
  ["an empty fragment", "https://downloads.example.com/get#"],
  ["scheme-relative", "//downloads.example.com/get"],
  ["javascript:", "javascript:alert(1)"],
  ["javascript: dressed as https", "javascript://https://downloads.example.com/%0aalert(1)"],
  ["data:", "data:text/html,<script>alert(1)</script>"],
  ["no scheme", "downloads.example.com/get"],
  ["a path alone", "/download"],
  ["an underscore in the host", "https://down_loads.example.com/"],
  ["a space in the host", "https://down loads.example.com/"],
  ["a percent in the host", "https://down%6Coads.example.com/"],
  ["a host in brackets", "https://[::1]/"],
  ["a non-ASCII host", "https://bücher.example/"],
  ["a host ending in a hyphen", "https://downloads-.example.com/"],
  ["a host with an empty label", "https://downloads..example.com/"],
  ["a host ending in a dot", "https://downloads.example.com./"],
  ["a backslash", "https://downloads.example.com\\get"],
  ["a quote and markup in the path", 'https://downloads.example.com/"><script>alert(1)</script>'],
  ["a space in the path", "https://downloads.example.com/get it"],
  ["a control character", "https://downloads.example.com/get\u0000"],
  ["a port out of range", "https://downloads.example.com:70000/"],
  ["too long", `https://downloads.example.com/${"a".repeat(DOWNLOAD_URL_MAX - "https://downloads.example.com/".length + 1)}`],
];

describe("DOWNLOAD_URL", () => {
  it("takes an absolute https address of a plain host name, an optional port and a path, at most 300 characters", () => {
    for (const [raw, href] of GOOD) expect(downloadUrlSetting(raw), raw).toEqual({ url: href, problem: null });
    const longest = `https://downloads.example.com/${"a".repeat(DOWNLOAD_URL_MAX - "https://downloads.example.com/".length)}`;
    expect(longest).toHaveLength(300);
    expect(downloadUrlSetting(longest)).toEqual({ url: longest, problem: null });
    expect(DOWNLOAD_URL_MAX).toBe(300);
  });

  it("leaves the feature off for every bad form, with one fixed line that names the setting and never the value", () => {
    for (const [what, raw] of BAD) {
      const got = downloadUrlSetting(raw);
      expect(got, what).toEqual({ url: null, problem: DOWNLOAD_URL_UNUSABLE });
    }
    // Not text (a Worker var written as JSON, or a binding given that name) is a value that cannot be used.
    for (const v of [42, true, { a: 1 }, ["https://downloads.example.com/"]]) expect(downloadUrlSetting(v), JSON.stringify(v)).toEqual({ url: null, problem: DOWNLOAD_URL_UNUSABLE });
    expect(DOWNLOAD_URL_UNUSABLE).toBe("download page: off, because DOWNLOAD_URL is not a usable https address. The site runs; the dashboard shows no download link.");
    expect(DOWNLOAD_URL_UNUSABLE).not.toMatch(/https:\/\/|example/);
  });

  it("unset or empty is off and says nothing", () => {
    for (const v of [undefined, null, "", "   "]) expect(downloadUrlSetting(v), JSON.stringify(v)).toEqual({ url: null, problem: null });
  });

  it("is checked by the same https check as INVITE_CONTACT, which keeps its own wider rule", () => {
    // The invite contact's https form is httpsAddressFrom without the strict shape.
    expect(inviteContactFrom("https://example.com/invite#form")).toEqual({ kind: "url", href: "https://example.com/invite#form" });
    expect(httpsAddressFrom("https://example.com/invite#form", { maxChars: 2000 })).toBe("https://example.com/invite#form");
    expect(httpsAddressFrom("https://example.com/invite#form", { maxChars: 2000, strict: true })).toBeNull();
    for (const raw of ["http://example.com/", "https://u:p@example.com/", "javascript:alert(1)"]) {
      expect(httpsAddressFrom(raw, { maxChars: 2000 }), raw).toBeNull();
      expect(inviteContactFrom(raw), raw).toBeNull();
    }
    // Every address the strict rule keeps is of the shape the page checks again.
    for (const [, href] of GOOD) expect(STRICT_HTTPS_SHAPE.test(href), href).toBe(true);
  });

  it("the page script checks the address again with the very same shape and length", () => {
    expect(DASH_JS).toContain(`var DOWNLOAD_URL = ${STRICT_HTTPS_SHAPE.toString()};`);
    expect(DASH_JS).toContain(`var DOWNLOAD_URL_MAX = ${DOWNLOAD_URL_MAX};`);
  });
});

describe("the session answer's download_url", () => {
  async function sessionOf(config: Record<string, unknown>) {
    const { deps } = await makeDeps({ ...TWO, ...config });
    const a = await seedAccount(deps, { username: "solex", admin: true });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, a.userId), "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", null);
    return send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${made!.secret}` } });
  }

  it("is null without the setting, the configured address with it, and only an added field", async () => {
    const off = await sessionOf({});
    expect(off.status).toBe(200);
    expect(off.json.download_url).toBeNull();
    expect(Object.keys(off.json)).toEqual(["account", "workspace", "session", "csrf", "email_change", "download_url"]);
    const on = await sessionOf({ downloadUrl: PAGE });
    expect(on.json.download_url).toBe(PAGE);
    // A config value that is not usable (made by hand, not from the setting) is never handed on.
    for (const bad of ["javascript:alert(1)", "http://downloads.example.com/", "https://downloads.example.com/#x"]) expect((await sessionOf({ downloadUrl: bad })).json.download_url, bad).toBeNull();
  });

  it("is documented in the API description", () => {
    const session = (openapi() as unknown as { components: { schemas: Record<string, { required: string[]; properties: Record<string, { type: unknown; description: string }> }> } }).components.schemas.Session;
    expect(session.required).toContain("download_url");
    expect(session.properties.download_url.type).toEqual(["string", "null"]);
    expect(session.properties.download_url.description).toMatch(/DOWNLOAD_URL/);
  });
});

describe("DOWNLOAD_URL on Workers", () => {
  it("the var reaches the config when usable; anything else leaves it out, with the line for a value that cannot be used", async () => {
    const load = import.meta.glob("../src/cloudflare/entry.ts");
    const entry = (await load["../src/cloudflare/entry.ts"]()) as {
      depsFromEnv(env: Record<string, unknown>, hosts: null): { config: Record<string, unknown> };
    };
    const config = (env: Record<string, unknown>) => entry.depsFromEnv({ DB: {}, DRAFTS: {}, PUB: {}, ...env }, null).config;
    expect(config({ DOWNLOAD_URL: ` ${PAGE} ` }).downloadUrl).toBe(PAGE);
    for (const v of [undefined, "", "  ", 42, { a: 1 }, "http://downloads.example.com/", "javascript:alert(1)"]) expect("downloadUrl" in config({ DOWNLOAD_URL: v }), JSON.stringify(v)).toBe(false);
  });

  it("the README names DOWNLOAD_URL in one line of its settings table, for both targets", () => {
    const readme = (import.meta.glob("../README.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../README.md"];
    const rows = readme.split("\n").filter((l) => l.startsWith("| `DOWNLOAD_URL` |"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^\| `DOWNLOAD_URL` \| both \|/);
    expect(rows[0]).toMatch(/300 characters/);
  });
});
