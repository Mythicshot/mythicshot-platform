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
import { BILLING_CONFIG } from "./fake-stripe.ts";

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

/** The operations anyone may call, with no credential at all. */
const PUBLIC = [
  "GET /healthz",
  "POST /api/v1/signin/request",
  "POST /api/v1/signin/complete",
  "POST /api/v1/invite/check",
  "POST /api/v1/invite/accept",
  "POST /api/v1/connect/start",
  "POST /api/v1/connect/token",
  "POST /api/v1/view/request",
  "POST /api/v1/view/check",
  "POST /api/v1/view/complete",
  "POST /api/v1/view/signout",
  "POST /api/v1/media-view/request",
  "POST /api/v1/media-view/check",
  "POST /api/v1/media-view/complete",
  "POST /api/v1/media-view/signout",
];
/** The one operation that takes the viewer cookie alone (src/viewers.ts): which address the browser proved. */
const VIEWER_ONLY = ["GET /api/v1/view/session", "GET /api/v1/media-view/session"];
/** The operations that take a session and no token. */
const SESSION_ONLY = ["GET /api/v1/session", "GET /api/v1/sessions", "DELETE /api/v1/sessions/:id", "POST /api/v1/signout", "POST /api/v1/signout/everywhere", "POST /api/v1/account/email", "POST /api/v1/account/email/confirm", "POST /api/v1/connect/lookup", "POST /api/v1/connect/confirm", "POST /api/v1/connect/refuse", "GET /api/v1/tokens", "PATCH /api/v1/tokens/:id", "DELETE /api/v1/tokens/:id", "PUT /api/v1/tours/:id/access", "PUT /api/v1/media/:id/access", "GET /api/v1/terms", "GET /api/v1/terms/agreed", "POST /api/v1/terms/agree"];
/** The site admin's operations: an admin's session alone, and a 404 (never a 401) to everyone else. */
const ADMIN_ONLY = [
  "GET /api/v1/admin/summary",
  "GET /api/v1/admin/accounts",
  "PATCH /api/v1/admin/workspaces/:id",
  "POST /api/v1/admin/accounts/:id/disable",
  "POST /api/v1/admin/accounts/:id/enable",
  "GET /api/v1/admin/accounts/:id/removal",
  "DELETE /api/v1/admin/accounts/:id",
  "POST /api/v1/admin/invites",
  "GET /api/v1/admin/invites",
  "POST /api/v1/admin/invites/:id/resend",
  "DELETE /api/v1/admin/invites/:id",
];

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
    // With billing on, so its routes are in the table (each is listed in UNDOCUMENTED_ROUTES).
    const app = createApp({ config: BILLING_CONFIG } as Deps);
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
    expect(s.UploadCreate.properties.logo_bytes).toMatchObject({ type: "integer", minimum: 1, maximum: LOGO_RULE.maxBytes });
    expect(s.UploadCreate.required).toEqual(["manifest", "target"]);

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
    expect(doc.tags.map((t) => t.name)).toEqual(["Tours", "Uploads", "Items", "Workspace", "Accounts", "Connections", "Admin", "Viewers", "Server"]);
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
      // An admin operation answers everyone who is not an admin as if it did not exist: 404, never 401.
      expect(statuses.includes("401"), `${key}: 401`).toBe(!PUBLIC.includes(key) && !ADMIN_ONLY.includes(key));
      if (ADMIN_ONLY.includes(key)) expect(statuses, key).toContain("404");
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
      "Who may view a tour",
      "Change who may view a tour",
      "List a tour's chapters",
      "Reorder and remove a tour's chapters",
      "Unpublish a tour",
      "Get a draft step's image",
      "Start an upload",
      "Send one step's image",
      "Send the logo",
      "Finish an upload",
      "Cancel an upload",
      "Start a shared item",
      "List the workspace's shared items",
      "Who may view a shared item",
      "Change who may view a shared item",
      "Get one shared item",
      "Delete a shared item",
      "Send one part of an item",
      "Send an item's preview",
      "Get an item's preview",
      "Finish a shared item",
      "The workspace and the server version",
      "The workspace's storage use",
      "The workspace's ten largest tours, images and GIFs",
      "Ask for a sign-in link",
      "Finish signing in",
      "Look up an invite",
      "Accept an invite",
      "The session and who it is",
      "List the account's sessions",
      "End one of the account's sessions",
      "Sign out",
      "Sign out everywhere",
      "Ask to change the email address",
      "Finish changing the email address",
      "The site's terms and the account's agreement",
      "The terms the account agreed to",
      "Agree to the site's terms",
      "Ask to connect the app",
      "Ask for the app's token",
      "Look up a request by its short code",
      "Confirm a request to connect",
      "Refuse a request to connect",
      "List the workspace's tokens",
      "Rename a token",
      "Revoke a token",
      "Every account's storage use in all",
      "List every account's storage use",
      "Set a workspace's storage allowance",
      "Disable an account",
      "Enable a disabled account",
      "What deleting an account removes",
      "Delete a disabled account, in steps",
      "Invite an address",
      "List the invites",
      "Send an invite again",
      "Cancel an invite",
      "Ask for a link to view a shared tour",
      "Look up a viewer link",
      "Prove the address of a viewer link",
      "End this browser's viewer session",
      "The address this browser proved",
      "Ask for a link to view a shared image or clip",
      "Look up a viewer link for an image or clip",
      "Prove the address of a viewer link for an image or clip",
      "End this browser's viewer session for images and clips",
      "The address this browser proved for images and clips",
      "Whether the server is up",
    ]);
  });

  it("usage is described with the fields it answers, closed", () => {
    const doc = openapi();
    const op = operations(doc).find((o) => o.key === "GET /api/v1/usage")!.op;
    expect(op.tags).toEqual(["Workspace"]);
    expect(op.operationId).toBe("getUsage");
    expect(Object.keys(op.responses)).toEqual(["200", "401"]);
    expect(op.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Usage" });
    const usage = (doc.components.schemas as Json).Usage;
    const fields = ["used_bytes", "allowance_bytes", "over", "tours", "images", "gifs", "counted"];
    expect(Object.keys(usage.properties)).toEqual(fields);
    expect(usage.required).toEqual(fields);
    expect(usage.additionalProperties).toBe(false);
    expect(usage.properties.allowance_bytes.type).toEqual(["integer", "null"]);
    const counted = ["pictures", "logos", "uploads_in_progress", "images", "gifs"];
    expect(Object.keys(usage.properties.counted.properties)).toEqual(counted);
    expect(usage.properties.counted.required).toEqual(counted);
    expect(usage.properties.counted.additionalProperties).toBe(false);
    // What is counted and what is not is said where a client reads it.
    for (const text of ["published", "24 hours", "No limit", "never deletes"]) expect(op.description, text).toContain(text);
    // Shared items: how an unfinished one counts, that only online ones are counted as items, and that counted adds up.
    for (const text of ["every shared image and clip", "an item being deleted counts until then", "not in uploads_in_progress", "items that are online", "add up to used_bytes"]) expect(op.description, text).toContain(text);
    expect(usage.properties.counted.description).toContain("The five numbers add up to used_bytes.");
    expect(usage.properties.used_bytes.description).toContain("the five numbers of counted together");
  });

  it("the create's 413 has two documented forms", () => {
    const doc = openapi();
    const res = operations(doc).find((o) => o.key === "POST /api/v1/uploads")!.op.responses["413"];
    const shapes = res.content["application/json"].schema.oneOf as Json[];
    expect(shapes).toHaveLength(2);
    // The request is too long: the plain refusal, as before.
    expect(shapes[0].properties.error.enum).toEqual(["too_large"]);
    expect(shapes[0].additionalProperties).toBe(false);
    // The workspace's storage is full: the closed schema StorageFull, with the three numbers.
    expect(shapes[1]).toEqual({ $ref: "#/components/schemas/StorageFull" });
    const full = (doc.components.schemas as Json).StorageFull;
    const fields = ["error", "detail", "used_bytes", "allowance_bytes", "needed_bytes"];
    expect(Object.keys(full.properties)).toEqual(fields);
    expect(full.required).toEqual(fields);
    expect(full.additionalProperties).toBe(false);
    expect(full.properties.error.enum).toEqual(["storage_full"]);
    for (const f of fields.slice(2)) expect(full.properties[f], f).toMatchObject({ type: "integer", minimum: 0 });
    expect(res.description).toContain("storage_full");
    expect(res.description).toContain("too_large");
    // No other request answers storage_full: only starting an upload or a shared item, and
    // sending an item's preview (whose size is counted when it is sent), is ever refused for storage.
    const forStorage = ["POST /api/v1/uploads", "POST /api/v1/media", "PUT /api/v1/media/:id/preview"];
    for (const { key, op } of operations(doc)) {
      expect(JSON.stringify(op.responses).includes("StorageFull"), key).toBe(forStorage.includes(key));
    }
    // Each says so in its 413, beside its other forms.
    for (const key of forStorage.slice(1)) {
      const r = operations(doc).find((o) => o.key === key)!.op.responses["413"];
      expect(r.description, key).toContain("storage_full");
      expect(r.content["application/json"].schema.oneOf.at(-1), key).toEqual({ $ref: "#/components/schemas/StorageFull" });
    }
    // The limits section and the create's own text both say it.
    expect(doc.info.description).toContain("413 `storage_full`");
    expect(operations(doc).find((o) => o.key === "POST /api/v1/uploads")!.op.description).toContain("storage_full");
  });

  it("health, the description and the two sign-in requests are the only public operations", async () => {
    const doc = openapi();
    // The session cookie is the second way to call, beside the token.
    // The viewer cookie is a third, for the one request that says which address a visitor proved, and no credential of any other.
    expect(doc.components.securitySchemes).toEqual({
      token: { type: "http", scheme: "bearer" },
      session: { type: "apiKey", in: "cookie", name: "__Host-dp_session" },
      viewer: { type: "apiKey", in: "cookie", name: "__Host-dp_viewer" },
      mediaViewer: { type: "apiKey", in: "cookie", name: "__Host-dp_media_viewer" },
    });
    const keys = operations(doc).map((o) => o.key);
    for (const key of [...PUBLIC, ...SESSION_ONLY, ...ADMIN_ONLY, ...VIEWER_ONLY]) expect(keys, key).toContain(key);
    for (const { key, op } of operations(doc)) {
      const sessionOnly = SESSION_ONLY.includes(key) || ADMIN_ONLY.includes(key);
      const want = PUBLIC.includes(key) ? [] : VIEWER_ONLY.includes(key) ? [key.includes("/media-view/") ? { mediaViewer: [] } : { viewer: [] }] : sessionOnly ? [{ session: [] }] : [{ token: [] }, { session: [] }];
      if (VIEWER_ONLY.includes(key)) expect(op.description, key).toContain("cannot be tried from the documentation page");
      expect(op.security, key).toEqual(want);
      // An operation a session may call says that the documentation page cannot try it with one.
      if (sessionOnly) expect(op.description, key).toContain("cannot be tried from the documentation page");
      // Every admin operation is tagged Admin, and only those are.
      expect(op.tags[0] === "Admin", key).toBe(ADMIN_ONLY.includes(key));
    }
    // The description itself is served to anyone, without a credential.
    const { deps } = await makeDeps();
    for (const path of ["/api/v1/openapi.json", "/api/v1/openapi.yaml"]) expect((await send(deps, "GET", path)).status, path).toBe(200);
    // What a session change needs, and what a request with both credentials gets, is said where a client reads it.
    for (const text of ["X-Csrf-Token", "GET /api/v1/session", "mixed_credentials", "bad_origin", "bad_csrf", "never sends a cookie"]) expect(doc.info.description, text).toContain(text);
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
    const fields = ["id", "title", "status", "slug", "url", "chapters", "steps", "bytes", "updated_at", "published_at", "unpublished_changes", "access", "viewers"];
    expect(Object.keys(tour.properties)).toEqual(fields);
    expect(tour.required).toEqual(fields);
    expect(tour.additionalProperties).toBe(false);
    expect(tour.properties.unpublished_changes.type).toBe("boolean");
    expect(tour.properties.bytes).toMatchObject({ type: "integer", minimum: 0 });
    // The size is counted as the usage counts storage, and says so.
    for (const text of ["logo", "GET /api/v1/usage"]) expect(tour.properties.bytes.description, text).toContain(text);
  });

  it("the largest tours and the admin's summary are described with the fields they answer, closed", () => {
    const doc = openapi();
    const s = doc.components.schemas as Json;
    const largest = operations(doc).find((o) => o.key === "GET /api/v1/usage/largest")!.op;
    expect([largest.tags, largest.operationId, Object.keys(largest.responses)]).toEqual([["Workspace"], "getLargestTours", ["200", "401"]]);
    expect(largest.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/LargestTours" });
    expect(s.LargestTours).toMatchObject({ required: ["tours", "largest"], additionalProperties: false });
    expect(s.LargestTours.properties.tours.maxItems).toBe(10);
    const item = s.LargestTours.properties.tours.items;
    expect([Object.keys(item.properties), item.required, item.additionalProperties]).toEqual([["id", "title", "bytes"], ["id", "title", "bytes"], false]);
    for (const text of ["the 10 largest tours", "largest first", "order of their id"]) expect(largest.description, text).toContain(text);
    // The list of every kind: its entries name their kind, and an item may have no title.
    expect(s.LargestTours.properties.largest.maxItems).toBe(10);
    const entry = s.LargestTours.properties.largest.items;
    expect([Object.keys(entry.properties), entry.required, entry.additionalProperties]).toEqual([["kind", "id", "title", "bytes"], ["kind", "id", "title", "bytes"], false]);
    expect(entry.properties.kind.enum).toEqual(["tour", "image", "gif"]);
    expect(entry.properties.title.type).toEqual(["string", "null"]);
    expect(entry.properties.id.pattern).toBe("^(tour|med)_[0-9a-f]{24}$");
    for (const text of ["the 10 largest things of every kind", "still being sent", "not one being deleted"]) expect(largest.description, text).toContain(text);

    const summary = operations(doc).find((o) => o.key === "GET /api/v1/admin/summary")!.op;
    expect([summary.tags, summary.operationId, Object.keys(summary.responses)]).toEqual([["Admin"], "adminSummary", ["200", "404"]]);
    expect(summary.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/AdminSummary" });
    const fields = ["accounts", "used_bytes", "standard_allowance_bytes"];
    // billing_problems and billing_price only on a site with billing switched on.
    expect([Object.keys(s.AdminSummary.properties), s.AdminSummary.required, s.AdminSummary.additionalProperties]).toEqual([[...fields, "billing_problems", "billing_price"], fields, false]);
    expect(s.AdminSummary.properties.standard_allowance_bytes.type).toEqual(["integer", "null"]);
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
