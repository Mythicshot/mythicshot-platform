import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { hashToken } from "../src/auth.ts";
import type { Db, Deps, Stmt, Value } from "../src/ports.ts";
import { PUBLIC_CACHE, STALE_PUBLISH_MS, type Snapshot } from "../src/publish.ts";
import { clone, count, fixtures, png, send, uploadTour, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
const PUBLIC_KEY = /^p\/[0-9a-f]{32}\.(png|jpg)$/;

type Ctx = Awaited<ReturnType<typeof makeDeps>> & { a: { workspaceId: string; token: string }; b: { workspaceId: string; token: string } };

async function setup(config?: Parameters<typeof makeDeps>[0]): Promise<Ctx> {
  const ctx = await makeDeps(config);
  const a = await seedWorkspace(ctx.deps, "Workspace A");
  const b = await seedWorkspace(ctx.deps, "Workspace B");
  return { ...ctx, a, b };
}

const publish = (deps: Deps, token: string | null, tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
const unpublish = (deps: Deps, token: string | null, tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/unpublish`, { token });

async function snapshotOf(deps: Deps, tourId: string): Promise<Snapshot | null> {
  const row = await deps.db.first<{ data: string }>("SELECT data FROM snapshot WHERE tour_id = ?", [tourId]);
  return row === null ? null : (JSON.parse(row.data) as Snapshot);
}

async function snapshotRow(deps: Deps, tourId: string): Promise<Json | null> {
  return deps.db.first<Json>("SELECT * FROM snapshot WHERE tour_id = ?", [tourId]);
}

async function liveKeys(deps: Deps, tourId?: string): Promise<string[]> {
  const rows = tourId
    ? await deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ? ORDER BY image_key", [tourId])
    : await deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object ORDER BY image_key");
  return rows.map((r) => r.image_key);
}

async function tourRow(deps: Deps, id: string): Promise<Json> {
  return (await deps.db.first<Json>("SELECT * FROM tour WHERE id = ?", [id]))!;
}

async function draftSteps(deps: Deps, tourId: string): Promise<Json[]> {
  return deps.db.all<Json>(
    "SELECT s.* FROM step s JOIN chapter c ON c.id = s.chapter_id WHERE s.tour_id = ? ORDER BY c.position, s.position",
    [tourId],
  );
}

async function bytesOf(store: Deps["pub"], key: string): Promise<Uint8Array | null> {
  const f = await store.get(key);
  return f === null ? null : new Uint8Array(await new Response(f.body).arrayBuffer());
}

function stepsOf(s: Snapshot) {
  return s.chapters.flatMap((c) => c.steps);
}

/** Every key the snapshot names: step images and the cover logo. */
function snapshotKeys(s: Snapshot): string[] {
  const keys = stepsOf(s).map((st) => st.image);
  if (s.cover?.logo) keys.push(s.cover.logo);
  return keys.sort();
}

/**
 * Every public object is named by a row (the live snapshot's or public_object's), every
 * live key exists, and each published tour's snapshot names exactly its live keys. A
 * public_object row may name a key that was never written (recorded before writing).
 */
async function expectConsistent(ctx: Ctx): Promise<void> {
  const live = await liveKeys(ctx.deps);
  const other = (await ctx.deps.db.all<{ image_key: string }>("SELECT image_key FROM public_object")).map((r) => r.image_key);
  const stored = (await ctx.publicKeys()).filter((k) => PUBLIC_KEY.test(k));
  for (const k of stored) expect(live.includes(k) || other.includes(k), `unrecorded ${k}`).toBe(true);
  for (const k of live) expect(stored).toContain(k);
  for (const k of live) expect(other).not.toContain(k);
  for (const t of await ctx.deps.db.all<{ id: string; status: string }>("SELECT id, status FROM tour")) {
    const snap = await snapshotOf(ctx.deps, t.id);
    if (t.status === "published") {
      expect(snap).not.toBeNull();
      expect(snapshotKeys(snap!)).toEqual(await liveKeys(ctx.deps, t.id));
    } else {
      expect(snap).toBeNull();
      expect(await liveKeys(ctx.deps, t.id)).toEqual([]);
    }
  }
}

/** A manifest of `n` small PNG steps. */
function manyStepManifest(n: number): Json {
  const m = clone(v2);
  const base = m.steps[1];
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120 }));
  return m;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publish", () => {
  it("publish copies every image under a new random name and writes the snapshot", async () => {
    const ctx = await setup();
    const { deps, a, draftKeys, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    const draftsBefore = await draftKeys();
    const r = await publish(deps, a.token, t.tour_id);
    expect(r.status).toBe(200);
    const tour = await tourRow(deps, t.tour_id);
    expect(r.json).toEqual({ slug: tour.slug, url: `/t/${tour.slug}`, steps: 3 });
    expect(tour.slug).toMatch(/^[a-z2-7]{10}$/);
    expect(tour.status).toBe("published");
    expect(typeof tour.published_at).toBe("number");

    const keys = await publicKeys();
    expect(keys).toHaveLength(3);
    for (const k of keys) {
      expect(k).toMatch(PUBLIC_KEY);
      expect(draftsBefore).not.toContain(k);
    }
    const snap = (await snapshotOf(deps, t.tour_id))!;
    const drafts = await draftSteps(deps, t.tour_id);
    const steps = stepsOf(snap);
    expect(steps.map((s) => s.id)).toEqual(drafts.map((d) => d.id));
    for (let i = 0; i < 3; i++) {
      expect(steps[i].image).toMatch(PUBLIC_KEY);
      expect(steps[i].image.endsWith("." + drafts[i].image_type)).toBe(true);
      expect(await bytesOf(deps.pub, steps[i].image)).toEqual(await bytesOf(deps.drafts, drafts[i].image_key));
    }
    expect(snapshotKeys(snap)).toEqual(keys);
    expect(await liveKeys(deps, t.tour_id)).toEqual(keys);
    expect(await count(deps, "public_object")).toBe(0);
    // The drafts are untouched: nothing moved, nothing deleted.
    expect(await draftKeys()).toEqual(draftsBefore);
    // The snapshot names no draft key.
    expect(JSON.stringify(snap)).not.toContain("u/up_");
  });

  it("the snapshot holds the steps' layer and the chapters in order", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    const more = clone(v2);
    more.title = "Second chapter";
    more.steps = more.steps.slice(0, 1);
    await uploadTour(deps, a.token, more, { kind: "chapter", tour_id: t.tour_id });
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200);
    const snap = (await snapshotOf(deps, t.tour_id))!;
    expect(snap.title).toBe("Send an invoice");
    expect(snap.spotlight_dim).toBe(60);
    expect(snap.chapters.map((c) => [c.title, c.steps.length])).toEqual([["Send an invoice", 3], ["Second chapter", 1]]);
    const s0 = snap.chapters[0].steps[0];
    expect(s0).toMatchObject({ width: 1280, height: 720, click: { x: 50, y: 50, size: 4 }, caption: null, spotlight: { x: 40, y: 30, w: 25, h: 12 }, notes: v2.steps[0].notes, card: null, advance: "hotspot", zoom: null });
    expect(snap.chapters[0].steps[2].click).toBeNull();
    expect(snap.chapters[0].description).toBeNull();
  });

  it("editing or uploading to the draft never changes what is published until Publish is pressed again", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const before = await snapshotRow(deps, t.tour_id);
    const keysBefore = await publicKeys();
    const more = clone(v2);
    more.title = "Second chapter";
    await uploadTour(deps, a.token, more, { kind: "chapter", tour_id: t.tour_id }, 7);
    await deps.db.run("UPDATE step SET caption = 'edited' WHERE tour_id = ?", [t.tour_id]);
    expect(await snapshotRow(deps, t.tour_id)).toEqual(before);
    expect(await publicKeys()).toEqual(keysBefore);
    expect((await tourRow(deps, t.tour_id)).status).toBe("published");

    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200);
    const snap = (await snapshotOf(deps, t.tour_id))!;
    expect(snap.chapters).toHaveLength(2);
    expect(stepsOf(snap).every((s) => s.caption === "edited")).toBe(true);
    // Step ids stay the draft's ids across publishes.
    const firstIds = stepsOf(JSON.parse(before!.data) as Snapshot).map((s) => s.id);
    expect(snap.chapters[0].steps.map((s) => s.id)).toEqual(firstIds);
    await expectConsistent(ctx);
  });

  it("publishing again swaps the images and removes only the old snapshot's", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    await deps.pub.put("p/someone-else.png", png(1, 1, 40), { contentType: "image/png" });
    const other = await uploadTour(deps, a.token, v2, { kind: "new" }, 3);
    await publish(deps, a.token, other.tour_id);
    const otherKeys = await liveKeys(deps, other.tour_id);
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const firstKeys = await liveKeys(deps, t.tour_id);
    const firstSlug = (await tourRow(deps, t.tour_id)).slug;

    const r = await publish(deps, a.token, t.tour_id);
    expect(r.status).toBe(200);
    expect(r.json.slug).toBe(firstSlug);
    const secondKeys = await liveKeys(deps, t.tour_id);
    expect(secondKeys).toHaveLength(3);
    for (const k of secondKeys) expect(firstKeys).not.toContain(k);
    const all = await publicKeys();
    for (const k of firstKeys) expect(all).not.toContain(k);
    expect(all).toContain("p/someone-else.png");
    for (const k of [...otherKeys, ...secondKeys]) expect(all).toContain(k);
    expect(all).toHaveLength(1 + 3 + 3);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  });

  it("an empty tour cannot be published", async () => {
    const { deps, a, publicKeys } = await setup();
    const id = "tour_" + "a".repeat(24);
    await deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'Empty', 'emptyslug2', 'draft', 1, 1)", [id, a.workspaceId]);
    const r = await publish(deps, a.token, id);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("empty_tour");
    expect(await count(deps, "snapshot")).toBe(0);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await publicKeys()).toEqual([]);
    expect((await tourRow(deps, id)).status).toBe("draft");
  });

  it("the snapshot carries the theme, zoom, cover, button, end card, autoplay and each step's card", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v3);
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200);
    const snap = (await snapshotOf(deps, t.tour_id))!;
    const drafts = await draftSteps(deps, t.tour_id);
    expect(snap).toEqual({
      title: v3.title,
      spotlight_dim: 60,
      image_base: "",
      theme: v3.theme,
      zoom: v3.zoom,
      cover: { ...v3.cover, logo: expect.stringMatching(/^p\/[0-9a-f]{32}\.png$/) },
      cta: v3.cta,
      end: v3.end,
      autoplay: v3.autoplay,
      chapters: [
        {
          id: t.chapter_id,
          title: v3.title,
          description: null,
          steps: v3.steps.map((s: Json, i: number) => ({
            id: drafts[i].id,
            image: expect.stringMatching(PUBLIC_KEY),
            width: s.width,
            height: s.height,
            click: s.click === null ? null : { ...s.click, size: 4 },
            caption: null,
            spotlight: s.spotlight,
            notes: s.notes,
            card: s.card,
            advance: s.advance,
            zoom: s.zoom,
          })),
        },
      ],
    });
  });

  it("the logo is published under its own random name and removed on unpublish", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v3);
    await publish(deps, a.token, t.tour_id);
    const snap = (await snapshotOf(deps, t.tour_id))!;
    const logo = snap.cover!.logo!;
    expect(logo).toMatch(/^p\/[0-9a-f]{32}\.png$/);
    expect(await liveKeys(deps, t.tour_id)).toContain(logo);
    const draftLogo = (await tourRow(deps, t.tour_id)).logo_key;
    expect(await bytesOf(deps.pub, logo)).toEqual(await bytesOf(deps.drafts, draftLogo));
    const file = (await deps.pub.get(logo))!;
    expect(file.contentType).toBe("image/png");
    expect(file.cacheControl).toBe(PUBLIC_CACHE);
    await file.body.cancel();
    // A second publish replaces the logo too.
    await publish(deps, a.token, t.tour_id);
    const logo2 = (await snapshotOf(deps, t.tour_id))!.cover!.logo!;
    expect(logo2).not.toBe(logo);
    expect(await publicKeys()).not.toContain(logo);
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204);
    expect(await publicKeys()).toEqual([]);
    expect(await deps.drafts.get(draftLogo)).not.toBeNull();
  });

  it("a link changed by hand to javascript: is left out of the snapshot", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v3);
    await deps.db.run("UPDATE tour SET cta = ?, end_card = ? WHERE id = ?", [
      JSON.stringify({ label: "Go", url: "javascript:alert(1)" }),
      JSON.stringify({ text: "Bye", primary: { label: "A", url: "http://example.com" }, secondary: { label: "B", url: "https://ok.example.com/x" }, replay: false }),
      t.tour_id,
    ]);
    await publish(deps, a.token, t.tour_id);
    const snap = (await snapshotOf(deps, t.tour_id))!;
    expect(snap.cta).toBeNull();
    expect(snap.end).toEqual({ text: "Bye", primary: null, secondary: { label: "B", url: "https://ok.example.com/x" }, replay: false });
    expect(JSON.stringify(snap)).not.toContain("javascript:");
  });

  it("a tour stored without settings publishes with the version 2 defaults", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v3);
    await deps.db.run("UPDATE tour SET theme = NULL, zoom = NULL, cover = NULL, cta = NULL, end_card = NULL, autoplay = NULL, logo_key = NULL, logo_type = NULL WHERE id = ?", [t.tour_id]);
    await deps.db.run("UPDATE step SET card = NULL, zoom = NULL WHERE tour_id = ?", [t.tour_id]);
    await publish(deps, a.token, t.tour_id);
    const snap = (await snapshotOf(deps, t.tour_id))!;
    expect(snap.zoom).toEqual({ enabled: false, percent: 118 });
    expect(snap.theme.progress_bar).toBe(false);
    expect(snap.autoplay).toEqual({ enabled: false, seconds: 5 });
    expect(snap.cover).toBeNull();
    expect(snap.cta).toBeNull();
    expect(snap.end).toBeNull();
    expect(stepsOf(snap).every((s) => s.card === null)).toBe(true);
    expect(await liveKeys(deps, t.tour_id)).toHaveLength(3); // no logo published
  });

  it("the snapshot stores the public image base from the configuration", async () => {
    const { deps, a } = await setup({ publicImageBase: "https://img.example.net" });
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    expect((await snapshotOf(deps, t.tour_id))!.image_base).toBe("https://img.example.net");
  });
});

describe("unpublish", () => {
  it("unpublish removes the snapshot rows and exactly its own keys", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys, draftKeys } = ctx;
    await deps.pub.put("p/someone-else.png", png(1, 1, 40), { contentType: "image/png" });
    const other = await uploadTour(deps, a.token, v2, { kind: "new" }, 2);
    await publish(deps, a.token, other.tour_id);
    const t = await uploadTour(deps, a.token, v3);
    await publish(deps, a.token, t.tour_id);
    const draftsBefore = await draftKeys();
    const stepsBefore = await draftSteps(deps, t.tour_id);
    const otherKeys = await liveKeys(deps, other.tour_id);

    const r = await unpublish(deps, a.token, t.tour_id);
    expect(r.status).toBe(204);
    const tour = await tourRow(deps, t.tour_id);
    expect(tour.status).toBe("draft");
    expect(tour.published_at).toBeNull();
    expect(await snapshotOf(deps, t.tour_id)).toBeNull();
    expect(await liveKeys(deps, t.tour_id)).toEqual([]);
    expect(await publicKeys()).toEqual(["p/someone-else.png", ...otherKeys].sort());
    // The draft is intact.
    expect(await draftKeys()).toEqual(draftsBefore);
    expect(await draftSteps(deps, t.tour_id)).toEqual(stepsBefore);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  });

  it("unpublish twice is 204 and deletes nothing more", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const other = await uploadTour(deps, a.token, v2, { kind: "new" }, 2);
    await publish(deps, a.token, other.tour_id);
    const t = await uploadTour(deps, a.token, v2);
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204); // never published
    await publish(deps, a.token, t.tour_id);
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204);
    const after = await publicKeys();
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204);
    expect(await publicKeys()).toEqual(after);
    expect(after).toEqual(await liveKeys(deps, other.tour_id));
  });

  it("publishing after unpublish makes new files under new names", async () => {
    const { deps, a, publicKeys } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const first = await publicKeys();
    await unpublish(deps, a.token, t.tour_id);
    await publish(deps, a.token, t.tour_id);
    const second = await publicKeys();
    expect(second).toHaveLength(3);
    for (const k of second) expect(first).not.toContain(k);
  });
});

describe("failures half-way", () => {
  it("a copy that fails leaves the old snapshot live and removes only this request's new keys", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const before = await snapshotRow(deps, t.tour_id);
    const keysBefore = await publicKeys();
    const drafts = await draftSteps(deps, t.tour_id);
    await deps.drafts.delete([drafts[1].image_key]);
    const r = await publish(deps, a.token, t.tour_id);
    expect(r.status).toBe(500);
    expect(r.json.error).toBe("publish_failed");
    expect(await snapshotRow(deps, t.tour_id)).toEqual(before);
    expect(await publicKeys()).toEqual(keysBefore);
    expect(await count(deps, "public_object")).toBe(0);
    expect((await tourRow(deps, t.tour_id)).status).toBe("published");
    await expectConsistent(ctx);
  });

  it("a write to the public store that fails part-way leaves nothing of this request", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    const realPut = deps.pub.put.bind(deps.pub);
    let n = 0;
    deps.pub.put = async (k, b, m) => {
      if (++n === 2) throw new Error("bucket unavailable");
      return realPut(k, b, m);
    };
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(500);
    deps.pub.put = realPut;
    expect(await publicKeys()).toEqual([]);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await count(deps, "snapshot")).toBe(0);
    expect((await tourRow(deps, t.tour_id)).status).toBe("draft");
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200); // a retry works
    await expectConsistent(ctx);
  });

  it("a failed commit batch leaves the previous snapshot live and removes the new objects", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const before = await snapshotRow(deps, t.tour_id);
    const keysBefore = await publicKeys();
    const realBatch = deps.db.batch.bind(deps.db);
    // A last statement the schema refuses makes the whole batch roll back.
    deps.db.batch = (stmts) => realBatch([...stmts, { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (2, ?, 0)", params: [a.workspaceId] }]);
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(500);
    deps.db.batch = realBatch;
    expect(await snapshotRow(deps, t.tour_id)).toEqual(before);
    expect(await publicKeys()).toEqual(keysBefore);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  });

  it("a commit that went through but answered with an error is treated as published", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const old = await publicKeys();
    const realBatch = deps.db.batch.bind(deps.db);
    deps.db.batch = async (stmts) => {
      await realBatch(stmts);
      throw new Error("connection lost after commit");
    };
    const r = await publish(deps, a.token, t.tour_id);
    deps.db.batch = realBatch;
    expect(r.status).toBe(200);
    const now = await publicKeys();
    expect(now).toHaveLength(3);
    for (const k of now) expect(old).not.toContain(k);
    await expectConsistent(ctx);
  });

  it("a publish whose pending objects were swept meanwhile does not go live", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const before = await snapshotRow(deps, t.tour_id);
    const keysBefore = await publicKeys();
    const realPut = deps.pub.put.bind(deps.pub);
    let swept = false;
    deps.pub.put = async (k, b, m) => {
      if (!swept) {
        swept = true;
        // What another request's sweep does to a stale publish: retire its pending rows.
        await deps.db.run("UPDATE public_object SET state = 'retired', publish_id = 'sweeper' WHERE state = 'pending'");
      }
      return realPut(k, b, m);
    };
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(500);
    deps.pub.put = realPut;
    expect(await snapshotRow(deps, t.tour_id)).toEqual(before);
    // Every object it wrote is gone or still recorded for deletion; nothing is unrecorded.
    await expectConsistent(ctx);
    // The next request finishes the deletion.
    await publish(deps, a.token, t.tour_id);
    expect(await count(deps, "public_object")).toBe(0);
    expect((await publicKeys()).filter((k) => keysBefore.includes(k))).toEqual([]);
    await expectConsistent(ctx);
  });

  it("a cleanup that cannot delete leaves its objects recorded, and a later request removes them", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const live = await liveKeys(deps, t.tour_id);
    const realPut = deps.pub.put.bind(deps.pub);
    const realDelete = deps.pub.delete.bind(deps.pub);
    let n = 0;
    deps.pub.put = async (k, b, m) => {
      if (++n === 3) throw new Error("bucket unavailable");
      return realPut(k, b, m);
    };
    deps.pub.delete = async () => {
      throw new Error("bucket unavailable");
    };
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(500);
    deps.pub.put = realPut;
    deps.pub.delete = realDelete;
    expect(await liveKeys(deps, t.tour_id)).toEqual(live);
    expect(await count(deps, "public_object")).toBeGreaterThan(0);
    await expectConsistent(ctx); // the two objects it wrote are still named by rows
    expect(errors).toHaveBeenCalled();
    // A retry is safe and clears what the failed request left.
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204);
    expect(await publicKeys()).toEqual([]);
    expect(await count(deps, "public_object")).toBe(0);
  });

  it("old images that cannot be deleted after a publish stay recorded and go with the next request", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const first = await liveKeys(deps, t.tour_id);
    const realDelete = deps.pub.delete.bind(deps.pub);
    deps.pub.delete = async () => {
      throw new Error("bucket unavailable");
    };
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200);
    deps.pub.delete = realDelete;
    const retired = (await deps.db.all<{ image_key: string; state: string }>("SELECT image_key, state FROM public_object ORDER BY image_key"));
    expect(retired).toEqual(first.map((k) => ({ image_key: k, state: "retired" })));
    await expectConsistent(ctx);
    await publish(deps, a.token, t.tour_id);
    for (const k of first) expect(await publicKeys()).not.toContain(k);
    expect(await count(deps, "public_object")).toBe(0);
  });

  it("an unpublish that cannot delete answers 500, stays unpublished, and a retry finishes it", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const realDelete = deps.pub.delete.bind(deps.pub);
    deps.pub.delete = async () => {
      throw new Error("bucket unavailable");
    };
    const r = await unpublish(deps, a.token, t.tour_id);
    deps.pub.delete = realDelete;
    expect(r.status).toBe(500);
    expect(r.json.error).toBe("cleanup_pending");
    expect((await tourRow(deps, t.tour_id)).status).toBe("draft");
    expect(await snapshotOf(deps, t.tour_id)).toBeNull();
    await expectConsistent(ctx);
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204);
    expect(await publicKeys()).toEqual([]);
  });

  it("a fresh pending publish is left alone and a stale one is swept by a later request", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const t = await uploadTour(deps, a.token, v2);
    // Another request's publish in flight: its pending row and object.
    const inflight = "p/" + "b".repeat(32) + ".png";
    await deps.db.run("INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at) VALUES (?, ?, 'pub_other', 'pending', ?)", [inflight, t.tour_id, now]);
    await deps.pub.put(inflight, png(1, 1, 40), { contentType: "image/png" });
    await publish(deps, a.token, t.tour_id);
    expect(await publicKeys()).toContain(inflight);
    now += STALE_PUBLISH_MS + 1;
    await publish(deps, a.token, t.tour_id);
    expect(await publicKeys()).not.toContain(inflight);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  });
});

describe("races", () => {
  it("two publishes at once end with one snapshot and no stray objects", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v3);
    await publish(deps, a.token, t.tour_id);
    const rs = await Promise.all([publish(deps, a.token, t.tour_id), publish(deps, a.token, t.tour_id), publish(deps, a.token, t.tour_id)]);
    for (const r of rs) expect(r.status).toBe(200);
    expect(await publicKeys()).toHaveLength(4);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  });

  it("publish racing unpublish ends either published or not, never in between", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    for (let i = 0; i < 4; i++) {
      await publish(deps, a.token, t.tour_id);
      const order = i % 2 === 0 ? [publish, unpublish] : [unpublish, publish];
      const rs = await Promise.all(order.map((f) => f(deps, a.token, t.tour_id)));
      for (const r of rs) expect([200, 204]).toContain(r.status);
      expect(await count(deps, "public_object")).toBe(0);
      await expectConsistent(ctx);
      const status = (await tourRow(deps, t.tour_id)).status;
      expect((await publicKeys()).length).toBe(status === "published" ? 3 : 0);
    }
  });

  it("publish racing a new upload's commit takes the new chapter whole or not at all", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    const more = clone(v2);
    more.title = "Second chapter";
    const { sendAll, commit } = await import("./bundle.ts");
    const id = await sendAll(deps, a.token, more, { kind: "chapter", tour_id: t.tour_id }, 5);
    const [p, c] = await Promise.all([publish(deps, a.token, t.tour_id), commit(deps, a.token, id)]);
    expect(p.status).toBe(200);
    expect(c.status).toBe(201);
    const snap = (await snapshotOf(deps, t.tour_id))!;
    expect([[3], [3, 3]]).toContainEqual(snap.chapters.map((ch) => ch.steps.length));
    expect(p.json.steps).toBe(stepsOf(snap).length);
    await expectConsistent(ctx);
  });
});

describe("scope and secrets", () => {
  it("workspace B's token cannot publish or unpublish A's tour", async () => {
    const ctx = await setup();
    const { deps, a, b, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    expect((await publish(deps, b.token, t.tour_id)).status).toBe(404);
    expect(await count(deps, "snapshot")).toBe(0);
    expect(await publicKeys()).toEqual([]);
    await publish(deps, a.token, t.tour_id);
    const before = await snapshotRow(deps, t.tour_id);
    const keys = await publicKeys();
    expect((await publish(deps, b.token, t.tour_id)).status).toBe(404);
    expect((await unpublish(deps, b.token, t.tour_id)).status).toBe(404);
    expect(await snapshotRow(deps, t.tour_id)).toEqual(before);
    expect(await publicKeys()).toEqual(keys);
    expect((await tourRow(deps, t.tour_id)).status).toBe("published");
    for (const bad of ["nope", "tour_" + "0".repeat(24), "TOUR_x"]) {
      expect((await publish(deps, a.token, bad)).status).toBe(404);
      expect((await unpublish(deps, a.token, bad)).status).toBe(404);
    }
  });

  it("publish and unpublish need the token", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    for (const r of [await publish(deps, null, t.tour_id), await unpublish(deps, null, t.tour_id), await publish(deps, "dp_" + "1".repeat(40), t.tour_id)]) {
      expect(r.status).toBe(401);
      expect(r.text).toBe('{"error":"unauthorized"}');
    }
    expect(await count(deps, "snapshot")).toBe(0);
  });

  it("no response body or console output contains the token or its hash", async () => {
    const { deps, a } = await setup();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const hash = await hashToken(a.token);
    const t = await uploadTour(deps, a.token, v3);
    const texts: string[] = [];
    const record = (r: { text: string; headers: Headers }) => {
      texts.push(r.text);
      r.headers.forEach((v) => texts.push(v));
    };
    record(await publish(deps, a.token, t.tour_id));
    record(await send(deps, "GET", "/p/" + (await liveKeys(deps, t.tour_id))[0].slice(2)));
    const realPut = deps.pub.put.bind(deps.pub);
    const realDelete = deps.pub.delete.bind(deps.pub);
    deps.pub.put = async () => {
      throw new Error("failed for " + a.token);
    };
    deps.pub.delete = async () => {
      throw new Error("failed for " + a.token + " " + hash);
    };
    record(await publish(deps, a.token, t.tour_id));
    deps.pub.put = realPut;
    record(await unpublish(deps, a.token, t.tour_id));
    deps.pub.delete = realDelete;
    record(await unpublish(deps, a.token, t.tour_id));
    record(await publish(deps, "dp_" + "e".repeat(40), t.tour_id));
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" ")));
    for (const text of [...texts, ...logged]) {
      expect(text).not.toContain(a.token.slice(3));
      expect(text).not.toContain(hash);
    }
  });
});

describe("limits", () => {
  it("a 200-step tour publishes inside the per-request query and subrequest limits", async () => {
    const ctx = await setup();
    const { deps, a, calls, publicKeys } = ctx;
    const m = manyStepManifest(200);
    const t = await uploadTour(deps, a.token, m);
    // Counts D1 calls (a batch is one query) and checks every statement against D1's own caps.
    const real: Db = deps.db;
    let dbCalls = 0;
    let maxParams = 0;
    let maxSql = 0;
    const track = (sql: string, params?: Value[]) => {
      maxParams = Math.max(maxParams, params?.length ?? 0);
      maxSql = Math.max(maxSql, sql.length);
    };
    deps.db = {
      all: (s, p) => (dbCalls++, track(s, p), real.all(s, p)),
      first: (s, p) => (dbCalls++, track(s, p), real.first(s, p)),
      run: (s, p) => (dbCalls++, track(s, p), real.run(s, p)),
      batch: (stmts: Stmt[]) => (dbCalls++, stmts.forEach((st) => track(st.sql, st.params)), real.batch(stmts)),
    };
    for (let round = 0; round < 2; round++) {
      dbCalls = 0;
      const before = calls();
      const r = await publish(deps, a.token, t.tour_id);
      expect(r.status).toBe(200);
      expect(r.json.steps).toBe(200);
      expect(calls() - before).toBeLessThanOrEqual(1000); // D1 and R2 subrequests together
      expect(dbCalls).toBeLessThanOrEqual(50); // D1 queries per invocation on the free plan
    }
    expect(maxParams).toBeLessThanOrEqual(100);
    expect(maxSql).toBeLessThanOrEqual(100_000);
    expect(await publicKeys()).toHaveLength(200);
    dbCalls = 0;
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204);
    expect(dbCalls).toBeLessThanOrEqual(50);
    expect(await publicKeys()).toEqual([]);
  }, 120_000);
});

describe("the public image route", () => {
  it("serves a published image and nothing else", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const snap = (await snapshotOf(deps, t.tour_id))!;
    const drafts = await draftSteps(deps, t.tour_id);
    for (let i = 0; i < 3; i++) {
      const name = stepsOf(snap)[i].image.slice(2);
      const r = await send(deps, "GET", "/p/" + name); // no token
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe(drafts[i].image_type === "png" ? "image/png" : "image/jpeg");
      expect(r.headers.get("cache-control")).toBe(PUBLIC_CACHE);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(r.bytes).toEqual(await bytesOf(deps.drafts, drafts[i].image_key));
      r.headers.forEach((v) => expect(v).not.toContain("u/up_"));
    }
    const draftName = drafts[0].image_key.split("/").pop();
    const unknown = "c".repeat(32) + ".png";
    for (const path of [
      "/p/u/up_x/step-001.png",
      "/p/" + drafts[0].image_key,
      "/p/" + draftName,
      "/p/../db.sqlite",
      "/p/%2e%2e/db.sqlite",
      "/p/%2e%2e%2fdb.sqlite",
      "/p/..%2f..%2fdb.sqlite",
      "/p/" + "a".repeat(31) + ".png",
      "/p/" + "A".repeat(32) + ".png",
      "/p/" + "a".repeat(32) + ".gif",
      "/p/" + unknown,
      "/p/",
      "/p",
    ]) {
      const r = await send(deps, "GET", path);
      expect(r.status, path).toBe(404);
    }
    // A name that was unpublished answers 404 too.
    const name = stepsOf(snap)[0].image.slice(2);
    await unpublish(deps, a.token, t.tour_id);
    expect((await send(deps, "GET", "/p/" + name)).status).toBe(404);
  });

  it("serves only names a live snapshot records, with the type from the name and not from the object", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    // An object in the public store that no snapshot uses (e.g. a publish still in flight).
    const loose = "d".repeat(32) + ".png";
    await deps.pub.put("p/" + loose, png(1, 1, 40), { contentType: "image/png" });
    expect((await send(deps, "GET", "/p/" + loose)).status).toBe(404);
    await publish(deps, a.token, t.tour_id);
    const key = (await liveKeys(deps, t.tour_id)).find((k) => k.endsWith(".png"))!;
    const bytes = await bytesOf(deps.pub, key);
    await deps.pub.put(key, bytes!, { contentType: "text/html" });
    const r = await send(deps, "GET", "/p/" + key.slice(2));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
  });
});
