// The product's mark beside the name, and the optional HOME_URL setting that makes the two
// one link to the site's home page. The mark's route (/dash/mark.svg: where it answers, its
// headers, its bytes), the brand's exact markup with and without the setting on the
// dashboard's pages, the sign-in pages and the invite page, the setting's validation table
// and the Worker's var. The pages viewers of other people's content see are checked to be
// left as they were. The Node target's reading of the setting is in test/node-home.test.ts.
import { describe, expect, it, vi, afterEach } from "vitest";
import { makeDeps } from "#harness";
import { BRAND_PLAIN, MARK_PATH, brandHtml, withHome } from "../src/brand.ts";
import { SOURCE_URL_DEFAULT } from "../src/https-address.ts";
import { MARK_SMALL_SVG } from "../src/brand-assets.ts";
import { DASH_LINK_PAGES, DASH_PAGES, TERMS_PAGE } from "../src/dash/routes.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { HOME_URL_MAX, HOME_URL_UNUSABLE, homeUrlSetting } from "../src/https-address.ts";
import { MEDIA_DENIED_HTML, MEDIA_GATE_HTML, MEDIA_LINK_HTML, MEDIA_SIGNOUT_HTML } from "../src/media-view-page.ts";
import { SHARE_NOT_FOUND_HTML } from "../src/media-page.ts";
import { ACCOUNT_PAGE_HEADERS } from "../src/pages.ts";
import { INVITE_HTML } from "../src/signin/accept.ts";
import { inviteContactFrom } from "../src/signin/invite.ts";
import { LINK_HTML, SIGNIN_CSS, SIGNIN_HTML, signinHtml } from "../src/signin/page.ts";
import { VIEW_DENIED_HTML, VIEW_GATE_HTML, VIEW_LINK_HTML, VIEW_SIGNOUT_HTML } from "../src/view-page.ts";
import { send } from "./bundle.ts";
import { isBrandMark, isBrandMarkAlt, withoutSourceLine } from "./dash-checks.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const IMG = "https://img.example.com";
const UNKNOWN = "https://evil.example.net";
const NOT_FOUND = '{"error":"not_found"}';
const HOME = "https://www.example.com/";
const HTML = "text/html; charset=utf-8";

/** The pages' policy, written out: the mark is covered by its img-src 'self', and nothing about it changes. */
const POLICY = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY: Record<string, string> = {
  "content-security-policy": POLICY,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};

/** The wordmark, exactly: its picture for dark grounds, else the light one, named "Mythicshot". */
const WORDMARK = '<picture><source srcset="/dash/wordmark-dark.png" media="(prefers-color-scheme: dark)"><img src="/dash/wordmark-light.png" alt="Mythicshot" width="153" height="24"></picture>';
/** The brand without the setting, exactly: the mark, then the name, and no link. */
const PLAIN = `<p class="brand"><img src="/dash/mark.svg" alt="" width="24" height="24">${WORDMARK}</p>`;
/** The brand with HOME_URL=https://www.example.com/, exactly: the mark and the name as one link, same tab. */
const LINKED = `<p class="brand"><a href="https://www.example.com/" rel="noopener noreferrer"><img src="/dash/mark.svg" alt="" width="24" height="24">${WORDMARK}</a></p>`;

/** Every page on the app address that shows the brand, as served without the setting. */
const BRANDED: { path: string; body: string }[] = [
  ...[...DASH_PAGES, ...DASH_LINK_PAGES, TERMS_PAGE].map((p) => ({ path: p.path, body: p.html })),
  { path: "/signin", body: SIGNIN_HTML },
  { path: "/signin/link", body: LINK_HTML },
  { path: "/invite", body: INVITE_HTML },
];

/** Good values, as written, and what they become. */
const GOOD: [string, string][] = [
  [HOME, HOME],
  ["https://www.example.com", "https://www.example.com/"],
  ["  https://example.com/mythicshot  ", "https://example.com/mythicshot"],
  ["HTTPS://WWW.Example.COM/Home", "https://www.example.com/Home"],
  ["https://example.com:8443/?from=dashboard&v=1", "https://example.com:8443/?from=dashboard&v=1"],
  ["https://example.com:443/", "https://example.com/"],
  ["https://xn--bcher-kva.example/", "https://xn--bcher-kva.example/"],
  // http only where the address settings allow it: localhost, a *.localhost name and 127.0.0.1.
  ["http://localhost:8080/", "http://localhost:8080/"],
  ["http://localhost", "http://localhost/"],
  ["http://site.localhost/home", "http://site.localhost/home"],
  ["HTTP://LocalHost:4321/", "http://localhost:4321/"],
  ["http://127.0.0.1:4321/", "http://127.0.0.1:4321/"],
];

