// The line at the foot of the platform's own pages: "Mythicshot <version> · Source code", where
// only "Source code" is a link to the copy's source, from the optional SOURCE_URL setting
// (default: the product's own repository). On every sign-in page, every dashboard page and the
// API documentation; never on a page a customer's viewers see (a tour, the player, the shared
// image and clip pages, their gates). The setting's validation table, the exact markup with the
// default and a custom address, the Worker's var, and that the line costs no database or
// storage call. The Node target's reading of the setting is in test/node-source-link.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { BILLING_PAGES, DASH_LINK_PAGES, DASH_PAGES, TERMS_PAGE } from "../src/dash/routes.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { docsHtml } from "../src/docs/page.ts";
import type { Hosts } from "../src/hosts.ts";
import { SOURCE_URL_DEFAULT, SOURCE_URL_MAX, SOURCE_URL_UNUSABLE, sourceUrlSetting } from "../src/https-address.ts";
import { MEDIA_DENIED_HTML, MEDIA_GATE_HTML, MEDIA_LINK_HTML, MEDIA_SIGNOUT_HTML } from "../src/media-view-page.ts";
import { SHARE_NOT_FOUND_HTML } from "../src/media-page.ts";
import { NOT_FOUND_HTML } from "../src/page.ts";
import { INVITE_HTML } from "../src/signin/accept.ts";
import { LINK_HTML, SIGNIN_CARD_CSS, SIGNIN_CSS, SIGNIN_HTML } from "../src/signin/page.ts";
import { SOURCE_FOOTER, SOURCE_LINE_ID, sourceFooterHtml, sourceLineHtml, withSource } from "../src/source.ts";
import { VERSION } from "../src/version.ts";
import { VIEW_CSS, VIEW_DENIED_HTML, VIEW_GATE_HTML, VIEW_LINK_HTML, VIEW_SIGNOUT_HTML } from "../src/view-page.ts";
import { clone, fixtures, send, uploadTour, type Json } from "./bundle.ts";
import { withBilling } from "./fake-stripe.ts";
import { FakeDocument, expectSourceUrl, inSourceLine, markupOf, sourceLineOf, textNodes, visibleText } from "./pages-dom.ts";
import { DASH_JS } from "../src/dash/script.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const APP = "https://app.example.com";
const CUSTOM = "https://code.example.com/our-copy";

/** The line as the owner approved it, with the default address: only "Source code" is the link. */
const LINE = `Mythicshot ${VERSION} · <a href="https://github.com/Mythicshot/mythicshot-platform" rel="noopener noreferrer">Source code</a>`;
/** The footer of the sign-in and dashboard pages, exactly. */
const FOOTER = `<footer class="source" id="source-line"><p>${LINE}</p></footer>`;

/** Every page on the app address that carries the footer, as served without the setting. */
const FOOTED: { path: string; body: string }[] = [
  ...[...DASH_PAGES, ...DASH_LINK_PAGES, TERMS_PAGE].map((p) => ({ path: p.path, body: p.html })),
  { path: "/signin", body: SIGNIN_HTML },
  { path: "/signin/link", body: LINK_HTML },
  { path: "/invite", body: INVITE_HTML },
];

/** The pages viewers of other people's content see: built from these, and none with the line. */
const VIEWERS_PAGES: Record<string, string> = {
  VIEW_GATE_HTML, VIEW_DENIED_HTML, VIEW_LINK_HTML, VIEW_SIGNOUT_HTML,
  MEDIA_GATE_IMAGE: MEDIA_GATE_HTML.image, MEDIA_GATE_CLIP: MEDIA_GATE_HTML.clip, MEDIA_DENIED_IMAGE: MEDIA_DENIED_HTML.image, MEDIA_DENIED_CLIP: MEDIA_DENIED_HTML.clip,
  MEDIA_LINK_HTML, MEDIA_SIGNOUT_HTML, SHARE_NOT_FOUND_HTML, NOT_FOUND_HTML,
};

