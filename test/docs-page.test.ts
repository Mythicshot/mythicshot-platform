// The documentation page, its four files, the licence notices and where each answers:
// headers, caching, the policy, the host rules, and that none of it costs a database or
// storage call, needs a token or sets a cookie.
import { describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { DOCS_CSP, DOCS_PAGE_CACHE, docsFile, docsHtml } from "../src/docs/page.ts";
import { DOCS_CSS, DOCS_CSS_ETAG, DOCS_CSS_PATH, DOCS_JS, DOCS_JS_ETAG, DOCS_JS_PATH } from "../src/docs/site-assets.ts";
import { VIEWER_CSS, VIEWER_CSS_ETAG, VIEWER_CSS_PATH, VIEWER_JS, VIEWER_JS_ETAG, VIEWER_JS_PATH, VIEWER_LICENCES } from "../src/docs/viewer-assets.ts";
import type { Hosts } from "../src/hosts.ts";
import { contentSecurityPolicy } from "../src/page.ts";
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
    const linked = [...r.text.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    expect(linked.sort()).toEqual([...FILES.map((f) => f.path), "/docs/licences.txt", "/api/v1/openapi.json", "/api/v1/openapi.yaml"].sort());
    expect(r.text).not.toMatch(/:\/\/|example\.|localhost/);
    expect(r.text).not.toMatch(/<style|style=|\son[a-z]+=|<script(?![^>]*\ssrc=)/i);
    expect(r.text).toContain("<title>Mythicshot API documentation</title>");
    expect(r.text).toContain("The reference needs JavaScript. Everything it shows is also in the description, as JSON and YAML above.");
  });

  it("the page sends the docs policy, forbids framing and relaxes nothing", async () => {
    // The policy, exactly. A change here is a decision, not a refactoring.
    expect(DOCS_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const d = directives(DOCS_CSP);
    expect(Object.keys(d)).toEqual(["default-src", "script-src", "style-src", "style-src-attr", "img-src", "connect-src", "base-uri", "form-action", "frame-ancestors"]);
    // Scripts and style sheets come from this origin only: nothing inline, nothing evaluated.
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["style-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["default-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(DOCS_CSP).not.toContain("unsafe-eval");
    expect(DOCS_CSP).not.toContain("wasm");
    // 'unsafe-inline' is allowed for style attributes alone, never for a script or a style sheet.
    for (const [name, sources] of Object.entries(d)) expect(sources.includes("'unsafe-inline'"), name).toBe(name === "style-src-attr");
    for (const name of ["script-src-elem", "script-src-attr", "style-src-elem"]) expect(d[name], name).toBeUndefined();
    // No wildcard, no scheme but data: and blob: for pictures, no host name.
    expect(DOCS_CSP).not.toMatch(/\*|https?:|wss?:|\/\/|\.[a-z]/);
    for (const [name, sources] of Object.entries(d)) {
      for (const s of sources) expect(["'self'", "'none'", "'unsafe-inline'", ...(name === "img-src" ? ["data:", "blob:"] : [])], `${name} ${s}`).toContain(s);
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
    expect(contentSecurityPolicy("")).toBe("default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'");
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