/** Every bad form: each gives the one fixed line. */
const BAD: [string, unknown][] = [
  ["http to another site", "http://www.example.com/"],
  ["http to a private address", "http://192.168.1.10/"],
  ["http to a name that only starts like localhost", "http://localhost.example.com/"],
  ["http to a name that ends in localhost without a dot", "http://notlocalhost/"],
  ["http to localhost in another form", "http://0x7f.1/"],
  ["credentials", "https://user:secret@www.example.com/"],
  ["a user name", "https://user@www.example.com/"],
  ["credentials on localhost", "http://user:secret@localhost/"],
  ["a fragment", "https://www.example.com/#top"],
  ["an empty fragment", "https://www.example.com/#"],
  ["scheme-relative", "//www.example.com/"],
  ["javascript:", "javascript:alert(1)"],
  ["javascript: dressed as https", "javascript://https://www.example.com/%0aalert(1)"],
  ["data:", "data:text/html,<script>alert(1)</script>"],
  ["no scheme", "www.example.com"],
  ["a path alone", "/home"],
  ["ftp", "ftp://www.example.com/"],
  ["a backslash", "https://www.example.com\\home"],
  ["a quote and markup in the path", 'https://www.example.com/"><script>alert(1)</script>'],
  ["a space", "https://www.example.com/a b"],
  ["a control character", "https://www.example.com/\u0000"],
  ["a non-ASCII host", "https://bücher.example/"],
  ["a host ending in a dot", "https://www.example.com./"],
  ["a host in brackets", "https://[::1]/"],
  ["an https IP address", "https://192.0.2.10/"],
  ["a port out of range", "https://www.example.com:70000/"],
  ["too long", `https://www.example.com/${"a".repeat(HOME_URL_MAX - "https://www.example.com/".length + 1)}`],
  ["a number", 42],
  ["an object", { a: 1 }],
  ["a list", [HOME]],
  ["true", true],
];

