// Every route, driven to its worst case within the caps, stays at or under the call budget
// (src/budget.ts): 200 steps per upload, 400 steps per tour, 20 notes per step, and the
// grace-period and workspace sweeps with plenty to clean. Every request the shared suite
// sends is held to the budget by test/bundle.ts as well; these tests make sure the worst
// cases are reached and record the highest count per route.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { metered, SUBREQUEST_BUDGET } from "../src/budget.ts";
import { LIMITS } from "../src/manifest.ts";
import type { Deps } from "../src/ports.ts";
import { COPY_BATCH, MAX_SNAPSHOT_BYTES, STALE_PUBLISH_MS } from "../src/publish.ts";
import { UPLOAD_MAX_AGE_MS } from "../src/uploads.ts";
import { clone, commit, createUpload, fixtures, logoPng, ORIGIN, putLogo, putStep, routeOf, send, sendAll, sha256Hex, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";

const v3 = fixtures.v3 as Json;
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

const highest = new Map<string, number>();
function noted(r: Call, route: string): Call {
  expect(r.calls, route).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
  highest.set(route, Math.max(highest.get(route) ?? 0, r.calls));
  return r;
}
const at = (method: string, path: string) => `${method} ${routeOf(path)}`;
async function call(deps: Deps, method: string, path: string, opts: Parameters<typeof send>[3] = {}): Promise<Call> {
  return noted(await send(deps, method, path, opts), at(method, path));
}

afterEach(() => vi.restoreAllMocks());

/**
 * A manifest of `n` small steps with a spotlight, as many of them carrying
 * LIMITS.notesPerStep notes as the manifest byte cap allows (200 steps of 20 notes each
 * do not fit in one manifest, so the caps cannot all be reached at once).
 */
function heavyManifest(n: number, title = "Heavy", maxBytes: number = LIMITS.manifestBytes): Json {
  const m = clone(v3);
  m.title = title;
  const base = m.steps[0];
  const note = { kind: "text", x: 1, y: 1, text: "n", size: 3, color: "#ffffff" };
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120, card: null, notes: [] }));
  const size = () => new TextEncoder().encode(JSON.stringify(m)).byteLength;
  for (const st of m.steps) {
    st.notes = Array.from({ length: LIMITS.notesPerStep }, () => ({ ...note }));
    if (size() > maxBytes) {
      st.notes = [];
      break;
    }
  }
  return m;
}

async function clocked(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps({ retiredGraceMs: 10 * 60_000, ...config });
  const a = await seedWorkspace(ctx.deps, "Workspace A");
  let now = T0;
  ctx.deps.now = () => now;
  return { ...ctx, a, advance: (ms: number) => (now += ms), now: () => now };
}

const publishPath = (tourId: string) => `/api/v1/tours/${tourId}/publish`;
const resumeOpts = (token: string, id: string) => ({ token, body: JSON.stringify({ publish_id: id }), headers: { "content-type": "application/json" } });

/** Runs a publish to the end, noting every call. */
async function publishAll(deps: Deps, token: string, tourId: string): Promise<Call[]> {
  let r = await call(deps, "POST", publishPath(tourId), { token });
  const calls = [r];
  while (r.status === 202) {
    r = await call(deps, "POST", publishPath(tourId), resumeOpts(token, r.json.publish_id));
    calls.push(r);
  }
  return calls;
}

/** Manifest bytes per half of the 400-step tour, so its snapshot stays just under MAX_SNAPSHOT_BYTES. */
const TOUR_PART_BYTES = 235_000;

/** A 400-step tour of heavy steps, the largest that can be published: two uploads of 200. */
async function tour400(deps: Deps, token: string, fill = 0): Promise<string> {
  const first = await uploadTour(deps, token, heavyManifest(200, "Part 1", TOUR_PART_BYTES), { kind: "new" }, fill);
  await uploadTour(deps, token, heavyManifest(200, "Part 2", TOUR_PART_BYTES), { kind: "chapter", tour_id: first.tour_id }, fill + 1);
  return first.tour_id;
}

/**
 * Plenty for the sweeps: `perTour` retired keys past their grace on this tour and on
 * `others` other tours of the workspace, and a stale pending publish of 400 images on one
 * more. Rows only: deleting a key that was never written is not an error.
 */
