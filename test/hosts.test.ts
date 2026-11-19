// Which address answers what: one row per route in the route table, sent to the app in
// one-address mode and, in two-address mode, to the tours address, the app address and
// a host the install does not serve.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { createApp } from "../src/app.ts";
import { HOST_RULES, hostGate, type HostRule } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import type { Deps } from "../src/ports.ts";
import { VERSION } from "../src/version.ts";
import { count, fixtures, send, uploadTour, type Call, type Json } from "./bundle.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const UNKNOWN = "https://evil.example.net";
const OTHER = "https://other.example.net"; // any host, for one-address mode
const CODE = "correct-horse-battery-staple";
const NOT_FOUND = '{"error":"not_found"}';
const TOUR = "tour_0123456789abcdef01234567";
const UPLOAD = "up_0123456789abcdef01234567";
const STEP = "st_0123456789abcdef01234567";
const SESSION = "ses_0123456789abcdef01234567";
const WORKSPACE = "ws_0123456789abcdef01234567";

type Row = {
  method: string;
  path: string;
  /** A JSON body; the request then also carries its own address as Origin, as the wizard's page does. */
  body?: unknown;
  /** The expected status: one-address mode on any host, the tours address, the app address, an unknown host. */
  one: number;
  tours: number;
  app: number;
  unknown: number;
};

const api = (method: string, path: string): Row => ({ method, path, one: 401, tours: 401, app: 401, unknown: 421 });
const wizard = (method: string, path: string, status: number, body?: unknown): Row => ({ method, path, body, one: status, tours: status, app: 404, unknown: 421 });
const session = (method: string, path: string, status: number, body?: unknown): Row => ({ method, path, body, one: status, tours: 404, app: status, unknown: 421 });
/** An admin route: the one 404 to anyone but an admin's session, and on the app address only. */
const admin = (method: string, path: string, body?: unknown): Row => ({ method, path, body, one: 404, tours: 404, app: 404, unknown: 421 });

/** Keyed like HOST_RULES: "<METHOD> <route path>" exactly as in the route table. */
const ROWS: Record<string, Row> = {
  "GET /healthz": { method: "GET", path: "/healthz", one: 200, tours: 200, app: 200, unknown: 200 },
  "GET /setup": wizard("GET", "/setup", 200),
  "GET /setup/setup.css": wizard("GET", "/setup/setup.css", 200),
  "GET /setup/setup.js": wizard("GET", "/setup/setup.js", 200),
  "POST /setup/check": wizard("POST", "/setup/check", 204, { code: CODE }),
  // The right code with no workspace name: the wizard's own 400, and nothing is claimed.
  "POST /setup/claim": wizard("POST", "/setup/claim", 400, { code: CODE }),
  "GET /api/v1/setup/connected": api("GET", "/api/v1/setup/connected"),
  "POST /api/v1/uploads": api("POST", "/api/v1/uploads"),
  "PUT /api/v1/uploads/:id/steps/:n": api("PUT", `/api/v1/uploads/${UPLOAD}/steps/1`),
  "PUT /api/v1/uploads/:id/logo": api("PUT", `/api/v1/uploads/${UPLOAD}/logo`),
  "POST /api/v1/uploads/:id/commit": api("POST", `/api/v1/uploads/${UPLOAD}/commit`),
  "DELETE /api/v1/uploads/:id": api("DELETE", `/api/v1/uploads/${UPLOAD}`),
  "GET /api/v1/me": api("GET", "/api/v1/me"),
  "GET /api/v1/usage": api("GET", "/api/v1/usage"),
  "GET /api/v1/tours": api("GET", "/api/v1/tours"),
  "PATCH /api/v1/tours/:id": api("PATCH", `/api/v1/tours/${TOUR}`),
  "DELETE /api/v1/tours/:id": api("DELETE", `/api/v1/tours/${TOUR}`),
  "GET /api/v1/tours/:id/steps/:step_id/image": api("GET", `/api/v1/tours/${TOUR}/steps/${STEP}/image`),
  "POST /api/v1/tours/:id/publish": api("POST", `/api/v1/tours/${TOUR}/publish`),
  "POST /api/v1/tours/:id/unpublish": api("POST", `/api/v1/tours/${TOUR}/unpublish`),
  // Signing in and the session: on the app address only. Asking for a link answers 200
  // for any well-formed address; a code nobody was given is the one refusal; the rest
  // need a session and answer 401 without one.
  "POST /api/v1/signin/request": session("POST", "/api/v1/signin/request", 200, { email: "nobody@example.com" }),
  "POST /api/v1/signin/complete": session("POST", "/api/v1/signin/complete", 403, { code: "dpl_" + "0".repeat(40) }),
  "GET /api/v1/session": session("GET", "/api/v1/session", 401),
  "GET /api/v1/sessions": session("GET", "/api/v1/sessions", 401),
  "DELETE /api/v1/sessions/:id": session("DELETE", `/api/v1/sessions/${SESSION}`, 401),
  "POST /api/v1/signout": session("POST", "/api/v1/signout", 401),
  "POST /api/v1/signout/everywhere": session("POST", "/api/v1/signout/everywhere", 401),
  // The site admin's routes: on the app address only, and nobody here is an admin.
  "GET /api/v1/admin/accounts": admin("GET", "/api/v1/admin/accounts"),
  "PATCH /api/v1/admin/workspaces/:id": admin("PATCH", `/api/v1/admin/workspaces/${WORKSPACE}`, { storage_allowance_bytes: 1 }),
  "GET /p/:name": { method: "GET", path: `/p/${"0123456789abcdef".repeat(2)}.png`, one: 404, tours: 404, app: 308, unknown: 421 },
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": { method: "GET", path: "/player.js", one: 200, tours: 200, app: 404, unknown: 421 },
  "GET /t/:slug": { method: "GET", path: "/t/no-such-tour", one: 404, tours: 404, app: 308, unknown: 421 },
  // The documentation page lives on the app address: the tours address sends the page on and has none of its files.
  "GET /docs": { method: "GET", path: "/docs", one: 200, tours: 308, app: 200, unknown: 421 },
  "GET /docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}": { method: "GET", path: "/docs/viewer.0123456789abcdef.js", one: 200, tours: 404, app: 200, unknown: 421 },
  "GET /docs/licences.txt": { method: "GET", path: "/docs/licences.txt", one: 200, tours: 404, app: 200, unknown: 421 },
  // The description is public text beside the API, on both addresses.
  "GET /api/v1/openapi.json": { method: "GET", path: "/api/v1/openapi.json", one: 200, tours: 200, app: 200, unknown: 421 },
  "GET /api/v1/openapi.yaml": { method: "GET", path: "/api/v1/openapi.yaml", one: 200, tours: 200, app: 200, unknown: 421 },
};

