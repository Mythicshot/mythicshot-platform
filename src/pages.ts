// The routes of the sign-in pages: /signin, /signin/link and /account, and their one
// stylesheet and one script (src/signin/page.ts). Each answers its fixed text: no
// database or storage call, no credential read, nothing about anyone. What a page shows
// of an account its script fetches from /api/v1. The host gate keeps all five to the app
// address, where the session cookie lives (on the one address in one-address mode).
import type { Hono } from "hono";
import type { Deps } from "./ports.ts";
import { ACCOUNT_HTML, LINK_HTML, SIGNIN_CSS, SIGNIN_HTML, SIGNIN_JS } from "./signin/page.ts";

/**
 * The headers of all five answers, besides their content type: the setup wizard's policy,
 * no framing, no referrer, no caching, no sniffing, and a browsing context of its own.
 */
export const ACCOUNT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};

const HTML = "text/html; charset=utf-8";

/** Adds the sign-in pages' routes. They use no deps: nothing they answer depends on the site's data. */
export function pageRoutesForAccounts(app: Hono, _deps: Deps): void {
  const serve = (body: string, type: string) => () => new Response(body, { status: 200, headers: { ...ACCOUNT_PAGE_HEADERS, "content-type": type } });
  app.get("/signin", serve(SIGNIN_HTML, HTML));
  app.get("/signin/link", serve(LINK_HTML, HTML));
  app.get("/account", serve(ACCOUNT_HTML, HTML));
  app.get("/signin/signin.css", serve(SIGNIN_CSS, "text/css; charset=utf-8"));
  app.get("/signin/signin.js", serve(SIGNIN_JS, "text/javascript; charset=utf-8"));
}
