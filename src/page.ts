// The share page, GET /t/<slug>: a small HTML document with the published snapshot
// embedded as JSON, the player's stylesheet and its script (both same-origin files, so
// the page needs no inline script or style at all).
//
// Only the snapshot is ever read here, never the draft. An unknown slug, a draft tour, an
// unpublished tour, a tour of a workspace with a disabled account and a broken snapshot
// row all run the same single query and answer the same 404 page, so the answer says
// nothing about which it was. The page is cached for a minute (PAGE_CACHE), so a page
// fetched just before its account was disabled can still be shown from a cache that long.
//
// Untrusted text reaches this page in two places, and neither can become markup: the
// title is HTML-escaped into <title> and the no-script heading, and the snapshot is JSON
// with every <, >, & and U+2028/U+2029 written as a \u escape, so no stored string can
// close the data block, open a comment or end the script.
//
// The page embeds a copy of the snapshot rebuilt field by field at every depth
// (`pageTour`), not the row itself: it holds no internal identifier except step ids, an
// unknown key anywhere is dropped, and a field added to the snapshot later reaches the
// public page only when it is added here on purpose. A part of the wrong type makes the
// whole snapshot malformed, which answers the same 404 as an unknown slug.
import type { Hono } from "hono";
import { beforeAccountsToo, noDisabledAccount } from "./accounts.ts";
import type { Autoplay, Box, Card, EndCard, Link, Note, Point, Theme, Zoom } from "./manifest.ts";
import { PLAYER_CSS, PLAYER_CSS_ETAG, PLAYER_CSS_PATH, PLAYER_JS, PLAYER_JS_ETAG, PLAYER_JS_PATH } from "./player/assets.ts";
import type { Deps } from "./ports.ts";

export type PageStep = {
  id: string;
  image: string;
  width: number;
  height: number;
  click: { x: number; y: number; size: number } | null;
  caption: string | null;
  spotlight: Box | null;
  notes: Note[];
  card: Card | null;
  advance: "hotspot" | "anywhere";
  zoom: boolean | null;
};
export type PageChapter = { title: string; description: string | null; steps: PageStep[] };
export type PageCover = { title: string; body: string; button: string; logo: string | null };
/** What the player receives: the snapshot's settings and chapters, with no chapter, tour or workspace id. */
export type PageTour = {
  title: string;
  spotlight_dim: number | null;
  theme: Theme;
  zoom: Zoom;
  cover: PageCover | null;
  cta: Link | null;
  end: EndCard | null;
  autoplay: Autoplay;
  chapters: PageChapter[];
};
/** The page's data block, `#tour`. `base` is the configured public image base at serve time. */
export type PageData = { base: string; tour: PageTour };

/** A snapshot part of the wrong type. Carries no content, so it is safe to log. */
export class MalformedSnapshot extends Error {
  constructor() {
    super("malformed snapshot");
  }
}
const bad = (): never => {
  throw new MalformedSnapshot();
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const objOf = (v: unknown): Obj => (isObj(v) ? v : bad());
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : bad());
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : bad());
const flag = (v: unknown): boolean => (typeof v === "boolean" ? v : bad());
const orNull = <T>(v: unknown, f: (x: unknown) => T): T | null => (v === null ? null : f(v));
const listOf = <T>(v: unknown, f: (x: unknown) => T): T[] => (Array.isArray(v) ? v.map((x) => f(x)) : bad());
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : bad();
}

