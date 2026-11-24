// The API description (src/docs/openapi.ts) against what the site really answers, on both
// targets. The description must not be able to say something the site does not do.
//
// Every request below goes to the real routes through the harness, and client() checks
// each answer against the description: the status must be one the request's entry lists,
// the content type the one it names, the body must fit the schema for that status (answer
// schemas are closed, so a field the site sends that the description lacks fails, and so
// does a required field the site leaves out), a status without a body must have none, and
// every header the description states must be there with a value that fits. For an
// accepted request, the path values and the JSON body sent must fit what the description
// asks for, too.
//
// Each answer is also recorded as a "case": the request, its status and, where the
// description gives one status several forms, which form (the error code, the shape of a
// oneOf, the image type, with or without an optional field). The last test fails when a
// documented case was never reached and is not in NOT_EXERCISED with its reason, so
// nothing the description says goes unchecked in silence. That test needs the whole file
// to have run: on its own (vitest -t) it fails, by design.
//
// Where the description and the code disagree, the code wins: correct src/docs/openapi.ts
// and run `npm run build:docs`. Never change a route to fit the description.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount, seedWorkspace } from "#harness";
import { encodeAccountCursor } from "../src/admin-api.ts";
import { createApp } from "../src/app.ts";
import { SUBSCRIPTION_ENDED } from "../src/billing.ts";
import { TRIAL_MS } from "../src/billing-rules.ts";
import { newId } from "../src/auth.ts";
import { MAX_CHAPTERS } from "../src/chapters.ts";
import { setClientAddress } from "../src/client.ts";
import { UNDOCUMENTED_ROUTES, openapi } from "../src/docs/openapi.ts";
import type { Deps } from "../src/ports.ts";
import { COPY_BATCH } from "../src/publish.ts";
import { LIMITS_MEDIA, workspaceKey } from "../src/rate.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { parseTerms, publishTerms } from "../src/terms.ts";
import { DELETE_FILES_PER_CALL } from "../src/tours.ts";
import { DEFAULT_MAX_OPEN_UPLOADS } from "../src/uploads.ts";
import { VERSION } from "../src/version.ts";
import { useViewerGate } from "../src/viewers.ts";
import { ORIGIN, clone, fixtures, gif, jpeg, logoPng, mp4, png, send, sha256Hex, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";
import { check, deref, KEYWORDS, keywordsOf } from "./openapi-schema.ts";
import { sessionOf, withBilling } from "./fake-stripe.ts";

/**
 * Documented cases no test reaches, each with the reason. A case is written as the last
 * test prints it, such as "DELETE /api/v1/tours/{id} 500 cleanup_pending". A case that is
 * listed here and reached anyway also fails, so the list cannot go stale.
 *
 * It is empty: every documented case is reached. These are reached only with help, which
 * the test that does it says in a comment; the route and its answer are always the real ones:
 * - DELETE /api/v1/tours/{id} 202 and POST /api/v1/tours/{id}/unpublish 202 need hundreds
 *   or thousands of files, so rows naming files that do not exist are written to the
 *   database first (removing a file that is already gone is not an error).
 * - The three 500 answers (cleanup_pending twice, publish_failed) need a store that
 *   fails: a store's delete is made to throw, or a draft image is removed from the store.
 * - POST /api/v1/tours/{id}/publish 409 publish_busy needs the draft to change twice at
 *   the moment a publish starts: a hook on the database's batch changes it.
 * - POST /api/v1/tours/{id}/publish 400 empty_tour needs a tour without steps, which no
 *   request can make: its row is written to the database.
 * - GET /api/v1/me 404 needs a token whose workspace is gone, which the database's own
 *   rules forbid: the one read of the workspace's name is made to find nothing.
 */
const NOT_EXERCISED: Readonly<Record<string, string>> = {};

const DOC = openapi();
const JSON_TYPE = "application/json";
const JSON_HEADERS = { "content-type": JSON_TYPE };

type Op = { key: string; method: string; path: string; re: RegExp; op: Json };

/** Every operation of the description, with a pattern that matches its real addresses. */
const OPS: Op[] = Object.entries(DOC.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({
    key: `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    path,
    re: new RegExp("^" + path.replace(/\{([a-z_]+)\}/g, "(?<$1>[^/]+)") + "$"),
    op: op as Json,
  })),
);

/** The cases reached so far in this file, with how often. */
const seen = new Map<string, number>();

/** A response of an operation, with a reference into components followed. */
function responseOf(op: Op, status: string): Json {
  return deref(DOC, op.op.responses[status] as Json) as Json;
}

/** The name of one shape of a oneOf: its schema's name, or its place in the list. */
function shapeName(branch: Json, i: number): string {
  return typeof branch.$ref === "string" ? branch.$ref.slice(branch.$ref.lastIndexOf("/") + 1) : `shape ${i + 1}`;
}

/**
 * The forms one schema gives a status: one per error code, else two per optional field
 * (with and without it), else just the one. With a `value`, only the forms that value is.
 */
function forms(label: string, schema: Json, value: Json | null): string[] {
  const codes = schema.properties?.error?.enum as string[] | undefined;
  if (codes !== undefined) return value === null ? codes.map((c) => `${label} ${c}`) : [`${label} ${value.error}`];
  const required = (schema.required ?? []) as string[];
  const optional = Object.keys(schema.properties ?? {}).filter((p) => !required.includes(p));
  if (optional.length === 0) return [label];
  return optional.flatMap((p) => (value === null ? [`${label} with ${p}`, `${label} without ${p}`] : [`${label} ${Object.hasOwn(value, p) ? "with" : "without"} ${p}`]));
}

/** Every case the description documents. */
function documentedCases(): string[] {
  const out: string[] = [];
  for (const op of OPS) {
    for (const status of Object.keys(op.op.responses)) {
      const res = responseOf(op, status);
      const base = `${op.key} ${status}`;
      if (res.content === undefined) {
        out.push(base);
        continue;
      }
      const types = Object.keys(res.content);
      for (const type of types) {
        const label = types.length > 1 ? `${base} ${type}` : base;
        const schema = deref(DOC, res.content[type].schema) as Json;
        if (Array.isArray(schema.oneOf)) {
          (schema.oneOf as Json[]).forEach((branch, i) => out.push(...forms(`${label} as ${shapeName(branch, i)}`, deref(DOC, branch) as Json, null)));
        } else out.push(...forms(label, schema, null));
      }
    }
  }
  return out;
}

/** What is wrong with the lists: cases neither reached nor excused, excused ones that were reached, and excuses for nothing. */
function coverageProblems(documented: string[], reached: (c: string) => boolean, excused: Readonly<Record<string, string>>) {
  return {
    neverReached: documented.filter((c) => !reached(c) && !Object.hasOwn(excused, c)),
    excusedButReached: Object.keys(excused).filter((c) => reached(c)),
    excusedButNotDocumented: Object.keys(excused).filter((c) => !documented.includes(c)),
    excusedWithoutReason: Object.entries(excused).filter(([, reason]) => reason.trim().length < 20).map(([c]) => c),
  };
}

type Opts = NonNullable<Parameters<typeof send>[3]>;

/** Checks one real answer against the description and records its case. Throws with what differs. */
function verify(method: string, path: string, opts: Opts, call: Call): void {
  const address = path.split("?")[0];
  const op = OPS.find((o) => o.method === method && o.re.test(address));
  if (op === undefined) throw new Error(`${method} ${address} is not a request the description has; send it with send(), not through client()`);
  const status = String(call.status);
  const where = `${op.key} answered ${status}`;
  const fix = "the code wins: correct src/docs/openapi.ts and run npm run build:docs";
  if (!Object.hasOwn(op.op.responses, status)) throw new Error(`${where} (${call.text.slice(0, 160)}), a status the description does not list for it; ${fix}`);
  const res = responseOf(op, status);

  for (const [name, header] of Object.entries((res.headers ?? {}) as Record<string, Json>)) {
    const raw = call.headers.get(name);
    if (raw === null) throw new Error(`${where} without the header ${name} the description states; ${fix}`);
    const schema = deref(DOC, header.schema) as Json;
    const value = schema.type === "integer" && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : raw;
    const problems = check(DOC, schema, value, `header ${name}`);
    if (problems.length > 0) throw new Error(`${where} with a header that differs from the description: ${problems.join("; ")}; ${fix}`);
  }

  const cases: string[] = [];
  const base = `${op.key} ${status}`;
  if (res.content === undefined) {
    if (call.bytes.byteLength !== 0) throw new Error(`${where} with a body (${call.text.slice(0, 160)}) where the description has none; ${fix}`);
    cases.push(base);
  } else {
    const types = Object.keys(res.content);
    const type = (call.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!types.includes(type)) throw new Error(`${where} as ${type || "no content type"}, the description says ${types.join(" or ")}; ${fix}`);
    let value: unknown = call.bytes;
    if (type === JSON_TYPE) {
      try {
        value = JSON.parse(call.text);
      } catch {
        throw new Error(`${where} as JSON that does not parse: ${call.text.slice(0, 160)}`);
      }
    }
    const declared = res.content[type].schema as Json;
    const problems = check(DOC, declared, value);
    if (problems.length > 0) throw new Error(`${where} with a body that differs from the description: ${problems.join("; ")}; ${fix}`);
    const label = types.length > 1 ? `${base} ${type}` : base;
    const schema = deref(DOC, declared) as Json;
    if (Array.isArray(schema.oneOf)) {
      // check() passed, so exactly one shape fits.
      const i = (schema.oneOf as Json[]).findIndex((branch) => check(DOC, branch, value).length === 0);
      cases.push(...forms(`${label} as ${shapeName(schema.oneOf[i], i)}`, deref(DOC, schema.oneOf[i]) as Json, value as Json));
    } else cases.push(...forms(label, schema, type === JSON_TYPE ? (value as Json) : null));
  }

  // A request the site accepted must itself be one the description allows.
  if (call.status < 300) {
    const groups = op.re.exec(address)?.groups ?? {};
    for (const p of (op.op.parameters ?? []) as Json[]) {
      const raw = decodeURIComponent(groups[p.name] ?? "");
      const schema = deref(DOC, p.schema) as Json;
      const value = schema.type === "integer" && /^-?[0-9]+$/.test(raw) ? Number(raw) : raw;
      const problems = check(DOC, schema, value, `{${p.name}}`);
      if (problems.length > 0) throw new Error(`${where} to a path value the description does not allow: ${problems.join("; ")}; ${fix}`);
    }
    const body = op.op.requestBody as Json | undefined;
    const sent = opts.body !== undefined && opts.body !== null;
    if (body === undefined && sent) throw new Error(`${where} to a request with a body, and the description gives it none; ${fix}`);
    if (body?.required === true && !sent) throw new Error(`${where} to a request without the body the description requires; ${fix}`);
    if (body?.content?.[JSON_TYPE] !== undefined && typeof opts.body === "string") {
      const problems = check(DOC, body.content[JSON_TYPE].schema, JSON.parse(opts.body), "request");
      if (problems.length > 0) throw new Error(`${where} to a body the description does not allow: ${problems.join("; ")}; ${fix}`);
    }
  }

  for (const c of cases) seen.set(c, (seen.get(c) ?? 0) + 1);
}

type Target = { kind: "new" } | { kind: "chapter"; tour_id: string } | { kind: "replace"; tour_id: string; chapter_id: string };
type Committed = { tour_id: string; chapter_id: string; steps: number; publish?: string };
const NEW: Target = { kind: "new" };

/** The API's requests on `deps`, every answer checked against the description. */
function client(deps: Deps) {
  const call = async (method: string, path: string, opts: Opts = {}): Promise<Call> => {
    const r = await send(deps, method, path, opts);
    verify(method, path, opts, r);
    return r;
  };
  const withJson = (token: string | null, body: unknown): Opts => ({ token, body: typeof body === "string" ? body : JSON.stringify(body), headers: JSON_HEADERS });
  const bytes = (token: string | null, body: Uint8Array): Opts => ({ token, body: body as NonNullable<RequestInit["body"]> });
  const api = {
    call,
    health: (origin?: string) => call("GET", "/healthz", origin === undefined ? {} : { origin }),
    me: (token: string | null, origin?: string) => call("GET", "/api/v1/me", origin === undefined ? { token } : { token, origin }),
    usage: (token: string | null) => call("GET", "/api/v1/usage", { token }),
    largest: (token: string | null) => call("GET", "/api/v1/usage/largest", { token }),
    list: (token: string | null) => call("GET", "/api/v1/tours", { token }),
    rename: (token: string | null, tourId: string, body: unknown) => call("PATCH", `/api/v1/tours/${tourId}`, withJson(token, body)),
    del: (token: string | null, tourId: string) => call("DELETE", `/api/v1/tours/${tourId}`, { token }),
    publish: (token: string | null, tourId: string, body?: unknown) => call("POST", `/api/v1/tours/${tourId}/publish`, body === undefined ? { token } : withJson(token, body)),
    unpublish: (token: string | null, tourId: string) => call("POST", `/api/v1/tours/${tourId}/unpublish`, { token }),
    access: (token: string | null, tourId: string) => call("GET", `/api/v1/tours/${tourId}/access`, { token }),
    chapters: (token: string | null, tourId: string) => call("GET", `/api/v1/tours/${tourId}/chapters`, { token }),
    setChapters: (token: string | null, tourId: string, body: unknown) => call("PUT", `/api/v1/tours/${tourId}/chapters`, withJson(token, body)),
    accessBySession: (session: { cookie: string; csrf: string }, tourId: string) => call("GET", `/api/v1/tours/${tourId}/access`, { headers: { cookie: session.cookie } }),
    /** Sent with a session (only a session may change who views a tour): its Cookie, anti-forgery value and this address as Origin. */
    setAccess: (session: { cookie: string; csrf: string }, tourId: string, body: unknown) =>
      call("PUT", `/api/v1/tours/${tourId}/access`, {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { ...JSON_HEADERS, cookie: session.cookie, "x-csrf-token": session.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin" },
      }),
    image: (token: string | null, tourId: string, stepId: string) => call("GET", `/api/v1/tours/${tourId}/steps/${stepId}/image`, { token }),
    create: (token: string | null, manifest: unknown, target: unknown = NEW, sha256?: string[]) =>
      call("POST", "/api/v1/uploads", withJson(token, sha256 === undefined ? { manifest, target } : { manifest, target, sha256 })),
    step: (token: string | null, uploadId: string, n: number, body: Uint8Array) => call("PUT", `/api/v1/uploads/${uploadId}/steps/${n}`, bytes(token, body)),
    logo: (token: string | null, uploadId: string, body: Uint8Array) => call("PUT", `/api/v1/uploads/${uploadId}/logo`, bytes(token, body)),
    commit: (token: string | null, uploadId: string) => call("POST", `/api/v1/uploads/${uploadId}/commit`, { token }),
    cancel: (token: string | null, uploadId: string) => call("DELETE", `/api/v1/uploads/${uploadId}`, { token }),

    /** Publishes until it is no longer in progress; every answer on the way is checked. */
    async publishAll(token: string, tourId: string): Promise<Call> {
      let r = await api.publish(token, tourId);
      for (let i = 0; r.status === 202; i++) {
        if (i > 50) throw new Error("publish does not finish");
        r = await api.publish(token, tourId, { publish_id: r.json.publish_id });
      }
      expect(r.status, r.text).toBe(200);
      return r;
    },

    /** A whole upload into a new tour or a new chapter: start, every image, the logo if one is due, finish. `pics[i]` picks step i's bytes. */
    async upload(token: string, manifest: Json, target: Target = NEW, pics: number[] = []): Promise<Committed> {
      const created = await api.create(token, manifest, target);
      expect(created.status, created.text).toBe(201);
      const id = created.json.upload_id as string;
      for (let i = 0; i < manifest.steps.length; i++) expect((await api.step(token, id, i + 1, stepImage(manifest.steps[i], pics[i] ?? 0))).status).toBe(204);
      if (manifest.cover?.logo && target.kind === "new") expect((await api.logo(token, id, logoPng())).status).toBe(204);
      const done = await api.commit(token, id);
      expect(done.status, done.text).toBe(201);
      return done.json;
    },

    /** Starts the replacement of a chapter with a hash per picture and sends the pictures the site lacks. Does not finish it. */
    async startReplace(token: string, at: { tour_id: string; chapter_id: string }, manifest: Json, pics: number[]): Promise<{ id: string; have: number[]; settings: boolean }> {
      const hashes = await Promise.all((manifest.steps as Json[]).map((s, i) => sha256Hex(stepImage(s, pics[i] ?? 0))));
      const created = await api.create(token, manifest, { kind: "replace", ...at }, hashes);
      expect(created.status, created.text).toBe(201);
      const id = created.json.upload_id as string;
      const have = created.json.have as number[];
      for (let i = 0; i < manifest.steps.length; i++) {
        if (!have.includes(i + 1)) expect((await api.step(token, id, i + 1, stepImage(manifest.steps[i], pics[i] ?? 0))).status).toBe(204);
      }
      return { id, have, settings: created.json.settings };
    },
  };
  return api;
}

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
/** A JSON body sent past client(), for a request a test makes while another is being answered. */
const withJsonBody = (token: string, body: unknown) => ({ token, body: JSON.stringify(body), headers: JSON_HEADERS });

/** A manifest of `n` small PNG steps. With different `pics` in upload(), the steps' bytes differ. */
function small(n: number, title = "Small tour"): Json {
  const m = clone(v2);
  m.title = title;
  const base = m.steps[1];
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120 }));
  return m;
}

/** Two workspaces; images a publish replaced are removed at once. */
async function setup(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps({ retiredGraceMs: 0, ...config });
  const a = await seedWorkspace(ctx.deps, "Workspace A");
  const b = await seedWorkspace(ctx.deps, "Workspace B");
  return { ...ctx, a, b };
}

const stepIds = async (deps: Deps, tourId: string) =>
  (await deps.db.all<{ id: string }>("SELECT s.id FROM step s JOIN chapter c ON c.id = s.chapter_id WHERE s.tour_id = ? ORDER BY c.position, s.position", [tourId])).map((r) => r.id);

/** What a refusal must be: the status and the error code. */
function refused(r: Call, status: number, code: string): void {
  expect([r.status, r.json?.error], r.text).toEqual([status, code]);
}

const TOUR_FIELDS = ["id", "title", "status", "slug", "url", "chapters", "steps", "bytes", "updated_at", "published_at", "unpublished_changes", "access", "viewers"];
const NO_TOUR = "tour_" + "0".repeat(24);
const NO_UPLOAD = "up_" + "0".repeat(24);
const NO_STEP = "st_" + "0".repeat(24);
const NO_CHAPTER = "ch_" + "0".repeat(24);
const NO_WORKSPACE = "ws_" + "0".repeat(24);
/** Well formed and known to no server: the placeholder the plan allows in tests. */
const NO_TOKEN = "dp_" + "0".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
  useViewerGate(null);
});

describe("the description against the real answers", { timeout: 120_000 }, () => {
  it("every answer of a full upload, publish, list, rename, replace, unpublish and delete is as documented", async () => {
    const { deps, a } = await setup();
    const api = client(deps);

    expect((await api.health()).json).toEqual({ ok: true });
    expect((await api.me(a.token)).json).toEqual({ workspace: "Workspace A", version: VERSION });
    // Usage: nothing yet, and no limit unless the site or the workspace has one.
    expect((await api.usage(a.token)).json).toEqual({ used_bytes: 0, allowance_bytes: null, over: false, tours: 0, images: 0, gifs: 0, counted: { pictures: 0, logos: 0, uploads_in_progress: 0, images: 0, gifs: 0 } });

    // A new tour with a logo, request by request.
    const created = await api.create(a.token, v3);
    expect(created.json).toEqual({ upload_id: created.json.upload_id, steps: 3 });
    const up = created.json.upload_id as string;
    for (let i = 0; i < 3; i++) expect((await api.step(a.token, up, i + 1, stepImage(v3.steps[i]))).status).toBe(204);
    expect((await api.logo(a.token, up, logoPng())).status).toBe(204);
    const committed = await api.commit(a.token, up);
    expect(committed.status).toBe(201);
    const t = committed.json as Committed;
    expect(Object.keys(t).sort()).toEqual(["chapter_id", "steps", "tour_id"]);
    // A repeated commit answers the same.
    expect((await api.commit(a.token, up)).json).toEqual(t);

    // The list's items have exactly the documented fields, for a draft and a published tour.
    const draft = (await api.list(a.token)).json.tours as Json[];
    expect(draft).toHaveLength(1);
    expect(Object.keys(draft[0])).toEqual(TOUR_FIELDS);
    expect(draft[0]).toMatchObject({ id: t.tour_id, status: "draft", url: null, published_at: null, chapters: 1, steps: 3, unpublished_changes: false });
    // Its size is its steps' pictures and its logo, as the usage counts them; the largest tours say the same.
    const counted = (await api.usage(a.token)).json.counted;
    expect(draft[0].bytes).toBe(counted.pictures + counted.logos);
    expect((await api.largest(a.token)).json).toEqual({ tours: [{ id: t.tour_id, title: draft[0].title, bytes: draft[0].bytes }], largest: [{ kind: "tour", id: t.tour_id, title: draft[0].title, bytes: draft[0].bytes }] });

    // A draft step image is the type its bytes are, and carries its sandbox policy.
    const steps = await stepIds(deps, t.tour_id);
    const first = await api.image(a.token, t.tour_id, steps[0]);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect([...first.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(first.bytes).toEqual(stepImage(v3.steps[0]));
    expect(first.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const third = await api.image(a.token, t.tour_id, steps[2]);
    expect(third.headers.get("content-type")).toBe("image/jpeg");
    expect([...third.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);

    expect((await api.rename(a.token, t.tour_id, { title: "  Renamed  " })).json).toEqual({ id: t.tour_id, title: "Renamed" });

    // Replacing a chapter of a draft: publishing would have nothing to do with it.
    const one = await api.startReplace(a.token, t, small(2, "First"), [5, 6]);
    expect([one.have, one.settings]).toEqual([[], true]);
    const replaced = await api.commit(a.token, one.id);
    expect(replaced.json).toEqual({ tour_id: t.tour_id, chapter_id: t.chapter_id, steps: 2, publish: "draft" });
    expect((await api.commit(a.token, one.id)).json).toEqual(replaced.json);

    const live = await api.publish(a.token, t.tour_id);
    expect(live.status).toBe(200);
    expect(live.json).toEqual({ slug: draft[0].slug, url: `/t/${draft[0].slug}`, steps: 2, access: "public", viewers: 0 });
    const published = (await api.list(a.token)).json.tours as Json[];
    expect(Object.keys(published[0])).toEqual(TOUR_FIELDS);
    expect(published[0]).toMatchObject({ status: "published", url: live.json.url, unpublished_changes: false });
    expect(typeof published[0].published_at).toBe("number");

    // A new chapter waits in the draft, and the list says so.
    const more = await api.upload(a.token, small(2, "Second"), { kind: "chapter", tour_id: t.tour_id }, [1, 2]);
    expect(more.tour_id).toBe(t.tour_id);
    expect(((await api.list(a.token)).json.tours as Json[])[0]).toMatchObject({ chapters: 2, steps: 4, unpublished_changes: true });

    // Replacing that chapter, never published: the draft holds more than this replace.
    const two = await api.startReplace(a.token, more, small(2, "Second"), [1, 3]);
    expect([two.have, two.settings]).toEqual([[1], false]);
    // A step the site already has is not to be sent.
    refused(await api.step(a.token, two.id, 1, stepImage(small(2).steps[0], 1)), 409, "already_sent");
    expect((await api.commit(a.token, two.id)).json.publish).toBe("other_changes");
    // Once all of it is live, a replace is the only change waiting.
    await api.publishAll(a.token, t.tour_id);
    const three = await api.startReplace(a.token, more, small(2, "Second"), [1, 4]);
    expect((await api.commit(a.token, three.id)).json.publish).toBe("ready");

    expect((await api.unpublish(a.token, t.tour_id)).status).toBe(204);
    expect((await api.unpublish(a.token, t.tour_id)).status).toBe(204); // a draft answers the same

    // A declared logo size: the upload starts, a logo of another length is refused, the right one is taken.
    const sized = await api.call("POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ manifest: v3, target: NEW, logo_bytes: 1000 }), headers: JSON_HEADERS });
    expect(sized.status, sized.text).toBe(201);
    refused(await api.logo(a.token, sized.json.upload_id, logoPng(999)), 400, "bad_image");
    expect((await api.logo(a.token, sized.json.upload_id, logoPng(1000))).status).toBe(204);
    expect((await api.cancel(a.token, sized.json.upload_id)).status).toBe(204);
    refused(await api.call("POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ manifest: v3, target: NEW, logo_bytes: 0 }), headers: JSON_HEADERS }), 400, "bad_request");

    // The oldest manifest version starts an upload as well.
    const open = await api.create(a.token, fixtures.v1);
    expect((await api.cancel(a.token, open.json.upload_id)).status).toBe(204);
    expect((await api.cancel(a.token, open.json.upload_id)).status).toBe(204); // gone already

    expect((await api.del(a.token, t.tour_id)).json).toEqual({ deleted: true });
    refused(await api.del(a.token, t.tour_id), 404, "not_found");
    expect((await api.list(a.token)).json).toEqual({ tours: [] });
  });

  it("the answers of work done in steps are as documented: publish, unpublish and delete in progress", async () => {
    const { deps, a } = await setup();
    const api = client(deps);
    const total = COPY_BATCH + 1;
    const t = await api.upload(a.token, small(total));

    const started = await api.publish(a.token, t.tour_id);
    expect(started.status).toBe(202);
    expect(started.json).toEqual({ status: "in_progress", publish_id: started.json.publish_id, done: COPY_BATCH, total, access: "public", viewers: 0 });
    // A publish in progress stops a delete.
    refused(await api.del(a.token, t.tour_id), 409, "publish_busy");
    const finished = await api.publish(a.token, t.tour_id, { publish_id: started.json.publish_id });
    expect([finished.status, finished.json.steps]).toEqual([200, total]);
    // The same answer however often it is asked.
    expect((await api.publish(a.token, t.tour_id, { publish_id: started.json.publish_id })).json).toEqual(finished.json);

    // Unpublish answers 202 only with more than 2,000 public images to remove. Help: rows
    // for 2,001 images an earlier publish would have left are written to the database;
    // the files do not exist, and removing a file that is gone is not an error.
    await deps.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2001)
       INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after)
       SELECT 'p/' || printf('%032x', i) || '.png', ?, 'pub_000000000000000000000000', 'retired', 0, 0 FROM n`,
      [t.tour_id],
    );
    const unpublishing = await api.unpublish(a.token, t.tour_id);
    expect(unpublishing.status).toBe(202);
    expect(unpublishing.json.status).toBe("in_progress");
    expect((await api.unpublish(a.token, t.tour_id)).status).toBe(204);

    // Delete answers 202 only with more files than one request removes. Help: rows for
    // pictures a chapter replace would have left behind, whose files do not exist.
    await deps.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO replaced_object (tour_id, image_key, draft_version, created_at)
       SELECT ?, 'u/up_000000000000000000000000/step-' || printf('%03d', i) || '.png', 1, 0 FROM n`,
      [DELETE_FILES_PER_CALL, t.tour_id],
    );
    const deleting = await api.del(a.token, t.tour_id);
    expect(deleting.status).toBe(202);
    expect(deleting.json).toEqual({ status: "in_progress", done: DELETE_FILES_PER_CALL, total: DELETE_FILES_PER_CALL + total });
    expect((await api.del(a.token, t.tour_id)).json).toEqual({ deleted: true });
  });

  it("every refusal is as documented: no token, another workspace's tour, step and upload, and each error code", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const api = client(deps);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Without a token, and with one no server knows: every request that needs one.
    const idFor = (path: string) => (path.includes("/uploads/") ? NO_UPLOAD : path.includes("/sessions/") ? "ses_" + "0".repeat(24) : path.includes("/workspaces/") ? NO_WORKSPACE : path.includes("/tokens/") ? "tok_" + "0".repeat(24) : NO_TOUR);
    const example = (op: Op) => op.path.replace("{id}", idFor(op.path)).replace("{step_id}", NO_STEP).replace("{n}", "1");
    // The one request that takes the viewer cookie refuses any token (its own test above); it takes no token or session at all.
    const guarded = OPS.filter((op) => op.op.security.length > 0 && !op.op.security.some((s: Json) => "viewer" in s || "mediaViewer" in s));
    // All but health, the two sign-in requests, the two requests of an invite, the app's two requests while it connects, and the five of a visitor for tours and the five for items.
    expect(guarded).toHaveLength(OPS.length - 17);
    for (const op of guarded) {
      for (const token of [null, NO_TOKEN]) {
        const r = await api.call(op.method, example(op), { token });
        // An admin route answers everyone who is not an admin as if it did not exist.
        const want = op.path.startsWith("/api/v1/admin/") ? [404, '{"error":"not_found"}'] : [401, '{"error":"unauthorized"}'];
        expect([r.status, r.text], op.key).toEqual(want);
      }
    }

    const t = await api.upload(a.token, small(2));
    const [step] = await stepIds(deps, t.tour_id);

    // Another workspace's tour and step answer as one that does not exist.
    refused(await api.rename(b.token, t.tour_id, { title: "Mine now" }), 404, "not_found");
    refused(await api.del(b.token, t.tour_id), 404, "not_found");
    refused(await api.publish(b.token, t.tour_id), 404, "not_found");
    refused(await api.unpublish(b.token, t.tour_id), 404, "not_found");
    refused(await api.image(b.token, t.tour_id, step), 404, "not_found");
    refused(await api.image(a.token, t.tour_id, NO_STEP), 404, "not_found");
    refused(await api.create(b.token, small(1), { kind: "chapter", tour_id: t.tour_id }), 404, "not_found");
    refused(await api.create(a.token, small(1), { kind: "replace", tour_id: t.tour_id, chapter_id: NO_CHAPTER }), 404, "not_found");
    expect((await api.list(b.token)).json).toEqual({ tours: [] });

    // Rename.
    refused(await api.rename(a.token, t.tour_id, "[]"), 400, "bad_request");
    refused(await api.rename(a.token, t.tour_id, { title: "   " }), 400, "bad_title");
    refused(await api.rename(a.token, t.tour_id, { title: "x".repeat(5000) }), 413, "too_large");

    // Start an upload.
    refused(await api.call("POST", "/api/v1/uploads", { token: a.token, body: "[]", headers: JSON_HEADERS }), 400, "bad_request");
    refused(await api.create(a.token, v2, NEW, ["0".repeat(64)]), 400, "bad_request"); // hashes are for a replace only
    refused(await api.call("POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ target: NEW }), headers: JSON_HEADERS }), 400, "bad_manifest");
    refused(await api.create(a.token, { ...clone(v2), steps: [] }), 400, "bad_manifest");
    refused(await api.call("POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ manifest: v2 }), headers: JSON_HEADERS }), 400, "bad_target");
    refused(await api.create(a.token, v2, { kind: "copy" }), 400, "bad_target");
    refused(await api.call("POST", "/api/v1/uploads", { token: a.token, body: "x".repeat(300_000), headers: JSON_HEADERS }), 413, "too_large");
    // The storage allowance, in workspace B: an upload that would go over it. The other
    // form of this request's 413 is the request that is too long, just above.
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = 100 WHERE id = ?", [b.workspaceId]);
    const full = await api.create(b.token, small(1));
    refused(full, 413, "storage_full");
    expect(full.json).toEqual({ error: "storage_full", detail: full.json.detail, used_bytes: 0, allowance_bytes: 100, needed_bytes: 120 });
    expect((await api.usage(b.token)).json).toEqual({ used_bytes: 0, allowance_bytes: 100, over: false, tours: 0, images: 0, gifs: 0, counted: { pictures: 0, logos: 0, uploads_in_progress: 0, images: 0, gifs: 0 } });
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = NULL WHERE id = ?", [b.workspaceId]);
    // The open-upload cap, in workspace B, which has none open: one more than allowed.
    const open: string[] = [];
    for (let i = 0; i < DEFAULT_MAX_OPEN_UPLOADS; i++) open.push((await api.create(b.token, v2)).json.upload_id);
    const capped = await api.create(b.token, v2);
    refused(capped, 429, "too_many_uploads");
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(0);
    for (const id of open) expect((await api.cancel(b.token, id)).status).toBe(204);

    // Send a step's image.
    const up = (await api.create(a.token, small(2))).json.upload_id as string;
    refused(await api.step(b.token, up, 1, png(64, 64, 120)), 404, "not_found");
    refused(await api.step(a.token, up, 3, png(64, 64, 120)), 404, "not_found");
    refused(await api.step(a.token, up, 1, png(32, 32, 120)), 400, "bad_image");
    refused(await api.step(a.token, up, 1, png(64, 64, 2_000_001)), 413, "too_large");
    expect((await api.step(a.token, up, 1, png(64, 64, 120))).status).toBe(204);
    refused(await api.step(a.token, up, 1, png(64, 64, 120)), 409, "already_sent");
    // Finish it too early, or from another workspace.
    refused(await api.commit(a.token, up), 409, "incomplete");
    refused(await api.commit(b.token, up), 404, "not_found");
    // The manifest names no logo.
    refused(await api.logo(a.token, up, logoPng()), 404, "not_found");
    expect((await api.cancel(a.token, up)).status).toBe(204);
    refused(await api.commit(a.token, up), 404, "not_found");

    // Send the logo.
    const withLogo = (await api.create(a.token, v3)).json.upload_id as string;
    refused(await api.logo(a.token, withLogo, jpeg(64, 64, 1000)), 400, "bad_image");
    refused(await api.logo(a.token, withLogo, png(64, 64, 200_001)), 413, "too_large");
    expect((await api.logo(a.token, withLogo, logoPng())).status).toBe(204);
    refused(await api.logo(a.token, withLogo, logoPng()), 409, "already_sent");
    expect((await api.cancel(a.token, withLogo)).status).toBe(204);
    const intoTour = (await api.create(a.token, v3, { kind: "chapter", tour_id: t.tour_id })).json.upload_id as string;
    refused(await api.logo(a.token, intoTour, logoPng()), 409, "logo_not_used");
    expect((await api.cancel(a.token, intoTour)).status).toBe(204);

    // Two replacements of one chapter: the second to finish is refused.
    const early = await api.startReplace(a.token, t, small(2), [4, 5]);
    const late = await api.startReplace(a.token, t, small(2), [6, 7]);
    expect((await api.commit(a.token, early.id)).status).toBe(201);
    refused(await api.commit(a.token, late.id), 409, "chapter_changed");
    expect((await api.cancel(a.token, late.id)).status).toBe(204);

    // Publish.
    refused(await api.publish(a.token, t.tour_id, { publish_id: 5 }), 400, "bad_request");
    refused(await api.publish(a.token, t.tour_id, { publish_id: "pub_" + "0".repeat(24) }), 409, "publish_cancelled");
    refused(await api.publish(a.token, t.tour_id, { note: "x".repeat(2000) }), 413, "too_large");
    // Help: a tour without steps, which no request can make, is written to the database.
    const hollow = "tour_" + "e".repeat(24);
    await deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'Empty', 'emptyslug2', 'draft', 1, 1)", [hollow, a.workspaceId]);
    refused(await api.publish(a.token, hollow), 400, "empty_tour");
    // Help: the draft changes twice at the moment the publish starts (as an upload finishing
    // at that moment would change it), so both of its starts lose.
    const realBatch = deps.db.batch.bind(deps.db);
    let lost = 0;
    deps.db.batch = async (stmts) => {
      if (lost < 2 && stmts[0].sql.startsWith("INSERT INTO publish_job")) {
        lost++;
        await deps.db.run("UPDATE tour SET draft_version = draft_version + 1 WHERE id = ?", [t.tour_id]);
      }
      return realBatch(stmts);
    };
    const busy = await api.publish(a.token, t.tour_id);
    deps.db.batch = realBatch;
    expect(lost).toBe(2);
    refused(busy, 409, "publish_busy");

    // The store fails while unpublishing: the tour is unpublished, its images wait.
    expect((await api.publishAll(a.token, t.tour_id)).json.steps).toBe(2);
    const pubDelete = deps.pub.delete.bind(deps.pub);
    deps.pub.delete = async () => {
      throw new Error("bucket unavailable");
    };
    const stuck = await api.unpublish(a.token, t.tour_id);
    deps.pub.delete = pubDelete;
    refused(stuck, 500, "cleanup_pending");
    expect(stuck.text).not.toContain("bucket");
    expect((await api.unpublish(a.token, t.tour_id)).status).toBe(204);

    // A draft image is gone from the store: the publish fails and says nothing of why.
    const key = (await deps.db.first<{ image_key: string }>("SELECT image_key FROM step WHERE tour_id = ? LIMIT 1", [t.tour_id]))!.image_key;
    await deps.drafts.delete([key]);
    refused(await api.publish(a.token, t.tour_id), 500, "publish_failed");

    // The store fails while deleting: the tour is gone, its files wait.
    const draftsDelete = deps.drafts.delete.bind(deps.drafts);
    deps.drafts.delete = async () => {
      throw new Error("bucket unavailable");
    };
    const half = await api.del(a.token, t.tour_id);
    deps.drafts.delete = draftsDelete;
    refused(half, 500, "cleanup_pending");
    expect((await api.del(a.token, t.tour_id)).json).toEqual({ deleted: true });

    // Help: a token whose workspace is gone cannot exist, since a token's row must name a
    // workspace; the read of the workspace's name is made to find nothing.
    const realFirst = deps.db.first.bind(deps.db);
    deps.db.first = (async (sql: string, params?: unknown[]) => (sql.startsWith("SELECT name FROM workspace") ? null : realFirst(sql, params as never))) as typeof deps.db.first;
    const orphan = await api.me(a.token);
    deps.db.first = realFirst;
    refused(orphan, 404, "not_found");
  });

  it("every answer of who may view a tour is as documented", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A site that can mail links, which restricting a tour needs.
    const { deps, a: aSide, b: bSide } = await setup({ siteHost: "tours.example.com" });
    const api = client(deps);
    // Only a session may change who views a tour: each workspace's owner signs in (the first is the site's admin, which signing in needs).
    const sessionOf = async (workspaceId: string) => {
      const user = (await deps.db.first<{ user_id: string }>("SELECT user_id FROM membership WHERE workspace_id = ?", [workspaceId]))!.user_id;
      await deps.db.run("UPDATE user SET is_admin = 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM user WHERE is_admin = 1)", [user]);
      const made = (await redeemSignInCode(deps, await createSignInCode(deps, user), null, null))!;
      return { cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
    };
    const a = { ...aSide, session: await sessionOf(aSide.workspaceId) };
    const b = { ...bSide, session: await sessionOf(bSide.workspaceId) };
    const draft = await api.upload(a.token, small(1, "Draft"));
    // A token reads the setting and how many addresses the list holds; a session reads the list itself.
    expect((await api.access(a.token, draft.tour_id)).json).toEqual({ access: "public", viewers_count: 0, limit: 200, can_restrict: true, switching: null });
    expect((await api.accessBySession(a.session, draft.tour_id)).json).toEqual({ access: "public", viewers: [], limit: 200, can_restrict: true, switching: null });
    refused(await api.access(b.token, draft.tour_id), 404, "not_found");
    refused(await api.access(a.token, NO_TOUR), 404, "not_found");
    refused(await api.setAccess(b.session, draft.tour_id, { access: "me" }), 404, "not_found");

    // The refusals of the body, which change nothing.
    refused(await api.setAccess(a.session, draft.tour_id, "[]"), 400, "bad_request");
    refused(await api.setAccess(a.session, draft.tour_id, { access: "people", viewers: "ana@example.com" }), 400, "bad_request");
    refused(await api.setAccess(a.session, draft.tour_id, { access: "friends" }), 400, "bad_access");
    const bad = await api.setAccess(a.session, draft.tour_id, { access: "people", viewers: ["ana@example.com", "not an address"] });
    refused(bad, 400, "bad_viewer");
    expect(bad.json.detail).toContain("viewers[1]");
    expect(bad.text).not.toContain("ana@example.com");
    refused(await api.setAccess(a.session, draft.tour_id, { access: "people", viewers: Array.from({ length: 201 }, (_, i) => `v${i}@example.com`) }), 400, "too_many_viewers");
    refused(await api.setAccess(a.session, draft.tour_id, `{"access":"people","viewers":["${"a".repeat(70_000)}"]}`), 413, "too_large");
    expect((await api.accessBySession(a.session, draft.tour_id)).json.viewers).toEqual([]);

    // A draft changes at once.
    const set = await api.setAccess(a.session, draft.tour_id, { access: "people", viewers: ["Ana@Example.com ", "bo@example.com", "ana@example.com"] });
    expect(set.json).toEqual({ access: "people", viewers: ["ana@example.com", "bo@example.com"], limit: 200, can_restrict: true, switching: null });

    // A published tour of more pictures than one request moves: 202, then 200.
    const big = await api.upload(a.token, small(COPY_BATCH + 1, "Big"));
    await api.publishAll(a.token, big.tour_id);
    const moving = await api.setAccess(a.session, big.tour_id, { access: "me" });
    expect([moving.status, moving.json]).toEqual([202, { status: "switching", done: COPY_BATCH, total: COPY_BATCH + 1, target: "restricted" }]);
    expect((await api.access(a.token, big.tour_id)).json.switching).toEqual({ done: COPY_BATCH, total: COPY_BATCH + 1, target: "restricted" });
    refused(await api.setAccess(a.session, big.tour_id, { access: "public" }), 409, "access_switching");
    refused(await api.publish(a.token, big.tour_id), 409, "access_switching");
    const moved = await api.setAccess(a.session, big.tour_id, { access: "me" });
    expect([moved.status, moved.json.access, moved.json.switching]).toEqual([200, "me", null]);

    // A move that cannot go on just now: the request is sent again.
    const store = deps.pub;
    deps.pub = { ...store, put: () => Promise.reject(new Error("the store is down")) };
    refused(await api.setAccess(a.session, big.tour_id, { access: "public" }), 500, "access_failed");
    deps.pub = store;
    let again = await api.setAccess(a.session, big.tour_id, { access: "public" });
    for (let i = 0; again.status === 202 && i < 5; i++) again = await api.setAccess(a.session, big.tour_id, { access: "public" });
    expect([again.status, again.json.access]).toEqual([200, "public"]);

    // A move whose tour is unpublished while a request of it copies: that request answers switch_cancelled.
    const drafts = deps.drafts;
    deps.drafts = {
      ...drafts,
      put: async (key, body, meta) => {
        deps.drafts = drafts;
        await send(deps, "POST", `/api/v1/tours/${big.tour_id}/unpublish`, { token: a.token });
        return drafts.put(key, body, meta);
      },
    };
    refused(await api.setAccess(a.session, big.tour_id, { access: "people" }), 409, "switch_cancelled");
    deps.drafts = drafts;

    // A tour that changes under the request twice: one batch and then the next fail as if a publish had landed.
    const db = deps.db;
    let failures = 0;
    deps.db = {
      ...db,
      batch: async (stmts) => {
        if (failures < 2 && stmts.some((s) => s.sql.includes("UPDATE tour SET access"))) {
          failures++;
          throw new Error("NOT NULL constraint failed: audit.at");
        }
        return db.batch(stmts);
      },
    };
    refused(await api.setAccess(a.session, draft.tour_id, { access: "me" }), 409, "access_busy");
    deps.db = db;

    // A published version that cannot be moved: publish again.
    const odd = await api.upload(a.token, small(1, "Odd"));
    await api.publishAll(a.token, odd.tour_id);
    await deps.db.run(`UPDATE snapshot SET data = '{"title":"odd"}' WHERE tour_id = ?`, [odd.tour_id]);
    refused(await api.setAccess(a.session, odd.tour_id, { access: "me" }), 409, "republish_needed");

    // A site that cannot mail refuses to make a public tour restricted, and keeps a restricted tour as it is.
    deps.config = { ...deps.config, siteHost: null };
    const plain = await api.upload(a.token, small(1, "Plain"));
    refused(await api.setAccess(a.session, plain.tour_id, { access: "me" }), 409, "cannot_restrict");
    const kept = await api.access(a.token, draft.tour_id);
    expect([kept.json.access, kept.json.can_restrict]).toEqual(["people", false]);
  });

  it("every answer of a tour's chapters is as documented, and a replace refused because they changed", async () => {
    const { deps, a, b } = await setup();
    const api = client(deps);
    const t = await api.upload(a.token, v3);
    const second = await api.upload(a.token, small(2, "Second"), { kind: "chapter", tour_id: t.tour_id }, [5, 6]);
    const theirs = await api.upload(b.token, small(1, "Theirs"), NEW, [7]);
    const read = await api.chapters(a.token, t.tour_id);
    expect(read.status).toBe(200);
    expect(read.json.chapters.map((c: Json) => c.id)).toEqual([t.chapter_id, second.chapter_id]);
    refused(await api.chapters(null, t.tour_id), 401, "unauthorized");
    refused(await api.chapters(a.token, theirs.tour_id), 404, "not_found");
    refused(await api.setChapters(null, t.tour_id, { revision: read.json.revision, chapters: [t.chapter_id] }), 401, "unauthorized");
    refused(await api.setChapters(a.token, theirs.tour_id, { revision: read.json.revision, chapters: [t.chapter_id] }), 404, "not_found");
    refused(await api.setChapters(a.token, t.tour_id, { revision: read.json.revision, chapters: [theirs.chapter_id] }), 404, "not_found");
    refused(await api.setChapters(a.token, t.tour_id, { revision: read.json.revision, chapters: [] }), 400, "last_chapter");
    refused(await api.setChapters(a.token, t.tour_id, { revision: read.json.revision, chapters: Array.from({ length: 401 }, (_, i) => "ch_" + String(i).padStart(24, "0")) }), 400, "too_many_chapters");
    refused(await api.setChapters(a.token, t.tour_id, { revision: read.json.revision, chapters: [t.chapter_id, t.chapter_id] }), 400, "bad_request");
    refused(await api.setChapters(a.token, t.tour_id, { revision: read.json.revision - 1, chapters: [t.chapter_id] }), 409, "tour_changed");
    refused(await api.setChapters(a.token, t.tour_id, JSON.stringify({ revision: 1, chapters: [t.chapter_id], pad: "x".repeat(20_000) })), 413, "too_large");
    const done = await api.setChapters(a.token, t.tour_id, { revision: read.json.revision, chapters: [second.chapter_id, t.chapter_id] });
    expect(done.status, done.text).toBe(200);
    expect(done.json.revision).toBe(read.json.revision + 1);
    // A replace whose create read the chapter as the tour's first, while a change makes another first: 409 chapter_changed.
    const real = deps.db.first.bind(deps.db);
    let fired = false;
    deps.db.first = async (sql: string, params?: unknown[]) => {
      const row = await real(sql, params as never);
      if (!fired && sql.includes("LEFT JOIN chapter c ON c.tour_id = t.id AND c.id = ?")) {
        fired = true;
        expect((await send(deps, "PUT", `/api/v1/tours/${t.tour_id}/chapters`, withJsonBody(a.token, { revision: done.json.revision, chapters: [t.chapter_id, second.chapter_id] }))).status).toBe(200);
      }
      return row as never;
    };
    refused(await api.create(a.token, small(1, "Late"), { kind: "replace", tour_id: t.tour_id, chapter_id: second.chapter_id }), 409, "chapter_changed");
    expect(fired).toBe(true);
    deps.db.first = real;

    // A tour with MAX_CHAPTERS - 1 chapters (filled in straight, as each would be an upload):
    // two new chapters started side by side, and the second commit and any later create refused.
    const ids = Array.from({ length: MAX_CHAPTERS - 3 }, () => newId("ch"));
    await deps.db.run("INSERT INTO chapter (id, tour_id, title, description, position) SELECT j.value, ?, 'Bare', NULL, 10 + j.key FROM json_each(?) j", [t.tour_id, JSON.stringify(ids)]);
    const sideBySide: string[] = [];
    for (const pic of [8, 9]) {
      const created = await api.create(a.token, small(1, "Side"), { kind: "chapter", tour_id: t.tour_id });
      expect(created.status, created.text).toBe(201);
      expect((await api.step(a.token, created.json.upload_id, 1, stepImage(small(1).steps[0], pic))).status).toBe(204);
      sideBySide.push(created.json.upload_id);
    }
    expect((await api.commit(a.token, sideBySide[0])).status).toBe(201);
    refused(await api.commit(a.token, sideBySide[1]), 409, "too_many_chapters");
    expect((await api.cancel(a.token, sideBySide[1])).status).toBe(204);
    refused(await api.create(a.token, small(1, "Full"), { kind: "chapter", tour_id: t.tour_id }), 409, "too_many_chapters");
  });

  it("me has addresses only with two addresses, and health names the address it was asked on", async () => {
    const hosts = { tours: "tours.example.com", app: "app.example.com" };
    const { deps, a } = await setup({ hosts });
    const api = client(deps);
    for (const origin of ["https://tours.example.com", "https://app.example.com"]) {
      expect((await api.me(a.token, origin)).json, origin).toEqual({ workspace: "Workspace A", version: VERSION, addresses: hosts });
    }
    expect((await api.health("https://tours.example.com")).json).toEqual({ ok: true, address: "tours" });
    expect((await api.health("https://app.example.com")).json).toEqual({ ok: true, address: "app" });
    // Health answers on any host name; on one that is not configured it names no address.
    expect((await api.health("https://other.example.net")).json).toEqual({ ok: true });
  });

  it("every answer of signing in and of a session is as documented", async () => {
    // One address, with the host name sign-in links use.
    const { deps, mail, settle } = await makeDeps({ siteHost: "tours.example.com" });
    // A fixed clock: the limiter's windows are fixed to the epoch, so with the real clock the requests below could straddle a quarter-hour and meet a fresh window.
    deps.now = () => 1_800_000_000_000;
    const api = client(deps);
    await seedAccount(deps, { admin: true });
    const a = await seedAccount(deps);
    const page = { "content-type": JSON_TYPE, origin: "https://tours.example.com" };
    const body = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
    const ask = (v: unknown, more: Opts = {}) => api.call("POST", "/api/v1/signin/request", { ...more, body: body(v), headers: { ...page, ...more.headers } });
    const press = (v: unknown, more: Opts = {}) => api.call("POST", "/api/v1/signin/complete", { ...more, body: body(v), headers: { ...page, ...more.headers } });
    // Requests from one network, as an entry would have recorded its address.
    const network = (d: Deps) => ({ fetch: (req: Request) => (setClientAddress(req, "203.0.113.50"), createApp(d).fetch(req)) });
    const withCookie = async (secret: string) => ({ cookie: `${SESSION_COOKIE}=${secret}`, origin: "https://tours.example.com", "x-csrf-token": await csrfFor(secret) });
    const signIn = async () => {
      const made = await redeemSignInCode(deps, await createSignInCode(deps, a.userId), null, null);
      if (made === null) throw new Error("the sign-in was refused");
      return made;
    };

    // Asking for a link.
    expect((await ask({ email: a.email })).json).toEqual({ ok: true });
    await settle();
    expect(mail.sent).toHaveLength(1);
    refused(await ask("not json"), 400, "bad_request");
    refused(await ask({ email: "not an address" }), 400, "bad_email");
    refused(await ask({ email: a.email }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    for (let i = 0; i < 10; i++) expect((await ask({ email: `someone-${i}@example.com` }, { app: network })).status).toBe(200);
    refused(await ask({ email: a.email }, { app: network }), 429, "rate_limited");

    // Completing it.
    const code = (mail.sent[0]?.text.match(/dpl_[0-9a-f]{40}/) ?? [""])[0];
    const signedIn = await press({ code });
    expect(signedIn.json).toEqual({ ok: true });
    const secret = (signedIn.headers.get("set-cookie") ?? "").match(/dps_[0-9a-f]{64}/)?.[0] ?? "";
    refused(await press({ code }), 403, "link_invalid");
    refused(await press("{"), 400, "bad_request");
    refused(await press({ code: "not a code" }), 400, "bad_code");
    refused(await press({ code }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    for (let i = 0; i < 20; i++) expect((await press({ code: "dpl_" + String(i).padStart(40, "0") }, { app: network })).status).toBe(403);
    refused(await press({ code }, { app: network }), 429, "rate_limited");

    // The session's own requests, with the cookie the sign-in set, and nobody without it.
    const mine = await withCookie(secret);
    const session = await api.call("GET", "/api/v1/session", { headers: { cookie: mine.cookie } });
    expect(session.json.account.id).toBe(a.userId);
    expect(session.json.csrf).toBe(mine["x-csrf-token"]);
    const list = await api.call("GET", "/api/v1/sessions", { headers: { cookie: mine.cookie } });
    expect(list.json.sessions).toHaveLength(1);
    const other = await signIn();
    expect((await api.call("DELETE", `/api/v1/sessions/${other.sessionId}`, { headers: mine })).status).toBe(204);
    refused(await api.call("DELETE", `/api/v1/sessions/${other.sessionId}`, { headers: mine }), 404, "not_found");
    for (const path of ["/api/v1/session", "/api/v1/sessions"]) refused(await api.call("GET", path, { token: a.token }), 401, "unauthorized");
    refused(await api.call("DELETE", `/api/v1/sessions/${session.json.session.id}`, { token: a.token }), 401, "unauthorized");
    for (const path of ["/api/v1/signout", "/api/v1/signout/everywhere"]) refused(await api.call("POST", path, {}), 401, "unauthorized");
    expect((await api.call("POST", "/api/v1/signout/everywhere", { headers: await withCookie((await signIn()).secret) })).status).toBe(204);
    expect((await api.call("POST", "/api/v1/signout", { headers: await withCookie((await signIn()).secret) })).status).toBe(204);
  });

  it("every answer of changing the email address is as documented", async () => {
    const { deps, mail } = await makeDeps({ siteHost: "tours.example.com" });
    // A fixed clock: the limiter's windows are fixed to the epoch, so with the real clock the requests below could straddle a quarter-hour and meet a fresh window.
    deps.now = () => 1_800_000_000_000;
    const api = client(deps);
    await seedAccount(deps, { admin: true });
    const a = await seedAccount(deps);
    const made = await redeemSignInCode(deps, await createSignInCode(deps, a.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const headers = { cookie: `${SESSION_COOKIE}=${made.secret}`, origin: "https://tours.example.com", "x-csrf-token": await csrfFor(made.secret), "content-type": JSON_TYPE };
    const ask = (body: string) => api.call("POST", "/api/v1/account/email", { headers, body });
    const confirm = (body: string) => api.call("POST", "/api/v1/account/email/confirm", { headers, body });

    expect((await api.call("GET", "/api/v1/session", { headers: { cookie: headers.cookie } })).json.email_change).toBe(true);
    expect((await ask(JSON.stringify({ email: "new@example.com" }))).json).toEqual({ ok: true });
    const code = (mail.sent[0]?.text.match(/dpe_[0-9a-f]{40}/) ?? [""])[0];
    refused(await ask("[]"), 400, "bad_request");
    refused(await ask(JSON.stringify({ email: "not an address" })), 400, "bad_email");
    refused(await confirm("{"), 400, "bad_request");
    refused(await confirm(JSON.stringify({ code: "dpe_" + "0".repeat(40) })), 400, "bad_code");
    expect((await confirm(JSON.stringify({ code }))).json).toEqual({ email: "new@example.com", previous_email: a.email });
    for (let i = 0; i < 2; i++) expect((await ask(JSON.stringify({ email: `more-${i}@example.com` }))).status).toBe(200);
    refused(await ask(JSON.stringify({ email: "one-too-many@example.com" })), 429, "rate_limited");
    for (let i = 0; i < 18; i++) expect((await confirm(JSON.stringify({ code: "dpe_" + String(i).padStart(40, "1") }))).status).toBe(400);
    refused(await confirm(JSON.stringify({ code })), 429, "rate_limited");
    for (const path of ["/api/v1/account/email", "/api/v1/account/email/confirm"]) refused(await api.call("POST", path, { token: a.token, body: "{}", headers: JSON_HEADERS }), 401, "unauthorized");

    // A site whose mail is off.
    const off = await makeDeps({ siteHost: "tours.example.com" }, { mail: false });
    const offApi = client(off.deps);
    await seedAccount(off.deps, { admin: true });
    const b = await seedAccount(off.deps);
    const offMade = await redeemSignInCode(off.deps, await createSignInCode(off.deps, b.userId), null, null);
    if (offMade === null) throw new Error("the sign-in was refused");
    const offHeaders = { cookie: `${SESSION_COOKIE}=${offMade.secret}`, origin: "https://tours.example.com", "x-csrf-token": await csrfFor(offMade.secret), "content-type": JSON_TYPE };
    expect((await offApi.call("GET", "/api/v1/session", { headers: { cookie: offHeaders.cookie } })).json.email_change).toBe(false);
    refused(await offApi.call("POST", "/api/v1/account/email", { headers: offHeaders, body: JSON.stringify({ email: "new@example.com" }) }), 409, "mail_off");
  });

  it("every answer of the admin routes is as documented", async () => {
    const { deps } = await makeDeps({ storageAllowanceBytes: 1_000_000 });
    const api = client(deps);
    const admin = await seedAccount(deps, { admin: true });
    const member = await seedAccount(deps);
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const headers = { cookie: `${SESSION_COOKIE}=${made.secret}`, origin: "https://tours.example.com", "x-csrf-token": await csrfFor(made.secret), "content-type": JSON_TYPE };
    await api.upload(member.token, small(2));

    // The summary.
    expect((await api.call("GET", "/api/v1/admin/summary", { headers })).json).toEqual({ accounts: 2, used_bytes: 240, standard_allowance_bytes: 1_000_000 });

    // The list, and its next page.
    const list = await api.call("GET", "/api/v1/admin/accounts", { headers });
    expect(list.json.accounts.map((a: Json) => a.id)).toEqual([admin.userId, member.userId]);
    expect(list.json.accounts[1]).toMatchObject({ tours: 1, used_bytes: 240, allowance_bytes: 1_000_000, storage_allowance_bytes: null });
    const first = list.json.accounts[0] as Json;
    expect((await api.call("GET", `/api/v1/admin/accounts?after=${encodeAccountCursor(first.created_at, first.id)}`, { headers })).json.accounts.map((a: Json) => a.id)).toEqual([member.userId]);
    refused(await api.call("GET", "/api/v1/admin/accounts?after=nobody", { headers }), 400, "bad_cursor");

    // Setting the allowance, and going back to the server's.
    const path = `/api/v1/admin/workspaces/${member.workspaceId}`;
    const set = await api.call("PATCH", path, { headers, body: JSON.stringify({ storage_allowance_bytes: 100 }) });
    expect(set.json).toEqual({ workspace_id: member.workspaceId, allowance_bytes: 100, storage_allowance_bytes: 100, used_bytes: 240, over: true });
    expect((await api.call("PATCH", path, { headers, body: JSON.stringify({ storage_allowance_bytes: null }) })).json).toMatchObject({ allowance_bytes: 1_000_000, storage_allowance_bytes: null });
    refused(await api.call("PATCH", path, { headers, body: JSON.stringify({ storage_allowance_bytes: -1 }) }), 400, "bad_allowance");
    refused(await api.call("PATCH", path, { headers, body: "[]" }), 400, "bad_request");
    refused(await api.call("PATCH", `/api/v1/admin/workspaces/${NO_WORKSPACE}`, { headers, body: JSON.stringify({ storage_allowance_bytes: 1 }) }), 404, "not_found");

    // Anyone else: the one 404.
    refused(await api.call("GET", "/api/v1/admin/accounts", { token: member.token }), 404, "not_found");
    refused(await api.call("GET", "/api/v1/admin/summary", { token: member.token }), 404, "not_found");
    refused(await api.call("PATCH", path, { token: admin.token, body: JSON.stringify({ storage_allowance_bytes: 1 }), headers: JSON_HEADERS }), 404, "not_found");
  });

  it("every answer of disabling, enabling and deleting an account is as documented", async () => {
    const { deps } = await makeDeps();
    const api = client(deps);
    const admin = await seedAccount(deps, { admin: true, username: "mara" });
    const member = await seedAccount(deps, { username: "rook" });
    const other = await seedAccount(deps, { admin: true });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const headers = { cookie: `${SESSION_COOKIE}=${made.secret}`, origin: "https://tours.example.com", "x-csrf-token": await csrfFor(made.secret), "content-type": JSON_TYPE };
    const account = (id: string, rest = "") => `/api/v1/admin/accounts/${id}${rest}`;
    const NO_ACCOUNT = "usr_" + "0".repeat(24);
    const del = (id: string, body: unknown) => api.call("DELETE", account(id), { headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    await api.upload(member.token, small(2));

    // What a delete would remove.
    expect((await api.call("GET", account(member.userId, "/removal"), { headers })).json).toEqual({ username: "rook", email: member.email, tours: 1, items: 0, connections: 1, used_bytes: 240 });
    refused(await api.call("GET", account(NO_ACCOUNT, "/removal"), { headers }), 404, "not_found");

    // Disable and enable, each twice (the second changes nothing), and the refusals.
    for (const how of ["disable", "enable", "disable"]) {
      expect((await api.call("POST", account(member.userId, `/${how}`), { headers })).status).toBe(204);
      expect((await api.call("POST", account(member.userId, `/${how}`), { headers })).status).toBe(204);
    }
    for (const how of ["disable", "enable"]) {
      refused(await api.call("POST", account(admin.userId, `/${how}`), { headers }), 409, "own_account");
      refused(await api.call("POST", account(NO_ACCOUNT, `/${how}`), { headers }), 404, "not_found");
    }

    // The delete's refusals.
    refused(await del(member.userId, "[]"), 400, "bad_request");
    refused(await del(member.userId, { username: "Rook" }), 400, "username_mismatch");
    refused(await del(admin.userId, { username: "mara" }), 409, "own_account");
    refused(await del(other.userId, { username: other.email }), 409, "not_disabled");
    refused(await del(NO_ACCOUNT, { username: "rook" }), 404, "not_found");
    await deps.db.run("INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, ?)", [member.workspaceId, deps.now()]);
    refused(await del(member.userId, { username: "rook" }), 409, "site_owner");
    await deps.db.run("DELETE FROM setup");
    // Another account in the workspace: its row names the workspace (as an older build wrote them).
    const lodger = "usr_" + "9".repeat(24);
    await deps.db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, 'lodger@example.com', ?)", [lodger, member.workspaceId, deps.now()]);
    refused(await del(member.userId, { username: "rook" }), 409, "shared_workspace");
    await deps.db.run("DELETE FROM user WHERE id = ?", [lodger]);

    // The last active admin: with the caller disabled after its own check (a hook on the
    // account's read stands in for another admin acting at that moment), the other admin
    // is the last one, and can be neither disabled nor deleted.
    const realFirst = deps.db.first.bind(deps.db);
    const callerGone = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("AS other_admins")) await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [admin.userId]);
      return realFirst(sql, params as never);
    }) as typeof deps.db.first;
    deps.db.first = callerGone;
    refused(await api.call("POST", account(other.userId, "/disable"), { headers }), 409, "last_admin");
    deps.db.first = realFirst;
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [admin.userId]);
    expect((await api.call("POST", account(other.userId, "/disable"), { headers })).status).toBe(204);
    deps.db.first = callerGone;
    refused(await del(other.userId, { username: other.email }), 409, "last_admin");
    deps.db.first = realFirst;
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [admin.userId]);

    // A delete whose store fails part way: 500, and the account is now being deleted, so it cannot be enabled.
    const realDelete = deps.drafts.delete.bind(deps.drafts);
    deps.drafts.delete = () => Promise.reject(new Error("the store is down"));
    const log = console.error;
    console.error = () => {};
    try {
      refused(await del(member.userId, { username: "rook" }), 500, "cleanup_pending");
    } finally {
      console.error = log;
      deps.drafts.delete = realDelete;
    }
    refused(await api.call("POST", account(member.userId, "/enable"), { headers }), 409, "deleting");

    // A delete with more files than one request removes: rows naming files that do not
    // exist are written first (removing a file that is already gone is not an error).
    const gone = "tour_" + "1".repeat(24);
    await deps.db.run("INSERT INTO tour_deletion (tour_id, workspace_id, total, created_at) VALUES (?, ?, 3000, ?)", [gone, member.workspaceId, deps.now()]);
    await deps.db.run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO deleted_object (tour_id, store, image_key) SELECT ?, 'drafts', 'u/none/' || i FROM n", [gone]);
    let r = await del(member.userId, { username: "rook" });
    expect(r.status).toBe(202);
    for (let i = 0; r.status === 202 && i < 20; i++) r = await del(member.userId, { username: "rook" });
    expect(r.json).toEqual({ deleted: true });
    refused(await del(member.userId, { username: "rook" }), 404, "not_found");

    // Anyone else: the one 404.
    refused(await api.call("POST", account(other.userId, "/enable"), { token: member.token }), 404, "not_found");
    refused(await api.call("GET", account(other.userId, "/removal"), { token: admin.token }), 404, "not_found");
  });

  it("every answer of invites is as documented", async () => {
    // One address, with the host name links use.
    const { deps, mail } = await makeDeps({ siteHost: "tours.example.com" });
    // A fixed clock: the limiter's windows are fixed to the epoch, so with the real clock the requests below could straddle a quarter-hour and meet a fresh window.
    deps.now = () => 1_800_000_000_000;
    const api = client(deps);
    const admin = await seedAccount(deps, { admin: true, username: "boss" });
    const member = await seedAccount(deps, { username: "member" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const SITE = "https://tours.example.com";
    const headers = { cookie: `${SESSION_COOKIE}=${made.secret}`, origin: SITE, "x-csrf-token": await csrfFor(made.secret), "content-type": JSON_TYPE };
    const send1 = (email: unknown) => api.call("POST", "/api/v1/admin/invites", { headers, body: JSON.stringify({ email }) });
    const codeOf = () => (mail.sent[mail.sent.length - 1]?.text.match(/dpi_[0-9a-f]{40}/) ?? [""])[0];
    const page = { "content-type": JSON_TYPE, origin: SITE };
    const network = (d: Deps) => ({ fetch: (req: Request) => (setClientAddress(req, "203.0.113.60"), createApp(d).fetch(req)) });
    const check = (body: unknown, more: Opts = {}) => api.call("POST", "/api/v1/invite/check", { ...more, body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...page, ...more.headers } });
    const accept = (body: unknown, more: Opts = {}) => api.call("POST", "/api/v1/invite/accept", { ...more, body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...page, ...more.headers } });

    // The admin's routes.
    const sent = await send1("first@example.com");
    expect(sent.status).toBe(201);
    const id = sent.json.id as string;
    refused(await send1("not an address"), 400, "bad_email");
    refused(await api.call("POST", "/api/v1/admin/invites", { headers, body: JSON.stringify({ email: "x@example.com", more: 1 }) }), 400, "bad_request");
    refused(await send1(member.email), 409, "has_account");
    expect((await api.call("GET", "/api/v1/admin/invites", { headers })).json.invites.map((i: Json) => i.id)).toEqual([id]);
    expect((await api.call("POST", `/api/v1/admin/invites/${id}/resend`, { headers })).status).toBe(200);
    refused(await api.call("POST", `/api/v1/admin/invites/inv_${"0".repeat(24)}/resend`, { headers }), 404, "not_found");
    mail.failNext();
    vi.spyOn(console, "error").mockImplementation(() => {});
    refused(await send1("failed@example.com"), 502, "mail_failed");
    mail.failNext();
    refused(await api.call("POST", `/api/v1/admin/invites/${id}/resend`, { headers }), 502, "mail_failed");
    expect((await api.call("POST", `/api/v1/admin/invites/${id}/resend`, { headers })).status).toBe(200);
    const code = codeOf();
    // An address that got an account meanwhile.
    const late = await send1("late@example.com");
    await deps.db.run("UPDATE user SET email = 'late@example.com' WHERE id = ?", [member.userId]);
    refused(await api.call("POST", `/api/v1/admin/invites/${late.json.id}/resend`, { headers }), 409, "has_account");
    expect((await api.call("DELETE", `/api/v1/admin/invites/${late.json.id}`, { headers })).status).toBe(204);
    refused(await api.call("DELETE", `/api/v1/admin/invites/${late.json.id}`, { headers }), 404, "not_found");
    for (const [method, path] of [["GET", "/api/v1/admin/invites"], ["POST", "/api/v1/admin/invites"], ["POST", `/api/v1/admin/invites/${id}/resend`], ["DELETE", `/api/v1/admin/invites/${id}`]]) {
      refused(await api.call(method, path, { token: admin.token, body: method === "POST" ? "{}" : undefined, headers: JSON_HEADERS }), 404, "not_found");
    }
    // The site's cap of invites.
    await deps.db.batch(Array.from({ length: 100 }, (_, i) => ({ sql: "INSERT INTO invite (id, email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", params: [`inv_${String(i).padStart(24, "a")}`, `cap${i}@example.com`, String(i).padStart(64, "c"), deps.now(), deps.now() + 86_400_000] })));
    refused(await send1("over@example.com"), 409, "too_many_invites");
    // Resending one that ran out would open it again: refused at the cap too.
    await deps.db.run("UPDATE invite SET created_at = 1, expires_at = 2 WHERE id = ?", [id]);
    refused(await api.call("POST", `/api/v1/admin/invites/${id}/resend`, { headers }), 409, "too_many_invites");
    await deps.db.run("UPDATE invite SET created_at = ?, expires_at = ? WHERE id = ?", [deps.now(), deps.now() + 86_400_000, id]);
    await deps.db.run("DELETE FROM invite WHERE email LIKE 'cap%'");
    // The admin's hourly number: 11 sends were counted so far, the refused ones too.
    for (let i = 0; i < 9; i++) expect((await send1(`n${i}@example.com`)).status).toBe(201);
    refused(await send1("one-too-many@example.com"), 429, "rate_limited");
    refused(await api.call("POST", `/api/v1/admin/invites/${id}/resend`, { headers }), 429, "rate_limited");

    // The person's requests.
    const found = await check({ code });
    expect(found.json).toEqual({ email: "first@example.com", invited_by: "boss", expires_at: expect.any(Number) });
    refused(await check("{"), 400, "bad_request");
    refused(await check({ code }, { token: admin.token }), 400, "credentials_not_allowed");
    refused(await check({ code }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    refused(await check({ code: "dpi_" + "0".repeat(40) }), 404, "invite_invalid");
    refused(await check({ code }, { headers: { cookie: headers.cookie } }), 409, "signed_in");
    refused(await accept("[]"), 400, "bad_request");
    refused(await accept({ code, username: "x" }, { token: admin.token }), 400, "credentials_not_allowed");
    refused(await accept({ code, username: "Bad_Name" }), 400, "bad_username");
    refused(await accept({ code, username: "admin" }), 400, "reserved_username");
    refused(await accept({ code: "dpi_" + "0".repeat(40), username: "Bad_Name" }), 404, "invite_invalid");
    refused(await accept({ code, username: "fresh" }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    refused(await accept({ code: "dpi_" + "0".repeat(40), username: "fresh" }), 404, "invite_invalid");
    refused(await accept({ code, username: "fresh" }, { headers: { cookie: headers.cookie } }), 409, "signed_in");
    refused(await accept({ code, username: "member" }), 409, "username_taken");
    const other = await deps.db.first<{ id: string }>("SELECT id FROM invite WHERE email = 'n0@example.com'");
    expect(other).not.toBeNull();
    const accepted = await accept({ code, username: "fresh" });
    expect(accepted.json).toEqual({ ok: true });
    expect(accepted.headers.get("set-cookie")).toMatch(/^__Host-dp_session=dps_[0-9a-f]{64};/);
    // An invite whose address got an account since: resend it to get its code, from a second admin.
    const second = await seedAccount(deps, { admin: true });
    const secondMade = await redeemSignInCode(deps, await createSignInCode(deps, second.userId), null, null);
    if (secondMade === null) throw new Error("the sign-in was refused");
    const secondHeaders = { cookie: `${SESSION_COOKIE}=${secondMade.secret}`, origin: SITE, "x-csrf-token": await csrfFor(secondMade.secret), "content-type": JSON_TYPE };
    expect((await api.call("POST", `/api/v1/admin/invites/${other!.id}/resend`, { headers: secondHeaders })).status).toBe(200);
    const otherCode = codeOf();
    await deps.db.run("UPDATE user SET email = 'n0@example.com' WHERE id = ?", [member.userId]);
    refused(await accept({ code: otherCode, username: "someone" }), 409, "has_account");
    // The network's number.
    for (let i = 0; i < 30; i++) await check({ code: otherCode }, { app: network });
    refused(await check({ code: otherCode }, { app: network }), 429, "rate_limited");
    refused(await accept({ code: otherCode, username: "someone" }, { app: network }), 429, "rate_limited");

    // A site whose mail is off.
    const off = await makeDeps({ siteHost: "tours.example.com" }, { mail: false });
    const offApi = client(off.deps);
    const offAdmin = await seedAccount(off.deps, { admin: true });
    const offMade = await redeemSignInCode(off.deps, await createSignInCode(off.deps, offAdmin.userId), null, null);
    if (offMade === null) throw new Error("the sign-in was refused");
    const offHeaders = { cookie: `${SESSION_COOKIE}=${offMade.secret}`, origin: SITE, "x-csrf-token": await csrfFor(offMade.secret), "content-type": JSON_TYPE };
    refused(await offApi.call("POST", "/api/v1/admin/invites", { headers: offHeaders, body: JSON.stringify({ email: "x@example.com" }) }), 409, "mail_off");
    await off.deps.db.run("INSERT INTO invite (id, email, code_hash, created_at, expires_at) VALUES (?, 'x@example.com', ?, 1, 2)", ["inv_" + "1".repeat(24), "d".repeat(64)]);
    refused(await offApi.call("POST", `/api/v1/admin/invites/inv_${"1".repeat(24)}/resend`, { headers: offHeaders }), 409, "mail_off");
  });

  it("every answer of a visitor proving an address is as documented", async () => {
    const { deps, mail } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    // A fixed clock: the limiter's windows are fixed to the epoch, so with the real clock the requests below could straddle a quarter-hour and meet a fresh window.
    deps.now = () => 1_800_000_000_000;
    const api = client(deps);
    // A stand-in for the tour's own setting: one read for every question, and one tour shared with one address.
    useViewerGate({
      mayRequest: async (d, slug, email) => ((await d.db.first("SELECT 1 AS x")) !== null && slug === "restricted" && email === "mara@example.com" ? { allowed: true, workspaceKey: "ws-one" } : { allowed: false }),
    });
    const TOURS = "https://tours.example.com";
    const page = { "content-type": JSON_TYPE, origin: TOURS };
    const network = (address: string) => (d: Deps) => ({ fetch: (req: Request) => (setClientAddress(req, address), createApp(d).fetch(req)) });
    const post = (path: string, body: unknown, more: Opts = {}) => api.call("POST", path, { origin: TOURS, ...more, body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...page, ...more.headers } });

    // Asking for a link.
    expect((await post("/api/v1/view/request", { email: "mara@example.com", slug: "restricted" })).json).toEqual({ ok: true });
    expect((await post("/api/v1/view/request", { email: "bram@example.com", slug: "restricted" })).status).toBe(202);
    refused(await post("/api/v1/view/request", "[]"), 400, "bad_request");
    refused(await post("/api/v1/view/request", { email: "mara@example.com", slug: "restricted" }, { token: NO_TOKEN }), 400, "credentials_not_allowed");
    refused(await post("/api/v1/view/request", { email: "mara@example.com", slug: "restricted" }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    for (let i = 0; i < 10; i++) await post("/api/v1/view/request", { email: "bram@example.com", slug: "openpublic" }, { app: network("203.0.113.70") });
    refused(await post("/api/v1/view/request", { email: "bram@example.com", slug: "openpublic" }, { app: network("203.0.113.70") }), 429, "rate_limited");
    const code = (mail.sent[0]?.text.match(/dpv_[0-9a-f]{40}/) ?? [""])[0];
    expect(code).not.toBe("");

    // Looking the code up and completing it.
    expect((await post("/api/v1/view/check", { code })).json).toEqual({ email: "mara@example.com", slug: "restricted" });
    refused(await post("/api/v1/view/check", "{"), 400, "bad_request");
    refused(await post("/api/v1/view/check", { code }, { token: NO_TOKEN }), 400, "credentials_not_allowed");
    refused(await post("/api/v1/view/check", { code }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    refused(await post("/api/v1/view/check", { code: "dpv_" + "0".repeat(40) }), 404, "view_link_invalid");
    refused(await post("/api/v1/view/complete", "{"), 400, "bad_request");
    refused(await post("/api/v1/view/complete", { code }, { token: NO_TOKEN }), 400, "credentials_not_allowed");
    refused(await post("/api/v1/view/complete", { code }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    const done = await post("/api/v1/view/complete", { code });
    expect(done.json).toEqual({ slug: "restricted" });
    expect(done.headers.get("set-cookie")).toMatch(/^__Host-dp_viewer=dpw_[0-9a-f]{64};/);
    refused(await post("/api/v1/view/complete", { code }), 404, "view_link_invalid");
    for (let i = 0; i < 20; i++) await post("/api/v1/view/check", { code }, { app: network("203.0.113.71") });
    refused(await post("/api/v1/view/check", { code }, { app: network("203.0.113.71") }), 429, "rate_limited");
    refused(await post("/api/v1/view/complete", { code }, { app: network("203.0.113.71") }), 429, "rate_limited");

    // The session and signing out.
    const cookie = (done.headers.get("set-cookie") ?? "").split(";")[0];
    expect((await api.call("GET", "/api/v1/view/session", { origin: TOURS, headers: { cookie } })).json).toEqual({ email: "mara@example.com" });
    refused(await api.call("GET", "/api/v1/view/session", { origin: TOURS, token: NO_TOKEN, headers: { cookie } }), 400, "credentials_not_allowed");
    refused(await api.call("POST", "/api/v1/view/signout", { origin: TOURS, token: NO_TOKEN, headers: { cookie, origin: TOURS } }), 400, "credentials_not_allowed");
    refused(await api.call("POST", "/api/v1/view/signout", { origin: TOURS, headers: { cookie, origin: "https://evil.example.net" } }), 403, "bad_origin");
    expect((await api.call("POST", "/api/v1/view/signout", { origin: TOURS, headers: { cookie, origin: TOURS } })).status).toBe(204);
    const gone = await api.call("GET", "/api/v1/view/session", { origin: TOURS, headers: { cookie } });
    expect([gone.status, gone.text]).toEqual([401, '{"error":"unauthorized"}']);
  });

  it("every answer of who may view a shared item, and of a visitor proving an address for one, is as documented", async () => {
    const { deps, mail } = await makeDeps({ siteHost: "tours.example.com" });
    // A fixed clock, as for the tours' visitors: the limiter's windows are fixed to the epoch.
    deps.now = () => 1_800_000_000_000;
    const api = client(deps);
    const sessionOf = async (userId: string) => {
      const made = (await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null))!;
      return { cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
    };
    const a = await seedAccount(deps, { admin: true });
    const b = await seedAccount(deps);
    const sa = await sessionOf(a.userId);
    const sb = await sessionOf(b.userId);
    const share = async () => {
      const made = await send(deps, "POST", "/api/v1/media", { token: a.token, headers: JSON_HEADERS, body: JSON.stringify({ kind: "image", content_type: "image/png", bytes: 3000, width: 20, height: 10 }) });
      const id = made.json.id as string;
      expect((await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token: a.token, body: png(20, 10, 3000) as NonNullable<RequestInit["body"]> })).status).toBe(204);
      const done = await send(deps, "POST", `/api/v1/media/${id}/commit`, { token: a.token });
      return { id, link: done.json.link_id as string };
    };
    const item = await share();
    const plain = await share();
    const get = (opts: Parameters<typeof api.call>[2]) => api.call("GET", `/api/v1/media/${item.id}/access`, opts);
    const put = (session: { cookie: string; csrf: string }, body: unknown, id = item.id) =>
      api.call("PUT", `/api/v1/media/${id}/access`, {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { ...JSON_HEADERS, cookie: session.cookie, "x-csrf-token": session.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin" },
      });

    // Reading: a token gets the count, a session the list; the other workspace and nobody are refused.
    expect((await get({ token: a.token })).json).toEqual({ access: "public", viewers_count: 0, limit: 200, can_restrict: true });
    expect((await get({ headers: { cookie: sa.cookie } })).json).toEqual({ access: "public", viewers: [], limit: 200, can_restrict: true });
    expect((await get({ token: null })).status).toBe(401);
    refused(await get({ token: b.token }), 404, "not_found");
    refused(await put(sb, { access: "me" }), 404, "not_found");
    expect((await api.call("PUT", `/api/v1/media/${item.id}/access`, { token: a.token, headers: JSON_HEADERS, body: '{"access":"me"}' })).status).toBe(401);

    // The refusals of the body, which change nothing.
    refused(await put(sa, "[]"), 400, "bad_request");
    refused(await put(sa, { access: "friends" }), 400, "bad_access");
    refused(await put(sa, { access: "people", viewers: ["ana@example.com", "not an address"] }), 400, "bad_viewer");
    refused(await put(sa, { access: "people", viewers: Array.from({ length: 201 }, (_, i) => `v${i}@example.com`) }), 400, "too_many_viewers");
    refused(await put(sa, `{"access":"people","viewers":["${"a".repeat(70_000)}"]}`), 413, "too_large");

    // An item that changes under the request twice.
    const db = deps.db;
    let failures = 0;
    deps.db = {
      ...db,
      batch: async (stmts) => {
        if (failures < 2 && stmts.some((st) => st.sql.includes("UPDATE media SET access"))) {
          failures++;
          throw new Error("NOT NULL constraint failed: audit.at");
        }
        return db.batch(stmts);
      },
    };
    refused(await put(sa, { access: "me" }), 409, "access_busy");
    deps.db = db;
    // Too large to be restricted here.
    await deps.db.run("UPDATE media SET parts = 36 WHERE id = ?", [plain.id]);
    refused(await put(sa, { access: "me" }, plain.id), 409, "too_large_to_restrict");
    await deps.db.run("UPDATE media SET parts = 1 WHERE id = ?", [plain.id]);
    // Done: restricted to one address.
    expect((await put(sa, { access: "people", viewers: ["mara@example.com"] })).json).toEqual({ access: "people", viewers: ["mara@example.com"], limit: 200, can_restrict: true });
    // A site that cannot mail refuses to restrict a public item.
    const config = deps.config;
    deps.config = { ...config, siteHost: null };
    refused(await put(sa, { access: "me" }, plain.id), 409, "cannot_restrict");
    deps.config = config;

    // A visitor asking for a link on the media address (one address here), the same answer for everyone.
    const page = { "content-type": JSON_TYPE, origin: ORIGIN };
    const network = (address: string) => (d: Deps) => ({ fetch: (req: Request) => (setClientAddress(req, address), createApp(d).fetch(req)) });
    const post = (path: string, body: unknown, more: Opts = {}) => api.call("POST", path, { ...more, body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...page, ...more.headers } });
    expect((await post("/api/v1/media-view/request", { email: "mara@example.com", path: `/i/${item.link}` })).json).toEqual({ ok: true });
    expect((await post("/api/v1/media-view/request", { email: "bram@example.com", path: `/i/${item.link}` })).status).toBe(202);
    refused(await post("/api/v1/media-view/request", "[]"), 400, "bad_request");
    refused(await post("/api/v1/media-view/request", { email: "mara@example.com", path: `/i/${item.link}` }, { token: NO_TOKEN }), 400, "credentials_not_allowed");
    refused(await post("/api/v1/media-view/request", { email: "mara@example.com", path: `/i/${item.link}` }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    for (let i = 0; i < 10; i++) await post("/api/v1/media-view/request", { email: "bram@example.com", path: `/i/${plain.link}` }, { app: network("203.0.113.80") });
    refused(await post("/api/v1/media-view/request", { email: "bram@example.com", path: `/i/${plain.link}` }, { app: network("203.0.113.80") }), 429, "rate_limited");
    const code = (mail.sent.find((m) => m.to === "mara@example.com")?.text.match(/dpi_[0-9a-f]{40}/) ?? [""])[0];
    expect(code).not.toBe("");

    // Looking the code up and completing it.
    expect((await post("/api/v1/media-view/check", { code })).json).toEqual({ email: "mara@example.com", path: `/i/${item.link}` });
    refused(await post("/api/v1/media-view/check", "{"), 400, "bad_request");
    refused(await post("/api/v1/media-view/check", { code }, { token: NO_TOKEN }), 400, "credentials_not_allowed");
    refused(await post("/api/v1/media-view/check", { code }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    refused(await post("/api/v1/media-view/check", { code: "dpi_" + "0".repeat(40) }), 404, "view_link_invalid");
    refused(await post("/api/v1/media-view/complete", "{"), 400, "bad_request");
    refused(await post("/api/v1/media-view/complete", { code }, { token: NO_TOKEN }), 400, "credentials_not_allowed");
    refused(await post("/api/v1/media-view/complete", { code }, { headers: { origin: "https://evil.example.net" } }), 403, "bad_origin");
    const done = await post("/api/v1/media-view/complete", { code });
    expect(done.json).toEqual({ path: `/i/${item.link}` });
    expect(done.headers.get("set-cookie")).toMatch(/^__Host-dp_media_viewer=dpk_[0-9a-f]{64};/);
    refused(await post("/api/v1/media-view/complete", { code }), 404, "view_link_invalid");
    for (let i = 0; i < 20; i++) await post("/api/v1/media-view/check", { code }, { app: network("203.0.113.81") });
    refused(await post("/api/v1/media-view/check", { code }, { app: network("203.0.113.81") }), 429, "rate_limited");
    refused(await post("/api/v1/media-view/complete", { code }, { app: network("203.0.113.81") }), 429, "rate_limited");

    // The session and signing out.
    const cookie = (done.headers.get("set-cookie") ?? "").split(";")[0];
    expect((await api.call("GET", "/api/v1/media-view/session", { headers: { cookie } })).json).toEqual({ email: "mara@example.com" });
    refused(await api.call("GET", "/api/v1/media-view/session", { token: NO_TOKEN, headers: { cookie } }), 400, "credentials_not_allowed");
    refused(await api.call("POST", "/api/v1/media-view/signout", { token: NO_TOKEN, headers: { cookie, origin: ORIGIN } }), 400, "credentials_not_allowed");
    refused(await api.call("POST", "/api/v1/media-view/signout", { headers: { cookie, origin: "https://evil.example.net" } }), 403, "bad_origin");
    expect((await api.call("POST", "/api/v1/media-view/signout", { headers: { cookie, origin: ORIGIN } })).status).toBe(204);
    const gone = await api.call("GET", "/api/v1/media-view/session", { headers: { cookie } });
    expect([gone.status, gone.text]).toEqual([401, '{"error":"unauthorized"}']);
  });

  it("every answer of shared items is as documented", async () => {
    const { deps, a, b } = await setup();
    const api = client(deps);
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const jsonOf = (token: string | null, body: unknown): Opts => ({ token, body: typeof body === "string" ? body : JSON.stringify(body), headers: JSON_HEADERS });
    const bytesOf = (token: string | null, body: Uint8Array): Opts => ({ token, body: body as NonNullable<RequestInit["body"]> });
    const create = (token: string | null, body: unknown) => api.call("POST", "/api/v1/media", jsonOf(token, body));
    const part = (token: string | null, id: string, n: number | string, body: Uint8Array) => api.call("PUT", `/api/v1/media/${id}/parts/${n}`, bytesOf(token, body));
    const preview = (token: string | null, id: string, body: Uint8Array) => api.call("PUT", `/api/v1/media/${id}/preview`, bytesOf(token, body));
    const commit = (token: string | null, id: string) => api.call("POST", `/api/v1/media/${id}/commit`, { token });
    const image = { kind: "image", content_type: "image/png", bytes: 3000, width: 64, height: 48, title: "A shared image" };
    const clip = { kind: "clip", content_type: "video/mp4", bytes: 2_000_100, width: 320, height: 240, duration_ms: 4000 };

    // An image: start, its part, a PNG preview, finish, read, list, its preview, delete.
    const made = await create(a.token, image);
    expect(made.json).toEqual({ id: made.json.id, parts: 1, part_bytes: 2_000_000 });
    const id = made.json.id as string;
    refused(await part(a.token, id, 0, png(64, 48, 2999)), 400, "bad_part");
    refused(await part(a.token, id, 0, jpeg(64, 48, 3000)), 400, "bad_media");
    refused(await part(a.token, id, 1, png(64, 48, 3000)), 404, "not_found");
    refused(await part(a.token, id, 0, new Uint8Array(2_000_001)), 413, "too_large");
    refused(await commit(a.token, id), 409, "incomplete");
    expect((await part(a.token, id, 0, png(64, 48, 3000))).status).toBe(204);
    refused(await preview(a.token, id, gif(10, 10, 100)), 400, "bad_image");
    refused(await preview(a.token, id, png(10, 10, 100_001)), 413, "too_large");
    refused(await api.call("GET", `/api/v1/media/${id}/preview`, { token: a.token }), 404, "not_found");
    expect((await preview(a.token, id, png(32, 24, 500))).status).toBe(204);
    expect((await api.call("GET", `/api/v1/media/${id}`, { token: a.token })).json.state).toBe("uploading");
    const done = await commit(a.token, id);
    expect(done.json).toMatchObject({ id, kind: "image", path: `/i/${done.json.link_id}` });
    expect((await commit(a.token, id)).json).toEqual(done.json);
    refused(await part(a.token, id, 0, png(64, 48, 3000)), 409, "already_online");
    refused(await preview(a.token, id, png(32, 24, 500)), 409, "already_online");
    const got = await api.call("GET", `/api/v1/media/${id}/preview`, { token: a.token });
    expect([got.status, got.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect((await api.call("GET", `/api/v1/media/${id}`, { token: a.token })).json).toMatchObject({ state: "online", has_preview: true, title: "A shared image" });
    expect((await api.call("GET", "/api/v1/media?kind=image", { token: a.token })).json.items.map((i: Json) => i.id)).toEqual([id]);

    // A clip of two parts with a JPEG preview.
    const twice = await create(a.token, clip);
    const clipId = twice.json.id as string;
    expect(twice.json.parts).toBe(2);
    const file = mp4(clip.bytes);
    expect((await part(a.token, clipId, 1, file.subarray(2_000_000))).status).toBe(204);
    expect((await part(a.token, clipId, 0, file.subarray(0, 2_000_000))).status).toBe(204);
    expect((await preview(a.token, clipId, jpeg(40, 30, 700))).status).toBe(204);
    expect((await commit(a.token, clipId)).json.path).toMatch(/^\/r\/[a-z2-7]{20}$/);
    const jpg = await api.call("GET", `/api/v1/media/${clipId}/preview`, { token: a.token });
    expect([jpg.status, jpg.headers.get("content-type")]).toEqual([200, "image/jpeg"]);

    // The usage and the largest list count both items, each with its preview, in their documented shapes.
    const u = (await api.usage(a.token)).json;
    expect([u.images, u.gifs]).toEqual([1, 1]);
    expect(u.counted.pictures + u.counted.logos + u.counted.uploads_in_progress + u.counted.images + u.counted.gifs).toBe(u.used_bytes);
    const items = ((await api.largest(a.token)).json.largest as Json[]).filter((e) => e.kind !== "tour");
    expect(items.map((e) => [e.kind, e.id, e.title])).toEqual([
      ["gif", clipId, null],
      ["image", id, "A shared image"],
    ]);
    expect(items.map((e) => e.bytes)).toEqual([u.counted.gifs, u.counted.images]);

    // Lists: a page, a bad kind, a bad cursor.
    expect((await api.call("GET", "/api/v1/media?kind=clip", { token: a.token })).json).toMatchObject({ next: null });
    refused(await api.call("GET", "/api/v1/media?kind=film", { token: a.token }), 400, "bad_request");
    refused(await api.call("GET", "/api/v1/media?kind=image&cursor=nope", { token: a.token }), 400, "bad_cursor");

    // Refusals of a create: a field, the body's length, the limits.
    refused(await create(a.token, { ...image, kind: "film" }), 400, "bad_request");
    refused(await create(a.token, { ...image, title: "x".repeat(5000) }), 413, "too_large");
    expect((await create(a.token, { ...image, bytes: 20 * 1024 * 1024 })).json).toMatchObject({ error: "media_too_large", max_bytes: 10 * 1024 * 1024, max_side: 8192 });

    // Nobody, and another workspace's item.
    for (const [method, path] of [["POST", "/api/v1/media"], ["GET", "/api/v1/media?kind=image"], ["GET", `/api/v1/media/${id}`], ["DELETE", `/api/v1/media/${id}`], ["POST", `/api/v1/media/${id}/commit`], ["GET", `/api/v1/media/${id}/preview`]] as const) {
      expect((await api.call(method, path, { token: null })).status, `${method} ${path}`).toBe(401);
      if (method !== "POST" || path !== "/api/v1/media") {
        if (!path.includes("?")) refused(await api.call(method, path, { token: b.token }), 404, "not_found");
      }
    }
    expect((await part(null, id, 0, png(64, 48, 3000))).status).toBe(401);
    expect((await preview(null, id, png(32, 24, 500))).status).toBe(401);
    refused(await preview(b.token, id, png(32, 24, 500)), 404, "not_found");

    // A delete whose files could not all be removed, then the one that finishes it.
    const broken: Deps = { ...deps, drafts: { ...deps.drafts, delete: () => Promise.reject(new Error("the store is down")) } };
    const log = console.error;
    console.error = () => {};
    try {
      const cut = await client(broken).call("DELETE", `/api/v1/media/${clipId}`, { token: a.token });
      refused(cut, 500, "cleanup_pending");
    } finally {
      console.error = log;
    }
    expect((await api.call("DELETE", `/api/v1/media/${clipId}`, { token: a.token })).status).toBe(204);
    expect((await api.call("DELETE", `/api/v1/media/${id}`, { token: a.token })).status).toBe(204);

    // A send whose claim is removed while it writes (as one older than its lifetime is), on an item still open.
    const open = (await create(a.token, { ...image, title: "Still open" })).json.id as string;
    let cut = false;
    const losing: Deps = {
      ...deps,
      drafts: {
        ...deps.drafts,
        put: async (key, body, meta) => {
          if (!cut && key.startsWith(`m/${open}/`)) {
            cut = true;
            await deps.db.run("DELETE FROM media_object WHERE media_id = ? AND claim = ?", [open, key.split(".")[1]]);
          }
          return deps.drafts.put(key, body, meta);
        },
      },
    };
    refused(await client(losing).call("PUT", `/api/v1/media/${open}/parts/0`, bytesOf(a.token, png(64, 48, 3000))), 409, "superseded");
    cut = false;
    refused(await client(losing).call("PUT", `/api/v1/media/${open}/preview`, bytesOf(a.token, png(32, 24, 500))), 409, "superseded");
    expect((await api.call("DELETE", `/api/v1/media/${open}`, { token: a.token })).status).toBe(204);

    // At most so many parts and previews an hour: the counts so far are written directly, one short of each limit.
    const sendsOf = (await create(a.token, image)).json.id as string;
    const key = await workspaceKey(a.workspaceId);
    for (const limit of [LIMITS_MEDIA.part, LIMITS_MEDIA.preview]) {
      await deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, ?) ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = excluded.count", [limit.bucket, key, now - (now % limit.windowMs), limit.most]);
    }
    refused(await part(a.token, sendsOf, 0, png(64, 48, 3000)), 429, "too_many_items");
    refused(await preview(a.token, sendsOf, png(32, 24, 500)), 429, "too_many_items");
    expect((await api.call("DELETE", `/api/v1/media/${sendsOf}`, { token: a.token })).status).toBe(204);

    // At most so many starts an hour.
    for (let i = 0; i < LIMITS_MEDIA.create.most; i++) expect((await send(deps, "POST", "/api/v1/media", jsonOf(b.token, image))).status).toBe(201);
    const over = await create(b.token, image);
    refused(over, 429, "too_many_items");
    now += 3_600_000;

    // The storage allowance: a create and a preview it refuses.
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = 4000 WHERE id = ?", [a.workspaceId]);
    refused(await create(a.token, { ...image, bytes: 4001 }), 413, "storage_full");
    const small = (await create(a.token, image)).json.id as string;
    refused(await preview(a.token, small, png(10, 10, 1001)), 413, "storage_full");
  });

  it("every answer of connecting the app and of the token list is as documented", async () => {
    // Two addresses, so the connected answer names them; then one address, where it does not.
    const hosts = { tours: "tours.example.com", app: "app.example.com" };
    const { deps } = await makeDeps({ hosts });
    const clock = { now: 1_800_000_000_000 };
    deps.now = () => clock.now;
    const api = client(deps);
    await seedAccount(deps, { admin: true });
    const a = await seedAccount(deps);
    const APP = "https://app.example.com";
    const TOURS = "https://tours.example.com";
    const made = await redeemSignInCode(deps, await createSignInCode(deps, a.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const cookie = `${SESSION_COOKIE}=${made.secret}`;
    const page = { cookie, origin: APP, "x-csrf-token": await csrfFor(made.secret), "content-type": JSON_TYPE };
    const fromNetwork = (address: string) => (d: Deps) => ({ fetch: (req: Request) => (setClientAddress(req, address), createApp(d).fetch(req)) });
    const start = (body: unknown, more: Opts = {}) => api.call("POST", "/api/v1/connect/start", { origin: TOURS, ...more, body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...JSON_HEADERS, ...more.headers } });
    const poll = (body: unknown, more: Opts = {}) => api.call("POST", "/api/v1/connect/token", { origin: TOURS, ...more, body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...JSON_HEADERS, ...more.headers } });
    const settle = (how: string, body: unknown, more: Opts = {}) => api.call("POST", `/api/v1/connect/${how}`, { origin: APP, headers: page, body: typeof body === "string" ? body : JSON.stringify(body), ...more });
    const lookup = (code: string, more: Opts = {}) => settle("lookup", { user_code: code }, more);

    // Starting, and its refusals.
    const r = await start({ device_name: "Laptop" });
    expect(r.status).toBe(201);
    refused(await start("not json"), 400, "bad_request");
    refused(await start({ device_name: "" }), 400, "bad_device_name");
    refused(await start({ device_name: "x" }, { token: a.token }), 400, "credentials_not_allowed");
    for (let i = 0; i < 10; i++) expect((await start({ device_name: `n${i}` }, { app: fromNetwork("203.0.113.70") })).status).toBeLessThan(500);
    refused(await start({ device_name: "x" }, { app: fromNetwork("203.0.113.70") }), 429, "rate_limited");

    // Asking for the token: pending, too soon, the refusals.
    expect((await poll({ device_code: r.json.device_code })).json).toEqual({ status: "pending" });
    refused(await poll({ device_code: r.json.device_code }), 429, "slow_down");
    refused(await poll({ device_code: "dpd_" + "0".repeat(40) }), 410, "expired_code");
    refused(await poll("[]"), 400, "bad_request");
    refused(await poll({ device_code: r.json.device_code }, { headers: { cookie } }), 400, "credentials_not_allowed");
    for (let i = 0; i < 360; i++) await send(deps, "POST", "/api/v1/connect/token", { body: "{}", headers: JSON_HEADERS, app: fromNetwork("203.0.113.71") });
    refused(await poll({ device_code: r.json.device_code }, { app: fromNetwork("203.0.113.71") }), 429, "rate_limited");

    // The dashboard: lookup, confirm, and the token, with both addresses.
    expect((await lookup(r.json.user_code)).json).toEqual({ device_name: "Laptop", asked_at: clock.now, same_network: false });
    refused(await lookup(r.json.user_code, { headers: JSON_HEADERS, token: a.token }), 401, "unauthorized");
    refused(await settle("lookup", "{"), 400, "bad_request");
    refused(await settle("confirm", "{"), 400, "bad_request");
    refused(await settle("refuse", "{"), 400, "bad_request");
    refused(await settle("confirm", { user_code: r.json.user_code }, { headers: JSON_HEADERS, token: a.token }), 401, "unauthorized");
    refused(await settle("refuse", { user_code: r.json.user_code }, { headers: JSON_HEADERS, token: a.token }), 401, "unauthorized");
    expect((await settle("confirm", { user_code: r.json.user_code })).status).toBe(204);
    refused(await lookup(r.json.user_code), 404, "not_found");
    refused(await settle("confirm", { user_code: r.json.user_code }), 404, "not_found");
    const other = await start({ device_name: "Other" });
    expect((await settle("refuse", { user_code: other.json.user_code })).status).toBe(204);
    refused(await settle("refuse", { user_code: other.json.user_code }), 404, "not_found");
    clock.now += 5000;
    const got = await poll({ device_code: r.json.device_code });
    expect(got.json.addresses).toEqual(hosts);
    expect(got.json.account).toEqual({ username: null });
    // A fifth wrong code: everything is 429 for the rest of the window.
    for (let i = 0; i < 2; i++) refused(await lookup("ABCD-EFGH"), 404, "not_found");
    for (const call of [await lookup("ABCD-EFGH"), await settle("confirm", { user_code: "ABCD-EFGH" }), await settle("refuse", { user_code: "ABCD-EFGH" })]) refused(call, 429, "rate_limited");

    // The token list.
    const list = await api.call("GET", "/api/v1/tokens", { origin: APP, headers: { cookie } });
    expect(list.json.tokens.map((t: Json) => t.kind)).toEqual(["sign_in", "setup"]);
    refused(await api.call("GET", "/api/v1/tokens", { origin: APP, token: a.token }), 401, "unauthorized");
    const id = list.json.tokens[0].id as string;
    const renamed = await api.call("PATCH", `/api/v1/tokens/${id}`, { origin: APP, headers: page, body: JSON.stringify({ name: "Studio" }) });
    expect(renamed.json.name).toBe("Studio");
    refused(await api.call("PATCH", `/api/v1/tokens/${id}`, { origin: APP, headers: page, body: "[]" }), 400, "bad_request");
    refused(await api.call("PATCH", `/api/v1/tokens/${id}`, { origin: APP, headers: page, body: JSON.stringify({ name: "" }) }), 400, "bad_name");
    refused(await api.call("PATCH", `/api/v1/tokens/${id}`, { origin: APP, token: a.token, body: JSON.stringify({ name: "x" }), headers: JSON_HEADERS }), 401, "unauthorized");
    refused(await api.call("PATCH", `/api/v1/tokens/tok_${"0".repeat(24)}`, { origin: APP, headers: page, body: JSON.stringify({ name: "x" }) }), 404, "not_found");
    refused(await api.call("DELETE", `/api/v1/tokens/${id}`, { origin: APP, token: a.token }), 401, "unauthorized");
    expect((await api.call("DELETE", `/api/v1/tokens/${id}`, { origin: APP, headers: page })).status).toBe(204);
    refused(await api.call("DELETE", `/api/v1/tokens/${id}`, { origin: APP, headers: page }), 404, "not_found");

    // One address: the connected answer has no addresses.
    const one = await makeDeps();
    const oneApi = client(one.deps);
    await seedAccount(one.deps, { admin: true });
    const b = await seedAccount(one.deps);
    const bMade = await redeemSignInCode(one.deps, await createSignInCode(one.deps, b.userId), null, null);
    if (bMade === null) throw new Error("the sign-in was refused");
    const started = await oneApi.call("POST", "/api/v1/connect/start", { body: JSON.stringify({ device_name: "Desk" }), headers: JSON_HEADERS });
    const bPage = { cookie: `${SESSION_COOKIE}=${bMade.secret}`, origin: "https://tours.example.com", "x-csrf-token": await csrfFor(bMade.secret), "content-type": JSON_TYPE };
    expect((await oneApi.call("POST", "/api/v1/connect/confirm", { headers: bPage, body: JSON.stringify({ user_code: started.json.user_code }) })).status).toBe(204);
    const oneGot = await oneApi.call("POST", "/api/v1/connect/token", { body: JSON.stringify({ device_code: started.json.device_code }), headers: JSON_HEADERS });
    expect(oneGot.json.status).toBe("connected");
    expect(Object.hasOwn(oneGot.json, "addresses")).toBe(false);
  });

  it("the answers any request can get are as the introduction says", async () => {
    const intro = DOC.info.description;
    const hosts = { tours: "tours.example.com", app: "app.example.com" };
    const { deps, a } = await setup({ hosts });

    expect(intro).toContain('`401 {"error":"unauthorized"}`, with no detail');
    const noToken = await send(deps, "GET", "/api/v1/tours");
    expect([noToken.status, noToken.text]).toEqual([401, '{"error":"unauthorized"}']);

    expect(intro).toContain('`404 {"error":"not_found"}`, with no detail: no request has that address');
    const nowhere = await send(deps, "GET", "/api/v1/nothing-here", { token: a.token });
    expect([nowhere.status, nowhere.text, nowhere.headers.get("content-type")]).toEqual([404, '{"error":"not_found"}', JSON_TYPE]);

    expect(intro).toContain("`421` with nothing in it: on a server with two addresses, the request was sent to another host name");
    const elsewhere = await send(deps, "GET", "/api/v1/tours", { token: a.token, origin: "https://other.example.net" });
    expect([elsewhere.status, elsewhere.bytes.byteLength]).toEqual([421, 0]);

    expect(intro).toContain('`500 {"error":"internal"}`: the server failed; nothing about the failure is given');
    const realAll = deps.db.all.bind(deps.db);
    deps.db.all = async () => {
      throw new Error("database unavailable");
    };
    const failed = await send(deps, "GET", "/api/v1/tours", { token: a.token });
    deps.db.all = realAll;
    expect([failed.status, failed.text]).toEqual([500, '{"error":"internal"}']);

    // The three answers of a request that carries a session cookie, on any route that takes one.
    const account = await seedAccount(deps, { admin: true });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, account.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const cookie = `${SESSION_COOKIE}=${made.secret}`;
    const APP = "https://app.example.com";
    const mixed = '`400 {"error":"mixed_credentials","detail":"send a token or a session cookie, not both"}`';
    expect(intro).toContain(mixed);
    const both = await send(deps, "GET", "/api/v1/tours", { origin: APP, token: account.token, headers: { cookie } });
    expect("`400 " + both.text + "`").toBe(mixed);
    const badOrigin = "`403 {\"error\":\"bad_origin\",\"detail\":\"this request must come from the site's own pages\"}`";
    expect(intro).toContain(badOrigin);
    const forged = await send(deps, "PATCH", "/api/v1/tours/tour_" + "0".repeat(24), { origin: APP, body: "{}", headers: { cookie, "content-type": JSON_TYPE, origin: "https://tours.example.com", "x-csrf-token": await csrfFor(made.secret) } });
    expect("`403 " + forged.text + "`").toBe(badOrigin);
    const badCsrf = '`403 {"error":"bad_csrf","detail":"the anti-forgery header is missing or wrong"}`';
    expect(intro).toContain(badCsrf);
    const noHeader = await send(deps, "DELETE", "/api/v1/tours/tour_" + "0".repeat(24), { origin: APP, headers: { cookie, origin: APP } });
    expect("`403 " + noHeader.text + "`").toBe(badCsrf);
    // A session on the tours address is nobody: the one 401.
    const onTours = await send(deps, "GET", "/api/v1/tours", { origin: "https://tours.example.com", headers: { cookie } });
    expect([onTours.status, onTours.text]).toEqual([401, '{"error":"unauthorized"}']);
    // A session whose account has not agreed to the site's terms: the refusal any session route can give, the admin's too.
    const termsRequired = '`403 {"error":"terms_required","detail":"agree to the site\'s terms first"}`';
    expect(intro).toContain(termsRequired);
    const read = await parseTerms(new TextEncoder().encode("title: T\nversion: 1\nmain points:\n- P\nterms:\nB\n"));
    if (!read.ok) throw new Error(read.reason);
    await publishTerms(deps, read);
    for (const path of ["/api/v1/tours", "/api/v1/admin/accounts"]) {
      const held = await send(deps, "GET", path, { origin: APP, headers: { cookie } });
      expect("`403 " + held.text + "`", path).toBe(termsRequired);
    }
    // `500 {"error":"misconfigured"}` is answered by the Cloudflare entry before the app
    // runs (test/worker-hosts.test.ts); no route answers it.
  });

  it("every answer of the site's terms is as documented", async () => {
    const { deps } = await makeDeps();
    deps.now = () => 1_800_000_000_000;
    const api = client(deps);
    const admin = await seedAccount(deps, { admin: true });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const cookie = `${SESSION_COOKIE}=${made.secret}`;
    const page = { cookie, "x-csrf-token": await csrfFor(made.secret), origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": JSON_TYPE };
    const agree = (body: unknown, headers: Record<string, string> = page) => api.call("POST", "/api/v1/terms/agree", { headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    // No terms yet: both reads answer, and agreeing is refused.
    expect((await api.call("GET", "/api/v1/terms", { headers: { cookie } })).json.terms).toBeNull();
    expect((await api.call("GET", "/api/v1/terms/agreed", { headers: { cookie } })).json.terms).toBeNull();
    refused(await agree({ terms: "trm_" + "0".repeat(24) }), 409, "terms_changed");
    expect((await api.call("GET", "/api/v1/session", { headers: { cookie } })).json.terms_agreed).toBeUndefined();
    // Terms with every kind of block and a link.
    const read = await parseTerms(new TextEncoder().encode("title: T\nversion: 1\nlink: Terms | https://example.com/terms\nmain points:\n- P\nterms:\n# H\nText.\n- a\n"));
    if (!read.ok) throw new Error(read.reason);
    const published = await publishTerms(deps, read);
    if (!published.ok) throw new Error("not published");
    const state = await api.call("GET", "/api/v1/terms", { headers: { cookie } });
    expect(state.json.required).toBe(true);
    refused(await agree("not json"), 400, "bad_request");
    refused(await agree({ terms: published.id }, { ...page, origin: "https://evil.example.net" }), 403, "bad_origin");
    refused(await agree({ terms: published.id }, { ...page, "x-csrf-token": "" }), 403, "bad_csrf");
    expect((await agree({ terms: published.id })).status).toBe(204);
    expect((await api.call("GET", "/api/v1/terms/agreed", { headers: { cookie } })).json.terms.id).toBe(published.id);
    expect((await api.call("GET", "/api/v1/session", { headers: { cookie } })).json.terms_agreed).toEqual({ version: "1", agreed_at: 1_800_000_000_000 });
    expect((await api.call("GET", "/api/v1/admin/accounts", { headers: { cookie } })).json.accounts[0].terms).toEqual({ version: "1", agreed_at: 1_800_000_000_000, current: true });
    for (const path of ["/api/v1/terms", "/api/v1/terms/agreed"]) refused(await api.call("GET", path, { token: admin.token }), 401, "unauthorized");
    refused(await api.call("POST", "/api/v1/terms/agree", { token: admin.token, headers: { "content-type": JSON_TYPE }, body: JSON.stringify({ terms: published.id }) }), 401, "unauthorized");
  });

  it("who may view, stated by a token at an item's create and a tour's first publish, answers as documented", async () => {
    // A site that can mail links, as restricting needs; clips as long as one answer can send.
    const { deps } = await setup({ siteHost: "tours.example.com", mediaClipMaxBytes: 38 * 2_000_000 });
    // Signing in needs a site with an admin: the owner is it.
    const a = await seedAccount(deps, { admin: true });
    const api = client(deps);
    const create = (body: unknown) => api.call("POST", "/api/v1/media", { token: a.token, body: JSON.stringify(body), headers: JSON_HEADERS });
    const image = { kind: "image", content_type: "image/png", bytes: 3000, width: 64, height: 48 };
    // An item: created restricted, with and without a list; every refusal.
    expect((await create({ ...image, access: "people", viewers: ["mara@example.com"] })).json).toMatchObject({ access: "people", viewers: 1 });
    expect((await create({ ...image, access: "me" })).json).toMatchObject({ access: "me", viewers: 0 });
    refused(await create({ ...image, access: "friends" }), 400, "bad_access");
    refused(await create({ ...image, access: "people", viewers: ["not an address"] }), 400, "bad_viewer");
    refused(await create({ ...image, access: "people", viewers: Array.from({ length: 201 }, (_, i) => `v${i}@example.com`) }), 400, "too_many_viewers");
    refused(await create({ kind: "clip", content_type: "video/mp4", bytes: 36 * 2_000_000, width: 64, height: 48, duration_ms: 1000, access: "me" }), 409, "too_large_to_restrict");
    // A tour: its first publish restricted, then every refusal.
    const first = await api.upload(a.token, small(1, "First published restricted"));
    expect((await api.publish(a.token, first.tour_id, { access: "people", viewers: ["mara@example.com"] })).json).toMatchObject({ access: "people", viewers: 1 });
    refused(await api.publish(a.token, first.tour_id, { access: "me" }), 409, "already_published");
    const draft = await api.upload(a.token, small(1, "Never published"));
    refused(await api.publish(a.token, draft.tour_id, { access: "friends" }), 400, "bad_access");
    refused(await api.publish(a.token, draft.tour_id, { access: "people", viewers: ["not an address"] }), 400, "bad_viewer");
    refused(await api.publish(a.token, draft.tour_id, { access: "people", viewers: Array.from({ length: 201 }, (_, i) => `v${i}@example.com`) }), 400, "too_many_viewers");
    const made = (await redeemSignInCode(deps, await createSignInCode(deps, a.userId), null, null))!;
    const session = { cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
    expect((await api.setAccess(session, draft.tour_id, { access: "me" })).status).toBe(200);
    refused(await api.publish(a.token, draft.tour_id, { access: "people" }), 409, "access_already_set");
    // A site that cannot mail.
    deps.mail = undefined;
    refused(await create({ ...image, access: "me" }), 409, "cannot_restrict");
    const other = await api.upload(a.token, small(1, "No mail"));
    refused(await api.publish(a.token, other.tour_id, { access: "me" }), 409, "cannot_restrict");
  });
  it("on a site with billing, a read-only workspace's refusals of upload, publish and share are as documented", async () => {
    const { deps } = await makeDeps();
    withBilling(deps);
    let now = 1_800_000_000_000;
    deps.now = () => now;
    await seedAccount(deps, { username: "siteadmin", admin: true });
    const owner = await seedAccount(deps, { username: "lapsed" });
    const m = clone(fixtures.v2 as Json);
    m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
    const tour = await uploadTour(deps, owner.token, m);
    now += TRIAL_MS + 86_400_000;
    const session = await sessionOf(deps, owner.userId);
    const api = client(deps);
    const refused = (r: Call) => expect([r.status, r.json?.error]).toEqual([402, "subscription_ended"]);
    refused(await api.call("POST", "/api/v1/uploads", { token: owner.token, body: JSON.stringify({ manifest: m, target: NEW }), headers: JSON_HEADERS }));
    refused(await api.call("POST", "/api/v1/media", { token: owner.token, body: JSON.stringify({ kind: "image", content_type: "image/png", bytes: 100, width: 8, height: 8, title: "x" }), headers: JSON_HEADERS }));
    refused(await api.call("POST", `/api/v1/tours/${tour.tour_id}/publish`, { token: owner.token }));
    refused(await api.call("PUT", `/api/v1/tours/${tour.tour_id}/access`, { body: JSON.stringify({ access: "public" }), headers: { ...JSON_HEADERS, ...session.headers } }));
    refused(await api.call("PUT", `/api/v1/media/med_${"0".repeat(24)}/access`, { body: JSON.stringify({ access: "public" }), headers: { ...JSON_HEADERS, ...session.headers } }));
    // The admin's summary on a site with billing carries its billing problems.
    const admin = await deps.db.first<{ id: string }>("SELECT id FROM user WHERE is_admin = 1");
    const summary = await api.call("GET", "/api/v1/admin/summary", { headers: (await sessionOf(deps, admin!.id)).headers });
    expect(summary.json.billing_problems).toEqual({ count: 0, recent: [] });
  });
});

describe("the two 403s of a change made with a session, on each route that takes a session alone", () => {
  it("bad_origin from another origin, bad_csrf without the anti-forgery header", async () => {
    const { deps } = await makeDeps();
    const api = client(deps);
    const account = await seedAccount(deps, { admin: true });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, account.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const cookie = `${SESSION_COOKIE}=${made.secret}`;
    const csrf = await csrfFor(made.secret);
    const APP = "https://app.example.com";
    const TOKEN = "tok_" + "0".repeat(24);
    const routes: [string, string, unknown][] = [
      ["DELETE", "/api/v1/sessions/ses_" + "0".repeat(24), undefined],
      ["POST", "/api/v1/signout", undefined],
      ["POST", "/api/v1/signout/everywhere", undefined],
      ["POST", "/api/v1/account/email", { email: "new@example.com" }],
      ["POST", "/api/v1/account/email/confirm", { code: "dpe_" + "0".repeat(40) }],
      ["POST", "/api/v1/connect/lookup", { user_code: "ABCD-EFGH" }],
      ["POST", "/api/v1/connect/confirm", { user_code: "ABCD-EFGH" }],
      ["POST", "/api/v1/connect/refuse", { user_code: "ABCD-EFGH" }],
      ["PATCH", `/api/v1/tokens/${TOKEN}`, { name: "Laptop" }],
      ["DELETE", `/api/v1/tokens/${TOKEN}`, undefined],
      ["PUT", `/api/v1/tours/tour_${"0".repeat(24)}/access`, { access: "me" }],
      ["PUT", `/api/v1/media/med_${"0".repeat(24)}/access`, { access: "me" }],
    ];
    for (const [method, path, body] of routes) {
      const withBody = body === undefined ? {} : { body: JSON.stringify(body) };
      const forged = await api.call(method, path, { origin: APP, ...withBody, headers: { cookie, "content-type": JSON_TYPE, origin: "https://evil.example.net", "x-csrf-token": csrf } });
      expect([forged.status, forged.json?.error], `${method} ${path}`).toEqual([403, "bad_origin"]);
      const bare = await api.call(method, path, { origin: APP, ...withBody, headers: { cookie, "content-type": JSON_TYPE, origin: APP } });
      expect([bare.status, bare.json?.error], `${method} ${path}`).toEqual([403, "bad_csrf"]);
    }
  });
});

describe("the description is checked in full", () => {
  /** Every schema the description holds, with where it is. References are not followed: their targets are in the list themselves. */
  function allSchemas(): { at: string; schema: Json; answer: boolean }[] {
    const out: { at: string; schema: Json; answer: boolean }[] = [];
    for (const [name, schema] of Object.entries(DOC.components.schemas)) out.push({ at: `schemas.${name}`, schema: schema as Json, answer: false });
    const ofResponse = (at: string, res: Json) => {
      for (const [type, media] of Object.entries((res.content ?? {}) as Record<string, Json>)) out.push({ at: `${at} ${type}`, schema: media.schema, answer: true });
      for (const [name, header] of Object.entries((res.headers ?? {}) as Record<string, Json>)) out.push({ at: `${at} header ${name}`, schema: header.schema, answer: false });
    };
    for (const [name, res] of Object.entries(DOC.components.responses)) ofResponse(`responses.${name}`, res as Json);
    for (const op of OPS) {
      for (const p of (op.op.parameters ?? []) as Json[]) out.push({ at: `${op.key} {${p.name}}`, schema: p.schema, answer: false });
      for (const [type, media] of Object.entries((op.op.requestBody?.content ?? {}) as Record<string, Json>)) out.push({ at: `${op.key} request ${type}`, schema: media.schema, answer: false });
      for (const [status, res] of Object.entries(op.op.responses as Record<string, Json>)) if (res.$ref === undefined) ofResponse(`${op.key} ${status}`, res);
    }
    return out;
  }

  it("the checker knows every keyword the description uses, and no other", () => {
    const used = new Set<string>();
    for (const { schema } of allSchemas()) keywordsOf(schema, used);
    expect([...used].sort(), "a keyword only one side has: check it in test/openapi-schema.ts (or drop it there), so nothing the description says is ignored").toEqual([...KEYWORDS].sort());
  });

  it("every answer's schema is closed: no field may come that the description does not name", () => {
    const open: string[] = [];
    const visit = (at: string, raw: Json, depth = 0): void => {
      if (depth > 12) throw new Error(`${at}: schemas nested too deep`);
      const s = deref(DOC, raw) as Json;
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if ((types.includes("object") || s.properties !== undefined) && s.additionalProperties !== false) open.push(at);
      for (const [name, sub] of Object.entries((s.properties ?? {}) as Record<string, Json>)) visit(`${at}.${name}`, sub, depth + 1);
      if (s.items !== undefined) visit(`${at}[]`, s.items, depth + 1);
      for (const [i, sub] of ((s.oneOf ?? []) as Json[]).entries()) visit(`${at} shape ${i + 1}`, sub, depth + 1);
    };
    const answers = allSchemas().filter((x) => x.answer);
    expect(answers.length).toBeGreaterThan(40);
    for (const { at, schema } of answers) visit(at, schema);
    expect(open, "these answers accept fields the description does not name; close them with additionalProperties: false").toEqual([]);
  });

  it("the schema checker itself refuses a missing field, an extra field and a wrong type, and a keyword it does not know", () => {
    const tour = { $ref: "#/components/schemas/Tour" };
    const good: Json = { id: NO_TOUR, title: "A tour", status: "draft", slug: "abcdefghij", url: null, chapters: 1, steps: 3, bytes: 0, updated_at: 1, published_at: null, unpublished_changes: false, access: "public", viewers: 0 };
    expect(check(DOC, tour, good)).toEqual([]);
    const { unpublished_changes: _gone, ...lacking } = good;
    expect(check(DOC, tour, lacking)).toEqual(['$: the required field "unpublished_changes" is missing']);
    expect(check(DOC, tour, { ...good, owner: "someone" })).toEqual(['$: the field "owner" is not in the description']);
    expect(check(DOC, tour, { ...good, steps: "3" })).toEqual(['$.steps: expected integer, got string "3"']);
    expect(check(DOC, tour, { ...good, steps: 2.5 })).toHaveLength(1);
    expect(check(DOC, tour, { ...good, steps: -1 })).toEqual(["$.steps: -1 breaks minimum 0"]);
    expect(check(DOC, tour, { ...good, status: "live" })).toHaveLength(1);
    expect(check(DOC, tour, { ...good, id: "tour_1" })).toHaveLength(1);
    expect(check(DOC, tour, { ...good, url: 5 })).toHaveLength(1);
    expect(check(DOC, tour, [good])).not.toEqual([]);
    expect(check(DOC, { $ref: "#/components/schemas/TourList" }, { tours: [good, { ...good, title: 7 }] })).toEqual(["$.tours[1].title: expected string, got integer 7"]);
    // Exactly one shape of a oneOf, a constant, and each bound.
    const created = { oneOf: [{ $ref: "#/components/schemas/UploadCreated" }, { $ref: "#/components/schemas/ReplaceCreated" }] };
    expect(check(DOC, created, { upload_id: NO_UPLOAD, steps: 2 })).toEqual([]);
    expect(check(DOC, created, { upload_id: NO_UPLOAD, steps: 2, have: [1], settings: false })).toEqual([]);
    expect(check(DOC, created, { upload_id: NO_UPLOAD, steps: 2, have: [1] })).toHaveLength(1);
    expect(check(DOC, { oneOf: [{ type: "integer" }, { type: "number" }] }, 1)).toEqual(["$: fits 2 of the oneOf shapes, must fit exactly one"]);
    expect(check(DOC, { const: true }, false)).toHaveLength(1);
    expect(check(DOC, { type: "string", minLength: 2, maxLength: 3 }, "é")).toHaveLength(1);
    expect(check(DOC, { type: "string", minLength: 2, maxLength: 3 }, "éé")).toEqual([]);
    expect(check(DOC, { type: "string", minLength: 2, maxLength: 3 }, "éééé")).toHaveLength(1);
    expect(check(DOC, { type: "number", exclusiveMinimum: 0, maximum: 100 }, 0)).toHaveLength(1);
    expect(check(DOC, { type: "number", exclusiveMinimum: 0, maximum: 100 }, 100.5)).toHaveLength(1);
    expect(check(DOC, { type: "array", minItems: 1, maxItems: 2, items: { type: "integer" } }, [])).toHaveLength(1);
    expect(check(DOC, { type: "array", minItems: 1, maxItems: 2, items: { type: "integer" } }, [1, 2, 3])).toHaveLength(1);
    expect(check(DOC, { type: ["string", "null"] }, null)).toEqual([]);
    expect(check(DOC, { type: "string", format: "binary" }, new Uint8Array(3))).toEqual([]);
    expect(check(DOC, { type: "string", format: "binary" }, "text")).toHaveLength(1);
    expect(check(DOC, { type: "string" }, new Uint8Array(3))).toHaveLength(1);
    // What it does not know, it refuses to pass over.
    expect(() => check(DOC, { type: "string", contentEncoding: "base64" }, "x")).toThrow(/unknown keyword "contentEncoding"/);
    expect(() => check(DOC, { type: "object", properties: { a: { allOf: [] } } }, {})).toThrow(/unknown keyword "allOf"/);
    expect(() => check(DOC, { type: "string", format: "date-time" }, "x")).toThrow(/format/);
    expect(() => check(DOC, { type: "text" }, "x")).toThrow(/unknown type/);
    expect(() => check(DOC, { type: "object", additionalProperties: { type: "string" } }, {})).toThrow(/additionalProperties/);
    expect(() => check(DOC, { type: "object", required: ["a"] }, {})).toThrow(/required names "a"/);
    expect(() => check(DOC, { $ref: "#/components/schemas/Nothing" }, {})).toThrow(/nothing is there/);
  });

  it("a documented case that is neither reached nor listed with a reason is reported, and so is a stale entry in the list", () => {
    const documented = ["GET /a 200", "GET /a 404 not_found", "GET /a 500 broken"];
    const reached = (c: string) => c !== "GET /a 500 broken";
    expect(coverageProblems(documented, reached, {})).toEqual({ neverReached: ["GET /a 500 broken"], excusedButReached: [], excusedButNotDocumented: [], excusedWithoutReason: [] });
    expect(coverageProblems(documented, reached, { "GET /a 500 broken": "needs a store that fails in a way no test can make" }).neverReached).toEqual([]);
    expect(coverageProblems(documented, reached, { "GET /a 200": "is reached, so this entry is stale and must go" }).excusedButReached).toEqual(["GET /a 200"]);
    expect(coverageProblems(documented, reached, { "GET /b 200": "is not in the description at all, so it must go" }).excusedButNotDocumented).toEqual(["GET /b 200"]);
    expect(coverageProblems(documented, reached, { "GET /a 500 broken": "todo" }).excusedWithoutReason).toEqual(["GET /a 500 broken"]);
  });

  // Last, after every request above: it reads what they recorded.
  it("every documented status was seen, in each of its documented forms, or is listed in NOT_EXERCISED with its reason", () => {
    const documented = documentedCases();
    expect(new Set(documented).size, "two documented cases read the same").toBe(documented.length);
    expect(documented.length).toBeGreaterThan(60);
    for (const op of OPS) for (const status of Object.keys(op.op.responses)) expect(documented.some((c) => c.startsWith(`${op.key} ${status}`)), `${op.key} ${status}`).toBe(true);
    // verify() only records cases it built from the description, so each one seen is documented.
    expect([...seen.keys()].filter((c) => !documented.includes(c))).toEqual([]);
    const problems = coverageProblems(documented, (c) => seen.has(c), NOT_EXERCISED);
    expect(problems.neverReached, "documented, but no test in this file reached it: reach it through client(), or list it in NOT_EXERCISED with the reason (if the site cannot answer it at all, remove it from src/docs/openapi.ts)").toEqual([]);
    expect(problems.excusedButReached, "listed in NOT_EXERCISED, yet a test reached it: remove it from the list").toEqual([]);
    expect(problems.excusedButNotDocumented, "listed in NOT_EXERCISED, but the description has no such case: remove it from the list").toEqual([]);
    expect(problems.excusedWithoutReason, "an entry of NOT_EXERCISED needs its reason").toEqual([]);
  });
});

// The source of every module beside the route table, read through Vite's ?raw import, which works under both Vitest configs.
const SOURCES = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("the error codes in the code", () => {
  it("every error code the API routes can answer is in the description, with its status, and no other", () => {
    const source = (file: string) => {
      const text = SOURCES[`../src/${file}`];
      expect(typeof text, `src/${file} was not read`).toBe("string");
      return text;
    };
    const inCode = new Set<string>();
    let calls = 0;
    for (const file of ["tours.ts", "uploads.ts", "publish.ts", "access.ts", "viewing.ts", "media-access.ts", "chapters.ts"]) {
      const literal = [...source(file).matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
      // Every call names its status and code in place, so none escapes this reading.
      expect(literal.length, `${file}: an apiError call without a literal status and code`).toBe([...source(file).matchAll(/\bapiError\(/g)].length);
      calls += literal.length;
      for (const m of literal) inCode.add(`${m[1]} ${m[2]}`);
    }
    expect(calls).toBeGreaterThan(40);
    // The sign-in routes answer with apiError, and with plain JSON for the refusals that have no detail.
    const signin = source("signin.ts");
    const signinLiteral = [...signin.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
    expect(signinLiteral.length, "signin.ts: an apiError call without a literal status and code").toBe([...signin.matchAll(/\bapiError\(/g)].length);
    for (const m of signinLiteral) inCode.add(`${m[1]} ${m[2]}`);
    const signinPlain = [...signin.matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)];
    expect(signinPlain.length, "signin.ts: an error answer not built in place").toBe([...signin.matchAll(/\berror: "/g)].length);
    for (const m of signinPlain) inCode.add(`${m[1]} ${m[2]}`);
    expect([...inCode]).toEqual(expect.arrayContaining(["400 bad_email", "400 bad_code", "403 link_invalid", "429 rate_limited"]));
    // Changing the email address answers the same way: apiError, and plain JSON for bad_email, which has no detail.
    const email = source("email-change.ts");
    const emailLiteral = [...email.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
    expect(emailLiteral.length, "email-change.ts: an apiError call without a literal status and code").toBe([...email.matchAll(/\bapiError\(/g)].length);
    for (const m of emailLiteral) inCode.add(`${m[1]} ${m[2]}`);
    const emailPlain = [...email.matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)];
    expect(emailPlain.length, "email-change.ts: an error answer not built in place").toBe([...email.matchAll(/\berror: "/g)].length);
    for (const m of emailPlain) inCode.add(`${m[1]} ${m[2]}`);
    expect([...inCode]).toEqual(expect.arrayContaining(["409 mail_off"]));
    // The admin routes answer with apiError, and with plain JSON for their one 404, which has no detail.
    const admin = source("admin-api.ts");
    const adminLiteral = [...admin.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
    expect(adminLiteral.length, "admin-api.ts: an apiError call without a literal status and code").toBe([...admin.matchAll(/\bapiError\(/g)].length);
    for (const m of adminLiteral) inCode.add(`${m[1]} ${m[2]}`);
    const adminPlain = [...admin.matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)];
    expect(adminPlain.length, "admin-api.ts: an error answer not built in place").toBe([...admin.matchAll(/\berror: "/g)].length);
    for (const m of adminPlain) inCode.add(`${m[1]} ${m[2]}`);
    expect([...inCode]).toEqual(expect.arrayContaining(["400 bad_allowance", "404 not_found"]));
    // So do the routes that disable, enable and delete an account.
    const removal = source("account-removal.ts");
    const removalLiteral = [...removal.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
    expect(removalLiteral.length, "account-removal.ts: an apiError call without a literal status and code").toBe([...removal.matchAll(/\bapiError\(/g)].length);
    for (const m of removalLiteral) inCode.add(`${m[1]} ${m[2]}`);
    const removalPlain = [...removal.matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)];
    expect(removalPlain.length, "account-removal.ts: an error answer not built in place").toBe([...removal.matchAll(/\berror: "/g)].length);
    for (const m of removalPlain) inCode.add(`${m[1]} ${m[2]}`);
    expect([...inCode]).toEqual(expect.arrayContaining(["409 own_account", "409 last_admin", "409 not_disabled", "409 deleting", "409 site_owner", "400 username_mismatch"]));
    // Invites answer with apiError, and with plain JSON for bad_email and the admin routes' one 404, which have no detail.
    const invites = source("invites.ts");
    const invitesLiteral = [...invites.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
    expect(invitesLiteral.length, "invites.ts: an apiError call without a literal status and code").toBe([...invites.matchAll(/\bapiError\(/g)].length);
    for (const m of invitesLiteral) inCode.add(`${m[1]} ${m[2]}`);
    const invitesPlain = [...invites.matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)];
    expect(invitesPlain.length, "invites.ts: an error answer not built in place").toBe([...invites.matchAll(/\berror: "/g)].length);
    for (const m of invitesPlain) inCode.add(`${m[1]} ${m[2]}`);
    expect([...inCode]).toEqual(expect.arrayContaining(["404 invite_invalid", "409 signed_in", "409 has_account", "409 too_many_invites", "502 mail_failed", "400 bad_username", "400 reserved_username", "409 username_taken"]));
    // Shared items answer with apiError, and with plain JSON for the one refusal that carries the limits.
    const media = source("media.ts");
    const mediaLiteral = [...media.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
    expect(mediaLiteral.length, "media.ts: an apiError call without a literal status and code").toBe([...media.matchAll(/\bapiError\(/g)].length);
    for (const m of mediaLiteral) inCode.add(`${m[1]} ${m[2]}`);
    const mediaPlain = [...media.matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)];
    expect(mediaPlain.length, "media.ts: an error answer not built in place").toBe([...media.matchAll(/\berror: "/g)].length);
    for (const m of mediaPlain) inCode.add(`${m[1]} ${m[2]}`);
    expect([...inCode]).toEqual(expect.arrayContaining(["413 media_too_large", "429 too_many_items", "400 bad_media", "409 already_online"]));
    // Connecting the app and the token list answer with apiError alone, every call with its status and code in place.
    for (const file of ["connect.ts", "tokens.ts"]) {
      const text = source(file);
      const literal = [...text.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
      expect(literal.length, `${file}: an apiError call without a literal status and code`).toBe([...text.matchAll(/\bapiError\(/g)].length);
      expect([...text.matchAll(/\berror: "/g)], `${file}: an error answer not built by apiError`).toHaveLength(0);
      for (const m of literal) inCode.add(`${m[1]} ${m[2]}`);
    }
    expect([...inCode]).toEqual(expect.arrayContaining(["410 expired_code", "429 slow_down", "400 credentials_not_allowed", "400 bad_device_name", "400 bad_name"]));
    // A visitor proving an address answers with apiError, and with plain JSON for its one 401, which has no detail.
    const viewers = source("viewers.ts");
    const viewersLiteral = [...viewers.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
    expect(viewersLiteral.length, "viewers.ts: an apiError call without a literal status and code").toBe([...viewers.matchAll(/\bapiError\(/g)].length);
    for (const m of viewersLiteral) inCode.add(`${m[1]} ${m[2]}`);
    const viewersPlain = [...viewers.matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)];
    expect(viewersPlain.length, "viewers.ts: an error answer not built in place").toBe([...viewers.matchAll(/\berror: "/g)].length);
    for (const m of viewersPlain) inCode.add(`${m[1]} ${m[2]}`);
    expect([...inCode]).toEqual(expect.arrayContaining(["404 view_link_invalid", "401 unauthorized", "403 bad_origin"]));
    // The site's terms answer with apiError alone, every call with its status and code in place.
    const terms = source("terms.ts");
    const termsLiteral = [...terms.matchAll(/\bapiError\((\d{3}), "([a-z_]+)"/g)];
    expect(termsLiteral.length, "terms.ts: an apiError call without a literal status and code").toBe([...terms.matchAll(/\bapiError\(/g)].length);
    expect([...terms.matchAll(/\berror: "/g)], "terms.ts: an error answer not built by apiError").toHaveLength(0);
    for (const m of termsLiteral) inCode.add(`${m[1]} ${m[2]}`);
    expect([...inCode]).toEqual(expect.arrayContaining(["409 terms_changed"]));
    // Billing (src/billing.ts): its own routes are the dashboard's and Stripe's, left out of the
    // description (UNDOCUMENTED_ROUTES); the one refusal it gives a described route is subscription_ended.
    expect(source("billing.ts")).toContain("apiError(SUBSCRIPTION_ENDED.status, SUBSCRIPTION_ENDED.error, SUBSCRIPTION_ENDED.detail)");
    inCode.add(`${SUBSCRIPTION_ENDED.status} ${SUBSCRIPTION_ENDED.error}`);
    // Download all my data (src/export.ts, 0.1.60): its two routes are the Account page's own,
    // left out of the description (UNDOCUMENTED_ROUTES), and it answers no described route.
    expect(Object.keys(UNDOCUMENTED_ROUTES)).toEqual(expect.arrayContaining(["POST /api/v1/account/data", "GET /api/v1/account/data/:ticket"]));
    // These are the only modules that answer with apiError (src/http.ts defines it).
    const callers = Object.keys(SOURCES).filter((path) => /\bapiError\(/.test(SOURCES[path])).sort();
    expect(callers).toEqual(["../src/access.ts", "../src/account-removal.ts", "../src/admin-api.ts", "../src/billing.ts", "../src/chapters.ts", "../src/connect.ts", "../src/email-change.ts", "../src/export.ts", "../src/http.ts", "../src/invites.ts", "../src/media-access.ts", "../src/media.ts", "../src/publish.ts", "../src/signin.ts", "../src/terms.ts", "../src/tokens.ts", "../src/tours.ts", "../src/uploads.ts", "../src/viewers.ts", "../src/viewing.ts"]);

    // The one refusal that carries numbers is built in src/usage.ts, as plain JSON with its
    // status and code in place; nothing else there answers an error.
    const storage = [...source("usage.ts").matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)];
    expect(storage.map((m) => `${m[1]} ${m[2]}`)).toEqual(["413 storage_full"]);
    expect([...source("usage.ts").matchAll(/\berror: "/g)]).toHaveLength(1);
    inCode.add("413 storage_full");
    // The caller guard's two 403s for a change made with a session (src/auth.ts, below) are
    // listed on each route that takes a session alone and changes something. Its third,
    // terms_required, any session route can answer: the introduction lists it once (below).
    const guard403 = [...source("auth.ts").matchAll(/\bjson\(403, \{ error: "([a-z_]+)"/g)].map((m) => `403 ${m[1]}`).filter((a) => a !== "403 terms_required");
    expect(guard403).toEqual(["403 bad_origin", "403 bad_csrf"]);
    for (const answer of guard403) inCode.add(answer);

    const described = new Set<string>();
    for (const op of OPS) {
      for (const status of Object.keys(op.op.responses)) {
        const res = responseOf(op, status);
        for (const media of Object.values((res.content ?? {}) as Record<string, Json>)) {
          const schema = deref(DOC, media.schema) as Json;
          // A status with several shapes names its codes in each of them.
          const shapes = Array.isArray(schema.oneOf) ? (schema.oneOf as Json[]).map((s) => deref(DOC, s) as Json) : [schema];
          for (const shape of shapes) for (const code of (shape.properties?.error?.enum ?? []) as string[]) described.add(`${status} ${code}`);
        }
      }
    }
    expect(described.has("413 storage_full")).toBe(true);
    expect([...described].sort(), "a status and code only one side has; the code wins: correct src/docs/openapi.ts").toEqual([...inCode].sort());

    // Every route that takes a session alone and changes something lists both 403s, but the
    // admin's, which answer every refusal with the one 404.
    const sessionChanges = OPS.filter((o) => o.method !== "GET" && JSON.stringify(o.op.security) === JSON.stringify([{ session: [] }]) && !o.path.startsWith("/api/v1/admin/"));
    expect(sessionChanges.map((o) => o.key).sort()).toEqual(
      [
        "DELETE /api/v1/sessions/{id}",
        "POST /api/v1/signout",
        "POST /api/v1/signout/everywhere",
        "POST /api/v1/account/email",
        "POST /api/v1/account/email/confirm",
        "POST /api/v1/connect/lookup",
        "POST /api/v1/connect/confirm",
        "POST /api/v1/connect/refuse",
        "PATCH /api/v1/tokens/{id}",
        "DELETE /api/v1/tokens/{id}",
        "PUT /api/v1/tours/{id}/access",
        "PUT /api/v1/media/{id}/access",
        "POST /api/v1/terms/agree",
      ].sort(),
    );
    for (const o of sessionChanges) {
      const schema = deref(DOC, (responseOf(o, "403").content as Record<string, Json>)["application/json"].schema) as Json;
      expect(schema.properties.error.enum, o.key).toEqual(expect.arrayContaining(["bad_origin", "bad_csrf"]));
    }

    // The refusals of the caller guard, which any route that takes a session can answer: in
    // the introduction's list of answers any request can get; the two 403s also on each route above.
    const guard = [...source("auth.ts").matchAll(/\bjson\((\d{3}), \{ error: "([a-z_]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(guard).toEqual(["403 terms_required", "400 mixed_credentials", "404 not_found", "403 bad_origin", "403 bad_csrf"]);
    for (const answer of guard) {
      const [status, code] = answer.split(" ");
      expect(DOC.info.description, answer).toContain("`" + status + ' {"error":"' + code + '"');
    }
    // The three that are not made by apiError: the token guard's, and the app's own two.
    expect(source("auth.ts")).toContain(`'{"error":"unauthorized"}'`);
    expect((DOC.components.schemas as Json).Unauthorized.properties.error.const).toBe("unauthorized");
    expect(source("app.ts")).toContain('c.json({ error: "not_found" }, 404)');
    expect(source("app.ts")).toContain('c.json({ error: "internal" }, 500)');
    expect(DOC.info.description).toContain('`404 {"error":"not_found"}`');
    expect(DOC.info.description).toContain('`500 {"error":"internal"}`');
  });
});
