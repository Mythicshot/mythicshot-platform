// The dashboard's routes on the app address: GET / (which sends a person on), each page in
// DASH_PAGES with its own script, the shared stylesheet and script, and the terms screen
// (TERMS_PAGE, also the read-only terms) with its own script. Every page and
// file answers its fixed text with the sign-in pages' headers (ACCOUNT_PAGE_HEADERS): no
// database or storage call, no credential read, nothing about anyone.
//
// GET / decides from the request alone whether a session cookie was sent, without looking
// the session up: with one it sends the browser to /tours, without one to /signin. A cookie
// that names no live session lands on /tours, whose script finds no session and sends the
// browser on to /signin. The answer depends only on the request's own cookie, never on
// any account, so it tells nobody anything, and it costs no database call.
import type { Hono } from "hono";
import { ACCOUNT_PAGE_HEADERS } from "../pages.ts";
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
 * served as DASH_PAGES are, with no database call, and kept apart because it is no dashboard
 * page: no top bar and no tabs, one card on its own page, with a script of its own. Its checks
 * are in test/dash-terms.test.ts.
 */
export const TERMS_PAGE: DashPage = { path: "/terms", html: TERMS_HTML, script: { path: "/dash/terms.js", body: TERMS_JS } };

const HTML = "text/html; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";

/** The answer GET / gives: a redirect that no cache keeps, with the pages' own headers. */
function sendTo(path: "/tours" | "/signin"): Response {
  return new Response(null, { status: 302, headers: { ...ACCOUNT_PAGE_HEADERS, location: path } });
}

export function dashRoutes(app: Hono): void {
  const serve = (body: string, type: string) => () => new Response(body, { status: 200, headers: { ...ACCOUNT_PAGE_HEADERS, "content-type": type } });
  app.get("/", (c) => sendTo(sessionCookiePresent(c.req.raw) ? "/tours" : "/signin"));
  for (const page of [...DASH_PAGES, ...DASH_LINK_PAGES]) {
    app.get(page.path, serve(page.html, HTML));
    app.get(page.script.path, serve(page.script.body, JS));
  }
  app.get("/dash/dash.css", serve(DASH_CSS, CSS));
  app.get("/dash/dash.js", serve(DASH_JS, JS));
  app.get(TERMS_PAGE.path, serve(TERMS_PAGE.html, HTML));
  app.get(TERMS_PAGE.script.path, serve(TERMS_PAGE.script.body, JS));
}