const point = (v: unknown): Point => {
  const o = objOf(v);
  return { x: num(own(o, "x")), y: num(own(o, "y")) };
};
const box = (v: unknown): Box => {
  const o = objOf(v);
  return { x: num(own(o, "x")), y: num(own(o, "y")), w: num(own(o, "w")), h: num(own(o, "h")) };
};
const link = (v: unknown): Link => {
  const o = objOf(v);
  return { label: str(own(o, "label")), url: str(own(o, "url")) };
};
function note(v: unknown): Note {
  const o = objOf(v);
  const base = { x: num(own(o, "x")), y: num(own(o, "y")), text: str(own(o, "text")), size: num(own(o, "size")), color: str(own(o, "color")) };
  const kind = oneOf(own(o, "kind"), ["text", "bubble"] as const);
  if (kind === "text") return { kind, ...base };
  return { kind, x: base.x, y: base.y, w: num(own(o, "w")), h: num(own(o, "h")), tail: point(own(o, "tail")), text: base.text, size: base.size, color: base.color, fill: str(own(o, "fill")) };
}
function card(v: unknown): Card {
  const o = objOf(v);
  return {
    title: str(own(o, "title")),
    body: str(own(o, "body")),
    next_label: str(own(o, "next_label")),
    anchor: oneOf(own(o, "anchor"), ["hotspot", "point", "none"] as const),
    point: orNull(own(o, "point"), point),
    placement: oneOf(own(o, "placement"), ["auto", "top", "bottom", "left", "right"] as const),
  };
}
function step(v: unknown): PageStep {
  const o = objOf(v);
  return {
    id: str(own(o, "id")),
    image: str(own(o, "image")),
    width: num(own(o, "width")),
    height: num(own(o, "height")),
    click: orNull(own(o, "click"), (c) => {
      const p = objOf(c);
      return { x: num(own(p, "x")), y: num(own(p, "y")), size: num(own(p, "size")) };
    }),
    caption: orNull(own(o, "caption"), str),
    spotlight: orNull(own(o, "spotlight"), box),
    notes: listOf(own(o, "notes"), note),
    card: orNull(own(o, "card"), card),
    advance: oneOf(own(o, "advance"), ["hotspot", "anywhere"] as const),
    zoom: orNull(own(o, "zoom"), flag),
  };
}
function chapter(v: unknown): PageChapter {
  const o = objOf(v);
  return { title: str(own(o, "title")), description: orNull(own(o, "description"), str), steps: listOf(own(o, "steps"), step) };
}
function theme(v: unknown): Theme {
  const o = objOf(v);
  return {
    card_style: oneOf(own(o, "card_style"), ["dark", "light", "compact", "auto"] as const),
    accent: str(own(o, "accent")),
    hotspot: oneOf(own(o, "hotspot"), ["pulse", "dot", "none"] as const),
    progress_bar: flag(own(o, "progress_bar")),
    backdrop: str(own(o, "backdrop")),
    spotlight_soft: flag(own(o, "spotlight_soft")),
  };
}

/**
 * The public copy of a snapshot, rebuilt field by field with the expected types: chapters
 * in order, chapter ids left out, step ids kept for later analytics. Throws
 * MalformedSnapshot when any part is missing or of the wrong type.
 */
export function pageTour(snapshot: unknown): PageTour {
  const s = objOf(snapshot);
  const z = objOf(own(s, "zoom"));
  const a = objOf(own(s, "autoplay"));
  return {
    title: str(own(s, "title")),
    spotlight_dim: orNull(own(s, "spotlight_dim"), num),
    theme: theme(own(s, "theme")),
    zoom: { enabled: flag(own(z, "enabled")), percent: num(own(z, "percent")) },
    cover: orNull(own(s, "cover"), (c) => {
      const o = objOf(c);
      return { title: str(own(o, "title")), body: str(own(o, "body")), button: str(own(o, "button")), logo: orNull(own(o, "logo"), str) };
    }),
    cta: orNull(own(s, "cta"), link),
    end: orNull(own(s, "end"), (e) => {
      const o = objOf(e);
      return { text: str(own(o, "text")), primary: orNull(own(o, "primary"), link), secondary: orNull(own(o, "secondary"), link), replay: flag(own(o, "replay")) };
    }),
    autoplay: { enabled: flag(own(a, "enabled")), seconds: num(own(a, "seconds")) },
    chapters: listOf(own(s, "chapters"), chapter),
  };
}

/** A slug as newSlug makes it. Anything else is looked up as "" so it costs the same query and finds nothing. */
const SLUG = /^[a-z2-7]{10}$/;

/**
 * The one lookup of the page. A tour of a workspace with a disabled account is not found,
 * in this same statement, so it costs no call more and answers exactly as an unknown slug.
 */
