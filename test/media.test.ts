// Shared items through the API (src/media.ts), on both targets: an item's life from create
// to delete, every refusal, the storage allowance, the sweep, the list and the call budget.
// The cross-workspace cases are in test/isolation.test.ts with every other route's.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount, seedWorkspace } from "#harness";
import { SUBREQUEST_BUDGET, metered } from "../src/budget.ts";
import { CLIP_MAX_DURATION_MS, DEFAULT_MEDIA_LIMITS, MAX_LOOSE_CLAIMS, MEDIA_MAX_AGE_MS, PART_BYTES, PREVIEW_RULE, mediaLimits, mediaLimitsProblem, mediaLink, onlineItemFiles } from "../src/media.ts";
import type { Hosts } from "../src/hosts.ts";
import type { Deps } from "../src/ports.ts";
import { LIMITS_MEDIA, workspaceKey } from "../src/rate.ts";
import { MAX_SERVED_PARTS, SERVE_LOOKUP_CALLS } from "../src/limits.ts";
import { storageFull, type Usage } from "../src/usage.ts";
import { ORIGIN, abort, count, createUpload, fixtures, gif, jpeg, mp4, png, send, uploadTour, type Call, type Json } from "./bundle.ts";

const SLOW = { timeout: 300_000 };
const JSON_HEADERS = { "content-type": "application/json" };
const NO_ITEM = { error: "not_found", detail: "no such item" };
const MB = 1024 * 1024;

type Spec = { kind: "image" | "clip"; content_type: string; bytes: number; width: number; height: number; duration_ms?: number; title?: unknown };

const IMAGE: Spec = { kind: "image", content_type: "image/png", bytes: 5000, width: 640, height: 480 };
const CLIP: Spec = { kind: "clip", content_type: "video/mp4", bytes: 4_500_000, width: 1280, height: 720, duration_ms: 12_000 };

/** The whole file an item of `spec` declares, with a header that matches it; `fill` makes two files differ. */
function fileOf(spec: Spec, fill = 0): Uint8Array {
  switch (spec.content_type) {
    case "image/png":
      return png(spec.width, spec.height, spec.bytes, fill);
    case "image/jpeg":
      return jpeg(spec.width, spec.height, spec.bytes, fill);
    case "image/gif":
      return gif(spec.width, spec.height, spec.bytes, fill);
    default:
      return mp4(spec.bytes, fill);
  }
}

const partOf = (file: Uint8Array, n: number) => file.subarray(n * PART_BYTES, Math.min(file.length, (n + 1) * PART_BYTES));

const create = (deps: Deps, token: string, body: unknown) => send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify(body), headers: JSON_HEADERS });
const putPart = (deps: Deps, token: string, id: string, n: number | string, body: Uint8Array) => send(deps, "PUT", `/api/v1/media/${id}/parts/${n}`, { token, body: body as NonNullable<RequestInit["body"]> });
const putPreview = (deps: Deps, token: string, id: string, body: Uint8Array) => send(deps, "PUT", `/api/v1/media/${id}/preview`, { token, body: body as NonNullable<RequestInit["body"]> });
const commit = (deps: Deps, token: string, id: string) => send(deps, "POST", `/api/v1/media/${id}/commit`, { token });
const remove = (deps: Deps, token: string, id: string) => send(deps, "DELETE", `/api/v1/media/${id}`, { token });
const get = (deps: Deps, token: string, id: string) => send(deps, "GET", `/api/v1/media/${id}`, { token });
const list = (deps: Deps, token: string, query: string) => send(deps, "GET", `/api/v1/media?${query}`, { token });

/** Creates an item and sends every part of its file; returns the id. Does not commit. */
async function sendItem(deps: Deps, token: string, spec: Spec, fill = 0): Promise<{ id: string; file: Uint8Array; calls: number[] }> {
  const made = await create(deps, token, spec);
  if (made.status !== 201) throw new Error(`create failed: ${made.status} ${made.text}`);
  const id = made.json.id as string;
  const file = fileOf(spec, fill);
  const calls = [made.calls];
  for (let n = 0; n < made.json.parts; n++) {
    const r = await putPart(deps, token, id, n, partOf(file, n));
    if (r.status !== 204) throw new Error(`part ${n} failed: ${r.status} ${r.text}`);
    calls.push(r.calls);
  }
  return { id, file, calls };
}

/** sendItem then commit; returns the commit's answer. */
async function shareItem(deps: Deps, token: string, spec: Spec, fill = 0): Promise<Json> {
  const { id } = await sendItem(deps, token, spec, fill);
  const r = await commit(deps, token, id);
  if (r.status !== 200) throw new Error(`commit failed: ${r.status} ${r.text}`);
  return r.json;
}

/** The objects of one item in the private store, each key without its claim token: `m/<id>/part-NNN`, `m/<id>/preview.png`. */
async function objectsOf(keys: () => Promise<string[]>, id: string): Promise<string[]> {
  return (await keys()).filter((k) => k.startsWith(`m/${id}/`)).map((k) => k.replace(/\.[0-9a-f]{24}(?=$|\.)/, "")).sort();
}

async function readAll(deps: Deps, key: string): Promise<Uint8Array | null> {
  const file = await deps.drafts.get(key);
  return file === null ? null : new Uint8Array(await new Response(file.body).arrayBuffer());
}

/** The bytes part `n` of an item serves now: its current claim's object. */
async function served(deps: Deps, id: string, n: number): Promise<Uint8Array | null> {
  const row = await deps.db.first<{ claim: string }>("SELECT claim FROM media_object WHERE media_id = ? AND n = ? AND current = 1", [id, n]);
  return row === null ? null : readAll(deps, `m/${id}/part-${String(n).padStart(3, "0")}.${row.claim}`);
}

/** Every object under m/ that no claim row names: there must never be one. */
async function orphans(deps: Deps, keys: () => Promise<string[]>): Promise<string[]> {
  const rows = await deps.db.all<{ media_id: string; n: number; claim: string; ext: string | null }>("SELECT media_id, n, claim, ext FROM media_object");
  const named = new Set(rows.map((r) => (r.n === -1 ? `m/${r.media_id}/preview.${r.claim}.${r.ext}` : `m/${r.media_id}/part-${String(r.n).padStart(3, "0")}.${r.claim}`)));
  return (await keys()).filter((k) => k.startsWith("m/") && !named.has(k));
}

const refused = (r: Call, status: number, error: string) => expect([r.status, r.json?.error], r.text).toEqual([status, error]);

