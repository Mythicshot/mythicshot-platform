import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { hashToken } from "../src/auth.ts";
import type { Deps } from "../src/ports.ts";
import {
  abort,
  clone,
  commit,
  count,
  counts,
  createUpload,
  endlessBody,
  fixtures,
  jpeg,
  logoPng,
  png,
  putLogo,
  putStep,
  send,
  sendAll,
  sha256Hex,
  stepImage,
  uploadTour,
  type Json,
} from "./bundle.ts";

// Lets a test force the slugs a commit draws, to collide with an existing tour's slug.
const slugQueue = vi.hoisted(() => [] as string[]);
vi.mock("../src/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/auth.ts")>();
  return { ...real, newSlug: () => slugQueue.shift() ?? real.newSlug() };
});

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_KEY = /^u\/up_[0-9a-f]{24}\/(step-\d{3}\.(png|jpg)|logo\.(png|jpg))$/;

type Ctx = Awaited<ReturnType<typeof makeDeps>> & { a: { workspaceId: string; token: string }; b: { workspaceId: string; token: string } };

async function setup(): Promise<Ctx> {
  const ctx = await makeDeps();
  const a = await seedWorkspace(ctx.deps, "Workspace A");
  const b = await seedWorkspace(ctx.deps, "Workspace B");
  return { ...ctx, a, b };
}

async function tourRow(deps: Deps, id: string): Promise<Json> {
  return (await deps.db.first<Json>("SELECT * FROM tour WHERE id = ?", [id]))!;
}

async function stepRows(deps: Deps, chapterId: string): Promise<Json[]> {
  return deps.db.all<Json>("SELECT * FROM step WHERE chapter_id = ? ORDER BY position", [chapterId]);
}

beforeEach(() => {
  slugQueue.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a complete upload", () => {
  it("a new-tour upload ends as one draft tour, one chapter and N steps", async () => {
    const { deps, a, draftKeys } = await setup();
    const created = await createUpload(deps, a.token, v2);
    expect(created.status).toBe(201);
    expect(created.json.upload_id).toMatch(/^up_[0-9a-f]{24}$/);
    expect(created.json.steps).toBe(3);
    const id = created.json.upload_id;
    for (let i = 0; i < 3; i++) expect((await putStep(deps, a.token, id, i + 1, stepImage(v2.steps[i]))).status).toBe(204);
    const done = await commit(deps, a.token, id);
    expect(done.status).toBe(201);
    expect(done.json).toEqual({ tour_id: expect.stringMatching(/^tour_[0-9a-f]{24}$/), chapter_id: expect.stringMatching(/^ch_[0-9a-f]{24}$/), steps: 3 });

    const tour = await tourRow(deps, done.json.tour_id);
    expect(tour.status).toBe("draft");
    expect(tour.workspace_id).toBe(a.workspaceId);
    expect(tour.title).toBe("Send an invoice");
    expect(tour.slug).toMatch(/^[a-z2-7]{10}$/);
    expect(tour.spotlight_dim).toBe(60);
    const chapters = await deps.db.all<Json>("SELECT * FROM chapter WHERE tour_id = ?", [done.json.tour_id]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].position).toBe(0);
    expect(chapters[0].title).toBe("Send an invoice");
    const steps = await stepRows(deps, done.json.chapter_id);
    expect(steps.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(steps[0].click_x).toBe(50);
    expect(steps[0].click_y).toBe(50);
    expect(steps[2].click_x).toBeNull();
    expect(JSON.parse(steps[0].spotlight)).toEqual({ x: 40, y: 30, w: 25, h: 12 });
    expect(steps[2].spotlight).toBeNull();
    expect(JSON.parse(steps[1].notes)).toEqual(v2.steps[1].notes);
    expect(steps.map((s) => s.image_type)).toEqual(["png", "png", "jpg"]);
    expect(steps.map((s) => s.bytes)).toEqual(v2.steps.map((s: Json) => s.bytes));
    for (const s of steps) expect(s.image_key).toMatch(UPLOAD_KEY);
    expect(await count(deps, "upload")).toBe(0);
    expect(await count(deps, "upload_step")).toBe(0);
    // The objects stay where they were written; nothing is moved at commit.
    expect(await draftKeys()).toEqual(steps.map((s) => s.image_key).sort());
  });

  it("storage keys are random per upload and never taken from the title or file names", async () => {
    const { deps, a } = await setup();
    const m = clone(v2);
    m.title = "Quarterly secrets";
    const first = await uploadTour(deps, a.token, m);
    const second = await uploadTour(deps, a.token, m);
    const k1 = (await stepRows(deps, first.chapter_id)).map((s) => s.image_key as string);
    const k2 = (await stepRows(deps, second.chapter_id)).map((s) => s.image_key as string);
    for (const k of [...k1, ...k2]) {
      expect(k).toMatch(UPLOAD_KEY);
      expect(k.toLowerCase()).not.toContain("quarterly");
    }
    expect(k1[0].split("/")[1]).not.toBe(k2[0].split("/")[1]);
  });

  it("an upload into an existing tour adds a chapter at the next position and keeps the first", async () => {
    const { deps, a } = await setup();
    const first = await uploadTour(deps, a.token, v2);
    const m = clone(v2);
    m.title = "Second chapter";
    m.steps = m.steps.slice(0, 2);
    const second = await uploadTour(deps, a.token, m, { kind: "chapter", tour_id: first.tour_id });
    expect(second.tour_id).toBe(first.tour_id);
    expect(second.chapter_id).not.toBe(first.chapter_id);
    expect(second.steps).toBe(2);
    const chapters = await deps.db.all<Json>("SELECT id, title, position FROM chapter WHERE tour_id = ? ORDER BY position", [first.tour_id]);
    expect(chapters).toEqual([
      { id: first.chapter_id, title: "Send an invoice", position: 0 },
      { id: second.chapter_id, title: "Second chapter", position: 1 },
    ]);
    expect((await stepRows(deps, first.chapter_id)).length).toBe(3);
    expect((await stepRows(deps, second.chapter_id)).map((s) => s.position)).toEqual([0, 1]);
    expect(await count(deps, "tour")).toBe(1);
    expect((await tourRow(deps, first.tour_id)).title).toBe("Send an invoice");
  });

  it("an upload into a published tour arrives as a draft chapter and leaves what is published alone", async () => {
    const { deps, a } = await setup();
    const first = await uploadTour(deps, a.token, v2);
    await deps.db.run("UPDATE tour SET status = 'published', published_at = 5 WHERE id = ?", [first.tour_id]);
    await deps.db.run("INSERT INTO snapshot (tour_id, data, published_at) VALUES (?, ?, 5)", [first.tour_id, '{"live":true}']);
    await deps.db.run("INSERT INTO snapshot_object (tour_id, image_key) VALUES (?, ?)", [first.tour_id, "p/" + "a".repeat(32) + ".png"]);
    await uploadTour(deps, a.token, v2, { kind: "chapter", tour_id: first.tour_id });
    const tour = await tourRow(deps, first.tour_id);
    expect(tour.status).toBe("published");
    expect(tour.published_at).toBe(5);
    expect(await deps.db.all("SELECT tour_id, data, published_at FROM snapshot")).toEqual([{ tour_id: first.tour_id, data: '{"live":true}', published_at: 5 }]);
    expect(await count(deps, "snapshot_object")).toBe(1);
    expect(await count(deps, "chapter")).toBe(2);
  });

  it("the tour's spotlight_dim is set from the manifest only when the tour has none yet", async () => {
    const { deps, a } = await setup();
    const noDim = clone(v2);
    delete noDim.spotlight_dim;
    for (const s of noDim.steps) s.spotlight = null;
    const first = await uploadTour(deps, a.token, noDim);
    expect((await tourRow(deps, first.tour_id)).spotlight_dim).toBeNull();
    const dim40 = clone(v2);
    dim40.spotlight_dim = 40;
    await uploadTour(deps, a.token, dim40, { kind: "chapter", tour_id: first.tour_id });
    expect((await tourRow(deps, first.tour_id)).spotlight_dim).toBe(40);
    await uploadTour(deps, a.token, v2, { kind: "chapter", tour_id: first.tour_id });
    expect((await tourRow(deps, first.tour_id)).spotlight_dim).toBe(40);
  });

  it("a v1 upload stores steps with no layer", async () => {
    const { deps, a } = await setup();
    const done = await uploadTour(deps, a.token, fixtures.v1 as Json);
    for (const s of await stepRows(deps, done.chapter_id)) {
      expect(s.spotlight).toBeNull();
      expect(s.notes).toBe("[]");
    }
  });
});