async function seedLeftovers(deps: Deps, workspaceId: string, tourId: string, others: number, perTour: number, now: number): Promise<string[]> {
  const tours = [tourId];
  for (let i = 0; i < others + 1; i++) {
    const id = "tour_" + (i + 1).toString(16).padStart(24, "e");
    await deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'Other', ?, 'draft', 1, 1)", [id, workspaceId, "zz" + String(i).padStart(8, "2")]);
    tours.push(id);
  }
  const keys = (tour: number, n: number) => JSON.stringify(Array.from({ length: n }, (_, k) => `p/${tour.toString(16).padStart(8, "0")}${k.toString(16).padStart(24, "0")}.png`));
  for (let i = 0; i < others + 1; i++) {
    await deps.db.run(
      "INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after) SELECT value, ?, 'pub_old', 'retired', ?, ? FROM json_each(?)",
      [tours[i], now - HOUR, now - HOUR + i, keys(i + 1, perTour)],
    );
  }
  const stale = tours[others + 1];
  await deps.db.run(
    "INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, source_key, seq) SELECT value, ?, 'pub_dead', 'pending', ?, 'u/x/step-001.png', key FROM json_each(?)",
    [stale, now - STALE_PUBLISH_MS - HOUR, keys(99, 400)],
  );
  return tours;
}

