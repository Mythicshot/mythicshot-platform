// The dashboard's routes on the app address: GET / (which sends a person on), each page in
// DASH_PAGES with its own script, the shared stylesheet and script, the terms screen
// (TERMS_PAGE, also the read-only terms) with its own script, and the product's mark
// (/dash/mark.svg) and name (/dash/wordmark-dark.png and -light.png), which the sign-in and
// invite pages show too. Every page and file
// answers its fixed text or bytes with the sign-in pages' headers (ACCOUNT_PAGE_HEADERS): no
// database or storage call, no credential read, nothing about anyone. A page's brand links
// to the site's home page when the HOME_URL setting names one (withHome, src/brand.ts).
//
// GET / decides from the request alone whether a session cookie was sent, without looking
// the session up: with one it sends the browser to /tours, without one to /signin. A cookie
// that names no live session lands on /tours, whose script finds no session and sends the
// browser on to /signin. The answer depends only on the request's own cookie, never on
// any account, so it tells nobody anything, and it costs no database call.
import type { Hono } from "hono";
import { MARK_SMALL_SVG, WORDMARK_DARK_PNG, WORDMARK_LIGHT_PNG } from "../brand-assets.ts";
import { PICTURE_CSP } from "../brand-routes.ts";
import { MARK_PATH, WORDMARK_DARK_PATH, WORDMARK_LIGHT_PATH, withHome } from "../brand.ts";
import { ACCOUNT_PAGE_HEADERS } from "../pages.ts";
import type { Config } from "../ports.ts";
import { sessionCookiePresent } from "../sessions.ts";
import { DASH_JS } from "./script.ts";
import { DASH_CSS } from "./style.ts";
import { TOURS_HTML, TOURS_JS } from "./tours.ts";
import { GIFS_HTML, GIFS_JS, IMAGES_HTML, IMAGES_JS } from "./media.ts";
import { STORAGE_HTML, STORAGE_JS } from "./storage.ts";
import { ADMIN_HTML, ADMIN_JS } from "./admin.ts";
import { ACCOUNT_HTML, ACCOUNT_JS } from "./account.ts";
import { CONNECTIONS_HTML, CONNECTIONS_JS } from "./connections.ts";
import { ACCOUNT_EMAIL_HTML, ACCOUNT_EMAIL_JS } from "./account-email.ts";
import { TERMS_HTML, TERMS_JS } from "./terms.ts";
import { BILLING_JS, RETURN_HTML, RETURN_JS, SUBSCRIBE_HTML, SUBSCRIBE_JS } from "./billing.ts";
import { RETURN_PATH, SUBSCRIBE_PATH, billingConfigured } from "../billing-rules.ts";

/** One dashboard page: where it is served, its document, and its own script. */
export type DashPage = { path: string; html: string; script: { path: string; body: string } };

/** The dashboard's pages. A later page adds its line here (see src/dash/shell.ts). */
export const DASH_PAGES: readonly DashPage[] = [
  { path: "/images", html: IMAGES_HTML, script: { path: "/dash/images.js", body: IMAGES_JS } },
  { path: "/gifs", html: GIFS_HTML, script: { path: "/dash/gifs.js", body: GIFS_JS } },
  { path: "/tours", html: TOURS_HTML, script: { path: "/dash/tours.js", body: TOURS_JS } },
  { path: "/storage", html: STORAGE_HTML, script: { path: "/dash/storage.js", body: STORAGE_JS } },
  { path: "/connections", html: CONNECTIONS_HTML, script: { path: "/dash/connections.js", body: CONNECTIONS_JS } },
  { path: "/admin", html: ADMIN_HTML, script: { path: "/dash/admin.js", body: ADMIN_JS } },
  { path: "/account", html: ACCOUNT_HTML, script: { path: "/dash/account.js", body: ACCOUNT_JS } },
];

/**
 * The dashboard's pages that a mailed link opens: served as DASH_PAGES are, and kept apart
 * because their scripts read the code after `#` in the address and take it out of the
 * address bar, which no page in DASH_PAGES may do (test/dash.test.ts). Their own checks are
 * in test/dash-account.test.ts.
 */
export const DASH_LINK_PAGES: readonly DashPage[] = [
  { path: "/account/email", html: ACCOUNT_EMAIL_HTML, script: { path: "/dash/account-email.js", body: ACCOUNT_EMAIL_JS } },
];

/**
 * The terms screen, which is also the read-only terms at /terms?read (src/dash/terms.ts):
 * served as DASH_PAGES are (its brand through withHome), with no database call, and kept apart
 * because it has no top bar and no tabs: the brand above one card on its own page, with a
 * script of its own. Its checks
 * are in test/dash-terms.test.ts.
 */
