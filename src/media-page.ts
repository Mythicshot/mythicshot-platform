// The public pages and files a shared link opens, with no credential at all:
// - GET /i/<link id> and GET /r/<link id>: the page of an image or a clip;
// - GET /i/<link id>.png|.jpg and GET /r/<link id>.gif|.mp4: the file itself, with Range;
// - GET /i/<link id>/download and GET /r/<link id>/download: the same file as an attachment;
// - GET /i/<link id>/preview and GET /r/<link id>/preview: the item's preview picture;
// - GET /s/share.css and GET /s/share.js: the pages' stylesheet and script.
// The host gate keeps every one of them to the media address (src/host-gate.ts, rule
// `media`): the img address when it is set, else the tours address.
//
// The page and the file share one route per letter, `/i/:name`: a name of exactly a link
// id is the page, a link id with the one extension of the item's stored type is the file,
// and anything else is the 404. One route keeps the routing table free of patterns that
// overlap, and every malformed name reaches the same code as a real one.
//
// An item is found by its link id (never by its database id) through the API's own
// lookup, onlineItemFiles in src/media.ts: only an item that is online and whose
// workspace has no disabled account (the rule src/auth.ts applies to a token; tour pages
// have no such check) is found, with the keys of its current objects. Every request makes
// that lookup, whatever the name looks like (a malformed name is looked up as ""), and it
// makes the same two database calls for every input. A deleted, unfinished or closing
// item, one of a disabled account, one of the other kind, a wrong extension, a malformed
// name and an unknown one all answer the same 404 page, byte for byte, with the same headers.
//
// No cookie is read or set and no Authorization header is read: nothing here calls
// requireAuth. No page names the sharer, the workspace or the account. Every value from
// the database reaches the HTML through `esc`, attribute values and the <title> included.
// A file is answered with the type stored in the item's row (the one sniffed from its
// bytes at upload), never one stored with the object, with nosniff and a sandbox policy,
// so stored bytes that look like HTML or SVG are never run as a document.
import type { Context, Hono } from "hono";
import { mediaOrigin } from "./hosts.ts";
import { MAX_SERVED_PARTS, SERVE_LOOKUP_CALLS } from "./limits.ts";
import { PART_BYTES, onlineItemFiles, type OnlineItemFiles } from "./media.ts";
import { SHARE_CSS, SHARE_CSS_PATH, SHARE_JS, SHARE_JS_PATH } from "./media-assets.ts";
import { capRange, parseRange, partsCovered, rangeStream, type FilePart } from "./media-serve.ts";
import { escapeHtml, matchesEtag } from "./page.ts";
import type { Config, Deps } from "./ports.ts";
import { formatBytes } from "./usage.ts";

type Kind = "image" | "clip";
type Ext = "png" | "jpg" | "gif" | "mp4";

/** Every visible sentence of the pages, so the tests can pin them. */
export const SHARE_TEXT = {
  brand: "Mythicshot",
  sharedImage: "Shared image",
  sharedClip: "Shared clip",
  untitledImage: "Untitled image",
  untitledGif: "Untitled GIF",
  untitledClip: "Untitled clip",
  loopMp4: "Plays in a loop, without sound. Click the clip to pause it.",
  loopGif: "Plays in a loop, without sound.",
  openFull: "Open full size",
  openFile: "Open file",
  download: "Download",
  footBefore: "Shared with ",
  footAfter: ", a screenshot and recording tool.",
  site: "https://mythicshot.com/",
  goneTitle: "This link no longer works",
  goneText: "The image or clip it pointed to was deleted, or the link is not complete. Ask whoever sent it to you for a new one.",
} as const;

/** The stored types, each with its one extension and the name the details line gives it. */
const FILE_TYPES: Readonly<Record<string, { kind: Kind; ext: Ext; mime: string; name: string }>> = {
  "image/png": { kind: "image", ext: "png", mime: "image/png", name: "PNG" },
  "image/jpeg": { kind: "image", ext: "jpg", mime: "image/jpeg", name: "JPEG" },
  "image/gif": { kind: "clip", ext: "gif", mime: "image/gif", name: "GIF" },
  "video/mp4": { kind: "clip", ext: "mp4", mime: "video/mp4", name: "MP4" },
};
const PREVIEW_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg" };