describe("an item's life", () => {
  it("an image goes online: create, its part, a preview, commit, then it reads and lists", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const made = await create(deps, token, { ...IMAGE, title: "  The new invoice screen  " });
    expect(made.status, made.text).toBe(201);
    expect(made.json).toEqual({ id: expect.stringMatching(/^med_[0-9a-f]{24}$/), parts: 1, part_bytes: PART_BYTES });
    const id = made.json.id as string;
    const file = fileOf(IMAGE, 7);
    expect((await putPart(deps, token, id, 0, file)).status).toBe(204);
    const preview = png(256, 192, 3000, 9);
    expect((await putPreview(deps, token, id, preview)).status).toBe(204);

    // Before commit it is there, uploading, and in no list.
    expect((await get(deps, token, id)).json.state).toBe("uploading");
    expect((await list(deps, token, "kind=image")).json).toEqual({ items: [], next: null });

    const done = await commit(deps, token, id);
    expect(done.status, done.text).toBe(200);
    const linkId = done.json.link_id as string;
    expect(done.json).toEqual({ id, link_id: linkId, kind: "image", path: `/i/${linkId}`, link: `/i/${linkId}` });
    // The link id is 20 characters of a-z and 2-7, and has nothing of the id in it.
    expect(linkId).toMatch(/^[a-z2-7]{20}$/);
    expect(linkId.includes(id.slice(4, 14))).toBe(false);

    const item = await get(deps, token, id);
    const fields = { id, link_id: linkId, kind: "image", title: "The new invoice screen", content_type: "image/png", bytes: 5000, width: 640, height: 480, duration_ms: null, created_at: expect.any(Number), has_preview: true, path: `/i/${linkId}`, link: `/i/${linkId}` };
    expect(item.json).toEqual({ ...fields, state: "online" });
    expect((await list(deps, token, "kind=image")).json).toEqual({ items: [fields], next: null });
    expect((await list(deps, token, "kind=clip")).json).toEqual({ items: [], next: null });

    // Stored as its own object in the private store, with the bytes sent; the preview beside it.
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`, `m/${id}/preview.png`]);
    expect(await served(deps, id, 0)).toEqual(file);

    // The preview, to its own workspace: the sniffed type and nothing a browser could run.
    const p = await send(deps, "GET", `/api/v1/media/${id}/preview`, { token });
    expect(p.status).toBe(200);
    expect(p.bytes).toEqual(preview);
    expect(p.headers.get("content-type")).toBe("image/png");
    expect(p.headers.get("x-content-type-options")).toBe("nosniff");
    expect(p.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(p.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  it("a clip of several parts: every part but the last is 2,000,000 bytes, and the size and duration of an MP4 are as declared", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const made = await create(deps, token, CLIP);
    expect(made.json.parts).toBe(3);
    const id = made.json.id as string;
    const file = fileOf(CLIP, 3);
    // Parts in any order.
    for (const n of [2, 0, 1]) expect((await putPart(deps, token, id, n, partOf(file, n))).status, `part ${n}`).toBe(204);
    const done = await commit(deps, token, id);
    expect(done.json).toMatchObject({ kind: "clip", path: `/r/${done.json.link_id}` });
    expect((await get(deps, token, id)).json).toMatchObject({ kind: "clip", content_type: "video/mp4", width: 1280, height: 720, duration_ms: 12_000, has_preview: false, title: null });
    expect(await objectsOf(draftKeys, id)).toEqual([0, 1, 2].map((n) => `m/${id}/part-00${n}`));
    expect((await served(deps, id, 2))?.length).toBe(500_000);
    expect((await list(deps, token, "kind=clip")).json.items.map((i: Json) => i.id)).toEqual([id]);
  });

  it("a GIF clip and a JPEG image have their sizes checked from part 0", async () => {
    const { deps } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    await shareItem(deps, token, { kind: "clip", content_type: "image/gif", bytes: 900, width: 320, height: 200, duration_ms: 1500 });
    await shareItem(deps, token, { kind: "image", content_type: "image/jpeg", bytes: 2_000_001, width: 8192, height: 10 });
  });

  it("the link is built from the configuration alone: the img address, else the tours address, else SITE_HOST, else the path", async () => {
    const item = { kind: "clip" as const, link_id: "abcdefghijklmnopqrst" };
    const base = { publicImageBase: "", setupCode: null };
    expect(mediaLink(base, item)).toBe("/r/abcdefghijklmnopqrst");
    expect(mediaLink({ ...base, siteHost: "tours.example.org" }, item)).toBe("https://tours.example.org/r/abcdefghijklmnopqrst");
    expect(mediaLink({ ...base, hosts: { tours: "t.example.org", app: "a.example.org" } }, { ...item, kind: "image" })).toBe("https://t.example.org/i/abcdefghijklmnopqrst");
    expect(mediaLink({ ...base, hosts: { tours: "t.example.org", app: "a.example.org", img: "i.example.org" } }, item)).toBe("https://i.example.org/r/abcdefghijklmnopqrst");
  });

  it("a spoofed Host header never shows up in a link, in any mode, and with IMG_HOST the link is on the img address", async () => {
    const TWO: Hosts = { tours: "tours.example.com", app: "app.example.com" };
    const modes: { name: string; config: Parameters<typeof makeDeps>[0]; origin: string; want: string }[] = [
      { name: "one address", config: {}, origin: "https://evil.example.net", want: "" },
      { name: "one address with SITE_HOST", config: { siteHost: "site.example.org" }, origin: "https://evil.example.net", want: "https://site.example.org" },
      { name: "two addresses", config: { hosts: TWO }, origin: "https://app.example.com", want: "https://tours.example.com" },
      { name: "three addresses", config: { hosts: { ...TWO, img: "img.example.com" } }, origin: "https://tours.example.com", want: "https://img.example.com" },
    ];
    for (const mode of modes) {
      const { deps } = await makeDeps(mode.config);
      const { token } = await seedWorkspace(deps, "Acme");
      const spoof = { host: "evil.example.net", "x-forwarded-host": "evil.example.net", forwarded: "host=evil.example.net" };
      const at = { origin: mode.origin, headers: spoof };
      const made = await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify(IMAGE), headers: { ...JSON_HEADERS, ...spoof }, origin: mode.origin });
      expect(made.status, `${mode.name}: ${made.text}`).toBe(201);
      const id = made.json.id as string;
      expect((await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token, body: fileOf(IMAGE) as NonNullable<RequestInit["body"]>, ...at })).status).toBe(204);
      const answers = [
        await send(deps, "POST", `/api/v1/media/${id}/commit`, { token, ...at }),
        await send(deps, "GET", `/api/v1/media/${id}`, { token, ...at }),
        await send(deps, "GET", "/api/v1/media?kind=image", { token, ...at }),
      ];
      const linkId = answers[0].json.link_id as string;
      for (const r of answers) {
        expect(r.status, mode.name).toBe(200);
        expect(r.text, mode.name).not.toContain("evil");
      }
      expect([answers[0].json.link, answers[1].json.link, answers[2].json.items[0].link], mode.name).toEqual(Array(3).fill(`${mode.want}/i/${linkId}`));
    }
  });
});

describe("the store", () => {
  it("parts and previews are kept in the private store: nothing under m/ is ever written to the public store", async () => {
    const { deps, draftKeys, publicKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const writes: string[] = [];
    const pub = deps.pub;
    deps.pub = {
      put: (key, body, meta) => (writes.push(`put ${key}`), pub.put(key, body, meta)),
      get: (key) => (writes.push(`get ${key}`), pub.get(key)),
      delete: (keys) => (writes.push(`delete ${keys.join(" ")}`), pub.delete(keys)),
    };
    const { id } = await sendItem(deps, token, CLIP);
    expect((await putPreview(deps, token, id, png(10, 10, 100))).status).toBe(204);
    expect((await putPreview(deps, token, id, jpeg(10, 10, 100))).status).toBe(204);
    expect((await commit(deps, token, id)).status).toBe(200);
    expect((await send(deps, "GET", `/api/v1/media/${id}/preview`, { token })).status).toBe(200);
    expect((await list(deps, token, "kind=clip")).status).toBe(200);
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`, `m/${id}/part-001`, `m/${id}/part-002`, `m/${id}/preview.jpg`]);
    expect((await remove(deps, token, id)).status).toBe(204);
    // An unfinished item swept a day on, too.
    let now = Date.now();
    deps.now = () => now;
    await sendItem(deps, token, IMAGE);
    now += MEDIA_MAX_AGE_MS + 1;
    expect((await create(deps, token, IMAGE)).status).toBe(201);
    expect(writes).toEqual([]);
    expect(await publicKeys()).toEqual([]);
  });

  it("the uploads' and tours' own clean-up never reaches an item's objects", async () => {
    const { deps, draftKeys } = await makeDeps({ retiredGraceMs: 0 });
    const { token } = await seedWorkspace(deps, "Acme");
    const online = (await shareItem(deps, token, CLIP)).id as string;
    const { id: unfinished } = await sendItem(deps, token, IMAGE);
    const before = (await draftKeys()).filter((k) => k.startsWith("m/"));
    expect(before).toHaveLength(4);
    // Every draft key the upload routes write is under u/.
    const tour = await uploadTour(deps, token, fixtures.v3 as Json);
    expect((await draftKeys()).filter((k) => !k.startsWith("m/")).every((k) => k.startsWith("u/"))).toBe(true);
    // An aborted upload, a publish and unpublish, and a deleted tour remove only their own files.
    const open = await createUpload(deps, token, fixtures.v1 as Json);
    expect((await abort(deps, token, open.json.upload_id)).status).toBe(204);
    expect((await send(deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token })).status).toBeLessThan(300);
    expect((await send(deps, "POST", `/api/v1/tours/${tour.tour_id}/unpublish`, { token })).status).toBeLessThan(300);
    let gone = await send(deps, "DELETE", `/api/v1/tours/${tour.tour_id}`, { token });
    while (gone.status === 202) gone = await send(deps, "DELETE", `/api/v1/tours/${tour.tour_id}`, { token });
    expect(gone.status).toBe(200);
    expect((await send(deps, "GET", "/api/v1/tours", { token })).status).toBe(200);
    expect((await draftKeys()).filter((k) => k.startsWith("m/"))).toEqual(before);
    expect((await draftKeys()).filter((k) => !k.startsWith("m/"))).toEqual([]);
    expect((await get(deps, token, online)).json.state).toBe("online");
    expect((await get(deps, token, unfinished)).json.state).toBe("uploading");
  });
});

