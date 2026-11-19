// The cross-workspace suite: no workspace reaches another's data by any key. It builds
// two workspaces that each hold one of everything (test/isolation-world.ts), then signs in
// as one and tries to read, change and delete the other's data on every route, on both
// targets. An attempt fails the build when it gets anything but the route's own answer for
// an id that never existed (status, body and headers, byte for byte), when a row of any
// table changed, or when anything was written to or deleted from either store.
//
// Every route of the app is in exactly one of four tables, keyed "<METHOD> <route path>"
// exactly as in `createApp(deps).routes`:
// - CASES: routes with an id in the path. Each lists the requests in which one workspace
//   names the other's ids, with the exact answer.
// - BODY_IDS: routes with no id in the path whose body carries one. The same kind of list.
// - LISTS: routes that answer a collection or a summary of the caller's own workspace.
// - OPEN: routes with no owner at all, each with its reason.
// A route in none of them, or in two, fails the first test below; so does a table key no
// route has. The route list is the router's own, as in test/openapi.test.ts, so the
// tables cannot drift from the app.
//
// A request names a foreign id in one of two places. In the path: that is what CASES is
// for. In the body: the request says which field with `field`, and every body field of the
// API description whose name ends in `_id` must have such a request. A route with both (a
// path id and a body id) is in CASES and marks its body requests the same way.
//
// How a later task adds to this file:
// - A new route: add its key to one table. With an id in the path it goes in CASES with
//   one request per foreign id it can be given; add what the requests need to `Ids` and to
//   `inventedIds` in test/isolation-world.ts.
// - Sessions (Task 10): add `session` to `Side` in the world, and a second entry to
//   CREDENTIALS below. Every test that sends a case sends it once per credential.
// - Admin routes (Task 12): a fifth table, ADMIN, added to TABLES.
import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { createApp } from "../src/app.ts";
import { hashToken, newToken } from "../src/auth.ts";
import { openapi, type OpenApiDoc } from "../src/docs/openapi.ts";
import type { Hosts } from "../src/hosts.ts";
import type { Deps } from "../src/ports.ts";
import { UPLOAD_MAX_AGE_MS } from "../src/uploads.ts";
import { commit, logoPng, putStep, send, stepImage, type Call, type Json } from "./bundle.ts";
import { OWNED, SHARED, createReplace, dumpOf, inventedIds, manifestOf, namesIn, needlesOf, snapshotOf, tablesOf, world, type Ids, type Side, type World } from "./isolation-world.ts";

const SLOW = { timeout: 120_000 };
const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const SETUP_CODE = "correct-horse-battery-staple";

// ---- The answers ----

type Expect = { status: number; body: Json | null };
const notFound = (what: string): Expect => ({ status: 404, body: { error: "not_found", detail: `no such ${what}` } });
const NO_TOUR = notFound("tour");
const NO_CHAPTER = notFound("chapter");
const NO_STEP = notFound("step");
const NO_UPLOAD = notFound("upload");
/** Aborting an upload answers 204 whatever the id: there is nothing to tell apart. */
const NOTHING: Expect = { status: 204, body: null };
/** A publish id the tour does not have: the publish it names was stopped, or never was. */
const NO_PUBLISH: Expect = {
  status: 409,
  body: { error: "publish_cancelled", detail: "this publish was stopped before it finished (the tour was unpublished, or the publish failed or was abandoned); publish again to start over" },
};

// ---- The tables ----

/** One request in which the caller names an id that is not its own. */
type Req = {
  what: string;
  method: string;
  path: string;
  json?: unknown;
  bytes?: Uint8Array;
  /** The body field that carries the foreign id, when it is not in the path. */
  field?: string;
  expect: Expect;
};

/** The requests of one route: `theirs` are the other workspace's ids (or ids that never existed), `mine` the caller's own. */
type Entry = (theirs: Ids, mine: Ids) => Req[];

const tourPath = (id: string, rest = "") => `/api/v1/tours/${id}${rest}`;
const uploadPath = (id: string, rest = "") => `/api/v1/uploads/${id}${rest}`;
/** Each of the other workspace's tours, in every state a tour can be in. */
const theirTours = (t: Ids): [string, string][] => [
  ["their published tour", t.published.tour],
  ["their draft tour", t.draft.tour],
  ["their tour with a publish in progress", t.publishing.tour],
  ["their half-deleted tour", t.deleting.tour],
];

