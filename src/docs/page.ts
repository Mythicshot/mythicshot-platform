// The API documentation page (GET /docs), its four files, the viewer's licence notices
// and the description as JSON and YAML.
//
// Everything here is fixed text built into the app, the same bytes on both targets and
// for every host: the viewer's files from src/docs/viewer-assets.ts, our page script and
// stylesheet and the description from src/docs/site-assets.ts. No route makes a database
// or storage call, reads a token or any header but If-None-Match, sets a cookie or sends
// a cross-origin header. In two-address mode the host gate keeps the page and its files
// to the app address (src/host-gate.ts); nothing here looks at the host.
//
// The page body is a plain shell for now: the header, the mount the viewer fills, and
// the footer. The token box and the guides come with the page itself.
import type { Hono } from "hono";
import { matchesEtag, PLAYER_FILE_IMMUTABLE } from "../page.ts";
import type { Deps } from "../ports.ts";
import { VERSION } from "../version.ts";
import { DOCS_CSS, DOCS_CSS_ETAG, DOCS_CSS_PATH, DOCS_JS, DOCS_JS_ETAG, DOCS_JS_PATH, OPENAPI_JSON, OPENAPI_JSON_ETAG, OPENAPI_YAML, OPENAPI_YAML_ETAG } from "./site-assets.ts";
import { VIEWER_CSS, VIEWER_CSS_ETAG, VIEWER_CSS_PATH, VIEWER_JS, VIEWER_JS_ETAG, VIEWER_JS_PATH, VIEWER_LICENCES } from "./viewer-assets.ts";

/**
 * The page's policy. Scripts, style sheets and requests come from this origin only:
 * nothing inline, nothing evaluated as code, no other host. `data:` is for the icons
 * inside the viewer's stylesheet, `blob:` shows a picture a request on the page fetched.
 * Inline style attributes alone are allowed, for the viewer; it is not known yet whether
 * it needs them. Unlike a tour page, this page may not be framed.
 */
export const DOCS_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Five minutes, then a cheap 304 by ETag: a new version of the app shows up soon after an update. */
export const DOCS_PAGE_CACHE = "public, max-age=300";
/** Another build's hash gets the current file briefly, as the player's files do. */
const DOCS_FILE_CACHE = "public, max-age=300";
/** The notices change only with the viewer. */
const LICENCES_CACHE = "public, max-age=86400";