describe("what a create refuses", () => {
  it("anything it cannot use: 400 with the field, 413 media_too_large with the limits, and no row", async () => {
    const { deps } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const bad: [string, unknown][] = [
      ["not an object", [IMAGE]],
      ["no kind", { ...IMAGE, kind: undefined }],
      ["an unknown kind", { ...IMAGE, kind: "video" }],
      ["a GIF as an image", { ...IMAGE, content_type: "image/gif" }],
      ["a PNG as a clip", { ...CLIP, content_type: "image/png" }],
      ["SVG", { ...IMAGE, content_type: "image/svg+xml" }],
      ["HTML", { ...IMAGE, content_type: "text/html" }],
      ["no bytes", { ...IMAGE, bytes: 0 }],
      ["fractional bytes", { ...IMAGE, bytes: 10.5 }],
      ["bytes as text", { ...IMAGE, bytes: "5000" }],
      ["no width", { ...IMAGE, width: 0 }],
      ["a negative height", { ...IMAGE, height: -1 }],
      ["a clip without duration", { ...CLIP, duration_ms: undefined }],
      ["a clip of no time", { ...CLIP, duration_ms: 0 }],
      ["a clip past the ceiling", { ...CLIP, duration_ms: CLIP_MAX_DURATION_MS + 1 }],
      ["an image with a duration", { ...IMAGE, duration_ms: 100 }],
      ["an image with a null duration", { ...IMAGE, duration_ms: null }],
      ["a title that is no text", { ...IMAGE, title: 5 }],
      ["a title of 121 characters", { ...IMAGE, title: "x".repeat(121) }],
      ["a title with a control character", { ...IMAGE, title: "a\u0000b" }],
      ["a title with a line break", { ...IMAGE, title: "a\nb" }],
      ["a title with a format character", { ...IMAGE, title: "a\u202eb" }],
    ];
    for (const [what, body] of bad) refused(await create(deps, token, body), 400, "bad_request");
    refused(await send(deps, "POST", "/api/v1/media", { token, body: "{nope", headers: JSON_HEADERS }), 400, "bad_request");
    refused(await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify({ ...IMAGE, title: "x".repeat(5000) }), headers: JSON_HEADERS }), 413, "too_large");

    const tooLarge: [Spec, number, number][] = [
      [{ ...IMAGE, bytes: 10 * MB + 1 }, 10 * MB, 8192],
      [{ ...IMAGE, width: 8193 }, 10 * MB, 8192],
      [{ ...IMAGE, height: 8193 }, 10 * MB, 8192],
      [{ ...CLIP, bytes: 50 * MB + 1 }, 50 * MB, 8192],
      [{ ...CLIP, width: 9000 }, 50 * MB, 8192],
    ];
    for (const [spec, maxBytes, maxSide] of tooLarge) {
      const r = await create(deps, token, spec);
      expect(r.status, r.text).toBe(413);
      expect(r.json).toEqual({ error: "media_too_large", detail: expect.stringContaining(`at most ${maxBytes} bytes and ${maxSide} pixels`), max_bytes: maxBytes, max_side: maxSide });
    }
    expect(await count(deps, "media")).toBe(0);
    // At the limits exactly is taken; a 120-character title too, as it was given but trimmed.
    expect((await create(deps, token, { ...IMAGE, bytes: 10 * MB, width: 8192, height: 8192, title: ` ${"é".repeat(120)} ` })).status).toBe(201);
    expect((await create(deps, token, { ...CLIP, bytes: 50 * MB, duration_ms: CLIP_MAX_DURATION_MS })).json.parts).toBe(Math.ceil((50 * MB) / PART_BYTES));
    expect(await deps.db.first("SELECT title FROM media WHERE kind = 'image'")).toEqual({ title: "é".repeat(120) });
    // An empty title is no title.
    const blank = await create(deps, token, { ...IMAGE, title: "   " });
    expect(await deps.db.first("SELECT title FROM media WHERE id = ?", [blank.json.id])).toEqual({ title: null });
  });

  it("the limits are settings: a deployment's own numbers replace the defaults", async () => {
    expect(DEFAULT_MEDIA_LIMITS).toEqual({ imageMaxBytes: 10 * MB, imageMaxSide: 8192, clipMaxBytes: 50 * MB });
    const { deps } = await makeDeps({ mediaImageMaxBytes: 1000, mediaImageMaxSide: 100, mediaClipMaxBytes: 2000 });
    const { token } = await seedWorkspace(deps, "Acme");
    expect((await create(deps, token, { ...IMAGE, bytes: 1001, width: 10, height: 10 })).json).toMatchObject({ error: "media_too_large", max_bytes: 1000, max_side: 100 });
    expect((await create(deps, token, { ...IMAGE, bytes: 1000, width: 101, height: 10 })).json).toMatchObject({ error: "media_too_large", max_side: 100 });
    expect((await create(deps, token, { ...CLIP, bytes: 2001 })).json).toMatchObject({ error: "media_too_large", max_bytes: 2000 });
    expect((await create(deps, token, { ...IMAGE, bytes: 1000, width: 100, height: 100 })).status).toBe(201);
  });

  it("a workspace starts at most 60 items an hour", SLOW, async () => {
    const { deps } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const other = await seedWorkspace(deps, "Other");
    expect(LIMITS_MEDIA.create).toEqual({ bucket: "media_create", windowMs: 3_600_000, most: 60 });
    let now = 1_800_000_000_000;
    deps.now = () => now;
    for (let i = 0; i < 60; i++) expect((await create(deps, token, IMAGE)).status, `item ${i + 1}`).toBe(201);
    const over = await create(deps, token, IMAGE);
    refused(over, 429, "too_many_items");
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await count(deps, "media")).toBe(60);
    // Another workspace is not limited by it, and the next hour starts again.
    expect((await create(deps, other.token, IMAGE)).status).toBe(201);
    now += 3_600_000;
    expect((await create(deps, token, IMAGE)).status).toBe(201);
  });
});

describe("parts", () => {
  it("part 0 that is HTML, SVG, an executable or another type than declared is refused, and nothing is stored", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const pad = (head: Uint8Array, total: number) => {
      const out = new Uint8Array(total).fill(0x20);
      out.set(head.subarray(0, total));
      return out;
    };
    const text = (s: string, total: number) => pad(new TextEncoder().encode(s), total);
    const cases: [string, Spec, Uint8Array][] = [
      ["HTML as a PNG", IMAGE, text("<!DOCTYPE html><html><script>alert(1)</script></html>", IMAGE.bytes)],
      ["SVG as a PNG", IMAGE, text("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", IMAGE.bytes)],
      ["an executable as a PNG", IMAGE, pad(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0]), IMAGE.bytes)],
      ["a JPEG as a PNG", IMAGE, jpeg(640, 480, IMAGE.bytes)],
      ["a GIF as a PNG", IMAGE, gif(640, 480, IMAGE.bytes)],
      ["a PNG as a JPEG", { ...IMAGE, content_type: "image/jpeg" }, png(640, 480, IMAGE.bytes)],
      ["a PNG of another size", IMAGE, png(641, 480, IMAGE.bytes)],
      ["a JPEG of another size", { ...IMAGE, content_type: "image/jpeg" }, jpeg(640, 481, IMAGE.bytes)],
      ["an MP4 as a GIF", { kind: "clip", content_type: "image/gif", bytes: 900, width: 10, height: 10, duration_ms: 10 }, mp4(900)],
      ["a GIF of another size", { kind: "clip", content_type: "image/gif", bytes: 900, width: 10, height: 10, duration_ms: 10 }, gif(10, 11, 900)],
      ["a GIF as an MP4", { ...CLIP, bytes: 900 }, gif(1280, 720, 900)],
      ["HTML as an MP4", { ...CLIP, bytes: 900 }, text("<html><body>ftyp</body></html>", 900)],
    ];
    for (const [what, spec, body] of cases) {
      const made = await create(deps, token, spec);
      const r = await putPart(deps, token, made.json.id, 0, body);
      expect([r.status, r.json?.error], `${what}: ${r.text}`).toEqual([400, "bad_media"]);
      expect(r.text, what).not.toContain("script");
    }
    expect(await count(deps, "media_object")).toBe(0);
    expect((await draftKeys()).filter((k) => k.startsWith("m/"))).toEqual([]);
  });

  it("a wrong length, a part number out of range, a part after commit and a commit that lacks a part are refused", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const made = await create(deps, token, CLIP);
    const id = made.json.id as string;
    const file = fileOf(CLIP);
    // Wrong lengths: short, long, the last part's length for a full part.
    refused(await putPart(deps, token, id, 0, partOf(file, 0).subarray(1)), 400, "bad_part");
    refused(await putPart(deps, token, id, 2, file.subarray(0, 500_001)), 400, "bad_part");
    refused(await putPart(deps, token, id, 1, file.subarray(0, 500_000)), 400, "bad_part");
    refused(await putPart(deps, token, id, 1, new Uint8Array(PART_BYTES + 1)), 413, "too_large");
    // Out of range, and numbers that are not part numbers: the extra part is not there.
    for (const n of ["3", "999", "-1", "01", "x", "1.0"]) expect((await putPart(deps, token, id, n, partOf(file, 0))).json, n).toEqual({ error: "not_found", detail: "no such part" });
    expect(await count(deps, "media_object")).toBe(0);

    expect((await putPart(deps, token, id, 0, partOf(file, 0))).status).toBe(204);
    expect((await putPart(deps, token, id, 2, partOf(file, 2))).status).toBe(204);
    const lacking = await commit(deps, token, id);
    refused(lacking, 409, "incomplete");
    expect(lacking.json.detail).toBe("part 1 has not been sent, or is still being sent");
    // Sending a part again replaces it.
    const other = fileOf(CLIP, 0x55);
    expect((await putPart(deps, token, id, 2, partOf(other, 2))).status).toBe(204);
    expect(await served(deps, id, 2)).toEqual(partOf(other, 2));
    expect((await putPart(deps, token, id, 1, partOf(file, 1))).status).toBe(204);

    // A part whose only claim is not stored yet is not there for the commit.
    await deps.db.run("UPDATE media_object SET current = 0 WHERE media_id = ? AND n = 1", [id]);
    await deps.db.run("INSERT INTO media_object (media_id, claim, n, bytes, claimed_at) VALUES (?, 'aaaaaaaaaaaaaaaaaaaaaaaa', 1, 2000000, 1)", [id]);
    refused(await commit(deps, token, id), 409, "incomplete");
    expect((await putPart(deps, token, id, 1, partOf(file, 1))).status).toBe(204);

    const first = await commit(deps, token, id);
    expect(first.status).toBe(200);
    // Commit twice: the same answer, and nothing changes.
    const again = await commit(deps, token, id);
    expect([again.status, again.json]).toEqual([200, first.json]);
    // After commit no part and no preview can change.
    refused(await putPart(deps, token, id, 1, partOf(file, 1)), 409, "already_online");
    refused(await putPreview(deps, token, id, png(10, 10, 100)), 409, "already_online");
    expect(await served(deps, id, 2)).toEqual(partOf(other, 2));
    expect(await objectsOf(draftKeys, id)).toHaveLength(3);
  });

  it("parts whose stored sizes do not add up to the declared bytes are not committed", async () => {
    const { deps } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const { id } = await sendItem(deps, token, CLIP);
    // Only a row changed behind the routes' back can say so: every part's length is checked when it is sent.
    await deps.db.run("UPDATE media_object SET bytes = bytes - 1 WHERE media_id = ? AND n = 2", [id]);
    const r = await commit(deps, token, id);
    refused(r, 409, "incomplete");
    expect(r.json.detail).toBe("the parts add up to 4499999 bytes, not the 4500000 declared");
    expect((await get(deps, token, id)).json.state).toBe("uploading");
  });

  it("the preview is a PNG or JPEG of at most 100,000 bytes and 512 pixels, and a new one replaces the old", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const { id } = await sendItem(deps, token, IMAGE);
    refused(await putPreview(deps, token, id, png(513, 10, 1000)), 400, "bad_image");
    refused(await putPreview(deps, token, id, gif(10, 10, 1000)), 400, "bad_image");
    refused(await putPreview(deps, token, id, new TextEncoder().encode("<svg/>")), 400, "bad_image");
    refused(await putPreview(deps, token, id, png(10, 10, PREVIEW_RULE.maxBytes + 1)), 413, "too_large");
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`]);
    expect((await send(deps, "GET", `/api/v1/media/${id}/preview`, { token })).json).toEqual({ error: "not_found", detail: "this item has no preview" });

    expect((await putPreview(deps, token, id, png(512, 512, PREVIEW_RULE.maxBytes))).status).toBe(204);
    expect((await putPreview(deps, token, id, jpeg(100, 50, 2000))).status).toBe(204);
    // The PNG it replaced is gone; one preview is left, served as what it is.
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`, `m/${id}/preview.jpg`]);
    const p = await send(deps, "GET", `/api/v1/media/${id}/preview`, { token });
    expect([p.status, p.headers.get("content-type"), p.bytes.length]).toEqual([200, "image/jpeg", 2000]);
    expect(await deps.db.all("SELECT ext, bytes, current FROM media_object WHERE media_id = ? AND n = -1", [id])).toEqual([{ ext: "jpg", bytes: 2000, current: 1 }]);
  });
});

