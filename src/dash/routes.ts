// The dashboard's routes on the app address: GET / (which sends a person on), each page in
// DASH_PAGES with its own script, the shared stylesheet and script, and the product's mark
// (/dash/mark.png, which the sign-in and invite pages show too). Every page and file
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
import { MARK_PATH, withHome } from "../brand.ts";
import { ACCOUNT_PAGE_HEADERS } from "../pages.ts";
import type { Config } from "../ports.ts";
import { sessionCookiePresent } from "../sessions.ts";
import { DASH_JS } from "./script.ts";
import { MARK_PNG } from "./mark.ts";
import { DASH_CSS } from "./style.ts";
import { TOURS_HTML, TOURS_JS } from "./tours.ts";
import { GIFS_HTML, GIFS_JS, IMAGES_HTML, IMAGES_JS } from "./media.ts";
import { STORAGE_HTML, STORAGE_JS } from "./storage.ts";
import { ADMIN_HTML, ADMIN_JS } from "./admin.ts";
import { ACCOUNT_HTML, ACCOUNT_JS } from "./account.ts";
import { CONNECTIONS_HTML, CONNECTIONS_JS } from "./connections.ts";
import { ACCOUNT_EMAIL_HTML, ACCOUNT_EMAIL_JS } from "./account-email.ts";

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

const HTML = "text/html; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const PNG = "image/png";

/** The answer GET / gives: a redirect that no cache keeps, with the pages' own headers. */
function sendTo(path: "/tours" | "/signin"): Response {
  return new Response(null, { status: 302, headers: { ...ACCOUNT_PAGE_HEADERS, location: path } });
}

/** `config.homeUrl` is the HOME_URL setting as checked at the start: the pages' brand links to it. */
export function dashRoutes(app: Hono, config: Pick<Config, "homeUrl">): void {
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
  // Each answer gets its own copy of the bytes, so no answer can use up another's.
  app.get(MARK_PATH, () => new Response(MARK_PNG.slice(), { status: 200, headers: { ...ACCOUNT_PAGE_HEADERS, "content-type": PNG } }));
}