describe("commit", () => {
  it("commit with a step missing is 409 and writes no tour, chapter or step row", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]));
    await putStep(deps, a.token, id, 3, stepImage(v2.steps[2]));
    const r = await commit(deps, a.token, id);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("incomplete");
    expect(r.json.detail).toContain("step 2");
    expect(await count(deps, "tour")).toBe(0);
    expect(await count(deps, "chapter")).toBe(0);
    expect(await count(deps, "step")).toBe(0);
    expect(await count(deps, "upload")).toBe(1);
    // The upload can still be finished.
    await putStep(deps, a.token, id, 2, stepImage(v2.steps[1]));
    expect((await commit(deps, a.token, id)).status).toBe(201);
  });

  it("a failed commit batch leaves no rows", async () => {
    const { deps, a } = await setup();
    const existing = await uploadTour(deps, a.token, v2);
    const taken = (await tourRow(deps, existing.tour_id)).slug as string;
    const before = await counts(deps);
    const id = await sendAll(deps, a.token, v2);
    // Every slug the commit draws collides with the existing tour's.
    slugQueue.push(...new Array(20).fill(taken));
    const r = await commit(deps, a.token, id);
    expect(r.status).toBe(500);
    expect(await count(deps, "tour")).toBe(before.tour);
    expect(await count(deps, "chapter")).toBe(before.chapter);
    expect(await count(deps, "step")).toBe(before.step);
    expect(await count(deps, "upload")).toBe(1);
    expect(await count(deps, "upload_step")).toBe(3);
    // With fresh slugs the same upload commits.
    slugQueue.length = 0;
    expect((await commit(deps, a.token, id)).status).toBe(201);
  });

  it("a slug collision is retried with a new slug", async () => {
    const { deps, a } = await setup();
    const existing = await uploadTour(deps, a.token, v2);
    const taken = (await tourRow(deps, existing.tour_id)).slug as string;
    const id = await sendAll(deps, a.token, v2);
    slugQueue.push(taken, taken);
    const r = await commit(deps, a.token, id);
    expect(r.status).toBe(201);
    expect((await tourRow(deps, r.json.tour_id)).slug).not.toBe(taken);
  });

  it("a batch that fails part-way writes nothing at all", async () => {
    const { deps, a } = await setup();
    const id = await sendAll(deps, a.token, v3);
    const realBatch = deps.db.batch.bind(deps.db);
    // A last statement that the schema refuses makes the whole commit roll back.
    deps.db.batch = (stmts) => realBatch([...stmts, { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (2, ?, 0)", params: [a.workspaceId] }]);
    const r = await commit(deps, a.token, id);
    expect(r.status).toBe(500);
    deps.db.batch = realBatch;
    expect(await counts(deps)).toMatchObject({ tour: 0, chapter: 0, step: 0, upload: 1, upload_step: 3 });
    expect((await commit(deps, a.token, id)).status).toBe(201);
  });

  it("commit repeated answers the same and writes nothing more", async () => {
    const { deps, a, b } = await setup();
    const id = await sendAll(deps, a.token, v3);
    const first = await commit(deps, a.token, id);
    expect(first.status).toBe(201);
    const after = await counts(deps);
    const again = await commit(deps, a.token, id);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
    expect(await counts(deps)).toEqual(after);
    // Another workspace learns nothing from it.
    expect((await commit(deps, b.token, id)).status).toBe(404);
  });

  it("two commits at the same moment make one tour", async () => {
    const { deps, a } = await setup();
    const id = await sendAll(deps, a.token, v2);
    const [r1, r2] = await Promise.all([commit(deps, a.token, id), commit(deps, a.token, id)]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.json).toEqual(r2.json);
    expect(await counts(deps)).toMatchObject({ tour: 1, chapter: 1, step: 3, upload: 0, upload_step: 0 });
  });

  it("an aborted upload cannot be committed", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = await sendAll(deps, a.token, v2);
    expect((await abort(deps, a.token, id)).status).toBe(204);
    expect((await commit(deps, a.token, id)).status).toBe(404);
    expect(await counts(deps)).toMatchObject({ tour: 0, chapter: 0, step: 0, upload: 0, upload_step: 0 });
    expect(await draftKeys()).toEqual([]);
  });

  it("an abort after a commit deletes nothing the tour uses", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = await sendAll(deps, a.token, v3);
    await commit(deps, a.token, id);
    const keys = await draftKeys();
    expect(keys).toHaveLength(4);
    expect((await abort(deps, a.token, id)).status).toBe(204);
    expect(await draftKeys()).toEqual(keys);
  });

  it("an abort marked on the upload stops a commit that already passed its checks", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = await sendAll(deps, a.token, v2);
    const realBatch = deps.db.batch.bind(deps.db);
    // The abort lands between the commit's checks and its batch.
    deps.db.batch = async (stmts) => {
      deps.db.batch = realBatch;
      await abort(deps, a.token, id);
      return realBatch(stmts);
    };
    const r = await commit(deps, a.token, id);
    expect(r.status).toBe(404);
    expect(await counts(deps)).toMatchObject({ tour: 0, chapter: 0, step: 0, upload: 0, upload_step: 0 });
    expect(await draftKeys()).toEqual([]);
  });
});