const KEYS = Object.keys(ROWS);
const DESCRIPTION_KEYS = KEYS.filter((k) => k.includes(" /api/v1/openapi."));
/** Signing in and the session: the app address's own part of the API. */
const SESSION_KEYS = KEYS.filter((k) => /^[A-Z]+ \/api\/v1\/(?:signin|signout|sessions?)(?:\/|$)/.test(k));
/** The site admin's routes. */
const ADMIN_KEYS = KEYS.filter((k) => k.includes(" /api/v1/admin/"));
/** The token API: everything under /api/v1/ but the description files, which need no token, the session's own routes and the admin's. */
const API_KEYS = KEYS.filter((k) => k.includes(" /api/v1/") && !DESCRIPTION_KEYS.includes(k) && !SESSION_KEYS.includes(k) && !ADMIN_KEYS.includes(k));
const WIZARD_KEYS = KEYS.filter((k) => k.includes(" /setup"));
const PLAYER_KEY = KEYS.find((k) => k.startsWith("GET /:file"))!;
const DOCS_PAGE_KEY = "GET /docs";
/** The page's own files and the licence notices. */
const DOCS_FILE_KEYS = KEYS.filter((k) => k.startsWith("GET /docs/"));

function sendRow(deps: Deps, row: Row, origin: string): Promise<Call> {
  if (row.body === undefined) return send(deps, row.method, row.path, { origin });
  return send(deps, row.method, row.path, { origin, body: JSON.stringify(row.body), headers: { "content-type": "application/json", origin } });
}

/** Sends every row to `origin`; the answers by key. */
async function column(deps: Deps, origin: string): Promise<Record<string, Call>> {
  const out: Record<string, Call> = {};
  for (const key of KEYS) out[key] = await sendRow(deps, ROWS[key], origin);
  return out;
}

const statuses = (answers: Record<string, Call>) => Object.fromEntries(KEYS.map((k) => [k, answers[k].status]));
const expected = (col: "one" | "tours" | "app" | "unknown") => Object.fromEntries(KEYS.map((k) => [k, ROWS[k][col]]));

/** An install with a setup code and nothing claimed, in one-address mode. */
const oneAddress = (config?: Parameters<typeof makeDeps>[0]) => makeDeps({ setupCode: CODE, ...config });
/** The same in two-address mode. */
const twoAddress = (config?: Parameters<typeof makeDeps>[0]) => makeDeps({ setupCode: CODE, hosts: HOSTS, ...config });

function expectMisdirected(r: Call, what: string): void {
  expect(r.status, what).toBe(421);
  expect(r.bytes.length, what).toBe(0);
  expect(r.headers.get("cache-control"), what).toBe("no-store");
  expect(r.headers.get("x-content-type-options"), what).toBe("nosniff");
  expect(r.headers.get("content-type"), what).toBeNull();
  expect(r.headers.get("location"), what).toBeNull();
  expect(r.calls, what).toBe(0);
}

function expectRedirect(r: Call, location: string, what = location): void {
  expect(r.status, what).toBe(308);
  expect(r.headers.get("location"), what).toBe(location);
  expect(r.headers.get("cache-control"), what).toBe("no-store");
  expect(r.headers.get("referrer-policy"), what).toBe("no-referrer");
  expect(r.headers.get("x-content-type-options"), what).toBe("nosniff");
  expect(r.headers.get("content-type"), what).toBeNull();
  expect(r.bytes.length, what).toBe(0);
  expect(r.calls, what).toBe(0);
}

/** The app address's answer for a route only the tours address has. */
function expectNotHere(r: Call, what: string): void {
  expect(r.status, what).toBe(404);
  expect(r.text, what).toBe(NOT_FOUND);
  expect(r.headers.get("content-type"), what).toBe("application/json");
  expect(r.headers.get("cache-control"), what).toBe("no-store");
  expect(r.calls, what).toBe(0);
}

/** Publishes a tour through `origin`, calling until it is no longer in progress; the last answer. */
async function publishAt(deps: Deps, token: string, tourId: string, origin: string): Promise<Call> {
  let r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token, origin });
  while (r.status === 202) {
    r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, {
      token,
      origin,
      body: JSON.stringify({ publish_id: r.json.publish_id }),
      headers: { "content-type": "application/json" },
    });
  }
  return r;
}

