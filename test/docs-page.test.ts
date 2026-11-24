// The documentation page, its four files, the licence notices and where each answers:
// headers, caching, the policy, the host rules, and that none of it costs a database or
// storage call, needs a token or sets a cookie. Then the page itself: its parts, that it
// loads nothing but its own files, and what its script may and may not do with a token.
// (The guides' commands are run in test/docs-guides.test.ts.)
import { describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { intercept, looksLikeToken, REFUSED, type ViewerRequest } from "../src/docs/client/rules.ts";
import { GUIDE_ORIGIN, GUIDES } from "../src/docs/guides.ts";
import { GET_STARTED, openapi } from "../src/docs/openapi.ts";
import { DOCS_CSP, DOCS_PAGE_CACHE, docsFile, docsHtml } from "../src/docs/page.ts";
import { DOCS_CSS, DOCS_CSS_ETAG, DOCS_CSS_PATH, DOCS_JS, DOCS_JS_ETAG, DOCS_JS_PATH } from "../src/docs/site-assets.ts";
import { VIEWER_CSS, VIEWER_CSS_ETAG, VIEWER_CSS_PATH, VIEWER_JS, VIEWER_JS_ETAG, VIEWER_JS_PATH, VIEWER_LICENCES } from "../src/docs/viewer-assets.ts";
import type { Hosts } from "../src/hosts.ts";
import { contentSecurityPolicy } from "../src/page.ts";
import { MANROPE_FACE, PAGE_BASE_CSS } from "../src/brand-css.ts";
import { VERSION } from "../src/version.ts";
import { send, type Call } from "./bundle.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const UNKNOWN = "https://evil.example.net";
const NOT_FOUND = '{"error":"not_found"}';
const FAKE_TOKEN = "dp_" + "0".repeat(40);

const twoAddress = (config?: Parameters<typeof makeDeps>[0]) => makeDeps({ hosts: HOSTS, ...config });

type File = { name: string; path: string; body: string; etag: string; type: string };
const FILES: File[] = [
  { name: "the viewer's script", path: VIEWER_JS_PATH, body: VIEWER_JS, etag: VIEWER_JS_ETAG, type: "text/javascript; charset=utf-8" },
  { name: "the viewer's stylesheet", path: VIEWER_CSS_PATH, body: VIEWER_CSS, etag: VIEWER_CSS_ETAG, type: "text/css; charset=utf-8" },
  { name: "the page script", path: DOCS_JS_PATH, body: DOCS_JS, etag: DOCS_JS_ETAG, type: "text/javascript; charset=utf-8" },
  { name: "the page stylesheet", path: DOCS_CSS_PATH, body: DOCS_CSS, etag: DOCS_CSS_ETAG, type: "text/css; charset=utf-8" },
];
/** Everything this plan serves: the page, its files, the notices and the two description files. */
const EVERYTHING = ["/docs", ...FILES.map((f) => f.path), "/docs/licences.txt", "/api/v1/openapi.json", "/api/v1/openapi.yaml"];

/** The same file name with another build's hash. */
const otherHash = (path: string) => path.replace(/\.[0-9a-f]{16}\./, ".0123456789abcdef.");

/** The policy as directive name -> its sources. */
function directives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    expect(out[name], `${name} given twice`).toBeUndefined();
    out[name] = sources;
  }
  return out;
}

function expectNotHere(r: Call, what: string): void {
  expect(r.status, what).toBe(404);
  expect(r.text, what).toBe(NOT_FOUND);
  expect(r.headers.get("content-type"), what).toBe("application/json");
  expect(r.headers.get("cache-control"), what).toBe("no-store");
  expect(r.headers.get("location"), what).toBeNull();
  expect(r.calls, what).toBe(0);
}