describe("abort and sweep", () => {
  it("abort removes this upload's objects and rows and nothing else", async () => {
    const { deps, a, draftKeys } = await setup();
    const unrelated = "u/up_" + "f".repeat(24) + "/step-001.png";
    await deps.drafts.put(unrelated, png(4, 4, 100), { contentType: "image/png" });
    const first = await sendAll(deps, a.token, v2, { kind: "new" }, 1);
    const second = await sendAll(deps, a.token, v2, { kind: "new" }, 2);
    expect((await abort(deps, a.token, first)).status).toBe(204);
    const keys = await draftKeys();
    expect(keys.filter((k) => k.includes(first))).toEqual([]);
    expect(keys.filter((k) => k.includes(second))).toHaveLength(3);
    expect(keys).toContain(unrelated);
    expect(await count(deps, "upload")).toBe(1);
    expect(await count(deps, "upload_step")).toBe(3);
    expect((await commit(deps, a.token, second)).status).toBe(201);
    // Aborting again, or an id that never existed, is still 204.
    expect((await abort(deps, a.token, first)).status).toBe(204);
    expect((await abort(deps, a.token, "up_" + "0".repeat(24))).status).toBe(204);
  });

  it("abort of a half-sent upload leaves no rows and no objects", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = (await createUpload(deps, a.token, v3)).json.upload_id;
    await putStep(deps, a.token, id, 1, stepImage(v3.steps[0]));
    await putLogo(deps, a.token, id, logoPng());
    expect(await draftKeys()).toHaveLength(2);
    expect((await abort(deps, a.token, id)).status).toBe(204);
    expect(await counts(deps)).toMatchObject({ upload: 0, upload_step: 0, tour: 0 });
    expect(await draftKeys()).toEqual([]);
  });

  it("abort removes an object whose step row was never finished", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    // As if a request was cut off after writing the object: the object is there and the
    // step row has no stored_at.
    await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]));
    await deps.db.run("UPDATE upload_step SET stored_at = NULL WHERE upload_id = ?", [id]);
    await deps.drafts.put(`u/${id}/step-002.png`, stepImage(v2.steps[1]), { contentType: "image/png" });
    expect((await commit(deps, a.token, id)).status).toBe(409);
    expect((await abort(deps, a.token, id)).status).toBe(204);
    expect(await draftKeys()).toEqual([]);
  });

  it("an upload older than 24 hours is swept on the next create, a newer one is not", async () => {
    const { deps, a, b, draftKeys } = await setup();
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const old = await sendAll(deps, a.token, v3, { kind: "new" }, 1);
    const otherWorkspace = await sendAll(deps, b.token, v2, { kind: "new" }, 3);
    now += DAY - 60_000;
    const newer = await sendAll(deps, a.token, v2, { kind: "new" }, 2);
    now += 120_000; // old is now just over a day old, newer is two minutes old
    const created = await createUpload(deps, a.token, v2);
    expect(created.status).toBe(201);
    const ids = (await deps.db.all<{ id: string }>("SELECT id FROM upload ORDER BY id")).map((r) => r.id).sort();
    expect(ids).toEqual([newer, otherWorkspace, created.json.upload_id].sort());
    const keys = await draftKeys();
    expect(keys.filter((k) => k.includes(old))).toEqual([]);
    expect(keys.filter((k) => k.includes(newer))).toHaveLength(3);
    // Another workspace's old upload is left for that workspace's own next create.
    expect(keys.filter((k) => k.includes(otherWorkspace))).toHaveLength(3);
  });

  it("the sweep takes at most five uploads per create", async () => {
    const { deps, a } = await setup();
    deps.config.maxOpenUploads = 10;
    let now = 1_800_000_000_000;
    deps.now = () => now;
    for (let i = 0; i < 7; i++) await createUpload(deps, a.token, v2);
    now += 2 * DAY;
    await createUpload(deps, a.token, v2);
    expect(await count(deps, "upload")).toBe(3);
  });

  it("a sweep that cannot delete never fails the create it rides on, and logs no secret", async () => {
    const { deps, a, draftKeys } = await setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const old1 = await sendAll(deps, a.token, v2, { kind: "new" }, 1);
    const old2 = await sendAll(deps, a.token, v2, { kind: "new" }, 2);
    now += 2 * DAY;
    const realDelete = deps.drafts.delete.bind(deps.drafts);
    deps.drafts.delete = async () => {
      throw new Error("storage down for " + a.token);
    };
    const r = await createUpload(deps, a.token, v2);
    expect(r.status).toBe(201);
    const logged = [...errors.mock.calls, ...warns.mock.calls].map((c) => c.map(String).join(" "));
    expect(logged.length).toBeGreaterThanOrEqual(2); // one line per upload it could not remove: it carried on after the first
    const hash = await hashToken(a.token);
    for (const line of logged) {
      expect(line).not.toContain(a.token.slice(3));
      expect(line).not.toContain(hash);
    }
    // The failed uploads keep their rows, closed to commits, and a later create finishes them.
    expect((await commit(deps, a.token, old1)).status).toBe(404);
    deps.drafts.delete = realDelete;
    now += 1000;
    expect((await createUpload(deps, a.token, v2)).status).toBe(201);
    const keys = await draftKeys();
    expect(keys.filter((k) => k.includes(old1) || k.includes(old2))).toEqual([]);
    expect(await count(deps, "upload")).toBe(2);
  });
});