const CASES: Record<string, Entry> = {
  "PUT /api/v1/uploads/:id/steps/:n": (t) => [
    { what: "the step their open upload still waits for, with a picture it would accept", method: "PUT", path: uploadPath(t.upload, "/steps/2"), bytes: stepImage(t.pictures.upload[1], t.fill), expect: NO_UPLOAD },
    { what: "a step their open upload already has", method: "PUT", path: uploadPath(t.upload, "/steps/1"), bytes: stepImage(t.pictures.upload[0], t.fill), expect: NO_UPLOAD },
    { what: "a step number their open upload does not have", method: "PUT", path: uploadPath(t.upload, "/steps/999"), bytes: stepImage(t.pictures.upload[0], t.fill), expect: NO_UPLOAD },
    { what: "the step their open replace still waits for", method: "PUT", path: uploadPath(t.replaceUpload, "/steps/2"), bytes: stepImage(t.pictures.replaceUpload[1], t.fill), expect: NO_UPLOAD },
    { what: "the step their open replace reuses", method: "PUT", path: uploadPath(t.replaceUpload, "/steps/1"), bytes: stepImage(t.pictures.replaceUpload[0], t.fill), expect: NO_UPLOAD },
    { what: "a step of their committed upload", method: "PUT", path: uploadPath(t.draft.committedUpload, "/steps/1"), bytes: stepImage(t.pictures.draft[0], t.fill), expect: NO_UPLOAD },
  ],
  "PUT /api/v1/uploads/:id/logo": (t) => [
    { what: "the logo their open upload still waits for", method: "PUT", path: uploadPath(t.upload, "/logo"), bytes: logoPng(), expect: NO_UPLOAD },
    { what: "a logo for their open replace, which takes none", method: "PUT", path: uploadPath(t.replaceUpload, "/logo"), bytes: logoPng(), expect: NO_UPLOAD },
  ],
  "POST /api/v1/uploads/:id/commit": (t) => [
    { what: "their open upload", method: "POST", path: uploadPath(t.upload, "/commit"), expect: NO_UPLOAD },
    { what: "their open replace", method: "POST", path: uploadPath(t.replaceUpload, "/commit"), expect: NO_UPLOAD },
    { what: "their committed upload, whose commit answers its owner again", method: "POST", path: uploadPath(t.draft.committedUpload, "/commit"), expect: NO_UPLOAD },
    { what: "their committed replace, whose commit answers its owner again", method: "POST", path: uploadPath(t.draft.committedReplace, "/commit"), expect: NO_UPLOAD },
  ],
  "DELETE /api/v1/uploads/:id": (t) => [
    { what: "their open upload", method: "DELETE", path: uploadPath(t.upload), expect: NOTHING },
    { what: "their open replace", method: "DELETE", path: uploadPath(t.replaceUpload), expect: NOTHING },
  ],
  "PATCH /api/v1/tours/:id": (t) => theirTours(t).map(([what, id]) => ({ what, method: "PATCH", path: tourPath(id), json: { title: "Taken over" }, expect: NO_TOUR })),
  "DELETE /api/v1/tours/:id": (t) => theirTours(t).map(([what, id]) => ({ what, method: "DELETE", path: tourPath(id), expect: NO_TOUR })),
  "GET /api/v1/tours/:id/steps/:step_id/image": (t, m) => [
    { what: "a picture of their draft tour", method: "GET", path: tourPath(t.draft.tour, `/steps/${t.draft.step}/image`), expect: NO_STEP },
    { what: "a picture of their published tour", method: "GET", path: tourPath(t.published.tour, `/steps/${t.published.step}/image`), expect: NO_STEP },
    { what: "a picture of their tour with a publish in progress", method: "GET", path: tourPath(t.publishing.tour, `/steps/${t.publishing.step}/image`), expect: NO_STEP },
    { what: "their step under the caller's own tour", method: "GET", path: tourPath(m.published.tour, `/steps/${t.published.step}/image`), expect: NO_STEP },
    { what: "the caller's own step under their tour", method: "GET", path: tourPath(t.published.tour, `/steps/${m.published.step}/image`), expect: NO_STEP },
  ],
  "POST /api/v1/tours/:id/publish": (t, m) => [
    ...theirTours(t).map(([what, id]) => ({ what, method: "POST", path: tourPath(id, "/publish"), expect: NO_TOUR })),
    { what: "their publish in progress, continued by its id", method: "POST", path: tourPath(t.publishing.tour, "/publish"), json: { publish_id: t.publishing.publishId }, expect: NO_TOUR },
    { what: "their publish in progress, named for the caller's own tour", method: "POST", path: tourPath(m.published.tour, "/publish"), json: { publish_id: t.publishing.publishId }, field: "publish_id", expect: NO_PUBLISH },
    { what: "their live publish, named for the caller's own tour", method: "POST", path: tourPath(m.published.tour, "/publish"), json: { publish_id: t.published.publishId }, field: "publish_id", expect: NO_PUBLISH },
  ],
  "POST /api/v1/tours/:id/unpublish": (t) => theirTours(t).map(([what, id]) => ({ what, method: "POST", path: tourPath(id, "/unpublish"), expect: NO_TOUR })),
};

/** A create for the open upload's own pictures, into `target`. */
const createInto = (t: Ids, target: Json, more: Json = {}) => ({ manifest: manifestOf(t.pictures.draft.map((s) => s.bytes), "Taken over"), target, ...more });

const BODY_IDS: Record<string, Entry> = {
  "POST /api/v1/uploads": (t, m) => [
    { what: "a new chapter for their draft tour", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "chapter", tour_id: t.draft.tour }), field: "tour_id", expect: NO_TOUR },
    { what: "a new chapter for their published tour", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "chapter", tour_id: t.published.tour }), field: "tour_id", expect: NO_TOUR },
    { what: "a new chapter for their half-deleted tour", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "chapter", tour_id: t.deleting.tour }), field: "tour_id", expect: NO_TOUR },
    { what: "a replace of their chapter", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "replace", tour_id: t.draft.tour, chapter_id: t.draft.chapter }), field: "tour_id", expect: NO_TOUR },
    {
      what: "a replace of their chapter that names their pictures by hash",
      method: "POST",
      path: "/api/v1/uploads",
      json: createInto(t, { kind: "replace", tour_id: t.draft.tour, chapter_id: t.draft.chapter }, { sha256: t.draft.sha256 }),
      field: "tour_id",
      expect: NO_TOUR,
    },
    { what: "their tour with the caller's own chapter", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "replace", tour_id: t.draft.tour, chapter_id: m.draft.chapter }), field: "tour_id", expect: NO_TOUR },
    { what: "their chapter under the caller's own tour", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "replace", tour_id: m.draft.tour, chapter_id: t.draft.chapter }), field: "chapter_id", expect: NO_CHAPTER },
    {
      what: "their chapter under the caller's own tour, naming their pictures by hash",
      method: "POST",
      path: "/api/v1/uploads",
      json: createInto(t, { kind: "replace", tour_id: m.draft.tour, chapter_id: t.draft.chapter }, { sha256: t.draft.sha256 }),
      field: "chapter_id",
      expect: NO_CHAPTER,
    },
  ],
};

/** Routes that answer the caller's own workspace as a whole: what the answer holds. */
const LISTS: Record<string, { path: string; holds: string }> = {
  "GET /api/v1/me": { path: "/api/v1/me", holds: "the caller's workspace name" },
  "GET /api/v1/usage": { path: "/api/v1/usage", holds: "the caller's workspace's usage and allowance" },
  "GET /api/v1/tours": { path: "/api/v1/tours", holds: "the caller's workspace's tours" },
  "GET /api/v1/setup/connected": { path: "/api/v1/setup/connected", holds: "whether the caller's own token was used" },
};

type Sample = { method: string; path: string; json?: unknown; headers?: Record<string, string> };

