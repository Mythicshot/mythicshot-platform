// The host gate: in two-address mode, decides from the host a request was sent to and
// the route it matched whether the route answers there. It runs before every route,
// reads no body, no token and no header, and makes no database or storage call. In
// one-address mode it does nothing.
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { originOf, requestHost, roleOf, type HostRole } from "./hosts.ts";
import type { Config } from "./ports.ts";

/**
 * Where a route answers in two-address mode. `any`: on every host, known or not. `both`:
 * on the tours and the app address. `tours`: on the tours address only, 404 on the app
 * address. `tours-redirect`: on the tours address, and the app address redirects there.
 * `app` and `app-redirect` are the same the other way round: on the app address only,
 * with 404 on the tours address, or a redirect from it.
 */
export type HostRule = "any" | "both" | "tours" | "tours-redirect" | "app" | "app-redirect";

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

  // The API a token or a session calls.
  "GET /api/v1/setup/connected": "both",
  "POST /api/v1/uploads": "both",
  "PUT /api/v1/uploads/:id/steps/:n": "both",
  "PUT /api/v1/uploads/:id/logo": "both",
  "POST /api/v1/uploads/:id/commit": "both",
  "DELETE /api/v1/uploads/:id": "both",
  "GET /api/v1/me": "both",
  "GET /api/v1/usage": "both",
  "GET /api/v1/usage/largest": "both",
  "GET /api/v1/tours": "both",
  "PATCH /api/v1/tours/:id": "both",
  "DELETE /api/v1/tours/:id": "both",
  "GET /api/v1/tours/:id/steps/:step_id/image": "both",
  "POST /api/v1/tours/:id/publish": "both",
  "POST /api/v1/tours/:id/unpublish": "both",

  // Signing in and the session. The session cookie belongs to the app address alone, so
  // none of these answers on the tours address, which holds what users publish.
  "POST /api/v1/signin/request": "app",
  "POST /api/v1/signin/complete": "app",
  "GET /api/v1/session": "app",
  "GET /api/v1/sessions": "app",
  "DELETE /api/v1/sessions/:id": "app",
  "POST /api/v1/signout": "app",
  "POST /api/v1/signout/everywhere": "app",

  // The site admin's routes: they take an admin's session alone, so they answer only where
  // the session cookie lives.
  "GET /api/v1/admin/summary": "app",
  "GET /api/v1/admin/accounts": "app",
  "PATCH /api/v1/admin/workspaces/:id": "app",

  // The sign-in pages and their two files. They lead to the session, whose cookie belongs
  // to the app address alone, so none of them answers on the tours address.
  "GET /signin": "app",
  "GET /signin/link": "app",
  "GET /account": "app",
  "GET /signin/signin.css": "app",
  "GET /signin/signin.js": "app",

  // Tour pages, their pictures and the player's files.
  "GET /p/:name": "tours-redirect",
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": "tours",
  "GET /t/:slug": "tours-redirect",

  // The API documentation. The tours origin holds what users publish and may be framed
  // anywhere, so nothing of the page is served from it: it sends the page on to the app
  // address (people know the tours address, so <tours address>/docs should arrive) and
  // has none of its files.
  "GET /docs": "app-redirect",
  "GET /docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}": "app",
  "GET /docs/licences.txt": "app",
  // The description is public text beside the API it describes, on either address.
  "GET /api/v1/openapi.json": "both",
  "GET /api/v1/openapi.yaml": "both",
};

/** The answer to a host this install does not serve: 421 with nothing in it. */
export function misdirected(): Response {
  return new Response(null, { status: 421, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** One address's answer for a route only the other address has. */
function notHere(): Response {
  return new Response('{"error":"not_found"}', { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** From the most open rule to the strictest. Rules that name different addresses are never compared: see ruleFor. */
const STRICTNESS: readonly HostRule[] = ["any", "both", "tours-redirect", "app-redirect", "tours", "app"];

/** The one address a rule keeps a route to, or null when it answers on both. */
function sideOf(rule: HostRule): HostRole | null {
  if (rule === "tours" || rule === "tours-redirect") return "tours";
  if (rule === "app" || rule === "app-redirect") return "app";
  return null;
}

/**
 * The rule for this request: the strictest rule among every route it matched, the gate
 * itself left out. Hono may answer from any of them, so each one needs a rule: null when
 * no route matched, "none" when a matched route has no rule, and also when two matched
 * routes are kept to different addresses: no address may then answer for both, so the
 * request is closed on both. A route is keyed as
 * "<METHOD> <path>", one registered for every method as "ALL <path>"; a HEAD request is
 * matched as GET, so it gets GET's rule.
 */
function ruleFor(c: Context, gate: MiddlewareHandler, rules: Readonly<Record<string, HostRule>>): HostRule | "none" | null {
  let strictest: HostRule | null = null;
  let side: HostRole | null = null;
  for (const route of matchedRoutes(c)) {
    if (route.handler === gate) continue;
    const key = `${route.method} ${route.path}`;
    if (!Object.hasOwn(rules, key)) return "none";
    const rule = rules[key];
    const kept = sideOf(rule);
    if (kept !== null) {
      if (side !== null && side !== kept) return "none";
      side = kept;
    }
    if (strictest === null || STRICTNESS.indexOf(rule) > STRICTNESS.indexOf(strictest)) strictest = rule;
  }
  return strictest;
}

/**
 * The middleware. Installed first, so nothing runs before the host is known. `rules` is
 * HOST_RULES except in tests of the lookup itself.
 */
export function hostGate(config: Config, rules: Readonly<Record<string, HostRule>> = HOST_RULES): MiddlewareHandler {
  const gate: MiddlewareHandler = async (c, next) => {
    const hosts = config.hosts ?? null;
    if (hosts === null) return next();

    const rule = ruleFor(c, gate, rules);
    if (rule === "any") return next();

    const role = roleOf(hosts, requestHost(c.req.raw));
    if (role === null) return misdirected();
    // No route matched: the app's own 404.
    if (rule === null) return next();
    // A matched route nobody gave a rule: closed on both addresses.
    if (rule === "none") return c.notFound();
    // The address the rule keeps the route to; this request reached `role`.
    const home = sideOf(rule);
    if (home === null || home === role) return next();
    if (rule === "tours-redirect" || rule === "app-redirect") {
      // The path and query are the request's; the host comes only from configuration.
      const url = new URL(c.req.url);
      return new Response(null, {
        status: 308,
        headers: {
          location: originOf(hosts[home]) + url.pathname + url.search,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return notHere();
  };
  return gate;
}
