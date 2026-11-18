import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import type { Deps } from "../src/ports.ts";
import { clone, fixtures, send, stepImage, uploadTour, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;

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
        { id: older.tour_id, title: "Send an invoice", status: "draft", slug: await slug(older.tour_id), url: null, chapters: 2, steps: 4, updated_at: 1_800_000_003_000, published_at: null },
        { id: newer.tour_id, title: "Short one", status: "draft", slug: await slug(newer.tour_id), url: null, chapters: 1, steps: 1, updated_at: 1_800_000_001_000, published_at: null },
      ],
    });
    // The fields the desktop app's picker has always read are all still there.
    for (const t of r.json.tours) expect(t).toMatchObject({ id: expect.any(String), title: expect.any(String), status: "draft", chapters: expect.any(Number), steps: expect.any(Number) });
    const rb = await send(deps, "GET", "/api/v1/tours", { token: b.token });
    expect(rb.json.tours).toHaveLength(1);
    expect(rb.json.tours[0].steps).toBe(3);
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
  it("me returns the workspace name", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "Acme </script> Tours");
    await seedWorkspace(deps, "Other");
    const r = await send(deps, "GET", "/api/v1/me", { token: a.token });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ workspace: "Acme </script> Tours" });
    expect((await send(deps, "GET", "/api/v1/me")).status).toBe(401);
  });
});