/** Routes that belong to no workspace: why, and requests that must answer everyone the same. */
const OPEN: Record<string, { reason: string; samples: (w: World) => Sample[] }> = {
  "GET /healthz": { reason: "says only that the site is up", samples: () => [{ method: "GET", path: "/healthz" }] },
  "GET /setup": { reason: "the wizard's page, open only while the site has no workspace at all", samples: () => [{ method: "GET", path: "/setup" }] },
  "GET /setup/setup.css": { reason: "the wizard's stylesheet, open only while the site has no workspace at all", samples: () => [{ method: "GET", path: "/setup/setup.css" }] },
  "GET /setup/setup.js": { reason: "the wizard's script, open only while the site has no workspace at all", samples: () => [{ method: "GET", path: "/setup/setup.js" }] },
  "POST /setup/check": {
    reason: "checks the setup code, and only while the site has no workspace at all",
    samples: () => [{ method: "POST", path: "/setup/check", json: { code: SETUP_CODE }, headers: { origin: TOURS } }],
  },
  "POST /setup/claim": {
    reason: "makes the first workspace, and only while the site has no workspace at all",
    samples: () => [{ method: "POST", path: "/setup/claim", json: { code: SETUP_CODE, workspace: "Taken over", email: "intruder@example.com" }, headers: { origin: TOURS } }],
  },
  "GET /p/:name": {
    reason: "a published picture, for visitors: the name is 128 random bits and is served only while a live snapshot or a re-publish inside its grace names it",
    samples: (w) => [w.a.ids.published.publicName, w.a.ids.published.retiredName, w.a.ids.publishing.pendingName, inventedIds().published.publicName].map((name) => ({ method: "GET", path: `/p/${name}` })),
  },
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": { reason: "the player's own files, the same for every tour", samples: () => [{ method: "GET", path: "/player.js" }, { method: "GET", path: "/player.css" }] },
  "GET /t/:slug": {
    reason: "a published tour's page, for visitors: only a published tour answers, from its snapshot",
    samples: (w) => [w.a.ids.published.slug, w.a.ids.draft.slug, w.a.ids.publishing.slug, inventedIds().published.slug].map((slug) => ({ method: "GET", path: `/t/${slug}` })),
  },
  "GET /docs": { reason: "the documentation page, the same for everyone", samples: () => [{ method: "GET", path: "/docs" }] },
  "GET /docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}": { reason: "the documentation page's own files", samples: () => [{ method: "GET", path: "/docs/viewer.0123456789abcdef.js" }] },
  "GET /docs/licences.txt": { reason: "licence notices, fixed text", samples: () => [{ method: "GET", path: "/docs/licences.txt" }] },
  "GET /api/v1/openapi.json": { reason: "the API description, fixed text", samples: () => [{ method: "GET", path: "/api/v1/openapi.json" }] },
  "GET /api/v1/openapi.yaml": { reason: "the API description, fixed text", samples: () => [{ method: "GET", path: "/api/v1/openapi.yaml" }] },
};

type Tables = Record<string, Record<string, unknown>>;
const TABLES: Tables = { CASES, BODY_IDS, LISTS, OPEN };

// ---- The route list against the tables ----

/** The app's routes as table keys. Only the host gate, registered for every method and every path, is left out. */
function routeKeysOf(app: { routes: { method: string; path: string }[] }): string[] {
  return [...new Set(app.routes.filter((r) => !(r.method === "ALL" && r.path === "/*")).map((r) => `${r.method} ${r.path}`))];
}

const hasParameter = (key: string) => key.slice(key.indexOf(" ") + 1).includes(":");

/** Where a route with no table belongs. */
function whereToAdd(key: string): string {
  return hasParameter(key)
    ? "add it to CASES in test/isolation.test.ts, with a request for every id it can be given (or to OPEN with its reason, if it has no owner)"
    : "add it to LISTS in test/isolation.test.ts if it answers a collection or a summary, to BODY_IDS if its body carries an id, or to OPEN with its reason if it has no owner";
}

/** Everything wrong between a route list and the tables: one line per problem, none when each route is in exactly one table and no table has a key without a route. */
function tableProblems(routes: string[], tables: Tables = TABLES): string[] {
  const problems: string[] = [];
  for (const key of routes) {
    const found = Object.keys(tables).filter((name) => Object.hasOwn(tables[name], key));
    if (found.length === 0) problems.push(`${key} is in no table: ${whereToAdd(key)}`);
    if (found.length > 1) problems.push(`${key} is in ${found.join(" and ")}: keep it in one`);
  }
  for (const [name, table] of Object.entries(tables)) {
    for (const key of Object.keys(table)) if (!routes.includes(key)) problems.push(`${key} is in ${name} but no route has it: remove it from ${name}`);
  }
  return problems;
}

/** Routes with an id in the path that are not in CASES or OPEN. */
function parameterProblems(routes: string[], tables: Tables = TABLES): string[] {
  return routes
    .filter((key) => hasParameter(key) && !Object.hasOwn(tables.CASES ?? {}, key) && !Object.hasOwn(tables.OPEN ?? {}, key))
    .map((key) => `${key} takes an id in its path: it belongs in CASES (or in OPEN with its reason), not in LISTS or BODY_IDS`);
}

/** For each operation of the description, the names ending in `_id` anywhere in its request body. */
function bodyIdFields(doc: OpenApiDoc): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const follow = (schema: any, seen: Set<string>, into: Set<string>): void => {
    if (schema === null || typeof schema !== "object") return;
    if (typeof schema.$ref === "string") {
      if (seen.has(schema.$ref)) return;
      seen.add(schema.$ref);
      let at: any = doc;
      for (const part of schema.$ref.slice(2).split("/")) at = at?.[part];
      return follow(at, seen, into);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name.endsWith("_id")) into.add(name);
      follow(child, seen, into);
    }
    for (const list of [schema.oneOf, schema.anyOf, schema.allOf]) for (const child of list ?? []) follow(child, seen, into);
    follow(schema.items, seen, into);
    if (typeof schema.additionalProperties === "object") follow(schema.additionalProperties, seen, into);
  };
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item as Record<string, any>)) {
      const fields = new Set<string>();
      for (const media of Object.values((op.requestBody?.content ?? {}) as Record<string, any>)) follow(media.schema, new Set(), fields);
      if (fields.size > 0) out[`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`] = [...fields].sort();
    }
  }
  return out;
}

// ---- Sending ----

/**
 * The credentials every case is sent with. Today a side has one, its token; Task 10 adds
 * its session (with the anti-forgery header) as a second entry.
 */
const CREDENTIALS: { name: string; of: (side: Side) => { token: string | null; headers?: Record<string, string> } }[] = [
  { name: "token", of: (side) => ({ token: side.token }) },
];

const JSON_HEADERS = { "content-type": "application/json" };

function fire(deps: Deps, r: Req | Sample, credential: { token: string | null; headers?: Record<string, string> }, origin?: string): Promise<Call> {
  const headers = { ...(r.json !== undefined ? JSON_HEADERS : {}), ...("headers" in r ? r.headers : {}), ...credential.headers };
  const body = r.json !== undefined ? JSON.stringify(r.json) : "bytes" in r ? r.bytes : undefined;
  return send(deps, r.method, r.path, { token: credential.token, body: body as RequestInit["body"], headers, origin });
}

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

function expectAnswer(c: Call, r: Req, label: string): void {
  expect({ status: c.status, body: r.expect.body === null ? c.text : c.json }, label).toEqual({ status: r.expect.status, body: r.expect.body ?? "" });
}