/** Good values, as written, and what they become. */
const GOOD: [string, string][] = [
  [CUSTOM, CUSTOM],
  ["  https://code.example.com/our-copy  ", CUSTOM],
  ["HTTPS://Code.Example.COM/Our-Copy", "https://code.example.com/Our-Copy"],
  ["https://code.example.com", "https://code.example.com/"],
  ["https://code.example.com:8443/repo?ref=main&v=1", "https://code.example.com:8443/repo?ref=main&v=1"],
  [SOURCE_URL_DEFAULT, SOURCE_URL_DEFAULT],
];

/** Every bad form: each gives the one fixed line. */
const BAD: [string, unknown][] = [
  ["http", "http://code.example.com/"],
  ["http on localhost", "http://localhost:8080/"],
  ["credentials", "https://user:secret@code.example.com/"],
  ["a fragment", "https://code.example.com/#top"],
  ["scheme-relative", "//code.example.com/"],
  ["javascript:", "javascript:alert(1)"],
  ["data:", "data:text/html,<script>alert(1)</script>"],
  ["no scheme", "code.example.com"],
  ["a path alone", "/source"],
  ["a quote and markup in the path", 'https://code.example.com/"><script>alert(1)</script>'],
  ["a backslash", "https://code.example.com\\repo"],
  ["a space", "https://code.example.com/a b"],
  ["a control character", "https://code.example.com/\u0000"],
  ["a non-ASCII host", "https://bücher.example/"],
  ["an https IP address", "https://192.0.2.10/"],
  ["too long", `https://code.example.com/${"a".repeat(SOURCE_URL_MAX - "https://code.example.com/".length + 1)}`],
  ["a number", 42],
  ["an object", { a: 1 }],
  ["a list", [CUSTOM]],
  ["true", true],
];

describe("SOURCE_URL", () => {
  it("unset, null or empty is the product's own repository", () => {
    expect(SOURCE_URL_DEFAULT).toBe("https://github.com/Mythicshot/mythicshot-platform");
    for (const v of [undefined, null, "", "   ", "\t"]) expect(sourceUrlSetting(v), JSON.stringify(v)).toEqual({ ok: true, url: SOURCE_URL_DEFAULT });
  });

  it("good values are kept as URL writes them, up to the cap", () => {
    for (const [written, url] of GOOD) expect(sourceUrlSetting(written), written).toEqual({ ok: true, url });
    const longest = `https://code.example.com/${"a".repeat(SOURCE_URL_MAX - "https://code.example.com/".length)}`;
    expect(sourceUrlSetting(longest)).toEqual({ ok: true, url: longest });
    expect(SOURCE_URL_MAX).toBe(300);
  });

  it("every value that is not a strict https address is refused with the one fixed line, which names the setting and never repeats the value", () => {
    for (const [what, value] of BAD) expect(sourceUrlSetting(value), what).toEqual({ ok: false, problem: SOURCE_URL_UNUSABLE });
    expect(SOURCE_URL_UNUSABLE).toContain("SOURCE_URL");
    expect(SOURCE_URL_UNUSABLE.split("\n")).toHaveLength(1);
    expect(SOURCE_URL_UNUSABLE).not.toMatch(/https?:|example|\/\//);
  });
});

describe("the line's markup", () => {
  it("is the approved line: the software's name and running version, then the link, which alone is a link", () => {
    expect(sourceLineHtml(SOURCE_URL_DEFAULT)).toBe(LINE);
    expect(sourceFooterHtml(SOURCE_URL_DEFAULT)).toBe(FOOTER);
    expect(SOURCE_FOOTER).toBe(FOOTER);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const doc = new FakeDocument(`<!doctype html><html lang="en"><head><title>x</title></head><body>${FOOTER}</body></html>`);
    const links = doc.root.all().filter((e) => e.tagName === "a");
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("rel"), a.textContent])).toEqual([[SOURCE_URL_DEFAULT, "noopener noreferrer", "Source code"]]);
    // No target, no handler, no style: a plain link that needs no script.
    expect([...links[0].attrs].map(([n]) => n).sort()).toEqual(["href", "rel"]);
  });

  it("escapes the address it is handed, whatever it holds", () => {
    const hostile = `https://x.example/"><script>alert('x')</script>&`;
    const html = sourceLineHtml(hostile);
    expect(html).toBe(`Mythicshot ${VERSION} · <a href="https://x.example/&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;" rel="noopener noreferrer">Source code</a>`);
    expect(html).not.toContain("<script");
    // An apostrophe is a character the strict rule keeps in a path; in the attribute it is escaped.
    expect(sourceUrlSetting("https://code.example.com/a'b")).toEqual({ ok: true, url: "https://code.example.com/a'b" });
    expect(sourceLineHtml("https://code.example.com/a'b")).toContain('href="https://code.example.com/a&#39;b"');
  });

  it("withSource keeps a page with the default as it is, and puts a custom address in the one footer", () => {
    for (const p of FOOTED) {
      expect(withSource(p.body, undefined), p.path).toBe(p.body);
      expect(withSource(p.body, null), p.path).toBe(p.body);
      expect(withSource(p.body, SOURCE_URL_DEFAULT), p.path).toBe(p.body);
      expect(withSource(p.body, CUSTOM), p.path).toBe(p.body.replace(FOOTER, sourceFooterHtml(CUSTOM)));
    }
    expect(() => withSource("<p>no footer</p>", CUSTOM)).toThrow();
    expect(() => withSource(FOOTER + FOOTER, CUSTOM)).toThrow();
  });
});

