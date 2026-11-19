// Builds tour bundles for the route tests: manifests from the fixtures and images whose
// header and length match what the manifest declares, plus a thin client for the API.
import { createApp } from "../src/app.ts";
import { metered, SUBREQUEST_BUDGET } from "../src/budget.ts";
import type { Deps } from "../src/ports.ts";
import v1 from "./fixtures/manifest-v1.json" with { type: "json" };
import v2 from "./fixtures/manifest-v2.json" with { type: "json" };
import v3 from "./fixtures/manifest-v3.json" with { type: "json" };

export type Json = Record<string, any>;
export const ORIGIN = "https://tours.example.com";

export const fixtures = { v1, v2, v3 } as const;

export function clone<T>(m: T): T {
  return JSON.parse(JSON.stringify(m));
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];

function padTo(head: number[], total: number, fill: number): Uint8Array {
  if (total < head.length) throw new Error("image too small for its header");
  const out = new Uint8Array(total).fill(fill);
  out.set(head);
  return out;
}

/** A PNG header for width x height, padded to exactly `total` bytes. */
export function png(width: number, height: number, total: number, fill = 0): Uint8Array {
  return padTo([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0], total, fill);
}

/** A JPEG header (SOI, APP0, SOF0) for width x height, padded to exactly `total` bytes. */
export function jpeg(width: number, height: number, total: number, fill = 0): Uint8Array {
  const seg = (m: number, body: number[]) => [0xff, m, ...be16(body.length + 2), ...body];
  const head = [0xff, 0xd8, ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), ...seg(0xc0, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])];
  return padTo(head, total, fill);
}

/** The image a manifest step declares: right type, size and length. `fill` makes bytes differ between uploads. */
export function stepImage(step: Json, fill = 0): Uint8Array {
  return String(step.image).endsWith(".png") ? png(step.width, step.height, step.bytes, fill) : jpeg(step.width, step.height, step.bytes, fill);
}

/** The lowercase hex SHA-256 of `bytes`, as the server records it for a stored picture. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

export type Call ={ status: number; text: string; json: any; headers: Headers; bytes: Uint8Array; calls: number };

/** What `send` takes besides the request line. */
export type SendOptions = {
  token?: string | null;
  body?: RequestInit["body"];
  headers?: Record<string, string>;
  /** The address the request is sent to, ORIGIN unless given. */
  origin?: string;
  /**
   * False: do not wait for the work the request deferred (a mail on its way) before
   * the calls are counted. Only for a test whose deferred work cannot end while the
   * request is looked at, such as one with a mailer that never answers; that test
   * lets the work end itself before it finishes.
   */
  settle?: boolean;
  /** The app the request goes to, instead of the real one: for tests of this helper itself. */
  app?: (deps: Deps) => { fetch(req: Request): Response | Promise<Response> };
};

/**
 * Sends one request to a fresh app on `deps` and reads the whole answer. Then it waits
 * for the work the request deferred, so `calls` holds the calls made after the answer
 * too, and the budget is checked on all of them.
 */
export async function send(deps: Deps, method: string, path: string, opts: SendOptions = {}): Promise<Call> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = "Bearer " + opts.token;
  const init: RequestInit & { duplex?: string } = { method, headers };
  if (opts.body !== undefined && opts.body !== null) {
    init.body = opts.body;
    if (opts.body instanceof ReadableStream) init.duplex = "half";
  }
  // Every request any test sends is metered and held to the budget, so a path that makes
  // too many storage or database calls fails the test that reaches it.
  const meter = metered(deps);
  const res = await (opts.app ?? createApp)(meter.deps).fetch(new Request((opts.origin ?? ORIGIN) + path, init));
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Calls made after the answer count against the same budget, so they are waited for.
  if (opts.settle !== false) await meter.idle();
  const calls = meter.calls();
  const route = `${method} ${routeOf(path)}`;
  budgetSeen.set(route, Math.max(budgetSeen.get(route) ?? 0, calls));
  if (calls > SUBREQUEST_BUDGET) throw new Error(`over the call budget: ${route} made ${calls} calls (budget ${SUBREQUEST_BUDGET})`);
  const text = new TextDecoder().decode(bytes);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers, bytes, calls };
}