describe("HOME_URL", () => {
  it("good values are kept as URL writes them, up to the cap", () => {
    for (const [written, url] of GOOD) expect(homeUrlSetting(written), written).toEqual({ url, problem: null });
    const longest = `https://www.example.com/${"a".repeat(HOME_URL_MAX - "https://www.example.com/".length)}`;
    expect(longest.length).toBe(HOME_URL_MAX);
    expect(homeUrlSetting(longest)).toEqual({ url: longest, problem: null });
    expect(HOME_URL_MAX).toBe(300);
  });

  it("unset, null or empty is no link and no problem", () => {
    for (const v of [undefined, null, "", "   ", "\t"]) expect(homeUrlSetting(v), JSON.stringify(v)).toEqual({ url: null, problem: null });
  });

  it("every bad value switches the link off with the one fixed line, which names the setting and never repeats the value", () => {
    for (const [what, value] of BAD) expect(homeUrlSetting(value), what).toEqual({ url: null, problem: HOME_URL_UNUSABLE });
    expect(HOME_URL_UNUSABLE).toBe("home page: off, because HOME_URL is not a usable address. The site runs; the logo is not a link.");
    expect(HOME_URL_UNUSABLE.split("\n")).toHaveLength(1);
    expect(HOME_URL_UNUSABLE).not.toMatch(/https?:|example|\/\//);
  });
});

describe("the brand", () => {
  it("is the mark and the name, without a link when no home page is set", () => {
    expect(BRAND_PLAIN).toBe(PLAIN);
    expect(brandHtml(null)).toBe(PLAIN);
    expect(MARK_PATH).toBe("/dash/mark.svg");
    for (const p of BRANDED) {
      expect(p.body.split(PLAIN).length - 1, p.path).toBe(1);
      expect(withHome(p.body, null), p.path).toBe(p.body);
      expect(withHome(p.body, undefined), p.path).toBe(p.body);
    }
  });

  it("with a home page, the mark and the name are one link to it in the same tab, named by the name alone", () => {
    expect(brandHtml(HOME)).toBe(LINKED);
    for (const p of BRANDED) {
      const page = withHome(p.body, HOME);
      expect(page, p.path).toBe(p.body.replace(PLAIN, LINKED));
      const doc = new FakeDocument(page);
      const links = doc.body.all().filter((e) => e.tagName === "a" && e.getAttribute("href") === HOME);
      expect(links, p.path).toHaveLength(1);
      const a = links[0];
      expect([a.parent?.className, a.getAttribute("rel"), a.hasAttribute("target"), a.textContent], p.path).toEqual(["brand", "noopener noreferrer", false, ""]);
      // The mark is decoration (an empty alt) and the wordmark's alt is the name, so the link's accessible name is "Mythicshot".
      const img = a.all().filter((e) => e.tagName === "img");
      expect(img.map((e) => [e.getAttribute("src"), e.getAttribute("alt"), e.getAttribute("width"), e.getAttribute("height")]), p.path).toEqual([["/dash/mark.svg", "", "24", "24"], ["/dash/wordmark-light.png", "Mythicshot", "153", "24"]]);
      expect(a.hasAttribute("aria-label") || a.hasAttribute("title"), p.path).toBe(false);
      // Nothing else on the page changed: its words are the same.
      expect(textNodes(doc.body), p.path).toEqual(textNodes(new FakeDocument(p.body).body));
    }
  });

  it("escapes the address it writes", () => {
    expect(brandHtml("https://www.example.com/?a=1&b='x'")).toBe(
      `<p class="brand"><a href="https://www.example.com/?a=1&amp;b=&#39;x&#39;" rel="noopener noreferrer"><img src="/dash/mark.svg" alt="" width="24" height="24">${WORDMARK}</a></p>`,
    );
    expect(brandHtml('https://x.example/"><b>')).not.toContain('"><b>');
  });

  it("is written into a page only where the plain brand is, exactly once", () => {
    expect(() => withHome("<p>no brand</p>", HOME)).toThrow();
    expect(() => withHome(PLAIN + PLAIN, HOME)).toThrow();
  });

  it("the stylesheets set the mark beside the name and keep the shared focus ring for the link", () => {
    for (const [what, css] of [["dash.css", DASH_CSS], ["signin.css", SIGNIN_CSS]] as const) {
      expect(css, what).toMatch(/\n\.brand \{[^}]*display: flex;[^}]*align-items: center;[^}]*gap: 8px;/);
      expect(css, what).toContain("\n.brand a { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }");
      expect(css, what).toContain("\n.brand img { display: block; flex: none; }");
      // The link's focus ring is the brand's one every control has; nothing takes it away.
      expect(css, what).toContain("\n:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }");
      expect(css, what).not.toMatch(/\.brand[^{]*:focus/);
      // The only address in the stylesheets is the text font's, on the same address.
      expect([...css.matchAll(/url\("([^"]+)"\)/g)].every((m) => m[1].startsWith("/fonts/manrope.")), what).toBe(true);
      // The name is the wordmark's picture at its own size; should it fail to load, its alt shows in the wordmark's colour.
      expect(css, what).toContain("\n.brand { font-size: 20px; line-height: 24px; font-weight: 700; color: var(--wordmark); }\n.brand picture { display: block; flex: none; }\n");
    }
  });
});

describe("the mark's file", () => {
  it("answers on the app address with the dashboard's headers but a picture's policy, an SVG and no database or storage call", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    const three = await makeDeps({ hosts: THREE, homeUrl: HOME });
    for (const [deps, origin] of [[one.deps, "https://any.example.org"], [one.deps, "http://localhost:3000"], [two.deps, APP], [three.deps, APP]] as const) {
      const r = await send(deps, "GET", "/dash/mark.svg", { origin });
      expect(r.status, origin).toBe(200);
      expect(Object.fromEntries(r.headers.entries()), origin).toEqual({ ...SECURITY, "content-security-policy": "default-src 'none'; sandbox", "content-type": "image/svg+xml" });
      expect(r.bytes.length, origin).toBeGreaterThan(0);
      expect(r.text, origin).toBe(MARK_SMALL_SVG);
      expect(r.calls, origin).toBe(0);
      expect(r.headers.get("set-cookie"), origin).toBeNull();
    }
    const head = await send(two.deps, "HEAD", "/dash/mark.svg", { origin: APP });
    expect([head.status, head.bytes.length, head.headers.get("content-type"), head.calls]).toEqual([200, 0, "image/svg+xml", 0]);
    // A second answer is the same text: the file is not used up by the first.
    expect((await send(two.deps, "GET", "/dash/mark.svg", { origin: APP })).text).toBe(MARK_SMALL_SVG);
  });

  it("is the brand's small mark (the one for sizes below 48 pixels), as SVG, small", () => {
    expect(MARK_SMALL_SVG.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img">')).toBe(true);
    expect(MARK_SMALL_SVG.match(/<polygon /g)).toHaveLength(4);
    expect(MARK_SMALL_SVG.length).toBeLessThan(1_000);
  });

  it("answers on the app address only, as the dashboard's other files do", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    const three = await makeDeps({ hosts: THREE });
    expect(HOST_RULES["GET /dash/mark.svg"]).toBe("app");
    for (const deps of [two.deps, three.deps]) {
      const onTours = await send(deps, "GET", "/dash/mark.svg", { origin: TOURS });
      expect([onTours.status, onTours.text, onTours.calls, onTours.headers.get("location")]).toEqual([404, NOT_FOUND, 0, null]);
    }
    const onImg = await send(three.deps, "GET", "/dash/mark.svg", { origin: IMG });
    expect([onImg.status, onImg.text, onImg.calls]).toEqual([404, NOT_FOUND, 0]);
    const unknown = await send(two.deps, "GET", "/dash/mark.svg", { origin: UNKNOWN });
    expect([unknown.status, unknown.bytes.length, unknown.calls]).toEqual([421, 0, 0]);
    // Left out of the description with its reason, as the dashboard's other files are.
    expect(UNDOCUMENTED_ROUTES["GET /dash/mark.svg"]?.length ?? 0).toBeGreaterThan(10);
  });
});

describe("the pages with and without HOME_URL", () => {
  it("without it, every branded page is served as built: the mark beside the name, no link, no other site", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    for (const p of BRANDED) {
      const r = await send(deps, "GET", p.path, { origin: APP });
      expect([r.status, r.text, r.calls], p.path).toEqual([200, p.body, 0]);
      expect(r.text, p.path).toContain(PLAIN);
      // No other site but the source line's (src/source.ts, test/source-link.test.ts).
      expect(withoutSourceLine(r.text), p.path).not.toMatch(/https?:|\/\//i);
    }
  });

  it("with it, every branded page links the brand to the home page; the headers, policy included, are unchanged", async () => {
    for (const config of [{ homeUrl: HOME }, { hosts: HOSTS, homeUrl: HOME }]) {
      const { deps } = await makeDeps(config);
      for (const p of BRANDED) {
        const r = await send(deps, "GET", p.path, { origin: APP });
        expect([r.status, r.calls], p.path).toEqual([200, 0]);
        expect(r.text, p.path).toBe(p.body.replace(PLAIN, LINKED));
        expect(Object.fromEntries(r.headers.entries()), p.path).toEqual({ ...SECURITY, "content-type": HTML });
        // The addresses of other sites in the page are the home page's, in the link, and the source line's.
        expect(r.text.match(/https?:\/\/[^"\s<]*/g), p.path).toEqual([HOME, SOURCE_URL_DEFAULT]);
      }
    }
    expect(ACCOUNT_PAGE_HEADERS["content-security-policy"]).toBe(POLICY);
  });

  it("the sign-in page keeps its invite line beside the linked brand", async () => {
    const contact = "https://invite.example.com/ask";
    const { deps } = await makeDeps({ homeUrl: HOME, inviteContact: contact });
    const r = await send(deps, "GET", "/signin", { origin: APP });
    expect(r.text).toBe(signinHtml(inviteContactFrom(contact)).replace(PLAIN, LINKED));
    expect(r.text).toContain('<a href="https://invite.example.com/ask" rel="noopener noreferrer">Ask for an invite</a>');
  });

  it("the pages viewers of other people's content see are left as they were: no mark, no link", async () => {
    const left = [
      VIEW_GATE_HTML, VIEW_DENIED_HTML, VIEW_LINK_HTML, VIEW_SIGNOUT_HTML,
      MEDIA_GATE_HTML.image, MEDIA_GATE_HTML.clip, MEDIA_DENIED_HTML.image, MEDIA_DENIED_HTML.clip, MEDIA_LINK_HTML, MEDIA_SIGNOUT_HTML,
      SHARE_NOT_FOUND_HTML,
    ];
    for (const html of left) {
      expect(html).not.toContain("mark.png");
      expect(html).not.toContain("<img");
    }
    // Served on the tours address with the setting, the gate pages are the same bytes as without it.
    const without = await makeDeps({ hosts: HOSTS });
    const withIt = await makeDeps({ hosts: HOSTS, homeUrl: HOME });
    for (const path of ["/view?t=nosuchtour", "/view/signout/nosuchtour", "/t/no-such-tour", "/i/aaaaaaaaaaaaaaaaaaaa"]) {
      const a = await send(without.deps, "GET", path, { origin: TOURS });
      const b = await send(withIt.deps, "GET", path, { origin: TOURS });
      expect([b.status, b.text], path).toEqual([a.status, a.text]);
      expect(b.text, path).not.toContain(HOME);
    }
  });
});

describe("HOME_URL on Workers", () => {
  type Entry = {
    depsFromEnv(env: Record<string, unknown>, hosts: null): { config: Record<string, unknown> };
    default: { fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Response | Promise<Response> };
  };
  const load = import.meta.glob("../src/cloudflare/entry.ts");
  const entry = async () => (await load["../src/cloudflare/entry.ts"]()) as Entry;
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the var reaches the config when usable, and is left out when unset or empty", async () => {
    const e = await entry();
    const config = (env: Record<string, unknown>) => e.depsFromEnv({ DB: {}, DRAFTS: {}, PUB: {}, ...env }, null).config;
    expect(config({ HOME_URL: ` ${HOME} ` }).homeUrl).toBe(HOME);
    expect(config({ HOME_URL: "http://localhost:8787" }).homeUrl).toBe("http://localhost:8787/");
    for (const v of [undefined, "", "  "]) expect("homeUrl" in config({ HOME_URL: v }), JSON.stringify(v)).toBe(false);
  });

  it("a value that cannot be used never stops the Worker: the pages, the mark and the health check answer, the logo is no link, and the one line is logged once per isolate", async () => {
    const e = await entry();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A stand-in database that answers the health check's one query, and nothing else.
    const db = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
    for (const value of ["http://made-up.example.com/", "https://user:made-up@example.com/", "javascript:alert('made-up')", 42, { made: "up" }]) {
      const env = { ...bindings(), HOME_URL: value };
      const signin = await e.default.fetch(new Request("https://app.example.com/signin"), env, {});
      expect([signin.status, await signin.text()], JSON.stringify(value)).toEqual([200, SIGNIN_HTML]);
      const mark = await e.default.fetch(new Request("https://app.example.com/dash/mark.svg"), env, {});
      expect([mark.status, mark.headers.get("content-type")], JSON.stringify(value)).toEqual([200, "image/svg+xml"]);
      await mark.arrayBuffer();
      const health = await e.default.fetch(new Request("https://app.example.com/healthz"), { ...env, DB: db }, {});
      expect([health.status, await health.text()], JSON.stringify(value)).toEqual([200, '{"ok":true}']);
      expect("homeUrl" in e.depsFromEnv({ DB: {}, DRAFTS: {}, PUB: {}, HOME_URL: value }, null).config, JSON.stringify(value)).toBe(false);
    }
    const lines = logged.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("HOME_URL"))).toEqual([HOME_URL_UNUSABLE]);
    for (const l of lines) expect(l.toLowerCase()).not.toContain("made-up");
  });

  it("no var, or an empty one, leaves the Worker as it was", async () => {
    const e = await entry();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const extra of [{}, { HOME_URL: "" }, { HOME_URL: "  " }, { HOME_URL: HOME }]) {
      expect((await e.default.fetch(new Request("https://tours.example.com/api/v1/me"), { ...bindings(), ...extra }, {})).status).toBe(401);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("the README names HOME_URL in one line of its settings table, for both targets", () => {
    const readme = (import.meta.glob("../README.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../README.md"];
    const rows = readme.split("\n").filter((l) => l.startsWith("| `HOME_URL` |"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^\| `HOME_URL` \| both \|/);
    expect(rows[0]).toMatch(/300 characters/);
    expect(rows[0]).toMatch(/localhost/);
    expect(rows[0]).toContain("never stops the site");
  });
});

describe("the test exemption for the mark and the wordmark", () => {
  const page = (brand: string, extra = "") => `<!doctype html><html lang="en"><head><title>x</title></head><body><header>${brand}</header>${extra}</body></html>`;
  const marks = (html: string) => new FakeDocument(html).root.all().filter((e) => e.tagName === "img");

  it("covers the mark and the wordmark exactly as the pages write them, plain and linked", () => {
    for (const brand of [PLAIN, LINKED]) {
      const imgs = marks(page(brand));
      expect(imgs.map((e) => e.getAttribute("src")), brand).toEqual(["/dash/mark.svg", "/dash/wordmark-light.png"]);
      for (const img of imgs) expect([isBrandMark(img), isBrandMarkAlt(img, "alt"), isBrandMarkAlt(img, "title")], brand).toEqual([true, true, false]);
    }
  });

  it("does not cover an image with another attribute, another value, another parent, or a second mark", () => {
    const cases: [string, string][] = [
      ["an onerror", page(PLAIN.replace('height="24">', 'height="24" onerror="x">'))],
      ["a title", page(PLAIN.replace('alt=""', 'alt="" title="logo"'))],
      ["words in the alt", page(PLAIN.replace('alt=""', 'alt="logo"'))],
      ["another size", page(PLAIN.replace('width="24"', 'width="25"'))],
      ["another file", page(PLAIN.replace("/dash/mark.svg", "/dash/other.png"))],
      ["attributes in another order", page(PLAIN.replace('src="/dash/mark.svg" alt=""', 'alt="" src="/dash/mark.svg"'))],
      ["outside the brand", page("<p>Mythicshot</p>", '<p><img src="/dash/mark.svg" alt="" width="24" height="24"></p>')],
      ["inside a link that is not the brand's", page("<p>Mythicshot</p>", '<p><a href="/x"><img src="/dash/mark.svg" alt="" width="24" height="24"></a></p>')],
    ];
    const wordmarkCases: [string, string][] = [
      ["an onerror on the wordmark", page(PLAIN.replace('height="24"></picture>', 'height="24" onerror="x"></picture>'))],
      ["other words in its alt", page(PLAIN.replace('alt="Mythicshot"', 'alt="Click here"'))],
      ["another source", page(PLAIN.replace('srcset="/dash/wordmark-dark.png"', 'srcset="https://x.example/w.png"'))],
      ["no source", page(PLAIN.replace(/<source[^>]*>/, ""))],
      ["a second source", page(PLAIN.replace("<picture>", '<picture><source srcset="/x.png">'))],
      ["its picture outside the brand", page("<p>Mythicshot</p>", `<p>${WORDMARK}</p>`)],
      ["without its picture", page(PLAIN.replace(/<\/?picture>/g, "").replace(/<source[^>]*>/, ""))],
    ];
    for (const [what, html] of wordmarkCases) {
      const word = marks(html).filter((e) => e.getAttribute("src") !== "/dash/mark.svg");
      expect(word.length, what).toBeGreaterThan(0);
      for (const img of word) expect([isBrandMark(img), isBrandMarkAlt(img, "alt")], what).toEqual([false, false]);
    }
    // The mark's cases: the wordmark beside it is untouched and stays covered.
    for (const [what, html] of cases) for (const img of marks(html).filter((e) => e.getAttribute("src") !== "/dash/wordmark-light.png")) expect([isBrandMark(img), isBrandMarkAlt(img, "alt")], what).toEqual([false, false]);
    // A second mark, even a second whole brand, makes neither one the mark.
    const two = marks(page(PLAIN, PLAIN));
    expect(two).toHaveLength(4);
    for (const img of two) expect(isBrandMark(img)).toBe(false);
    const extra = marks(page(PLAIN, '<p><img src="/dash/mark.svg" alt="" width="24" height="24"></p>'));
    for (const img of extra.filter((e) => e.getAttribute("src") === "/dash/mark.svg")) expect(isBrandMark(img)).toBe(false);
  });
});
