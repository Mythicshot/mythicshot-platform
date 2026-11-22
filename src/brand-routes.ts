// The brand's files, served by the app itself from src/brand-assets.ts on both targets:
//
// - the tab icon, /favicon.svg (the small mark) and /favicon.ico (16, 32 and 48 pixels), on
//   every address. The platform's own pages link both (FAVICON_LINKS); the pages that show
//   what people publish (a tour, a shared image or clip, their gates and not-found pages)
//   keep their markup as it was, and a browser asks /favicon.ico of their address by itself.
// - Manrope, the text font, and its licence, on every address: each address has pages set in it.
//
// Each is a fixed file: no database or storage call, no credential read, no cookie. A font's
// address names its content, so that address may be kept for good; any other answers today's
// file briefly, as the player's files do (src/page.ts). The licences, the tab icon and the
// mark have no version in their address, so they are kept for an hour or a day at most.
import type { Hono } from "hono";
import { FAVICON_ICO, MANROPE_ETAG, MANROPE_LICENCE, MANROPE_PATH, MANROPE_TTF, MARK_SMALL_SVG } from "./brand-assets.ts";
import { FAVICON_ICO_PATH, FAVICON_SVG_PATH } from "./brand.ts";
import { matchesEtag, PLAYER_FILE_CACHE, PLAYER_FILE_IMMUTABLE } from "./page.ts";

export { FAVICON_ICO_PATH, FAVICON_LINKS, FAVICON_SVG_PATH } from "./brand.ts";
export const MANROPE_LICENCE_PATH = "/fonts/manrope-OFL.txt";
/** The route of the font: its hashed address, the plain one, or another build's hash. */
export const MANROPE_ROUTE = "/fonts/:file{manrope(?:\\.[0-9a-f]{16})?\\.ttf}";

/** The tab icon has no version in its address: an hour. */
const ICON_CACHE = "public, max-age=3600";
/** The licences change only with a font: a day. */
const LICENCE_CACHE = "public, max-age=86400";
/** Opened on its own, a picture runs nothing: the policy of every picture the app serves itself. */
export const PICTURE_CSP = "default-src 'none'; sandbox";

function font(path: string, ifNoneMatch: string | undefined, current: string, etag: string, bytes: () => Uint8Array): Response {
  const cache = path === current ? PLAYER_FILE_IMMUTABLE : PLAYER_FILE_CACHE;
  const headers = { "content-type": "font/ttf", "cache-control": cache, etag, "x-content-type-options": "nosniff" };
  if (matchesEtag(ifNoneMatch ?? null, etag)) return new Response(null, { status: 304, headers });
  // Each answer gets its own copy of the bytes, so no answer can use up another's.
  return new Response(bytes().slice(), { status: 200, headers });
}

const text = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": LICENCE_CACHE, "x-content-type-options": "nosniff" } });

export function brandRoutes(app: Hono): void {
  app.get(FAVICON_SVG_PATH, () => new Response(MARK_SMALL_SVG, { status: 200, headers: { "content-type": "image/svg+xml", "cache-control": ICON_CACHE, "content-security-policy": PICTURE_CSP, "x-content-type-options": "nosniff" } }));
  app.get(FAVICON_ICO_PATH, () => new Response(FAVICON_ICO().slice(), { status: 200, headers: { "content-type": "image/x-icon", "cache-control": ICON_CACHE, "content-security-policy": PICTURE_CSP, "x-content-type-options": "nosniff" } }));
  app.get(MANROPE_ROUTE, (c) => font(c.req.path, c.req.header("if-none-match"), MANROPE_PATH, MANROPE_ETAG, MANROPE_TTF));
  app.get(MANROPE_LICENCE_PATH, text(MANROPE_LICENCE));
}
