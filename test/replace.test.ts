// Replacing a chapter of an existing tour (src/replace.ts and the replace target of
// src/uploads.ts), on both targets. Every request goes through test/bundle.ts, which holds
// each one to the call budget.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { hashToken } from "../src/auth.ts";
import type { Deps } from "../src/ports.ts";
import { UPLOAD_MAX_AGE_MS } from "../src/uploads.ts";
import { abort, clone, commit, count, createUpload, fixtures, logoPng, putLogo, putStep, send, sha256Hex, stepImage, type Call, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const JSON_HEADERS = { "content-type": "application/json" };

type Ws = { workspaceId: string; token: string };

/** Two workspaces, replaced public images deleted at once, and a clock the test moves. */
async function setup(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps({ retiredGraceMs: 0, ...config });
  const a: Ws = await seedWorkspace(ctx.deps, "Workspace A");
  const b: Ws = await seedWorkspace(ctx.deps, "Workspace B");
  let now = T0;
  ctx.deps.now = () => now;
  return { ...ctx, a, b, advance: (ms: number) => (now += ms) };
}

afterEach(() => vi.restoreAllMocks());

/**
 * A manifest of small PNG steps, one per entry of `pics`. A picture is named by a number:
 * the same number gives the same bytes, another number other bytes of the same size.
 */
function manifestOf(pics: number[], title = "Chapter"): Json {
  const m = clone(v2);
  m.title = title;
  const base = m.steps[1];
  m.steps = pics.map((_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120 }));
  return m;
}

/** The bytes of picture `pic` for step `i` (from 0) of `m`. */
const picture = (m: Json, i: number, pic: number) => stepImage(m.steps[i], pic);
const hashesOf = (m: Json, pics: number[]) => Promise.all(pics.map((p, i) => sha256Hex(picture(m, i, p))));

type Target = { tour_id: string; chapter_id: string };

/** A new tour, or a new chapter of `tourId`, with these pictures; committed. */
async function uploadPics(deps: Deps, token: string, pics: number[], title = "Chapter", tourId: string | null = null): Promise<Target & { steps: number }> {
  const m = manifestOf(pics, title);
  const created = await createUpload(deps, token, m, tourId === null ? { kind: "new" } : { kind: "chapter", tour_id: tourId });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text}`);
  const id = created.json.upload_id as string;
  for (let i = 0; i < pics.length; i++) {
    const r = await putStep(deps, token, id, i + 1, picture(m, i, pics[i]));
    if (r.status !== 204) throw new Error(`step ${i + 1} failed: ${r.status} ${r.text}`);
  }
  const done = await commit(deps, token, id);
  if (done.status !== 201) throw new Error(`commit failed: ${done.status} ${done.text}`);
  return done.json;
}

/** The create request of a replace. `sha256` is left out of the body when undefined. */
function createReplace(deps: Deps, token: string | null, manifest: unknown, target: Json, sha256?: unknown): Promise<Call> {
  const body: Json = { manifest, target: { kind: "replace", ...target } };
  if (sha256 !== undefined) body.sha256 = sha256;
  return send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify(body), headers: JSON_HEADERS });
}

/** Creates a replace with one hash per step and sends the pictures the site says it lacks. Does not commit. */
async function sendReplace(deps: Deps, token: string, t: Target, pics: number[], title = "Chapter"): Promise<{ id: string; have: number[]; manifest: Json }> {
  const manifest = manifestOf(pics, title);
  const created = await createReplace(deps, token, manifest, t, await hashesOf(manifest, pics));
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text}`);
  const id = created.json.upload_id as string;
  const have = created.json.have as number[];
  for (let i = 0; i < pics.length; i++) {
    if (have.includes(i + 1)) continue;
    const r = await putStep(deps, token, id, i + 1, picture(manifest, i, pics[i]));
    if (r.status !== 204) throw new Error(`step ${i + 1} failed: ${r.status} ${r.text}`);
  }
  return { id, have, manifest };
}

/** sendReplace, then commit; returns the commit's answer. */
async function replaceChapter(deps: Deps, token: string, t: Target, pics: number[], title = "Chapter"): Promise<Call> {
  const { id } = await sendReplace(deps, token, t, pics, title);
  return commit(deps, token, id);
}

const publish = (deps: Deps, token: string, tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
const resume = (deps: Deps, token: string, tourId: string, publishId: string) =>
  send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token, body: JSON.stringify({ publish_id: publishId }), headers: JSON_HEADERS });

async function publishAll(deps: Deps, token: string, tourId: string): Promise<Call> {
  let r = await publish(deps, token, tourId);
  while (r.status === 202) r = await resume(deps, token, tourId, r.json.publish_id);
  if (r.status !== 200) throw new Error(`publish failed: ${r.status} ${r.text}`);
  return r;
}

const stepRows = (deps: Deps, chapterId: string) => deps.db.all<Json>("SELECT * FROM step WHERE chapter_id = ? ORDER BY position", [chapterId]);
const stepKeys = async (deps: Deps, chapterId: string) => (await stepRows(deps, chapterId)).map((s) => s.image_key as string);
const chapterRow = async (deps: Deps, id: string) => (await deps.db.first<Json>("SELECT * FROM chapter WHERE id = ?", [id]))!;
const tourRow = async (deps: Deps, id: string) => (await deps.db.first<Json>("SELECT * FROM tour WHERE id = ?", [id]))!;
const snapshotRow = (deps: Deps, tourId: string) => deps.db.first<Json>("SELECT * FROM snapshot WHERE tour_id = ?", [tourId]);

