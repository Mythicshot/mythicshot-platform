// The host gate: with addresses configured, decides from the host a request was sent to
// and the route it matched whether the route answers there. It runs before every route,
// reads no body, no token and no header, and makes no database or storage call. In
// one-address mode it does nothing.
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { HOST_ROLES, mediaRole, originOf, requestHost, roleOf, type HostRole, type Hosts } from "./hosts.ts";
import type { Config } from "./ports.ts";

/**
 * Where a route answers with addresses configured. `any`: on every host, known or not.
 * `both`: on the tours and the app address. `tours`: on the tours address only, 404 on the
 * app address. `tours-redirect`: on the tours address, and the app address redirects
 * there. `app` and `app-redirect` are the same the other way round: on the app address
 * only, with 404 on the tours address, or a redirect from it. `media`: shared images and
 * clips, on the img address only when it is set, else on the tours address only (404
 * everywhere else, and never a redirect). On the img address every rule but `any` and
 * `media` is 404. In one-address mode every rule answers on the one address.
 */
export type HostRule = "any" | "both" | "tours" | "tours-redirect" | "app" | "app-redirect" | "media";

/**
 * Where each rule answers, for the configured addresses: the roles whose address answers
 * it, and the one role (if any) whose address redirects to the first of them. A role the
 * list leaves out is 404, so a new role answers nothing it is not named for.
 */
const PLACES: Readonly<Record<HostRule, { on: (hosts: Hosts) => readonly HostRole[]; redirectFrom?: HostRole }>> = {
  any: { on: () => HOST_ROLES },
  both: { on: () => ["tours", "app"] },
  tours: { on: () => ["tours"] },
  "tours-redirect": { on: () => ["tours"], redirectFrom: "app" },
  app: { on: () => ["app"] },
  "app-redirect": { on: () => ["app"], redirectFrom: "tours" },
  media: { on: (hosts) => [mediaRole(hosts)] },
};

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
  // Shared items: the same rule as the uploads, whose credentials they take.
  "POST /api/v1/media": "both",
  "PUT /api/v1/media/:id/parts/:n": "both",
  "PUT /api/v1/media/:id/preview": "both",
  "POST /api/v1/media/:id/commit": "both",
  "DELETE /api/v1/media/:id": "both",
  "GET /api/v1/media": "both",
  "GET /api/v1/media/:id": "both",
  "GET /api/v1/media/:id/preview": "both",
  "GET /api/v1/me": "both",
  "GET /api/v1/usage": "both",
  "GET /api/v1/usage/largest": "both",
  "GET /api/v1/tours": "both",
  "PATCH /api/v1/tours/:id": "both",
  "DELETE /api/v1/tours/:id": "both",
  "GET /api/v1/tours/:id/steps/:step_id/image": "both",
  "POST /api/v1/tours/:id/publish": "both",
  "POST /api/v1/tours/:id/unpublish": "both",
  // Who may view a tour: the same credentials and addresses as every other tour change.
  "GET /api/v1/tours/:id/access": "both",
  "PUT /api/v1/tours/:id/access": "both",

  // Signing in and the session. The session cookie belongs to the app address alone, so
  // none of these answers on the tours address, which holds what users publish.
  "POST /api/v1/signin/request": "app",
  "POST /api/v1/signin/complete": "app",
  "GET /api/v1/session": "app",
  "GET /api/v1/sessions": "app",
  "DELETE /api/v1/sessions/:id": "app",
  "POST /api/v1/signout": "app",
  "POST /api/v1/signout/everywhere": "app",
  // Changing the account's email address takes a session alone, so it lives where the cookie does.
  "POST /api/v1/account/email": "app",
  "POST /api/v1/account/email/confirm": "app",

  // Connecting the desktop app (src/connect.ts). The app has no credential yet and talks to
  // whichever address it was set up with (an install from before this had only the tours
  // address to give it), so its two requests answer on both. Typing the short code takes a
  // session, so that part lives where the cookie does.
  "POST /api/v1/connect/start": "both",
  "POST /api/v1/connect/token": "both",
  "POST /api/v1/connect/lookup": "app",
  "POST /api/v1/connect/confirm": "app",
  "POST /api/v1/connect/refuse": "app",
  // The workspace's tokens (src/tokens.ts) take a session alone, so they live where the cookie does.
  "GET /api/v1/tokens": "app",
  "PATCH /api/v1/tokens/:id": "app",
  "DELETE /api/v1/tokens/:id": "app",

  // The site admin's routes: they take an admin's session alone, so they answer only where
  // the session cookie lives.
  "GET /api/v1/admin/summary": "app",
  "GET /api/v1/admin/accounts": "app",
  "PATCH /api/v1/admin/workspaces/:id": "app",
  "POST /api/v1/admin/invites": "app",
  "GET /api/v1/admin/invites": "app",
  "POST /api/v1/admin/invites/:id/resend": "app",
  "DELETE /api/v1/admin/invites/:id": "app",
  // Looking up and accepting an invite (src/invites.ts): no credential, but accepting signs
  // the new account in, so both live where the session cookie does, as signing in does.
  "POST /api/v1/invite/check": "app",
  "POST /api/v1/invite/accept": "app",
  "POST /api/v1/admin/accounts/:id/disable": "app",
  "POST /api/v1/admin/accounts/:id/enable": "app",
  "GET /api/v1/admin/accounts/:id/removal": "app",
  "DELETE /api/v1/admin/accounts/:id": "app",

  // The sign-in pages and their two files. They lead to the session, whose cookie belongs
  // to the app address alone, so none of them answers on the tours address.
  "GET /signin": "app",
  "GET /signin/link": "app",
  "GET /signin/signin.css": "app",
  "GET /signin/signin.js": "app",
  // The page an invite's link opens and its script: accepting signs the new account in, so
  // they live where the session cookie does.
  "GET /invite": "app",
  "GET /invite/invite.js": "app",

  // The dashboard (src/dash/), on the app address where the session cookie lives. The
  // tours address sends / on to the app address, which then sends a person to /tours or
  // /signin; the pages and their files have no place on the tours address.
  "GET /": "app-redirect",
  "GET /tours": "app",
  "GET /dash/tours.js": "app",
  "GET /dash/dash.css": "app",
  "GET /dash/dash.js": "app",
  "GET /images": "app",
  "GET /dash/images.js": "app",
  "GET /gifs": "app",
  "GET /dash/gifs.js": "app",
  "GET /storage": "app",
  "GET /dash/storage.js": "app",
  "GET /connections": "app",
  "GET /dash/connections.js": "app",
  "GET /admin": "app",
  "GET /dash/admin.js": "app",
  "GET /account": "app",
  "GET /dash/account.js": "app",
  "GET /account/email": "app",
  "GET /dash/account-email.js": "app",

  // Tour pages, their pictures and the player's files.
  "GET /p/:name": "tours-redirect",
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": "tours",
  "GET /t/:slug": "tours-redirect",

  // The pages and files a shared link opens, the preview pictures, and the pages' own
  // stylesheet and script: on the img address when it is set, else on the tours address.
  // They take no credential, so nothing of the session or a token reaches them.
  "GET /i/:name": "media",
  "GET /i/:name/download": "media",
  "GET /i/:name/preview": "media",
  "GET /r/:name": "media",
  "GET /r/:name/download": "media",
  "GET /r/:name/preview": "media",
  "GET /s/share.css": "media",
  "GET /s/share.js": "media",

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

