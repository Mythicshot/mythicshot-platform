// The brand at the top of the dashboard's pages (src/dash/shell.ts), the sign-in pages
// (src/signin/page.ts) and the invite page (src/signin/accept.ts): the product's mark, then
// its name. The mark is the brand's small mark (used below 48 pixels), the app's own file
// /dash/mark.svg (src/brand-assets.ts); its alt is empty, as the name beside it is the label.
// The name is the wordmark, "MYTHICSHOT" in the brand's Cinzel, drawn as a picture by
// scripts/build-wordmark.py in two colourways: gold for dark grounds, ink for light ones. A
// <picture> picks one with the prefers-color-scheme media query of its <source>, which the
// pages' own colours follow too: no script, and the policy's img-src 'self' covers both,
// since they are the app's own files on the app address (src/dash/routes.ts), as the mark is.
// Its alt is "Mythicshot", the text a screen reader reads and a browser shows when the
// picture cannot be loaded. The platform serves no font for the name.
//
// Every page is built with the plain brand, BRAND_PLAIN. With the optional HOME_URL setting
// (homeUrlSetting, src/https-address.ts) the routes serve the page through withHome, which
// makes the mark and the name one link to the site's home page, in the same tab. The pages
// viewers of other people's content see (on the tours and img addresses) keep the name
// alone: the mark is not served there.
import { WORDMARK_HEIGHT, WORDMARK_WIDTH } from "./brand-assets.ts";
import { escapeHtml } from "./signin/invite.ts";

/** Where the tab icon is served, on every address (src/brand-routes.ts). */
export const FAVICON_SVG_PATH = "/favicon.svg";
export const FAVICON_ICO_PATH = "/favicon.ico";

/**
 * What the platform's own pages (the dashboard, the sign-in and invite pages, the setup wizard
 * and the API documentation) put in their head for the tab icon: the ICO for every browser,
 * the SVG for those that take it. The pages that show what people publish (a tour, a shared
 * image or clip, their gates and not-found pages) keep their markup, and a browser asks
 * /favicon.ico of their address by itself.
 */
export const FAVICON_LINKS = `<link rel="icon" href="${FAVICON_ICO_PATH}" sizes="16x16 32x32 48x48">
<link rel="icon" href="${FAVICON_SVG_PATH}" type="image/svg+xml">`;

/** Where the mark is served. */
export const MARK_PATH = "/dash/mark.svg";
/** Where the wordmark is served: for dark grounds, and for light ones (the picture's fallback). */
export const WORDMARK_DARK_PATH = "/dash/wordmark-dark.png";
export const WORDMARK_LIGHT_PATH = "/dash/wordmark-light.png";

/** The wordmark: the dark ground's picture when the system's scheme is dark, else the light one. */
export const WORDMARK_HTML = `<picture><source srcset="${WORDMARK_DARK_PATH}" media="(prefers-color-scheme: dark)"><img src="${WORDMARK_LIGHT_PATH}" alt="Mythicshot" width="${WORDMARK_WIDTH}" height="${WORDMARK_HEIGHT}"></picture>`;

/** The mark and the name, as written inside the brand and its link. */
const MARK_AND_NAME = `<img src="${MARK_PATH}" alt="" width="24" height="24">${WORDMARK_HTML}`;

/** The brand as every page is built with it: the mark beside the name, no link. */
export const BRAND_PLAIN = `<p class="brand">${MARK_AND_NAME}</p>`;

/**
 * The brand for a home page's address: the plain brand without one, else the mark and the
 * name as one link to it, in the same tab, with the rel the sign-in page's other link to
 * another site has. The address is escaped.
 */
export function brandHtml(homeUrl: string | null): string {
  if (homeUrl === null) return BRAND_PLAIN;
  return `<p class="brand"><a href="${escapeHtml(homeUrl)}" rel="noopener noreferrer">${MARK_AND_NAME}</a></p>`;
}

/**
 * A page with its brand for `homeUrl` (Config.homeUrl): the page itself when there is none.
 * The page must hold the plain brand exactly once; anything else is a mistake in the page,
 * and throws.
 */
export function withHome(page: string, homeUrl: string | null | undefined): string {
  if (page.split(BRAND_PLAIN).length !== 2) throw new Error("a branded page holds the brand once");
  if (homeUrl === null || homeUrl === undefined) return page;
  const brand = brandHtml(homeUrl);
  return page.replace(BRAND_PLAIN, () => brand);
}
