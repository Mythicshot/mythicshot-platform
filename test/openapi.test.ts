// The API description (src/docs/openapi.ts) against the code it describes: the route
// table, the version and the limits. What each request really answers is checked by the
// contract tests; this file checks that nothing is missing, invented or hard-coded.
import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { createApp } from "../src/app.ts";
import { GET_STARTED, openapi, routeKeys, UNDOCUMENTED_ROUTES, type OpenApiDoc } from "../src/docs/openapi.ts";
import { LIMITS } from "../src/manifest.ts";
import type { Deps } from "../src/ports.ts";
import { COPY_BATCH, MAX_PUBLISH_STEPS, MAX_SNAPSHOT_BYTES, STALE_PUBLISH_MS } from "../src/publish.ts";
import { LOGO_RULE, STEP_IMAGE_RULE } from "../src/sniff.ts";
import { DELETE_FILES_PER_CALL } from "../src/tours.ts";
import { DEFAULT_MAX_OPEN_UPLOADS, UPLOAD_MAX_AGE_MS } from "../src/uploads.ts";
import { OPENAPI_JSON, OPENAPI_JSON_ETAG, OPENAPI_YAML, OPENAPI_YAML_ETAG } from "../src/docs/site-assets.ts";
import { VERSION } from "../src/version.ts";
import { send } from "./bundle.ts";

type Json = Record<string, any>;

/** The documentation's own routes. Until they are registered, the coverage test counts them as present. */
const DOCS_ROUTES = [
  "GET /docs",
  "GET /docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}",
  "GET /docs/licences.txt",
  "GET /api/v1/openapi.json",
  "GET /api/v1/openapi.yaml",
];

/** The one address an example in the description may carry: a placeholder the page replaces. */
const EXAMPLE_ORIGIN = "https://YOUR-SITE";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

/** Every operation of the description, with its key in the form of the route table. */
function operations(doc: OpenApiDoc): { key: string; path: string; method: string; op: Json }[] {
  const out: { key: string; path: string; method: string; op: Json }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      expect(METHODS, `${path}: ${method} is not an HTTP method`).toContain(method);
      out.push({ key: `${method.toUpperCase()} ${path.replace(/\{([a-z_]+)\}/g, ":$1")}`, path, method, op: op as Json });
    }
  }
  return out;
}

/** A number the way the description writes it: digits in groups of three. */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Follows a local reference such as "#/components/schemas/Tour". */
function resolve(doc: OpenApiDoc, ref: string): unknown {
  expect(ref.startsWith("#/"), `${ref}: only references into this document are allowed`).toBe(true);
  let at: any = doc;
  for (const part of ref.slice(2).split("/")) {
    at = at !== null && typeof at === "object" && Object.hasOwn(at, part) ? at[part] : undefined;
  }
  return at;
}

