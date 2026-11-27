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
// The page is server-rendered and reads without JavaScript: the header, "Get connected",
// the links to the guides, the mount the viewer fills, the three guides (src/docs/guides.ts)
// and the footer, whose second line is the software's version and the link to its source
// (src/source.ts, from the SOURCE_URL setting). Its script (src/docs/client/main.ts) adds the token box, the copy
// buttons and the viewer.
import type { Hono } from "hono";
import { FAVICON_LINKS } from "../brand.ts";
import { SOURCE_URL_DEFAULT } from "../https-address.ts";
import { matchesEtag, PLAYER_FILE_IMMUTABLE } from "../page.ts";
import type { Deps } from "../ports.ts";
import { sourceLineHtml } from "../source.ts";
import { VERSION } from "../version.ts";
import { CODE_MEANINGS, errorCodes, GUIDES, HISTORY_NOTE, limitLines, type Guide, type GuideStep } from "./guides.ts";
import { GET_STARTED, openapi } from "./openapi.ts";
import { DOCS_CSS, DOCS_CSS_ETAG, DOCS_CSS_PATH, DOCS_JS, DOCS_JS_ETAG, DOCS_JS_PATH, OPENAPI_JSON, OPENAPI_JSON_ETAG, OPENAPI_YAML, OPENAPI_YAML_ETAG } from "./site-assets.ts";
import { VIEWER_CSS, VIEWER_CSS_ETAG, VIEWER_CSS_PATH, VIEWER_JS, VIEWER_JS_ETAG, VIEWER_JS_PATH, VIEWER_LICENCES } from "./viewer-assets.ts";

/**
 * The page's policy. Scripts, style sheets and requests come from this origin only:
 * nothing inline, nothing evaluated as code, no other host. `data:` is for the icons
 * inside the viewer's stylesheet, `blob:` shows a picture a request on the page fetched.
 * Not even inline style attributes are allowed. The viewer's script has nothing that
 * writes one as text, and it was first shipped with `style-src-attr 'unsafe-inline'` only
 * as a precaution; that is now taken out on trial. The integrator checks the page in a
 * browser: if the viewer breaks or the console reports a violation, that one directive is
 * put back here and in the test that pins this text. Unlike a tour page, this page may
 * not be framed.
 */
export const DOCS_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Five minutes, then a cheap 304 by ETag: a new version of the app shows up soon after an update. */
export const DOCS_PAGE_CACHE = "public, max-age=300";
/** Another build's hash gets the current file briefly, as the player's files do. */
const DOCS_FILE_CACHE = "public, max-age=300";
/** The notices change only with the viewer. */
const LICENCES_CACHE = "public, max-age=86400";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text as HTML text or an attribute's value. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** A command in its box, with a copy button the page script shows where the browser can copy. */
function command(curl: string, attrs = ""): string {
  return `<div class="command"><pre><code${attrs}>${esc(curl)}</code></pre><button type="button" hidden>Copy</button></div>`;
}

function stepHtml(step: GuideStep): string {
  const parts = [`<p>${esc(step.text)}</p>`];
  if (step.note !== undefined) parts.push(`<p class="note">${esc(step.note)}</p>`);
  if (step.example !== undefined) {
    const { curl, expect, repeatUntil } = step.example;
    parts.push(command(curl, ' class="example"'));
    parts.push(`<p class="answers">${repeatUntil === undefined ? `Answers ${expect}.` : `Answers ${repeatUntil} when it is done, 202 until then.`}</p>`);
  }
  return `<li>${parts.join("")}</li>`;
}

/** Every error code of the description with its status and its meaning, and the description's own list of limits. */
function tables(): string {
  const doc = openapi();
  const rows = errorCodes(doc).map(({ code, statuses }) => `<tr><td>${statuses.join(", ")}</td><td><code>${esc(code)}</code></td><td>${esc(CODE_MEANINGS[code] ?? "")}</td></tr>`);
  const limits = limitLines(doc).map((line) => `<li>${esc(line)}</li>`);
  return `<h3>Error codes</h3>
<div class="table-wrap"><table>
<thead><tr><th scope="col">Status</th><th scope="col">Code</th><th scope="col">Meaning</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table></div>
<h3>Limits</h3>
<ul class="limits">
${limits.join("\n")}
</ul>`;
}

function guideHtml(guide: Guide): string {
  const legend = guide.placeholders.map(([word, meaning]) => `<code>${esc(word)}</code> is ${esc(meaning)}`).join("; ");
  return `<section class="own block guide" id="guide-${guide.id}">
<h2>${esc(guide.title)}</h2>
<p>${esc(guide.intro)}</p>
<p class="legend">In the examples, ${legend}. ${esc(HISTORY_NOTE)}</p>
<ol class="steps">
${guide.steps.map(stepHtml).join("\n")}
</ol>
${guide.id === "errors-and-limits" ? tables() + "\n" : ""}${(guide.closing ?? []).map((line) => `<p>${esc(line)}</p>`).join("\n")}
</section>`;
}

/** The page for each source address asked for, built once: it is fixed text. */
const pages = new Map<string, string>();