const LINK_ID = /^[a-z2-7]{20}$/;
const FILE_NAME = /^([a-z2-7]{20})\.(png|jpg|gif|mp4)$/;

/** A page lives a minute in a cache, then a cheap 304 by ETag, as a tour page does. */
export const SHARE_PAGE_CACHE = "public, max-age=60";
/** A file, a preview, the stylesheet and the script: an hour. An online item never changes. */
export const SHARE_FILE_CACHE = "public, max-age=3600";
/** The database calls of every request here: the lookup, onlineItemFiles. */
export const SHARE_LOOKUP_CALLS = SERVE_LOOKUP_CALLS;
/**
 * A file answer reads at most this many parts: with the lookup it stays within the 40-call
 * budget. A ranged answer is shortened to it; a whole-file answer never needs more, since
 * mediaLimitsProblem (src/limits.ts) refuses a size setting that would need more parts.
 */
export const MAX_PARTS_PER_ANSWER = MAX_SERVED_PARTS;

/** The policy of every page, the 404 included: only this origin's files, no framing, no forms. */
export const SHARE_PAGE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** The policy of every file and preview: nothing runs, even if it is opened as a document. */
export const SHARE_FILE_CSP = "default-src 'none'; sandbox";

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": SHARE_PAGE_CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

/** An online item as the lookup answers it, with the link id it was found by. Its `id` stays on the server. */
export type ShareItem = OnlineItemFiles & { link: string };

/** The item's parts with their lengths: every part PART_BYTES long but the last, which is the rest. */
function partsOf(item: ShareItem): FilePart[] {
  const last = item.parts.length - 1;
  return item.parts.map((key, n) => ({ key, bytes: n < last ? PART_BYTES : item.bytes - PART_BYTES * last }));
}

/** Text or a number for an HTML text node or a quoted attribute value: the one way any value reaches a page. */
const esc = (v: string | number): string => escapeHtml(String(v));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A moment as day, month abbreviation and year in UTC: "19 Nov 2026". */
export function shareDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A clip's length: "12 s" under a minute (at least "1 s"), else "2 min" or "2 min 5 s". */
export function shareDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${min} min` : `${min} min ${s} s`;
}

/** The details line under the title. */
export function detailsLine(item: ShareItem): string {
  const type = FILE_TYPES[item.contentType];
  const parts = [`${item.width} × ${item.height}`, type.name, formatBytes(item.bytes), `shared ${shareDate(item.sharedAt)}`];
  if (item.kind === "clip" && item.durationMs !== null) parts.unshift(shareDuration(item.durationMs));
  return parts.join(" · ");
}

function titleOf(item: ShareItem): string {
  if (item.title !== null && item.title !== "") return item.title;
  if (item.kind === "image") return SHARE_TEXT.untitledImage;
  return item.contentType === "image/gif" ? SHARE_TEXT.untitledGif : SHARE_TEXT.untitledClip;
}

const letterOf = (kind: Kind) => (kind === "image" ? "i" : "r");
const pagePath = (item: ShareItem) => `/${letterOf(item.kind)}/${item.link}`;
const filePath = (item: ShareItem) => `${pagePath(item)}.${FILE_TYPES[item.contentType].ext}`;

/** The origin of absolute addresses, from configuration only, as src/media.ts builds links: "" when none is configured. */
function originOf(config: Config): string {
  return mediaOrigin({ hosts: config.hosts ?? null, ...(typeof config.siteHost === "string" ? { siteHost: config.siteHost } : {}) });
}

/**
 * The link preview tags. Absolute addresses only when the configuration names an origin;
 * otherwise only the tags that need none, never an origin taken from the request.
 */
function previewTags(item: ShareItem, title: string, origin: string): string {
  const mp4 = item.contentType === "video/mp4";
  const tags: [string, string | number][] = [
    ["og:title", title],
    ["og:type", mp4 ? "video.other" : "website"],
  ];
  let image: { url: string; width: number | null; height: number | null } | null = null;
  if (origin !== "") {
    tags.push(["og:url", origin + pagePath(item)]);
    if (item.kind === "image") image = { url: origin + filePath(item), width: item.width, height: item.height };
    else if (item.preview !== null) image = { url: `${origin}${pagePath(item)}/preview`, width: null, height: null };
    else if (item.contentType === "image/gif") image = { url: origin + filePath(item), width: item.width, height: item.height };
    if (image !== null) {
      tags.push(["og:image", image.url]);
      if (image.width !== null && image.height !== null) tags.push(["og:image:width", image.width], ["og:image:height", image.height]);
    }
    if (mp4) {
      tags.push(["og:video", origin + filePath(item)]);
      if (origin.startsWith("https://")) tags.push(["og:video:secure_url", origin + filePath(item)]);
      tags.push(["og:video:type", "video/mp4"], ["og:video:width", item.width], ["og:video:height", item.height]);
    }
  }
  const lines = tags.map(([p, v]) => `<meta property="${esc(p)}" content="${esc(v)}">`);
  lines.push(`<meta name="twitter:card" content="${image !== null ? "summary_large_image" : "summary"}">`);
  return lines.join("\n");
}

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">`;

