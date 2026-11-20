// The dashboard's routes on the app address: GET / (which sends a person on), each page in
// DASH_PAGES with its own script, and the shared stylesheet and script. Every page and
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
import { ADMIN_HTML, ADMIN_JS } from "./admin.ts";

/** One dashboard page: where it is served, its document, and its own script. */
export type DashPage = { path: string; html: string; script: { path: string; body: string } };

/** The dashboard's pages. A later page adds its line here (see src/dash/shell.ts). */
export const DASH_PAGES: readonly DashPage[] = [
  { path: "/tours", html: TOURS_HTML, script: { path: "/dash/tours.js", body: TOURS_JS } },
  { path: "/admin", html: ADMIN_HTML, script: { path: "/dash/admin.js", body: ADMIN_JS } },
];

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
  for (const page of DASH_PAGES) {
    app.get(page.path, serve(page.html, HTML));
    app.get(page.script.path, serve(page.script.body, JS));
  }
  app.get("/dash/dash.css", serve(DASH_CSS, CSS));
  app.get("/dash/dash.js", serve(DASH_JS, JS));
}