describe("the open-upload cap", () => {
  it("the sixth open upload is refused with 429 and Retry-After, and an abort frees a place", async () => {
    const { deps, a, b } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await createUpload(deps, a.token, v2);
      expect(r.status).toBe(201);
      ids.push(r.json.upload_id);
    }
    const refused = await createUpload(deps, a.token, v2);
    expect(refused.status).toBe(429);
    expect(refused.json.error).toBe("too_many_uploads");
    expect(refused.json.detail).toContain("5");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await count(deps, "upload")).toBe(5);
    // Another workspace has its own places.
    expect((await createUpload(deps, b.token, v2)).status).toBe(201);
    expect((await abort(deps, a.token, ids[0])).status).toBe(204);
    expect((await createUpload(deps, a.token, v2)).status).toBe(201);
    expect((await createUpload(deps, a.token, v2)).status).toBe(429);
  });

  it("committed and expired uploads do not count, and the cap comes from the config", async () => {
    const { deps, a } = await makeDeps({ maxOpenUploads: 2 }).then(async (ctx) => ({ ...ctx, a: await seedWorkspace(ctx.deps, "A") }));
    let now = 1_800_000_000_000;
    deps.now = () => now;
    await uploadTour(deps, a.token, v2);
    await uploadTour(deps, a.token, v2);
    expect((await createUpload(deps, a.token, v2)).status).toBe(201);
    expect((await createUpload(deps, a.token, v2)).status).toBe(201);
    expect((await createUpload(deps, a.token, v2)).status).toBe(429);
    now += DAY + 1000; // both open ones expire and are swept
    expect((await createUpload(deps, a.token, v2)).status).toBe(201);
  });

  it("creates at the same moment never pass the cap", async () => {
    const { deps, a } = await setup();
    deps.config.maxOpenUploads = 3;
    const rs = await Promise.all(Array.from({ length: 6 }, () => createUpload(deps, a.token, v2)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(3);
    expect(await count(deps, "upload")).toBe(3);
  });
});

describe("a step whose request died", () => {
  it("an unfinished claim answers 409 at first and can be taken over after a minute", async () => {
    const { deps, a, draftKeys } = await setup();
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    // As if the process died after writing the step's row: a claim with no stored_at.
    await deps.db.run("INSERT INTO upload_step (upload_id, n, image_key, bytes, claim, claimed_at) VALUES (?, 1, ?, ?, ?, ?)", [
      id, `u/${id}/step-001.png`, v2.steps[0].bytes, "dead-request", now,
    ]);
    now += 30_000;
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]))).status).toBe(409);
    now += 31_000;
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]))).status).toBe(204);
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]))).status).toBe(409); // finished now: never taken over
    await putStep(deps, a.token, id, 2, stepImage(v2.steps[1]));
    await putStep(deps, a.token, id, 3, stepImage(v2.steps[2]));
    expect((await commit(deps, a.token, id)).status).toBe(201);
    expect(await draftKeys()).toHaveLength(3);
  });

  it("a slow first writer that finishes after a takeover neither finishes the step nor deletes the object", async () => {
    const { deps, a, draftKeys } = await setup();
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const realPut = deps.drafts.put.bind(deps.drafts);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    deps.drafts.put = async (key, body, meta) => {
      if (calls++ === 0) await gate; // the first writer stalls while writing its object
      return realPut(key, body, meta);
    };
    const slow = putStep(deps, a.token, id, 1, stepImage(v2.steps[0], 1));
    // Wait until the slow writer holds its claim.
    for (let i = 0; i < 200 && (await count(deps, "upload_step")) === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await count(deps, "upload_step")).toBe(1);
    now += 61_000;
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0], 2))).status).toBe(204);
    release();
    expect((await slow).status).toBe(409);
    expect(await draftKeys()).toEqual([`u/${id}/step-001.png`]);
    const row = await deps.db.first<Json>("SELECT stored_at FROM upload_step WHERE upload_id = ? AND n = 1", [id]);
    expect(row!.stored_at).not.toBeNull();
    await putStep(deps, a.token, id, 2, stepImage(v2.steps[1]));
    await putStep(deps, a.token, id, 3, stepImage(v2.steps[2]));
    expect((await commit(deps, a.token, id)).status).toBe(201);
  });
});

describe("picture hashes", () => {
  it("a stored step records the SHA-256 of its bytes, and commit carries it to the step", async () => {
    const { deps, a } = await setup();
    const m = clone(v2);
    // Steps 1 and 2 declare the same picture, so the same bytes are sent for both.
    m.steps[1] = { ...clone(m.steps[0]), image: "step-002.png" };
    const id = (await createUpload(deps, a.token, m)).json.upload_id as string;
    const same = stepImage(m.steps[0], 5);
    const third = stepImage(m.steps[2], 6);
    expect((await putStep(deps, a.token, id, 1, same)).status).toBe(204);
    expect((await putStep(deps, a.token, id, 2, same)).status).toBe(204);
    expect((await putStep(deps, a.token, id, 3, third)).status).toBe(204);
    const sent = await deps.db.all<Json>("SELECT n, sha256, reused FROM upload_step WHERE upload_id = ? ORDER BY n", [id]);
    expect(sent).toEqual([
      { n: 1, sha256: await sha256Hex(same), reused: 0 },
      { n: 2, sha256: await sha256Hex(same), reused: 0 },
      { n: 3, sha256: await sha256Hex(third), reused: 0 },
    ]);
    expect(sent[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sent[2].sha256).not.toBe(sent[0].sha256);
    const done = await commit(deps, a.token, id);
    expect(done.status).toBe(201);
    const steps = await stepRows(deps, done.json.chapter_id);
    expect(steps.map((s) => s.sha256)).toEqual(sent.map((s) => s.sha256));
    // Each is the digest of what the drafts store holds under the step's key.
    for (const s of steps) {
      const file = (await deps.drafts.get(s.image_key))!;
      expect(await sha256Hex(new Uint8Array(await new Response(file.body).arrayBuffer()))).toBe(s.sha256);
    }
  });

  it("a step taken over after a stale claim records the hash of the bytes that were kept", async () => {
    const { deps, a } = await setup();
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await createUpload(deps, a.token, v2)).json.upload_id as string;
    await deps.db.run("INSERT INTO upload_step (upload_id, n, image_key, bytes, claim, claimed_at) VALUES (?, 1, ?, ?, ?, ?)", [
      id, `u/${id}/step-001.png`, v2.steps[0].bytes, "dead-request", now,
    ]);
    now += 61_000;
    const kept = stepImage(v2.steps[0], 9);
    expect((await putStep(deps, a.token, id, 1, kept)).status).toBe(204);
    const row = await deps.db.first<Json>("SELECT sha256, image_key FROM upload_step WHERE upload_id = ? AND n = 1", [id]);
    expect(row!.sha256).toBe(await sha256Hex(kept));
    const file = (await deps.drafts.get(row!.image_key))!;
    expect(new Uint8Array(await new Response(file.body).arrayBuffer())).toEqual(kept);
  });

  it("a slow first writer that wrote over a taken-over step leaves its hash unknown, never a wrong one", async () => {
    const { deps, a } = await setup();
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const id = (await createUpload(deps, a.token, v2)).json.upload_id as string;
    const realPut = deps.drafts.put.bind(deps.drafts);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    deps.drafts.put = async (key, body, meta) => {
      if (calls++ === 0) await gate; // the first writer stalls, then writes last
      return realPut(key, body, meta);
    };
    const slow = putStep(deps, a.token, id, 1, stepImage(v2.steps[0], 1));
    for (let i = 0; i < 200 && (await count(deps, "upload_step")) === 0; i++) await new Promise((r) => setTimeout(r, 5));
    now += 61_000;
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0], 2))).status).toBe(204);
    release();
    expect((await slow).status).toBe(409);
    // The store now holds the slow writer's bytes, so the hash of the later send is not kept.
    const row = await deps.db.first<Json>("SELECT sha256, stored_at FROM upload_step WHERE upload_id = ? AND n = 1", [id]);
    expect(row!.stored_at).not.toBeNull();
    expect(row!.sha256).toBeNull();
    await putStep(deps, a.token, id, 2, stepImage(v2.steps[1]));
    await putStep(deps, a.token, id, 3, stepImage(v2.steps[2]));
    const done = await commit(deps, a.token, id);
    expect(done.status).toBe(201);
    expect((await stepRows(deps, done.json.chapter_id)).map((s) => s.sha256 === null)).toEqual([true, false, false]);
  });

  it("storing a step still makes no more calls than before", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id as string;
    // 2 authentication, the upload, the step's claim state, the claim, the object, the mark.
    const r = await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]));
    expect(r.status).toBe(204);
    expect(r.calls).toBe(7);
    // A second send is refused after 4.
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]))).calls).toBe(4);
  });
});