describe("the documentation page", () => {
  it("answers with the page, its type, a short cache and an ETag, and 304 for a matching If-None-Match", async () => {
    const { deps } = await makeDeps();
    const r = await send(deps, "GET", "/docs");
    expect(r.status).toBe(200);
    expect(r.text).toBe(docsHtml());
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(DOCS_PAGE_CACHE).toBe("public, max-age=300");
    expect(r.headers.get("cache-control")).toBe(DOCS_PAGE_CACHE);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = r.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const again = await send(deps, "GET", "/docs", { headers: { "if-none-match": header } });
      expect(again.status, header).toBe(304);
      expect(again.bytes.length, header).toBe(0);
      for (const h of ["content-security-policy", "x-frame-options", "referrer-policy", "x-content-type-options", "cache-control", "etag"]) {
        expect(again.headers.get(h), `${header} ${h}`).toBe(r.headers.get(h));
      }
    }
    expect((await send(deps, "GET", "/docs", { headers: { "if-none-match": '"other"' } })).status).toBe(200);

    const head = await send(deps, "HEAD", "/docs");
    expect(head.status).toBe(200);
    expect(head.bytes.length).toBe(0);
    expect(head.headers.get("etag")).toBe(etag);
    expect(head.headers.get("content-security-policy")).toBe(DOCS_CSP);

    // The same bytes for every host and on every call, and nothing in them but our own files.
    expect(docsHtml()).toBe(docsHtml());
    expect((await send(deps, "GET", "/docs?x=1", { origin: "http://localhost:8787" })).text).toBe(r.text);
    const linked = [...r.text.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]).filter((l) => !l.startsWith("#"));
    expect(linked.sort()).toEqual([...FILES.map((f) => f.path), "/docs/licences.txt", "/api/v1/openapi.json", "/api/v1/openapi.yaml", "/favicon.ico", "/favicon.svg"].sort());
    // The only address in it is the examples' placeholder, which is no host at all.
    expect(r.text.split(GUIDE_ORIGIN).join("")).not.toMatch(/:\/\/|example\.|localhost/);
    expect(r.text).not.toMatch(/<style|style=|\son[a-z]+=|<script(?![^>]*\ssrc=)/i);
    expect(r.text).toContain("<title>Mythicshot API documentation</title>");
    expect(r.text).toContain("The reference needs JavaScript. Everything it shows is also in the description, as JSON and YAML above.");
  });

  it("the page sends the docs policy, forbids framing and relaxes nothing", async () => {
    // The policy, exactly. A change here is a decision, not a refactoring.
    expect(DOCS_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const d = directives(DOCS_CSP);
    expect(Object.keys(d)).toEqual(["default-src", "script-src", "style-src", "font-src", "img-src", "connect-src", "base-uri", "form-action", "frame-ancestors"]);
    // Scripts and style sheets come from this origin only: nothing inline, nothing evaluated.
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["style-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["default-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(DOCS_CSP).not.toContain("unsafe-eval");
    expect(DOCS_CSP).not.toContain("wasm");
    // Nothing inline at all: not a script, not a style sheet, and (on trial, to be checked
    // in a browser) not a style attribute either. If the viewer needs those, the one
    // directive "style-src-attr 'unsafe-inline'" comes back, here and in src/docs/page.ts.
    expect(DOCS_CSP).not.toContain("unsafe-inline");
    for (const name of ["script-src-elem", "script-src-attr", "style-src-elem", "style-src-attr"]) expect(d[name], name).toBeUndefined();
    // No wildcard, no scheme but data: and blob: for pictures, no host name.
    expect(DOCS_CSP).not.toMatch(/\*|https?:|wss?:|\/\/|\.[a-z]/);
    for (const [name, sources] of Object.entries(d)) {
      for (const s of sources) expect(["'self'", "'none'", ...(name === "img-src" ? ["data:", "blob:"] : [])], `${name} ${s}`).toContain(s);
    }

    for (const make of [() => makeDeps(), () => twoAddress()]) {
      const { deps } = await make();
      const r = await send(deps, "GET", "/docs", { origin: APP });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-security-policy")).toBe(DOCS_CSP);
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("content-security-policy-report-only")).toBeNull();
    }
  });

  it("the tour page's policy is unchanged", () => {
    expect(contentSecurityPolicy("")).toBe("default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'");
    expect(contentSecurityPolicy("")).not.toBe(DOCS_CSP);
  });

  it("the tours address sends /docs on to the app address and serves no docs file", async () => {
    const { deps } = await twoAddress();
    const expectRedirect = (r: Call, location: string) => {
      expect(r.status, location).toBe(308);
      expect(r.headers.get("location"), location).toBe(location);
      expect(r.headers.get("cache-control"), location).toBe("no-store");
      expect(r.headers.get("referrer-policy"), location).toBe("no-referrer");
      expect(r.headers.get("x-content-type-options"), location).toBe("nosniff");
      expect(r.headers.get("content-type"), location).toBeNull();
      expect(r.headers.get("content-security-policy"), location).toBeNull();
      expect(r.headers.get("etag"), location).toBeNull();
      expect(r.bytes.length, location).toBe(0);
      expect(r.calls, location).toBe(0);
    };
    expectRedirect(await send(deps, "GET", "/docs", { origin: TOURS }), "https://app.example.com/docs");
    expectRedirect(await send(deps, "GET", "/docs?x=1&y=%2F%2Fevil.example.net#frag", { origin: TOURS }), "https://app.example.com/docs?x=1&y=%2F%2Fevil.example.net");
    expectRedirect(await send(deps, "HEAD", "/docs", { origin: TOURS }), "https://app.example.com/docs");
    // A matching If-None-Match gets the redirect too, never a 304 from the tours origin.
    expectRedirect(await send(deps, "GET", "/docs", { origin: TOURS, headers: { "if-none-match": "*" } }), "https://app.example.com/docs");

    for (const path of [...FILES.map((f) => f.path), ...FILES.map((f) => otherHash(f.path)), "/docs/licences.txt"]) {
      expectNotHere(await send(deps, "GET", path, { origin: TOURS }), path);
      expectNotHere(await send(deps, "GET", path, { origin: TOURS, headers: { "if-none-match": "*" } }), `${path} conditional`);
    }
    // The description is public text beside the API, on either address.
    for (const path of ["/api/v1/openapi.json", "/api/v1/openapi.yaml"]) {
      for (const origin of [TOURS, APP]) expect((await send(deps, "GET", path, { origin })).status, `${origin}${path}`).toBe(200);
    }
    // An unknown host gets nothing of any of them.
    for (const path of EVERYTHING) {
      const r = await send(deps, "GET", path, { origin: UNKNOWN });
      expect(r.status, path).toBe(421);
      expect(r.bytes.length, path).toBe(0);
      expect(r.headers.get("location"), path).toBeNull();
    }

    // A local pair keeps its port and uses http.
    const local = await twoAddress({ hosts: { tours: "tours.localhost:8787", app: "app.localhost:8787" } });
    expectRedirect(await send(local.deps, "GET", "/docs?x=1", { origin: "http://tours.localhost:8787" }), "http://app.localhost:8787/docs?x=1");
    expect((await send(local.deps, "GET", "/docs", { origin: "http://app.localhost:8787" })).status).toBe(200);
  });

  it("following the redirect ends on the app address without another redirect", async () => {
    const { deps } = await twoAddress();
    const first = await send(deps, "GET", "/docs?from=tours", { origin: TOURS });
    expect(first.status).toBe(308);
    const next = new URL(first.headers.get("location")!);
    expect(next.origin).toBe(APP);
    const second = await send(deps, "GET", next.pathname + next.search, { origin: next.origin });
    expect(second.status).toBe(200);
    expect(second.headers.get("location")).toBeNull();
    expect(second.text).toBe(docsHtml());
    // And every file the page names answers there.
    for (const f of FILES) expect((await send(deps, "GET", f.path, { origin: next.origin })).status, f.name).toBe(200);
  });

  it("the app address never redirects /docs, and a forged forwarded host changes nothing", async () => {
    const { deps } = await twoAddress();
    const forged: Record<string, string>[] = [
      {},
      { "x-forwarded-host": "tours.example.com" },
      { forwarded: "host=tours.example.com;proto=https" },
      { "x-forwarded-host": "evil.example.net", forwarded: "host=evil.example.net", "x-original-host": "evil.example.net", "x-host": "evil.example.net" },
    ];
    for (const headers of forged) {
      const what = JSON.stringify(headers);
      const onApp = await send(deps, "GET", "/docs", { origin: APP, headers });
      expect(onApp.status, what).toBe(200);
      expect(onApp.headers.get("location"), what).toBeNull();
      expect(onApp.text, what).toBe(docsHtml());
      // Nor do they move the tours address's redirect anywhere but the configured app host.
      const onTours = await send(deps, "GET", "/docs", { origin: TOURS, headers: { ...headers, "x-forwarded-host": "app.example.com" } });
      expect(onTours.status, what).toBe(308);
      expect(onTours.headers.get("location"), what).toBe("https://app.example.com/docs");
      expect((await send(deps, "GET", VIEWER_CSS_PATH, { origin: TOURS, headers: { "x-forwarded-host": "app.example.com" } })).status, what).toBe(404);
    }
  });

  it("the page, its files and the description need no token, ignore one, set no cookie and send no cross-origin header", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme");
    for (const path of EVERYTHING) {
      const plain = await send(deps, "GET", path);
      expect(plain.status, path).toBe(200);
      for (const token of [a.token, FAKE_TOKEN, "not a token"]) {
        const r = await send(deps, "GET", path, { headers: { authorization: `Bearer ${token}`, cookie: "session=abc", origin: "https://evil.example.net" } });
        expect(r.status, path).toBe(200);
        expect(r.text, path).toBe(plain.text);
        for (const [name, value] of plain.headers) expect(r.headers.get(name), `${path} ${name}`).toBe(value);
        expect(r.headers.get("set-cookie"), path).toBeNull();
        expect(r.headers.getSetCookie(), path).toEqual([]);
        for (const [header] of r.headers) expect(header.startsWith("access-control-"), `${path} ${header}`).toBe(false);
        expect(r.headers.get("vary"), path).toBeNull();
        expect(r.headers.get("www-authenticate"), path).toBeNull();
      }
      // No answer repeats the token.
      expect(plain.text.includes(a.token), path).toBe(false);
    }
    // Sending a token here does not count as using it.
    const row = await deps.db.first<{ last_used_at: number | null }>("SELECT last_used_at FROM api_token WHERE workspace_id = ?", [a.workspaceId]);
    expect(row?.last_used_at).toBeNull();
  });

  it("none of them makes a database or storage call", async () => {
    for (const make of [() => makeDeps(), () => twoAddress()]) {
      const { deps, calls } = await make();
      const before = calls();
      for (const path of EVERYTHING) {
        for (const origin of [APP, TOURS, UNKNOWN]) {
          for (const headers of [{}, { "if-none-match": "*" }] as Record<string, string>[]) {
            const r = await send(deps, "GET", path, { origin, headers });
            expect(r.calls, `${origin}${path}`).toBe(0);
          }
        }
      }
      expect(calls() - before).toBe(0);
    }
  });

  it("the hashed address is cached for good, another hash briefly, and a matching If-None-Match answers 304", async () => {
    const { deps } = await makeDeps();
    for (const f of FILES) {
      expect(f.path, f.name).toMatch(/^\/docs\/(viewer|docs)\.[0-9a-f]{16}\.(js|css)$/);
      const r = await send(deps, "GET", f.path);
      expect(r.status, f.name).toBe(200);
      expect(r.text === f.body, `${f.name}: the body is the file`).toBe(true);
      expect(r.bytes.length, f.name).toBe(new TextEncoder().encode(f.body).length);
      expect(r.headers.get("content-type"), f.name).toBe(f.type);
      expect(r.headers.get("cache-control"), f.name).toBe("public, max-age=31536000, immutable");
      expect(r.headers.get("etag"), f.name).toBe(f.etag);
      expect(r.headers.get("x-content-type-options"), f.name).toBe("nosniff");

      // Another build's hash gets today's file, briefly, so no cache keeps a mismatch.
      const other = await send(deps, "GET", otherHash(f.path));
      expect(other.status, f.name).toBe(200);
      expect(other.text === f.body, f.name).toBe(true);
      expect(other.headers.get("cache-control"), f.name).toBe("public, max-age=300");
      expect(other.headers.get("etag"), f.name).toBe(f.etag);

      for (const [path, cache] of [[f.path, "public, max-age=31536000, immutable"], [otherHash(f.path), "public, max-age=300"]]) {
        for (const header of [f.etag, `W/${f.etag}`, "*"]) {
          const cached = await send(deps, "GET", path, { headers: { "if-none-match": header } });
          expect(cached.status, `${f.name} ${header}`).toBe(304);
          expect(cached.bytes.length, f.name).toBe(0);
          expect(cached.headers.get("etag"), f.name).toBe(f.etag);
          expect(cached.headers.get("cache-control"), f.name).toBe(cache);
          expect(cached.headers.get("content-type"), f.name).toBe(f.type);
        }
        expect((await send(deps, "GET", path, { headers: { "if-none-match": '"something-else"' } })).status, f.name).toBe(200);
      }

      const head = await send(deps, "HEAD", f.path);
      expect(head.status, f.name).toBe(200);
      expect(head.bytes.length, f.name).toBe(0);
      expect(head.headers.get("etag"), f.name).toBe(f.etag);

      // A second answer is the same bytes: the file is held once and reused.
      expect((await send(deps, "GET", f.path)).text === f.body, f.name).toBe(true);
    }
    // The page names exactly these four addresses.
    for (const f of FILES) expect(docsHtml()).toContain(`"${f.path}"`);
    // docsFile knows only its own names.
    for (const path of ["/docs", "/docs/", "/docs/licences.txt", "/docs/viewer.js", "/player.js", `/x${VIEWER_JS_PATH}`, `${VIEWER_JS_PATH}/`, VIEWER_JS_PATH.replace("viewer", "player")]) {
      expect(docsFile(path), path).toBeNull();
    }
    expect(docsFile(VIEWER_CSS_PATH)?.status).toBe(200);
    expect(docsFile(VIEWER_CSS_PATH, VIEWER_CSS_ETAG)?.status).toBe(304);
  });

  it("the licence notices are served as plain text for a day", async () => {
    const { deps } = await makeDeps();
    const r = await send(deps, "GET", "/docs/licences.txt");
    expect(r.status).toBe(200);
    expect(r.text === VIEWER_LICENCES).toBe(true);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.text).toContain("Apache License");
    expect(docsHtml()).toContain('href="/docs/licences.txt"');
  });

  it("anything else under /docs is not found", async () => {
    const paths = [
      "/docs/",
      "/docs/viewer.js",
      "/docs/docs.js",
      "/docs/viewer.0123456789abcdef.map",
      "/docs/viewer.0123456789abcdef.js.map",
      "/docs/viewer.0123456789ABCDEF.js",
      "/docs/viewer.0123456789abcde.js",
      "/docs/player.0123456789abcdef.js",
      "/docs/../setup",
      "/docs/%2e%2e/setup",
      "/docs/licences",
      "/docs/licences.txt/",
      "/docs/index.html",
      "/docs/swagger-ui-bundle.js",
      "/docs/swagger-ui-standalone-preset.js",
      "/docs/openapi.json",
      "/api/v1/openapi",
      "/api/v1/openapi.yml",
      "/DOCS",
    ];
    for (const make of [() => makeDeps(), () => twoAddress()]) {
      const { deps } = await make();
      for (const path of paths) {
        for (const origin of [APP, TOURS]) {
          const r = await send(deps, "GET", path, { origin });
          // "/docs/../setup" is "/setup" by the time it is a request: the wizard, off here.
          expect(r.status, `${origin}${path}`).toBe(404);
          expect(r.headers.get("location"), `${origin}${path}`).toBeNull();
          expect(r.calls, `${origin}${path}`).toBe(0);
          if (!path.endsWith("/setup")) expect(r.text, `${origin}${path}`).toBe(NOT_FOUND);
        }
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const path of EVERYTHING) expect((await send(deps, method, path, { origin: APP })).status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it("the stylesheet's source map, which a browser's developer tools ask for, is a plain quiet 404", async () => {
    // The viewer's stylesheet ends with a pointer to a map that is not shipped. A browser
    // with its developer tools open resolves it against the stylesheet's address and asks.
    expect(VIEWER_CSS.trimEnd().endsWith("/*# sourceMappingURL=swagger-ui.css.map*/")).toBe(true);
    const asked = new URL("swagger-ui.css.map", APP + VIEWER_CSS_PATH).pathname;
    expect(asked).toBe("/docs/swagger-ui.css.map");
    expect(VIEWER_JS).not.toContain("sourceMappingURL");
    expect(DOCS_JS).not.toContain("sourceMappingURL");
    expect(DOCS_CSS).not.toContain("sourceMappingURL");

    const noise = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    try {
      for (const make of [() => makeDeps(), () => twoAddress()]) {
        const { deps } = await make();
        for (const origin of [APP, TOURS]) {
          const r = await send(deps, "GET", asked, { origin });
          expect(r.status, origin).toBe(404);
          expect(r.text, origin).toBe(NOT_FOUND);
          expect(r.headers.get("content-type"), origin).toMatch(/^application\/json/);
          expect(r.headers.get("location"), origin).toBeNull();
          expect(r.headers.get("set-cookie"), origin).toBeNull();
          expect(r.calls, origin).toBe(0);
        }
      }
      // Nothing is logged for it: it is an ordinary request for something that is not there.
      for (const spy of noise) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of noise) spy.mockRestore();
    }
  });
});

/** The page with its tags taken out: the text a reader sees. */
function visible(html: string): string {
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  return html
    .replace(/<head>[\s\S]*?<\/head>/, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => entities[e])
    .replace(/\s+/g, " ");
}

describe("the documentation page's parts", () => {
  it("the page has the approved parts in order", () => {
    const html = docsHtml();
    const parts = [
      // The header, with the version and the two download links.
      "<h1>Mythicshot API</h1>",
      `<p>Version ${VERSION}</p>`,
      'Download the description: <a href="/api/v1/openapi.json">JSON</a> <a href="/api/v1/openapi.yaml">YAML</a>',
      // Get connected, with its three steps.
      "<h2>Get connected</h2>",
      "<li>Create a token in your workspace. Today the setup wizard shows it once, at the end of setup; keep it in a password manager.</li>",
      "<li>Send it with every request, as the header <code>Authorization: Bearer YOUR_TOKEN</code>. A token typed into a command stays in your shell&#39;s history. Put it in a variable first, with read -rs TOKEN, and write $TOKEN in place of YOUR_TOKEN.</li>",
      "<li>Try the first call. It answers with your workspace's name and the server's version.</li>",
      // The token box.
      '<label for="token">Paste a token to try the calls on this page</label>',
      '<input id="token" type="password"',
      '<button type="button" id="use-token">Use token</button>',
      "Kept in this tab only, never stored.",
      // The first command, with its copy button.
      '<code id="first-command">curl https://YOUR-SITE/api/v1/me -H &quot;Authorization: Bearer YOUR_TOKEN&quot;</code></pre><button type="button" hidden>Copy</button>',
      // The links to the three guides.
      ">Guides</h3>",
      '<a href="#guide-upload-and-publish">Upload and publish a tour</a>',
      '<a href="#guide-update-a-tour">Update a tour over the same link</a>',
      '<a href="#guide-errors-and-limits">Errors and limits</a>',
      // The reference: the mount the viewer fills, and what is shown without JavaScript.
      '<h2 id="reference-title">Reference</h2>',
      '<div id="reference"><noscript><p>The reference needs JavaScript. Everything it shows is also in the description, as JSON and YAML above.</p></noscript></div>',
      // The three guides, as sections of this page.
      '<section class="own block guide" id="guide-upload-and-publish">\n<h2>Upload and publish a tour</h2>',
      '<section class="own block guide" id="guide-update-a-tour">\n<h2>Update a tour over the same link</h2>',
      '<section class="own block guide" id="guide-errors-and-limits">\n<h2>Errors and limits</h2>',
      "<h3>Error codes</h3>",
      "<h3>Limits</h3>",
      // The footer, then the two scripts, the viewer's first.
      'The reference is shown with Swagger UI, used under the Apache License 2.0. <a href="/docs/licences.txt">Licence notices</a>',
      `<script src="${VIEWER_JS_PATH}"></script>\n<script src="${DOCS_JS_PATH}"></script>\n</body>`,
    ];
    let at = 0;
    for (const part of parts) {
      const found = html.indexOf(part, at);
      expect(found, `missing, or out of order: ${part}`).toBeGreaterThanOrEqual(0);
      expect(html.split(part).length - 1, `more than once: ${part}`).toBe(1);
      at = found + part.length;
    }
    // One of each landmark, one h1, and the first command is the description's own.
    for (const tag of ["<header", "<main>", "<footer", "<h1>", "<title>"]) expect(html.split(tag).length - 1, tag).toBe(1);
    expect(html).toContain(GET_STARTED.replace(/"/g, "&quot;"));
    expect(GUIDES.map((g) => g.title)).toEqual(["Upload and publish a tour", "Update a tour over the same link", "Errors and limits"]);
    // Every link into the page lands on something, and every id is there once.
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const anchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
    expect(anchors).toEqual(["guide-upload-and-publish", "guide-update-a-tour", "guide-errors-and-limits"]);
    for (const anchor of anchors) expect(ids, anchor).toContain(anchor);
    expect(html).toContain('<label for="token">');
    expect(html).toContain('aria-labelledby="reference-title"');
    // The stylesheets come before anything is drawn, the viewer's first so ours can take its two parts away.
    expect(html.indexOf(VIEWER_CSS_PATH)).toBeLessThan(html.indexOf(DOCS_CSS_PATH));
    expect(html.indexOf(DOCS_CSS_PATH)).toBeLessThan(html.indexOf("<body>"));
  });

  it("the page is the same bytes for every host and carries only the placeholder origin", async () => {
    const html = docsHtml();
    const { deps } = await makeDeps();
    const two = await twoAddress();
    const local = await twoAddress({ hosts: { tours: "tours.localhost:8787", app: "app.localhost:8787" } });
    const answers = [
      await send(deps, "GET", "/docs"),
      await send(deps, "GET", "/docs", { origin: "http://localhost:8787" }),
      await send(deps, "GET", "/docs", { origin: "https://anything.example.net" }),
      await send(two.deps, "GET", "/docs", { origin: APP }),
      await send(local.deps, "GET", "/docs", { origin: "http://app.localhost:8787" }),
    ];
    for (const r of answers) {
      expect(r.status).toBe(200);
      expect(r.text === html).toBe(true);
      expect(r.headers.get("etag")).toBe(answers[0].headers.get("etag"));
    }
    // Every address in the page is the placeholder, in a command; the script puts the real one in.
    expect(GUIDE_ORIGIN).toBe("https://YOUR-SITE");
    const addresses = html.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<&]*/g) ?? [];
    expect(addresses.length).toBeGreaterThan(10);
    for (const address of addresses) expect(address.startsWith(`${GUIDE_ORIGIN}/api/v1/`), address).toBe(true);
    for (const host of ["example.com", "example.net", "localhost", "mythicshot.com"]) expect(html, host).not.toContain(host);
    expect(DOCS_JS).toContain(JSON.stringify(GUIDE_ORIGIN));
    expect(DOCS_JS).toContain("location.origin");
    // Nothing in the page changes from one moment to the next: no date, no id made up on the way.
    expect(docsHtml() === html).toBe(true);
  });

  it("the page loads only its own four files", () => {
    const html = docsHtml();
    const loaded = [...html.matchAll(/<(script|link|img|iframe|object|embed|source|video|audio|form|base|meta)\b([^>]*)>/g)].map((m) => `${m[1]}${m[2]}`);
    expect(loaded).toEqual([
      'meta charset="utf-8"',
      'meta name="viewport" content="width=device-width, initial-scale=1"',
      'meta name="referrer" content="no-referrer"',
      'link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"',
      'link rel="icon" href="/favicon.svg" type="image/svg+xml"',
      `link rel="stylesheet" href="${VIEWER_CSS_PATH}"`,
      `link rel="stylesheet" href="${DOCS_CSS_PATH}"`,
      `script src="${VIEWER_JS_PATH}"`,
      `script src="${DOCS_JS_PATH}"`,
    ]);
    // Every src and href is one of the four hashed files, a place on this page, a description file or the notices.
    const allowed = new Set([VIEWER_CSS_PATH, DOCS_CSS_PATH, VIEWER_JS_PATH, DOCS_JS_PATH, "/api/v1/openapi.json", "/api/v1/openapi.yaml", "/docs/licences.txt", "/favicon.ico", "/favicon.svg"]);
    for (const m of html.matchAll(/\s(?:src|href|action|formaction|poster|srcset|data|ping|background)="([^"]*)"/g)) {
      expect(m[1].startsWith("#guide-") || allowed.has(m[1]), m[1]).toBe(true);
    }
    // Nothing inline: no script without a src, no style element, no style or event attribute.
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(m[1]).toMatch(/^ src="\/docs\/(viewer|docs)\.[0-9a-f]{16}\.js"$/);
      expect(m[2]).toBe("");
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:|data:|blob:|<svg\b/i);
    expect(html).not.toMatch(/\starget=/);
    // Our stylesheet and script load nothing either.
    expect(DOCS_CSS.replace(MANROPE_FACE, "")).not.toMatch(/url\(|@import|@font-face|expression\(/i);
    expect(DOCS_JS).not.toMatch(/import\(|importScripts|createElement\("(script|link|style|iframe|img)"\)|\.src\s*=|\.href\s*=/);
  });

  it("the token field is a password field outside any form, with autocomplete off", () => {
    const html = docsHtml();
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toEqual(['<input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">']);
    // No form anywhere, so nothing can submit the field; and no name, so nothing would carry it.
    expect(html).not.toMatch(/<form\b/i);
    expect(inputs[0]).not.toMatch(/\sname=|\svalue=/);
    expect(html).not.toMatch(/<textarea\b|<select\b/i);
    // Every button only does what the script gives it: none can submit.
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length).toBeGreaterThan(3);
    for (const b of buttons) expect(b, b).toContain('type="button"');
    // Without the page script the box and the copy buttons would do nothing, so they start hidden.
    expect(html).toContain('<div class="token-box" id="token-box" hidden>');
    expect(html).toContain('<button type="button" id="forget-token" class="quiet" hidden>Forget token</button>');
    for (const b of buttons.filter((x) => !x.includes("id="))) expect(b).toBe('<button type="button" hidden>');
    expect(DOCS_CSS).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    // What happened to the token is told to a screen reader, too.
    expect(html).toContain('<p class="status" id="token-status" role="status" aria-live="polite"></p>');
  });

  it("the page script keeps the token in memory only", () => {
    // Nowhere to keep it, nowhere to send it but fetch, and no way to make markup or code of text.
    const never = [
      "localStorage", "sessionStorage", "indexedDB", "document.cookie", "cookie", "window.name", "sendBeacon", "WebSocket", "EventSource", "XMLHttpRequest",
      "postMessage", "BroadcastChannel", "SharedWorker", "serviceWorker", "caches", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write",
      "history.", "pushState", "replaceState", "location.hash =", "location.href =", "location.assign", "location.replace", "window.open", "eval(", "new Function",
      "setAttribute", "console.", "opener", "Image(",
    ];
    for (const word of never) expect(DOCS_JS.includes(word), word).toBe(false);
    // The address is only read: to resolve a request against it, to show it, and to return to a guide.
    expect([...new Set([...DOCS_JS.matchAll(/location\.([a-z]+)/g)].map((m) => m[1]))].sort()).toEqual(["hash", "href", "origin"]);
    expect(DOCS_JS).not.toMatch(/location\.[a-z]+\s*=[^=]/);
    expect(DOCS_JS).not.toMatch(/\blocation\s*=[^=]/);

    // One fetch of our own, to this site's /api/v1/me, without cookies.
    const fetches = [...DOCS_JS.matchAll(/\bfetch\(([^;]*);/g)].map((m) => m[1]);
    expect(fetches).toHaveLength(1);
    for (const call of fetches) {
      expect(call.startsWith('"/api/v1/me", { credentials: "omit",'), call).toBe(true);
      expect(call).toContain('redirect: "error"');
      expect(call).toContain('referrerPolicy: "no-referrer"');
      expect(call).toContain('cache: "no-store"');
    }
    expect(DOCS_JS).not.toMatch(/credentials: "(include|same-origin)"/);
    expect(DOCS_JS).toContain('req.credentials = "omit";');

    // The token is one variable of the script's closure: declared once, set only by the token box.
    expect(DOCS_JS.startsWith('"use strict";\n(() => {')).toBe(true);
    expect(DOCS_JS.trimEnd().endsWith("})();")).toBe(true);
    expect(DOCS_JS.match(/\bvar token = "";/g)).toHaveLength(1);
    // It is emptied in one place, which also throws the viewer away and starts a new one,
    // since the viewer keeps and shows the requests it sent.
    expect([...DOCS_JS.matchAll(/^\s*token = (.+);$/gm)].map((m) => m[1]).sort()).toEqual(['""', "candidate"]);
    expect(DOCS_JS).toMatch(/function dropToken\(\) \{\s*if \(token === ""\) return;\s*token = "";\s*document\.querySelector\(MOUNT\)\?\.replaceChildren\(\);\s*startViewer\(\);\s*\}/);
    expect(DOCS_JS.match(/\bdropToken\(\);/g)).toHaveLength(2);
    expect(DOCS_JS).not.toMatch(/(window|globalThis|self|document)\.[A-Za-z_$]+\s*=[^=]/);
    // It is read in one place only: where a request of the viewer is let through.
    expect(DOCS_JS).toContain("requestInterceptor: (req) => intercept(req, location.href, token)");
    // (Counted with every quoted text taken out, since the messages say "token" too.)
    const code = DOCS_JS.replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    expect(code.match(/\btoken\b/g)).toHaveLength(5);
    // What the visitor typed is cleared from the field once the server has answered.
    expect(DOCS_JS).toContain('input.value = "";');
    // The page is told only through text nodes and class names.
    expect(DOCS_JS).toContain("status.textContent = text;");
  });

  it("the page script starts the viewer with the validator off, no stored authorisation and the base layout", () => {
    for (const option of [
      'url: "/api/v1/openapi.json"',
      "dom_id: MOUNT",
      'layout: "BaseLayout"',
      "presets: [SwaggerUIBundle.presets.apis]",
      "validatorUrl: null",
      "persistAuthorization: false",
      "deepLinking: true",
      'docExpansion: "list"',
      "defaultModelsExpandDepth: -1",
      "requestSnippetsEnabled: true",
      "withCredentials: false",
      "requestInterceptor: (req) => intercept(req, location.href, token)",
    ]) {
      expect(DOCS_JS, option).toContain(option);
    }
    expect(DOCS_JS).toContain('var MOUNT = "#reference";');
    expect(docsHtml()).toContain('<div id="reference">');
    // The viewer's own top bar and its second preset are not used, and nothing turns the settings above back on.
    expect(DOCS_JS).not.toMatch(/StandaloneLayout|SwaggerUIStandalonePreset|persistAuthorization: true|withCredentials: true|validatorUrl: "|oauth|preauthorize|queryConfigEnabled|configUrl/);
    // The viewer still reads every one of those settings by these names.
    for (const name of ["validatorUrl", "persistAuthorization", "requestInterceptor", "withCredentials", "deepLinking", "docExpansion", "defaultModelsExpandDepth", "requestSnippetsEnabled", "onComplete", "BaseLayout"]) {
      expect(VIEWER_JS.includes(name), name).toBe(true);
    }
    // The script keeps nothing of the viewer it starts, and reaches into none of its insides:
    // to forget a token it starts a new viewer instead.
    expect(DOCS_JS).not.toMatch(/=\s*SwaggerUIBundle\(/);
    for (const name of ["clearRequest", "clearResponse", "specSelectors", "specActions", "mutatedRequests", "getSystem"]) expect(DOCS_JS.includes(name), name).toBe(false);
    // Why: the viewer keeps each request it sent, as the interceptor left it, under this name.
    expect(VIEWER_JS).toContain("mutatedRequests");
  });

  it("the interceptor refuses another origin and a path outside the API", () => {
    const PAGE = "https://app.example.com/docs#guide-errors-and-limits";
    const TOKEN = FAKE_TOKEN;
    const req = (url: string, more: Partial<ViewerRequest> = {}): ViewerRequest => ({ url, method: "GET", headers: { Accept: "application/json" }, ...more });
    expect(REFUSED).toBe("This page only sends requests to this site's own API.");

    // To this site's API: no cookie, and the token.
    for (const url of ["https://app.example.com/api/v1/me", "/api/v1/tours", "/api/v1/uploads/up_000000000000000000000000/steps/1", "https://APP.example.com:443/api/v1/me?x=1", "//app.example.com/api/v1/me"]) {
      const out = intercept(req(url, { credentials: "include" }), PAGE, TOKEN);
      expect(out.credentials, url).toBe("omit");
      expect(out.headers, url).toEqual({ Accept: "application/json", Authorization: `Bearer ${TOKEN}` });
      expect(out.url, url).toBe(url);
    }
    // Without a token held, nothing is added; with one, it replaces any the request came with.
    expect(intercept(req("/api/v1/me"), PAGE, "")).toEqual({ url: "/api/v1/me", method: "GET", credentials: "omit", headers: { Accept: "application/json" } });
    expect(intercept(req("/api/v1/me", { headers: { Authorization: "Bearer other" } }), PAGE, TOKEN).headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(intercept({ url: "/api/v1/me" }, PAGE, TOKEN)).toEqual({ url: "/api/v1/me", credentials: "omit", headers: { Authorization: `Bearer ${TOKEN}` } });
    // The description is public: fetching it never carries the token.
    expect(intercept(req("/api/v1/openapi.json", { loadSpec: true, credentials: "same-origin" }), PAGE, TOKEN)).toEqual({ url: "/api/v1/openapi.json", method: "GET", loadSpec: true, credentials: "omit", headers: { Accept: "application/json" } });
    // The health check is the one documented request outside /api/v1/: allowed, without cookie or token.
    expect(intercept(req("/healthz", { credentials: "include" }), PAGE, TOKEN)).toEqual({ url: "/healthz", method: "GET", credentials: "omit", headers: { Accept: "application/json" } });

    // Anything else is refused before it is sent: another origin, another scheme or port, a path outside the API.
    const refused = [
      "https://tours.example.com/api/v1/me",
      "https://evil.example.net/api/v1/me",
      "http://app.example.com/api/v1/me",
      "https://app.example.com:8443/api/v1/me",
      "https://app.example.com.evil.example.net/api/v1/me",
      "https://app.example.com@evil.example.net/api/v1/me",
      "//evil.example.net/api/v1/me",
      "\\\\evil.example.net/api/v1/me",
      "/\\evil.example.net/api/v1/me",
      "/setup",
      "/setup/claim",
      "/docs",
      "/t/some-slug",
      "/api/v1",
      "/api/v10/me",
      "/api/v2/me",
      "/api/v1/../../setup/claim",
      "/api/v1/%2e%2e/%2E%2E/setup/claim",
      "/api/v1/..\\..\\setup",
      "/healthz/",
      "/healthz/../setup",
      "/healthzz",
      "/API/V1/me",
      "javascript:alert(1)",
      "data:text/plain,x",
      "blob:https://app.example.com/1",
      "file:///etc/passwd",
      "ws://app.example.com/api/v1/me",
      "https://",
      "",
    ];
    for (const url of refused) {
      const r = req(url, { credentials: "include" });
      expect(() => intercept(r, PAGE, TOKEN), url).toThrow(REFUSED);
      // A refused request is left as it was: nothing was added to it.
      expect(r, url).toEqual({ url, method: "GET", credentials: "include", headers: { Accept: "application/json" } });
    }
    // An empty address is the page itself, and dots are worked out as a browser does before the check.
    expect(new URL("", PAGE).pathname).toBe("/docs");
    expect(new URL("/api/v1/%2e%2e/%2E%2E/setup/claim", PAGE).pathname).toBe("/setup/claim");
    // A page address that makes no sense refuses everything.
    expect(() => intercept(req("/api/v1/me"), "not an address", TOKEN)).toThrow(REFUSED);
    // On a local server the same rules hold for its own origin.
    expect(intercept(req("http://localhost:8787/api/v1/me"), "http://localhost:8787/docs", TOKEN).credentials).toBe("omit");
    expect(() => intercept(req("http://127.0.0.1:8787/api/v1/me"), "http://localhost:8787/docs", TOKEN)).toThrow(REFUSED);

    // The script's idea of a token is the server's.
    expect(looksLikeToken(FAKE_TOKEN)).toBe(true);
    for (const bad of ["", "dp_", "YOUR_TOKEN", "dp_" + "0".repeat(39), "dp_" + "0".repeat(41), "dp_" + "G".repeat(40), "DP_" + "0".repeat(40), ` ${FAKE_TOKEN}`, `${FAKE_TOKEN}\n`, `Bearer ${FAKE_TOKEN}`]) {
      expect(looksLikeToken(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(FAKE_TOKEN).toHaveLength(43);
  });

  it("a request from the documentation page never carries a cookie, also to a session route", async () => {
    const PAGE = "https://app.example.com/docs";
    // Every operation of the description, as "Try it" would send it, asking for the browser's cookies.
    const requests: ViewerRequest[] = [];
    for (const [path, item] of Object.entries(openapi().paths)) {
      for (const [method, op] of Object.entries(item)) {
        const url = path.replace("{id}", "ses_" + "0".repeat(24)).replace("{step_id}", "st_" + "0".repeat(24)).replace("{n}", "1");
        requests.push({ url, method: method.toUpperCase(), credentials: "include", headers: { Accept: "application/json" } });
        // The operations a session may call are described with it, so the viewer knows of the cookie.
        // A visitor's viewer requests (src/viewers.ts) take no session, and the one that reads the viewer cookie says so instead.
        // A token ending itself takes the token alone, and is described without the session.
        if (path === "/api/v1/token") expect(op.security, `${method} ${path}`).toEqual([{ token: [] }]);
        else if (path.startsWith("/api/v1/view/") || path.startsWith("/api/v1/media-view/")) expect(JSON.stringify(op.security), `${method} ${path}`).not.toContain("session");
        else if (path !== "/healthz" && !path.startsWith("/api/v1/signin/") && !path.startsWith("/api/v1/invite/") && path !== "/api/v1/connect/start" && path !== "/api/v1/connect/token") expect(JSON.stringify(op.security), `${method} ${path}`).toContain("session");
      }
    }
    const sessionRoutes = requests.filter((r) => /\/api\/v1\/(?:session|sessions|signout)/.test(r.url));
    expect(sessionRoutes.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/v1/session",
      "GET /api/v1/sessions",
      "DELETE /api/v1/sessions/ses_000000000000000000000000",
      "POST /api/v1/signout",
      "POST /api/v1/signout/everywhere",
    ]);
    for (const token of [FAKE_TOKEN, ""]) {
      for (const r of requests) {
        const out = intercept({ ...r, headers: { ...r.headers } }, PAGE, token);
        expect(out.credentials, `${r.method} ${r.url}`).toBe("omit");
        // Nothing of a session is ever added: no cookie and no anti-forgery header.
        for (const name of Object.keys(out.headers ?? {})) expect(["accept", "authorization"], `${r.method} ${r.url}: ${name}`).toContain(name.toLowerCase());
      }
    }
    // The page script has no way to send one either: it never reads or writes a cookie, and never asks for the session.
    expect(DOCS_JS).not.toMatch(/credentials: "(include|same-origin)"/);
    expect(DOCS_JS.includes("x-csrf-token") || DOCS_JS.includes("X-Csrf-Token")).toBe(false);
    expect(DOCS_JS.includes("/api/v1/session")).toBe(false);
    // And the server answers a session route sent the way the page sends it (a token, no cookie) as nobody.
    const { deps } = await twoAddress();
    const a = await seedWorkspace(deps, "Acme");
    for (const r of sessionRoutes) {
      const answer = await send(deps, r.method ?? "GET", r.url, { origin: APP, token: a.token });
      expect([answer.status, answer.text], `${r.method} ${r.url}`).toEqual([401, '{"error":"unauthorized"}']);
    }
  });

  it("a seeded token is what the page script takes for a token, and the request the token box makes tells the three cases apart", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme");
    expect(looksLikeToken(a.token)).toBe(true);
    expect((await send(deps, "GET", "/api/v1/me", { token: a.token })).json.workspace).toBe("Acme");
    expect((await send(deps, "GET", "/api/v1/me", { token: FAKE_TOKEN })).status).toBe(401);
    expect((await send(deps, "GET", "/api/v1/me")).status).toBe(401);
  });

  it("every string the page and its script show is the approved one", () => {
    const text = visible(docsHtml());
    for (const s of [
      "Mythicshot API",
      `Version ${VERSION}`,
      "Download the description: JSON YAML",
      "Get connected",
      "Create a token in your workspace. Today the setup wizard shows it once, at the end of setup; keep it in a password manager.",
      "Send it with every request, as the header Authorization: Bearer YOUR_TOKEN . A token typed into a command stays in your shell's history. Put it in a variable first, with read -rs TOKEN, and write $TOKEN in place of YOUR_TOKEN.",
      "Try the first call. It answers with your workspace's name and the server's version.",
      "Paste a token to try the calls on this page",
      "Use token",
      "Kept in this tab only, never stored.",
      "Forget token",
      'curl https://YOUR-SITE/api/v1/me -H "Authorization: Bearer YOUR_TOKEN"',
      "Copy",
      "Guides",
      "Upload and publish a tour",
      "Update a tour over the same link",
      "Errors and limits",
      "Reference",
      "The reference needs JavaScript. Everything it shows is also in the description, as JSON and YAML above.",
      "The reference is shown with Swagger UI, used under the Apache License 2.0. Licence notices",
    ]) {
      expect(text, s).toContain(s);
    }
    expect(docsHtml()).toContain("<title>Mythicshot API documentation</title>");
    // The three steps are a numbered list, so they read "1.", "2.", "3.".
    expect(docsHtml()).toMatch(/<h2>Get connected<\/h2>\n<ol class="steps">\n<li>Create[^\n]*\n<li>Send[^\n]*\n<li>Try[^\n]*\n<\/ol>/);
    // What the script says, word for word.
    for (const s of [
      '"That does not look like a token. A token starts with dp_ and is 43 characters long."',
      '"Checking\\u2026"',
      "`Connected to ${workspace}. The calls on this page now use this token.`",
      '"The server does not know this token. Check that you pasted all of it."',
      '"The server could not be reached. Try again."',
      '"Token forgotten."',
      '"Copy"',
      '"Copied"',
      '"The reference could not be loaded. Reload the page, or read the description as JSON or YAML."',
      '"This page only sends requests to this site\'s own API."',
    ]) {
      expect(DOCS_JS, s).toContain(s);
    }
  });
});

describe("the documentation page beside the viewer", () => {
  /** The stylesheet without its comments. */
  const css = DOCS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  /** Every selector of the stylesheet, media queries opened up. */
  const selectors = [...css.replace(/@media[^{]*\{/g, "").matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter((s) => s !== "");

  it("hides the viewer's own title block, its authorise bar and the lock buttons that open it, and nothing else of it but its ground", () => {
    const viewerRules = selectors.filter((s) => s.includes("swagger-ui"));
    // The three it hides, and in the dark scheme its ground, made see-through so the page's shows (no other property).
    expect(viewerRules).toEqual(["html.dark-mode .swagger-ui", ".swagger-ui .information-container", ".swagger-ui .scheme-container", ".swagger-ui .authorization__btn"]);
    expect(css).toMatch(/\nhtml\.dark-mode \.swagger-ui \{\s*background: transparent;\s*\}/);
    expect(css).toMatch(/\.swagger-ui \.information-container,\s*\.swagger-ui \.scheme-container,\s*\.swagger-ui \.authorization__btn \{\s*display: none;\s*\}/);
    // The lock button on each request opens the viewer's token dialog, which the viewer
    // draws inside the hidden bar: left visible, the button would do nothing. The dialog
    // itself stays hidden with the bar; the page's token box is the one way to give a token.
    expect(VIEWER_JS).toContain('className:"authorization__btn"');
    expect(VIEWER_CSS).toContain(".swagger-ui .authorization__btn{");
    expect(css).not.toMatch(/auth-wrapper|auth-container|dialog-ux|modal-ux/);
    // Both names are the viewer's own, as its script writes them: the block around its
    // title and introduction, and the bar that holds the servers and the Authorize button.
    expect(VIEWER_JS).toContain('{className:"information-container"}');
    expect(VIEWER_JS).toContain('"div",{className:"scheme-container"}');
    expect(VIEWER_JS.split("information-container").length - 1).toBe(1);
    expect(VIEWER_JS.split('"scheme-container"').length - 1).toBe(1);
    expect(VIEWER_CSS).toContain(".swagger-ui .scheme-container{");
    // The bar holds the servers and the authorise button of the layout in use.
    const at = VIEWER_JS.indexOf('className:"scheme-container"');
    const bar = VIEWER_JS.slice(at, at + 600);
    expect(bar).toContain("schemes wrapper");
    expect(VIEWER_JS).toContain('className:"auth-wrapper"');

    // display: none appears for those two and for [hidden] alone, and nothing is hidden another way.
    expect(css.match(/display:\s*none/g)).toHaveLength(2); // the one rule for the viewer's three parts, and [hidden]
    expect(css).not.toMatch(/visibility:\s*hidden|opacity:\s*0|height:\s*0|clip-path|text-indent/);
    // Every other rule is about our own blocks, so nothing here restyles the viewer: it is
    // under ".own", names a class or id only our markup has, or is the page itself.
    const ours = /^(\.own\b|\.(page-header|page-footer|block|steps|note|answers|legend|token-box|token-row|status|command|guide-links|table-wrap|limits)\b|#reference\b|:root$|html$|html\.dark-mode$|body$|\[hidden\]$|@font-face$)/;
    for (const s of selectors.filter((x) => !x.includes("swagger-ui"))) expect(ours.test(s), s).toBe(true);
    // And none of those class names is one the viewer's stylesheet uses.
    for (const name of ["own", "page-header", "page-footer", "block", "steps", "note", "answers", "legend", "token-box", "token-row", "status", "command", "guide-links", "table-wrap", "limits"]) {
      expect(new RegExp(`\\.${name}(?![\\w-])`).test(VIEWER_CSS), name).toBe(false);
    }
    // The viewer's stylesheet, for its part, styles nothing outside itself.
    const outside = [...VIEWER_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:^|\})([^{}@]+)\{/g)]
      .flatMap((m) => m[1].split(","))
      .map((s) => s.trim())
      .filter((s) => !s.startsWith(".swagger-ui") && !s.startsWith("html.dark-mode") && !/^(\d+(\.\d+)?%|from|to)$/.test(s));
    expect(outside).toEqual([]);
  });

  it("is light or dark as the system is, and switches the viewer's own dark look on with it", () => {
    // The brand's colours, named once and given for both schemes (src/brand-tokens.ts); nothing else in the stylesheet is a colour.
    expect(DOCS_CSS.startsWith(PAGE_BASE_CSS)).toBe(true);
    const light = /:root \{([^}]*)\}/.exec(css)![1];
    const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css)![1];
    const names = (block: string) => [...block.matchAll(/(--[a-z-]+): #/g)].map((m) => m[1]);
    expect(names(light).length).toBeGreaterThanOrEqual(25);
    expect(names(dark)).toEqual(names(light));
    expect(light).toContain("color-scheme: light dark");
    const rest = css.slice(css.indexOf("[hidden]"));
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(css).toMatch(/\nbody \{[^}]*background: var\(--ground\);[^}]*color: var\(--text\);/);

    // The viewer has a dark look of its own, keyed on a class on the html element; it does
    // not follow the system by itself, so the page script sets that class from the system's setting.
    expect(VIEWER_CSS).toContain("html.dark-mode .swagger-ui{background:#1c2022;color:#e4e6e6}");
    expect(VIEWER_CSS).not.toContain("prefers-color-scheme");
    expect(VIEWER_JS).not.toContain("dark-mode");
    expect(DOCS_JS).toContain('var DARK = "dark-mode";');
    expect(DOCS_JS).toContain('matchMedia("(prefers-color-scheme: dark)")');
    expect(DOCS_JS).toContain("document.documentElement.classList.toggle(DARK, dark.matches)");
    expect(DOCS_JS).toContain('dark.addEventListener("change", apply)');
    // In the dark scheme the viewer's own ground is see-through, so the page's brand ground runs behind it without a seam.
    expect(css).toMatch(/\nhtml\.dark-mode \{\s*background: var\(--ground\);\s*\}/);
  });

  it("fits a phone and a keyboard: one column, long commands wrap, focus shows", () => {
    expect(docsHtml()).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(css).toMatch(/\.command pre \{[^}]*white-space: pre-wrap;/);
    expect(css).toMatch(/\.command pre \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.table-wrap \{\s*overflow-x: auto;/);
    expect(css).toMatch(/@media \(max-width: 600px\)/);
    // No fixed width anywhere: only max-width, and widths in percent.
    expect(css).not.toMatch(/[^-]width:\s*\d+(px|rem|em)/);
    // Keyboard: what can be focused shows it, in the page's order, with nothing taken out of it.
    expect(css).toContain(".own :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }");
    expect(css).not.toMatch(/outline:\s*(none|0)/);
    expect(docsHtml()).not.toMatch(/tabindex=/);
    expect(DOCS_JS).toContain('if (event.key === "Enter") void check();');
  });
});