export const TERMS_PAGE: DashPage = { path: "/terms", html: TERMS_HTML, script: { path: "/dash/terms.js", body: TERMS_JS } };

/**
 * The billing pages (src/dash/billing.ts), registered only on a site with billing switched on:
 * the return page and the Subscribe page, each with its own script, and the shared billing
 * script the dashboard loads when the session says billing is on. Kept apart from DASH_PAGES:
 * no tab leads to them.
 */
export const BILLING_PAGES: readonly DashPage[] = [
  { path: SUBSCRIBE_PATH, html: SUBSCRIBE_HTML, script: { path: "/dash/billing-subscribe.js", body: SUBSCRIBE_JS } },
  { path: RETURN_PATH, html: RETURN_HTML, script: { path: "/dash/billing-return.js", body: RETURN_JS } },
];
export const BILLING_SCRIPT_PATH = "/dash/billing.js";

/**
 * The Subscribe page's policy: the pages' own (ACCOUNT_PAGE_HEADERS) with only what Stripe's
 * embedded checkout needs added, as Stripe's security guide lists it for Checkout: its script
 * and checkout hosts for scripts and frames, its API and checkout hosts for connections, and its
 * pictures. No inline script or style, and nothing else changes; every other page keeps its own
 * policy byte for byte (test/dash-billing.test.ts).
 */
export const SUBSCRIBE_CSP =
  "default-src 'none'; img-src 'self' https://*.stripe.com; style-src 'self'; font-src 'self'; script-src 'self' https://js.stripe.com https://checkout.stripe.com; frame-src https://js.stripe.com https://checkout.stripe.com; connect-src 'self' https://api.stripe.com https://checkout.stripe.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HTML = "text/html; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const SVG = "image/svg+xml";

/** The answer GET / gives: a redirect that no cache keeps, with the pages' own headers. */
function sendTo(path: "/tours" | "/signin"): Response {
  return new Response(null, { status: 302, headers: { ...ACCOUNT_PAGE_HEADERS, location: path } });
}

/** `config.homeUrl` is the HOME_URL setting as checked at the start: the pages' brand links to it. */
export function dashRoutes(app: Hono, config: Pick<Config, "homeUrl" | "billing">): void {
  const serve = (body: string, type: string) => () => new Response(body, { status: 200, headers: { ...ACCOUNT_PAGE_HEADERS, "content-type": type } });
  // A page is made when it is asked for, so a request makes only its own.
  const page = (html: string) => () => new Response(withHome(html, config.homeUrl), { status: 200, headers: { ...ACCOUNT_PAGE_HEADERS, "content-type": HTML } });
  app.get("/", (c) => sendTo(sessionCookiePresent(c.req.raw) ? "/tours" : "/signin"));
  for (const p of [...DASH_PAGES, ...DASH_LINK_PAGES]) {
    app.get(p.path, page(p.html));
    app.get(p.script.path, serve(p.script.body, JS));
  }
  app.get("/dash/dash.css", serve(DASH_CSS, CSS));
  app.get("/dash/dash.js", serve(DASH_JS, JS));
  // The terms screen: its brand as every dashboard page's, through withHome.
  app.get(TERMS_PAGE.path, page(TERMS_PAGE.html));
  app.get(TERMS_PAGE.script.path, serve(TERMS_PAGE.script.body, JS));
  // Billing's pages and script: only with billing switched on, else no such path.
  if (billingConfigured(config)) {
    for (const p of BILLING_PAGES) {
      const headers = p.path === SUBSCRIBE_PATH ? { ...ACCOUNT_PAGE_HEADERS, "content-security-policy": SUBSCRIBE_CSP, "content-type": HTML } : { ...ACCOUNT_PAGE_HEADERS, "content-type": HTML };
      app.get(p.path, () => new Response(withHome(p.html, config.homeUrl), { status: 200, headers }));
      app.get(p.script.path, serve(p.script.body, JS));
    }
    app.get(BILLING_SCRIPT_PATH, serve(BILLING_JS, JS));
  }
  // The brand's small mark, the same file as the tab icon, and the wordmark's two pictures:
  // the pages' own headers, but a picture's policy, so a picture opened on its own runs
  // nothing (an SVG could hold a script) and is a sandboxed origin of its own.
  const picture = (type: string) => ({ ...ACCOUNT_PAGE_HEADERS, "content-security-policy": PICTURE_CSP, "content-type": type });
  app.get(MARK_PATH, () => new Response(MARK_SMALL_SVG, { status: 200, headers: picture(SVG) }));
  app.get(WORDMARK_DARK_PATH, () => new Response(WORDMARK_DARK_PNG().slice(), { status: 200, headers: picture("image/png") }));
  app.get(WORDMARK_LIGHT_PATH, () => new Response(WORDMARK_LIGHT_PNG().slice(), { status: 200, headers: picture("image/png") }));
}
