// The share page, GET /t/<slug>: a small HTML document with the published snapshot
// embedded as JSON, the player's stylesheet and its script (both same-origin files, so
// the page needs no inline script or style at all).
//
// Only the snapshot is ever read here, never the draft. An unknown slug, a draft tour, an
// unpublished tour and a broken snapshot row all run the same single query and answer
// the same 404 page, so the answer says nothing about which it was.
//
// Untrusted text reaches this page in two places, and neither can become markup: the
// title is HTML-escaped into <title> and the no-script heading, and the snapshot is JSON
// with every <, >, & and U+2028/U+2029 written as a \u escape, so no stored string can
// close the data block, open a comment or end the script.
//
// The page embeds a copy of the snapshot built field by field (`pageTour`), not the row
// itself, so it holds no internal identifier except step ids, and a field added to the
// snapshot later reaches the public page only when it is added here on purpose.
import type { Hono } from "hono";
import { PLAYER_CSS, PLAYER_CSS_ETAG, PLAYER_JS, PLAYER_JS_ETAG } from "./player/assets.ts";
import type { Deps } from "./ports.ts";
import type { Snapshot, SnapshotStep } from "./publish.ts";

export type PageStep = SnapshotStep;
export type PageChapter = { title: string; description: string | null; steps: PageStep[] };
/** What the player receives: the snapshot's settings and chapters, with no chapter, tour or workspace id. */
export type PageTour = Pick<Snapshot, "title" | "spotlight_dim" | "theme" | "zoom" | "cover" | "cta" | "end" | "autoplay"> & { chapters: PageChapter[] };
/** The page's data block, `#tour`. `base` is the configured public image base at serve time. */
export type PageData = { base: string; tour: PageTour };

const list = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

/** The public copy of a snapshot: an allow-list of fields, chapters in order, step ids kept for later analytics. */
export function pageTour(s: Snapshot): PageTour {
  return {
    title: s.title,
    spotlight_dim: s.spotlight_dim,
    theme: s.theme,
    zoom: s.zoom,
    cover: s.cover === null || s.cover === undefined ? null : { title: s.cover.title, body: s.cover.body, button: s.cover.button, logo: s.cover.logo },
    cta: s.cta,
    end: s.end,
    autoplay: s.autoplay,
    chapters: list(s.chapters).map((c) => ({
      title: c.title,
      description: c.description,
      steps: list(c.steps).map((st) => ({
        id: st.id,
        image: st.image,
        width: st.width,
        height: st.height,
        click: st.click,
        caption: st.caption,
        spotlight: st.spotlight,
        notes: st.notes,
        card: st.card,
        advance: st.advance,
        zoom: st.zoom,
      })),
    })),
  };
}

/** A slug as newSlug makes it. Anything else is looked up as "" so it costs the same query and finds nothing. */
const SLUG = /^[a-z2-7]{10}$/;

const PAGE_SQL = "SELECT s.data FROM snapshot s JOIN tour t ON t.id = s.tour_id WHERE t.slug = ? AND t.status = 'published'";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text for an HTML text node or a quoted attribute value. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** JSON that is safe inside a <script> element: no <, >, & or line separators survive as themselves. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** The image base with any trailing slash removed; the player builds `base + "/" + key`. */
export function normaliseBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * The CSP source images may come from: 'self' when the app serves them on /p/<name>, the
 * origin of an https image base, and 'none' for any other value, so a mistyped setting
 * blocks images instead of opening the page to an unintended host.
 */
export function imageSource(base: string): string {
  if (base === "") return "'self'";
  try {
    const u = new URL(base);
    if (u.protocol === "https:" && u.username === "" && u.password === "" && u.origin !== "null") return u.origin;
  } catch {
    // Not a URL: fall through.
  }
  return "'none'";
}

export function contentSecurityPolicy(base: string): string {
  return `default-src 'none'; img-src ${imageSource(base)}; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'`;
}

/**
 * Headers both the page and the 404 carry. Framing is allowed on purpose, since tours are
 * meant to be embedded, so there is no X-Frame-Options and no frame-ancestors.
 */
