import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import type { Deps } from "../src/ports.ts";
import { VERSION } from "../src/version.ts";
import pkg from "../package.json" with { type: "json" };
import { clone, fixtures, send, stepImage, uploadTour, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;

/** The bytes of a manifest's steps, as the upload declared and stored them. */
const bytesOf = (m: Json) => (m.steps as Json[]).reduce((n, st) => n + (st.bytes as number), 0);

async function firstStep(deps: Deps, chapterId: string): Promise<Json> {
  return (await deps.db.first<Json>("SELECT * FROM step WHERE chapter_id = ? ORDER BY position LIMIT 1", [chapterId]))!;
}

describe("tour list", () => {
  it("lists only this workspace's tours with chapter and step counts", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    const b = await seedWorkspace(deps, "B");
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const older = await uploadTour(deps, a.token, v2);
    now += 1000;
    const short = clone(v2);
    short.title = "Short one";
    short.steps = short.steps.slice(0, 1);
    const newer = await uploadTour(deps, a.token, short);
    now += 1000;
    await uploadTour(deps, b.token, v3);
    now += 1000;
    // A second chapter makes the older tour the most recently updated.
    await uploadTour(deps, a.token, short, { kind: "chapter", tour_id: older.tour_id });

    const r = await send(deps, "GET", "/api/v1/tours", { token: a.token });
    expect(r.status).toBe(200);
    const slug = async (id: string) => (await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [id]))!.slug;
    expect(r.json).toEqual({
      tours: [
        { id: older.tour_id, title: "Send an invoice", status: "draft", slug: await slug(older.tour_id), url: null, chapters: 2, steps: 4, bytes: bytesOf(v2) + bytesOf(short), updated_at: 1_800_000_003_000, published_at: null, unpublished_changes: false, access: "public", viewers: 0 },
        { id: newer.tour_id, title: "Short one", status: "draft", slug: await slug(newer.tour_id), url: null, chapters: 1, steps: 1, bytes: bytesOf(short), updated_at: 1_800_000_001_000, published_at: null, unpublished_changes: false, access: "public", viewers: 0 },
      ],
    });
    // The fields the desktop app's picker has always read are all still there.
    for (const t of r.json.tours) expect(t).toMatchObject({ id: expect.any(String), title: expect.any(String), status: "draft", chapters: expect.any(Number), steps: expect.any(Number) });
    const rb = await send(deps, "GET", "/api/v1/tours", { token: b.token });
    expect(rb.json.tours).toHaveLength(1);
    expect(rb.json.tours[0].steps).toBe(3);
  });

  it("unpublished_changes says whether a publish would change what visitors see", async () => {
    const { deps } = await makeDeps({ retiredGraceMs: 0 });
    const a = await seedWorkspace(deps, "A");
    const b = await seedWorkspace(deps, "B");
    const post = (path: string) => send(deps, "POST", path, { token: a.token });
    const flags = async (token = a.token): Promise<Record<string, unknown>> => {
      const r = await send(deps, "GET", "/api/v1/tours", { token });
      expect(r.status).toBe(200);
      return Object.fromEntries(r.json.tours.map((t: Json) => [t.id, t.unpublished_changes]));
    };
    const draft = await uploadTour(deps, a.token, v2);
    const t = await uploadTour(deps, a.token, v2, { kind: "new" }, 1);
    // B has a published tour with a chapter waiting: it must never show in A's list.
    const other = await uploadTour(deps, b.token, v3);
    expect((await send(deps, "POST", `/api/v1/tours/${other.tour_id}/publish`, { token: b.token })).status).toBe(200);
    await uploadTour(deps, b.token, v2, { kind: "chapter", tour_id: other.tour_id }, 2);

    // Two drafts: nothing is public, so nothing is behind.
    expect(await flags()).toEqual({ [draft.tour_id]: false, [t.tour_id]: false });
    // Published and untouched.
    expect((await post(`/api/v1/tours/${t.tour_id}/publish`)).status).toBe(200);
    expect(await flags()).toEqual({ [draft.tour_id]: false, [t.tour_id]: false });
    // A chapter uploaded as a draft is waiting.
    await uploadTour(deps, a.token, v2, { kind: "chapter", tour_id: t.tour_id }, 3);
    expect(await flags()).toEqual({ [draft.tour_id]: false, [t.tour_id]: true });
    // Publishing the waiting changes clears it.
    expect((await post(`/api/v1/tours/${t.tour_id}/publish`)).status).toBe(200);
    expect(await flags()).toEqual({ [draft.tour_id]: false, [t.tour_id]: false });
    // A rename is live at once: nothing waits.
    expect((await send(deps, "PATCH", `/api/v1/tours/${t.tour_id}`, { token: a.token, body: JSON.stringify({ title: "Renamed" }), headers: { "content-type": "application/json" } })).status).toBe(200);
    expect(await flags()).toEqual({ [draft.tour_id]: false, [t.tour_id]: false });
    // A snapshot from before draft versions were recorded: unknown reads as "may be behind".
    await deps.db.run("UPDATE snapshot SET draft_version = NULL WHERE tour_id = ?", [t.tour_id]);
    expect(await flags()).toEqual({ [draft.tour_id]: false, [t.tour_id]: true });
    // Waiting changes, then unpublished: a draft again, so false.
    expect((await post(`/api/v1/tours/${t.tour_id}/unpublish`)).status).toBe(204);
    expect(await flags()).toEqual({ [draft.tour_id]: false, [t.tour_id]: false });
    // Every entry carries the field as a boolean, and B sees only its own tour, which is behind.
    for (const v of Object.values(await flags())) expect(typeof v).toBe("boolean");
    expect(await flags(b.token)).toEqual({ [other.tour_id]: true });
  });

  it("each tour carries its size, its steps' pictures and its logo, and the sizes add up to the usage's pictures and logos", async () => {
    const { deps } = await makeDeps({ retiredGraceMs: 0 });
    const a = await seedWorkspace(deps, "A");
    const b = await seedWorkspace(deps, "B");
    // A tour with a logo (its commit records 1000 bytes for it) and a second chapter, a
    // published tour, and an open upload, which holds room but is no tour yet.
    const withLogo = await uploadTour(deps, a.token, v3);
    await uploadTour(deps, a.token, v2, { kind: "chapter", tour_id: withLogo.tour_id }, 1);
    const plain = await uploadTour(deps, a.token, v2, { kind: "new" }, 2);
    expect((await send(deps, "POST", `/api/v1/tours/${plain.tour_id}/publish`, { token: a.token })).status).toBe(200);
    const open = await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ manifest: v2, target: { kind: "new" } }), headers: { "content-type": "application/json" } });
    expect(open.status, open.text).toBe(201);
    // Another workspace's tour never enters A's sizes.
    await uploadTour(deps, b.token, v3);

    const tours = (await send(deps, "GET", "/api/v1/tours", { token: a.token })).json.tours as Json[];
    const size = Object.fromEntries(tours.map((t) => [t.id, t.bytes]));
    expect(size).toEqual({ [withLogo.tour_id]: bytesOf(v3) + 1000 + bytesOf(v2), [plain.tour_id]: bytesOf(v2) });
    for (const t of tours) expect(Number.isSafeInteger(t.bytes) && t.bytes >= 0, String(t.bytes)).toBe(true);
    // The sum over the workspace's tours is exactly the usage's pictures plus logos; the
    // usage's used_bytes is that plus the room open uploads hold.
    const usage = (await send(deps, "GET", "/api/v1/usage", { token: a.token })).json;
    const total = tours.reduce((n, t) => n + (t.bytes as number), 0);
    expect(total).toBe(usage.counted.pictures + usage.counted.logos);
    expect(usage.used_bytes).toBe(total + usage.counted.uploads_in_progress);
    expect(usage.counted.uploads_in_progress).toBe(bytesOf(v2));
    // A logo stored before its size was recorded counts as nothing, in the tour and in the usage alike.
    await deps.db.run("UPDATE tour SET logo_bytes = NULL WHERE id = ?", [withLogo.tour_id]);
    const after = (await send(deps, "GET", "/api/v1/tours", { token: a.token })).json.tours as Json[];
    expect(after.find((t) => t.id === withLogo.tour_id)!.bytes).toBe(bytesOf(v3) + bytesOf(v2));
    const usageAfter = (await send(deps, "GET", "/api/v1/usage", { token: a.token })).json;
    expect(after.reduce((n, t) => n + (t.bytes as number), 0)).toBe(usageAfter.counted.pictures + usageAfter.counted.logos);
  });

  it("the list makes as many database calls for many tours as for one", async () => {
    const { deps, calls } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    await uploadTour(deps, a.token, v2);
    const callsFor = async () => {
      const before = calls();
      expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).status).toBe(200);
      return calls() - before;
    };
    await callsFor();
    const one = await callsFor();
    for (let i = 1; i <= 4; i++) await uploadTour(deps, a.token, v2, { kind: "new" }, i);
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).json.tours).toHaveLength(5);
    expect(await callsFor()).toBe(one);
  });

  it("an empty workspace lists no tours", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).json).toEqual({ tours: [] });
  });
});