describe("step images", () => {
  it("PUT refuses a wrong length, an HTML body named .png, a JPEG sent for a .png step, n = 0 and n = N + 1", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const s0 = v2.steps[0];
    const tooShort = await putStep(deps, a.token, id, 1, png(s0.width, s0.height, s0.bytes - 1));
    expect(tooShort.status).toBe(400);
    const tooLong = await putStep(deps, a.token, id, 1, png(s0.width, s0.height, s0.bytes + 1));
    expect(tooLong.status).toBe(400);
    const html = new Uint8Array(s0.bytes).fill(0x20);
    html.set(new TextEncoder().encode("<html><script>alert(1)</script>"));
    expect((await putStep(deps, a.token, id, 1, html)).status).toBe(400);
    expect((await putStep(deps, a.token, id, 1, jpeg(s0.width, s0.height, s0.bytes))).status).toBe(400);
    expect((await putStep(deps, a.token, id, 1, png(s0.width + 1, s0.height, s0.bytes))).status).toBe(400);
    expect((await putStep(deps, a.token, id, 3, png(1280, 720, v2.steps[2].bytes))).status).toBe(400);
    for (const n of ["0", "4", "01", "-1", "1.0", "x", "1e0"]) {
      expect((await putStep(deps, a.token, id, n, stepImage(s0))).status).toBe(404);
    }
    expect(await draftKeys()).toEqual([]);
    expect(await count(deps, "upload_step")).toBe(0);
  });

  it("a refused image names the step and the problem without repeating the bytes", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const html = new Uint8Array(v2.steps[0].bytes).fill(0x20);
    html.set(new TextEncoder().encode("<html>SECRET-CONTENT"));
    const r = await putStep(deps, a.token, id, 1, html);
    expect(r.json.error).toBe("bad_image");
    expect(r.json.detail).toContain("step 1");
    expect(r.text).not.toContain("SECRET");
  });

  it("PUT refuses 2,000,001 bytes with 413 before storing anything", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const r = await putStep(deps, a.token, id, 1, png(1280, 720, 2_000_001));
    expect(r.status).toBe(413);
    expect(r.json.error).toBe("too_large");
    expect(await draftKeys()).toEqual([]);
    expect(await count(deps, "upload_step")).toBe(0);
  });

  it("a body with no Content-Length is read only up to the cap", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const body = endlessBody();
    const r = await putStep(deps, a.token, id, 1, body.stream);
    expect(r.status).toBe(413);
    // 2,000,000 bytes is about 31 chunks of 64 KiB; the reader stopped soon after.
    expect(body.pulled()).toBeLessThan(40);
    expect(await draftKeys()).toEqual([]);
  });

  it("a declared Content-Length over the cap is refused without reading the body", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const body = endlessBody();
    const r = await send(deps, "PUT", `/api/v1/uploads/${id}/steps/1`, { token: a.token, body: body.stream, headers: { "content-length": "2000001" } });
    expect(r.status).toBe(413);
    expect(body.pulled()).toBeLessThanOrEqual(1);
  });

  it("a streamed body of the right length is accepted", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const img = stepImage(v2.steps[0]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < img.length; i += 10_000) c.enqueue(img.slice(i, i + 10_000));
        c.close();
      },
    });
    expect((await putStep(deps, a.token, id, 1, stream)).status).toBe(204);
  });

  it("sending the same step twice is 409 and keeps the first object", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0], 1))).status).toBe(204);
    const again = await putStep(deps, a.token, id, 1, stepImage(v2.steps[0], 2));
    expect(again.status).toBe(409);
    const stored = await deps.drafts.get(`u/${id}/step-001.png`);
    const bytes = new Uint8Array(await new Response(stored!.body).arrayBuffer());
    expect(bytes[bytes.length - 1]).toBe(1);
  });

  it("two sends of the same step at the same moment store one and refuse the other", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const rs = await Promise.all([putStep(deps, a.token, id, 1, stepImage(v2.steps[0], 1)), putStep(deps, a.token, id, 1, stepImage(v2.steps[0], 2))]);
    expect(rs.map((r) => r.status).sort()).toEqual([204, 409]);
    const winner = rs[0].status === 204 ? 1 : 2;
    const stored = await deps.drafts.get(`u/${id}/step-001.png`);
    const bytes = new Uint8Array(await new Response(stored!.body).arrayBuffer());
    expect(bytes[bytes.length - 1]).toBe(winner);
  });

  it("a failed object write releases the step so it can be sent again", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const realPut = deps.drafts.put.bind(deps.drafts);
    deps.drafts.put = async () => {
      throw new Error("disk full");
    };
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]))).status).toBe(500);
    deps.drafts.put = realPut;
    expect(await count(deps, "upload_step")).toBe(0);
    expect(await draftKeys()).toEqual([]);
    expect((await putStep(deps, a.token, id, 1, stepImage(v2.steps[0]))).status).toBe(204);
  });
});