describe("the storage allowance", () => {
  const usageOf = async (deps: Deps, token: string) => (await send(deps, "GET", "/api/v1/usage", { token })).json;

  it("an item over the allowance is refused before any part is stored, with the item's own sentence", async () => {
    const { deps, draftKeys } = await makeDeps({ storageAllowanceBytes: 3 * MB });
    const { token } = await seedWorkspace(deps, "Acme");
    const r = await create(deps, token, { ...CLIP, bytes: 3 * MB + 1 });
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: "storage_full", detail: expect.any(String), used_bytes: 0, allowance_bytes: 3 * MB, needed_bytes: 3 * MB + 1 });
    expect(r.json.detail).toBe("this GIF needs 3.1 MB of room, but the workspace has 3 MB left of its 3 MB allowance. Nothing was uploaded. Delete what you no longer need, or ask the site's admin for more room");
    const image = await create(deps, token, { ...IMAGE, content_type: "image/jpeg", bytes: 3 * MB + 1, width: 10, height: 10 });
    expect(image.json.detail).toMatch(/^this image needs 3\.1 MB of room/);
    expect(await count(deps, "media")).toBe(0);
    expect(await draftKeys()).toEqual([]);
    // Exactly the allowance fits.
    expect((await create(deps, token, { ...CLIP, bytes: 3 * MB })).status).toBe(201);
    expect((await usageOf(deps, token)).used_bytes).toBe(3 * MB);
  });

  it("every sentence stays under 200 characters and reads after \"Could not start the upload: \"", async () => {
    const usage = (used: number, allowance: number): Usage => ({ pictures: used, logos: 0, uploads: 0, media: 0, imageBytes: 0, gifBytes: 0, used, allowance, over: used > allowance, tours: 1, images: 0, gifs: 0 });
    const MAX = Number.MAX_SAFE_INTEGER;
    for (const of of ["image", "clip", "preview"] as const) {
      for (const [u, needed] of [[usage(600, 1000), 500], [usage(MAX - 1023, MAX), 1023 * 1024], [usage(0, MAX), MAX], [usage(MAX, MAX), MAX]] as [Usage, number][]) {
        const detail = ((await storageFull(u, needed, of).json()) as Json).detail as string;
        expect(detail.length, detail).toBeLessThan(200);
        expect(detail).toMatch(new RegExp(`^this ${of === "clip" ? "GIF" : of} needs .* Nothing was uploaded\\. Delete what you no longer need, or ask the site's admin for more room$`));
      }
    }
    // The tour's sentence is the one it always was.
    expect(((await storageFull(usage(1_070_491_238, 1_073_741_824), 14_889_779).json()) as Json).detail).toBe(
      "this tour needs 14.2 MB of room, but the workspace has 3.1 MB left of its 1 GB allowance. Nothing was uploaded. Delete tours you no longer need, or ask the site's admin for more room",
    );
  });

  it("two creates at the same moment cannot both pass, and tour uploads and items see each other's room", async () => {
    const { deps } = await makeDeps({ storageAllowanceBytes: 5 * MB });
    const { token } = await seedWorkspace(deps, "Acme");
    const spec = { ...CLIP, bytes: 3 * MB };
    const both = await Promise.all([create(deps, token, spec), create(deps, token, spec)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 413]);
    expect(await count(deps, "media")).toBe(1);
    // The item's reserved bytes count against a tour upload...
    const manifest = JSON.parse(JSON.stringify(fixtures.v2)) as Json;
    manifest.steps = manifest.steps.map((s: Json) => ({ ...s, bytes: 1_100_000 }));
    const tour = await createUpload(deps, token, manifest);
    expect([tour.status, tour.json.error]).toEqual([413, "storage_full"]);
    expect(tour.json.detail).toMatch(/^this tour needs/);
    // ...and an open tour upload's reservation counts against an item.
    manifest.steps = manifest.steps.map((s: Json) => ({ ...s, bytes: 500_000 }));
    expect((await createUpload(deps, token, manifest)).status).toBe(201);
    refused(await create(deps, token, { ...CLIP, bytes: 2 * MB - 500_000 * manifest.steps.length + 1 }), 413, "storage_full");
  });

  it("the preview counts too, and one over the allowance is refused", async () => {
    const { deps } = await makeDeps({ storageAllowanceBytes: 10_000 });
    const { token } = await seedWorkspace(deps, "Acme");
    const { id } = await sendItem(deps, token, { ...IMAGE, bytes: 8000 });
    expect((await putPreview(deps, token, id, png(10, 10, 1500))).status).toBe(204);
    expect((await usageOf(deps, token)).used_bytes).toBe(9500);
    // A new preview takes the old one's place: 2000 in place of 1500 fits, 2001 does not.
    const full = await putPreview(deps, token, id, png(10, 10, 2001));
    expect(full.json).toMatchObject({ error: "storage_full", needed_bytes: 501, used_bytes: 9500, allowance_bytes: 10_000 });
    expect(full.json.detail).toMatch(/^this preview needs 501 bytes of room/);
    expect((await putPreview(deps, token, id, png(10, 10, 2000))).status).toBe(204);
    expect((await usageOf(deps, token)).used_bytes).toBe(10_000);
  });

  it("a deleted item and a swept one stop counting at once; the usage answer keeps its shape", async () => {
    const { deps } = await makeDeps({ storageAllowanceBytes: 10 * MB });
    const { token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const online = await shareItem(deps, token, { ...CLIP, bytes: 3 * MB });
    const { id: unfinished } = await sendItem(deps, token, { ...CLIP, bytes: 4 * MB });
    const usage = await usageOf(deps, token);
    // The unfinished clip counts its bytes under gifs, but is not yet one of the online gifs.
    expect(usage).toEqual({ used_bytes: 7 * MB, allowance_bytes: 10 * MB, over: false, tours: 0, images: 0, gifs: 1, counted: { pictures: 0, logos: 0, uploads_in_progress: 0, images: 0, gifs: 7 * MB } });
    refused(await create(deps, token, { ...CLIP, bytes: 3 * MB + 1 }), 413, "storage_full");

    expect((await remove(deps, token, online.id)).status).toBe(204);
    expect((await usageOf(deps, token)).used_bytes).toBe(4 * MB);
    // A day on, the next create sweeps the unfinished item, and its room is free for itself.
    now += MEDIA_MAX_AGE_MS + 1;
    expect((await create(deps, token, { ...CLIP, bytes: 10 * MB })).status).toBe(201);
    expect(await deps.db.first("SELECT count(*) AS n FROM media WHERE id = ?", [unfinished])).toEqual({ n: 0 });
  });
});