/** Every request of CASES and BODY_IDS with its route key. */
function everyCase(theirs: Ids, mine: Ids): { key: string; req: Req }[] {
  return Object.entries({ ...CASES, ...BODY_IDS }).flatMap(([key, entry]) => entry(theirs, mine).map((req) => ({ key, req })));
}

const label = (key: string, req: Req, credential: string, as: Side) => `${key}: ${req.what} (as ${as.name}, by ${credential})`;

async function build(config?: Parameters<typeof makeDeps>[0]): Promise<World> {
  const ctx = await makeDeps(config);
  return world(ctx.deps, { draftKeys: ctx.draftKeys, publicKeys: ctx.publicKeys });
}

/** Each workspace as the caller, the other as the one whose ids are named. */
const directions = (w: World): [Side, Side][] => [[w.b, w.a], [w.a, w.b]];

describe("the tables against the route table", () => {
  const routes = () => routeKeysOf(createApp({ config: { publicImageBase: "", setupCode: null } } as Deps));

  it("every route in the route table is in exactly one of the four tables, and nothing else is", () => {
    expect(tableProblems(routes())).toEqual([]);
    // The routes are really there: an empty route list would agree with empty tables.
    expect(routes().length).toBeGreaterThanOrEqual(27);
    expect(routes()).toContain("DELETE /api/v1/tours/:id");
    for (const [key, entry] of Object.entries(OPEN)) expect(entry.reason.length, `${key} needs a reason`).toBeGreaterThan(10);
    for (const [key, entry] of Object.entries(LISTS)) expect(entry.holds.length, `${key} must say what it holds`).toBeGreaterThan(10);
  });

  it("every route whose path has a parameter is in CASES or OPEN", () => {
    expect(parameterProblems(routes())).toEqual([]);
    // And every such route names a foreign id in its path at least once, with a request of its own method and path.
    const theirs = inventedIds();
    const mine = inventedIds();
    for (const [key, entry] of Object.entries(CASES)) {
      const [method, path] = key.split(" ");
      const shape = new RegExp("^" + path.replace(/:[a-z_]+/g, "[^/]+") + "$");
      const reqs = entry(theirs, mine);
      expect(reqs.length, `${key} has no request`).toBeGreaterThan(0);
      for (const r of reqs) {
        expect(r.method, `${key}: ${r.what}`).toBe(method);
        expect(r.path, `${key}: ${r.what}`).toMatch(shape);
        const names = namesIn(theirs).filter((n) => r.path.includes(n) || JSON.stringify(r.json ?? null).includes(n));
        expect(names.length, `${key}: ${r.what} names none of the other workspace's ids`).toBeGreaterThan(0);
      }
      expect(reqs.some((r) => namesIn(theirs).some((n) => r.path.includes(n))), `${key} never names a foreign id in its path`).toBe(true);
    }
  });

  it("every request-body field of the description whose name ends in _id has a case in BODY_IDS", () => {
    const fields = bodyIdFields(openapi());
    // The walk finds the fields there are today; if it found none, it would check nothing.
    expect(fields).toMatchObject({ "POST /api/v1/uploads": ["chapter_id", "tour_id"], "POST /api/v1/tours/:id/publish": ["publish_id"] });
    const theirs = inventedIds();
    const mine = inventedIds();
    for (const [key, names] of Object.entries(fields)) {
      // A route with an id in its path is in CASES and carries its body-id requests there.
      const table = hasParameter(key) ? CASES : BODY_IDS;
      const tableName = hasParameter(key) ? "CASES" : "BODY_IDS";
      expect(Object.hasOwn(table, key), `${key} has ${names.join(", ")} in its body: add it to ${tableName} with a request for each, marked with \`field\``).toBe(true);
      const reqs = table[key](theirs, mine);
      for (const name of names) {
        const marked = reqs.filter((r) => r.field === name);
        expect(marked.length, `${key}: no request of ${tableName} is marked \`field: "${name}"\``).toBeGreaterThan(0);
        // The marked request really carries one of the other workspace's ids in that field.
        const carries = (v: unknown): boolean =>
          v !== null && typeof v === "object" && Object.entries(v).some(([k, x]) => (k === name && typeof x === "string" && namesIn(theirs).includes(x)) || carries(x));
        for (const r of marked) expect(carries(r.json), `${key}: ${r.what} does not put a foreign id in ${name}`).toBe(true);
      }
    }
    // And BODY_IDS holds nothing else: each of its requests names a field.
    for (const [key, entry] of Object.entries(BODY_IDS)) for (const r of entry(theirs, mine)) expect(r.field, `${key}: ${r.what}`).toBeTypeOf("string");
  });

  it("the suite itself fails for a route with no case", () => {
    const app = createApp({ config: { publicImageBase: "", setupCode: null } } as Deps);
    app.get("/api/v1/tours/:id/notes", (c) => c.json({}));
    app.post("/api/v1/export", (c) => c.json({}));
    app.all("/api/v1/anything/:id", (c) => c.json({}));
    const problems = tableProblems(routeKeysOf(app));
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^GET \/api\/v1\/tours\/:id\/notes is in no table: add it to CASES in test\/isolation\.test\.ts/);
    expect(problems[1]).toMatch(/^POST \/api\/v1\/export is in no table: add it to LISTS in test\/isolation\.test\.ts .* to BODY_IDS .* or to OPEN/);
    expect(problems[2]).toMatch(/^ALL \/api\/v1\/anything\/:id is in no table: add it to CASES/);

    // A route with an id in its path cannot be passed off as a list.
    const asList: Tables = { ...TABLES, LISTS: { ...LISTS, "GET /api/v1/tours/:id/notes": {} } };
    expect(tableProblems(["GET /api/v1/tours/:id/notes", ...routes()], asList)).toEqual([]);
    expect(parameterProblems(["GET /api/v1/tours/:id/notes", ...routes()], asList)).toEqual([
      "GET /api/v1/tours/:id/notes takes an id in its path: it belongs in CASES (or in OPEN with its reason), not in LISTS or BODY_IDS",
    ]);
    // A route in two tables, and a table key left behind by a route that is gone.
    const twice: Tables = { ...TABLES, LISTS: { ...LISTS, "GET /healthz": {} } };
    expect(tableProblems(routes(), twice)).toEqual(["GET /healthz is in LISTS and OPEN: keep it in one"]);
    expect(tableProblems(routes().filter((k) => k !== "GET /api/v1/usage"))).toEqual(["GET /api/v1/usage is in LISTS but no route has it: remove it from LISTS"]);
  });
});