describe("the pages that carry the line", () => {
  it("every sign-in page and every dashboard page holds the footer once, after its main part, as the last thing in its body", () => {
    for (const p of [...FOOTED, ...BILLING_PAGES.map((b) => ({ path: b.path, body: b.html }))]) {
      expect(p.body.split(FOOTER).length - 1, p.path).toBe(1);
      expect(p.body, p.path).toContain(`</main>\n${FOOTER}\n</body>`);
      expect(p.body.split("Source code").length - 1, p.path).toBe(1);
      expect(p.body.split('class="source"').length - 1, p.path).toBe(1);
      expect(p.body.split('id="source-line"').length - 1, p.path).toBe(1);
    }
  });

  it("served without the setting, each page is the page as built, with no database or storage call", async () => {
    for (const config of [{}, { hosts: HOSTS }]) {
      const { deps } = await makeDeps(config);
      for (const p of FOOTED) {
        const r = await send(deps, "GET", p.path, { origin: APP });
        expect([r.status, r.text, r.calls], p.path).toEqual([200, p.body, 0]);
        expect(r.text, p.path).toContain(FOOTER);
      }
    }
  });

  it("with SOURCE_URL, each page links to that address instead, and nothing else of the page or its headers changes", async () => {
    const plain = await makeDeps({ hosts: HOSTS });
    const { deps } = await makeDeps({ hosts: HOSTS, sourceUrl: CUSTOM });
    for (const p of FOOTED) {
      const before = await send(plain.deps, "GET", p.path, { origin: APP });
      const r = await send(deps, "GET", p.path, { origin: APP });
      expect([r.status, r.calls], p.path).toEqual([200, 0]);
      expect(r.text, p.path).toBe(p.body.replace(FOOTER, `<footer class="source" id="source-line"><p>Mythicshot ${VERSION} · <a href="${CUSTOM}" rel="noopener noreferrer">Source code</a></p></footer>`));
      expect(r.text, p.path).not.toContain(SOURCE_URL_DEFAULT);
      expect([...r.headers.entries()], p.path).toEqual([...before.headers.entries()]);
    }
  });

  it("the home page's link and the source link sit side by side", async () => {
    const { deps } = await makeDeps({ homeUrl: "https://www.example.com/", sourceUrl: CUSTOM });
    const r = await send(deps, "GET", "/tours");
    expect(r.text.match(/https?:\/\/[^"\s<]*/g)).toEqual(["https://www.example.com/", CUSTOM]);
  });

  it("the billing pages carry it too, with the setting's address", async () => {
    const { deps } = await makeDeps({ sourceUrl: CUSTOM });
    withBilling(deps);
    for (const p of BILLING_PAGES) {
      const r = await send(deps, "GET", p.path);
      expect([r.status, r.calls], p.path).toEqual([200, 0]);
      expect(r.text, p.path).toBe(p.html.replace(FOOTER, sourceFooterHtml(CUSTOM)));
    }
  });

  it("the API documentation keeps its sentence and adds the line in its footer", async () => {
    const html = docsHtml();
    expect(html).toContain(`<footer class="own page-footer">\n<p>The reference is shown with Swagger UI, used under the Apache License 2.0. <a href="/docs/licences.txt">Licence notices</a></p>\n<p>${LINE}</p>\n</footer>`);
    expect(docsHtml(SOURCE_URL_DEFAULT)).toBe(html);
    const { deps } = await makeDeps();
    const r = await send(deps, "GET", "/docs");
    expect([r.status, r.text === html, r.calls]).toEqual([200, true, 0]);
    // A custom address: its own page and its own ETag; the default's page is left as it was.
    const custom = await makeDeps({ sourceUrl: CUSTOM });
    const c = await send(custom.deps, "GET", "/docs");
    expect([c.status, c.calls]).toEqual([200, 0]);
    expect(c.text).toBe(html.replace(`<p>${LINE}</p>`, `<p>${sourceLineHtml(CUSTOM)}</p>`));
    expect(c.headers.get("etag")).not.toBe(r.headers.get("etag"));
    const again = await send(custom.deps, "GET", "/docs", { headers: { "if-none-match": c.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect((await send(deps, "GET", "/docs")).text === html).toBe(true);
  });

  it("the footer's look uses the brand's tokens only, on the sign-in pages and the dashboard, and the viewers' card is left as it was", () => {
    for (const css of [SIGNIN_CSS, DASH_CSS]) {
      const rule = /\.source \{([^}]*)\}/.exec(css)?.[1] ?? "";
      expect(rule).toContain("text-align: center");
      expect(rule).toContain("color: var(--text-muted)");
      expect(rule).toMatch(/font-size: 13px/);
      expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i);
    }
    // The gate pages viewers see share the sign-in card's rules, without the footer's.
    expect(SIGNIN_CARD_CSS).not.toContain(".source");
    expect(VIEW_CSS).not.toContain(".source");
  });
});

describe("the pages viewers of other people's content see", () => {
  it("none is built with the line", () => {
    for (const [name, html] of Object.entries(VIEWERS_PAGES)) {
      expect(html, name).not.toContain("Source code");
      expect(html, name).not.toContain(SOURCE_URL_DEFAULT);
      expect(html, name).not.toContain('class="source"');
    }
  });

  it("served, a published tour, a missing tour, the gates and the shared pages' fronts are the same bytes with SOURCE_URL as without it, and carry no link to the source", async () => {
    // One site, its data and its clock, served twice: once as it is, once with SOURCE_URL. Only
    // the configuration differs, so any difference in a page is the setting's.
    const { deps } = await makeDeps();
    const a = await seedAccount(deps, { username: "pub" });
    const m = clone(fixtures.v2 as Json);
    m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
    const t = await uploadTour(deps, a.token, m);
    let r = await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: a.token });
    while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: a.token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);
    const slug = (await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]))!.slug;
    const at = deps.now();
    const fixed = { ...deps, now: () => at };
    const custom = { ...fixed, config: { ...deps.config, sourceUrl: CUSTOM } };
    expect(fixed.config.sourceUrl).toBeUndefined();
    for (const path of [`/t/${slug}`, "/t/no-such-tour", "/view?t=nosuchtour", "/view/signout/nosuchtour", "/s/view", "/i/aaaaaaaaaaaaaaaaaaaa"]) {
      const without = await send(fixed, "GET", path);
      const withIt = await send(custom, "GET", path);
      expect([withIt.status, withIt.text], path).toEqual([without.status, without.text]);
      expect([...withIt.headers.entries()], path).toEqual([...without.headers.entries()]);
      for (const page of [without, withIt]) {
        expect(page.text, path).not.toContain("Source code");
        expect(page.text, path).not.toContain(SOURCE_URL_DEFAULT);
        expect(page.text, path).not.toContain(CUSTOM);
        expect(page.text, path).not.toContain('class="source"');
      }
    }
    expect((await send(fixed, "GET", `/t/${slug}`)).status).toBe(200);
    // And the same site's own pages do change with it: the setting reached the app.
    expect((await send(custom, "GET", "/signin")).text).toContain(CUSTOM);
  });
});

