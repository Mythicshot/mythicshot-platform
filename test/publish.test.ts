import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { hashToken } from "../src/auth.ts";
import { isUniqueViolation, type Db, type Deps, type Stmt, type Value } from "../src/ports.ts";
import { COPY_BATCH, MAX_SNAPSHOT_BYTES, PUBLIC_CACHE, STALE_PUBLISH_MS, type Snapshot } from "../src/publish.ts";
import { clone, count, fixtures, png, send, uploadTour, type Call, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
const PUBLIC_KEY = /^p\/[0-9a-f]{32}\.(png|jpg)$/;

type Ctx = Awaited<ReturnType<typeof makeDeps>> & { a: { workspaceId: string; token: string }; b: { workspaceId: string; token: string } };

/** Most tests delete replaced images at once (grace 0); the grace tests set their own. */
async function setup(config?: Parameters<typeof makeDeps>[0]): Promise<Ctx> {
  const ctx = await makeDeps({ retiredGraceMs: 0, ...config });
  const a = await seedWorkspace(ctx.deps, "Workspace A");
  const b = await seedWorkspace(ctx.deps, "Workspace B");
  return { ...ctx, a, b };
}

const publish = (deps: Deps, token: string | null, tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
const unpublish = (deps: Deps, token: string | null, tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/unpublish`, { token });
/** A later call of a publish in progress, naming it. */
const resume = (deps: Deps, token: string, tourId: string, publishId: string) =>
  send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token, body: JSON.stringify({ publish_id: publishId }), headers: { "content-type": "application/json" } });

/** Calls publish until it is no longer in progress, as the command-line helper does. */
async function publishAll(deps: Deps, token: string, tourId: string): Promise<{ last: Call; calls: Call[] }> {
  let r = await publish(deps, token, tourId);
  const calls = [r];
  while (r.status === 202) {
    r = await resume(deps, token, tourId, r.json.publish_id);
    calls.push(r);
  }
  return { last: r, calls };
}

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

  it("a snapshot records the draft version it was built from, and a re-publish after a chapter upload records the new one", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200);
    expect((await tourRow(deps, t.tour_id)).draft_version).toBe(1);
    expect((await snapshotRow(deps, t.tour_id))!.draft_version).toBe(1);
    const more = clone(v2);
    more.title = "Second chapter";
    await uploadTour(deps, a.token, more, { kind: "chapter", tour_id: t.tour_id }, 7);
    // The upload alone changes the draft, not what the snapshot says it was built from.
    expect((await tourRow(deps, t.tour_id)).draft_version).toBe(2);
    expect((await snapshotRow(deps, t.tour_id))!.draft_version).toBe(1);
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200);
    expect((await snapshotRow(deps, t.tour_id))!.draft_version).toBe(2);
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
      theme: v3.theme,
      zoom: v3.zoom,
      cover: { ...v3.cover, logo: expect.stringMatching(/^p\/[0-9a-f]{32}\.png$/) },
      cta: v3.cta,
      end: v3.end,
      autoplay: v3.autoplay,
      chapters: [
        {
          id: expect.stringMatching(/^c_[0-9a-f]{24}$/),
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

  it("the snapshot holds no image base: the page takes the configured one when it renders", async () => {
    const { deps, a } = await setup({ publicImageBase: "https://img.example.net" });
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const snap = (await snapshotOf(deps, t.tour_id))! as Json;
    expect(Object.keys(snap)).not.toContain("image_base");
    expect(JSON.stringify(snap)).not.toContain("img.example.net");
  });

  it("the snapshot's JSON holds no draft key, upload id or internal id beyond step ids", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v3);
    const more = clone(v3);
    more.title = "Second chapter";
    const t2 = await uploadTour(deps, a.token, more, { kind: "chapter", tour_id: t.tour_id }, 4);
    await publish(deps, a.token, t.tour_id);
    const text = (await snapshotRow(deps, t.tour_id))!.data as string;
    const tour = await tourRow(deps, t.tour_id);
    const secrets = [
      "u/", "up_", "ch_", "tour_", "ws_", "tok_",
      t.tour_id, t.tour_id.slice(5), a.workspaceId, a.workspaceId.slice(3),
      t.chapter_id.slice(3), t2.chapter_id.slice(3), // the upload ids behind the chapters
      tour.logo_key,
      ...(await draftSteps(deps, t.tour_id)).map((s) => s.image_key),
    ];
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
    // Step ids are the one internal id the snapshot keeps, for analytics across publishes.
    const ids = stepsOf(JSON.parse(text)).map((s) => s.id);
    expect(ids).toEqual((await draftSteps(deps, t.tour_id)).map((s) => s.id));
  });

  it("chapter ids are the snapshot's own, distinct per chapter and stable across publishes", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    const more = clone(v2);
    more.title = "Second chapter";
    await uploadTour(deps, a.token, more, { kind: "chapter", tour_id: t.tour_id }, 4);
    await publish(deps, a.token, t.tour_id);
    const first = (await snapshotOf(deps, t.tour_id))!.chapters.map((c) => c.id);
    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    for (const id of first) expect(id).toMatch(/^c_[0-9a-f]{24}$/);
    await unpublish(deps, a.token, t.tour_id);
    await publish(deps, a.token, t.tour_id);
    expect((await snapshotOf(deps, t.tour_id))!.chapters.map((c) => c.id)).toEqual(first);
  });

  it("a public key can belong to one snapshot only", async () => {
    const { deps, a } = await setup();
    const t1 = await uploadTour(deps, a.token, v2);
    const t2 = await uploadTour(deps, a.token, v2, { kind: "new" }, 2);
    await publish(deps, a.token, t1.tour_id);
    const key = (await liveKeys(deps, t1.tour_id))[0];
    let err: unknown = null;
    try {
      await deps.db.run("INSERT INTO snapshot_object (tour_id, image_key) VALUES (?, ?)", [t2.tour_id, key]);
    } catch (e) {
      err = e;
    }
    expect(isUniqueViolation(err)).toBe(true);
    expect(await liveKeys(deps, t2.tour_id)).toEqual([]);
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
      if (stmts[0].sql.includes("INSERT INTO snapshot ")) throw new Error("connection lost after commit");
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
      // A publish that unpublish cancelled answers 409.
      for (const r of rs) expect([200, 204, 409]).toContain(r.status);
      expect(await count(deps, "public_object")).toBe(0);
      await expectConsistent(ctx);
      const status = (await tourRow(deps, t.tour_id)).status;
      expect((await publicKeys()).length).toBe(status === "published" ? 3 : 0);
    }
  });

  it("unpublish landing between a publish's copies and its commit cancels the publish and leaves nothing public", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    // Hold the publish's last copy until a whole unpublish has run.
    const realPut = deps.pub.put.bind(deps.pub);
    let puts = 0;
    let unpublished: Json | null = null;
    deps.pub.put = async (k, b, m) => {
      if (++puts === 3) unpublished = await unpublish(deps, a.token, t.tour_id);
      return realPut(k, b, m);
    };
    const r = await publish(deps, a.token, t.tour_id);
    deps.pub.put = realPut;
    expect(unpublished!.status).toBe(204);
    // Unpublish cancels a publish in progress: it can no longer commit, and the image it
    // wrote after its rows were removed is deleted too.
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("publish_cancelled");
    expect((await tourRow(deps, t.tour_id)).status).toBe("draft");
    expect(await publicKeys()).toEqual([]);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await count(deps, "publish_job")).toBe(0);
    await expectConsistent(ctx);
  });

  it("unpublish landing between a publish's commit and its cleanup ends unpublished with nothing public", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const realBatch = deps.db.batch.bind(deps.db);
    let unpublished: Json | null = null;
    deps.db.batch = async (stmts) => {
      await realBatch(stmts);
      if (unpublished === null && stmts[0].sql.includes("INSERT INTO snapshot ")) {
        deps.db.batch = realBatch;
        unpublished = await unpublish(deps, a.token, t.tour_id);
      }
    };
    const r = await publish(deps, a.token, t.tour_id);
    deps.db.batch = realBatch;
    expect(r.status).toBe(200);
    expect(unpublished!.status).toBe(204);
    expect((await tourRow(deps, t.tour_id)).status).toBe("draft");
    expect(await publicKeys()).toEqual([]);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  });

  it("publish and unpublish succeed while another request deletes the same images at the same moment", async () => {
    // The interleaving behind the intermittent failure: a publish's cleanup and an
    // unpublish both read the same retired images and delete them together. Every delete
    // here runs twice at once, as if a second request were clearing the same keys.
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const realDelete = deps.pub.delete.bind(deps.pub);
    let doubled = 0;
    deps.pub.delete = async (keys) => {
      if (keys.length > 0) doubled++;
      await Promise.all([realDelete(keys), realDelete([...keys].reverse())]);
    };
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200); // deletes the replaced images
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204); // deletes the live ones
    deps.pub.delete = realDelete;
    expect(doubled).toBeGreaterThanOrEqual(2);
    expect(await publicKeys()).toEqual([]);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
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

describe("publishing in bounded steps", () => {
  /** Uploads a tour of `n` small steps, in uploads of at most 200 (the manifest cap). */
  async function bigTour(deps: Deps, token: string, n: number, fill = 0): Promise<string> {
    let tourId: string | null = null;
    for (let at = 0; at < n; at += 200) {
      const m = manyStepManifest(Math.min(200, n - at));
      m.title = `Part ${at / 200 + 1}`;
      const t: { tour_id: string } = await uploadTour(deps, token, m, tourId === null ? { kind: "new" } : { kind: "chapter", tour_id: tourId }, fill + at / 200);
      tourId = t.tour_id;
    }
    return tourId!;
  }

  it("a large tour publishes over several calls, each copying at most COPY_BATCH images, and goes live only on the last", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const tourId = await bigTour(deps, a.token, 60);
    const first = await publish(deps, a.token, tourId);
    expect(first.status).toBe(202);
    expect(first.json).toEqual({ status: "in_progress", publish_id: expect.stringMatching(/^pub_[0-9a-f]{24}$/), done: COPY_BATCH, total: 60 });
    expect(COPY_BATCH).toBe(12);
    // Nothing is live yet: no snapshot, no served image, the tour is still a draft.
    expect(await snapshotRow(deps, tourId)).toBeNull();
    expect((await tourRow(deps, tourId)).status).toBe("draft");
    const id = first.json.publish_id as string;
    const seen = [first];
    let r = first;
    while (r.status === 202) {
      r = await resume(deps, a.token, tourId, id);
      seen.push(r);
    }
    expect(seen.map((x) => x.json.done ?? "done")).toEqual([12, 24, 36, 48, "done"]);
    const tour = await tourRow(deps, tourId);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ slug: tour.slug, url: `/t/${tour.slug}`, steps: 60 });
    expect(tour.status).toBe("published");
    expect(await publicKeys()).toHaveLength(60);
    expect(await count(deps, "publish_job")).toBe(0);
    expect(await count(deps, "public_object")).toBe(0);
    // Asking again with the same id answers the same and does nothing more.
    const again = await resume(deps, a.token, tourId, id);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(r.json);
    expect(await publicKeys()).toHaveLength(60);
    await expectConsistent(ctx);
  }, 120_000);

  it("viewers keep the previous version, images included, until the final call commits the new one", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const tourId = await bigTour(deps, a.token, 30);
    expect((await publishAll(deps, a.token, tourId)).last.status).toBe(200);
    const before = await snapshotRow(deps, tourId);
    const oldKeys = await liveKeys(deps, tourId);
    const r1 = await publish(deps, a.token, tourId);
    const r2 = await resume(deps, a.token, tourId, r1.json.publish_id);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    expect(await snapshotRow(deps, tourId)).toEqual(before);
    for (const k of oldKeys) expect((await send(deps, "GET", "/p/" + k.slice(2))).status).toBe(200);
    // The images copied so far are not served: no live snapshot names them.
    const pending = await deps.db.all<{ image_key: string }>("SELECT image_key FROM public_object WHERE state = 'pending' AND copied = 1");
    expect(pending).toHaveLength(24);
    for (const p of pending.slice(0, 3)) expect((await send(deps, "GET", "/p/" + p.image_key.slice(2))).status).toBe(404);
    const r3 = await resume(deps, a.token, tourId, r1.json.publish_id);
    expect(r3.status).toBe(200);
    expect(await snapshotRow(deps, tourId)).not.toEqual(before);
    for (const k of await liveKeys(deps, tourId)) expect(oldKeys).not.toContain(k);
    await expectConsistent(ctx);
  }, 120_000);

  it("a publish stopped half-way leaves the published version alone, and its copies are swept later", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const tourId = await bigTour(deps, a.token, 40);
    await publishAll(deps, a.token, tourId);
    const before = await snapshotRow(deps, tourId);
    const live = await liveKeys(deps, tourId);
    const r1 = await publish(deps, a.token, tourId);
    await resume(deps, a.token, tourId, r1.json.publish_id);
    // The client goes away. The half-copied images are recorded as pending, nothing else changed.
    expect(await snapshotRow(deps, tourId)).toEqual(before);
    expect(await count(deps, "public_object")).toBe(40);
    expect((await publicKeys()).length).toBe(40 + 24);
    await expectConsistent(ctx);
    // Within the stale period the same publish can be resumed where it stopped.
    now += STALE_PUBLISH_MS - 1000;
    const resumed = await resume(deps, a.token, tourId, r1.json.publish_id);
    expect(resumed.json.done).toBe(36);
    // Once it has made no progress for the stale period, any request in the workspace sweeps it.
    now += STALE_PUBLISH_MS + 1;
    const other = await uploadTour(deps, a.token, v2, { kind: "new" }, 99);
    expect((await publish(deps, a.token, other.tour_id)).status).toBe(200);
    expect(await snapshotRow(deps, tourId)).toEqual(before);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await count(deps, "publish_job")).toBe(0);
    // Only the stopped publish's images went: the live ones and the other tour's stay.
    expect((await publicKeys()).sort()).toEqual([...live, ...(await liveKeys(deps, other.tour_id))].sort());
    // Continuing the swept publish is refused; a new publish starts over and finishes.
    const late = await resume(deps, a.token, tourId, r1.json.publish_id);
    expect(late.status).toBe(409);
    expect(late.json.error).toBe("publish_cancelled");
    expect((await publishAll(deps, a.token, tourId)).last.status).toBe(200);
    await expectConsistent(ctx);
  }, 120_000);

  it("calls arriving twice at once copy the same images and end with one snapshot and no stray objects", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const tourId = await bigTour(deps, a.token, 30);
    const r1 = await publish(deps, a.token, tourId);
    const id = r1.json.publish_id as string;
    for (;;) {
      const rs = await Promise.all([resume(deps, a.token, tourId, id), resume(deps, a.token, tourId, id)]);
      for (const r of rs) expect([200, 202]).toContain(r.status);
      if (rs.every((r) => r.status === 200)) {
        expect(rs[0].json).toEqual(rs[1].json);
        break;
      }
    }
    expect(await publicKeys()).toHaveLength(30);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  }, 120_000);

  it("two first calls at once start one publish, and the second joins it", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const tourId = await bigTour(deps, a.token, 30);
    const [x, y] = await Promise.all([publish(deps, a.token, tourId), publish(deps, a.token, tourId)]);
    expect([x.status, y.status]).toEqual([202, 202]);
    expect(x.json.publish_id).toBe(y.json.publish_id);
    expect(await count(deps, "publish_job")).toBe(1);
    expect(await count(deps, "public_object")).toBe(30);
    // A later call without an id joins the publish in progress too.
    const z = await publish(deps, a.token, tourId);
    expect(z.json.publish_id).toBe(x.json.publish_id);
    expect((await publishAll(deps, a.token, tourId)).last.status).toBe(200);
    await expectConsistent(ctx);
  }, 120_000);

  it("a draft that changes mid-publish does not mix: the publish finishes the version it started from", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const tourId = await bigTour(deps, a.token, 30);
    const r1 = await publish(deps, a.token, tourId);
    const more = clone(v2);
    more.title = "Added mid-publish";
    await uploadTour(deps, a.token, more, { kind: "chapter", tour_id: tourId }, 50);
    await deps.db.run("UPDATE step SET caption = 'edited mid-publish' WHERE tour_id = ?", [tourId]);
    let r = r1;
    while (r.status === 202) r = await resume(deps, a.token, tourId, r1.json.publish_id);
    expect(r.json.steps).toBe(30);
    const snap = (await snapshotOf(deps, tourId))!;
    expect(snap.chapters.map((c) => c.title)).toEqual(["Part 1"]);
    expect(stepsOf(snap).every((s) => s.caption !== "edited mid-publish")).toBe(true);
    await expectConsistent(ctx);
    // The next publish takes the new chapter and the edits.
    expect((await publishAll(deps, a.token, tourId)).last.json.steps).toBe(33);
    const next = (await snapshotOf(deps, tourId))!;
    expect(next.chapters.map((c) => c.title)).toEqual(["Part 1", "Added mid-publish"]);
    expect(stepsOf(next).every((s) => s.caption === "edited mid-publish")).toBe(true);
    await expectConsistent(ctx);
  }, 120_000);

  it("unpublish during a publish cancels it: nothing goes live and nothing of it is left", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const tourId = await bigTour(deps, a.token, 40);
    await publishAll(deps, a.token, tourId);
    const r1 = await publish(deps, a.token, tourId);
    await resume(deps, a.token, tourId, r1.json.publish_id);
    expect((await unpublish(deps, a.token, tourId)).status).toBe(204);
    expect(await publicKeys()).toEqual([]);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await count(deps, "publish_job")).toBe(0);
    const late = await resume(deps, a.token, tourId, r1.json.publish_id);
    expect(late.status).toBe(409);
    expect(late.json.error).toBe("publish_cancelled");
    expect((await tourRow(deps, tourId)).status).toBe("draft");
    expect(await snapshotRow(deps, tourId)).toBeNull();
    expect(await publicKeys()).toEqual([]);
    await expectConsistent(ctx);
  }, 120_000);

  it("an id that does not name the publish in progress or the live one is refused, and a malformed body is 400", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const tourId = await bigTour(deps, a.token, 30);
    const r1 = await publish(deps, a.token, tourId);
    const stranger = "pub_" + "0".repeat(24);
    expect((await resume(deps, a.token, tourId, stranger)).status).toBe(409);
    expect((await resume(deps, b.token, tourId, r1.json.publish_id)).status).toBe(404);
    for (const body of ["{", "[]", '{"publish_id": 5}', '{"publish_id": "pub_x"}']) {
      const r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token: a.token, body });
      expect(r.status, body).toBe(400);
    }
    // None of that disturbed the publish in progress.
    expect((await resume(deps, a.token, tourId, r1.json.publish_id)).json.done).toBe(24);
  }, 120_000);

  it("a copy that fails half-way stops the whole publish and deletes only what it made", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const tourId = await bigTour(deps, a.token, 40);
    await publishAll(deps, a.token, tourId);
    const before = await snapshotRow(deps, tourId);
    const live = await liveKeys(deps, tourId);
    const r1 = await publish(deps, a.token, tourId);
    const realGet = deps.drafts.get.bind(deps.drafts);
    let n = 0;
    deps.drafts.get = async (k) => {
      if (++n === 5) throw new Error("bucket unavailable");
      return realGet(k);
    };
    const r2 = await resume(deps, a.token, tourId, r1.json.publish_id);
    deps.drafts.get = realGet;
    expect(r2.status).toBe(500);
    expect(r2.json.error).toBe("publish_failed");
    expect(await snapshotRow(deps, tourId)).toEqual(before);
    expect((await publicKeys()).sort()).toEqual(live);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await count(deps, "publish_job")).toBe(0);
    expect((await resume(deps, a.token, tourId, r1.json.publish_id)).status).toBe(409);
    await expectConsistent(ctx);
  }, 120_000);

  it("every statement stays inside D1's caps on parameters and SQL length", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const tourId = await bigTour(deps, a.token, 400);
    const real: Db = deps.db;
    let maxParams = 0;
    let maxSql = 0;
    const track = (sql: string, params?: Value[]) => {
      maxParams = Math.max(maxParams, params?.length ?? 0);
      maxSql = Math.max(maxSql, sql.length);
    };
    deps.db = {
      all: (s, p) => (track(s, p), real.all(s, p)),
      first: (s, p) => (track(s, p), real.first(s, p)),
      run: (s, p) => (track(s, p), real.run(s, p)),
      batch: (stmts: Stmt[]) => (stmts.forEach((st) => track(st.sql, st.params)), real.batch(stmts)),
    };
    const { last, calls } = await publishAll(deps, a.token, tourId);
    expect(last.status).toBe(200);
    expect(last.json.steps).toBe(400);
    expect(calls).toHaveLength(Math.ceil(400 / COPY_BATCH));
    expect((await unpublish(deps, a.token, tourId)).status).toBe(204);
    deps.db = real;
    expect(maxParams).toBeLessThanOrEqual(100);
    expect(maxSql).toBeLessThanOrEqual(100_000);
  }, 300_000);

  it("a fresh start after a publish abandoned for longer than the stale period begins a new publish in that same request", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const tourId = await bigTour(deps, a.token, 30);
    const first = await publish(deps, a.token, tourId);
    expect(first.json).toMatchObject({ status: "in_progress", done: 12, total: 30 });
    now += 16 * 60_000;
    const fresh = await publish(deps, a.token, tourId);
    expect(fresh.status).toBe(202);
    expect(fresh.json.publish_id).not.toBe(first.json.publish_id);
    expect(fresh.json.done).toBeGreaterThan(0);
    // The abandoned publish's rows and images are gone; only the new one's are pending.
    const pending = await deps.db.all<{ publish_id: string }>("SELECT DISTINCT publish_id FROM public_object WHERE state = 'pending'");
    expect(pending).toEqual([{ publish_id: fresh.json.publish_id }]);
    expect(await count(deps, "publish_job")).toBe(1);
    expect((await resume(deps, a.token, tourId, first.json.publish_id)).status).toBe(409);
    let r = fresh;
    while (r.status === 202) r = await resume(deps, a.token, tourId, fresh.json.publish_id);
    expect(r.status).toBe(200);
    expect(await publicKeys()).toHaveLength(30);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  }, 120_000);

  it("a fresh start finding a running publish of an older draft cancels it and starts from the current draft", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    const tourId = await bigTour(deps, a.token, 30);
    const old = await publish(deps, a.token, tourId);
    const more = clone(v2);
    more.title = "Added after the first call";
    await uploadTour(deps, a.token, more, { kind: "chapter", tour_id: tourId }, 60);
    const fresh = await publish(deps, a.token, tourId);
    expect(fresh.status).toBe(202);
    expect(fresh.json.publish_id).not.toBe(old.json.publish_id);
    expect(fresh.json.total).toBe(33);
    expect((await resume(deps, a.token, tourId, old.json.publish_id)).status).toBe(409);
    let r = fresh;
    while (r.status === 202) r = await resume(deps, a.token, tourId, fresh.json.publish_id);
    expect(r.json.steps).toBe(33);
    expect((await snapshotOf(deps, tourId))!.chapters.map((c) => c.title)).toEqual(["Part 1", "Added after the first call"]);
    expect(await publicKeys()).toHaveLength(33);
    expect(await count(deps, "public_object")).toBe(0);
    await expectConsistent(ctx);
  }, 120_000);

  it("a fresh start finding a running publish of the current draft joins it", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const tourId = await bigTour(deps, a.token, 30);
    const one = await publish(deps, a.token, tourId);
    const two = await publish(deps, a.token, tourId);
    expect(two.json.publish_id).toBe(one.json.publish_id);
    expect(two.json.done).toBe(24);
  }, 120_000);

  it("a call marks only the images it copied and keeps the publish alive on its job row", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const tourId = await bigTour(deps, a.token, 40);
    const first = await publish(deps, a.token, tourId);
    const created = await deps.db.all<{ created_at: number }>("SELECT DISTINCT created_at FROM public_object WHERE state = 'pending'");
    // Each call within the stale period keeps the publish alive, however long it takes in all.
    for (let i = 0; i < 2; i++) {
      now += STALE_PUBLISH_MS - 1000;
      const r = await resume(deps, a.token, tourId, first.json.publish_id);
      expect(r.status).toBe(202);
    }
    expect(await deps.db.all("SELECT DISTINCT created_at FROM public_object WHERE state = 'pending'")).toEqual(created);
    expect((await deps.db.first<{ touched_at: number }>("SELECT touched_at FROM publish_job"))!.touched_at).toBe(now);
    expect(await count(deps, "public_object WHERE copied = 1")).toBe(36);
  }, 120_000);
});

describe("housekeeping on other requests", () => {
  it("listing tours or creating an upload clears an abandoned publish of the workspace, and never another workspace's", async () => {
    const ctx = await setup();
    const { deps, a, b, publicKeys } = ctx;
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const mine = (await uploadTour(deps, a.token, manyStepManifest(30))).tour_id;
    const theirs = (await uploadTour(deps, b.token, manyStepManifest(30), { kind: "new" }, 3)).tour_id;
    await publish(deps, a.token, mine);
    await publish(deps, b.token, theirs);
    expect(await publicKeys()).toHaveLength(24);
    now += STALE_PUBLISH_MS + 60_000;
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).status).toBe(200);
    expect(await count(deps, "publish_job")).toBe(1);
    expect(await publicKeys()).toHaveLength(12); // B's half-done publish is B's to clear
    expect((await send(deps, "POST", "/api/v1/uploads", { token: b.token, body: JSON.stringify({ manifest: v2, target: { kind: "new" } }), headers: { "content-type": "application/json" } })).status).toBe(201);
    expect(await publicKeys()).toEqual([]);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await count(deps, "publish_job")).toBe(0);
    await expectConsistent(ctx);
  }, 120_000);
});

describe("the snapshot size cap", () => {
  it("a tour whose snapshot would pass MAX_SNAPSHOT_BYTES is refused with 413 and writes nothing", async () => {
    const ctx = await setup();
    const { deps, a, publicKeys } = ctx;
    // Three uploads of about 190 KB of notes each: about 570 KB of snapshot.
    const heavy = (title: string) => {
      const m = manyStepManifest(17);
      m.title = title;
      for (const st of m.steps) st.notes = Array.from({ length: 20 }, (_, k) => ({ kind: "text", x: 10, y: 10, text: ("Note " + k + " ").padEnd(500, "lorem ipsum "), size: 3, color: "#ffffff" }));
      return m;
    };
    const t = await uploadTour(deps, a.token, heavy("Heavy"));
    await uploadTour(deps, a.token, heavy("Heavy 2"), { kind: "chapter", tour_id: t.tour_id }, 2);
    await uploadTour(deps, a.token, heavy("Heavy 3"), { kind: "chapter", tour_id: t.tour_id }, 3);
    expect(MAX_SNAPSHOT_BYTES).toBe(512_000);
    const r = await publish(deps, a.token, t.tour_id);
    expect(r.status).toBe(413);
    expect(r.json.error).toBe("too_large");
    expect(await publicKeys()).toEqual([]);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await count(deps, "snapshot")).toBe(0);
  });
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

describe("replaced images and the workspace sweep", () => {
  const T0 = 1_800_000_000_000;
  const MIN = 60_000;

  /** Default grace (10 minutes) and a clock the test moves. */
  async function clocked(config?: Parameters<typeof makeDeps>[0]) {
    const ctx = await makeDeps(config);
    const a = await seedWorkspace(ctx.deps, "Workspace A");
    const b = await seedWorkspace(ctx.deps, "Workspace B");
    let now = T0;
    ctx.deps.now = () => now;
    return { ...ctx, a, b, advance: (ms: number) => (now += ms) };
  }

  const status = async (deps: Deps, key: string) => (await send(deps, "GET", "/p/" + key.slice(2))).status;

  it("a replaced image stays served for the grace period, then stops and is deleted", async () => {
    const ctx = await clocked();
    const { deps, a, publicKeys, advance } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    const other = await uploadTour(deps, a.token, v2, { kind: "new" }, 3);
    await publish(deps, a.token, t.tour_id);
    const old = await liveKeys(deps, t.tour_id);
    advance(1000);
    await publish(deps, a.token, t.tour_id);
    const fresh = await liveKeys(deps, t.tour_id);
    for (const k of old) {
      expect(await status(deps, k)).toBe(200);
      expect(await publicKeys()).toContain(k);
    }
    for (const k of fresh) expect(await status(deps, k)).toBe(200);
    advance(10 * MIN - 1);
    for (const k of old) expect(await status(deps, k)).toBe(200);
    advance(2);
    for (const k of old) expect(await status(deps, k)).toBe(404); // grace over, even before deletion
    // Any later publish or unpublish in the workspace deletes them.
    await publish(deps, a.token, other.tour_id);
    for (const k of old) expect(await publicKeys()).not.toContain(k);
    for (const k of fresh) expect(await status(deps, k)).toBe(200);
    expect(await count(deps, "public_object")).toBe(0);
  });

  it("the grace period comes from the configuration", async () => {
    const { deps, a, advance } = await clocked({ retiredGraceMs: MIN });
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const old = await liveKeys(deps, t.tour_id);
    await publish(deps, a.token, t.tour_id);
    expect(await status(deps, old[0])).toBe(200);
    advance(MIN + 1);
    expect(await status(deps, old[0])).toBe(404);
  });

  it("unpublish is immediate, also for images still in their grace period", async () => {
    const { deps, a, publicKeys } = await clocked();
    const t = await uploadTour(deps, a.token, v2);
    await publish(deps, a.token, t.tour_id);
    const old = await liveKeys(deps, t.tour_id);
    await publish(deps, a.token, t.tour_id);
    const fresh = await liveKeys(deps, t.tour_id);
    expect((await unpublish(deps, a.token, t.tour_id)).status).toBe(204);
    expect(await publicKeys()).toEqual([]);
    for (const k of [...old, ...fresh]) expect(await status(deps, k)).toBe(404);
    expect(await count(deps, "public_object")).toBe(0);
  });

  it("a stale pending publish on another tour is swept by any publish or unpublish in the workspace", async () => {
    const { deps, a, publicKeys, advance } = await clocked();
    const t = await uploadTour(deps, a.token, v2);
    const other = await uploadTour(deps, a.token, v2, { kind: "new" }, 3);
    const dead = "p/" + "e".repeat(32) + ".png";
    await deps.db.run("INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at) VALUES (?, ?, 'pub_dead', 'pending', ?)", [dead, t.tour_id, T0]);
    await deps.pub.put(dead, png(1, 1, 40), { contentType: "image/png" });
    await unpublish(deps, a.token, other.tour_id);
    expect(await publicKeys()).toContain(dead); // not stale yet
    advance(STALE_PUBLISH_MS + 1);
    await unpublish(deps, a.token, other.tour_id);
    expect(await publicKeys()).not.toContain(dead);
    expect(await count(deps, "public_object")).toBe(0);
  });

  it("the sweep is bounded, oldest first, stays in its workspace and never fails its request", async () => {
    const ctx = await clocked();
    const { deps, a, b, publicKeys, advance } = ctx;
    const tours: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await uploadTour(deps, a.token, v2, { kind: "new" }, i + 1);
      tours.push(t.tour_id);
    }
    const bTour = (await uploadTour(deps, b.token, v2, { kind: "new" }, 9)).tour_id;
    // Each tour gets replaced images, one minute apart, so tours[0]'s are the oldest.
    const retired: string[][] = [];
    for (const id of [...tours, bTour]) {
      const tok = id === bTour ? b.token : a.token;
      await publish(deps, tok, id);
      const old = await liveKeys(deps, id);
      await publish(deps, tok, id);
      retired.push(old);
      advance(MIN);
    }
    advance(10 * MIN);
    const fresh = (await uploadTour(deps, a.token, v2, { kind: "new" }, 8)).tour_id;
    const left = async (i: number) => (await publicKeys()).filter((k) => retired[i].includes(k)).length;
    await publish(deps, a.token, fresh);
    // At most SWEEP_TOURS other tours per request, the oldest first.
    expect(await left(0)).toBe(0);
    expect(await left(1)).toBe(0);
    expect(await left(4)).toBe(3);
    expect(await left(5)).toBe(3); // workspace B's are never touched by A's requests
    for (let i = 0; i < 3; i++) await publish(deps, a.token, fresh);
    for (let i = 0; i < 5; i++) expect(await left(i)).toBe(0);
    expect(await left(5)).toBe(3);
    // A sweep that cannot delete never fails the request it rides on.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await publish(deps, b.token, bTour); // B's own: retires again, nothing due yet except its old ones
    advance(11 * MIN);
    const realDelete = deps.pub.delete.bind(deps.pub);
    let failures = 0;
    deps.pub.delete = async (keys) => {
      if (failures++ === 0) throw new Error("bucket unavailable");
      return realDelete(keys);
    };
    const other = (await uploadTour(deps, b.token, v2, { kind: "new" }, 7)).tour_id;
    expect((await publish(deps, b.token, other)).status).toBe(200);
    expect(failures).toBeGreaterThan(0);
    deps.pub.delete = realDelete;
    await expectConsistent(ctx as unknown as Ctx);
  });
});
