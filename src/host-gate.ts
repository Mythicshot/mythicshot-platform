// The host gate: in two-address mode, decides from the host a request was sent to and
// the route it matched whether the route answers there. It runs before every route,
// reads no body, no token and no header, and makes no database or storage call. In
// one-address mode it does nothing.
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { originOf, requestHost, roleOf } from "./hosts.ts";
import type { Config } from "./ports.ts";

/**
 * Where a route answers in two-address mode. `any`: on every host, known or not. `both`:
 * on the tours and the app address. `tours`: on the tours address only, 404 on the app
 * address. `tours-redirect`: on the tours address, and the app address redirects there.
 */
export type HostRule = "any" | "both" | "tours" | "tours-redirect";

/**
 * The rule of every route, keyed by "<METHOD> <route path>" exactly as in the app's
 * route table. A route without an entry answers 404 on both addresses, and the matrix
 * in test/hosts.test.ts fails until it has one: a new route needs a line here.
 */
export const HOST_RULES: Readonly<Record<string, HostRule>> = {
  // The container's own health check and platform probes ask by an internal name.
  "GET /healthz": "any",

  // The wizard shows the address it is opened on as the server address for the recorder,
  // which builds tour links from it, so it lives on the tours address only.
  "GET /setup": "tours",
  "GET /setup/setup.css": "tours",
  "GET /setup/setup.js": "tours",
  "POST /setup/check": "tours",
  "POST /setup/claim": "tours",

  // The token API.
  "GET /api/v1/setup/connected": "both",
  "POST /api/v1/uploads": "both",
  "PUT /api/v1/uploads/:id/steps/:n": "both",
  "PUT /api/v1/uploads/:id/logo": "both",
  "POST /api/v1/uploads/:id/commit": "both",
  "DELETE /api/v1/uploads/:id": "both",
  "GET /api/v1/me": "both",
  "GET /api/v1/tours": "both",
  "PATCH /api/v1/tours/:id": "both",
  "DELETE /api/v1/tours/:id": "both",
  "GET /api/v1/tours/:id/steps/:step_id/image": "both",
  "POST /api/v1/tours/:id/publish": "both",
  "POST /api/v1/tours/:id/unpublish": "both",

  // Tour pages, their pictures and the player's files.
  "GET /p/:name": "tours-redirect",
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": "tours",
  "GET /t/:slug": "tours-redirect",
};

/** The answer to a host this install does not serve: 421 with nothing in it. */
export function misdirected(): Response {
  return new Response(null, { status: 421, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** The app address's answer for a route only the tours address has. */
function notHere(): Response {
  return new Response('{"error":"not_found"}', { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * The key of the route this request reached: the last matched route that is a handler
 * (middleware is registered for every method, as ALL), or null when none matched. A HEAD
 * request is matched as GET, so it gets GET's rule.
 */
function routeKey(c: Context): string | null {
  const route = matchedRoutes(c).findLast((r) => r.method !== "ALL");
  return route === undefined ? null : `${route.method} ${route.path}`;
}

/** The middleware. Installed first, so nothing runs before the host is known. */
export function hostGate(config: Config): MiddlewareHandler {
  return async (c, next) => {
    const hosts = config.hosts ?? null;
    if (hosts === null) return next();

    const key = routeKey(c);
    const rule = key === null ? undefined : HOST_RULES[key];
    if (rule === "any") return next();

    const role = roleOf(hosts, requestHost(c.req.raw));
    if (role === null) return misdirected();
    // No route matched: the app's own 404.
    if (key === null) return next();
    // A route nobody gave a rule: closed on both addresses.
    if (rule === undefined) return c.notFound();
    if (rule === "both" || role === "tours") return next();
    if (rule === "tours-redirect") {
      // The path and query are the request's; the host comes only from configuration.
      const url = new URL(c.req.url);
      return new Response(null, {
        status: 308,
        headers: {
          location: originOf(hosts.tours) + url.pathname + url.search,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return notHere();
  };
}