describe("the source line behind a dashboard question", () => {
  it("every question makes the footer inert and hidden from screen readers with what the page names, by its id", () => {
    expect(SOURCE_LINE_ID).toBe("source-line");
    expect(FOOTER).toContain(`id="${SOURCE_LINE_ID}"`);
    // Dash.question, the one way a dashboard page asks a question, adds the footer to every page's list.
    expect(DASH_JS).toContain(`each((o.behind || []).concat(["${SOURCE_LINE_ID}"]), function (e) {`);
    expect(DASH_JS.split("o.behind").length - 1).toBe(1);
  });
});

describe("the test helpers' guard on the source line (test/pages-dom.ts)", () => {
  const page = (foot: string) => `<!doctype html><html lang="en"><head><title>x</title></head><body><main><p>Words</p></main>${foot}</body></html>`;

  afterEach(() => expectSourceUrl());

  it("leaves out exactly the expected footer, and nothing of the page", () => {
    const doc = new FakeDocument(page(FOOTER));
    expect(textNodes(doc.body)).toEqual(["Words"]);
    expect(visibleText(doc)).toEqual(["Words"]);
    expect(inSourceLine(doc.root.all().find((e) => e.tagName === "a")!)).toBe(true);
    expect(markupOf(sourceLineOf(doc.root)!)).toBe(FOOTER);
    // A page without one is a stand-in a test built by hand: nothing to leave out.
    expect(textNodes(new FakeDocument(page("")).body)).toEqual(["Words"]);
    // While a question is open: the footer's inert and aria-hidden, after its own attributes.
    const behind = FOOTER.replace('id="source-line">', 'id="source-line" inert="" aria-hidden="true">');
    expect(textNodes(new FakeDocument(page(behind)).body)).toEqual(["Words"]);
  });

  it("takes a custom address only when the test said so", () => {
    const custom = page(sourceFooterHtml(CUSTOM));
    expect(() => textNodes(new FakeDocument(custom).body)).toThrow();
    expectSourceUrl(CUSTOM);
    expect(textNodes(new FakeDocument(custom).body)).toEqual(["Words"]);
    expect(() => textNodes(new FakeDocument(page(FOOTER)).body)).toThrow();
  });

  it("throws for two footers, a footer with an extra link, altered text, or anything else in or on it", () => {
    const bad: [string, string][] = [
      ["two footers", FOOTER + FOOTER],
      ["a second element of the class", `${FOOTER}<p class="source">x</p>`],
      ["an extra link", FOOTER.replace("</p></footer>", ' <a href="https://evil.example.net/">More</a></p></footer>')],
      ["altered text", FOOTER.replace("Source code", "Source")],
      ["an altered version", FOOTER.replace(`Mythicshot ${VERSION}`, "Mythicshot 9.9.9")],
      ["a username in it", FOOTER.replace("</p></footer>", "</p><p>morgan</p></footer>")],
      ["another address", FOOTER.replace(SOURCE_URL_DEFAULT, "https://evil.example.net/")],
      ["another attribute", FOOTER.replace('<footer class="source"', '<footer class="source" title="x"')],
      ["a target on the link", FOOTER.replace('rel="noopener noreferrer"', 'rel="noopener noreferrer" target="_blank"')],
    ];
    for (const [what, foot] of bad) {
      const doc = new FakeDocument(page(foot));
      expect(() => textNodes(doc.body), what).toThrow();
      expect(() => visibleText(doc), what).toThrow();
      expect(() => inSourceLine(doc.root.all().find((e) => e.tagName === "p")!), what).toThrow();
    }
  });

  it("throws for a node a script put into the footer after the page was built", () => {
    const doc = new FakeDocument(page(FOOTER));
    const footer = doc.getElementById("source-line")!;
    footer.appendChild(doc.createTextNode(" morgan"));
    expect(() => textNodes(doc.body)).toThrow();
    expect(() => visibleText(doc)).toThrow();
  });
});