describe("delete and sweep", () => {
  it("delete removes an item in any state, its rows and every object, and a second delete is 404", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const empty = (await create(deps, token, CLIP)).json.id as string;
    const half = await create(deps, token, CLIP);
    const halfFile = fileOf(CLIP);
    await putPart(deps, token, half.json.id, 1, partOf(halfFile, 1));
    await putPreview(deps, token, half.json.id, png(10, 10, 100));
    const online = await shareItem(deps, token, CLIP);
    for (const id of [empty, half.json.id, online.id]) {
      const r = await remove(deps, token, id);
      expect([r.status, r.text], id).toEqual([204, ""]);
      expect(await objectsOf(draftKeys, id), id).toEqual([]);
      expect((await get(deps, token, id)).json).toEqual(NO_ITEM);
      expect((await remove(deps, token, id)).json).toEqual(NO_ITEM);
    }
    expect([await count(deps, "media"), await count(deps, "media_object")]).toEqual([0, 0]);
    expect(await draftKeys()).toEqual([]);
  });

  it("a delete whose files could not all be removed says so and is repeated; the item is gone for everything else at once", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const item = await shareItem(deps, token, CLIP);
    const broken: Deps = { ...deps, drafts: { ...deps.drafts, delete: () => Promise.reject(new Error("the store is down")) } };
    const log = console.error;
    console.error = () => {};
    let cut: Call;
    try {
      cut = await remove(broken, token, item.id);
    } finally {
      console.error = log;
    }
    expect(cut.json).toEqual({ error: "cleanup_pending", detail: "the item is deleted, but some of its files could not be removed yet; delete it again to retry" });
    expect(cut.status).toBe(500);
    expect((await get(deps, token, item.id)).json).toEqual(NO_ITEM);
    expect((await list(deps, token, "kind=clip")).json.items).toEqual([]);
    // Its objects are still there, so its bytes still count, until the repeat removes them.
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes).toBe(CLIP.bytes);
    refused(await commit(deps, token, item.id), 404, "not_found");
    expect(await objectsOf(draftKeys, item.id)).toHaveLength(3);
    // The repeat finishes it.
    expect((await remove(deps, token, item.id)).status).toBe(204);
    expect(await objectsOf(draftKeys, item.id)).toEqual([]);
    expect(await count(deps, "media")).toBe(0);
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes).toBe(0);
  });

  it("a part that lands after its item was deleted is removed by the request that wrote it", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const id = (await create(deps, token, IMAGE)).json.id as string;
    // The delete runs while the part is being written: between the claim and the store's put.
    const slow: Deps = {
      ...deps,
      drafts: {
        ...deps.drafts,
        put: async (key, body, meta) => {
          expect((await remove(deps, token, id)).status).toBe(500);
          return deps.drafts.put(key, body, meta);
        },
      },
    };
    expect((await putPart(slow, token, id, 0, fileOf(IMAGE))).json).toEqual(NO_ITEM);
    expect(await objectsOf(draftKeys, id)).toEqual([]);
    expect([await count(deps, "media"), await count(deps, "media_object")]).toEqual([0, 0]);
  });

  it("unfinished items are swept a day on, by the workspace's own next create, at most five at a time; online ones stay", SLOW, async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const other = await seedWorkspace(deps, "Other");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const online = await shareItem(deps, token, IMAGE);
    const stale: string[] = [];
    for (let i = 0; i < 7; i++) stale.push((await sendItem(deps, token, IMAGE)).id);
    const theirs = (await sendItem(deps, other.token, IMAGE)).id;
    now += MEDIA_MAX_AGE_MS - 1;
    // Not yet a day old: the next create sweeps nothing.
    const fresh = (await create(deps, token, IMAGE)).json.id as string;
    expect(await count(deps, "media")).toBe(10);
    now += 2;
    const r = await create(deps, token, IMAGE);
    expect(r.status).toBe(201);
    expect(r.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    // All seven are closed (none counts any more), five are removed, the other two by the next create.
    const left = await deps.db.all<{ id: string; state: string }>("SELECT id, state FROM media WHERE id IN (" + stale.map(() => "?").join(", ") + ") ORDER BY id", stale);
    expect(left.map((x) => x.state)).toEqual(["closing", "closing"]);
    await create(deps, token, IMAGE);
    for (const id of stale) expect(await objectsOf(draftKeys, id), id).toEqual([]);
    expect(await deps.db.first("SELECT count(*) AS n FROM media WHERE id IN (" + stale.map(() => "?").join(", ") + ")", stale)).toEqual({ n: 0 });
    // The online item, the newer one and the other workspace's stay.
    for (const id of [online.id, fresh, theirs]) expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM media WHERE id = ?", [id]), id).toEqual({ n: 1 });
    expect(await objectsOf(draftKeys, theirs)).toEqual([`m/${theirs}/part-000`]);
  });
});

