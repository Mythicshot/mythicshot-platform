// The documentation page script's two rules, as pure functions with no page around them,
// so tests can call them: what a token looks like, and where a request from the page may
// go. src/docs/client/main.ts is the only caller in the page.

/** A request the viewer is about to send, as its interceptor sees it. */
export type ViewerRequest = { url: string; method?: string; credentials?: string; loadSpec?: boolean; headers?: Record<string, string> };

/** The shape of a token, as TOKEN_PATTERN in src/auth.ts has it (a test holds them equal). */
export const TOKEN_SHAPE = /^dp_[0-9a-f]{40}$/;

export function looksLikeToken(text: string): boolean {
  return TOKEN_SHAPE.test(text);
}

/** What a refused request says, in the viewer's own error line. */
export const REFUSED = "This page only sends requests to this site's own API.";

/** Under this, a request carries the token. */
const API = "/api/v1/";
/** The one documented request outside it: it needs no token and never gets one. */
const HEALTH = "/healthz";

/**
 * The gate every request of the viewer passes ("Try it" and the loading of the
 * description). `pageHref` is the page's own address, `token` the one held, or "".
 *
 * A request to another origin, or to anything but this site's API, is refused: it throws,
 * and nothing is sent. An allowed one never carries a cookie, and carries the token only
 * to the API itself, never when fetching the description.
 *
 * Phase 2 (the dashboard's session cookie on the app address): "Try it" must still never
 * act with that cookie. `omit` guarantees it from this page; the API's own rules (a token
 * together with a cookie is refused, and a cookie-authenticated change needs the
 * anti-forgery header, which this page never sends) guarantee it from anywhere else.
 */
export function intercept(req: ViewerRequest, pageHref: string, token: string): ViewerRequest {
  let target: URL;
  let page: URL;
  try {
    page = new URL(pageHref);
    target = new URL(req.url, page);
  } catch {
    throw new Error(REFUSED);
  }
  const api = target.pathname.startsWith(API);
  if (target.origin !== page.origin || !(api || target.pathname === HEALTH)) throw new Error(REFUSED);
  req.credentials = "omit";
  if (api && token !== "" && req.loadSpec !== true) req.headers = { ...req.headers, Authorization: `Bearer ${token}` };
  return req;
}