async function bytesOf(store: Deps["drafts"], key: string): Promise<Uint8Array | null> {
  const f = await store.get(key);
  return f === null ? null : new Uint8Array(await new Response(f.body).arrayBuffer());
}

/** What replaced_object held right after each replace commit's batch, before anything is cleaned up. */
function watchReplaced(deps: Deps): { seen: Json[][] } {
  const realBatch = deps.db.batch.bind(deps.db);
  const seen: Json[][] = [];
  deps.db.batch = async (stmts) => {
    await realBatch(stmts);
    if (stmts.some((s) => s.sql.includes("INTO replaced_object"))) {
      seen.push(await deps.db.all<Json>("SELECT tour_id, image_key, draft_version FROM replaced_object ORDER BY image_key"));
    }
  };
  return { seen };
}

describe("replace: creating the upload", { timeout: 60_000 }, () => {
  it("a replace of a chapter reports the steps whose pictures it already has", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const old = await stepRows(deps, t.chapter_id);
    // Four new steps: picture 3 (now first), picture 1, a new picture, and a step that
    // claims picture 2's hash but declares another width.
    const m = manifestOf([3, 1, 9, 2]);
    const hashes = await hashesOf(m, [3, 1, 9, 2]);
    m.steps[3].width = 65;
    const created = await createReplace(deps, a.token, m, t, hashes);
    expect(created.status).toBe(201);
    expect(created.json).toEqual({ upload_id: expect.stringMatching(/^up_[0-9a-f]{24}$/), steps: 4, have: [1, 2], settings: false });
    const id = created.json.upload_id as string;
    expect(await deps.db.first<Json>("SELECT tour_id, replaces_chapter_id, base_revision FROM upload WHERE id = ?", [id])).toEqual({
      tour_id: t.tour_id, replaces_chapter_id: t.chapter_id, base_revision: null,
    });
    // A step the chapter already has is recorded as stored, under the picture's existing key.
    const rows = await deps.db.all<Json>("SELECT n, image_key, bytes, sha256, reused, stored_at FROM upload_step WHERE upload_id = ? ORDER BY n", [id]);
    expect(rows).toEqual([
      { n: 1, image_key: old[2].image_key, bytes: 120, sha256: hashes[0], reused: 1, stored_at: T0 },
      { n: 2, image_key: old[0].image_key, bytes: 120, sha256: hashes[1], reused: 1, stored_at: T0 },
    ]);
  });

  it("a replace without a hash list has every picture to send", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const created = await createReplace(deps, a.token, manifestOf([1, 2, 3]), t);
    expect(created.status).toBe(201);
    expect(created.json).toEqual({ upload_id: expect.any(String), steps: 3, have: [], settings: false });
    expect(await count(deps, "upload_step")).toBe(0);
  });

  it("a tour uploaded before hashes existed has nothing to reuse", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    await deps.db.run("UPDATE step SET sha256 = NULL");
    const m = manifestOf([1, 2, 3]);
    const created = await createReplace(deps, a.token, m, t, await hashesOf(m, [1, 2, 3]));
    expect(created.status).toBe(201);
    expect(created.json.have).toEqual([]);
    expect(await count(deps, "upload_step")).toBe(0);
  });

  it("another workspace's tour, an unknown chapter and a chapter of another tour answer 404 and create nothing", async () => {
    const { deps, a, b } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2]);
    const other = await uploadPics(deps, a.token, [3, 4]);
    const m = manifestOf([1, 2]);
    const hashes = await hashesOf(m, [1, 2]);
    const noTour = [
      await createReplace(deps, b.token, m, t, hashes), // another workspace's
      await createReplace(deps, a.token, m, { tour_id: "tour_" + "0".repeat(24), chapter_id: t.chapter_id }, hashes),
      await createReplace(deps, a.token, m, { tour_id: "tour_1", chapter_id: t.chapter_id }, hashes),
      await createReplace(deps, a.token, m, { tour_id: 7, chapter_id: t.chapter_id }, hashes),
      await createReplace(deps, a.token, m, { chapter_id: t.chapter_id }, hashes),
    ];
    for (const r of noTour) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: "not_found", detail: "no such tour" });
    }
    const noChapter = [
      await createReplace(deps, a.token, m, { tour_id: t.tour_id, chapter_id: "ch_" + "0".repeat(24) }, hashes),
      await createReplace(deps, a.token, m, { tour_id: t.tour_id, chapter_id: other.chapter_id }, hashes), // a chapter of another tour
      await createReplace(deps, a.token, m, { tour_id: t.tour_id, chapter_id: "ch_1" }, hashes),
      await createReplace(deps, a.token, m, { tour_id: t.tour_id, chapter_id: null }, hashes),
      await createReplace(deps, a.token, m, { tour_id: t.tour_id }, hashes),
    ];
    for (const r of noChapter) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: "not_found", detail: "no such chapter" });
    }
    expect(await count(deps, "upload")).toBe(0);
    expect(await count(deps, "upload_step")).toBe(0);
  });

  it("a hash list of the wrong length or form is refused and creates nothing", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2]);
    const m = manifestOf([1, 2]);
    const [h1, h2] = await hashesOf(m, [1, 2]);
    const bad: unknown[] = [
      [h1], // one too few
      [h1, h2, h1], // one too many
      [],
      [h1, h2.toUpperCase()],
      [h1, h2.slice(1)],
      [h1, h2 + "0"],
      [h1, "g".repeat(64)],
      [h1, 5],
      [h1, null],
      h1 + h2,
      { 0: h1, 1: h2 },
      null,
    ];
    for (const list of bad) {
      const r = await createReplace(deps, a.token, m, t, list);
      expect(r.status, JSON.stringify(list)).toBe(400);
      expect(r.json.error).toBe("bad_request");
      // The answer never repeats what was sent.
      expect(r.text).not.toContain(h1);
    }
    expect(await count(deps, "upload")).toBe(0);
    // A bad manifest is still named first, exactly as for any other upload.
    const noManifest = await createReplace(deps, a.token, { version: 9 }, t, [h1]);
    expect(noManifest.status).toBe(400);
    expect(noManifest.json.error).toBe("bad_manifest");
  });

  it("a hash list with a new tour or a new chapter is refused", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2]);
    const m = manifestOf([1, 2]);
    const sha256 = await hashesOf(m, [1, 2]);
    for (const target of [{ kind: "new" }, { kind: "chapter", tour_id: t.tour_id }]) {
      const r = await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ manifest: m, target, sha256 }), headers: JSON_HEADERS });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("bad_request");
    }
    expect(await count(deps, "upload")).toBe(0);
    // Without the list both still work, and answer as they always did.
    const plain = await createUpload(deps, a.token, m, { kind: "chapter", tour_id: t.tour_id });
    expect(plain.status).toBe(201);
    expect(plain.json).toEqual({ upload_id: expect.any(String), steps: 2 });
    // An unknown kind is still a bad target.
    const unknown = await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ manifest: m, target: { kind: "swap" } }), headers: JSON_HEADERS });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe("bad_target");
  });

  it("the create body may be the largest manifest plus a full hash list, and no larger", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1]);
    const m = manifestOf(Array.from({ length: 200 }, (_, i) => i));
    const sha256 = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(64, "0"));
    const body = (pad: number) => JSON.stringify({ manifest: m, target: { kind: "replace", ...t }, sha256, pad: "x".repeat(pad) });
    const room = 262_144 + 4096 + 14_000 - body(0).length;
    expect((await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: body(room), headers: JSON_HEADERS })).status).toBe(201);
    const over = await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: body(room + 1), headers: JSON_HEADERS });
    expect(over.status).toBe(413);
    expect(over.json.error).toBe("too_large");
  });
});