/** The page. Byte-for-byte the same on both targets and for every host: it names no address but its own files'. */
export function docsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Mythicshot API documentation</title>
<link rel="stylesheet" href="${VIEWER_CSS_PATH}">
<link rel="stylesheet" href="${DOCS_CSS_PATH}">
</head>
<body>
<header>
<h1>Mythicshot API</h1>
<p>Version ${VERSION}</p>
<p>Download the description: <a href="/api/v1/openapi.json">JSON</a> <a href="/api/v1/openapi.yaml">YAML</a></p>
</header>
<main>
<h2>Reference</h2>
<div id="reference"><noscript><p>The reference needs JavaScript. Everything it shows is also in the description, as JSON and YAML above.</p></noscript></div>
</main>
<footer>
<p>The reference is shown with Swagger UI, used under the Apache License 2.0. <a href="/docs/licences.txt">Licence notices</a></p>
</footer>
<script src="${VIEWER_JS_PATH}"></script>
<script src="${DOCS_JS_PATH}"></script>
</body>
</html>
`;
}

/** The page's ETag: the first 32 hex digits of its SHA-256, worked out once and kept. */
let pageEtag: Promise<string> | null = null;
function docsEtag(): Promise<string> {
  pageEtag ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(docsHtml())).then((buffer) => {
    let hex = "";
    for (const b of new Uint8Array(buffer).subarray(0, 16)) hex += b.toString(16).padStart(2, "0");
    return `"${hex}"`;
  });
  return pageEtag;
}

async function docsPage(ifNoneMatch: string | null): Promise<Response> {
  const etag = await docsEtag();
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": DOCS_CSP,
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": DOCS_PAGE_CACHE,
    etag,
  };
  if (matchesEtag(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(docsHtml(), { status: 200, headers });
}

type Asset = { text: string; type: string; etag: string; path: string };
const SCRIPT = "text/javascript; charset=utf-8";
const STYLE = "text/css; charset=utf-8";
const ASSETS: Record<string, Asset> = {
  "viewer.js": { text: VIEWER_JS, type: SCRIPT, etag: VIEWER_JS_ETAG, path: VIEWER_JS_PATH },
  "viewer.css": { text: VIEWER_CSS, type: STYLE, etag: VIEWER_CSS_ETAG, path: VIEWER_CSS_PATH },
  "docs.js": { text: DOCS_JS, type: SCRIPT, etag: DOCS_JS_ETAG, path: DOCS_JS_PATH },
  "docs.css": { text: DOCS_CSS, type: STYLE, etag: DOCS_CSS_ETAG, path: DOCS_CSS_PATH },
};

/**
 * Each file as bytes, encoded on its first request and kept for the life of the process
 * (or the Worker's isolate): the viewer's script is 1.7 MB, and encoding it for every
 * request would be the whole cost of answering it.
 */
const encoded = new Map<string, Uint8Array<ArrayBuffer>>();
function bytesOf(name: string, text: string): Uint8Array<ArrayBuffer> {
  const held = encoded.get(name);
  if (held !== undefined) return held;
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  encoded.set(name, bytes);
  return bytes;
}

/** `/docs/viewer.<16 hex>.js`, `.css`, and the same for `docs`. */
const DOCS_FILE = /^\/docs\/(viewer|docs)\.[0-9a-f]{16}\.(js|css)$/;

/** One of the page's four files, or null when `path` is not one of their addresses. */
export function docsFile(path: string, ifNoneMatch?: string | null): Response | null {
  const m = DOCS_FILE.exec(path);
  if (m === null) return null;
  const name = `${m[1]}.${m[2]}`;
  const asset = ASSETS[name];
  // Only the current build's own address may be cached for good; a page asking for
  // another build's file gets today's with the short cache, so no cache keeps a mismatch.
  const cache = path === asset.path ? PLAYER_FILE_IMMUTABLE : DOCS_FILE_CACHE;
  const headers = { "content-type": asset.type, "cache-control": cache, etag: asset.etag, "x-content-type-options": "nosniff" };
  if (matchesEtag(ifNoneMatch ?? null, asset.etag)) return new Response(null, { status: 304, headers });
  return new Response(bytesOf(name, asset.text), { status: 200, headers });
}

/** A description file: its type, a short cache and an ETag. */
function description(text: string, type: string, etag: string, ifNoneMatch: string | null): Response {
  const headers = { "content-type": type, "cache-control": DOCS_PAGE_CACHE, etag, "x-content-type-options": "nosniff" };
  if (matchesEtag(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { status: 200, headers });
}

/** The routes. `deps` is taken as every route group takes it, and not used: nothing here reaches data. */
export function docsRoutes(app: Hono, _deps: Deps): void {
  app.get("/docs", (c) => docsPage(c.req.header("if-none-match") ?? null));
  app.get("/docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}", (c) => docsFile(c.req.path, c.req.header("if-none-match")) ?? c.notFound());
  app.get("/docs/licences.txt", () => new Response(VIEWER_LICENCES, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": LICENCES_CACHE, "x-content-type-options": "nosniff" } }));
  app.get("/api/v1/openapi.json", (c) => description(OPENAPI_JSON, "application/json; charset=utf-8", OPENAPI_JSON_ETAG, c.req.header("if-none-match") ?? null));
  app.get("/api/v1/openapi.yaml", (c) => description(OPENAPI_YAML, "application/yaml; charset=utf-8", OPENAPI_YAML_ETAG, c.req.header("if-none-match") ?? null));
}