describe("creating an upload", () => {
  it("refuses a bad manifest naming the field, and writes nothing", async () => {
    const { deps, a } = await setup();
    const m = clone(v3);
    m.cta.url = "javascript:alert(1)";
    const r = await createUpload(deps, a.token, m);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("bad_manifest");
    expect(r.json.detail).toContain("cta.url");
    expect(r.text).not.toContain("javascript");
    expect(await count(deps, "upload")).toBe(0);
  });

  it("refuses bad JSON, a missing manifest and an unknown target", async () => {
    const { deps, a } = await setup();
    const bad = await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ target: { kind: "new" } }) })).status).toBe(400);
    const unknown = await createUpload(deps, a.token, v2, { kind: "swap" });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe("bad_target");
    // "replace" is a target now (test/replace.test.ts): without a tour it names none.
    expect((await createUpload(deps, a.token, v2, { kind: "replace" })).status).toBe(404);
    expect((await createUpload(deps, a.token, v2, null)).status).toBe(400);
    expect((await createUpload(deps, a.token, v2, { kind: "chapter", tour_id: "tour_" + "0".repeat(24) })).status).toBe(404);
    expect((await createUpload(deps, a.token, v2, { kind: "chapter", tour_id: "../x" })).status).toBe(404);
    expect(await count(deps, "upload")).toBe(0);
  });

  it("refuses a body over the manifest cap with 413", async () => {
    const { deps, a } = await setup();
    const m = clone(v2);
    m.generator = "x".repeat(300_000);
    const r = await createUpload(deps, a.token, m);
    expect(r.status).toBe(413);
    expect(await count(deps, "upload")).toBe(0);
    const body = endlessBody();
    expect((await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: body.stream })).status).toBe(413);
    expect(body.pulled()).toBeLessThan(10);
  });

  it("stores the validated manifest, not the request's text", async () => {
    const { deps, a } = await setup();
    const m = clone(v2) as Json;
    m.extra = "dropped";
    m.steps[0].keys = ["ctrl"];
    const id = (await createUpload(deps, a.token, m)).json.upload_id;
    const row = await deps.db.first<{ manifest: string }>("SELECT manifest FROM upload WHERE id = ?", [id]);
    expect(row!.manifest).not.toContain("dropped");
    expect(row!.manifest).not.toContain("ctrl");
  });
});