function walk(node: unknown, visit: (node: Json) => void): void {
  if (Array.isArray(node)) for (const n of node) walk(n, visit);
  else if (node !== null && typeof node === "object") {
    visit(node as Json);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

describe("the API description", () => {
  it("every route in the route table is described or listed as left out, and nothing else is", () => {
    const app = createApp({ config: { publicImageBase: "", setupCode: null } } as Deps);
    const routes = app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    const described = routeKeys(openapi());
    const leftOut = Object.keys(UNDOCUMENTED_ROUTES);
    const lacking = (have: string[], want: string[]) => want.filter((k) => !have.includes(k));

    expect(new Set(described).size, "two operations share a method and a path").toBe(described.length);
    expect(described.filter((k) => leftOut.includes(k)), "these routes are both described in src/docs/openapi.ts and listed in its UNDOCUMENTED_ROUTES; keep one").toEqual([]);

    // The documentation's own routes count as present until they are registered.
    const table = [...routes, ...lacking(routes, DOCS_ROUTES)];
    const known = [...described, ...leftOut];
    expect(lacking(known, table), "describe each of these routes in openapi() in src/docs/openapi.ts, or list it with its reason in UNDOCUMENTED_ROUTES there").toEqual([]);
    expect(lacking(table, described), "remove these operations from openapi() in src/docs/openapi.ts: no route has them").toEqual([]);
    expect(lacking(table, leftOut), "remove these keys from UNDOCUMENTED_ROUTES in src/docs/openapi.ts: no route has them").toEqual([]);
    for (const [key, reason] of Object.entries(UNDOCUMENTED_ROUTES)) expect(reason.length, `${key} needs a reason`).toBeGreaterThan(10);

    // routeKeys is the description's own paths and methods in the route table's form.
    expect([...described].sort()).toEqual(operations(openapi()).map((o) => o.key).sort());
    expect(described).toContain("GET /api/v1/tours/:id/steps/:step_id/image");
    expect(described).toContain("PUT /api/v1/uploads/:id/steps/:n");
  });

  it("every path parameter is declared, and no other", () => {
    const doc = openapi();
    const seen = new Set<string>();
    for (const { key, path, op } of operations(doc)) {
      const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const declared = ((op.parameters ?? []) as Json[]).map((p) => {
        expect(p.in, `${key}: ${p.name}`).toBe("path");
        expect(p.required, `${key}: ${p.name} must be required`).toBe(true);
        expect(typeof p.description, `${key}: ${p.name} needs a description`).toBe("string");
        expect(p.schema, `${key}: ${p.name} needs a schema`).toBeTypeOf("object");
        return p.name as string;
      });
      expect(declared, key).toEqual(inPath);
      for (const name of inPath) seen.add(name);
    }
    expect([...seen].sort()).toEqual(["id", "n", "step_id"]);
  });

  it("the version and every limit come from the code", () => {
    const doc = openapi();
    expect(doc.info.version).toBe(VERSION);
    expect(doc.info.title).toBe("Mythicshot API");

    // The manifest's schema carries each cap where the field is.
    const s = doc.components.schemas as Json;
    const m = s.Manifest.properties;
    const step = s.ManifestStep.properties;
    expect(m.steps.maxItems).toBe(LIMITS.steps);
    expect(m.steps.minItems).toBe(1);
    expect(m.title.maxLength).toBe(LIMITS.title);
    expect(m.generator.maxLength).toBe(LIMITS.generator);
    expect(step.bytes.maximum).toBe(LIMITS.imageBytes);
    expect(step.width.maximum).toBe(LIMITS.imageSide);
    expect(step.height.maximum).toBe(LIMITS.imageSide);
    expect(step.notes.maxItems).toBe(LIMITS.notesPerStep);
    for (const kind of ["TextNote", "BubbleNote"]) expect(s[kind].properties.text.maxLength, kind).toBe(LIMITS.noteText);
    expect(s.Card.properties.title.maxLength).toBe(LIMITS.cardTitle);
    expect(s.Card.properties.body.maxLength).toBe(LIMITS.cardBody);
    expect(s.Card.properties.next_label.maxLength).toBe(LIMITS.nextLabel);
    expect(s.Cover.properties.title.maxLength).toBe(LIMITS.coverTitle);
    expect(s.Cover.properties.body.maxLength).toBe(LIMITS.coverBody);
    expect(s.Cover.properties.button.maxLength).toBe(LIMITS.coverButton);
    expect(s.Link.properties.label.maxLength).toBe(LIMITS.buttonLabel);
    expect(s.Link.properties.url.maxLength).toBe(LIMITS.link);
    expect(s.EndCard.properties.text.maxLength).toBe(LIMITS.endText);
    expect(s.RenameBody.properties.title.maxLength).toBe(LIMITS.title);
    expect(s.UploadCreate.properties.sha256.maxItems).toBe(LIMITS.steps);

    // The limits section of the introduction states every one of them, in words.
    const intro = doc.info.description;
    const hours = UPLOAD_MAX_AGE_MS / 3_600_000;
    const minutes = STALE_PUBLISH_MS / 60_000;
    expect(Number.isInteger(hours) && Number.isInteger(minutes)).toBe(true);
    const stated = [
      `${grouped(LIMITS.steps)} steps in one upload`,
      `${grouped(LIMITS.manifestBytes)} bytes`,
      `${grouped(STEP_IMAGE_RULE.maxBytes)} bytes and ${grouped(STEP_IMAGE_RULE.maxSide)} pixels`,
      `${grouped(LOGO_RULE.maxBytes)} bytes and ${grouped(LOGO_RULE.maxSide)} pixels`,
      `title ${LIMITS.title}`,
      `generator ${LIMITS.generator}`,
      `${LIMITS.notesPerStep} notes on a step`,
      `note text ${LIMITS.noteText}`,
      `card title ${LIMITS.cardTitle}`,
      `card body ${LIMITS.cardBody}`,
      `next label ${LIMITS.nextLabel}`,
      `cover title ${LIMITS.coverTitle}`,
      `cover body ${LIMITS.coverBody}`,
      `cover button ${LIMITS.coverButton}`,
      `button label ${LIMITS.buttonLabel}`,
      `end text ${LIMITS.endText}`,
      `link ${LIMITS.link}`,
      `${grouped(MAX_PUBLISH_STEPS)} steps in one published tour`,
      `${grouped(MAX_SNAPSHOT_BYTES)} bytes`,
      `${COPY_BATCH} images`,
      `${DELETE_FILES_PER_CALL} files`,
      `${DEFAULT_MAX_OPEN_UPLOADS} open uploads`,
      `${hours} hours`,
      `${minutes} minutes`,
    ];
    for (const text of stated) expect(intro, text).toContain(text);
    // imageBytes and imageSide are the step image rule's numbers; all 17 keys are covered.
    expect(LIMITS.imageBytes).toBe(STEP_IMAGE_RULE.maxBytes);
    expect(LIMITS.imageSide).toBe(STEP_IMAGE_RULE.maxSide);
    expect(Object.keys(LIMITS)).toHaveLength(17);

    // And each request says its own, where a client meets it.
    const op = (key: string) => operations(doc).find((o) => o.key === key)!.op.description as string;
    expect(op("POST /api/v1/uploads")).toContain(`${grouped(LIMITS.manifestBytes)} bytes`);
    expect(op("POST /api/v1/uploads")).toContain(`${DEFAULT_MAX_OPEN_UPLOADS} open uploads`);
    expect(op("POST /api/v1/uploads")).toContain(`${hours} hours`);
    expect(op("PUT /api/v1/uploads/:id/steps/:n")).toContain(`${grouped(STEP_IMAGE_RULE.maxBytes)} bytes and ${grouped(STEP_IMAGE_RULE.maxSide)} pixels`);
    expect(op("PUT /api/v1/uploads/:id/logo")).toContain(`${grouped(LOGO_RULE.maxBytes)} bytes and ${grouped(LOGO_RULE.maxSide)} pixels`);
    expect(op("POST /api/v1/tours/:id/publish")).toContain(`${grouped(MAX_PUBLISH_STEPS)} steps`);
    expect(op("POST /api/v1/tours/:id/publish")).toContain(`${grouped(MAX_SNAPSHOT_BYTES)} bytes`);
    expect(op("POST /api/v1/tours/:id/publish")).toContain(`${COPY_BATCH} images`);
    expect(op("POST /api/v1/tours/:id/publish")).toContain(`${minutes} minutes`);
    expect(op("DELETE /api/v1/tours/:id")).toContain(`${DELETE_FILES_PER_CALL} files`);
  });

  it("every operation has a tag, a one-line summary, a description, an operationId that is unique, and a 401 unless it is public", () => {
    const doc = openapi();
    expect(doc.tags.map((t) => t.name)).toEqual(["Tours", "Uploads", "Workspace", "Server"]);
    for (const t of doc.tags) expect(t.description.length, t.name).toBeGreaterThan(10);
    const ids: string[] = [];
    const summaries: string[] = [];
    for (const { key, op } of operations(doc)) {
      expect(op.tags, key).toHaveLength(1);
      expect(doc.tags.map((t) => t.name), key).toContain(op.tags[0]);
      expect(op.summary, key).toMatch(/^[A-Z][^\n.]{5,60}$/);
      expect(op.description.length, key).toBeGreaterThan(40);
      expect(op.operationId, key).toMatch(/^[a-z][A-Za-z]+$/);
      ids.push(op.operationId);
      summaries.push(op.summary);
      const statuses = Object.keys(op.responses);
      expect(statuses.length, key).toBeGreaterThan(0);
      for (const status of statuses) expect(status, key).toMatch(/^[1-5][0-9][0-9]$/);
      expect(statuses.includes("401"), `${key}: 401`).toBe(key !== "GET /healthz");
      for (const [status, res] of Object.entries(op.responses as Json)) {
        const r = (res.$ref ? resolve(doc, res.$ref) : res) as Json;
        expect(typeof r?.description, `${key} ${status} needs a description`).toBe("string");
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    // The approved summaries, in page order.
    expect(summaries).toEqual([
      "List the workspace's tours",
      "Rename a tour",
      "Delete a tour, in steps",
      "Publish a tour, in steps",
      "Unpublish a tour",
      "Get a draft step's image",
      "Start an upload",
      "Send one step's image",
      "Send the logo",
      "Finish an upload",
      "Cancel an upload",
      "The workspace and the server version",
      "Whether the server is up",
    ]);
  });

  it("only health is public", () => {
    const doc = openapi();
    expect(doc.components.securitySchemes).toEqual({ token: { type: "http", scheme: "bearer" } });
    for (const { key, op } of operations(doc)) {
      expect(op.security, key).toEqual(key === "GET /healthz" ? [] : [{ token: [] }]);
    }
  });

  it("the description names no host and no real token", () => {
    const doc = openapi();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "/" }]);
    const text = JSON.stringify(doc);
    // The only address is the placeholder of the first example.
    expect(GET_STARTED).toContain(`${EXAMPLE_ORIGIN}/api/v1/me`);
    expect(GET_STARTED).toContain("Authorization: Bearer YOUR_TOKEN");
    expect(doc.info.description).toContain(GET_STARTED);
    const outside = text.split(JSON.stringify(GET_STARTED).slice(1, -1)).join("");
    expect(outside).not.toContain("://");
    expect(GET_STARTED.split(EXAMPLE_ORIGIN).join("")).not.toContain("://");
    expect(text).not.toMatch(/example\.(com|org|net)|localhost|mythicshot\.com/i);
    expect(text).not.toMatch(/dp_[0-9a-f]/);
    expect(text).not.toMatch(/[0-9a-f]{40}/);
  });

  it("every $ref resolves, and the description is plain data", () => {
    const doc = openapi();
    let refs = 0;
    walk(doc, (node) => {
      if (!Object.hasOwn(node, "$ref")) return;
      refs++;
      expect(typeof node.$ref).toBe("string");
      expect(resolve(doc, node.$ref), node.$ref).toBeTypeOf("object");
    });
    expect(refs).toBeGreaterThan(20);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    // toEqual treats an undefined property as absent; the text must not differ either.
    walk(doc, (node) => {
      for (const [k, v] of Object.entries(node)) expect(v === undefined || typeof v === "function", k).toBe(false);
    });
    // Pure and deterministic: two calls give equal, separate objects.
    expect(openapi()).toEqual(doc);
    expect(openapi()).not.toBe(doc);
    expect(JSON.stringify(openapi())).toBe(JSON.stringify(doc));
  });

  it("the tour list's items carry the fields the list answers, unpublished_changes included", () => {
    const tour = (openapi().components.schemas as Json).Tour;
    const fields = ["id", "title", "status", "slug", "url", "chapters", "steps", "updated_at", "published_at", "unpublished_changes"];
    expect(Object.keys(tour.properties)).toEqual(fields);
    expect(tour.required).toEqual(fields);
    expect(tour.additionalProperties).toBe(false);
    expect(tour.properties.unpublished_changes.type).toBe("boolean");
  });

  it("an upload can target a new tour, a new chapter, or the replacement of a chapter", () => {
    const s = openapi().components.schemas as Json;
    const kinds = (s.UploadTarget.oneOf as Json[]).map((t) => ((t.$ref ? resolve(openapi(), t.$ref) : t) as Json).properties.kind.const);
    expect(kinds).toEqual(["new", "chapter", "replace"]);
  });
});

describe("the served description", () => {
  const FILES = [
    { path: "/api/v1/openapi.json", body: OPENAPI_JSON, etag: OPENAPI_JSON_ETAG, type: "application/json; charset=utf-8" },
    { path: "/api/v1/openapi.yaml", body: OPENAPI_YAML, etag: OPENAPI_YAML_ETAG, type: "application/yaml; charset=utf-8" },
  ];

  it("the description is served as JSON and as YAML with their types, a short cache and an ETag", async () => {
    const { deps } = await makeDeps();
    for (const f of FILES) {
      const r = await send(deps, "GET", f.path);
      expect(r.status, f.path).toBe(200);
      expect(r.text, f.path).toBe(f.body);
      expect(r.headers.get("content-type"), f.path).toBe(f.type);
      expect(r.headers.get("cache-control"), f.path).toBe("public, max-age=300");
      expect(r.headers.get("etag"), f.path).toBe(f.etag);
      expect(r.headers.get("x-content-type-options"), f.path).toBe("nosniff");
      expect(r.calls, f.path).toBe(0);
      for (const [header] of r.headers) expect(header.startsWith("access-control-"), `${f.path} ${header}`).toBe(false);

      for (const header of [f.etag, `W/${f.etag}`, "*"]) {
        const cached = await send(deps, "GET", f.path, { headers: { "if-none-match": header } });
        expect(cached.status, `${f.path} ${header}`).toBe(304);
        expect(cached.bytes.length, f.path).toBe(0);
        for (const h of ["content-type", "cache-control", "etag", "x-content-type-options"]) expect(cached.headers.get(h), `${f.path} ${h}`).toBe(r.headers.get(h));
      }
      expect((await send(deps, "GET", f.path, { headers: { "if-none-match": '"other"' } })).status, f.path).toBe(200);

      // HEAD answers the same headers and no body.
      const head = await send(deps, "HEAD", f.path);
      expect(head.status, f.path).toBe(200);
      expect(head.bytes.length, f.path).toBe(0);
      for (const h of ["content-type", "cache-control", "etag", "x-content-type-options"]) expect(head.headers.get(h), `${f.path} ${h}`).toBe(r.headers.get(h));
    }
  });

  it("what is served is the description itself, at the code's version", async () => {
    const { deps } = await makeDeps();
    const served = (await send(deps, "GET", "/api/v1/openapi.json")).json;
    expect(served).toEqual(openapi());
    expect(served.info.version).toBe(VERSION);
    // The same on any host, with or without a token: it is public text.
    const again = await send(deps, "GET", "/api/v1/openapi.json", { origin: "http://localhost:8787", token: "dp_" + "0".repeat(40) });
    expect(again.text).toBe(OPENAPI_JSON);
    expect((await send(deps, "GET", "/api/v1/openapi.yaml")).text.startsWith("openapi: 3.1.0\n")).toBe(true);
  });
});