describe("the three invariants", () => {
  /** Runs `during` once, in the middle of the next store put under m/: after the object is written, before the put returns. */
  function interrupt(deps: Deps, during: () => Promise<void>, opts: { before?: boolean } = {}): Deps {
    let done = false;
    return {
      ...deps,
      drafts: {
        ...deps.drafts,
        put: async (key, body, meta) => {
          if (done || !key.startsWith("m/")) return deps.drafts.put(key, body, meta);
          done = true;
          if (opts.before) await during();
          await deps.drafts.put(key, body, meta);
          if (!opts.before) await during();
        },
      },
    };
  }
  const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
    const log = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = log;
    }
  };

  it("(a) a part whose request dies after its object landed, while the item is being deleted, is still named by a row, counted, and removed later", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await create(deps, token, IMAGE)).json.id as string;
    // The delete runs while the part is being written, and the request then dies: its
    // object is in the store, and neither its "done" statement nor its own clean-up runs.
    const dying: Deps = interrupt(deps, async () => {
      expect((await remove(deps, token, id)).status).toBe(500);
    }, { before: true });
    const dead: Deps = { ...dying, db: { ...dying.db, batch: () => Promise.reject(new Error("cut off")) }, drafts: { ...dying.drafts, delete: () => Promise.reject(new Error("cut off")) } };
    expect((await quiet(() => putPart(dead, token, id, 0, fileOf(IMAGE)))).status).toBe(500);
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`]);
    expect(await orphans(deps, draftKeys)).toEqual([]);
    // Deleted for everyone, and still counted: its object is there.
    expect((await get(deps, token, id)).json).toEqual(NO_ITEM);
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes).toBe(2 * IMAGE.bytes); // the item, and the object of the send that died
    // A delete while the claim is young removes the object but keeps the row, which could still see one written.
    refused(await remove(deps, token, id), 500, "cleanup_pending");
    expect(await objectsOf(draftKeys, id)).toEqual([]);
    expect(await count(deps, "media_object")).toBe(1);
    // Past the claim's lifetime the next sweep finishes it, and the room is free.
    now += 5 * 60 * 1000 + 1;
    expect((await create(deps, token, { ...IMAGE, title: "next" })).status).toBe(201);
    expect(await deps.db.first("SELECT count(*) AS n FROM media WHERE id = ?", [id])).toEqual({ n: 0 });
    expect(await count(deps, "media_object")).toBe(0);
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes).toBe(IMAGE.bytes);
  });

  it("(a) a preview whose request dies after its object landed is named by a row too, and a held item does not hold the sweep up", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { workspaceId, token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const { id } = await sendItem(deps, token, IMAGE);
    const dying = interrupt(deps, async () => {
      expect((await remove(deps, token, id)).status).toBe(500);
    }, { before: true });
    const dead: Deps = { ...dying, db: { ...dying.db, batch: () => Promise.reject(new Error("cut off")) }, drafts: { ...dying.drafts, delete: () => Promise.reject(new Error("cut off")) } };
    expect((await quiet(() => putPreview(dead, token, id, png(10, 10, 300)))).status).toBe(500);
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/preview.png`]);
    expect(await orphans(deps, draftKeys)).toEqual([]);

    // The oldest closing item still holds a young claim; six unfinished items are a day old.
    // One sweep skips the held one and removes five others, so it cannot keep them waiting.
    const others: string[] = [];
    for (let i = 0; i < 6; i++) others.push((await sendItem(deps, token, IMAGE)).id);
    now += MEDIA_MAX_AGE_MS + 1;
    const held = "med_" + "0".repeat(24);
    await deps.db.batch([
      { sql: "INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, state, created_at) VALUES (?, ?, ?, 'image', 'image/png', 10, 1, 1, 1, 'closing', 1)", params: [held, workspaceId, "h".repeat(20)] },
      { sql: "INSERT INTO media_object (media_id, claim, n, bytes, claimed_at) VALUES (?, ?, 0, 10, ?)", params: [held, "b".repeat(24), now] },
    ]);
    expect((await create(deps, token, IMAGE)).status).toBe(201);
    // Closing before: the held one, the item whose request died (its claim is old now), the six others: five of those seven go.
    const left = await deps.db.all<{ id: string }>("SELECT id FROM media WHERE state = 'closing'");
    expect(left).toHaveLength(3);
    expect(left.map((r) => r.id)).toContain(held);
    expect(await orphans(deps, draftKeys)).toEqual([]);
  });

  it("(b) a slow part send that lost its place lands after commit under its own key, and the online item serves what was committed", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const made = await create(deps, token, IMAGE);
    const id = made.json.id as string;
    const winner = fileOf(IMAGE, 0x11);
    const loser = fileOf(IMAGE, 0x22);
    // The slow send has claimed part 0 and is writing; another send of part 0 and the commit finish meanwhile.
    const slow = interrupt(deps, async () => {
      expect((await putPart(deps, token, id, 0, winner)).status).toBe(204);
      expect((await commit(deps, token, id)).status).toBe(200);
    }, { before: true });
    refused(await putPart(slow, token, id, 0, loser), 409, "already_online");
    expect(await served(deps, id, 0)).toEqual(winner);
    const files = await onlineItemFiles(deps, made.json.id === id ? (await get(deps, token, id)).json.link_id : "");
    expect(files?.parts).toHaveLength(1);
    expect(await readAll(deps, files!.parts[0])).toEqual(winner);
    // The loser removed its own object; nothing else is under the item.
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`]);
    expect(await orphans(deps, draftKeys)).toEqual([]);
  });

  it("(b) a slow preview send can neither replace the committed preview, nor leave one whose type disagrees, nor delete the newer one", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const { id } = await sendItem(deps, token, IMAGE);
    const newer = jpeg(20, 10, 700, 3);
    const slow = interrupt(deps, async () => {
      expect((await putPreview(deps, token, id, newer)).status).toBe(204);
      expect((await commit(deps, token, id)).status).toBe(200);
    }, { before: true });
    // The old preview, a PNG, was claimed first and lands last.
    refused(await putPreview(slow, token, id, png(20, 10, 600, 4)), 409, "already_online");
    const linkId = (await get(deps, token, id)).json.link_id as string;
    const files = await onlineItemFiles(deps, linkId);
    expect(files?.preview?.type).toBe("jpg");
    expect(await readAll(deps, files!.preview!.key)).toEqual(newer);
    const p = await send(deps, "GET", `/api/v1/media/${id}/preview`, { token });
    expect([p.headers.get("content-type"), p.bytes]).toEqual(["image/jpeg", newer]);
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`, `m/${id}/preview.jpg`]);
    expect(await orphans(deps, draftKeys)).toEqual([]);
  });

  it("(b) of two sends of one part that both finish before commit, one is served and the other's object is gone", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const id = (await create(deps, token, IMAGE)).json.id as string;
    const first = fileOf(IMAGE, 1);
    const second = fileOf(IMAGE, 2);
    const slow = interrupt(deps, async () => {
      expect((await putPart(deps, token, id, 0, second)).status).toBe(204);
    }, { before: true });
    expect((await putPart(slow, token, id, 0, first)).status).toBe(204);
    // The one whose "done" came last is served; there is exactly one object and one claim row.
    expect(await served(deps, id, 0)).toEqual(first);
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`]);
    expect(await count(deps, "media_object")).toBe(1);
    expect((await commit(deps, token, id)).status).toBe(200);
  });

  it("(b) when the read after the stored batch fails, the stored object survives and is served", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedAccount(deps);
    const id = (await create(deps, token, IMAGE)).json.id as string;
    const file = fileOf(IMAGE, 5);
    // The batch that marks the claim stored commits; the next read fails once.
    let armed = false;
    const flaky: Deps = {
      ...deps,
      db: {
        ...deps.db,
        batch: async (stmts) => {
          await deps.db.batch(stmts);
          if (stmts.some((st) => st.sql.includes("SET stored_at"))) armed = true;
        },
        all: async (sql, params) => {
          if (armed) {
            armed = false;
            throw new Error("the read failed");
          }
          return deps.db.all(sql, params);
        },
      },
    };
    expect((await quiet(() => putPart(flaky, token, id, 0, file))).status).toBe(500);
    expect(await served(deps, id, 0)).toEqual(file);
    expect(await orphans(deps, draftKeys)).toEqual([]);
    expect((await commit(deps, token, id)).status).toBe(200);
    const files = await onlineItemFiles(deps, (await get(deps, token, id)).json.link_id);
    expect(await readAll(deps, files!.parts[0])).toEqual(file);
  });

  it("(b) a send whose claim was taken away while the item is still uploading answers 409 superseded, not 404", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const id = (await create(deps, token, IMAGE)).json.id as string;
    // Its claim row goes while it writes (as a claim older than its lifetime is removed).
    const slow = interrupt(deps, async () => {
      await deps.db.run("DELETE FROM media_object WHERE media_id = ?", [id]);
    }, { before: true });
    const r = await putPart(slow, token, id, 0, fileOf(IMAGE));
    expect([r.status, r.json?.error]).toEqual([409, "superseded"]);
    expect((await get(deps, token, id)).json.state).toBe("uploading");
    expect(await objectsOf(draftKeys, id)).toEqual([]);
    expect((await putPart(deps, token, id, 0, fileOf(IMAGE))).status).toBe(204);
  });

  it("(c) sends that die after their object landed count, are bounded per item, and are removed after their lifetime by a later touch", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await create(deps, token, CLIP)).json.id as string;
    const file = fileOf(CLIP);
    const usage = async () => (await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes as number;
    // A send dies after its object landed: no "done", no clean-up.
    const dying: Deps = { ...deps, db: { ...deps.db, batch: () => Promise.reject(new Error("cut off")) }, drafts: { ...deps.drafts, delete: () => Promise.reject(new Error("cut off")) } };
    for (let i = 0; i < MAX_LOOSE_CLAIMS; i++) {
      expect((await quiet(() => putPart(dying, token, id, 0, partOf(file, 0)))).status, `dying send ${i + 1}`).toBe(500);
      now += 1000;
    }
    // Their objects are there, named by rows, and counted beside the item's own bytes.
    expect((await draftKeys()).filter((k) => k.startsWith(`m/${id}/`))).toHaveLength(MAX_LOOSE_CLAIMS);
    expect(await orphans(deps, draftKeys)).toEqual([]);
    expect(await usage()).toBe(CLIP.bytes + MAX_LOOSE_CLAIMS * PART_BYTES);
    // One more send is refused while they are young: 429, and when to come back.
    const refusedSend = await putPart(deps, token, id, 1, partOf(file, 1));
    refused(refusedSend, 429, "too_many_items");
    const wait = Number(refusedSend.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(300);
    expect(await count(deps, "media_object")).toBe(MAX_LOOSE_CLAIMS);
    // Past their lifetime the next send removes them (objects, then rows) and goes through.
    now += 5 * 60 * 1000;
    for (let n = 0; n < 3; n++) expect((await putPart(deps, token, id, n, partOf(file, n))).status, `part ${n}`).toBe(204);
    expect(await count(deps, "media_object")).toBe(3);
    expect(await usage()).toBe(CLIP.bytes);
    expect(await objectsOf(draftKeys, id)).toEqual([0, 1, 2].map((n) => `m/${id}/part-00${n}`));
    // A send that dies after the item was finished leaves a claim on an online item: counted
    // until the sweep of a later create meets it past its lifetime.
    const dyingLate = interrupt(dying, async () => {
      expect((await commit(deps, token, id)).status).toBe(200);
    }, { before: true });
    expect((await quiet(() => putPart(dyingLate, token, id, 2, partOf(file, 2)))).status).toBe(500);
    expect(await usage()).toBe(CLIP.bytes + 500_000);
    expect(await orphans(deps, draftKeys)).toEqual([]);
    now += 5 * 60 * 1000 + 1;
    expect((await create(deps, token, IMAGE)).status).toBe(201);
    expect(await usage()).toBe(CLIP.bytes + IMAGE.bytes);
    expect(await objectsOf(draftKeys, id)).toEqual([0, 1, 2].map((n) => `m/${id}/part-00${n}`));
    expect(await count(deps, "media_object")).toBe(3);
  });

  it("(b) expiry is final: a send whose object lands after its claim's lifetime is never stored, even when another send pruned it meanwhile", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await create(deps, token, CLIP)).json.id as string;
    const file = fileOf(CLIP);
    // The object of the slow send of part 1 lands; then the clock passes the claim's
    // lifetime. Another request prunes the claim as loose: it deletes the claim's object,
    // the slow send's batch runs, and only then does the pruner delete the row (with its
    // `current = 0` re-check), as pruneClaims does in that order.
    const slow = interrupt(deps, async () => {
      now += 5 * 60 * 1000 + 1000;
    });
    const pruneMeanwhile: Deps = {
      ...slow,
      db: {
        ...slow.db,
        batch: async (stmts) => {
          if (!stmts.some((st) => st.sql.includes("SET stored_at"))) return deps.db.batch(stmts);
          const loose = await deps.db.all<{ claim: string }>("SELECT claim FROM media_object WHERE media_id = ? AND n = 1 AND current = 0 AND stored_at IS NULL AND claimed_at < ?", [id, now - 5 * 60 * 1000]);
          expect(loose).toHaveLength(1);
          await deps.drafts.delete(loose.map((l) => `m/${id}/part-001.${l.claim}`));
          await deps.db.batch(stmts);
          await deps.db.run("DELETE FROM media_object WHERE media_id = ? AND current = 0 AND (stored_at IS NOT NULL OR claimed_at < ?) AND claim = ?", [id, now - 5 * 60 * 1000, loose[0].claim]);
        },
      },
    };
    const r = await putPart(pruneMeanwhile, token, id, 1, partOf(file, 1));
    expect([r.status, r.json?.error]).toEqual([409, "superseded"]);
    expect(await deps.db.first("SELECT count(*) AS n FROM media_object WHERE media_id = ? AND n = 1 AND current = 1", [id])).toEqual({ n: 0 });
    expect(await count(deps, "media_object")).toBe(0);
    expect(await objectsOf(draftKeys, id)).toEqual([]);
    expect(await orphans(deps, draftKeys)).toEqual([]);
    // A fresh send of the part goes through, and the item can be finished with every object there.
    for (const n of [0, 1, 2]) expect((await putPart(deps, token, id, n, partOf(file, n))).status).toBe(204);
    expect((await commit(deps, token, id)).status).toBe(200);
    const files = await onlineItemFiles(deps, (await get(deps, token, id)).json.link_id);
    for (const key of files!.parts) expect(await readAll(deps, key)).not.toBeNull();
  });

  it("(b) a send past the claim's lifetime alone, with nobody pruning, is not stored either", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await create(deps, token, IMAGE)).json.id as string;
    const slow = interrupt(deps, async () => {
      now += 5 * 60 * 1000 - 60_000 + 1;
    });
    refused(await putPart(slow, token, id, 0, fileOf(IMAGE)), 409, "superseded");
    expect(await count(deps, "media_object")).toBe(0);
    expect(await objectsOf(draftKeys, id)).toEqual([]);
    expect((await putPart(deps, token, id, 0, fileOf(IMAGE))).status).toBe(204);
  });

  it("at the bound of loose claims, a finished item answers already_online, a full allowance storage_full, and a failing clean-up still 429", async () => {
    const { deps } = await makeDeps({ storageAllowanceBytes: IMAGE.bytes + 4 * 2000 + 500 });
    const { token } = await seedWorkspace(deps, "Acme");
    const now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await create(deps, token, IMAGE)).json.id as string;
    const loose = async (n: number, bytes: number) => {
      for (let i = 0; i < MAX_LOOSE_CLAIMS; i++) {
        await deps.db.run("INSERT INTO media_object (media_id, claim, n, ext, bytes, claimed_at) VALUES (?, ?, ?, ?, ?, ?)", [id, `${n === -1 ? "e" : "d"}${i}`.padEnd(24, "0"), n, n === -1 ? "png" : null, bytes, now]);
      }
    };
    // Young loose preview claims: the allowance is the reason a further preview is refused.
    await loose(-1, 2000);
    refused(await putPreview(deps, token, id, png(10, 10, 1000)), 413, "storage_full");
    // A failing clean-up on the way does not turn the 429 into a 500.
    const failing: Deps = { ...deps, drafts: { ...deps.drafts, delete: () => Promise.reject(new Error("the store is down")) } };
    await deps.db.run("UPDATE media_object SET claimed_at = ? WHERE media_id = ? AND claim LIKE 'e1%'", [now - 10 * 60 * 1000, id]);
    refused(await quiet(() => putPart(failing, token, id, 0, fileOf(IMAGE))), 429, "too_many_items");
    // An item that went online meanwhile answers as one.
    await deps.db.run("UPDATE media SET state = 'online' WHERE id = ?", [id]);
    await deps.db.run("UPDATE media_object SET claimed_at = ? WHERE media_id = ?", [now, id]);
    expect((await putPart(deps, token, id, 0, fileOf(IMAGE))).json.error).toBe("already_online");
  });

  it("(c) a commit leaves no replaced or expired claim behind", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await create(deps, token, IMAGE)).json.id as string;
    expect((await putPart(deps, token, id, 0, fileOf(IMAGE))).status).toBe(204);
    // A claim of a send that died long ago, written directly with its object.
    const claim = "c".repeat(24);
    await deps.db.run("INSERT INTO media_object (media_id, claim, n, bytes, claimed_at) VALUES (?, ?, 0, ?, ?)", [id, claim, IMAGE.bytes, now - 10 * 60 * 1000]);
    await deps.drafts.put(`m/${id}/part-000.${claim}`, fileOf(IMAGE), { contentType: "image/png" });
    expect((await commit(deps, token, id)).status).toBe(200);
    expect(await count(deps, "media_object")).toBe(1);
    expect(await objectsOf(draftKeys, id)).toEqual([`m/${id}/part-000`]);
    expect(await orphans(deps, draftKeys)).toEqual([]);
  });

  it("(c) a delete with a send still under way says cleanup_pending and counts until it is finished; an item at its row bound deletes within the budget", async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const { id } = await sendItem(deps, token, { ...CLIP, bytes: DEFAULT_MEDIA_LIMITS.clipMaxBytes });
    // The most claim rows an item can hold: every part, a preview, and the loose ones.
    expect((await putPreview(deps, token, id, png(10, 10, 100))).status).toBe(204);
    for (let i = 0; i < MAX_LOOSE_CLAIMS; i++) {
      await deps.db.run("INSERT INTO media_object (media_id, claim, n, bytes, claimed_at) VALUES (?, ?, 1, 2000000, ?)", [id, String(i).repeat(24), now]);
    }
    expect(await count(deps, "media_object")).toBe(27 + 1 + MAX_LOOSE_CLAIMS);
    const held = await remove(deps, token, id);
    refused(held, 500, "cleanup_pending");
    expect(held.calls).toBeLessThanOrEqual(8);
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes).toBe(DEFAULT_MEDIA_LIMITS.clipMaxBytes + MAX_LOOSE_CLAIMS * PART_BYTES);
    expect(await objectsOf(draftKeys, id)).toEqual([]);
    now += 5 * 60 * 1000 + 1;
    const done = await remove(deps, token, id);
    expect([done.status, done.calls <= 8]).toEqual([204, true]);
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes).toBe(0);
  });

  it("(c) a delete that cannot finish keeps counting the item until it does", async () => {
    const { deps } = await makeDeps({ storageAllowanceBytes: IMAGE.bytes + 1000 });
    const { token } = await seedWorkspace(deps, "Acme");
    const item = await shareItem(deps, token, IMAGE);
    const broken: Deps = { ...deps, drafts: { ...deps.drafts, delete: () => Promise.reject(new Error("the store is down")) } };
    refused(await quiet(() => remove(broken, token, item.id)), 500, "cleanup_pending");
    // The room is not free while the objects are there; the repeat, or the next create's sweep, frees it.
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json).toMatchObject({ used_bytes: IMAGE.bytes });
    expect((await remove(deps, token, item.id)).status).toBe(204);
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json).toMatchObject({ used_bytes: 0 });
    expect((await create(deps, token, IMAGE)).status).toBe(201);
  });
});

describe("the serving lookup", () => {
  it("answers an online item's part keys in order and its preview, and nothing for an unfinished, deleted or disabled one", SLOW, async () => {
    const { deps } = await makeDeps();
    const owner = await seedAccount(deps);
    const { token } = owner;
    const { id, file } = await sendItem(deps, token, CLIP);
    expect((await putPreview(deps, token, id, png(16, 9, 400))).status).toBe(204);
    const linkId = (await get(deps, token, id)).json.link_id as string;
    expect(await onlineItemFiles(deps, linkId)).toBeNull();
    expect((await commit(deps, token, id)).status).toBe(200);
    const files = await onlineItemFiles(deps, linkId);
    expect(files).toEqual({
      id, kind: "clip", contentType: "video/mp4", bytes: CLIP.bytes, width: 1280, height: 720, durationMs: 12_000, title: null, sharedAt: expect.any(Number),
      parts: [expect.stringMatching(new RegExp(`^m/${id}/part-000\\.[0-9a-f]{24}$`)), expect.stringMatching(/part-001\./), expect.stringMatching(/part-002\./)],
      preview: { key: expect.stringMatching(new RegExp(`^m/${id}/preview\\.[0-9a-f]{24}\\.png$`)), type: "png" },
    });
    const joined = new Uint8Array(CLIP.bytes);
    let at = 0;
    for (const key of files!.parts) {
      const bytes = (await readAll(deps, key))!;
      joined.set(bytes, at);
      at += bytes.length;
    }
    expect(joined).toEqual(file);
    expect(await onlineItemFiles(deps, "a".repeat(20))).toBeNull();
    expect(await onlineItemFiles(deps, "not a link id")).toBeNull();
    // The shared date is the commit's moment.
    const row = await deps.db.first<{ online_at: number }>("SELECT online_at FROM media WHERE id = ?", [id]);
    expect(files!.sharedAt).toBe(row!.online_at);
    // Two database calls for every input: online, unknown, malformed, empty.
    for (const asked of [linkId, "a".repeat(20), "not a link id", "", linkId.toUpperCase()]) {
      const m = metered(deps);
      await onlineItemFiles(m.deps, asked);
      expect(m.calls(), asked).toBe(2);
    }
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [owner.userId]);
    expect(await onlineItemFiles(deps, linkId)).toBeNull();
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [owner.userId]);
    expect((await remove(deps, token, id)).status).toBe(204);
    expect(await onlineItemFiles(deps, linkId)).toBeNull();
  });
});

describe("age, rate limits and settings", () => {
  it("an unfinished item older than a day answers as swept before any sweep runs: no part, no preview, no commit, no read", async () => {
    const { deps } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const { id, file } = await sendItem(deps, token, IMAGE);
    now += MEDIA_MAX_AGE_MS + 1;
    for (const r of [await putPart(deps, token, id, 0, file), await putPreview(deps, token, id, png(10, 10, 100)), await commit(deps, token, id), await get(deps, token, id), await send(deps, "GET", `/api/v1/media/${id}/preview`, { token })]) {
      expect(r.json).toEqual(NO_ITEM);
    }
    // It still counts until the sweep removes it, as an upload does, and a delete still removes it.
    expect((await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes).toBe(IMAGE.bytes);
    expect((await remove(deps, token, id)).status).toBe(204);
    expect(await count(deps, "media")).toBe(0);
  });

  it("a workspace sends at most 2,000 parts and 240 previews an hour", async () => {
    const { deps } = await makeDeps();
    const { workspaceId, token } = await seedWorkspace(deps, "Acme");
    const other = await seedWorkspace(deps, "Other");
    expect([LIMITS_MEDIA.part, LIMITS_MEDIA.preview]).toEqual([{ bucket: "media_part", windowMs: 3_600_000, most: 2000 }, { bucket: "media_preview", windowMs: 3_600_000, most: 240 }]);
    // The counts so far, written directly: one short of each limit.
    const now = 1_800_000_000_000;
    deps.now = () => now;
    const key = await workspaceKey(workspaceId);
    for (const limit of [LIMITS_MEDIA.part, LIMITS_MEDIA.preview]) {
      await deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, ?)", [limit.bucket, key, now - (now % limit.windowMs), limit.most - 1]);
    }
    const id = (await create(deps, token, IMAGE)).json.id as string;
    expect((await putPart(deps, token, id, 0, fileOf(IMAGE))).status).toBe(204);
    expect((await putPreview(deps, token, id, png(10, 10, 100))).status).toBe(204);
    const part = await putPart(deps, token, id, 0, fileOf(IMAGE));
    refused(part, 429, "too_many_items");
    expect(Number(part.headers.get("retry-after"))).toBeGreaterThan(0);
    refused(await putPreview(deps, token, id, png(10, 10, 100)), 429, "too_many_items");
    // A refused send stores nothing.
    expect(await count(deps, "media_object")).toBe(2);
    // Another workspace is not limited by it.
    const theirs = (await create(deps, other.token, IMAGE)).json.id as string;
    expect((await putPart(deps, other.token, theirs, 0, fileOf(IMAGE))).status).toBe(204);
  });

  it("limit settings that would need more parts than one public answer can send within the call budget, or are no whole numbers, are a configuration problem", () => {
    expect(mediaLimitsProblem({})).toBeNull();
    // The lookup's calls and the most parts fill the budget exactly, and the defaults are well inside it.
    expect(SERVE_LOOKUP_CALLS + MAX_SERVED_PARTS).toBe(SUBREQUEST_BUDGET);
    expect(Math.ceil(DEFAULT_MEDIA_LIMITS.clipMaxBytes / PART_BYTES)).toBeLessThanOrEqual(MAX_SERVED_PARTS);
    expect(mediaLimitsProblem({ mediaImageMaxBytes: MAX_SERVED_PARTS * PART_BYTES, mediaClipMaxBytes: MAX_SERVED_PARTS * PART_BYTES, mediaImageMaxSide: 65_535 })).toBeNull();
    expect(mediaLimitsProblem({ mediaClipMaxBytes: MAX_SERVED_PARTS * PART_BYTES + 1 })).toBe(
      `media settings: the most bytes of a shared image or clip must be a whole number from 1 to ${MAX_SERVED_PARTS * PART_BYTES} (${MAX_SERVED_PARTS} parts of ${PART_BYTES} bytes, which one answer can send within the call budget)`,
    );
    for (const bad of [{ mediaClipMaxBytes: MAX_SERVED_PARTS * PART_BYTES + 1 }, { mediaImageMaxBytes: MAX_SERVED_PARTS * PART_BYTES + 1 }, { mediaClipMaxBytes: 999 * PART_BYTES }, { mediaImageMaxBytes: 0 }, { mediaImageMaxBytes: 1.5 }, { mediaImageMaxSide: 0 }, { mediaImageMaxSide: 65_536 }]) {
      expect(mediaLimitsProblem(bad), JSON.stringify(bad)).toMatch(/^media settings: /);
    }
    expect(() => mediaLimits({ publicImageBase: "", setupCode: null, mediaClipMaxBytes: 10 ** 10 })).toThrow(/media settings/);
  });
});

describe("the list", () => {
  it("lists online items of one kind, newest first, 50 a page with an opaque cursor", async () => {
    const { deps } = await makeDeps();
    const { workspaceId, token } = await seedWorkspace(deps, "Acme");
    const other = await seedWorkspace(deps, "Other");
    // Rows written directly: 120 online images (some at the same moment), clips, unfinished and closing ones, and another workspace's.
    const linkOf = (i: number) => {
      let out = "";
      for (let v = i; out.length < 20; v = Math.floor(v / 32)) out += "abcdefghijklmnopqrstuvwxyz234567"[v % 32];
      return out;
    };
    const row = (ws: string, i: number, kind: string, state: string, createdAt: number) => ({
      sql: "INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, created_at) VALUES (?, ?, ?, ?, ?, 10, 1, 1, 1, ?, ?, ?, ?)",
      params: [`med_${String(i).padStart(24, "0")}`, ws, linkOf(i), kind, kind === "image" ? "image/png" : "image/gif", kind === "clip" ? 10 : null, `Item ${i}`, state, createdAt],
    });
    const stmts = [];
    for (let i = 1; i <= 120; i++) stmts.push(row(workspaceId, i, "image", "online", 1000 + Math.floor(i / 3)));
    stmts.push(row(workspaceId, 201, "clip", "online", 5000), row(workspaceId, 202, "image", "uploading", 6000), row(workspaceId, 203, "image", "closing", 6000), row(other.workspaceId, 204, "image", "online", 7000));
    await deps.db.batch(stmts);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r = await list(deps, token, `kind=image${cursor === null ? "" : `&cursor=${cursor}`}`);
      expect(r.status, r.text).toBe(200);
      seen.push(...r.json.items.map((i: Json) => i.id));
      expect(r.json.items.length).toBe(page < 2 ? 50 : 20);
      cursor = r.json.next;
      if (cursor === null) break;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(cursor).toBeNull();
    const expected = Array.from({ length: 120 }, (_, k) => 120 - k).sort((x, y) => Math.floor(y / 3) - Math.floor(x / 3) || y - x).map((i) => `med_${String(i).padStart(24, "0")}`);
    expect(seen).toEqual(expected);
    expect((await list(deps, token, "kind=clip")).json.items.map((i: Json) => i.id)).toEqual([`med_${"0".repeat(21)}201`]);
    // A cursor that is not one, and a missing or unknown kind.
    refused(await list(deps, token, "kind=image&cursor=abc"), 400, "bad_cursor");
    refused(await list(deps, token, "kind=image&cursor=" + btoa("1.med_" + "0".repeat(23))), 400, "bad_cursor");
    refused(await list(deps, token, ""), 400, "bad_request");
    refused(await list(deps, token, "kind=video"), 400, "bad_request");
    // Another workspace's cursor shows nothing of that workspace.
    const theirs = await list(deps, other.token, "kind=image");
    expect(theirs.json.items.map((i: Json) => i.id)).toEqual([`med_${"0".repeat(21)}204`]);
  });
});

describe("credentials", () => {
  it("a session works as a token does, and a disabled account's workspace is refused as the uploads refuse it", async () => {
    const { deps } = await makeDeps();
    const admin = await seedAccount(deps, { admin: true });
    const { createSignInCode, redeemSignInCode, csrfFor, SESSION_COOKIE } = await import("../src/sessions.ts");
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), null, null);
    if (made === null) throw new Error("no session");
    const headers = { cookie: `${SESSION_COOKIE}=${made.secret}`, "x-csrf-token": await csrfFor(made.secret), "sec-fetch-site": "same-origin", origin: ORIGIN };
    const r = await send(deps, "POST", "/api/v1/media", { body: JSON.stringify(IMAGE), headers: { ...headers, ...JSON_HEADERS } });
    expect(r.status, r.text).toBe(201);
    expect((await send(deps, "GET", `/api/v1/media/${r.json.id}`, { headers })).json.state).toBe("uploading");
    // Without the anti-forgery header a change is refused, as on every route a session may change.
    expect((await send(deps, "DELETE", `/api/v1/media/${r.json.id}`, { headers: { ...headers, "x-csrf-token": "" } })).status).toBe(403);

    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [admin.userId]);
    const routes: [string, string][] = [["POST", "/api/v1/media"], ["GET", "/api/v1/media?kind=image"], ["GET", `/api/v1/media/${r.json.id}`], ["DELETE", `/api/v1/media/${r.json.id}`], ["POST", `/api/v1/media/${r.json.id}/commit`], ["GET", `/api/v1/media/${r.json.id}/preview`]];
    for (const [method, path] of routes) {
      expect((await send(deps, method, path, { token: admin.token })).status, `${method} ${path} by token`).toBe(401);
      expect((await send(deps, method, path, { headers })).status, `${method} ${path} by session`).toBe(401);
      // The uploads answer the same.
    }
    expect((await send(deps, "POST", "/api/v1/uploads", { token: admin.token })).status).toBe(401);
    expect(await count(deps, "media")).toBe(1);
  });
});

describe("the call budget", () => {
  it("the largest clip is created, sent, committed, listed and deleted with no request over 40 calls", SLOW, async () => {
    const { deps, draftKeys } = await makeDeps();
    const { token } = await seedWorkspace(deps, "Acme");
    const spec: Spec = { ...CLIP, bytes: DEFAULT_MEDIA_LIMITS.clipMaxBytes };
    const { id, calls } = await sendItem(deps, token, spec);
    expect(calls).toHaveLength(1 + Math.ceil(spec.bytes / PART_BYTES));
    expect(calls.length - 1).toBe(27);
    expect(await objectsOf(draftKeys, id)).toHaveLength(27);
    expect((await putPreview(deps, token, id, png(10, 10, 100))).calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    const done = await commit(deps, token, id);
    expect(done.status).toBe(200);
    const listed = await list(deps, token, "kind=clip");
    expect(listed.json.items.map((i: Json) => i.id)).toEqual([id]);
    const gone = await remove(deps, token, id);
    expect(gone.status).toBe(204);
    expect(await objectsOf(draftKeys, id)).toEqual([]);
    for (const c of [...calls, done.calls, listed.calls, gone.calls]) expect(c).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    // The delete is a handful of calls whatever the number of parts: one store delete takes them all.
    expect(gone.calls).toBeLessThanOrEqual(8);
    expect({ create: calls[0], parts: Math.max(...calls.slice(1)), commit: done.calls, list: listed.calls, remove: gone.calls }).toEqual({ create: 7, parts: 8, commit: 7, list: 3, remove: 7 });
  });
});