/** The most calls seen per route in this test file, for the budget report. */
export const budgetSeen = new Map<string, number>();

/** A path with its ids replaced by placeholders, so requests group by route. */
export function routeOf(path: string): string {
  return path
    .split("?")[0]
    .replace(/tour_[0-9a-f]{24}/g, ":id")
    .replace(/up_[0-9a-f]{24}/g, ":id")
    .replace(/ws_[0-9a-f]{24}/g, ":id")
    .replace(/st_[0-9a-f]{24}/g, ":step_id")
    .replace(/\/steps\/[^/]+$/, "/steps/:n")
    .replace(/^\/p\/.+/, "/p/:name")
    .replace(/^\/docs\/(?:viewer|docs)\.[0-9a-f]{16}\.(?:js|css)$/, "/docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}")
    .replace(/^\/t\/.+/, "/t/:slug");
}

export function createUpload(deps: Deps, token: string, manifest: unknown, target: unknown = { kind: "new" }): Promise<Call> {
  return send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest, target }), headers: { "content-type": "application/json" } });
}

export function putStep(deps: Deps, token: string, uploadId: string, n: number | string, body: Uint8Array | ReadableStream<Uint8Array>): Promise<Call> {
  return send(deps, "PUT", `/api/v1/uploads/${uploadId}/steps/${n}`, { token, body: body as NonNullable<RequestInit["body"]> });
}

export function putLogo(deps: Deps, token: string, uploadId: string, body: Uint8Array | ReadableStream<Uint8Array>): Promise<Call> {
  return send(deps, "PUT", `/api/v1/uploads/${uploadId}/logo`, { token, body: body as NonNullable<RequestInit["body"]> });
}

export function commit(deps: Deps, token: string, uploadId: string): Promise<Call> {
  return send(deps, "POST", `/api/v1/uploads/${uploadId}/commit`, { token });
}

export function abort(deps: Deps, token: string, uploadId: string): Promise<Call> {
  return send(deps, "DELETE", `/api/v1/uploads/${uploadId}`, { token });
}

/** A 64 x 64 PNG logo of `total` bytes. */
export function logoPng(total = 1000, side = 64): Uint8Array {
  return png(side, side, total);
}

/** Create, every step image, the logo if the manifest names one and the target is a new tour; returns the upload id. Does not commit. */
export async function sendAll(deps: Deps, token: string, manifest: Json, target: unknown = { kind: "new" }, fill = 0): Promise<string> {
  const created = await createUpload(deps, token, manifest, target);
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text}`);
  const id = created.json.upload_id as string;
  for (let i = 0; i < manifest.steps.length; i++) {
    const r = await putStep(deps, token, id, i + 1, stepImage(manifest.steps[i], fill));
    if (r.status !== 204) throw new Error(`step ${i + 1} failed: ${r.status} ${r.text}`);
  }
  const logo = manifest.cover?.logo;
  if (logo && (target as Json)?.kind !== "chapter") {
    const r = await putLogo(deps, token, id, logo.endsWith(".png") ? logoPng() : jpeg(64, 64, 1000));
    if (r.status !== 204) throw new Error(`logo failed: ${r.status} ${r.text}`);
  }
  return id;
}

/** sendAll then commit; returns the commit body. */
export async function uploadTour(deps: Deps, token: string, manifest: Json, target: unknown = { kind: "new" }, fill = 0): Promise<{ tour_id: string; chapter_id: string; steps: number }> {
  const id = await sendAll(deps, token, manifest, target, fill);
  const r = await commit(deps, token, id);
  if (r.status !== 201) throw new Error(`commit failed: ${r.status} ${r.text}`);
  return r.json;
}

export async function count(deps: Deps, table: string): Promise<number> {
  return (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
}

/** Row counts of every table an upload touches. */
export async function counts(deps: Deps): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["tour", "chapter", "step", "upload", "upload_step", "snapshot", "snapshot_object"]) out[t] = await count(deps, t);
  return out;
}

/** A body that yields `chunk` bytes forever and counts how many chunks were pulled. */
export function endlessBody(chunk = 65536): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
  let n = 0;
  let cancelled = false;
  const head = png(100, 100, chunk);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(n === 0 ? head : new Uint8Array(chunk));
      n++;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => n, cancelled: () => cancelled };
}