describe("replace: commit", { timeout: 60_000 }, () => {
  it("a replaced chapter keeps its id, position and title and has exactly the new steps in order", async () => {
    const { deps, a, advance } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3], "Customer onboarding");
    const tourBefore = await tourRow(deps, t.tour_id);
    const chapterBefore = await chapterRow(deps, t.chapter_id);
    const oldIds = (await stepRows(deps, t.chapter_id)).map((s) => s.id);
    advance(HOUR);
    const { id, manifest } = await sendReplace(deps, a.token, t, [4, 5], "Renamed in the app");
    const done = await commit(deps, a.token, id);
    expect(done.status).toBe(201);
    expect(done.json).toEqual({ tour_id: t.tour_id, chapter_id: t.chapter_id, steps: 2, publish: "draft" });

    const chapter = await chapterRow(deps, t.chapter_id);
    expect(chapter).toEqual({ ...chapterBefore, revision: id, replaced_version: 2 });
    expect(chapter.title).toBe("Customer onboarding");
    expect(chapter.position).toBe(0);
    const steps = await stepRows(deps, t.chapter_id);
    expect(steps.map((s) => s.position)).toEqual([0, 1]);
    for (const s of steps) {
      expect(s.id).toMatch(/^st_[0-9a-f]{24}$/);
      expect(oldIds).not.toContain(s.id);
      expect(s.tour_id).toBe(t.tour_id);
    }
    expect(steps.map((s) => s.image_key)).toEqual([`u/${id}/step-001.png`, `u/${id}/step-002.png`]);
    expect(steps.map((s) => s.sha256)).toEqual(await hashesOf(manifest, [4, 5]));
    expect(steps.map((s) => [s.image_type, s.width, s.height, s.bytes])).toEqual([["png", 64, 64, 120], ["png", 64, 64, 120]]);
    expect(JSON.parse(steps[0].notes)).toEqual(manifest.steps[0].notes);
    expect(steps[0].click_x).toBe(manifest.steps[0].click.x);
    expect(await bytesOf(deps.drafts, steps[1].image_key)).toEqual(picture(manifest, 1, 5));
    // The tour keeps its title, link and status; only its draft moved on.
    expect(await tourRow(deps, t.tour_id)).toEqual({ ...tourBefore, updated_at: T0 + HOUR, draft_version: 2 });
    expect(await count(deps, "chapter")).toBe(1);
    expect(await count(deps, "step")).toBe(2);
    expect(await count(deps, "upload")).toBe(0);
    expect(await count(deps, "upload_step")).toBe(0);
    expect(await count(deps, "snapshot")).toBe(0);
  });

  it("the other chapters of the tour are untouched", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2], "First");
    const second = await uploadPics(deps, a.token, [3, 4, 5], "Second", t.tour_id);
    const third = await uploadPics(deps, a.token, [6], "Third", t.tour_id);
    const elsewhere = await uploadPics(deps, a.token, [3, 4, 5], "Another tour");
    const others = async () => ({
      chapters: await deps.db.all<Json>("SELECT * FROM chapter WHERE id <> ? ORDER BY id", [second.chapter_id]),
      steps: await deps.db.all<Json>("SELECT * FROM step WHERE chapter_id <> ? ORDER BY id", [second.chapter_id]),
      tour: await tourRow(deps, elsewhere.tour_id),
    });
    const before = await others();
    const done = await replaceChapter(deps, a.token, { tour_id: t.tour_id, chapter_id: second.chapter_id }, [5, 7]);
    expect(done.status).toBe(201);
    expect(done.json).toMatchObject({ chapter_id: second.chapter_id, steps: 2 });
    expect(await others()).toEqual(before);
    expect((await chapterRow(deps, second.chapter_id)).position).toBe(1);
    expect((await deps.db.all<Json>("SELECT id FROM chapter WHERE tour_id = ? ORDER BY position", [t.tour_id])).map((c) => c.id)).toEqual([
      t.chapter_id, second.chapter_id, third.chapter_id,
    ]);
    for (const k of before.steps.map((s) => s.image_key as string)) expect(await bytesOf(deps.drafts, k)).not.toBeNull();
  });

  it("a step reported as had cannot be sent again, and the new step points at the same stored picture", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const old = await stepRows(deps, t.chapter_id);
    const m = manifestOf([2, 7, 1]);
    const created = await createReplace(deps, a.token, m, t, await hashesOf(m, [2, 7, 1]));
    expect(created.json.have).toEqual([1, 3]);
    const id = created.json.upload_id as string;
    const again = await putStep(deps, a.token, id, 1, picture(m, 0, 2));
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("already_sent");
    expect((await putStep(deps, a.token, id, 3, picture(m, 2, 8))).status).toBe(409);
    expect((await putStep(deps, a.token, id, 2, picture(m, 1, 7))).status).toBe(204);
    const done = await commit(deps, a.token, id);
    expect(done.status).toBe(201);
    const steps = await stepRows(deps, t.chapter_id);
    expect(steps.map((s) => s.image_key)).toEqual([old[1].image_key, `u/${id}/step-002.png`, old[0].image_key]);
    expect(steps.map((s) => s.sha256)).toEqual(await hashesOf(m, [2, 7, 1]));
    // The draft image of each new step is the picture the client meant.
    for (const [i, pic] of [2, 7, 1].entries()) {
      const img = await send(deps, "GET", `/api/v1/tours/${t.tour_id}/steps/${steps[i].id}/image`, { token: a.token });
      expect(img.status).toBe(200);
      expect(img.bytes).toEqual(picture(m, i, pic));
    }
    // Nothing was stored for the steps the chapter already had.
    expect(await bytesOf(deps.drafts, `u/${id}/step-001.png`)).toBeNull();
    expect(await bytesOf(deps.drafts, `u/${id}/step-003.png`)).toBeNull();
  });

  it("the same picture at two new steps points both at the one stored picture", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2]);
    const old = await stepKeys(deps, t.chapter_id);
    const { id, have } = await sendReplace(deps, a.token, t, [2, 2, 2]);
    expect(have).toEqual([1, 2, 3]);
    expect((await commit(deps, a.token, id)).status).toBe(201);
    expect(await stepKeys(deps, t.chapter_id)).toEqual([old[1], old[1], old[1]]);
  });

  it("commit with a changed step not sent is 409 incomplete and changes nothing", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const before = { steps: await stepRows(deps, t.chapter_id), chapter: await chapterRow(deps, t.chapter_id), tour: await tourRow(deps, t.tour_id) };
    const m = manifestOf([1, 9, 3]);
    const created = await createReplace(deps, a.token, m, t, await hashesOf(m, [1, 9, 3]));
    expect(created.json.have).toEqual([1, 3]);
    const id = created.json.upload_id as string;
    const r = await commit(deps, a.token, id);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("incomplete");
    expect(r.json.detail).toContain("step 2");
    expect({ steps: await stepRows(deps, t.chapter_id), chapter: await chapterRow(deps, t.chapter_id), tour: await tourRow(deps, t.tour_id) }).toEqual(before);
    expect(await count(deps, "upload")).toBe(1);
    expect(await count(deps, "replaced_object")).toBe(0);
    // The upload can still be finished.
    expect((await putStep(deps, a.token, id, 2, picture(m, 1, 9))).status).toBe(204);
    expect((await commit(deps, a.token, id)).status).toBe(201);
  });

  it("a logo is refused, as for any upload into an existing tour", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1]);
    const m = clone(fixtures.v3 as Json);
    m.steps = [{ ...m.steps[0], image: "step-001.png", width: 64, height: 64, bytes: 120 }];
    expect(m.cover.logo).toBeTruthy();
    const created = await createReplace(deps, a.token, m, t);
    expect(created.status).toBe(201);
    const logo = await putLogo(deps, a.token, created.json.upload_id, logoPng());
    expect(logo.status).toBe(409);
    expect(logo.json.error).toBe("logo_not_used");
  });

  it("the pictures no step uses any more are recorded for removal and the reused ones are not", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3, 3]);
    const other = await uploadPics(deps, a.token, [1, 2], "Second", t.tour_id);
    const old = await stepKeys(deps, t.chapter_id);
    const watch = watchReplaced(deps);
    // Picture 2 stays, the rest go: three keys, the two of picture 3 included.
    const first = await sendReplace(deps, a.token, t, [2, 8]);
    expect(first.have).toEqual([1]);
    expect((await commit(deps, a.token, first.id)).status).toBe(201);
    expect(watch.seen).toHaveLength(1);
    expect(watch.seen[0]).toEqual([old[0], old[2], old[3]].sort().map((image_key) => ({ tour_id: t.tour_id, image_key, draft_version: 3 })));
    const newKey = `u/${first.id}/step-002.png`;
    // Both new steps use picture 2's key: only the other key is recorded, and it once.
    const second = await sendReplace(deps, a.token, t, [2, 2]);
    expect((await commit(deps, a.token, second.id)).status).toBe(201);
    expect(watch.seen[1].filter((r) => r.draft_version === 4)).toEqual([{ tour_id: t.tour_id, image_key: newKey, draft_version: 4 }]);
    // Two steps on one key leave one row when they go.
    const third = await sendReplace(deps, a.token, t, [5]);
    expect((await commit(deps, a.token, third.id)).status).toBe(201);
    expect(watch.seen[2].filter((r) => r.draft_version === 5)).toEqual([{ tour_id: t.tour_id, image_key: old[1], draft_version: 5 }]);
    // No key of the tour's other chapter was ever recorded, though it holds the same pictures.
    const otherKeys = await stepKeys(deps, other.chapter_id);
    for (const rows of watch.seen) for (const r of rows) expect(otherKeys).not.toContain(r.image_key);
    for (const k of otherKeys) expect(await bytesOf(deps.drafts, k)).not.toBeNull();
  });
});