const PAGE_SQL_BEFORE_ACCOUNTS = "SELECT s.data FROM snapshot s JOIN tour t ON t.id = s.tour_id WHERE t.slug = ? AND t.status = 'published'";
const PAGE_SQL = `${PAGE_SQL_BEFORE_ACCOUNTS} AND ${noDisabledAccount("t.workspace_id")}`;

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
export function pageHtml(tour: PageTour, base: string): string {
  const title = escapeHtml(tour.title);
  return `<!doctype html>
<html lang="en">
<head>
${HEAD}
<title>${title}</title>
<link rel="stylesheet" href="${PLAYER_CSS_PATH}">
<script src="${PLAYER_JS_PATH}" defer></script>
</head>
<body>
<main id="player">
<div class="fallback">
<h1>${title}</h1>
<noscript><p>This tour needs JavaScript to play. Turn it on in your browser to click through it.</p></noscript>
</div>
</main>
<script type="application/json" id="tour">${scriptJson({ base: normaliseBase(base), tour } satisfies PageData)}</script>
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
<link rel="stylesheet" href="${PLAYER_CSS_PATH}">
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
export async function renderPage(tour: PageTour, base: string, ifNoneMatch: string | null = null): Promise<Response> {
  const html = pageHtml(tour, base);
  const etag = await etagOf(html);
  const headers = { ...baseHeaders(base), "cache-control": PAGE_CACHE, etag };
  if (matchesEtag(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(html, { status: 200, headers });
}

export function notFoundPage(base: string): Response {
  return new Response(NOT_FOUND_HTML, { status: 404, headers: { ...baseHeaders(base), "cache-control": "no-store" } });
}

/** A hashed address names one build of the file, so it never changes. */
export const PLAYER_FILE_IMMUTABLE = "public, max-age=31536000, immutable";
/** The plain address, or another build's hash, gets the current file briefly. */
export const PLAYER_FILE_CACHE = "public, max-age=300";

/** `/player.js`, `/player.css`, or either with a 16-hex-digit hash before the extension. */
const PLAYER_FILE = /^\/player(\.[0-9a-f]{16})?\.(js|css)$/;

function playerFile(path: string, ifNoneMatch: string | undefined): Response | null {
  const m = PLAYER_FILE.exec(path);
  if (m === null) return null;
  const js = m[2] === "js";
  const [body, type, etag, current] = js
    ? [PLAYER_JS, "text/javascript; charset=utf-8", PLAYER_JS_ETAG, PLAYER_JS_PATH]
    : [PLAYER_CSS, "text/css; charset=utf-8", PLAYER_CSS_ETAG, PLAYER_CSS_PATH];
  // Only the current build's own address may be cached for good; an old page asking for
  // another build's file gets today's with the short cache, so no cache keeps a mismatch.
  const cache = path === current ? PLAYER_FILE_IMMUTABLE : PLAYER_FILE_CACHE;
  const headers = { "content-type": type, "cache-control": cache, etag, "x-content-type-options": "nosniff" };
  if (matchesEtag(ifNoneMatch ?? null, etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}

function parseTour(data: string): PageTour {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new MalformedSnapshot();
  }
  return pageTour(parsed);
}

export function pageRoutes(app: Hono, deps: Deps): void {
  // The player's script and stylesheet: generated into src/player/assets.ts, so both
  // targets serve the same bytes with the same headers and no static-file setup.
  app.get("/:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}", (c) => playerFile(c.req.path, c.req.header("if-none-match")) ?? c.notFound());

  app.get("/t/:slug", async (c) => {
    const base = deps.config.publicImageBase;
    const raw = c.req.param("slug");
    const slug = SLUG.test(raw) ? raw : "";
    const row = await beforeAccountsToo(
      () => deps.db.first<{ data: string }>(PAGE_SQL, [slug]),
      () => deps.db.first<{ data: string }>(PAGE_SQL_BEFORE_ACCOUNTS, [slug]),
    );
    if (row === null) return notFoundPage(base);
    let tour: PageTour;
    try {
      tour = parseTour(row.data);
    } catch (err) {
      if (!(err instanceof MalformedSnapshot)) throw err;
      // Fixed text only: neither the slug nor anything from the row.
      console.error("page: a published snapshot is malformed; answering 404");
      return notFoundPage(base);
    }
    return renderPage(tour, base, c.req.header("if-none-match") ?? null);
  });
}