describe("version 3 settings and the logo", () => {
  it("a v3 upload stores the tour's settings and each step's card, advance and zoom", async () => {
    const { deps, a } = await setup();
    const done = await uploadTour(deps, a.token, v3);
    const tour = await tourRow(deps, done.tour_id);
    expect(JSON.parse(tour.theme)).toEqual(v3.theme);
    expect(JSON.parse(tour.zoom)).toEqual(v3.zoom);
    expect(JSON.parse(tour.cover)).toEqual(v3.cover);
    expect(JSON.parse(tour.cover).logo).toBe("logo.png");
    expect(JSON.parse(tour.cta)).toEqual(v3.cta);
    expect(JSON.parse(tour.end_card)).toEqual(v3.end);
    expect(JSON.parse(tour.autoplay)).toEqual(v3.autoplay);
    expect(tour.logo_key).toMatch(/^u\/up_[0-9a-f]{24}\/logo\.png$/);
    expect(tour.logo_type).toBe("png");
    expect(tour.end_text).toBeNull();
    expect(tour.end_button_label).toBeNull();
    expect(tour.end_button_url).toBeNull();
    const steps = await stepRows(deps, done.chapter_id);
    expect(JSON.parse(steps[0].card)).toEqual(v3.steps[0].card);
    expect(steps[0].advance).toBe("anywhere");
    expect(steps[0].zoom).toBe(0);
    expect(steps[1].zoom).toBeNull();
    expect(steps[1].advance).toBe("hotspot");
    expect(JSON.parse(steps[1].card).point).toEqual({ x: 20, y: 50 });
  });

  it("a v3 upload with zoom on for a step stores 1", async () => {
    const { deps, a } = await setup();
    const m = clone(v3);
    m.steps[2].zoom = true;
    const done = await uploadTour(deps, a.token, m);
    expect((await stepRows(deps, done.chapter_id))[2].zoom).toBe(1);
  });

  it("an upload into an existing tour refuses a logo with 409 and stores no object or row for it", async () => {
    const { deps, a, draftKeys } = await setup();
    const first = await uploadTour(deps, a.token, v3);
    const keysBefore = await draftKeys();
    const id = (await createUpload(deps, a.token, v3, { kind: "chapter", tour_id: first.tour_id })).json.upload_id;
    for (let i = 0; i < 3; i++) await putStep(deps, a.token, id, i + 1, stepImage(v3.steps[i]));
    const r = await putLogo(deps, a.token, id, logoPng());
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("logo_not_used");
    expect(r.json.detail).toContain("existing tour");
    const row = await deps.db.first<Json>("SELECT logo_key, logo_bytes FROM upload WHERE id = ?", [id]);
    expect(row).toEqual({ logo_key: null, logo_bytes: null });
    expect((await draftKeys()).filter((k) => k.includes(id) && k.includes("logo"))).toEqual([]);
    // The commit needs no logo, and afterwards every draft object is recorded on a row.
    expect((await commit(deps, a.token, id)).status).toBe(201);
    const recorded = new Set<string>();
    for (const s of await deps.db.all<{ image_key: string }>("SELECT image_key FROM step")) recorded.add(s.image_key);
    for (const t of await deps.db.all<{ logo_key: string | null }>("SELECT logo_key FROM tour")) if (t.logo_key) recorded.add(t.logo_key);
    const keys = await draftKeys();
    expect(keys.length).toBe(keysBefore.length + 3);
    for (const k of keys) expect(recorded.has(k)).toBe(true);
  });

  it("a new tour's draft objects are all recorded on its rows after commit", async () => {
    const { deps, a, draftKeys } = await setup();
    await uploadTour(deps, a.token, v3);
    const recorded = new Set<string>();
    for (const s of await deps.db.all<{ image_key: string }>("SELECT image_key FROM step")) recorded.add(s.image_key);
    for (const t of await deps.db.all<{ logo_key: string | null }>("SELECT logo_key FROM tour")) if (t.logo_key) recorded.add(t.logo_key);
    expect((await draftKeys()).sort()).toEqual([...recorded].sort());
  });

  it("an upload into an existing tour keeps that tour's theme, cover and logo", async () => {
    const { deps, a, draftKeys } = await setup();
    const first = await uploadTour(deps, a.token, v3);
    const before = await tourRow(deps, first.tour_id);
    const m = clone(v3);
    m.theme.accent = "#112233";
    m.cover.title = "Another cover";
    m.cta = null;
    const second = await uploadTour(deps, a.token, m, { kind: "chapter", tour_id: first.tour_id });
    const after = await tourRow(deps, first.tour_id);
    for (const col of ["theme", "zoom", "cover", "cta", "end_card", "autoplay", "logo_key", "logo_type", "title", "slug", "status"]) expect(after[col]).toEqual(before[col]);
    const keys = await draftKeys();
    expect(keys.filter((k) => k.endsWith("/logo.png"))).toEqual([before.logo_key]);
    // The new chapter's steps keep their own card, advance and zoom.
    const steps = await stepRows(deps, second.chapter_id);
    expect(JSON.parse(steps[0].card)).toEqual(m.steps[0].card);
    expect(steps[0].advance).toBe("anywhere");
  });

  it("commit is 409 when the manifest names a logo that was never sent", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v3)).json.upload_id;
    for (let i = 0; i < 3; i++) await putStep(deps, a.token, id, i + 1, stepImage(v3.steps[i]));
    const r = await commit(deps, a.token, id);
    expect(r.status).toBe(409);
    expect(r.json.detail).toContain("logo");
    expect(await count(deps, "tour")).toBe(0);
    expect((await putLogo(deps, a.token, id, logoPng())).status).toBe(204);
    expect((await commit(deps, a.token, id)).status).toBe(201);
  });

  it("the logo route refuses an HTML body, 200,001 bytes, a 513-pixel side, a second logo, and a manifest with no logo", async () => {
    const { deps, a, b, draftKeys } = await setup();
    const id = (await createUpload(deps, a.token, v3)).json.upload_id;
    const html = new TextEncoder().encode("<html><body>not a logo</body></html>");
    expect((await putLogo(deps, a.token, id, html)).status).toBe(400);
    expect((await putLogo(deps, a.token, id, png(64, 64, 200_001))).status).toBe(413);
    expect((await putLogo(deps, a.token, id, png(513, 64, 2000))).status).toBe(400);
    expect((await putLogo(deps, a.token, id, png(64, 513, 2000))).status).toBe(400);
    expect((await putLogo(deps, a.token, id, jpeg(64, 64, 2000))).status).toBe(400); // manifest says logo.png
    expect(await draftKeys()).toEqual([]);
    expect((await putLogo(deps, a.token, id, png(512, 512, 200_000))).status).toBe(204);
    const one = await draftKeys();
    expect(one).toEqual([`u/${id}/logo.png`]);
    expect((await putLogo(deps, a.token, id, logoPng())).status).toBe(409);
    expect(await draftKeys()).toEqual(one);
    const noLogo = (await createUpload(deps, a.token, v2)).json.upload_id;
    expect((await putLogo(deps, a.token, noLogo, logoPng())).status).toBe(404);
    const coverNoLogo = clone(v3);
    coverNoLogo.cover.logo = null;
    const id3 = (await createUpload(deps, a.token, coverNoLogo)).json.upload_id;
    expect((await putLogo(deps, a.token, id3, logoPng())).status).toBe(404);
    expect((await putLogo(deps, b.token, id, logoPng())).status).toBe(404);
    expect(await draftKeys()).toEqual(one);
  });

  it("a JPEG logo is accepted when the manifest names logo.jpg", async () => {
    const { deps, a } = await setup();
    const m = clone(v3);
    m.cover.logo = "logo.jpg";
    const done = await uploadTour(deps, a.token, m);
    const tour = await tourRow(deps, done.tour_id);
    expect(tour.logo_key).toMatch(/\/logo\.jpg$/);
    expect(tour.logo_type).toBe("jpg");
  });

  it("abort removes the logo with the steps", async () => {
    const { deps, a, draftKeys } = await setup();
    const id = await sendAll(deps, a.token, v3);
    expect(await draftKeys()).toHaveLength(4);
    expect((await abort(deps, a.token, id)).status).toBe(204);
    expect(await draftKeys()).toEqual([]);
    expect(await count(deps, "upload")).toBe(0);
  });

  it("a v2 upload still works and stores the default theme with zoom off", async () => {
    const { deps, a } = await setup();
    const done = await uploadTour(deps, a.token, v2);
    const tour = await tourRow(deps, done.tour_id);
    expect(JSON.parse(tour.zoom).enabled).toBe(false);
    expect(JSON.parse(tour.theme).progress_bar).toBe(false);
    expect(tour.cover).toBeNull();
    expect(tour.cta).toBeNull();
    expect(tour.end_card).toBeNull();
    expect(tour.logo_key).toBeNull();
    for (const s of await stepRows(deps, done.chapter_id)) {
      expect(s.card).toBeNull();
      expect(s.advance).toBe("hotspot");
      expect(s.zoom).toBeNull();
    }
  });
});