describe("SOURCE_URL on Workers", () => {
  type Entry = {
    depsFromEnv(env: Record<string, unknown>, hosts: null): { config: Record<string, unknown> };
    sourceUrlFromWorkerEnv(env: Record<string, unknown>): ReturnType<typeof sourceUrlSetting>;
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

  it("the var reaches the config when usable; unset or empty is the default, and the config has no such key", async () => {
    const e = await entry();
    const config = (env: Record<string, unknown>) => e.depsFromEnv({ DB: {}, DRAFTS: {}, PUB: {}, ...env }, null).config;
    expect(config({ SOURCE_URL: ` ${CUSTOM} ` }).sourceUrl).toBe(CUSTOM);
    for (const v of [undefined, "", "  ", SOURCE_URL_DEFAULT]) expect("sourceUrl" in config({ SOURCE_URL: v }), JSON.stringify(v)).toBe(false);
    expect(e.sourceUrlFromWorkerEnv({ SOURCE_URL: CUSTOM })).toEqual({ ok: true, url: CUSTOM });
  });

  it("the pages link to the var's address", async () => {
    const e = await entry();
    const r = await e.default.fetch(new Request("https://app.example.com/signin"), { ...bindings(), SOURCE_URL: CUSTOM }, {});
    expect([r.status, await r.text()]).toEqual([200, SIGNIN_HTML.replace(FOOTER, sourceFooterHtml(CUSTOM))]);
    const plain = await e.default.fetch(new Request("https://app.example.com/signin"), bindings(), {});
    expect([plain.status, await plain.text()]).toEqual([200, SIGNIN_HTML]);
  });

  it("a value that cannot be used closes every path, as the target's other refused settings do, with the one line and no value", async () => {
    const e = await entry();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const value of ["http://made-up.example.com/", "https://user:made-up@example.com/", "javascript:alert('made-up')", 'https://made-up.example.com/"><b>', 42, { made: "up" }]) {
      const env = { ...bindings(), SOURCE_URL: value };
      for (const path of ["/signin", "/healthz", "/api/v1/me", "/docs"]) {
        const r = await e.default.fetch(new Request(`https://app.example.com${path}`), env, {});
        expect([r.status, await r.text()], `${JSON.stringify(value)} ${path}`).toEqual([500, '{"error":"misconfigured"}']);
      }
      expect(e.sourceUrlFromWorkerEnv({ SOURCE_URL: value })).toEqual({ ok: false, problem: SOURCE_URL_UNUSABLE });
    }
    const lines = logged.mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toBe(SOURCE_URL_UNUSABLE);
      expect(l.toLowerCase()).not.toContain("made-up");
    }
  });

  it("no var, or an empty one, leaves the Worker as it was", async () => {
    const e = await entry();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const extra of [{}, { SOURCE_URL: "" }, { SOURCE_URL: "  " }, { SOURCE_URL: CUSTOM }]) {
      expect((await e.default.fetch(new Request("https://tours.example.com/api/v1/me"), { ...bindings(), ...extra }, {})).status).toBe(401);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("the README names SOURCE_URL in one line of its settings table, for both targets", () => {
    const readme = (import.meta.glob("../README.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../README.md"];
    const rows = readme.split("\n").filter((l) => l.startsWith("| `SOURCE_URL` |"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^\| `SOURCE_URL` \| both \|/);
    expect(rows[0]).toContain(SOURCE_URL_DEFAULT);
    expect(rows[0]).toContain(SOURCE_URL_UNUSABLE);
    expect(rows[0]).toMatch(/300 characters/);
  });
});