describe("the call budget, route by route", () => {
  it("setup: check, claim and the connected check", async () => {
    const { deps } = await makeDeps({ setupCode: "correct-horse-battery-staple" });
    const headers = { "content-type": "application/json", origin: ORIGIN };
    const body = (o: unknown) => ({ body: JSON.stringify(o), headers });
    expect((await call(deps, "POST", "/setup/check", body({ code: "correct-horse-battery-staple" }))).status).toBe(204);
    expect((await call(deps, "POST", "/setup/check", body({ code: "wrong-wrong-wrong-wrong" }))).status).toBe(403);
    const claimed = await call(deps, "POST", "/setup/claim", body({ code: "correct-horse-battery-staple", workspace: "Acme", email: "owner@example.com" }));
    expect(claimed.status).toBe(201);
    expect((await call(deps, "POST", "/setup/claim", body({ code: "correct-horse-battery-staple", workspace: "Acme", email: "o2@example.com" }))).status).toBe(404);
    expect((await call(deps, "GET", "/api/v1/setup/connected", { token: claimed.json.token })).status).toBe(200);
    expect((await call(deps, "GET", "/healthz")).status).toBe(200);
    expect((await call(deps, "GET", "/api/v1/me", { token: claimed.json.token })).status).toBe(200);
  });

  it("uploads: create with five stale 200-step uploads to sweep, every step, the logo, commit, abort", async () => {
    const { deps, a, advance } = await clocked({ maxOpenUploads: 5 });
    const big = heavyManifest(200);
    // Five full-size uploads, every step sent, then left for more than a day.
    for (let i = 0; i < 5; i++) await sendAll(deps, a.token, big, { kind: "new" }, i);
    advance(UPLOAD_MAX_AGE_MS + HOUR);
    // Plenty for the publish housekeeping that rides on this request too.
    const anchor = "tour_" + "d".repeat(24);
    await deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'Anchor', 'anchor2222', 'draft', 1, 1)", [anchor, a.workspaceId]);
    await seedLeftovers(deps, a.workspaceId, anchor, 5, 1500, deps.now());
    const created = await call(deps, "POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ manifest: big, target: { kind: "new" } }), headers: { "content-type": "application/json" } });
    expect(created.status).toBe(201);
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM upload"))!.n).toBe(1);
    const id = created.json.upload_id as string;
    for (let n = 1; n <= 200; n++) noted(await putStep(deps, a.token, id, n, stepImage(big.steps[n - 1])), "PUT /api/v1/uploads/:id/steps/:n");
    noted(await putStep(deps, a.token, id, 1, stepImage(big.steps[0])), "PUT /api/v1/uploads/:id/steps/:n"); // a second send: 409
    noted(await putLogo(deps, a.token, id, logoPng()), "PUT /api/v1/uploads/:id/logo");
    const done = noted(await commit(deps, a.token, id), "POST /api/v1/uploads/:id/commit");
    expect(done.status).toBe(201);
    expect(noted(await commit(deps, a.token, id), "POST /api/v1/uploads/:id/commit").status).toBe(201); // repeated

    // A commit whose new tour collides on its slug every time but the last.
    const id2 = await sendAll(deps, a.token, big, { kind: "new" }, 7);
    const realBatch = deps.db.batch.bind(deps.db);
    let fails = 0;
    deps.db.batch = async (stmts) => {
      if (stmts.some((s) => s.sql.startsWith("INSERT INTO tour ")) && fails++ < 4) throw new Error("UNIQUE constraint failed: tour.slug");
      return realBatch(stmts);
    };
    expect(noted(await commit(deps, a.token, id2), "POST /api/v1/uploads/:id/commit").status).toBe(201);
    deps.db.batch = realBatch;
    expect(fails).toBe(5);

    // A step whose upload is aborted while its image is being written.
    const id3 = (await createUpload(deps, a.token, big)).json.upload_id as string;
    const realPut = deps.drafts.put.bind(deps.drafts);
    deps.drafts.put = async (k, b, m) => {
      await deps.db.run("UPDATE upload SET closing_at = 1 WHERE id = ?", [id3]);
      return realPut(k, b, m);
    };
    noted(await putStep(deps, a.token, id3, 1, stepImage(big.steps[0])), "PUT /api/v1/uploads/:id/steps/:n");
    deps.drafts.put = realPut;

    // Abort of a full upload.
    const id4 = await sendAll(deps, a.token, big, { kind: "new" }, 9);
    expect((await call(deps, "DELETE", `/api/v1/uploads/${id4}`, { token: a.token })).status).toBe(204);

    // The tour list with many tours, and a draft image.
    for (let i = 0; i < 40; i++) {
      await deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'T', ?, 'draft', 1, 1)", ["tour_" + i.toString(16).padStart(24, "c"), a.workspaceId, "yy" + String(i).padStart(8, "0")]);
    }
    expect((await call(deps, "GET", "/api/v1/tours", { token: a.token })).status).toBe(200);
    const step = (await deps.db.first<{ id: string; tour_id: string }>("SELECT id, tour_id FROM step LIMIT 1"))!;
    expect((await call(deps, "GET", `/api/v1/tours/${step.tour_id}/steps/${step.id}/image`, { token: a.token })).status).toBe(200);
  }, 600_000);

  it("replace: create with five stale 200-step uploads to sweep and 200 pictures to match, the changed steps, commit with 200 pictures to remove, all within the budget", async () => {
    const ctx = await clocked({ maxOpenUploads: 5 });
    const { deps, a, advance } = ctx;
    const big = heavyManifest(200);
    const STEP ="PUT /api/v1/uploads/:id/steps/:n";
    const COMMIT = "POST /api/v1/uploads/:id/commit";
    const jsonBody = (o: unknown) => ({ token: a.token, body: JSON.stringify(o), headers: { "content-type": "application/json" } });
    // A 200-step tour whose pictures all differ, so each has its own hash.
    const first = (await createUpload(deps, a.token, big)).json.upload_id as string;
    for (let n = 1; n <= 200; n++) expect((await putStep(deps, a.token, first, n, stepImage(big.steps[n - 1], n))).status).toBe(204);
    expect((await putLogo(deps, a.token, first, logoPng())).status).toBe(204);
    const t = (await commit(deps, a.token, first)).json as { tour_id: string; chapter_id: string };
    const target = { kind: "replace", tour_id: t.tour_id, chapter_id: t.chapter_id };
    const hashes = await Promise.all(big.steps.map((s: Json, i: number) => sha256Hex(stepImage(s, i + 1))));
    // Five full-size uploads left for more than a day, and plenty for the publish housekeeping.
    for (let i = 0; i < 5; i++) await sendAll(deps, a.token, big, { kind: "new" }, 210 + i);
    advance(UPLOAD_MAX_AGE_MS + HOUR);
    await seedLeftovers(deps, a.workspaceId, t.tour_id, 5, 1500, deps.now());

    // Create: the sweep, the housekeeping, and all 200 pictures matched and recorded.
    const same = await call(deps, "POST", "/api/v1/uploads", jsonBody({ manifest: big, target, sha256: hashes }));
    expect(same.status).toBe(201);
    expect(same.json.have).toHaveLength(200);
    // 2 authentication, the chapter, 26 for the sweep, 4 housekeeping, the pictures, the batch, one look.
    expect(same.calls).toBe(36);
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM upload"))!.n).toBe(1);
    noted(await putStep(deps, a.token, same.json.upload_id, 7, stepImage(big.steps[6], 7)), STEP); // 409: the chapter has it
    // An abort of it deletes none of the 200 pictures it points at.
    expect((await call(deps, "DELETE", `/api/v1/uploads/${same.json.upload_id}`, { token: a.token })).status).toBe(204);
    expect(await ctx.draftKeys()).toHaveLength(201);
    // The same again, committed: no picture to send, and only the previous logo to remove
    // (the chapter is the tour's first, so the settings and the logo come with it).
    const kept = await call(deps, "POST", "/api/v1/uploads", jsonBody({ manifest: big, target, sha256: hashes }));
    expect(kept.json.settings).toBe(true);
    expect(noted(await putLogo(deps, a.token, kept.json.upload_id, logoPng()), "PUT /api/v1/uploads/:id/logo").status).toBe(204);
    expect(noted(await commit(deps, a.token, kept.json.upload_id), COMMIT).status).toBe(201);
    expect(noted(await commit(deps, a.token, kept.json.upload_id), COMMIT).status).toBe(201); // repeated
    expect(await ctx.draftKeys()).toHaveLength(201);

    // 200 changed steps: every one sent, and the commit has 200 pictures to remove,
    // with as many again left over from elsewhere in the workspace.
    const leftovers = JSON.stringify(Array.from({ length: 300 }, (_, i) => `u/up_${"0".repeat(24)}/left-${String(i).padStart(3, "0")}.png`));
    await deps.db.run("INSERT INTO replaced_object (tour_id, image_key, draft_version, created_at) SELECT ?, value, 1, 1 FROM json_each(?)", ["tour_" + "e".repeat(23) + "1", leftovers]);
    const changed = await call(deps, "POST", "/api/v1/uploads", jsonBody({ manifest: big, target, sha256: hashes.map((h: string) => h.replace(/^./, (c) => (c === "0" ? "1" : "0"))) }));
    expect(changed.json.have).toEqual([]);
    for (let n = 1; n <= 200; n++) noted(await putStep(deps, a.token, changed.json.upload_id, n, stepImage(big.steps[n - 1], 255 - (n % 50))), STEP);
    expect(noted(await commit(deps, a.token, changed.json.upload_id), COMMIT).status).toBe(409); // the logo is still to come
    expect(noted(await putLogo(deps, a.token, changed.json.upload_id, logoPng()), "PUT /api/v1/uploads/:id/logo").status).toBe(204);
    const done = noted(await commit(deps, a.token, changed.json.upload_id), COMMIT);
    expect(done.status).toBe(201);
    expect(done.json.steps).toBe(200);
    // 2 authentication, the upload, its stored steps, the batch, the answer, 3 to remove a page.
    expect(done.calls).toBe(9);
    expect(await ctx.draftKeys()).toHaveLength(201);
    // The 200 pictures and the previous logo went first; the rest of the page came from the leftovers.
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM replaced_object"))!.n).toBe(251);

    // A second replace of the same chapter that commits too late: refused, within the budget.
    const late = await call(deps, "POST", "/api/v1/uploads", jsonBody({ manifest: big, target }));
    const winner = await call(deps, "POST", "/api/v1/uploads", jsonBody({ manifest: heavyManifest(1, "One"), target }));
    noted(await putStep(deps, a.token, winner.json.upload_id, 1, stepImage(big.steps[0], 3)), STEP);
    for (const up of [winner, late]) expect((await putLogo(deps, a.token, up.json.upload_id, logoPng())).status).toBe(204);
    expect(noted(await commit(deps, a.token, winner.json.upload_id), COMMIT).status).toBe(201);
    for (let n = 1; n <= 200; n++) await putStep(deps, a.token, late.json.upload_id, n, stepImage(big.steps[n - 1], 9));
    const refused = noted(await commit(deps, a.token, late.json.upload_id), COMMIT);
    expect([refused.status, refused.json.error]).toEqual([409, "chapter_changed"]);
    // The tour list removes a page of what is left.
    expect((await call(deps, "GET", "/api/v1/tours", { token: a.token })).status).toBe(200);
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM replaced_object"))!.n).toBe(0);
  }, 600_000);

  it("publish: every call of a 400-step tour of 20 notes per step, with plenty to sweep, then a re-publish and unpublish", async () => {
    const { deps, a, now, advance } = await clocked();
    const tourId = await tour400(deps, a.token);
    await seedLeftovers(deps, a.workspaceId, tourId, 5, 1500, now());
    const calls = await publishAll(deps, a.token, tourId);
    expect(calls.at(-1)!.status).toBe(200);
    expect(calls.at(-1)!.json.steps).toBe(400);
    expect(calls).toHaveLength(Math.ceil(401 / COPY_BATCH)); // 400 steps and the logo
    // The snapshot is near its cap, so the first call did about the most work it ever can.
    const size = (await deps.db.first<{ n: number }>("SELECT length(CAST(data AS BLOB)) AS n FROM snapshot WHERE tour_id = ?", [tourId]))!.n;
    expect(size).toBeGreaterThan(MAX_SNAPSHOT_BYTES * 0.85);
    expect(size).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    // Publish again over the published tour: the old images are retired with grace.
    advance(1000);
    expect((await publishAll(deps, a.token, tourId)).at(-1)!.status).toBe(200);
    // Once more, so a third set is in its grace, then start a fourth and unpublish half-way:
    // unpublish has the live 401, two retired sets and the pending ones to remove.
    advance(1000);
    expect((await publishAll(deps, a.token, tourId)).at(-1)!.status).toBe(200);
    const half = await call(deps, "POST", publishPath(tourId), { token: a.token });
    for (let i = 0; i < 10; i++) await call(deps, "POST", publishPath(tourId), resumeOpts(a.token, half.json.publish_id));
    let u = await call(deps, "POST", `/api/v1/tours/${tourId}/unpublish`, { token: a.token });
    while (u.status === 202) u = await call(deps, "POST", `/api/v1/tours/${tourId}/unpublish`, { token: a.token });
    expect(u.status).toBe(204);
    expect((await call(deps, "POST", publishPath(tourId), resumeOpts(a.token, half.json.publish_id))).status).toBe(409);
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM public_object WHERE tour_id = ?", [tourId]))!.n).toBe(0);
  }, 600_000);

  it("publish: the failure paths of a large publish stay in the budget", async () => {
    const { deps, a } = await clocked({ retiredGraceMs: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tourId = await tour400(deps, a.token);
    await seedLeftovers(deps, a.workspaceId, tourId, 5, 1500, deps.now());
    // A copy that fails on the first call, after the start.
    const realGet = deps.drafts.get.bind(deps.drafts);
    let gets = 0;
    deps.drafts.get = async (k) => {
      if (++gets === COPY_BATCH) throw new Error("bucket unavailable");
      return realGet(k);
    };
    expect((await call(deps, "POST", publishPath(tourId), { token: a.token })).status).toBe(500);
    deps.drafts.get = realGet;
    // A commit batch that fails, with the store failing too, on the final call.
    let r = await call(deps, "POST", publishPath(tourId), { token: a.token });
    const id = r.json.publish_id as string;
    while (r.json.done + COPY_BATCH < r.json.total) r = await call(deps, "POST", publishPath(tourId), resumeOpts(a.token, id));
    const realBatch = deps.db.batch.bind(deps.db);
    deps.db.batch = async (stmts) => {
      if (stmts[0].sql.includes("INSERT INTO snapshot ")) throw new Error("database unavailable");
      return realBatch(stmts);
    };
    expect((await call(deps, "POST", publishPath(tourId), resumeOpts(a.token, id))).status).toBe(500);
    deps.db.batch = realBatch;
    // A publish cancelled between its copies and its mark: the call finds out and cleans up.
    const c1 = await call(deps, "POST", publishPath(tourId), { token: a.token });
    const realPut = deps.pub.put.bind(deps.pub);
    let puts = 0;
    deps.pub.put = async (k, b, m) => {
      if (++puts === COPY_BATCH) await deps.db.run("UPDATE public_object SET state = 'retired', delete_after = 0 WHERE state = 'pending'");
      return realPut(k, b, m);
    };
    expect((await call(deps, "POST", publishPath(tourId), resumeOpts(a.token, c1.json.publish_id))).status).toBe(409);
    deps.pub.put = realPut;
    // Two calls of the same publish at once, to the end.
    const d1 = await call(deps, "POST", publishPath(tourId), { token: a.token });
    for (;;) {
      const rs = await Promise.all([0, 1].map(() => send(deps, "POST", publishPath(tourId), resumeOpts(a.token, d1.json.publish_id))));
      for (const x of rs) noted(x, at("POST", publishPath(tourId)));
      if (rs.every((x) => x.status === 200)) break;
    }
  }, 600_000);

  it("publish: a call that joins another start, then fails its commit, stays in the budget", async () => {
    const { deps, a } = await clocked({ retiredGraceMs: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tourId = (await uploadTour(deps, a.token, heavyManifest(20, "Twenty"), { kind: "new" }, 1)).tour_id; // 21 images with the logo
    await seedLeftovers(deps, a.workspaceId, tourId, 5, 1500, deps.now());
    const realBatch = deps.db.batch.bind(deps.db);
    let raced = false;
    deps.db.batch = async (stmts) => {
      if (!raced && stmts[0].sql.startsWith("INSERT INTO publish_job")) {
        // Another start of the same tour lands first, so this one joins it.
        raced = true;
        expect((await send(deps, "POST", publishPath(tourId), { token: a.token })).status).toBe(202);
      }
      if (stmts[0].sql.includes("INSERT INTO snapshot ")) throw new Error("database unavailable");
      return realBatch(stmts);
    };
    const r = await call(deps, "POST", publishPath(tourId), { token: a.token });
    deps.db.batch = realBatch;
    expect(raced).toBe(true);
    expect(r.status).toBe(500);
  }, 300_000);

  it("publish: start, unpublish, another start, then a joining call whose commit fails, stays in the budget", async () => {
    const { deps, a } = await clocked({ retiredGraceMs: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tourId = (await uploadTour(deps, a.token, heavyManifest(20, "Twenty"), { kind: "new" }, 1)).tour_id;
    await seedLeftovers(deps, a.workspaceId, tourId, 5, 1500, deps.now());
    const realBatch = deps.db.batch.bind(deps.db);
    let raced = false;
    deps.db.batch = async (stmts) => {
      if (!raced && stmts[0].sql.startsWith("INSERT INTO publish_job")) {
        raced = true;
        await send(deps, "POST", publishPath(tourId), { token: a.token }); // start A
        await send(deps, "POST", `/api/v1/tours/${tourId}/unpublish`, { token: a.token }); // cancels A
        await send(deps, "POST", publishPath(tourId), { token: a.token }); // start C
      }
      if (stmts[0].sql.includes("INSERT INTO snapshot ")) throw new Error("database unavailable");
      return realBatch(stmts);
    };
    const r = await call(deps, "POST", publishPath(tourId), { token: a.token });
    deps.db.batch = realBatch;
    expect(raced).toBe(true);
    expect([409, 500]).toContain(r.status);
  }, 300_000);

  it("publish: a fresh start that cancels a publish of an older draft stays in the budget", async () => {
    const { deps, a } = await clocked();
    // 399 steps, a publish started, then a 400th step in a new chapter: the next fresh start
    // stops the old publish and starts a new one, copies and answers, all in one request.
    const tourId = (await uploadTour(deps, a.token, heavyManifest(199, "Part 1", TOUR_PART_BYTES), { kind: "new" }, 0)).tour_id;
    await uploadTour(deps, a.token, heavyManifest(200, "Part 2", TOUR_PART_BYTES), { kind: "chapter", tour_id: tourId }, 1);
    await seedLeftovers(deps, a.workspaceId, tourId, 5, 1500, deps.now());
    const old = await call(deps, "POST", publishPath(tourId), { token: a.token });
    expect(old.status).toBe(202);
    await uploadTour(deps, a.token, heavyManifest(1, "One more", 20_000), { kind: "chapter", tour_id: tourId }, 7);
    const fresh = await call(deps, "POST", publishPath(tourId), { token: a.token });
    expect(fresh.status).toBe(202);
    expect(fresh.json.publish_id).not.toBe(old.json.publish_id);
    expect(fresh.json.total).toBe(401);
  }, 600_000);

  it("publish: a fresh start that cancels a publish of an older draft, then loses its own start to an upload and starts again, stays in the budget", async () => {
    const { deps, a } = await clocked();
    // 398 steps and a publish started; a 399th step makes that publish one of an older
    // draft. The next fresh start stops it, reads the draft, loses the job to a 400th step
    // that commits at that moment, reads the draft again, starts, copies and answers.
    const tourId = (await uploadTour(deps, a.token, heavyManifest(198, "Part 1", TOUR_PART_BYTES), { kind: "new" }, 0)).tour_id;
    await uploadTour(deps, a.token, heavyManifest(200, "Part 2", TOUR_PART_BYTES), { kind: "chapter", tour_id: tourId }, 1);
    await seedLeftovers(deps, a.workspaceId, tourId, 5, 1500, deps.now());
    const old = await call(deps, "POST", publishPath(tourId), { token: a.token });
    expect(old.status).toBe(202);
    await uploadTour(deps, a.token, heavyManifest(1, "One more", 20_000), { kind: "chapter", tour_id: tourId }, 7);
    const last = await sendAll(deps, a.token, heavyManifest(1, "And another", 20_000), { kind: "chapter", tour_id: tourId }, 8);
    const realBatch = deps.db.batch.bind(deps.db);
    let raced = 0;
    deps.db.batch = async (stmts) => {
      if (raced === 0 && stmts[0].sql.startsWith("INSERT INTO publish_job")) {
        raced++;
        expect((await commit(deps, a.token, last)).status).toBe(201);
      }
      return realBatch(stmts);
    };
    const fresh = await call(deps, "POST", publishPath(tourId), { token: a.token });
    deps.db.batch = realBatch;
    expect(raced).toBe(1);
    expect(fresh.status).toBe(202);
    expect(fresh.json.total).toBe(401);
    // 2 authentication, 4 housekeeping, the state, 4 to stop the old publish, 2 for the start
    // that lost, one look, 2 for the start that won, then copies sized from what is left
    // (each a read and a write) and the 2 that mark them.
    expect(fresh.calls).toBe(16 + 2 * fresh.json.done + 2);
    expect(fresh.json.done).toBe(9);
    // Losing twice answers 409 after 2 + 4 + 1 + 2 + 1 + 2 + 1 calls and copies nothing.
    expect((await call(deps, "POST", `/api/v1/tours/${tourId}/unpublish`, { token: a.token })).status).toBeLessThan(300);
    let lost = 0;
    deps.db.batch = async (stmts) => {
      if (lost < 2 && stmts[0].sql.startsWith("INSERT INTO publish_job")) await deps.db.run("UPDATE tour SET draft_version = draft_version + 1 WHERE id = ?", [tourId]).then(() => lost++);
      return realBatch(stmts);
    };
    const twice = await call(deps, "POST", publishPath(tourId), { token: a.token });
    deps.db.batch = realBatch;
    expect(lost).toBe(2);
    expect([twice.status, twice.json.error]).toEqual([409, "publish_busy"]);
    expect(twice.calls).toBe(13);
  }, 600_000);

  it("manage: rename with a publish in progress near the snapshot cap; delete of a 400-step tour published twice, with open uploads into it, an abandoned publish and plenty to sweep", async () => {
    const { deps, a, now, advance } = await clocked();
    const tourId = await tour400(deps, a.token);
    const tourPath = `/api/v1/tours/${tourId}`;
    expect((await publishAll(deps, a.token, tourId)).at(-1)!.status).toBe(200);
    advance(1000);
    expect((await publishAll(deps, a.token, tourId)).at(-1)!.status).toBe(200);
    advance(1000);
    // A third publish half-way: the rename rewrites the live snapshot and the job's, both near the cap.
    const half = await call(deps, "POST", publishPath(tourId), { token: a.token });
    expect(half.status).toBe(202);
    const renamed = await call(deps, "PATCH", tourPath, { token: a.token, body: JSON.stringify({ title: "é".repeat(LIMITS.title) }), headers: { "content-type": "application/json" } });
    expect(renamed.status).toBe(200);
    expect((await call(deps, "PATCH", tourPath, { token: a.token, body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
    // Delete while that publish is in progress: refused, after the housekeeping it runs to make sure.
    expect((await call(deps, "DELETE", tourPath, { token: a.token })).status).toBe(409);
    // Two full uploads into the tour, every step sent, never committed.
    for (let i = 0; i < 2; i++) await sendAll(deps, a.token, heavyManifest(200, "More", TOUR_PART_BYTES), { kind: "chapter", tour_id: tourId }, 3 + i);
    // The publish is abandoned, and the workspace has plenty to sweep besides.
    advance(STALE_PUBLISH_MS + HOUR);
    await seedLeftovers(deps, a.workspaceId, tourId, 5, 1500, now());
    let d = await call(deps, "DELETE", tourPath, { token: a.token });
    let n = 1;
    for (; d.status === 202; n++) {
      expect(d.json.total).toBeGreaterThan(2000); // 401 draft files, 800 of the uploads, and the public ones
      d = await call(deps, "DELETE", tourPath, { token: a.token });
    }
    expect(d.status).toBe(200);
    expect(n).toBeGreaterThan(8);
    expect((await call(deps, "DELETE", tourPath, { token: a.token })).status).toBe(404);
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM deleted_object"))!.n).toBe(0);
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM step"))!.n).toBe(0);
  }, 600_000);

  it("rows written: a 400-step publish writes each image's row a bounded number of times", async () => {
    const { deps, a } = await clocked();
    const tourId = await tour400(deps, a.token);
    // Count rows changed by every statement, running a batch's statements one by one (this
    // test makes no concurrent calls, so their order is all that matters).
    const real = deps.db;
    let rows = 0;
    deps.db = {
      all: (s, p) => real.all(s, p),
      first: (s, p) => real.first(s, p),
      run: async (s, p) => {
        const r = await real.run(s, p);
        rows += r.changes;
        return r;
      },
      batch: async (stmts) => {
        for (const st of stmts) rows += (await real.run(st.sql, st.params)).changes;
      },
    };
    const perCall: number[] = [];
    let r = await send(deps, "POST", publishPath(tourId), { token: a.token });
    perCall.push(rows);
    while (r.status === 202) {
      const before = rows;
      r = await send(deps, "POST", publishPath(tourId), resumeOpts(a.token, r.json.publish_id));
      perCall.push(rows - before);
    }
    deps.db = real;
    expect(r.status).toBe(200);
    const total = perCall.reduce((x, y) => x + y, 0);
    console.log(`rows written for a 400-step publish: ${total} (first call ${perCall[0]}, middle calls ${perCall[1]}, final ${perCall.at(-1)})`);
    // Every middle call writes its token touch, its last-used touch, the job heartbeat and one row per image copied.
    for (const n of perCall.slice(1, -1)) expect(n).toBeLessThanOrEqual(COPY_BATCH + 3);
    expect(total).toBeLessThan(3000);
  }, 600_000);

  it("the page, the public images and a publish that is too large stay in the budget", async () => {
    const { deps, a } = await clocked();
    const tourId = await tour400(deps, a.token);
    await publishAll(deps, a.token, tourId);
    const slug = (await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [tourId]))!.slug;
    expect((await call(deps, "GET", `/t/${slug}`)).status).toBe(200);
    const key = (await deps.db.first<{ image_key: string }>("SELECT image_key FROM snapshot_object"))!.image_key;
    expect((await call(deps, "GET", "/" + key)).status).toBe(200);
    expect((await call(deps, "GET", "/p/" + "0".repeat(32) + ".png")).status).toBe(404);
    // A 401st step: refused before anything is written.
    await uploadTour(deps, a.token, heavyManifest(1, "One more"), { kind: "chapter", tour_id: tourId }, 5);
    expect((await call(deps, "POST", publishPath(tourId), { token: a.token })).status).toBe(413);
  }, 600_000);

  it("the meter counts a batch and a delete of up to 1,000 keys as one call each", async () => {
    const { deps } = await makeDeps();
    const m = metered(deps);
    await m.deps.db.batch([{ sql: "SELECT 1" }, { sql: "SELECT 2" }, { sql: "SELECT 3" }]);
    expect(m.calls()).toBe(1);
    await m.deps.pub.delete(Array.from({ length: 1000 }, (_, i) => `p/${i}.png`));
    expect(m.calls()).toBe(2);
    await m.deps.pub.delete(Array.from({ length: 1001 }, (_, i) => `p/${i}.png`));
    expect(m.calls()).toBe(4);
    await m.deps.drafts.get("u/x/a.png");
    await m.deps.db.first("SELECT 1");
    expect(m.calls()).toBe(6);
  });

  it("reports the highest count seen per route (run with --silent=false to see it)", () => {
    const rows = [...highest.entries()].sort().map(([route, n]) => `${String(n).padStart(3)}  ${route}`);
    console.log(`calls per request, highest seen (budget ${SUBREQUEST_BUDGET}):\n` + rows.join("\n"));
    expect(Math.max(...highest.values())).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
  });
});