const FOOT = `<footer class="foot">${esc(SHARE_TEXT.footBefore)}<a href="${esc(SHARE_TEXT.site)}">${esc(SHARE_TEXT.brand)}</a>${esc(SHARE_TEXT.footAfter)}</footer>`;

/** The page of one online item. Byte for byte the same on both targets. */
export function sharePageHtml(item: ShareItem, origin: string): string {
  const title = titleOf(item);
  const type = FILE_TYPES[item.contentType];
  const file = filePath(item);
  const mp4 = type.ext === "mp4";
  let stage: string;
  if (mp4) {
    const poster = item.preview !== null ? ` poster="${esc(pagePath(item) + "/preview")}"` : "";
    stage = `<video id="clip" src="${esc(file)}" width="${esc(item.width)}" height="${esc(item.height)}"${poster} muted loop autoplay playsinline preload="auto" tabindex="0" aria-label="${esc(title)}"></video>`;
  } else {
    stage = `<img${item.kind === "clip" ? ' id="clip"' : ""} src="${esc(file)}" width="${esc(item.width)}" height="${esc(item.height)}" alt="${esc(title)}">`;
  }
  const lines = [`<p class="d">${esc(detailsLine(item))}</p>`];
  if (item.kind === "clip") lines.push(`<p class="d">${esc(mp4 ? SHARE_TEXT.loopMp4 : SHARE_TEXT.loopGif)}</p>`);
  const open = item.kind === "image" ? SHARE_TEXT.openFull : SHARE_TEXT.openFile;
  return `<!doctype html>
<html lang="en">
<head>
${HEAD}
<title>${esc(title)}</title>
${previewTags(item, title, origin)}
<link rel="stylesheet" href="${SHARE_CSS_PATH}">
${mp4 ? `<script src="${SHARE_JS_PATH}" defer></script>\n` : ""}</head>
<body>
<header class="top"><span class="brand">${esc(SHARE_TEXT.brand)}</span><span class="who">${esc(item.kind === "image" ? SHARE_TEXT.sharedImage : SHARE_TEXT.sharedClip)}</span></header>
<main>
<div class="stage">${stage}</div>
<div class="meta"><div><h1>${esc(title)}</h1>${lines.join("")}</div><div class="acts"><a class="btn" href="${esc(file)}">${esc(open)}</a><a class="btn" href="${esc(pagePath(item) + "/download")}">${esc(SHARE_TEXT.download)}</a></div></div>
</main>
${FOOT}
</body>
</html>
`;
}