describe("one workspace against another", () => {
  it("the world holds two full workspaces, and the stand-in ids are none of theirs", SLOW, async () => {
    const w = await build();
    const names = [...namesIn(w.a.ids), ...namesIn(w.b.ids)];
    expect(new Set(names).size).toBe(names.length);
    const invented = namesIn(inventedIds(w.a.ids));
    expect(invented.length).toBe(namesIn(w.a.ids).length);
    for (const n of invented) expect(names).not.toContain(n);
    for (const side of [w.a, w.b]) {
      const s = await snapshotOf(w.deps, side, w.keys);
      for (const table of ["workspace", "user", "membership", "signin_method", "api_token", "tour", "chapter", "step", "snapshot", "snapshot_object", "public_object", "publish_job", "replaced_object", "upload", "upload_step", "tour_deletion", "deleted_object"]) {
        expect(s.rows[table].length, `${side.name} has no row in ${table}`).toBeGreaterThan(0);
      }
      // Every file a row names is there, but the one picture the publish in progress has not copied yet.
      const notCopied = s.rows.public_object.filter((o) => o.state === "pending" && o.copied === 0).map((o) => o.image_key);
      expect(notCopied).toHaveLength(1);
      expect(Object.keys(s.files).filter((key) => s.files[key] === "missing")).toEqual(notCopied);
      expect(Object.keys(s.files).length).toBeGreaterThan(20);
    }
  });

  it("every table of the database belongs to a workspace in the snapshot, or is listed as shared", async () => {
    const { deps } = await makeDeps();
    const tables = await tablesOf(deps);
    expect(tables.length).toBeGreaterThan(20);
    const known = [...Object.keys(OWNED), ...Object.keys(SHARED)];
    expect(tables.filter((t) => !known.includes(t)), "say whose rows these tables hold: add each to OWNED in test/isolation-world.ts, or to SHARED with its reason").toEqual([]);
    expect(known.filter((t) => !tables.includes(t)), "no such table: remove these from OWNED or SHARED in test/isolation-world.ts").toEqual([]);
    expect(Object.keys(OWNED).filter((t) => Object.hasOwn(SHARED, t))).toEqual([]);
    for (const [table, reason] of Object.entries(SHARED)) expect(reason.length, `${table} needs a reason`).toBeGreaterThan(10);
  });

  it("another workspace's token gets the route's own not-found answer for every case", SLOW, async () => {
    const w = await build();
    for (const [mine, theirs] of directions(w)) {
      for (const credential of CREDENTIALS) {
        for (const { key, req } of everyCase(theirs.ids, mine.ids)) {
          w.tick();
          expectAnswer(await fire(w.deps, req, credential.of(mine)), req, label(key, req, credential.name, mine));
        }
      }
    }
    // The same requests are not refused for everyone: with its own ids a workspace is answered otherwise.
    const own = await fire(w.deps, CASES["PATCH /api/v1/tours/:id"](w.a.ids, w.a.ids)[1], { token: w.a.token });
    expect(own.status).toBe(200);
  });

  it("that answer is byte for byte the answer for an id that never existed", SLOW, async () => {
    const w = await build();
    for (const [mine, theirs] of directions(w)) {
      const real = everyCase(theirs.ids, mine.ids);
      const invented = everyCase(inventedIds(theirs.ids), mine.ids);
      expect(invented.length).toBe(real.length);
      for (const credential of CREDENTIALS) {
        for (let i = 0; i < real.length; i++) {
          w.tick();
          const never = await fire(w.deps, invented[i].req, credential.of(mine));
          const theirsAnswer = await fire(w.deps, real[i].req, credential.of(mine));
          expect(seen(theirsAnswer), label(real[i].key, real[i].req, credential.name, mine)).toEqual(seen(never));
        }
      }
    }
  });

  it("nothing of the first workspace changed: rows and files are identical before and after every case", SLOW, async () => {
    const w = await build();
    const start = await dumpOf(w.deps, w.keys, { files: true, touched: [w.a.tokenId, w.b.tokenId] });
    for (const [mine, theirs] of directions(w)) {
      // A request with an accepted token records that the token was used; nothing else may differ.
      const look = () => dumpOf(w.deps, w.keys, { touched: [mine.tokenId] });
      const before = await look();
      const real = everyCase(theirs.ids, mine.ids);
      const invented = everyCase(inventedIds(theirs.ids), mine.ids);
      for (const credential of CREDENTIALS) {
        for (const { key, req } of [...real, ...invented]) {
          w.tick();
          await fire(w.deps, req, credential.of(mine));
          const what = label(key, req, credential.name, mine);
          expect(w.writes(), `${what} wrote to or deleted from a store`).toEqual([]);
          expect(await look(), `${what} changed what is stored`).toEqual(before);
        }
      }
    }
    // And every file still holds the bytes it held, under the type it had.
    expect(await dumpOf(w.deps, w.keys, { files: true, touched: [w.a.tokenId, w.b.tokenId] })).toEqual(start);
    expect(Object.keys(start.files ?? {}).length).toBeGreaterThan(60);
  });

  it("nothing of the first workspace changes when it has an old upload, a stale publish and pictures past their grace", SLOW, async () => {
    const w = await build();
    // A day on, both workspaces hold things housekeeping removes: uploads past their age, a
    // publish nobody continued, public pictures a re-publish retired. The second workspace's
    // requests run its own housekeeping, also the refused ones; none may reach the first's.
    w.tick(UPLOAD_MAX_AGE_MS + 60_000);
    const before = await snapshotOf(w.deps, w.a, w.keys);
    expect(before.rows.publish_job).toHaveLength(1);
    expect(before.rows.upload).toHaveLength(2);
    expect(before.rows.replaced_object).toHaveLength(1);
    expect(before.rows.public_object.filter((o) => o.state === "retired" && o.delete_after <= w.deps.now()).length).toBeGreaterThan(0);

    for (const credential of CREDENTIALS) {
      for (const { key, req } of everyCase(w.a.ids, w.b.ids)) {
        w.tick();
        const what = label(key, req, credential.name, w.b);
        expectAnswer(await fire(w.deps, req, credential.of(w.b)), req, what);
        expect(await snapshotOf(w.deps, w.a, w.keys), `${what} changed something of the other workspace`).toEqual(before);
      }
    }
    // Its own ordinary requests, each of which runs housekeeping for its own workspace.
    const own: [string, () => Promise<Call>][] = [
      ["list tours", () => send(w.deps, "GET", "/api/v1/tours", { token: w.b.token })],
      ["create an upload", () => send(w.deps, "POST", "/api/v1/uploads", { token: w.b.token, body: JSON.stringify({ manifest: manifestOf([700], "Bravo later tour"), target: { kind: "new" } }), headers: JSON_HEADERS })],
      ["publish", () => send(w.deps, "POST", tourPath(w.b.ids.published.tour, "/publish"), { token: w.b.token })],
      ["unpublish", () => send(w.deps, "POST", tourPath(w.b.ids.published.tour, "/unpublish"), { token: w.b.token })],
      ["delete a tour", () => send(w.deps, "DELETE", tourPath(w.b.ids.draft.tour), { token: w.b.token })],
      ["finish a delete", () => send(w.deps, "DELETE", tourPath(w.b.ids.deleting.tour), { token: w.b.token })],
    ];
    for (const [what, run] of own) {
      w.tick();
      const r = await run();
      expect(r.status, `${what}: ${r.text}`).toBeLessThan(300);
      expect(await snapshotOf(w.deps, w.a, w.keys), `the other workspace's own ${what} changed something of the first`).toEqual(before);
    }
    // The housekeeping did run, for the workspace that asked: its stale publish, its old
    // uploads and its retired pictures are gone. So the first workspace's were there to take.
    const after = await snapshotOf(w.deps, w.b, w.keys);
    expect(after.rows.publish_job).toEqual([]);
    expect(after.rows.upload.map((u) => u.id)).not.toContain(w.b.ids.upload);
    expect(after.rows.tour_deletion).toEqual([]);
    expect(after.rows.replaced_object).toEqual([]);
    expect(after.rows.public_object).toEqual([]);
  });

  it("no list or summary of one workspace holds anything of the other", SLOW, async () => {
    const w = await build();
    const { deps } = w;
    const needles = async (side: Side) => needlesOf(await snapshotOf(deps, side, w.keys), [side.token, side.revokedToken, side.workspaceName, side.email]);
    const answers = async (side: Side) => {
      const out: Record<string, { status: number; body: string }> = {};
      for (const [key, list] of Object.entries(LISTS)) {
        const r = await send(deps, "GET", list.path, { token: side.token });
        out[key] = { status: r.status, body: r.text };
      }
      return out;
    };
    const all = { a: await needles(w.a), b: await needles(w.b) };
    // The one name both have is the fixed name of a workspace's first token, which tells nothing.
    expect(all.a.filter((n) => all.b.includes(n))).toEqual(["First token"]);
    const mine = { a: all.a.filter((n) => !all.b.includes(n)), b: all.b.filter((n) => !all.a.includes(n)) };
    // The needles are what would give a workspace away: its ids, titles, slugs, email and file names.
    for (const n of [w.a.workspaceId, w.a.email, w.a.ids.published.tour, w.a.ids.draft.step, w.a.ids.published.slug, w.a.ids.published.publicName, w.a.ids.upload, "Alpha published tour", "Alpha workspace"]) expect(mine.a).toContain(n);
    expect(mine.a.length).toBeGreaterThan(80);

    const first = { a: await answers(w.a), b: await answers(w.b) };
    for (const key of Object.keys(LISTS)) {
      expect(first.a[key].status, key).toBe(200);
      expect(first.b[key].status, key).toBe(200);
      for (const n of mine.a) expect(first.b[key].body.includes(n), `${key} told the second workspace ${n} of the first`).toBe(false);
      for (const n of mine.b) expect(first.a[key].body.includes(n), `${key} told the first workspace ${n} of the second`).toBe(false);
    }
    // A leak would be seen: each workspace's own answers do hold its own names.
    expect(first.a["GET /api/v1/tours"].body).toContain(w.a.ids.published.tour);
    expect(first.a["GET /api/v1/tours"].body).toContain("Alpha draft tour");
    expect(first.a["GET /api/v1/me"].body).toContain("Alpha workspace");

    // The numbers of a workspace are its own rows' and nobody else's.
    const usage = async (side: Side) => {
      const s = await snapshotOf(deps, side, w.keys);
      const sum = (rows: Json[], column: string) => rows.reduce((n, r) => n + ((r[column] as number | null) ?? 0), 0);
      const pictures = sum(s.rows.step, "bytes");
      const logos = sum(s.rows.tour, "logo_bytes");
      const uploads = sum(s.rows.upload.filter((u) => u.closing_at === null), "reserved_bytes");
      return { used_bytes: pictures + logos + uploads, allowance_bytes: null, over: false, tours: s.rows.tour.length, counted: { pictures, logos, uploads_in_progress: uploads } };
    };
    const usedA = JSON.parse(first.a["GET /api/v1/usage"].body);
    const usedB = JSON.parse(first.b["GET /api/v1/usage"].body);
    expect(usedA).toEqual(await usage(w.a));
    expect(usedB).toEqual(await usage(w.b));
    expect(usedA.used_bytes).not.toBe(usedB.used_bytes);
    expect(JSON.parse(first.b["GET /api/v1/tours"].body).tours).toHaveLength(3);

    // Whatever the first workspace then does, the second's answers stay the same, byte for byte.
    w.tick();
    const token = w.a.token;
    const steps = [
      await send(deps, "PATCH", tourPath(w.a.ids.published.tour), { token, body: JSON.stringify({ title: "Alpha renamed tour" }), headers: JSON_HEADERS }),
      await send(deps, "POST", tourPath(w.a.ids.draft.tour, "/publish"), { token }),
      await send(deps, "POST", tourPath(w.a.ids.published.tour, "/unpublish"), { token }),
      await send(deps, "DELETE", uploadPath(w.a.ids.upload), { token }),
      await send(deps, "DELETE", tourPath(w.a.ids.deleting.tour), { token }),
      await send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest: manifestOf([90_000, 90_001], "Alpha later tour"), target: { kind: "new" } }), headers: JSON_HEADERS }),
    ];
    for (const r of steps) expect(r.status, r.text).toBeLessThan(300);
    const second = { a: await answers(w.a), b: await answers(w.b) };
    expect(second.b).toEqual(first.b);
    expect(second.a["GET /api/v1/usage"].body).not.toBe(first.a["GET /api/v1/usage"].body);
    expect(second.a["GET /api/v1/tours"].body).not.toBe(first.a["GET /api/v1/tours"].body);

    // And a workspace at its allowance does not take room from another: the limit is per workspace.
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = ? WHERE id = ?", [JSON.parse(second.a["GET /api/v1/usage"].body).used_bytes, w.a.workspaceId]);
    const full = await send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest: manifestOf([10], "Alpha one more"), target: { kind: "new" } }), headers: JSON_HEADERS });
    expect(full.status).toBe(413);
    const other = await send(deps, "POST", "/api/v1/uploads", { token: w.b.token, body: JSON.stringify({ manifest: manifestOf([10], "Bravo one more"), target: { kind: "new" } }), headers: JSON_HEADERS });
    expect(other.status).toBe(201);
  });

  it("an upload cannot target another workspace's tour or chapter", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const before = await snapshotOf(deps, a, w.keys);
    const uploadsOfB = async () => (await snapshotOf(deps, b, w.keys)).rows.upload.length;
    const had = await uploadsOfB();
    // Every way of naming the other's tour or chapter in a create leaves no upload behind.
    for (const req of BODY_IDS["POST /api/v1/uploads"](a.ids, b.ids)) {
      expectAnswer(await fire(deps, req, { token: b.token }), req, req.what);
      expect(await uploadsOfB(), req.what).toBe(had);
    }

    // A hash reaches only the pictures of the chapter being replaced, and that chapter is the
    // caller's own. The second workspace replaces its own chapter with pictures of exactly
    // the type, size and length of the first's, and says it has the first's hashes.
    const target = { kind: "replace", tour_id: b.ids.draft.tour, chapter_id: b.ids.draft.chapter };
    const manifest = manifestOf(a.ids.pictures.draft.map((s) => s.bytes), "Bravo draft tour");
    const withTheirs = await createReplace(deps, b.token, manifest, target, a.ids.draft.sha256);
    const withNobodys = await createReplace(deps, b.token, manifest, target, inventedIds().draft.sha256);
    // Nothing is reused, and the answer is the one for hashes no picture has: it tells nothing.
    expect(withTheirs.status).toBe(201);
    expect(withTheirs.json).toEqual({ upload_id: expect.stringMatching(/^up_[0-9a-f]{24}$/), steps: 2, have: [], settings: true });
    expect({ ...withNobodys.json, upload_id: "" }).toEqual({ ...withTheirs.json, upload_id: "" });
    expect(seen(withNobodys).headers).toEqual(seen(withTheirs).headers);
    expect(await deps.db.all("SELECT * FROM upload_step WHERE upload_id IN (?, ?)", [withTheirs.json.upload_id, withNobodys.json.upload_id])).toEqual([]);
    // Its own pictures are found by hash, so the reuse does work; only never across workspaces.
    const mixed = manifestOf([a.ids.pictures.draft[0].bytes, b.ids.pictures.draft[1].bytes], "Bravo draft tour");
    const own = await createReplace(deps, b.token, mixed, target, [a.ids.draft.sha256[0], b.ids.draft.sha256[1]]);
    expect(own.json).toMatchObject({ have: [2] });

    // It then sends the very bytes the first workspace stored and commits. Its steps name
    // files under its own upload, never the first's, although the bytes are the same.
    const id = withTheirs.json.upload_id as string;
    for (const n of [1, 2]) expect((await putStep(deps, b.token, id, n, stepImage(manifest.steps[n - 1], a.ids.fill))).status).toBe(204);
    expect((await commit(deps, b.token, id)).status).toBe(201);
    const steps = await deps.db.all<{ image_key: string; sha256: string }>("SELECT image_key, sha256 FROM step WHERE chapter_id = ? ORDER BY position", [b.ids.draft.chapter]);
    expect(steps.map((s) => s.sha256)).toEqual(a.ids.draft.sha256);
    for (const s of steps) expect(s.image_key.startsWith(`u/${id}/`), s.image_key).toBe(true);
    const theirKeys = Object.keys(before.files);
    for (const row of await deps.db.all<Json>("SELECT * FROM upload_step WHERE upload_id IN (SELECT id FROM upload WHERE workspace_id = ?)", [b.workspaceId])) {
      expect(theirKeys).not.toContain(row.image_key);
    }
    expect(await snapshotOf(deps, a, w.keys)).toEqual(before);
  });

  it("on a site with two addresses every case answers the same on the tours address and on the app address", SLOW, async () => {
    const w = await build({ hosts: HOSTS });
    const start = await dumpOf(w.deps, w.keys, { files: true, touched: [w.a.tokenId, w.b.tokenId] });
    const needles = needlesOf(await snapshotOf(w.deps, w.a, w.keys), [w.a.token, w.a.workspaceName, w.a.email]);
    for (const origin of [TOURS, APP]) {
      for (const [mine, theirs] of directions(w)) {
        const real = everyCase(theirs.ids, mine.ids);
        const invented = everyCase(inventedIds(theirs.ids), mine.ids);
        for (const credential of CREDENTIALS) {
          for (let i = 0; i < real.length; i++) {
            w.tick();
            const what = `${label(real[i].key, real[i].req, credential.name, mine)} on ${origin}`;
            const r = await fire(w.deps, real[i].req, credential.of(mine), origin);
            expectAnswer(r, real[i].req, what);
            expect(seen(r), what).toEqual(seen(await fire(w.deps, invented[i].req, credential.of(mine), origin)));
          }
        }
      }
    }
    expect(w.writes()).toEqual([]);
    expect(await dumpOf(w.deps, w.keys, { files: true, touched: [w.a.tokenId, w.b.tokenId] })).toEqual(start);
    // The lists last: listing tours also clears the caller's own replaced pictures.
    for (const origin of [TOURS, APP]) {
      for (const [key, list] of Object.entries(LISTS)) {
        const r = await send(w.deps, "GET", list.path, { token: w.b.token, origin });
        expect(r.status, `${key} on ${origin}`).toBe(200);
        for (const n of needles) expect(r.text.includes(n), `${key} on ${origin} told the second workspace ${n} of the first`).toBe(false);
      }
    }
  });
});