describe("replace: what is public", { timeout: 60_000 }, () => {
  it("replacing a chapter of a public tour leaves the public page and its images exactly as they were", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const live = await publishAll(deps, a.token, t.tour_id);
    const before = {
      snapshot: await snapshotRow(deps, t.tour_id),
      objects: await deps.db.all<Json>("SELECT * FROM snapshot_object ORDER BY image_key"),
      keys: await ctx.publicKeys(),
      page: (await send(deps, "GET", live.json.url)).text,
    };
    const images = new Map<string, Uint8Array | null>();
    for (const k of before.keys) images.set(k, await bytesOf(deps.pub, k));
    const done = await replaceChapter(deps, a.token, t, [7, 8]);
    expect(done.status).toBe(201);
    expect(await snapshotRow(deps, t.tour_id)).toEqual(before.snapshot);
    expect(await deps.db.all<Json>("SELECT * FROM snapshot_object ORDER BY image_key")).toEqual(before.objects);
    expect(await ctx.publicKeys()).toEqual(before.keys);
    expect(await count(deps, "public_object")).toBe(0);
    expect(await count(deps, "publish_job")).toBe(0);
    const page = await send(deps, "GET", live.json.url);
    expect(page.status).toBe(200);
    expect(page.text).toBe(before.page);
    for (const k of before.keys) {
      const img = await send(deps, "GET", "/" + k);
      expect(img.status).toBe(200);
      expect(img.bytes).toEqual(images.get(k));
    }
    expect((await tourRow(deps, t.tour_id)).status).toBe("published");
    // Publishing again is what shows the new chapter.
    expect((await publishAll(deps, a.token, t.tour_id)).json.steps).toBe(2);
  });

  it("a draft tour stays a draft and the answer says draft", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2]);
    const done = await replaceChapter(deps, a.token, t, [3]);
    expect(done.json.publish).toBe("draft");
    expect((await tourRow(deps, t.tour_id)).status).toBe("draft");
    expect(await count(deps, "snapshot")).toBe(0);
    // Also for a tour that was public once and was unpublished.
    await publishAll(deps, a.token, t.tour_id);
    expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/unpublish`, { token: a.token })).status).toBe(204);
    expect((await replaceChapter(deps, a.token, t, [4])).json.publish).toBe("draft");
  });

  it("a public tour with nothing else unpublished answers ready", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2]);
    await uploadPics(deps, a.token, [3], "Second", t.tour_id);
    await publishAll(deps, a.token, t.tour_id);
    const first = await sendReplace(deps, a.token, t, [5]);
    const done = await commit(deps, a.token, first.id);
    expect(done.json).toEqual({ tour_id: t.tour_id, chapter_id: t.chapter_id, steps: 1, publish: "ready" });
    // Asked again once the publish went through, it is still safe to publish.
    await publishAll(deps, a.token, t.tour_id);
    expect((await commit(deps, a.token, first.id)).json.publish).toBe("ready");
    // And so is the next update of the tour that is now wholly public.
    expect((await replaceChapter(deps, a.token, t, [6])).json.publish).toBe("ready");
  });

  it("a public tour with another chapter that was never published answers other_changes", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2]);
    await publishAll(deps, a.token, t.tour_id);
    const extra = await uploadPics(deps, a.token, [3], "Not public yet", t.tour_id);
    const done = await replaceChapter(deps, a.token, t, [5]);
    expect(done.status).toBe(201);
    expect(done.json).toEqual({ tour_id: t.tour_id, chapter_id: t.chapter_id, steps: 1, publish: "other_changes" });
    // The same when the unpublished change arrives after the replace.
    await publishAll(deps, a.token, t.tour_id);
    const again = await sendReplace(deps, a.token, t, [6]);
    expect((await commit(deps, a.token, again.id)).json.publish).toBe("ready");
    await uploadPics(deps, a.token, [4], "Later", t.tour_id);
    expect((await commit(deps, a.token, again.id)).json.publish).toBe("other_changes");
    expect((await chapterRow(deps, extra.chapter_id)).revision).toBeNull();
  });

  it("a tour published before draft versions were recorded answers other_changes", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2]);
    await publishAll(deps, a.token, t.tour_id);
    await deps.db.run("UPDATE snapshot SET draft_version = NULL WHERE tour_id = ?", [t.tour_id]);
    expect((await replaceChapter(deps, a.token, t, [5])).json.publish).toBe("other_changes");
    // Once it is published again the version is known.
    await publishAll(deps, a.token, t.tour_id);
    expect((await replaceChapter(deps, a.token, t, [6])).json.publish).toBe("ready");
  });
});

describe("replace: retries and races", { timeout: 60_000 }, () => {
  it("a repeated commit answers the same and writes nothing more", async () => {
    const { deps, a, b } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const { id } = await sendReplace(deps, a.token, t, [3, 4]);
    const first = await commit(deps, a.token, id);
    expect(first.status).toBe(201);
    const state = async () => ({
      steps: await stepRows(deps, t.chapter_id),
      chapter: await chapterRow(deps, t.chapter_id),
      tour: await tourRow(deps, t.tour_id),
      uploads: await count(deps, "upload"),
    });
    const after = await state();
    const again = await commit(deps, a.token, id);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
    expect(await state()).toEqual(after);
    // Another workspace learns nothing from it.
    expect((await commit(deps, b.token, id)).status).toBe(404);
  });

  it("two commits of one replace at the same moment replace the chapter once", async () => {
    const { deps, a } = await setup();
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const { id } = await sendReplace(deps, a.token, t, [3, 4]);
    const [r1, r2] = await Promise.all([commit(deps, a.token, id), commit(deps, a.token, id)]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.json).toEqual(r2.json);
    expect(await count(deps, "step")).toBe(2);
    expect((await tourRow(deps, t.tour_id)).draft_version).toBe(2);
  });

  it("two replaces of one chapter: the second to commit is refused with chapter_changed and the chapter is whole", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    // Both start from the same chapter; the second reuses a picture the first one drops.
    const one = await sendReplace(deps, a.token, t, [4, 5]);
    const two = await sendReplace(deps, a.token, t, [1, 6]);
    expect(two.have).toEqual([1]);
    expect((await commit(deps, a.token, one.id)).status).toBe(201);
    const whole = { steps: await stepRows(deps, t.chapter_id), chapter: await chapterRow(deps, t.chapter_id), tour: await tourRow(deps, t.tour_id) };
    const late = await commit(deps, a.token, two.id);
    expect(late.status).toBe(409);
    expect(late.json).toEqual({ error: "chapter_changed", detail: "the chapter was changed by another upload since this one started; start again" });
    expect((await commit(deps, a.token, two.id)).status).toBe(409); // however often it asks
    expect({ steps: await stepRows(deps, t.chapter_id), chapter: await chapterRow(deps, t.chapter_id), tour: await tourRow(deps, t.tour_id) }).toEqual(whole);
    expect(whole.steps.map((s) => s.image_key)).toEqual([`u/${one.id}/step-001.png`, `u/${one.id}/step-002.png`]);
    // The refused upload is still its client's to cancel, which removes its own picture only.
    expect(await count(deps, "upload")).toBe(1);
    expect((await abort(deps, a.token, two.id)).status).toBe(204);
    expect(await count(deps, "upload")).toBe(0);
    const keys = await ctx.draftKeys();
    expect(keys).not.toContain(`u/${two.id}/step-002.png`);
    for (const s of whole.steps) expect(keys).toContain(s.image_key);
    // Starting again from the chapter as it is now goes through.
    expect((await replaceChapter(deps, a.token, t, [1, 6])).status).toBe(201);
  });

  it("an aborted replace deletes its own pictures and none the chapter still uses", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const before = { keys: await ctx.draftKeys(), steps: await stepRows(deps, t.chapter_id), chapter: await chapterRow(deps, t.chapter_id) };
    const { id, have } = await sendReplace(deps, a.token, t, [1, 9, 3, 8]);
    expect(have).toEqual([1, 3]);
    expect(await ctx.draftKeys()).toHaveLength(5);
    expect((await abort(deps, a.token, id)).status).toBe(204);
    expect(await ctx.draftKeys()).toEqual(before.keys);
    expect({ keys: await ctx.draftKeys(), steps: await stepRows(deps, t.chapter_id), chapter: await chapterRow(deps, t.chapter_id) }).toEqual(before);
    expect(await count(deps, "upload")).toBe(0);
    expect(await count(deps, "upload_step")).toBe(0);
    expect((await commit(deps, a.token, id)).status).toBe(404);
    for (const s of before.steps) expect((await send(deps, "GET", `/api/v1/tours/${t.tour_id}/steps/${s.id}/image`, { token: a.token })).status).toBe(200);
  });

  it("an abort that arrives after the replace was committed changes nothing", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const { id, have } = await sendReplace(deps, a.token, t, [3, 9]);
    expect(have).toEqual([1]);
    const done = await commit(deps, a.token, id);
    expect(done.status).toBe(201);
    const state = async () => ({
      steps: await stepRows(deps, t.chapter_id),
      chapter: await chapterRow(deps, t.chapter_id),
      tour: await tourRow(deps, t.tour_id),
    });
    const after = await state();
    // The client's cancel, sent late (twice), finds no upload and deletes no picture.
    expect((await abort(deps, a.token, id)).status).toBe(204);
    expect((await abort(deps, a.token, id)).status).toBe(204);
    expect(await state()).toEqual(after);
    for (const s of after.steps) expect(await bytesOf(deps.drafts, s.image_key)).not.toBeNull();
    for (const s of after.steps) expect((await send(deps, "GET", `/api/v1/tours/${t.tour_id}/steps/${s.id}/image`, { token: a.token })).status).toBe(200);
    // And the commit still answers the same.
    expect((await commit(deps, a.token, id)).json).toEqual(done.json);
  });

  it("a client that sends no hash list gets the answers it always got for a new tour and a new chapter", async () => {
    const { deps, a } = await setup();
    const m = manifestOf([1, 2]);
    const made = await createUpload(deps, a.token, m, { kind: "new" });
    expect(made.status).toBe(201);
    expect(made.json).toEqual({ upload_id: expect.stringMatching(/^up_[0-9a-f]{24}$/), steps: 2 });
    for (let i = 0; i < 2; i++) expect((await putStep(deps, a.token, made.json.upload_id, i + 1, picture(m, i, i + 1))).status).toBe(204);
    const tour = await commit(deps, a.token, made.json.upload_id);
    expect(tour.status).toBe(201);
    expect(tour.json).toEqual({ tour_id: expect.stringMatching(/^tour_[0-9a-f]{24}$/), chapter_id: "ch_" + made.json.upload_id.slice(3), steps: 2 });
    const more = await createUpload(deps, a.token, m, { kind: "chapter", tour_id: tour.json.tour_id });
    expect(more.status).toBe(201);
    expect(more.json).toEqual({ upload_id: expect.stringMatching(/^up_[0-9a-f]{24}$/), steps: 2 });
    for (let i = 0; i < 2; i++) expect((await putStep(deps, a.token, more.json.upload_id, i + 1, picture(m, i, i + 1))).status).toBe(204);
    const chapter = await commit(deps, a.token, more.json.upload_id);
    expect(chapter.status).toBe(201);
    expect(chapter.json).toEqual({ tour_id: tour.json.tour_id, chapter_id: "ch_" + more.json.upload_id.slice(3), steps: 2 });
    // Neither is a replace: nothing is reused, recorded for removal or marked on the chapter.
    expect(await count(deps, "replaced_object")).toBe(0);
    expect(await deps.db.all<Json>("SELECT revision, replaced_version FROM chapter")).toEqual([
      { revision: null, replaced_version: null },
      { revision: null, replaced_version: null },
    ]);
  });

  it("a replace aborted while its commit is on the way answers 404 and leaves the chapter as it was", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const before = { keys: await ctx.draftKeys(), steps: await stepRows(deps, t.chapter_id), chapter: await chapterRow(deps, t.chapter_id), tour: await tourRow(deps, t.tour_id) };
    const { id } = await sendReplace(deps, a.token, t, [1, 9]);
    const realBatch = deps.db.batch.bind(deps.db);
    // The abort lands between the commit's checks and its batch.
    deps.db.batch = async (stmts) => {
      deps.db.batch = realBatch;
      await abort(deps, a.token, id);
      return realBatch(stmts);
    };
    const r = await commit(deps, a.token, id);
    expect(r.status).toBe(404);
    expect({ keys: await ctx.draftKeys(), steps: await stepRows(deps, t.chapter_id), chapter: await chapterRow(deps, t.chapter_id), tour: await tourRow(deps, t.tour_id) }).toEqual(before);
    expect(await count(deps, "replaced_object")).toBe(0);
  });

  it("a replace left open for 24 hours is swept without touching the chapter's pictures", async () => {
    const ctx = await setup();
    const { deps, a, advance } = ctx;
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const before = { keys: await ctx.draftKeys(), steps: await stepRows(deps, t.chapter_id) };
    const { id, have } = await sendReplace(deps, a.token, t, [3, 9, 1]);
    expect(have).toEqual([1, 3]);
    advance(UPLOAD_MAX_AGE_MS + HOUR);
    // The next create of the workspace sweeps it.
    const next = await createUpload(deps, a.token, manifestOf([4]));
    expect(next.status).toBe(201);
    expect((await deps.db.all<Json>("SELECT id FROM upload")).map((u) => u.id)).toEqual([next.json.upload_id]);
    expect(await count(deps, "upload_step")).toBe(0);
    expect(await ctx.draftKeys()).toEqual(before.keys);
    expect(await stepRows(deps, t.chapter_id)).toEqual(before.steps);
    expect((await commit(deps, a.token, id)).status).toBe(404);
  });

  it("a failed commit batch leaves the chapter as it was", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const { id } = await sendReplace(deps, a.token, t, [2, 9]);
    const state = async () => ({
      keys: await ctx.draftKeys(),
      steps: await stepRows(deps, t.chapter_id),
      chapter: await chapterRow(deps, t.chapter_id),
      tour: await tourRow(deps, t.tour_id),
      upload: await count(deps, "upload"),
      sent: await count(deps, "upload_step"),
      replaced: await count(deps, "replaced_object"),
    });
    const before = await state();
    const realBatch = deps.db.batch.bind(deps.db);
    // A last statement that the schema refuses makes the whole commit roll back.
    deps.db.batch = (stmts) => realBatch([...stmts, { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (2, ?, 0)", params: [a.workspaceId] }]);
    const r = await commit(deps, a.token, id);
    deps.db.batch = realBatch;
    expect(r.status).toBe(500);
    expect(await state()).toEqual(before);
    // The same upload then commits.
    const done = await commit(deps, a.token, id);
    expect(done.status).toBe(201);
    expect(done.json.steps).toBe(2);
  });

  it("a slow writer that finishes after the replace was committed does not delete the picture the chapter uses", async () => {
    const ctx = await setup();
    const { deps, a, advance } = ctx;
    const t = await uploadPics(deps, a.token, [1, 2]);
    const m = manifestOf([7]);
    const id = (await createReplace(deps, a.token, m, t)).json.upload_id as string;
    const realPut = deps.drafts.put.bind(deps.drafts);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let puts = 0;
    deps.drafts.put = async (key, body, meta) => {
      if (puts++ === 0) await gate; // the first writer stalls while writing its object
      return realPut(key, body, meta);
    };
    const slow = putStep(deps, a.token, id, 1, picture(m, 0, 7));
    for (let i = 0; i < 200 && (await count(deps, "upload_step")) === 0; i++) await new Promise((r) => setTimeout(r, 5));
    advance(61_000);
    expect((await putStep(deps, a.token, id, 1, picture(m, 0, 8))).status).toBe(204);
    expect((await commit(deps, a.token, id)).status).toBe(201);
    release();
    expect((await slow).status).toBe(409);
    const [step] = await stepRows(deps, t.chapter_id);
    expect(step.image_key).toBe(`u/${id}/step-001.png`);
    expect(await bytesOf(deps.drafts, step.image_key)).not.toBeNull();
    // Which of the two sends the store kept is not known, so the picture is not offered for reuse.
    expect(step.sha256).toBeNull();
  });
});

describe("replace: scope and secrets", { timeout: 60_000 }, () => {
  it("workspace B's token cannot send to, commit or cancel A's replace", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const t = await uploadPics(deps, a.token, [1, 2]);
    const m = manifestOf([1, 9]);
    const created = await createReplace(deps, a.token, m, t, await hashesOf(m, [1, 9]));
    const id = created.json.upload_id as string;
    const before = { keys: await ctx.draftKeys(), sent: await deps.db.all<Json>("SELECT * FROM upload_step ORDER BY n") };
    expect((await putStep(deps, b.token, id, 2, picture(m, 1, 9))).status).toBe(404);
    expect((await commit(deps, b.token, id)).status).toBe(404);
    expect((await abort(deps, b.token, id)).status).toBe(204);
    expect({ keys: await ctx.draftKeys(), sent: await deps.db.all<Json>("SELECT * FROM upload_step ORDER BY n") }).toEqual(before);
    expect(await count(deps, "upload")).toBe(1);
    expect((await putStep(deps, a.token, id, 2, picture(m, 1, 9))).status).toBe(204);
    expect((await commit(deps, a.token, id)).status).toBe(201);
  });

  it("no token answers 401 and no response or log line holds the token", async () => {
    const { deps, a } = await setup();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const hash = await hashToken(a.token);
    const t = await uploadPics(deps, a.token, [1, 2, 3]);
    const m = manifestOf([1, 9]);
    const sha256 = await hashesOf(m, [1, 9]);
    const none = await createReplace(deps, null, m, t, sha256);
    expect(none.status).toBe(401);
    expect(none.text).toBe('{"error":"unauthorized"}');
    expect(await count(deps, "upload")).toBe(0);

    const bodies: string[] = [];
    const record = (r: Call) => {
      bodies.push(r.text);
      r.headers.forEach((v) => bodies.push(v));
      return r;
    };
    record(none);
    for (const token of [a.token, "dp_" + "e".repeat(40)]) {
      const created = record(await createReplace(deps, token, m, t, sha256));
      const id = created.json?.upload_id ?? "up_" + "0".repeat(24);
      record(await createReplace(deps, token, m, t, [a.token])); // 400
      record(await createReplace(deps, token, m, { tour_id: t.tour_id, chapter_id: "ch_" + "0".repeat(24) }, sha256)); // 404
      record(await putStep(deps, token, id, 1, picture(m, 0, 1))); // 409: the chapter has it
      record(await commit(deps, token, id)); // 409 incomplete
      record(await putStep(deps, token, id, 2, picture(m, 1, 9)));
      const other = record(await createReplace(deps, token, m, t, sha256));
      record(await commit(deps, token, id));
      record(await commit(deps, token, id));
      if (other.status === 201) {
        record(await putStep(deps, token, other.json.upload_id, 2, picture(m, 1, 9)));
        record(await commit(deps, token, other.json.upload_id)); // 409 chapter_changed
        record(await abort(deps, token, other.json.upload_id));
      }
      record(await send(deps, "GET", "/api/v1/tours", { token }));
    }
    // A failure inside the commit answers the generic error.
    const { id } = await sendReplace(deps, a.token, t, [5]);
    const realBatch = deps.db.batch.bind(deps.db);
    deps.db.batch = async () => {
      throw new Error("failed for " + a.token);
    };
    const failed = record(await commit(deps, a.token, id));
    deps.db.batch = realBatch;
    expect(failed.status).toBe(500);
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" ")));
    for (const text of [...bodies, ...logged]) {
      expect(text).not.toContain(a.token);
      expect(text).not.toContain(a.token.slice(3));
      expect(text).not.toContain(hash);
    }
  });
});