/** The one body of every link that does not work. */
export const SHARE_NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
${HEAD}
<title>${esc(SHARE_TEXT.goneTitle)}</title>
<link rel="stylesheet" href="${SHARE_CSS_PATH}">
</head>
<body>
<header class="top"><span class="brand">${esc(SHARE_TEXT.brand)}</span></header>
<main class="gone"><h1>${esc(SHARE_TEXT.goneTitle)}</h1><p>${esc(SHARE_TEXT.goneText)}</p></main>
</body>
</html>
`;

/** The one answer for every link that does not work, whatever the reason: same status, body and headers. */
export function shareNotFound(): Response {
  return new Response(SHARE_NOT_FOUND_HTML, { status: 404, headers: { ...PAGE_HEADERS, "cache-control": "no-store" } });
}

async function digestTag(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let hex = "";
  for (const b of digest.subarray(0, 16)) hex += b.toString(16).padStart(2, "0");
  return `"${hex}"`;
}

/** The parsed name of `/i/:name` or `/r/:name`: a link id, with the extension when it names the file. Null for anything else. */
function parseName(name: string): { link: string; ext: Ext | null } | null {
  if (LINK_ID.test(name)) return { link: name, ext: null };
  const m = FILE_NAME.exec(name);
  return m === null ? null : { link: m[1], ext: m[2] as Ext };
}

/**
 * The lookup, made for every request whatever the name: a name that is no link id is
 * looked up as "", which finds nothing at the same cost. An item of the other kind, or of
 * a type this module does not serve, is not found. Nor is an item of more parts than one
 * answer may read (MAX_SERVED_PARTS): one stored under an older, larger size setting
 * would otherwise make a whole-file answer run past the call budget. It is logged, with
 * its number of parts only.
 */
async function lookup(deps: Deps, kind: Kind, link: string | null): Promise<ShareItem | null> {
  const files = await onlineItemFiles(deps, link ?? "");
  if (files === null || link === null) return null;
  const type = FILE_TYPES[files.contentType];
  if (type === undefined || type.kind !== kind || files.kind !== kind || files.parts.length === 0) return null;
  if (files.parts.length > MAX_SERVED_PARTS) {
    console.error(`share: an online item has ${files.parts.length} parts, more than the ${MAX_SERVED_PARTS} one answer may read; answering 404`);
    return null;
  }
  return { ...files, link };
}

/** The headers every file answer carries, whatever its status. */
function fileHeaders(type: { mime: string; ext: Ext }, item: ShareItem, attachment: boolean): Record<string, string> {
  return {
    "content-type": type.mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": SHARE_FILE_CSP,
    "referrer-policy": "no-referrer",
    "accept-ranges": "bytes",
    // Built from the link id and the extension only, never from the title.
    "content-disposition": `${attachment ? "attachment" : "inline"}; filename="${item.link}.${type.ext}"`,
  };
}

/**
 * The file, whole or one range of it. A matching If-None-Match is a 304 before any part is
 * read; a Range the file cannot satisfy is a 416; one range is a 206 that reads only the
 * parts it covers (at most MAX_PARTS_PER_ANSWER of them: a longer range is shortened, and
 * Content-Range says so); several ranges answer the whole file. HEAD reads no part.
 */
async function serveFile(c: Context, deps: Deps, item: ShareItem, attachment: boolean): Promise<Response> {
  const type = FILE_TYPES[item.contentType];
  const parts = partsOf(item);
  const size = item.bytes;
  // The ETag names this exact set of objects: their keys hold the claims, which never change while the item is online.
  const etag = await digestTag(`file:${item.contentType}:${item.bytes}:${item.parts.join(",")}`);
  const headers: Record<string, string> = { ...fileHeaders(type, item, attachment), "cache-control": SHARE_FILE_CACHE, etag };
  if (matchesEtag(c.req.header("if-none-match") ?? null, etag)) return new Response(null, { status: 304, headers });

  const ifRange = c.req.header("if-range");
  let ask = parseRange(c.req.header("range") ?? null, size);
  if (ifRange !== undefined && ifRange.trim() !== etag) ask = { kind: "full" };
  if (ask.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}`, "cache-control": "no-store" } });
  }
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (ask.kind === "range") {
    start = ask.start;
    end = capRange(parts, ask.start, ask.end, MAX_PARTS_PER_ANSWER);
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = String(end - start + 1);
  if (c.req.method === "HEAD") return new Response(null, { status, headers });

  // The first part is fetched before answering, so a missing object is the 404, not a cut-off 200.
  const firstPart = parts[partsCovered(parts, start, end).first];
  const first = await deps.drafts.get(firstPart.key);
  if (first === null || first.size !== firstPart.bytes) {
    await first?.body.cancel().catch(() => {});
    console.error("share: an online item's part is missing or has the wrong length; answering 404");
    return shareNotFound();
  }
  return new Response(rangeStream(deps.drafts, parts, start, end, first), { status, headers });
}