describe("the host-routing matrix", () => {
  it("every route in the route table has a row and a rule, and nothing else does", () => {
    const app = createApp({ config: { publicImageBase: "", setupCode: null } } as Deps);
    // The gate is the route table's only entry for every method; a handler registered
    // for every method would need its own "ALL <path>" rule and row.
    const every = app.routes.filter((r) => r.method === "ALL");
    expect(every.map((r) => r.path), "the only route for every method is the host gate, first in the table").toEqual(["/*"]);
    expect(app.routes[0]).toBe(every[0]);
    const routes = app.routes.filter((r) => r !== every[0]).map((r) => `${r.method} ${r.path}`);
    expect(new Set(routes).size, "two routes share a method and a path").toBe(routes.length);
    const rules = Object.keys(HOST_RULES);
    const lacking = (have: string[], want: string[]) => want.filter((k) => !have.includes(k));
    expect(lacking(rules, routes), "add a rule to HOST_RULES in src/host-gate.ts for each of these routes").toEqual([]);
    expect(lacking(KEYS, routes), "add a row to ROWS in test/hosts.test.ts for each of these routes").toEqual([]);
    expect(lacking(routes, rules), "remove these keys from HOST_RULES in src/host-gate.ts: no route has them").toEqual([]);
    expect(lacking(routes, KEYS), "remove these keys from ROWS in test/hosts.test.ts: no route has them").toEqual([]);
    // Each row's sample request reaches its own route and no other.
    for (const key of KEYS) {
      const matched = app.router.match(ROWS[key].method, ROWS[key].path)[0].map(([[, r]]) => r as unknown as { method: string; path: string });
      expect(matched.filter((r) => !(r.method === "ALL" && r.path === "/*")).map((r) => `${r.method} ${r.path}`), key).toEqual([key]);
    }
    // The rules the plan gives each group of routes.
    expect(HOST_RULES["GET /healthz"]).toBe("any");
    for (const key of API_KEYS) expect(HOST_RULES[key], key).toBe("both");
    for (const key of [...WIZARD_KEYS, PLAYER_KEY]) expect(HOST_RULES[key], key).toBe("tours");
    for (const key of ["GET /t/:slug", "GET /p/:name"]) expect(HOST_RULES[key], key).toBe("tours-redirect");
    for (const key of DESCRIPTION_KEYS) expect(HOST_RULES[key], key).toBe("both");
    expect(HOST_RULES[DOCS_PAGE_KEY]).toBe("app-redirect");
    for (const key of DOCS_FILE_KEYS) expect(HOST_RULES[key], key).toBe("app");
    for (const key of SESSION_KEYS) expect(HOST_RULES[key], key).toBe("app");
    for (const key of ADMIN_KEYS) expect(HOST_RULES[key], key).toBe("app");
    expect(SESSION_KEYS.length).toBe(7);
    expect(ADMIN_KEYS.length).toBe(2);
    expect(DESCRIPTION_KEYS.length).toBe(2);
    expect(DOCS_FILE_KEYS.length).toBe(2);
    expect(API_KEYS.length).toBe(14);
    expect(WIZARD_KEYS.length).toBe(5);
  });

  it("one-address mode answers every route on any host as before", async () => {
    const { deps } = await oneAddress();
    for (const origin of [OTHER, TOURS, APP, UNKNOWN, "http://localhost:8787"]) {
      const answers = await column(deps, origin);
      expect(statuses(answers), origin).toEqual(expected("one"));
      for (const key of API_KEYS) expect(answers[key].json.error, key).toBe("unauthorized");
      for (const key of ADMIN_KEYS) expect(answers[key].text, key).toBe(NOT_FOUND);
      expect(answers["GET /healthz"].text).toBe('{"ok":true}');
      expect(answers["GET /setup"].headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(answers["POST /setup/claim"].text).toBe('{"error":"bad_workspace"}');
      expect(answers["GET /t/:slug"].headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(answers["GET /p/:name"].text).toBe(NOT_FOUND);
      expect(answers["GET /p/:name"].headers.get("content-type")).toBe("application/json");
      expect(answers[PLAYER_KEY].headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      for (const key of KEYS) expect(answers[key].headers.get("location"), key).toBeNull();
    }
    expect(await count(deps, "workspace")).toBe(0);
  });

  it("the tours address answers every route but the documentation page, its files and the session's routes", async () => {
    const { deps } = await twoAddress();
    const answers = await column(deps, TOURS);
    expect(statuses(answers)).toEqual(expected("tours"));
    // As in one-address mode, except for the documentation page, which lives on the app address.
    const onApp = [DOCS_PAGE_KEY, ...DOCS_FILE_KEYS, ...SESSION_KEYS, ...ADMIN_KEYS];
    const without = (col: Record<string, number>) => Object.fromEntries(Object.entries(col).filter(([k]) => !onApp.includes(k)));
    expect(without(expected("tours"))).toEqual(without(expected("one")));
    expect(answers[DOCS_PAGE_KEY].headers.get("location")).toBe(APP + "/docs");
    for (const key of [...DOCS_FILE_KEYS, ...SESSION_KEYS, ...ADMIN_KEYS]) expectNotHere(answers[key], key);
    for (const key of DESCRIPTION_KEYS) expect(answers[key].status, key).toBe(200);
    for (const key of API_KEYS) expect(answers[key].json.error, key).toBe("unauthorized");
    expect(answers["GET /setup"].headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answers["POST /setup/claim"].text).toBe('{"error":"bad_workspace"}');
    expect(answers["GET /t/:slug"].headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answers["GET /p/:name"].text).toBe(NOT_FOUND);
    expect(answers[PLAYER_KEY].headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // The tours address redirects nothing else.
    for (const key of KEYS) if (key !== DOCS_PAGE_KEY) expect(answers[key].headers.get("location"), key).toBeNull();
  });

  it("the app address answers the token API and health, redirects tour pages and pictures, and has no wizard and no player files", async () => {
    const { deps } = await twoAddress();
    const answers = await column(deps, APP);
    expect(statuses(answers)).toEqual(expected("app"));
    for (const key of API_KEYS) {
      expect(answers[key].status, key).toBe(401);
      expect(answers[key].json.error, key).toBe("unauthorized");
    }
    expect(answers["GET /healthz"].status).toBe(200);
    for (const key of ADMIN_KEYS) expect([answers[key].status, answers[key].text], key).toEqual([404, NOT_FOUND]);
    for (const key of ["GET /t/:slug", "GET /p/:name"]) expectRedirect(answers[key], TOURS + ROWS[key].path, key);
    for (const key of [...WIZARD_KEYS, PLAYER_KEY]) expectNotHere(answers[key], key);
    // The documentation page, its files and the description answer here, and none of them redirects.
    for (const key of [DOCS_PAGE_KEY, ...DOCS_FILE_KEYS, ...DESCRIPTION_KEYS]) {
      expect(answers[key].status, key).toBe(200);
      expect(answers[key].headers.get("location"), key).toBeNull();
    }
    expect(await count(deps, "workspace")).toBe(0);
  });

  it("an unknown host gets an empty 421 on every route but health, and costs no database or storage call", async () => {
    const { deps, calls } = await twoAddress();
    const before = calls();
    const answers = await column(deps, UNKNOWN);
    expect(statuses(answers)).toEqual(expected("unknown"));
    for (const key of KEYS) {
      if (key === "GET /healthz") continue;
      expectMisdirected(answers[key], key);
    }
    expect(answers["GET /healthz"].text).toBe('{"ok":true}');
    // Health asked the database once; nothing else asked anything.
    expect(calls() - before).toBe(answers["GET /healthz"].calls);
    expect(answers["GET /healthz"].calls).toBe(1);
    // Other unknown hosts: a look-alike, another port, an address, another scheme.
    for (const origin of ["https://tours.example.com.evil.example.net", "https://xtours.example.com", "https://tours.example.com:8443", "http://127.0.0.1:3000", "http://[::1]:3000", "https://example.com"]) {
      for (const key of ["GET /t/:slug", "GET /api/v1/me", "GET /setup", PLAYER_KEY]) expectMisdirected(await sendRow(deps, ROWS[key], origin), `${origin} ${key}`);
    }
    // The configured names still match in capitals, with a trailing dot and with a default port.
    for (const origin of ["https://TOURS.Example.com", "https://tours.example.com.", "https://tours.example.com:443", "http://tours.example.com:80", "http://tours.example.com"]) {
      expect((await send(deps, "GET", "/healthz", { origin })).text, origin).toBe('{"ok":true,"address":"tours"}');
    }
  });

  it("an unknown path is 404 on a configured host and 421 on an unknown one", async () => {
    const { deps } = await twoAddress();
    const paths: [string, string][] = [
      ["GET", "/"],
      ["GET", "/nope"],
      ["GET", "/api/v1/nope"],
      ["GET", "/t"],
      ["GET", "/t/a/b"],
      ["GET", "/player.png"],
      ["POST", "/healthz"],
      ["POST", "/t/abc"],
      ["DELETE", "/setup"],
      ["GET", "//evil.example.net/t/abc"],
    ];
    for (const [method, path] of paths) {
      for (const origin of [TOURS, APP]) {
        const r = await send(deps, method, path, { origin });
        expect(r.status, `${origin} ${method} ${path}`).toBe(404);
        expect(r.text, `${origin} ${method} ${path}`).toBe(NOT_FOUND);
        expect(r.headers.get("location")).toBeNull();
        expect(r.calls).toBe(0);
      }
      expectMisdirected(await send(deps, method, path, { origin: UNKNOWN }), `${method} ${path}`);
    }
    // In one-address mode an unknown path is the same 404 on any host.
    const one = await oneAddress();
    for (const [method, path] of paths) {
      const r = await send(one.deps, method, path, { origin: UNKNOWN });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.text, `${method} ${path}`).toBe(NOT_FOUND);
    }
  });

  it("no answer on any host sets a cookie or a cross-origin header", async () => {
    const one = await oneAddress();
    const two = await twoAddress();
    const all: [string, Record<string, Call>][] = [
      ["one address", await column(one.deps, OTHER)],
      ["tours", await column(two.deps, TOURS)],
      ["app", await column(two.deps, APP)],
      ["unknown", await column(two.deps, UNKNOWN)],
    ];
    let seen = 0;
    for (const [name, answers] of all) {
      for (const key of KEYS) {
        const h = answers[key].headers;
        expect(h.get("set-cookie"), `${name} ${key}`).toBeNull();
        expect(h.getSetCookie(), `${name} ${key}`).toEqual([]);
        for (const [header] of h) expect(header.startsWith("access-control-"), `${name} ${key} ${header}`).toBe(false);
        seen++;
      }
    }
    expect(seen).toBe(4 * KEYS.length);
  });
});

describe("two addresses", () => {
  it("the redirect keeps the path and query and names only the configured tours host", async () => {
    const { deps } = await twoAddress();
    expectRedirect(await send(deps, "GET", "/t/abc?x=1", { origin: APP }), "https://tours.example.com/t/abc?x=1");
    expectRedirect(await send(deps, "GET", "/t/abc", { origin: APP }), "https://tours.example.com/t/abc");
    expectRedirect(await send(deps, "GET", "/t/abc?", { origin: APP }), "https://tours.example.com/t/abc");
    expectRedirect(await send(deps, "GET", "/p/x.png?a=1&b=%2F%2Fevil.example.net", { origin: APP }), "https://tours.example.com/p/x.png?a=1&b=%2F%2Fevil.example.net");
    // Whatever the path holds, the address before it is the configured one.
    for (const path of ["/t/%2F%2Fevil.example.net", "/t/@evil.example.net", "/t/evil.example.net%0d%0aset-cookie:a=b", "/t/x?next=https://evil.example.net/"]) {
      const r = await send(deps, "GET", path, { origin: APP });
      expect(r.status, path).toBe(308);
      const location = r.headers.get("location")!;
      expect(location.startsWith("https://tours.example.com/t/"), path).toBe(true);
      expect(new URL(location).host, path).toBe("tours.example.com");
      expect(r.headers.get("set-cookie"), path).toBeNull();
    }
    // The app address on another scheme or with a default port is still the app address.
    expectRedirect(await send(deps, "GET", "/t/abc?x=1", { origin: "http://APP.example.com:80" }), "https://tours.example.com/t/abc?x=1");

    // A local pair keeps its port and uses http.
    const local = await twoAddress({ hosts: { tours: "tours.localhost:8787", app: "app.localhost:8787" } });
    expectRedirect(await send(local.deps, "GET", "/t/abc?x=1", { origin: "http://app.localhost:8787" }), "http://tours.localhost:8787/t/abc?x=1");
    expectMisdirected(await send(local.deps, "GET", "/t/abc?x=1", { origin: "http://app.localhost:8788" }), "another port");
    expectMisdirected(await send(local.deps, "GET", "/t/abc?x=1", { origin: "http://app.localhost" }), "no port");
  });

  it("following the redirect ends on the tours address without another redirect", async () => {
    const { deps } = await twoAddress({ retiredGraceMs: 0 });
    const a = await seedWorkspace(deps, "Acme");
    const tour = await uploadTour(deps, a.token, fixtures.v3 as Json);
    const published = await publishAt(deps, a.token, tour.tour_id, TOURS);
    expect(published.status).toBe(200);
    const first = await send(deps, "GET", `/t/${published.json.slug}?from=app`, { origin: APP });
    expect(first.status).toBe(308);
    const next = new URL(first.headers.get("location")!);
    expect(next.origin).toBe(TOURS);
    const second = await send(deps, "GET", next.pathname + next.search, { origin: next.origin });
    expect(second.status).toBe(200);
    expect(second.headers.get("location")).toBeNull();
    expect(second.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(second.text).toContain("<!doctype html>");
  });

  it("a forged forwarded host changes nothing", async () => {
    const { deps } = await twoAddress();
    const forged: Record<string, string>[] = [
      { "x-forwarded-host": "tours.example.com" },
      { forwarded: "host=tours.example.com;proto=https" },
      { "x-original-host": "tours.example.com" },
      { "x-forwarded-host": "tours.example.com", forwarded: 'for=192.0.2.1;host="tours.example.com"', "x-original-host": "tours.example.com", "x-forwarded-server": "tours.example.com", "x-host": "tours.example.com" },
    ];
    for (const headers of forged) {
      const what = Object.keys(headers).join(",");
      // An unknown host stays unknown.
      for (const path of ["/t/x", "/setup", "/api/v1/me", "/player.js", "/nope"]) expectMisdirected(await send(deps, "GET", path, { origin: UNKNOWN, headers }), `${what} ${path}`);
      expect((await send(deps, "GET", "/healthz", { origin: UNKNOWN, headers })).text, what).toBe('{"ok":true}');
      // The app address stays the app address: a redirect, not the page, and no wizard.
      expectRedirect(await send(deps, "GET", "/t/x", { origin: APP, headers }), "https://tours.example.com/t/x", what);
      expectNotHere(await send(deps, "GET", "/setup", { origin: APP, headers }), what);
      expectNotHere(await send(deps, "GET", "/player.js", { origin: APP, headers }), what);
      expect((await send(deps, "GET", "/healthz", { origin: APP, headers })).text, what).toBe('{"ok":true,"address":"app"}');
    }
    // A forged header never ends up in the redirect either.
    const r = await send(deps, "GET", "/t/x", { origin: APP, headers: { "x-forwarded-host": "evil.example.net", forwarded: "host=evil.example.net", "x-original-host": "evil.example.net" } });
    expectRedirect(r, "https://tours.example.com/t/x");
  });

  it("a published picture is never served from the app address", async () => {
    const { deps, publicKeys } = await twoAddress({ retiredGraceMs: 0 });
    const a = await seedWorkspace(deps, "Acme");
    const tour = await uploadTour(deps, a.token, fixtures.v2 as Json);
    expect((await publishAt(deps, a.token, tour.tour_id, TOURS)).status).toBe(200);
    const key = (await publicKeys()).find((k) => /^p\/[0-9a-f]{32}\.(png|jpg)$/.test(k))!;
    expect(key).toBeDefined();
    const onTours = await send(deps, "GET", "/" + key, { origin: TOURS });
    expect(onTours.status).toBe(200);
    expect(onTours.headers.get("content-type")).toMatch(/^image\/(png|jpeg)$/);
    expect(onTours.bytes.length).toBeGreaterThan(0);
    for (const method of ["GET", "HEAD"]) {
      const onApp = await send(deps, method, "/" + key, { origin: APP });
      expectRedirect(onApp, `https://tours.example.com/${key}`, method);
      expect(onApp.headers.get("content-length") ?? "0", method).toBe("0");
      expect(onApp.headers.get("etag"), method).toBeNull();
    }
    expectMisdirected(await send(deps, "GET", "/" + key, { origin: UNKNOWN }), "unknown host");
  });

  it("the token API works with a real token on both addresses and gives the same list", async () => {
    const { deps } = await twoAddress({ retiredGraceMs: 0 });
    const a = await seedWorkspace(deps, "Acme");
    const tour = await uploadTour(deps, a.token, fixtures.v2 as Json);
    const onTours = await send(deps, "GET", "/api/v1/tours", { token: a.token, origin: TOURS });
    const onApp = await send(deps, "GET", "/api/v1/tours", { token: a.token, origin: APP });
    expect(onTours.status).toBe(200);
    expect(onApp.status).toBe(200);
    expect(onApp.text).toBe(onTours.text);
    expect(onTours.json.tours.map((t: Json) => t.id)).toEqual([tour.tour_id]);
    expect(onApp.headers.get("content-type")).toBe(onTours.headers.get("content-type"));
    // A change made through one address shows on the other.
    const renamed = await send(deps, "PATCH", `/api/v1/tours/${tour.tour_id}`, { token: a.token, origin: APP, body: JSON.stringify({ title: "Renamed" }), headers: { "content-type": "application/json" } });
    expect(renamed.status).toBe(200);
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token, origin: TOURS })).json.tours[0].title).toBe("Renamed");
    // The token is still not enough on an unknown host.
    expectMisdirected(await send(deps, "GET", "/api/v1/tours", { token: a.token, origin: UNKNOWN }), "unknown host with a token");
  });

  it("health reports the role only to a configured host", async () => {
    const { deps } = await twoAddress();
    const tours = await send(deps, "GET", "/healthz", { origin: TOURS });
    const app = await send(deps, "GET", "/healthz", { origin: APP });
    const unknown = await send(deps, "GET", "/healthz", { origin: UNKNOWN });
    expect(tours.text).toBe('{"ok":true,"address":"tours"}');
    expect(app.text).toBe('{"ok":true,"address":"app"}');
    expect(unknown.text).toBe('{"ok":true}');
    // The container's own check asks an internal name.
    expect((await send(deps, "GET", "/healthz", { origin: "http://127.0.0.1:3000" })).text).toBe('{"ok":true}');
    for (const r of [tours, app, unknown]) {
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(r.calls).toBe(1);
    }
    // One-address mode reports no role, on the same names too.
    const one = await oneAddress();
    for (const origin of [TOURS, APP, UNKNOWN]) {
      const r = await send(one.deps, "GET", "/healthz", { origin });
      expect(r.text, origin).toBe('{"ok":true}');
      expect(r.headers.get("content-type"), origin).toBe(unknown.headers.get("content-type"));
      expect([...r.headers.keys()].sort(), origin).toEqual([...unknown.headers.keys()].sort());
    }
  });

  it("me lists both addresses in two-address mode and is unchanged in one-address mode", async () => {
    const two = await twoAddress({ hosts: { tours: "tours.example.com", app: "app.example.com:8443" } });
    const a = await seedWorkspace(two.deps, "Acme");
    const want = `{"workspace":"Acme","version":"${VERSION}","addresses":{"tours":"tours.example.com","app":"app.example.com:8443"}}`;
    expect((await send(two.deps, "GET", "/api/v1/me", { token: a.token, origin: TOURS })).text).toBe(want);
    expect((await send(two.deps, "GET", "/api/v1/me", { token: a.token, origin: "https://app.example.com:8443" })).text).toBe(want);
    const anon = await send(two.deps, "GET", "/api/v1/me", { origin: TOURS });
    expect(anon.status).toBe(401);
    expect(anon.text).not.toContain("addresses");
    expect(anon.text).not.toContain("example.com");

    const plain = await twoAddress();
    const p = await seedWorkspace(plain.deps, "Acme");
    expect((await send(plain.deps, "GET", "/api/v1/me", { token: p.token, origin: APP })).text).toBe(
      `{"workspace":"Acme","version":"${VERSION}","addresses":{"tours":"tours.example.com","app":"app.example.com"}}`,
    );

    for (const config of [{}, { hosts: null }]) {
      const one = await oneAddress(config);
      const b = await seedWorkspace(one.deps, "Acme");
      for (const origin of [TOURS, OTHER]) {
        const r = await send(one.deps, "GET", "/api/v1/me", { token: b.token, origin });
        expect(r.status).toBe(200);
        expect(r.text, origin).toBe(`{"workspace":"Acme","version":"${VERSION}"}`);
      }
    }
  });

  it("the tour list and the publish answer still give the link as a path on both addresses", async () => {
    const { deps } = await twoAddress({ retiredGraceMs: 0 });
    const a = await seedWorkspace(deps, "Acme");
    const first = await uploadTour(deps, a.token, fixtures.v2 as Json);
    const second = await uploadTour(deps, a.token, fixtures.v3 as Json);
    const onTours = await publishAt(deps, a.token, first.tour_id, TOURS);
    const onApp = await publishAt(deps, a.token, second.tour_id, APP);
    for (const r of [onTours, onApp]) {
      expect(r.status).toBe(200);
      expect(r.json.url).toBe(`/t/${r.json.slug}`);
      expect(r.text).not.toContain("example.com");
    }
    for (const origin of [TOURS, APP]) {
      const list = await send(deps, "GET", "/api/v1/tours", { token: a.token, origin });
      expect(list.status).toBe(200);
      expect(list.json.tours.length).toBe(2);
      for (const t of list.json.tours) expect(t.url, origin).toBe(`/t/${t.slug}`);
      expect(list.text, origin).not.toContain("example.com");
    }
  });

  it("the wizard claims on the tours address in two-address mode and is 404 on the app address even with the right code", async () => {
    const { deps } = await twoAddress();
    const claim = (origin: string, from = origin) =>
      send(deps, "POST", "/setup/claim", {
        origin,
        body: JSON.stringify({ code: CODE, workspace: "Acme Tours", email: "owner@example.com" }),
        headers: { "content-type": "application/json", origin: from },
      });
    // The app address has no wizard: not with its own page's origin, not with the tours one.
    for (const from of [APP, TOURS]) expectNotHere(await claim(APP, from), `claim on the app address from ${from}`);
    expectNotHere(await send(deps, "POST", "/setup/check", { origin: APP, body: JSON.stringify({ code: CODE }), headers: { "content-type": "application/json", origin: APP } }), "check on the app address");
    expect(await count(deps, "workspace")).toBe(0);
    expect(await count(deps, "setup")).toBe(0);
    // The tours address still refuses another site's page, and takes its own.
    const cross = await claim(TOURS, APP);
    expect(cross.status).toBe(403);
    expect(cross.text).toBe('{"error":"cross_origin"}');
    expect(await count(deps, "workspace")).toBe(0);
    const claimed = await claim(TOURS);
    expect(claimed.status).toBe(201);
    expect(claimed.json.workspace).toBe("Acme Tours");
    expect(await count(deps, "workspace")).toBe(1);
    // The token it gave works on both addresses.
    for (const origin of [TOURS, APP]) expect((await send(deps, "GET", "/api/v1/me", { token: claimed.json.token, origin })).status, origin).toBe(200);
  });

  it("HEAD follows the same rule as GET", async () => {
    const { deps } = await twoAddress();
    expectRedirect(await send(deps, "HEAD", "/t/abc?x=1", { origin: APP }), "https://tours.example.com/t/abc?x=1");
    expectMisdirected(await send(deps, "HEAD", "/t/abc", { origin: UNKNOWN }), "HEAD on an unknown host");
    const onTours = await send(deps, "HEAD", "/t/abc", { origin: TOURS });
    expect(onTours.status).toBe(404);
    expect(onTours.headers.get("location")).toBeNull();
    const notHere = await send(deps, "HEAD", "/setup", { origin: APP });
    expect(notHere.status).toBe(404);
    expect(notHere.bytes.length).toBe(0);
    expect(notHere.calls).toBe(0);
    expect((await send(deps, "HEAD", "/healthz", { origin: UNKNOWN })).status).toBe(200);
  });
});