describe("a caller that is nobody", () => {
  const UNAUTHORIZED = { status: 401, headers: [["content-type", "application/json"]], body: '{"error":"unauthorized"}' };

  /** One request per route that needs a caller, each naming the caller's own data: a valid token would be answered with it. */
  function ownRequests(side: Side): { key: string; req: Req | Sample }[] {
    const lists = Object.entries(LISTS).map(([key, list]) => ({ key, req: { method: "GET", path: list.path } as Sample }));
    return [...everyCase(side.ids, side.ids), ...lists];
  }

  it("a revoked token and a malformed one get 401 everywhere", SLOW, async () => {
    const w = await build();
    const { deps, a } = w;
    const before = await dumpOf(deps, w.keys, { files: true });
    const unknown = newToken();
    const headers: [string, string | null][] = [
      ["no Authorization header", null],
      ["the revoked token", `Bearer ${a.revokedToken}`],
      ["a token nobody was given", `Bearer ${unknown}`],
      ["the token in capitals", `Bearer ${a.token.toUpperCase()}`],
      ["the token with a character more", `Bearer ${a.token}0`],
      ["the token with a character less", `Bearer ${a.token.slice(0, -1)}`],
      ["the token without its prefix", `Bearer ${a.token.slice(3)}`],
      ["the token after two spaces", `Bearer  ${a.token}`],
      ["the token as a Basic credential", `Basic ${a.token}`],
      ["the bare token", a.token],
      ["two tokens", `Bearer ${a.token}, Bearer ${w.b.token}`],
      ["the stored hash of the token", `Bearer ${await hashToken(a.token)}`],
      ["the token's id", `Bearer ${a.tokenId}`],
      ["the workspace's id", `Bearer ${a.workspaceId}`],
    ];
    const requests = ownRequests(a);
    expect(new Set(requests.map((r) => r.key))).toEqual(new Set([...Object.keys(CASES), ...Object.keys(BODY_IDS), ...Object.keys(LISTS)]));
    for (const [what, value] of headers) {
      for (const { key, req } of requests) {
        w.tick();
        const r = await fire(deps, req, { token: null, headers: value === null ? {} : { authorization: value } });
        expect(seen(r), `${key} with ${what}`).toEqual(UNAUTHORIZED);
      }
      // Not even the record of a token's last use: nobody was there.
      expect(w.writes(), what).toEqual([]);
      expect(await dumpOf(deps, w.keys), what).toEqual({ rows: before.rows, drafts: before.drafts, public: before.public });
    }
    expect(await dumpOf(deps, w.keys, { files: true })).toEqual(before);
    // The same requests with the token itself are answered: the 401s were about the credential.
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).status).toBe(200);
  });

  // The token lookup does not yet look at the owner's status: `requireAuth` gains that
  // condition with sessions (Task 9, src/auth.ts). Until then this test is expected to fail,
  // and vitest reports it as failing the build the moment it passes: then change `it.fails`
  // to `it`. Nothing can disable an account before that task either.
  it("a token of a disabled owner's workspace gets 401 everywhere", SLOW, async () => {
    const w = await build();
    const { deps, a } = w;
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    const before = await dumpOf(deps, w.keys);
    for (const { key, req } of ownRequests(a)) {
      const r = await fire(deps, req, { token: a.token });
      expect(seen(r), key).toEqual(UNAUTHORIZED);
    }
    expect(w.writes()).toEqual([]);
    expect(await dumpOf(deps, w.keys)).toEqual(before);
    // The other workspace is not disabled with it.
    expect((await send(deps, "GET", "/api/v1/tours", { token: w.b.token })).status).toBe(200);
  });
});