/**
 * The page, with the source line for `sourceUrl` (the SOURCE_URL setting; the default when
 * left out). Byte-for-byte the same on both targets and for every host: it names no address
 * but its own files', the source line's and, in the examples, the placeholder GUIDE_ORIGIN,
 * which the page script replaces with the address the page was opened on.
 *
 * It reads without JavaScript: the header, "Get connected", the guides and the footer
 * are plain HTML. The token box and the copy buttons are hidden until the page script
 * shows them, since they do nothing without it; the viewer fills #reference.
 */
export function docsHtml(sourceUrl: string = SOURCE_URL_DEFAULT): string {
  const held = pages.get(sourceUrl);
  if (held !== undefined) return held;
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Mythicshot API documentation</title>
${FAVICON_LINKS}
<link rel="stylesheet" href="${VIEWER_CSS_PATH}">
<link rel="stylesheet" href="${DOCS_CSS_PATH}">
</head>
<body>
<header class="own page-header">
<h1>Mythicshot API</h1>
<p>Version ${esc(VERSION)}</p>
<p>Download the description: <a href="/api/v1/openapi.json">JSON</a> <a href="/api/v1/openapi.yaml">YAML</a></p>
</header>
<main>
<section class="own block" id="get-connected">
<h2>Get connected</h2>
<ol class="steps">
<li>Create a token in your workspace. Today the setup wizard shows it once, at the end of setup; keep it in a password manager.</li>
<li>Send it with every request, as the header <code>Authorization: Bearer YOUR_TOKEN</code>. ${esc(HISTORY_NOTE)}</li>
<li>Try the first call. It answers with your workspace's name and the server's version.</li>
</ol>
<div class="token-box" id="token-box" hidden>
<label for="token">Paste a token to try the calls on this page</label>
<div class="token-row"><input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" id="use-token">Use token</button><button type="button" id="forget-token" class="quiet" hidden>Forget token</button></div>
<p class="note">Kept in this tab only, never stored.</p>
<p class="status" id="token-status" role="status" aria-live="polite"></p>
</div>
${command(GET_STARTED, ' id="first-command"')}
<h3 id="guides">Guides</h3>
<ul class="guide-links">
${GUIDES.map((g) => `<li><a href="#guide-${g.id}">${esc(g.title)}</a></li>`).join("\n")}
</ul>
</section>
<section aria-labelledby="reference-title">
<div class="own block"><h2 id="reference-title">Reference</h2></div>
<div id="reference"><noscript><p>The reference needs JavaScript. Everything it shows is also in the description, as JSON and YAML above.</p></noscript></div>
</section>
${GUIDES.map(guideHtml).join("\n")}
</main>
<footer class="own page-footer">
<p>The reference is shown with Swagger UI, used under the Apache License 2.0. <a href="/docs/licences.txt">Licence notices</a></p>
<p>${sourceLineHtml(sourceUrl)}</p>
</footer>
<script src="${VIEWER_JS_PATH}"></script>
<script src="${DOCS_JS_PATH}"></script>
</body>
</html>
`;
  pages.set(sourceUrl, page);
  return page;
}

/** The page's ETag: the first 32 hex digits of its SHA-256, worked out once per source address and kept. */
const pageEtags = new Map<string, Promise<string>>();
function docsEtag(sourceUrl: string): Promise<string> {
  const held = pageEtags.get(sourceUrl);
  if (held !== undefined) return held;
  const etag = crypto.subtle.digest("SHA-256", new TextEncoder().encode(docsHtml(sourceUrl))).then((buffer) => {
    let hex = "";
    for (const b of new Uint8Array(buffer).subarray(0, 16)) hex += b.toString(16).padStart(2, "0");
    return `"${hex}"`;
  });
  pageEtags.set(sourceUrl, etag);
  return etag;
}

async function docsPage(ifNoneMatch: string | null, sourceUrl: string): Promise<Response> {
  const etag = await docsEtag(sourceUrl);
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
  return new Response(docsHtml(sourceUrl), { status: 200, headers });
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

/** The routes. Of `deps` only the SOURCE_URL setting is read, for the page's source line: nothing here reaches data. */
export function docsRoutes(app: Hono, deps: Deps): void {
  const sourceUrl = deps.config.sourceUrl ?? SOURCE_URL_DEFAULT;
  app.get("/docs", (c) => docsPage(c.req.header("if-none-match") ?? null, sourceUrl));
  app.get("/docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}", (c) => docsFile(c.req.path, c.req.header("if-none-match")) ?? c.notFound());
  app.get("/docs/licences.txt", () => new Response(VIEWER_LICENCES, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": LICENCES_CACHE, "x-content-type-options": "nosniff" } }));
  app.get("/api/v1/openapi.json", (c) => description(OPENAPI_JSON, "application/json; charset=utf-8", OPENAPI_JSON_ETAG, c.req.header("if-none-match") ?? null));
  app.get("/api/v1/openapi.yaml", (c) => description(OPENAPI_YAML, "application/yaml; charset=utf-8", OPENAPI_YAML_ETAG, c.req.header("if-none-match") ?? null));
}