describe("the rule lookup", () => {
  const config = { publicImageBase: "", setupCode: null, hosts: HOSTS };
  type Route = [method: "get" | "all", path: string, name: string];

  /** A small app behind the gate: each route answers 200 with its own name. */
  function tiny(routes: Route[], rules: Record<string, HostRule>, hosts: Hosts | null = HOSTS): Hono {
    const app = new Hono();
    app.use("*", hostGate({ ...config, hosts }, rules));
    for (const [method, path, name] of routes) app[method](path, (c) => c.text(name));
    app.notFound((c) => c.json({ error: "not_found" }, 404));
    return app;
  }

  async function ask(app: Hono, origin: string, path: string, method = "GET"): Promise<{ status: number; text: string; location: string | null }> {
    const res = await app.fetch(new Request(origin + path, { method }));
    return { status: res.status, text: await res.text(), location: res.headers.get("location") };
  }

  const narrow: Route = ["get", "/setup", "narrow"];
  const wide: Route = ["get", "/:page", "wide"];
  const orders: [string, Route[]][] = [
    ["narrow first", [narrow, wide]],
    ["wide first", [wide, narrow]],
  ];

  it("two routes that match one request get the strictest of their rules, in either order", async () => {
    const cases: [HostRule, HostRule, { tours: number; app: number; unknown: number }][] = [
      ["tours", "both", { tours: 200, app: 404, unknown: 421 }],
      ["both", "tours", { tours: 200, app: 404, unknown: 421 }],
      ["tours-redirect", "both", { tours: 200, app: 308, unknown: 421 }],
      ["tours", "tours-redirect", { tours: 200, app: 404, unknown: 421 }],
      ["tours", "any", { tours: 200, app: 404, unknown: 421 }],
      ["both", "any", { tours: 200, app: 200, unknown: 421 }],
      ["tours-redirect", "any", { tours: 200, app: 308, unknown: 421 }],
      ["any", "any", { tours: 200, app: 200, unknown: 200 }],
      ["both", "both", { tours: 200, app: 200, unknown: 421 }],
    ];
    for (const [name, routes] of orders) {
      for (const [narrowRule, wideRule, want] of cases) {
        const app = tiny(routes, { "GET /setup": narrowRule, "GET /:page": wideRule });
        const what = `${name}: ${narrowRule} + ${wideRule}`;
        const onApp = await ask(app, APP, "/setup?x=1");
        expect((await ask(app, TOURS, "/setup")).status, what).toBe(want.tours);
        expect(onApp.status, what).toBe(want.app);
        expect((await ask(app, UNKNOWN, "/setup")).status, what).toBe(want.unknown);
        if (want.app === 404) expect(onApp.text, what).toBe(NOT_FOUND);
        if (want.app === 308) expect(onApp.location, what).toBe("https://tours.example.com/setup?x=1");
        // A request only the wide route matches keeps the wide route's own rule.
        const alone = { any: 200, both: 200, tours: 404, "tours-redirect": 308, app: 200, "app-redirect": 200 }[wideRule];
        expect((await ask(app, APP, "/other")).status, what).toBe(alone);
      }
    }
  });

  it("the app rules mirror the tours rules, and the strictest of two still wins", async () => {
    const cases: [HostRule, HostRule, { tours: number; app: number; unknown: number }][] = [
      ["app", "both", { tours: 404, app: 200, unknown: 421 }],
      ["both", "app", { tours: 404, app: 200, unknown: 421 }],
      ["app-redirect", "both", { tours: 308, app: 200, unknown: 421 }],
      ["app", "app-redirect", { tours: 404, app: 200, unknown: 421 }],
      ["app-redirect", "app", { tours: 404, app: 200, unknown: 421 }],
      ["app", "any", { tours: 404, app: 200, unknown: 421 }],
      ["app-redirect", "any", { tours: 308, app: 200, unknown: 421 }],
      ["app-redirect", "app-redirect", { tours: 308, app: 200, unknown: 421 }],
    ];
    for (const [name, routes] of orders) {
      for (const [narrowRule, wideRule, want] of cases) {
        const app = tiny(routes, { "GET /setup": narrowRule, "GET /:page": wideRule });
        const what = `${name}: ${narrowRule} + ${wideRule}`;
        const onTours = await ask(app, TOURS, "/setup?x=1");
        expect(onTours.status, what).toBe(want.tours);
        expect((await ask(app, APP, "/setup")).status, what).toBe(want.app);
        expect((await ask(app, UNKNOWN, "/setup")).status, what).toBe(want.unknown);
        if (want.tours === 404) expect(onTours.text, what).toBe(NOT_FOUND);
        if (want.tours === 308) expect(onTours.location, what).toBe("https://app.example.com/setup?x=1");
        // A request only the wide route matches keeps the wide route's own rule.
        const alone = { any: 200, both: 200, app: 404, "app-redirect": 308, tours: 200, "tours-redirect": 200 }[wideRule];
        expect((await ask(app, TOURS, "/other")).status, what).toBe(alone);
      }
    }
  });

  it("two matched routes whose rules name different addresses are closed on both", async () => {
    const tours: HostRule[] = ["tours", "tours-redirect"];
    const apps: HostRule[] = ["app", "app-redirect"];
    const aloneOnTours: Record<HostRule, number> = { any: 200, both: 200, tours: 200, "tours-redirect": 200, app: 404, "app-redirect": 308 };
    for (const [name, routes] of orders) {
      for (const a of tours) {
        for (const b of apps) {
          for (const [narrowRule, wideRule] of [[a, b], [b, a]]) {
            const app = tiny(routes, { "GET /setup": narrowRule, "GET /:page": wideRule });
            const what = `${name}: ${narrowRule} + ${wideRule}`;
            for (const origin of [TOURS, APP]) {
              const r = await ask(app, origin, "/setup");
              // Neither a page nor a redirect: no address may answer for both rules.
              expect(r.status, `${what} ${origin}`).toBe(404);
              expect(r.text, `${what} ${origin}`).toBe(NOT_FOUND);
              expect(r.location, `${what} ${origin}`).toBeNull();
            }
            expect((await ask(app, UNKNOWN, "/setup")).status, what).toBe(421);
            // A request only one of them matches keeps that route's own rule.
            expect((await ask(app, TOURS, "/other")).status, what).toBe(aloneOnTours[wideRule]);
          }
        }
      }
    }
  });

  it("a matched route without a rule closes the request, whichever route would have answered", async () => {
    for (const [name, routes] of orders) {
      for (const rules of [{ "GET /setup": "both" }, { "GET /:page": "both" }, { "GET /setup": "any" }, { "GET /:page": "any" }, {}] as Record<string, HostRule>[]) {
        const app = tiny(routes, rules);
        const what = `${name}: ${JSON.stringify(rules)}`;
        for (const origin of [TOURS, APP]) {
          const r = await ask(app, origin, "/setup");
          expect(r.status, `${what} ${origin}`).toBe(404);
          expect(r.text, `${what} ${origin}`).toBe(NOT_FOUND);
        }
        const unknown = await ask(app, UNKNOWN, "/setup");
        expect(unknown.status, what).toBe(421);
        expect(unknown.text, what).toBe("");
      }
    }
  });

  it("a handler for every method needs its own rule and is not taken for the gate", async () => {
    const secret: Route = ["all", "/secret", "secret"];
    for (const routes of [[secret], [secret, wide], [wide, secret], [["all", "*", "secret"]], [["all", "/*", "secret"]]] as Route[][]) {
      const app = tiny(routes, { "GET /:page": "both" });
      for (const method of ["GET", "POST", "HEAD"]) {
        for (const origin of [TOURS, APP]) expect((await ask(app, origin, "/secret", method)).status, `${JSON.stringify(routes)} ${method} ${origin}`).toBe(404);
        expect((await ask(app, UNKNOWN, "/secret", method)).status, `${JSON.stringify(routes)} ${method}`).toBe(421);
      }
    }
    // With a rule under "ALL <path>" it answers where the rule says.
    const ruled = tiny([secret], { "ALL /secret": "tours" });
    expect((await ask(ruled, TOURS, "/secret", "POST")).text).toBe("secret");
    expect((await ask(ruled, APP, "/secret", "POST")).status).toBe(404);
    expect((await ask(ruled, UNKNOWN, "/secret", "POST")).status).toBe(421);

    // A mounted app is such a handler too.
    const mounted = new Hono();
    mounted.use("*", hostGate(config, {}));
    mounted.mount("/m", () => new Response("mounted"));
    mounted.notFound((c) => c.json({ error: "not_found" }, 404));
    for (const origin of [TOURS, APP]) expect((await ask(mounted, origin, "/m/x")).status, origin).toBe(404);
    expect((await ask(mounted, UNKNOWN, "/m/x")).status).toBe(421);
  });

  it("one-address mode asks for no rule at all", async () => {
    const app = tiny([narrow, wide, ["all", "/secret", "secret"]], {}, null);
    expect((await ask(app, UNKNOWN, "/setup")).text).toBe("narrow");
    expect((await ask(app, UNKNOWN, "/other")).text).toBe("wide");
    expect((await ask(app, UNKNOWN, "/secret", "POST")).text).toBe("secret");
  });
});
