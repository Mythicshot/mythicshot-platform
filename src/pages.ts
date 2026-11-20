// The routes of the sign-in pages: /signin and /signin/link, and their one stylesheet and
// one script (src/signin/page.ts); and the page an invite's link opens, /invite, with its own
// script (src/signin/accept.ts) and the sign-in pages' stylesheet. Each answers its fixed
// text: no database or storage call, no credential read, nothing about anyone. The host gate
// keeps all six to the app address, where the session cookie lives (on the one address in
// one-address mode). The
// account page, /account, is a dashboard page (src/dash/account.ts) and uses the headers
// below, as every dashboard page does.
import type { Hono } from "hono";
import type { Deps } from "./ports.ts";
import { INVITE_HTML, INVITE_JS } from "./signin/accept.ts";
import { inviteContactFrom } from "./signin/invite.ts";
import { LINK_HTML, SIGNIN_CSS, SIGNIN_JS, signinHtml } from "./signin/page.ts";

/**
 * The headers of the sign-in pages' answers and the dashboard's, besides their content
 * type: the setup wizard's policy, no framing, no referrer, no caching, no sniffing, and a
 * browsing context of its own.
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

/**
 * Adds the sign-in pages' routes. Nothing they answer depends on the site's data; the
 * sign-in page carries the invite line of the INVITE_CONTACT setting, made once here from
 * the configuration (a value that cannot be used gives the page without a contact).
 */
export function pageRoutesForAccounts(app: Hono, deps: Deps): void {
  const serve = (body: string, type: string) => () => new Response(body, { status: 200, headers: { ...ACCOUNT_PAGE_HEADERS, "content-type": type } });
  app.get("/signin", serve(signinHtml(inviteContactFrom(deps.config.inviteContact)), HTML));
  app.get("/signin/link", serve(LINK_HTML, HTML));
  app.get("/signin/signin.css", serve(SIGNIN_CSS, "text/css; charset=utf-8"));
  app.get("/signin/signin.js", serve(SIGNIN_JS, "text/javascript; charset=utf-8"));
  app.get("/invite", serve(INVITE_HTML, HTML));
  app.get("/invite/invite.js", serve(INVITE_JS, "text/javascript; charset=utf-8"));
}