function baseHeaders(base: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": contentSecurityPolicy(base),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">`;

/** The page for a published snapshot. Byte-for-byte the same on both targets. */
export function pageHtml(snapshot: Snapshot, base: string): string {
  const title = escapeHtml(snapshot.title);
  return `<!doctype html>
<html lang="en">
<head>
${HEAD}
<title>${title}</title>
<link rel="stylesheet" href="/player.css">
<script src="/player.js" defer></script>
</head>
<body>
<main id="player">
<div class="fallback">
<h1>${title}</h1>
<noscript><p>This tour needs JavaScript to play. Turn it on in your browser to click through it.</p></noscript>
</div>
</main>
<script type="application/json" id="tour">${scriptJson({ base: normaliseBase(base), tour: pageTour(snapshot) } satisfies PageData)}</script>
</body>
</html>
`;
}

/** One body for every slug that has no published tour. */
export const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
${HEAD}
<title>Tour not available</title>
<link rel="stylesheet" href="/player.css">
</head>
<body>
<main id="player">
<div class="fallback">
<h1>This tour isn&#39;t available</h1>
<p>The link may be mistyped, or the tour may have been taken down.</p>
</div>
</main>
</body>
</html>
`;

async function etagOf(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let hex = "";
  for (const b of digest.subarray(0, 16)) hex += b.toString(16).padStart(2, "0");
  return `"${hex}"`;
}

/** True when an If-None-Match header names `etag` (weak or strong) or is "*". */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((part) => {
    const t = part.trim();
    return t === "*" || t === etag || t === "W/" + etag;
  });
}

/**
 * A minute of caching, then a cheap 304 by ETag: a re-publish shows up within a minute,
 * and publish keeps the previous snapshot's images for a grace period longer than that,
 * so a cached page never points at deleted images.
 */
export const PAGE_CACHE = "public, max-age=60";

/** The page's response, with its ETag; a matching If-None-Match answers 304. */
export async function renderPage(snapshot: Snapshot, base: string, ifNoneMatch: string | null = null): Promise<Response> {
  const html = pageHtml(snapshot, base);
  const etag = await etagOf(html);
  const headers = { ...baseHeaders(base), "cache-control": PAGE_CACHE, etag };
  if (matchesEtag(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(html, { status: 200, headers });
}

export function notFoundPage(base: string): Response {
  return new Response(NOT_FOUND_HTML, { status: 404, headers: { ...baseHeaders(base), "cache-control": "no-store" } });
}

/** The player's files change only with a deploy; a few minutes of caching, then a 304 by ETag. */
export const PLAYER_FILE_CACHE = "public, max-age=300";

function playerFile(body: string, type: string, etag: string, ifNoneMatch: string | undefined): Response {
  const headers = { "content-type": type, "cache-control": PLAYER_FILE_CACHE, etag, "x-content-type-options": "nosniff" };
  if (matchesEtag(ifNoneMatch ?? null, etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}

export function pageRoutes(app: Hono, deps: Deps): void {
  // The player's script and stylesheet: generated into src/player/assets.ts, so both
  // targets serve the same bytes with the same headers and no static-file setup.
  app.get("/player.js", (c) => playerFile(PLAYER_JS, "text/javascript; charset=utf-8", PLAYER_JS_ETAG, c.req.header("if-none-match")));
  app.get("/player.css", (c) => playerFile(PLAYER_CSS, "text/css; charset=utf-8", PLAYER_CSS_ETAG, c.req.header("if-none-match")));

  app.get("/t/:slug", async (c) => {
    const base = deps.config.publicImageBase;
    const raw = c.req.param("slug");
    const row = await deps.db.first<{ data: string }>(PAGE_SQL, [SLUG.test(raw) ? raw : ""]);
    let snapshot: Snapshot | null = null;
    if (row !== null) {
      try {
        const parsed: unknown = JSON.parse(row.data);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) snapshot = parsed as Snapshot;
      } catch {
        snapshot = null;
      }
    }
    if (snapshot === null || typeof snapshot.title !== "string") return notFoundPage(base);
    return renderPage(snapshot, base, c.req.header("if-none-match") ?? null);
  });
}