/** The preview picture: one store read (HEAD too, for its length), its type from the item's row. */
async function servePreview(c: Context, deps: Deps, item: ShareItem): Promise<Response> {
  const preview = item.preview;
  if (preview === null) return shareNotFound();
  const etag = await digestTag(`preview:${preview.type}:${preview.key}`);
  const headers: Record<string, string> = {
    "content-type": PREVIEW_TYPES[preview.type],
    "x-content-type-options": "nosniff",
    "content-security-policy": SHARE_FILE_CSP,
    "referrer-policy": "no-referrer",
    "content-disposition": `inline; filename="${item.link}-preview.${preview.type}"`,
    "cache-control": SHARE_FILE_CACHE,
    etag,
  };
  if (matchesEtag(c.req.header("if-none-match") ?? null, etag)) return new Response(null, { status: 304, headers });
  const file = await deps.drafts.get(preview.key);
  if (file === null) return shareNotFound();
  headers["content-length"] = String(file.size);
  if (c.req.method === "HEAD") {
    await file.body.cancel().catch(() => {});
    return new Response(null, { status: 200, headers });
  }
  return new Response(file.body, { status: 200, headers });
}

async function servePage(c: Context, deps: Deps, item: ShareItem): Promise<Response> {
  const html = sharePageHtml(item, originOf(deps.config));
  const etag = await digestTag(html);
  const headers = { ...PAGE_HEADERS, "cache-control": SHARE_PAGE_CACHE, etag };
  if (matchesEtag(c.req.header("if-none-match") ?? null, etag)) return new Response(null, { status: 304, headers });
  return new Response(html, { status: 200, headers });
}

/** The stylesheet or the script: fixed text, an hour in a cache (the address carries no hash), a 304 by ETag. */
function asset(body: string, type: string): (c: Context) => Promise<Response> {
  let tag: Promise<string> | null = null;
  return async (c) => {
    tag ??= digestTag(body);
    const etag = await tag;
    const headers = { "content-type": type, "cache-control": SHARE_FILE_CACHE, etag, "x-content-type-options": "nosniff" };
    if (matchesEtag(c.req.header("if-none-match") ?? null, etag)) return new Response(null, { status: 304, headers });
    return new Response(body, { status: 200, headers });
  };
}

export function sharePageRoutes(app: Hono, deps: Deps): void {
  for (const kind of ["image", "clip"] as const) {
    const letter = letterOf(kind);
    // The page, or the file when the name carries the item's one extension.
    app.get(`/${letter}/:name`, async (c) => {
      const name = parseName(c.req.param("name"));
      const item = await lookup(deps, kind, name?.link ?? null);
      if (name === null || item === null) return shareNotFound();
      if (name.ext === null) return servePage(c, deps, item);
      if (name.ext !== FILE_TYPES[item.contentType].ext) return shareNotFound();
      return serveFile(c, deps, item, false);
    });
    // The same file, to be saved.
    app.get(`/${letter}/:name/download`, async (c) => {
      const raw = c.req.param("name");
      const link = LINK_ID.test(raw) ? raw : null;
      const item = await lookup(deps, kind, link);
      if (item === null) return shareNotFound();
      return serveFile(c, deps, item, true);
    });
    // The preview picture, for link previews and a clip's poster.
    app.get(`/${letter}/:name/preview`, async (c) => {
      const raw = c.req.param("name");
      const link = LINK_ID.test(raw) ? raw : null;
      const item = await lookup(deps, kind, link);
      if (item === null) return shareNotFound();
      return servePreview(c, deps, item);
    });
  }
  app.get(SHARE_CSS_PATH, asset(SHARE_CSS, "text/css; charset=utf-8"));
  app.get(SHARE_JS_PATH, asset(SHARE_JS, "text/javascript; charset=utf-8"));
}