describe("draft images", () => {
  it("the draft image route needs the token", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    const done = await uploadTour(deps, a.token, v2);
    const step = await firstStep(deps, done.chapter_id);
    const path = `/api/v1/tours/${done.tour_id}/steps/${step.id}/image`;
    const anon = await send(deps, "GET", path);
    expect(anon.status).toBe(401);
    expect(anon.text).toBe('{"error":"unauthorized"}');
    const wrong = await send(deps, "GET", path, { token: "dp_" + "1".repeat(40) });
    expect(wrong.status).toBe(401);
    const r = await send(deps, "GET", path, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.bytes).toEqual(stepImage(v2.steps[0]));
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-disposition")).toBe('inline; filename="step.png"');
    expect(r.headers.get("content-length")).toBe(String(v2.steps[0].bytes));
  });

  it("serves a JPEG step as image/jpeg whatever the stored object says", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    const done = await uploadTour(deps, a.token, v2);
    const step = (await deps.db.first<Json>("SELECT * FROM step WHERE chapter_id = ? AND position = 2", [done.chapter_id]))!;
    // Even an object whose stored type was tampered with is served with the sniffed type.
    const stored = await deps.drafts.get(step.image_key);
    const bytes = new Uint8Array(await new Response(stored!.body).arrayBuffer());
    await deps.drafts.put(step.image_key, bytes, { contentType: "text/html" });
    const r = await send(deps, "GET", `/api/v1/tours/${done.tour_id}/steps/${step.id}/image`, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("content-disposition")).toBe('inline; filename="step.jpg"');
  });

  it("a step of another tour, an unknown step and a malformed id are 404", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    const one = await uploadTour(deps, a.token, v2);
    const two = await uploadTour(deps, a.token, v2);
    const stepOfTwo = await firstStep(deps, two.chapter_id);
    for (const path of [
      `/api/v1/tours/${one.tour_id}/steps/${stepOfTwo.id}/image`,
      `/api/v1/tours/${one.tour_id}/steps/st_${"0".repeat(24)}/image`,
      `/api/v1/tours/${one.tour_id}/steps/..%2F..%2Fdb.sqlite/image`,
    ]) {
      expect((await send(deps, "GET", path, { token: a.token })).status).toBe(404);
    }
  });

  it("a missing object is 404, not an error", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    const done = await uploadTour(deps, a.token, v2);
    const step = await firstStep(deps, done.chapter_id);
    await deps.drafts.delete([step.image_key]);
    expect((await send(deps, "GET", `/api/v1/tours/${done.tour_id}/steps/${step.id}/image`, { token: a.token })).status).toBe(404);
  });
});

describe("me", () => {
  it("me returns the server's version, which is package.json's, and only with a token", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme");
    expect(VERSION, "set VERSION in src/version.ts to the version in package.json").toBe(pkg.version);
    expect(VERSION).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+/);
    const r = await send(deps, "GET", "/api/v1/me", { token: a.token });
    expect(r.json.version).toBe(pkg.version);
    const anon = await send(deps, "GET", "/api/v1/me");
    expect(anon.status).toBe(401);
    expect(anon.text).not.toContain(pkg.version);
    expect((await send(deps, "GET", "/healthz")).text).not.toContain(pkg.version);
  });

  it("me returns the workspace name", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme </script> Tours");
    await seedWorkspace(deps, "Other");
    const r = await send(deps, "GET", "/api/v1/me", { token: a.token });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ workspace: "Acme </script> Tours", version: VERSION });
    expect((await send(deps, "GET", "/api/v1/me")).status).toBe(401);
  });
});