describe("routes with no owner", () => {
  it("an open route answers everyone the same, reads no credential and shows only what was published", SLOW, async () => {
    const w = await build({ setupCode: SETUP_CODE });
    const { deps, a, b } = w;
    const before = await dumpOf(deps, w.keys, { files: true });
    const callers: [string, { token: string | null }][] = [["nobody", { token: null }], ["the owner", { token: a.token }], ["the other workspace", { token: b.token }], ["a revoked token", { token: a.revokedToken }]];
    const statuses: Record<string, number[]> = {};
    for (const [key, entry] of Object.entries(OPEN)) {
      const samples = entry.samples(w);
      expect(samples.length, key).toBeGreaterThan(0);
      statuses[key] = [];
      for (const sample of samples) {
        w.tick();
        const first = await fire(deps, sample, callers[0][1]);
        statuses[key].push(first.status);
        for (const [who, credential] of callers.slice(1)) expect(seen(await fire(deps, sample, credential)), `${key} ${sample.path} for ${who}`).toEqual(seen(first));
      }
    }
    // No token was looked at (none records a use), nothing was claimed and nothing stored.
    expect(w.writes()).toEqual([]);
    expect(await dumpOf(deps, w.keys, { files: true })).toEqual(before);

    // What each answers: the wizard is closed on a site that has workspaces; a tour page and
    // a picture answer only for what is live (or retired and inside its grace).
    for (const key of Object.keys(OPEN).filter((k) => k.includes(" /setup"))) expect(statuses[key], key).toEqual([404]);
    expect(statuses["GET /t/:slug"]).toEqual([200, 404, 404, 404]);
    expect(statuses["GET /p/:name"]).toEqual([200, 200, 404, 404]);
    for (const key of Object.keys(OPEN).filter((k) => !k.includes(" /setup") && !k.includes(":slug") && !k.includes(":name"))) for (const s of statuses[key]) expect(s, key).toBe(200);

    // A draft's link, the link of a tour whose publish has not finished, and a picture that
    // publish has already copied answer exactly as a name that never existed.
    const page = async (slug: string) => seen(await send(deps, "GET", `/t/${slug}`));
    const picture = async (name: string) => seen(await send(deps, "GET", `/p/${name}`));
    const never = inventedIds();
    expect(await page(a.ids.draft.slug)).toEqual(await page(never.draft.slug));
    expect(await page(a.ids.publishing.slug)).toEqual(await page(never.draft.slug));
    expect(await picture(a.ids.publishing.pendingName)).toEqual(await picture(never.published.publicName));
    // The live page names its own public pictures: no draft file, no workspace, account or
    // token, and nothing of the other workspace. (It does carry its steps' ids, which the
    // player uses; a step id opens nothing without its workspace's credential.)
    const live = await send(deps, "GET", `/t/${a.ids.published.slug}`);
    for (const n of [a.ids.published.tour, a.ids.published.chapter, a.workspaceId, a.userId, a.email, a.token, a.tokenId, "u/up_", ...namesIn(b.ids)]) expect(live.text.includes(n), n).toBe(false);
    // A draft file is not reachable as a public picture under any of its names.
    const draftKeys = (await w.keys.draftKeys()).filter((k) => k.includes("/step-"));
    expect(draftKeys.length).toBeGreaterThan(20);
    for (const key of draftKeys.slice(0, 5)) {
      for (const path of [`/p/${key}`, `/p/${encodeURIComponent(key)}`, `/p/${key.split("/").pop()}`]) expect((await send(deps, "GET", path)).status, path).toBe(404);
    }
    // Once the owner unpublishes, the page and every picture it had are gone at once.
    expect((await send(deps, "POST", tourPath(a.ids.published.tour, "/unpublish"), { token: a.token })).status).toBeLessThan(300);
    expect(await page(a.ids.published.slug)).toEqual(await page(never.draft.slug));
    expect(await picture(a.ids.published.publicName)).toEqual(await picture(never.published.publicName));
    expect(await picture(a.ids.published.retiredName)).toEqual(await picture(never.published.publicName));
  });
});