describe("workspaces and tokens", () => {
  it("workspace B's token gets 404 for A's upload, tour and image, and changes nothing", async () => {
    const { deps, a, b, draftKeys } = await setup();
    const done = await uploadTour(deps, a.token, v3);
    const pending = (await createUpload(deps, a.token, v3)).json.upload_id;
    await putStep(deps, a.token, pending, 1, stepImage(v3.steps[0]));
    const before = await counts(deps);
    const keysBefore = await draftKeys();
    const stepId = (await stepRows(deps, done.chapter_id))[0].id;

    expect((await putStep(deps, b.token, pending, 2, stepImage(v3.steps[1]))).status).toBe(404);
    expect((await putLogo(deps, b.token, pending, logoPng())).status).toBe(404);
    expect((await commit(deps, b.token, pending)).status).toBe(404);
    // Abort answers as for an upload that is not there, and deletes nothing.
    expect((await abort(deps, b.token, pending)).status).toBe(204);
    expect((await createUpload(deps, b.token, v2, { kind: "chapter", tour_id: done.tour_id })).status).toBe(404);
    expect((await send(deps, "GET", `/api/v1/tours/${done.tour_id}/steps/${stepId}/image`, { token: b.token })).status).toBe(404);
    const list = await send(deps, "GET", "/api/v1/tours", { token: b.token });
    expect(list.json.tours).toEqual([]);

    expect(await counts(deps)).toEqual(before);
    expect(await draftKeys()).toEqual(keysBefore);
    expect((await commit(deps, a.token, pending)).status).toBe(409); // still A's, still incomplete
  });

  it("B's sweep never touches A's old uploads", async () => {
    const { deps, a, b, draftKeys } = await setup();
    let now = 1_800_000_000_000;
    deps.now = () => now;
    const stale = await sendAll(deps, a.token, v2);
    now += 2 * DAY;
    const keysBefore = await draftKeys();
    expect((await createUpload(deps, b.token, v2)).status).toBe(201);
    expect(await count(deps, "upload")).toBe(2);
    // B's sweep closed nothing of A's: the statement that closes stale uploads is held to
    // the sweeping workspace, so A's upload is still open, with its files, and still commits.
    expect(await deps.db.first("SELECT closing_at FROM upload WHERE id = ? AND workspace_id = ?", [stale, a.workspaceId])).toEqual({ closing_at: null });
    expect(await count(deps, "upload WHERE closing_at IS NOT NULL")).toBe(0);
    expect(await draftKeys()).toEqual(keysBefore);
    const done = await commit(deps, a.token, stale);
    expect(done.status, done.text).toBe(201);
    expect(done.json.steps).toBe(v2.steps.length);
  });

  it("a create refused twice while room appears both times it is looked for answers the cap's 429, not an error", async () => {
    const h = await makeDeps({ maxOpenUploads: 1 });
    const deps = h.deps;
    const a = await seedWorkspace(deps, "Workspace A");
    const held = (await createUpload(deps, a.token, v2)).json.upload_id as string;
    const setClosing = (at: number | null) => deps.db.run("UPDATE upload SET closing_at = ? WHERE id = ?", [at, held]);
    // Another request closes the one open upload right after each create statement ran
    // and found the cap full, and it is open again just before the second statement: both
    // statements are refused, and both looks at why find room.
    const real = deps.db.run.bind(deps.db);
    let creates = 0;
    deps.db.run = async (sql, params) => {
      if (!sql.startsWith("INSERT INTO upload (id")) return real(sql, params);
      creates += 1;
      if (creates === 2) await setClosing(null);
      const res = await real(sql, params);
      await setClosing(1_800_000_000_000);
      return res;
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let refused: Awaited<ReturnType<typeof createUpload>>;
    try {
      refused = await createUpload(deps, a.token, v2);
    } finally {
      deps.db.run = real;
    }
    expect(creates).toBe(2);
    // What 0.1.7 answered a create that the cap refused: come back in a minute.
    expect([refused.status, refused.json?.error, refused.headers.get("retry-after")], refused.text).toEqual([429, "too_many_uploads", "60"]);
    expect(refused.json.detail).toBe("this workspace already has 1 open uploads; finish or cancel one first");
    expect(errors).not.toHaveBeenCalled();
    // Nothing was made for it: the one row is the upload that held the place.
    expect(await deps.db.all("SELECT id FROM upload")).toEqual([{ id: held }]);
    expect(await count(deps, "upload_step")).toBe(0);
    // Sent again once things are still, it is created.
    await setClosing(null);
    await abort(deps, a.token, held);
    expect((await createUpload(deps, a.token, v2)).status).toBe(201);
  });

  it("every upload route needs the token", async () => {
    const { deps, a } = await setup();
    const id = (await createUpload(deps, a.token, v2)).json.upload_id;
    const calls = [
      send(deps, "POST", "/api/v1/uploads", { body: JSON.stringify({ manifest: v2, target: { kind: "new" } }) }),
      send(deps, "PUT", `/api/v1/uploads/${id}/steps/1`, { body: stepImage(v2.steps[0]) }),
      send(deps, "PUT", `/api/v1/uploads/${id}/logo`, { body: logoPng() }),
      send(deps, "POST", `/api/v1/uploads/${id}/commit`),
      send(deps, "DELETE", `/api/v1/uploads/${id}`),
      send(deps, "GET", "/api/v1/tours"),
      send(deps, "GET", "/api/v1/me"),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(401);
      expect(r.text).toBe('{"error":"unauthorized"}');
    }
    expect(await count(deps, "upload")).toBe(1);
    expect(await count(deps, "upload_step")).toBe(0);
  });

  it("no response body or console output contains the token or its hash", async () => {
    const { deps, a } = await setup();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const hash = await hashToken(a.token);
    const wrong = "dp_" + "e".repeat(40);
    const bodies: string[] = [];
    const record = (r: { text: string; headers: Headers }) => {
      bodies.push(r.text);
      r.headers.forEach((v) => bodies.push(v));
    };
    for (const token of [a.token, wrong]) {
      const created = await createUpload(deps, token, v3);
      record(created);
      const id = created.json?.upload_id ?? "up_" + "0".repeat(24);
      for (let i = 0; i < 3; i++) record(await putStep(deps, token, id, i + 1, stepImage(v3.steps[i])));
      record(await putStep(deps, token, id, 1, stepImage(v3.steps[0]))); // 409
      record(await putStep(deps, token, id, 9, stepImage(v3.steps[0]))); // 404
      record(await putLogo(deps, token, id, new TextEncoder().encode("<html>"))); // 400
      record(await putLogo(deps, token, id, logoPng()));
      const done = await commit(deps, token, id);
      record(done);
      record(await commit(deps, token, id));
      record(await abort(deps, token, id));
      record(await createUpload(deps, token, { version: 9 }));
      record(await send(deps, "GET", "/api/v1/tours", { token }));
      record(await send(deps, "GET", "/api/v1/me", { token }));
      if (done.status === 201) {
        const step = await deps.db.first<{ id: string }>("SELECT id FROM step WHERE chapter_id = ?", [done.json.chapter_id]);
        record(await send(deps, "GET", `/api/v1/tours/${done.json.tour_id}/steps/${step!.id}/image`, { token }));
      }
    }
    // A failure inside a route answers the generic error.
    deps.drafts.put = async () => {
      throw new Error("failed for " + a.token);
    };
    const id2 = (await createUpload(deps, a.token, v2)).json.upload_id;
    const failed = await putStep(deps, a.token, id2, 1, stepImage(v2.steps[0]));
    expect(failed.status).toBe(500);
    record(failed);
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" ")));
    for (const text of [...bodies, ...logged]) {
      expect(text).not.toContain(a.token);
      expect(text).not.toContain(a.token.slice(3));
      expect(text).not.toContain(hash);
    }
  });
});