/**
 * From the most open rule to the strictest. Only the strictest of a request's rules may
 * redirect: see the gate. `media` ranks strictest and never redirects, so a media route
 * matched together with a redirect rule answers 404 on the address that rule would
 * redirect from (without the img address, the app address) instead of redirecting.
 */
const STRICTNESS: readonly HostRule[] = ["any", "both", "tours-redirect", "app-redirect", "tours", "app", "media"];

/**
 * The rule for this request: the strictest rule among every route it matched, the gate
 * itself left out, and the roles whose address may answer it, which are the roles every
 * one of those rules answers on. Hono may answer from any of them, so each one needs a
 * rule: null when no route matched, "none" when a matched route has no rule, and also when
 * no address answers all of the matched routes' rules (two routes kept to different
 * addresses): no address may then answer for all of them, so the request is closed on
 * every address. A route is keyed as "<METHOD> <path>", one registered for every method as
 * "ALL <path>"; a HEAD request is matched as GET, so it gets GET's rule.
 */
function ruleFor(
  c: Context,
  gate: MiddlewareHandler,
  rules: Readonly<Record<string, HostRule>>,
  hosts: Hosts,
): { rule: HostRule; on: readonly HostRole[] } | "none" | null {
  let strictest: HostRule | null = null;
  let on: readonly HostRole[] = HOST_ROLES;
  for (const route of matchedRoutes(c)) {
    if (route.handler === gate) continue;
    const key = `${route.method} ${route.path}`;
    if (!Object.hasOwn(rules, key)) return "none";
    const rule = rules[key];
    const here = PLACES[rule].on(hosts);
    on = on.filter((role) => here.includes(role));
    if (on.length === 0) return "none";
    if (strictest === null || STRICTNESS.indexOf(rule) > STRICTNESS.indexOf(strictest)) strictest = rule;
  }
  return strictest === null ? null : { rule: strictest, on };
}

/**
 * The middleware. Installed first, so nothing runs before the host is known. `rules` is
 * HOST_RULES except in tests of the lookup itself.
 */
export function hostGate(config: Config, rules: Readonly<Record<string, HostRule>> = HOST_RULES): MiddlewareHandler {
  const gate: MiddlewareHandler = async (c, next) => {
    const hosts = config.hosts ?? null;
    if (hosts === null) return next();

    const found = ruleFor(c, gate, rules, hosts);
    if (found !== null && found !== "none" && found.rule === "any") return next();

    const role = roleOf(hosts, requestHost(c.req.raw));
    if (role === null) return misdirected();
    // No route matched: the app's own 404.
    if (found === null) return next();
    // A matched route nobody gave a rule: closed on every address.
    if (found === "none") return c.notFound();
    // This request reached `role`: it answers when every matched rule allows that address.
    if (found.on.includes(role)) return next();
    // Else only the one address the strictest rule names may redirect, to the address that
    // rule keeps the route to, and only when that address answers the request.
    const place = PLACES[found.rule];
    const home = place.on(hosts)[0];
    const target = home === undefined ? undefined : hosts[home];
    if (place.redirectFrom === role && target !== undefined && found.on.includes(home)) {
      // The path and query are the request's; the host comes only from configuration.
      const url = new URL(c.req.url);
      return new Response(null, {
        status: 308,
        headers: {
          location: originOf(target) + url.pathname + url.search,
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
