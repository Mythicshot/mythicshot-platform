// Reordering and removing a tour's chapters (src/chapters.ts), on both targets: the list, the
// change in one batch, its refusals (each changing nothing), what it does to the draft, the
// files, the storage count and "Changes waiting", the first-chapter rule, and every
// interleaving with an upload, a replace and a publish that can be built. Every request goes
// through test/bundle.ts, which holds each one to the call budget.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount, seedWorkspace } from "#harness";
import { newId } from "../src/auth.ts";
import { MAX_CHAPTERS } from "../src/chapters.ts";
import type { Deps, Stmt } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, clone, commit, createUpload, fixtures, logoPng, putLogo, putStep, send, sha256Hex, stepImage, type Call, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
const T0 = 1_800_000_000_000;
const JSON_HEADERS = { "content-type": "application/json" };

type Ws = { workspaceId: string; token: string };
type Target = { tour_id: string; chapter_id: string };

async function setup() {
  const ctx = await makeDeps({ retiredGraceMs: 0 });
  const a: Ws = await seedWorkspace(ctx.deps, "Workspace A");
  const b: Ws = await seedWorkspace(ctx.deps, "Workspace B");
  let now = T0;
  ctx.deps.now = () => now;
  return { ...ctx, a, b, advance: (ms: number) => (now += ms), at: () => now };
}

afterEach(() => vi.restoreAllMocks());

/** A manifest of small PNG steps, one per entry of `pics`: the same number gives the same bytes. */
function manifestOf(pics: number[], title: string, withSettings = false): Json {
  const m = clone(withSettings ? v3 : v2);
  m.title = title;
  const base = withSettings ? v3.steps[0] : v2.steps[1];
  m.steps = pics.map((_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120 }));
  return m;
}
const picture = (m: Json, i: number, pic: number) => stepImage(m.steps[i], pic);

/** A new tour (with a logo and settings when `withSettings`), or a new chapter of `tourId`; committed. */
async function upload(deps: Deps, token: string, pics: number[], title: string, tourId: string | null = null, withSettings = false): Promise<Target> {
  const m = manifestOf(pics, title, withSettings);
  const created = await createUpload(deps, token, m, tourId === null ? { kind: "new" } : { kind: "chapter", tour_id: tourId });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text}`);
  const id = created.json.upload_id as string;
  for (let i = 0; i < pics.length; i++) expect((await putStep(deps, token, id, i + 1, picture(m, i, pics[i]))).status).toBe(204);
  if (withSettings && tourId === null) expect((await putLogo(deps, token, id, logoPng())).status).toBe(204);
  const done = await commit(deps, token, id);
  if (done.status !== 201) throw new Error(`commit failed: ${done.status} ${done.text}`);
  return done.json;
}

/** A replace of `t` with these pictures (hashes sent), its missing steps sent; not committed. */
async function openReplace(deps: Deps, token: string, t: Target, pics: number[], title = "Replaced", withSettings = false): Promise<Call> {
  const m = manifestOf(pics, title, withSettings);
  const sha256 = await Promise.all(pics.map((p, i) => sha256Hex(picture(m, i, p))));
  const created = await send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest: m, target: { kind: "replace", ...t }, sha256 }), headers: JSON_HEADERS });
  if (created.status !== 201) return created;
  for (let i = 0; i < pics.length; i++) {
    if (created.json.have.includes(i + 1)) continue;
    expect((await putStep(deps, token, created.json.upload_id, i + 1, picture(m, i, pics[i]))).status).toBe(204);
  }
  return created;
}

const list = (deps: Deps, token: string | null, tourId: string, headers?: Record<string, string>) => send(deps, "GET", `/api/v1/tours/${tourId}/chapters`, { token, headers });
const change = (deps: Deps, token: string | null, tourId: string, body: unknown, headers?: Record<string, string>) =>
  send(deps, "PUT", `/api/v1/tours/${tourId}/chapters`, { token, body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...JSON_HEADERS, ...headers } });
const publish = (deps: Deps, token: string, tourId: string, publishId?: string) =>
  send(deps, "POST", `/api/v1/tours/${tourId}/publish`, publishId === undefined ? { token } : { token, body: JSON.stringify({ publish_id: publishId }), headers: JSON_HEADERS });
async function publishAll(deps: Deps, token: string, tourId: string): Promise<Call> {
  let r = await publish(deps, token, tourId);
  while (r.status === 202) r = await publish(deps, token, tourId, r.json.publish_id);
  expect(r.status, r.text).toBe(200);
  return r;
}
const tours = async (deps: Deps, token: string) => (await send(deps, "GET", "/api/v1/tours", { token })).json.tours as Json[];
const tourRow = async (deps: Deps, id: string) => (await deps.db.first<Json>("SELECT * FROM tour WHERE id = ?", [id]))!;
const chapterRows = (deps: Deps, tourId: string) => deps.db.all<Json>("SELECT id, title, position FROM chapter WHERE tour_id = ? ORDER BY position, id", [tourId]);
const stepKeys = async (deps: Deps, tourId: string) => (await deps.db.all<{ image_key: string }>("SELECT image_key FROM step WHERE tour_id = ? ORDER BY image_key", [tourId])).map((r) => r.image_key);
const used = async (deps: Deps, token: string) => (await send(deps, "GET", "/api/v1/usage", { token })).json.used_bytes as number;
const snapshotOf = async (deps: Deps, tourId: string) => {
  const row = await deps.db.first<{ data: string }>("SELECT data FROM snapshot WHERE tour_id = ?", [tourId]);
  return row === null ? null : (JSON.parse(row.data) as Json);
};

/** Every row the feature could touch and both stores' keys, to show a refusal changed nothing. */
async function everything(ctx: { deps: Deps; draftKeys: () => Promise<string[]>; publicKeys: () => Promise<string[]> }) {
  const out: Json = {};
  for (const t of ["tour", "chapter", "step", "replaced_object", "upload", "upload_step", "snapshot", "snapshot_object", "public_object", "publish_job"]) {
    out[t] = await ctx.deps.db.all(`SELECT * FROM ${t} ORDER BY rowid`);
  }
  out.drafts = await ctx.draftKeys();
  out.public = await ctx.publicKeys();
  return out;
}

/** A tour of three chapters: First (pictures 1, 2), Second (3, 4, 5), Third (6). */
async function threeChapters(deps: Deps, token: string, withSettings = false) {
  const first = await upload(deps, token, [1, 2], "First", null, withSettings);
  const second = await upload(deps, token, [3, 4, 5], "Second", first.tour_id);
  const third = await upload(deps, token, [6], "Third", first.tour_id);
  return { tour: first.tour_id, first: first.chapter_id, second: second.chapter_id, third: third.chapter_id };
}

describe("chapters: the list", { timeout: 60_000 }, () => {
  it("lists the chapters in the order visitors see them, with steps, pictures, the upload time and the tour's revision", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const made = ctx.at();
    const first = await upload(deps, a.token, [1, 1, 2], "First");
    ctx.advance(60_000);
    const second = await upload(deps, a.token, [3], "Second", first.tour_id);
    const r = await list(deps, a.token, first.tour_id);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      revision: (await tourRow(deps, first.tour_id)).draft_version,
      chapters: [
        { id: first.chapter_id, title: "First", position: 0, steps: 3, pictures: 3, uploaded_at: made },
        { id: second.chapter_id, title: "Second", position: 1, steps: 1, pictures: 1, uploaded_at: made + 60_000 },
      ],
    });
    // A replace is an upload of the chapter: its time is the replace's, and two steps that
    // share one picture count as one picture.
    ctx.advance(60_000);
    const rep = await openReplace(deps, a.token, first, [1, 1]);
    expect(rep.json.have).toEqual([1, 2]);
    expect((await commit(deps, a.token, rep.json.upload_id)).status).toBe(201);
    const after = await list(deps, a.token, first.tour_id);
    expect(after.json.chapters[0]).toEqual({ id: first.chapter_id, title: "First", position: 0, steps: 2, pictures: 1, uploaded_at: made + 120_000 });
    expect(after.json.revision).toBe(r.json.revision + 1);
  });

  it("answers another workspace's tour, an unknown one and a malformed id exactly alike", async () => {
    const { deps, a, b } = await setup();
    const theirs = await upload(deps, b.token, [1], "Theirs");
    const answers = [await list(deps, a.token, theirs.tour_id), await list(deps, a.token, "tour_" + "0".repeat(24)), await list(deps, a.token, "nope")];
    for (const r of answers) expect([r.status, r.text]).toEqual([404, '{"error":"not_found","detail":"no such tour"}']);
    expect((await list(deps, null, theirs.tour_id)).status).toBe(401);
  });
});

describe("chapters: a change", { timeout: 120_000 }, () => {
  it("reorders in one batch: positions from 0 without gaps, the draft one version on, the public page unchanged until the next publish", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token, true);
    await publishAll(deps, a.token, t.tour);
    const before = { tour: await tourRow(deps, t.tour), snapshot: await snapshotOf(deps, t.tour), drafts: await ctx.draftKeys(), used: await used(deps, a.token) };
    expect((await tours(deps, a.token))[0].unpublished_changes).toBe(false);
    const revision = (await list(deps, a.token, t.tour)).json.revision;
    const r = await change(deps, a.token, t.tour, { revision, chapters: [t.third, t.first, t.second] });
    expect(r.status, r.text).toBe(200);
    expect(r.json.revision).toBe(revision + 1);
    expect(r.json.chapters.map((c: Json) => [c.id, c.position])).toEqual([[t.third, 0], [t.first, 1], [t.second, 2]]);
    expect((await chapterRows(deps, t.tour)).map((c) => [c.id, c.position])).toEqual([[t.third, 0], [t.first, 1], [t.second, 2]]);
    // Nothing else of the tour changed: no file, no step, no setting, no byte of the count.
    expect(await ctx.draftKeys()).toEqual(before.drafts);
    expect(await used(deps, a.token)).toBe(before.used);
    const after = await tourRow(deps, t.tour);
    expect({ ...after, draft_version: 0, updated_at: 0 }).toEqual({ ...before.tour, draft_version: 0, updated_at: 0 });
    // Visitors see the old order until the tour is published again, and the list says so as after a replace.
    expect(await snapshotOf(deps, t.tour)).toEqual(before.snapshot);
    expect((await tours(deps, a.token))[0].unpublished_changes).toBe(true);
    await publishAll(deps, a.token, t.tour);
    expect((await snapshotOf(deps, t.tour))!.chapters.map((c: Json) => c.title)).toEqual(["Third", "First", "Second"]);
    expect((await tours(deps, a.token))[0].unpublished_changes).toBe(false);
  });

  it("removes chapters: their steps and rows go, their files are deleted, the storage count drops by their bytes, and the rest close up", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token, true);
    const logo = (await tourRow(deps, t.tour)).logo_key as string;
    const usedBefore = await used(deps, a.token);
    const revision = (await list(deps, a.token, t.tour)).json.revision;
    const r = await change(deps, a.token, t.tour, { revision, chapters: [t.third, t.first] });
    expect(r.status, r.text).toBe(200);
    expect(r.json.chapters.map((c: Json) => [c.title, c.position, c.steps])).toEqual([["Third", 0, 1], ["First", 1, 2]]);
    expect(await deps.db.all("SELECT id FROM step WHERE chapter_id = ?", [t.second])).toEqual([]);
    expect(await deps.db.all("SELECT id FROM chapter WHERE id = ?", [t.second])).toEqual([]);
    // Every file still named is a step's or the logo; the removed chapter's three are gone, from the store and from replaced_object.
    expect(await ctx.draftKeys()).toEqual([...(await stepKeys(deps, t.tour)), logo].sort());
    expect(await ctx.draftKeys()).toHaveLength(4);
    expect(await deps.db.all("SELECT * FROM replaced_object")).toEqual([]);
    expect(await used(deps, a.token)).toBe(usedBefore - 3 * 120);
    expect((await tours(deps, a.token))[0]).toMatchObject({ chapters: 2, steps: 3, bytes: 3 * 120 + 1000 });
    // A draft has nothing waiting to be published.
    expect((await tours(deps, a.token))[0].unpublished_changes).toBe(false);
  });

  it("a list that changes nothing changes nothing, not even the revision", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token);
    const before = await everything(ctx);
    const read = await list(deps, a.token, t.tour);
    const r = await change(deps, a.token, t.tour, { revision: read.json.revision, chapters: [t.first, t.second, t.third] });
    expect([r.status, r.json]).toEqual([200, read.json]);
    expect(await everything(ctx)).toEqual(before);
  });

  it("refuses, changing nothing: no chapter left, an id that is not this tour's, an id twice, too many, a stale revision, a bad body", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const t = await threeChapters(deps, a.token);
    const other = await upload(deps, a.token, [7], "Other tour");
    const theirs = await upload(deps, b.token, [8], "Theirs");
    const revision = (await list(deps, a.token, t.tour)).json.revision;
    const before = await everything(ctx);
    const cases: [unknown, number, Json][] = [
      [{ revision, chapters: [] }, 400, { error: "last_chapter", detail: "a tour keeps at least one chapter; to remove them all, delete the tour" }],
      [{ revision, chapters: [t.first, other.chapter_id] }, 404, { error: "not_found", detail: "no such chapter" }],
      [{ revision, chapters: [t.first, theirs.chapter_id] }, 404, { error: "not_found", detail: "no such chapter" }],
      [{ revision, chapters: [t.first, "ch_" + "0".repeat(24)] }, 404, { error: "not_found", detail: "no such chapter" }],
      [{ revision, chapters: [t.first, "not an id"] }, 404, { error: "not_found", detail: "no such chapter" }],
      [{ revision, chapters: [t.first, t.second, t.first] }, 400, { error: "bad_request", detail: "chapters lists a chapter more than once" }],
      [{ revision, chapters: Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => "ch_" + String(i).padStart(24, "0")) }, 400, { error: "too_many_chapters", detail: `chapters lists more than ${MAX_CHAPTERS} ids` }],
      [{ revision: revision - 1, chapters: [t.first] }, 409, { error: "tour_changed", detail: "the tour changed since its chapters were read (an upload, a replace or another change of its chapters); read them again" }],
      [{ revision: revision + 1, chapters: [t.first] }, 409, { error: "tour_changed", detail: "the tour changed since its chapters were read (an upload, a replace or another change of its chapters); read them again" }],
      [{ chapters: [t.first] }, 400, { error: "bad_request", detail: "revision must be the whole number GET /api/v1/tours/{id}/chapters answered" }],
      [{ revision: 1.5, chapters: [t.first] }, 400, { error: "bad_request", detail: "revision must be the whole number GET /api/v1/tours/{id}/chapters answered" }],
      [{ revision, chapters: t.first }, 400, { error: "bad_request", detail: "chapters must be a list of chapter ids" }],
      [{ revision, chapters: [t.first, 7] }, 400, { error: "bad_request", detail: "chapters must be a list of chapter ids" }],
      ["[1]", 400, { error: "bad_request", detail: 'the body must be JSON such as {"revision": 3, "chapters": ["ch_...", "ch_..."]}' }],
      ["{", 400, { error: "bad_request", detail: 'the body must be JSON such as {"revision": 3, "chapters": ["ch_...", "ch_..."]}' }],
      [JSON.stringify({ revision, chapters: [t.first], pad: "x".repeat(17_000) }), 413, { error: "too_large", detail: "the request is over 16384 bytes" }],
    ];
    for (const [body, status, answer] of cases) {
      const r = await change(deps, a.token, t.tour, body);
      expect([r.status, r.json], JSON.stringify(body).slice(0, 80)).toEqual([status, answer]);
    }
    // Another workspace's tour, an unknown one and a malformed id: the one not-found, before the body's ids are looked at.
    for (const id of [theirs.tour_id, "tour_" + "0".repeat(24), "tour_x"]) {
      const r = await change(deps, a.token, id, { revision, chapters: [theirs.chapter_id] });
      expect([r.status, r.text]).toEqual([404, '{"error":"not_found","detail":"no such tour"}']);
    }
    expect(await everything(ctx)).toEqual(before);
  });

  it("takes a session with the anti-forgery header as the dashboard sends it, and refuses one without", async () => {
    const ctx = await setup();
    const { deps } = ctx;
    const owner = await seedAccount(deps, { admin: true });
    const t = await threeChapters(deps, owner.token);
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), null, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    const page = { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" };
    const read = await list(deps, null, t.tour, { cookie });
    expect(read.status).toBe(200);
    const body = { revision: read.json.revision, chapters: [t.second, t.first, t.third] };
    expect((await change(deps, null, t.tour, body, page)).json.error).toBe("bad_csrf");
    expect((await change(deps, null, t.tour, body, { cookie, "x-csrf-token": await csrfFor(made!.secret) })).json.error).toBe("bad_origin");
    expect((await chapterRows(deps, t.tour)).map((c) => c.id)).toEqual([t.first, t.second, t.third]);
    const done = await change(deps, null, t.tour, body, { ...page, "x-csrf-token": await csrfFor(made!.secret) });
    expect(done.status, done.text).toBe(200);
    expect(done.json.chapters.map((c: Json) => c.id)).toEqual([t.second, t.first, t.third]);
  });

  it("removes a chapter of many pictures in one request, inside the call budget, the files a page at a time", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const keep = await upload(deps, a.token, [1], "Kept");
    const big = Array.from({ length: 140 }, (_, i) => 100 + i);
    const one = await upload(deps, a.token, big, "Big one", keep.tour_id);
    const two = await upload(deps, a.token, big.map((p) => p + 1000), "Big two", keep.tour_id);
    expect(await ctx.draftKeys()).toHaveLength(281);
    const revision = (await list(deps, a.token, keep.tour_id)).json.revision;
    const r = await change(deps, a.token, keep.tour_id, { revision, chapters: [keep.chapter_id] });
    expect(r.status, r.text).toBe(200);
    expect(r.calls).toBeLessThanOrEqual(40);
    // 280 files: more than one page, all gone in this request.
    expect(await ctx.draftKeys()).toEqual(await stepKeys(deps, keep.tour_id));
    expect(await deps.db.all("SELECT * FROM replaced_object")).toEqual([]);
    expect(await deps.db.all("SELECT id FROM chapter WHERE id IN (?, ?)", [one.chapter_id, two.chapter_id])).toEqual([]);
  });
});

describe("chapters: the tour's settings stay on the tour", { timeout: 120_000 }, () => {
  const SETTINGS = ["title", "slug", "status", "spotlight_dim", "theme", "zoom", "cover", "cta", "end_card", "autoplay", "logo_key", "logo_type", "logo_bytes", "access"];
  const settingsOf = (tour: Json) => Object.fromEntries(SETTINGS.map((k) => [k, tour[k]]));

  it("moving and removing the first chapter leaves every setting and the logo as they were", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token, true);
    const before = await tourRow(deps, t.tour);
    const logo = before.logo_key as string;
    let revision = (await list(deps, a.token, t.tour)).json.revision;
    expect((await change(deps, a.token, t.tour, { revision, chapters: [t.second, t.first, t.third] })).status).toBe(200);
    expect(settingsOf(await tourRow(deps, t.tour))).toEqual(settingsOf(before));
    revision += 1;
    expect((await change(deps, a.token, t.tour, { revision, chapters: [t.second, t.third] })).status).toBe(200);
    expect(settingsOf(await tourRow(deps, t.tour))).toEqual(settingsOf(before));
    expect(await ctx.draftKeys()).toContain(logo);
    const snap = (await publishAll(deps, a.token, t.tour)) && (await snapshotOf(deps, t.tour))!;
    expect(snap.chapters.map((c: Json) => c.title)).toEqual(["Second", "Third"]);
    expect(snap.cover.logo).toMatch(/^p\/[0-9a-f]{32}\.png$/);
    expect(snap.theme).toEqual(JSON.parse(before.theme));
  });

  it("afterwards a replace of the new first chapter carries the settings, and one of the former first does not", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token, true);
    const revision = (await list(deps, a.token, t.tour)).json.revision;
    expect((await change(deps, a.token, t.tour, { revision, chapters: [t.second, t.first, t.third] })).status).toBe(200);
    const before = await tourRow(deps, t.tour);

    // The former first chapter: no settings, no logo.
    const old = await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.first }, [1, 9], "Old first", true);
    expect(old.json).toMatchObject({ settings: false });
    expect((await putLogo(deps, a.token, old.json.upload_id, logoPng(900))).json.error).toBe("logo_not_used");
    expect((await commit(deps, a.token, old.json.upload_id)).status).toBe(201);
    expect(settingsOf(await tourRow(deps, t.tour))).toEqual(settingsOf(before));

    // The new first chapter: the manifest's settings and logo.
    const fresh = await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.second }, [3, 4], "New first", true);
    expect(fresh.json).toMatchObject({ settings: true });
    expect((await putLogo(deps, a.token, fresh.json.upload_id, logoPng(900))).status).toBe(204);
    expect((await commit(deps, a.token, fresh.json.upload_id)).status).toBe(201);
    const after = await tourRow(deps, t.tour);
    expect([after.logo_key, after.logo_type, after.logo_bytes]).toEqual([`u/${fresh.json.upload_id}/logo.png`, "png", 900]);
    expect(await ctx.draftKeys()).not.toContain(before.logo_key);
  });
});

describe("chapters: interleavings", { timeout: 120_000 }, () => {
  /** Runs `during` once, just before the first batch whose text matches `pattern` goes to the database. */
  function beforeBatch(deps: Deps, pattern: RegExp, during: () => Promise<unknown>) {
    const real = deps.db.batch.bind(deps.db);
    let fired = false;
    deps.db.batch = async (stmts: Stmt[]) => {
      if (!fired && stmts.some((s) => pattern.test(s.sql))) {
        fired = true;
        await during();
      }
      return real(stmts);
    };
    return { fired: () => fired };
  }

  it("a replace open for a removed chapter can never commit: it answers 404, writes no step and brings nothing back, and its files go", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token);
    const rep = await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.second }, [3, 9]);
    expect(rep.json.have).toEqual([1]);
    const id = rep.json.upload_id as string;
    expect((await ctx.draftKeys()).some((k) => k.startsWith(`u/${id}/`))).toBe(true);
    const revision = (await list(deps, a.token, t.tour)).json.revision;
    expect((await change(deps, a.token, t.tour, { revision, chapters: [t.first, t.third] })).status).toBe(200);
    expect((await commit(deps, a.token, id)).json).toEqual({ error: "not_found", detail: "no such upload" });
    expect((await putStep(deps, a.token, id, 2, stepImage(manifestOf([3, 9], "x").steps[1], 9))).status).toBe(404);
    expect(await deps.db.all("SELECT id FROM chapter WHERE id = ?", [t.second])).toEqual([]);
    expect(await deps.db.all("SELECT id FROM step WHERE chapter_id = ?", [t.second])).toEqual([]);
    expect(await deps.db.all("SELECT id FROM upload WHERE id = ?", [id])).toEqual([]);
    expect(await ctx.draftKeys()).toEqual(await stepKeys(deps, t.tour));
  });

  it("a replace of the first chapter with its logo sent is cancelled when another chapter becomes first, and the tour keeps its settings", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token, true);
    const before = await tourRow(deps, t.tour);
    const rep = await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.first }, [1, 9], "New look", true);
    expect(rep.json.settings).toBe(true);
    const id = rep.json.upload_id as string;
    expect((await putLogo(deps, a.token, id, logoPng(900))).status).toBe(204);
    // A replace of the chapter that becomes first was decided without settings: cancelled too.
    const other = await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.third }, [6, 9]);
    expect(other.json.settings).toBe(false);
    // And one of a chapter whose place changes but which is first neither before nor after is not.
    const middle = await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.second }, [3, 4, 9]);
    const revision = (await list(deps, a.token, t.tour)).json.revision;
    expect((await change(deps, a.token, t.tour, { revision, chapters: [t.third, t.second, t.first] })).status).toBe(200);
    expect((await commit(deps, a.token, id)).status).toBe(404);
    expect((await commit(deps, a.token, other.json.upload_id)).status).toBe(404);
    expect((await deps.db.first<Json>("SELECT * FROM tour WHERE id = ?", [t.tour]))!.logo_key).toBe(before.logo_key);
    expect((await ctx.draftKeys()).filter((k) => k.startsWith(`u/${id}/`))).toEqual([]);
    const done = await commit(deps, a.token, middle.json.upload_id);
    expect(done.status, done.text).toBe(201);
    expect((await chapterRows(deps, t.tour)).map((c) => c.id)).toEqual([t.third, t.second, t.first]);
    expect(await ctx.draftKeys()).toEqual([...(await stepKeys(deps, t.tour)), before.logo_key].sort());
  });

  it("an upload, a replace or a change that lands after the list was read makes the change 409, with nothing changed", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token);
    for (const meanwhile of [
      () => upload(deps, a.token, [10], "Added", t.tour),
      async () => expect((await commit(deps, a.token, (await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.third }, [11])).json.upload_id)).status).toBe(201),
      async () => {
        const r = (await list(deps, a.token, t.tour)).json;
        expect((await change(deps, a.token, t.tour, { revision: r.revision, chapters: r.chapters.map((c: Json) => c.id).reverse() })).status).toBe(200);
      },
    ]) {
      const read = (await list(deps, a.token, t.tour)).json;
      await meanwhile();
      const before = await everything(ctx);
      const r = await change(deps, a.token, t.tour, { revision: read.revision, chapters: [read.chapters[0].id] });
      expect(r.json.error).toBe("tour_changed");
      expect(await everything(ctx)).toEqual(before);
    }
  });

  it("a replace that commits between the change's read and its batch makes the batch take no effect", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token);
    const rep = await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.second }, [3, 12]);
    const read = (await list(deps, a.token, t.tour)).json;
    const hook = beforeBatch(deps, /CASE WHEN draft_version = \?/, () => commit(deps, a.token, rep.json.upload_id));
    const r = await change(deps, a.token, t.tour, { revision: read.revision, chapters: [t.first, t.third] });
    expect(hook.fired()).toBe(true);
    expect(r.json.error).toBe("tour_changed");
    // The replace is in; nothing of the change is.
    expect((await chapterRows(deps, t.tour)).map((c) => c.id)).toEqual([t.first, t.second, t.third]);
    expect(await deps.db.all("SELECT * FROM replaced_object")).toEqual([]);
    expect((await list(deps, a.token, t.tour)).json.chapters[1]).toMatchObject({ id: t.second, steps: 2 });
  });

  it("a change that lands between a replace commit's read and its batch makes the commit fail cleanly", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token);
    const rep = await openReplace(deps, a.token, { tour_id: t.tour, chapter_id: t.second }, [3, 13]);
    const read = (await list(deps, a.token, t.tour)).json;
    const hook = beforeBatch(deps, /INSERT INTO step/, () => change(deps, a.token, t.tour, { revision: read.revision, chapters: [t.first, t.third] }));
    const r = await commit(deps, a.token, rep.json.upload_id);
    expect(hook.fired()).toBe(true);
    expect(r.json).toEqual({ error: "not_found", detail: "no such upload" });
    expect((await chapterRows(deps, t.tour)).map((c) => c.id)).toEqual([t.first, t.third]);
    expect(await deps.db.all("SELECT id FROM step WHERE chapter_id = ?", [t.second])).toEqual([]);
  });

  it("a replace created while the first chapter changes is refused at its create, writing nothing", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token);
    const read = (await list(deps, a.token, t.tour)).json;
    // Just after the create read the chapter (as first), the change makes another chapter first.
    const real = deps.db.first.bind(deps.db);
    let fired = false;
    deps.db.first = async (sql: string, params?: unknown[]) => {
      const row = await real(sql, params as never);
      if (!fired && sql.includes("LEFT JOIN chapter c ON c.tour_id = t.id AND c.id = ?")) {
        fired = true;
        expect((await change(deps, a.token, t.tour, { revision: read.revision, chapters: [t.third, t.first, t.second] })).status).toBe(200);
      }
      return row as never;
    };
    const uploads = await deps.db.all("SELECT id FROM upload");
    const m = manifestOf([1, 2], "x");
    const r = await send(deps, "POST", "/api/v1/uploads", { token: a.token, body: JSON.stringify({ manifest: m, target: { kind: "replace", tour_id: t.tour, chapter_id: t.first } }), headers: JSON_HEADERS });
    expect(fired).toBe(true);
    expect([r.status, r.json.error]).toEqual([409, "chapter_changed"]);
    expect(await deps.db.all("SELECT id FROM upload")).toEqual(uploads);
  });

  it("a new chapter uploaded across the change lands last, the positions without a gap", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token);
    const m = manifestOf([20], "Late");
    const id = (await createUpload(deps, a.token, m, { kind: "chapter", tour_id: t.tour })).json.upload_id as string;
    expect((await putStep(deps, a.token, id, 1, picture(m, 0, 20))).status).toBe(204);
    const revision = (await list(deps, a.token, t.tour)).json.revision;
    expect((await change(deps, a.token, t.tour, { revision, chapters: [t.third, t.first] })).status).toBe(200);
    const done = await commit(deps, a.token, id);
    expect(done.status).toBe(201);
    expect((await list(deps, a.token, t.tour)).json.chapters.map((c: Json) => [c.title, c.position])).toEqual([["Third", 0], ["First", 1], ["Late", 2]]);
    expect((await chapterRows(deps, t.tour)).map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it("a publish in progress finishes from the draft it started from, and the removed pictures go only after it", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const big = await upload(deps, a.token, Array.from({ length: 13 }, (_, i) => 30 + i), "Big");
    const small = await upload(deps, a.token, [50], "Small", big.tour_id);
    const started = await publish(deps, a.token, big.tour_id);
    expect(started.status).toBe(202);
    const removedKeys = (await deps.db.all<{ image_key: string }>("SELECT image_key FROM step WHERE chapter_id = ?", [big.chapter_id])).map((r) => r.image_key);
    const revision = (await list(deps, a.token, big.tour_id)).json.revision;
    expect((await change(deps, a.token, big.tour_id, { revision, chapters: [small.chapter_id] })).status).toBe(200);
    // The pictures wait for the publish that copies from them.
    expect((await deps.db.all("SELECT image_key FROM replaced_object")).length).toBe(13);
    for (const k of removedKeys) expect(await ctx.draftKeys()).toContain(k);
    const done = await publish(deps, a.token, big.tour_id, started.json.publish_id);
    expect(done.status, done.text).toBe(200);
    expect((await snapshotOf(deps, big.tour_id))!.chapters.map((c: Json) => [c.title, c.steps.length])).toEqual([["Big", 13], ["Small", 1]]);
    // It is live, the draft is ahead of it, and the next request of the workspace clears the pictures.
    expect((await tours(deps, a.token))[0].unpublished_changes).toBe(true);
    expect(await deps.db.all("SELECT image_key FROM replaced_object")).toEqual([]);
    expect(await ctx.draftKeys()).toEqual(await stepKeys(deps, big.tour_id));
    await publishAll(deps, a.token, big.tour_id);
    expect((await snapshotOf(deps, big.tour_id))!.chapters.map((c: Json) => c.title)).toEqual(["Small"]);
  });

  it("a publish whose start read the draft before the change starts again from the changed draft", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await threeChapters(deps, a.token);
    const read = (await list(deps, a.token, t.tour)).json;
    const real = deps.db.all.bind(deps.db);
    let fired = false;
    deps.db.all = async (sql: string, params?: unknown[]) => {
      const rows = await real(sql, params as never);
      if (!fired && sql.includes("ORDER BY c.position, c.id, s.position, s.id")) {
        fired = true;
        expect((await change(deps, a.token, t.tour, { revision: read.revision, chapters: [t.third, t.first] })).status).toBe(200);
      }
      return rows as never;
    };
    const r = await publish(deps, a.token, t.tour);
    expect(fired).toBe(true);
    expect(r.status, r.text).toBe(200);
    expect((await snapshotOf(deps, t.tour))!.chapters.map((c: Json) => c.title)).toEqual(["Third", "First"]);
    expect((await tours(deps, a.token))[0].unpublished_changes).toBe(false);
    expect(await ctx.draftKeys()).toEqual(await stepKeys(deps, t.tour));
  });
});

/**
 * Adds `n` chapters without steps to the end of `tourId`, straight into the database: the
 * quickest way to a tour at or over MAX_CHAPTERS (through the routes each would be an upload).
 */
async function bareChapters(deps: Deps, tourId: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => newId("ch"));
  await deps.db.run(
    `INSERT INTO chapter (id, tour_id, title, description, position)
     SELECT j.value, ?, 'Bare ' || j.key, NULL, (SELECT coalesce(max(position) + 1, 0) FROM chapter WHERE tour_id = ?) + j.key FROM json_each(?) j`,
    [tourId, tourId, JSON.stringify(ids)],
  );
  return ids;
}
const chapterCount = async (deps: Deps, tourId: string) => (await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM chapter WHERE tour_id = ?", [tourId]))!.n;
const FULL = { error: "too_many_chapters", detail: `the tour already has ${MAX_CHAPTERS} chapters, the most a tour may have; remove a chapter first (PUT /api/v1/tours/{id}/chapters)` };

describe("chapters: at most MAX_CHAPTERS in a tour (0.1.56)", { timeout: 120_000 }, () => {
  it("a new chapter is refused at its create once the tour has MAX_CHAPTERS, changing nothing; a replace and another tour still work", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const first = await upload(deps, a.token, [1], "First");
    await bareChapters(deps, first.tour_id, MAX_CHAPTERS - 1);
    expect(await chapterCount(deps, first.tour_id)).toBe(MAX_CHAPTERS);
    const before = await everything(ctx);
    const r = await createUpload(deps, a.token, manifestOf([2], "One too many"), { kind: "chapter", tour_id: first.tour_id });
    expect([r.status, r.json]).toEqual([409, FULL]);
    expect(await everything(ctx)).toEqual(before);
    // A replace keeps the number of chapters, so it is not held to the cap.
    const replaced = await openReplace(deps, a.token, first, [3]);
    expect(replaced.status, replaced.text).toBe(201);
    expect((await commit(deps, a.token, replaced.json.upload_id)).status).toBe(201);
    // Another tour has its own count.
    await upload(deps, a.token, [4], "Another tour");
    expect(await chapterCount(deps, first.tour_id)).toBe(MAX_CHAPTERS);
  });

  it("two uploads started below the cap: the one that would go over it is refused at its commit, changing nothing, and can be cancelled", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const first = await upload(deps, a.token, [1], "First");
    await bareChapters(deps, first.tour_id, MAX_CHAPTERS - 2);
    const opened: string[] = [];
    for (const pic of [5, 6]) {
      const m = manifestOf([pic], `Late ${pic}`);
      const created = await createUpload(deps, a.token, m, { kind: "chapter", tour_id: first.tour_id });
      expect(created.status, created.text).toBe(201);
      expect((await putStep(deps, a.token, created.json.upload_id, 1, picture(m, 0, pic))).status).toBe(204);
      opened.push(created.json.upload_id);
    }
    expect((await commit(deps, a.token, opened[0])).status).toBe(201);
    expect(await chapterCount(deps, first.tour_id)).toBe(MAX_CHAPTERS);
    const before = await everything(ctx);
    const refused = await commit(deps, a.token, opened[1]);
    expect([refused.status, refused.json]).toEqual([409, FULL]);
    expect(await everything(ctx)).toEqual(before);
    // The upload is still open: it is cancelled as any other, and takes its picture with it.
    expect((await send(deps, "DELETE", `/api/v1/uploads/${opened[1]}`, { token: a.token })).status).toBe(204);
    expect(await deps.db.all("SELECT id FROM upload")).toEqual([]);
    expect(await ctx.draftKeys()).toEqual(await stepKeys(deps, first.tour_id));
    // Once a chapter is removed, there is room for one again.
    const read = (await list(deps, a.token, first.tour_id)).json;
    const keep = read.chapters.slice(1).map((c: Json) => c.id);
    expect((await change(deps, a.token, first.tour_id, { revision: read.revision, chapters: keep })).status).toBe(200);
    await upload(deps, a.token, [7], "Room again", first.tour_id);
    expect(await chapterCount(deps, first.tour_id)).toBe(MAX_CHAPTERS);
  });

  it("refused for the cap at its insert, an upload that is still open is never answered as not found, even when room appears at once; its next commit lands", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const first = await upload(deps, a.token, [1], "First");
    const bare = await bareChapters(deps, first.tour_id, MAX_CHAPTERS - 2);
    const m = manifestOf([5], "Late");
    const created = await createUpload(deps, a.token, m, { kind: "chapter", tour_id: first.tour_id });
    expect(created.status, created.text).toBe(201);
    const id = created.json.upload_id as string;
    expect((await putStep(deps, a.token, id, 1, picture(m, 0, 5))).status).toBe(204);
    await bareChapters(deps, first.tour_id, 1);
    expect(await chapterCount(deps, first.tour_id)).toBe(MAX_CHAPTERS);
    // Between the refused insert and the look that follows it, a change of the chapters makes room.
    const real = deps.db.first.bind(deps.db);
    let fired = false;
    deps.db.first = async (sql: string, params?: unknown[]) => {
      if (!fired && sql.includes("FROM chapter c JOIN tour t ON t.id = c.tour_id WHERE c.id = ?")) {
        fired = true;
        await deps.db.run("DELETE FROM chapter WHERE id = ?", [bare[0]]);
      }
      return real(sql, params as never) as never;
    };
    const refused = await commit(deps, a.token, id);
    deps.db.first = real;
    expect(fired).toBe(true);
    expect([refused.status, refused.json]).toEqual([409, FULL]);
    expect(await deps.db.first("SELECT closing_at FROM upload WHERE id = ?", [id])).toEqual({ closing_at: null });
    // Sent again, now that there is room, the same upload lands.
    const again = await commit(deps, a.token, id);
    expect(again.status, again.text).toBe(201);
    expect(again.json.chapter_id).toBe("ch_" + id.slice(3));
    expect(await chapterCount(deps, first.tour_id)).toBe(MAX_CHAPTERS);
    expect(await deps.db.all("SELECT id FROM upload")).toEqual([]);
  });

  it("refused for the cap, an open upload can be cancelled, and another workspace's commit of it is no upload, byte for byte", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const first = await upload(deps, a.token, [1], "First");
    await bareChapters(deps, first.tour_id, MAX_CHAPTERS - 2);
    const m = manifestOf([5], "Late");
    const id = (await createUpload(deps, a.token, m, { kind: "chapter", tour_id: first.tour_id })).json.upload_id as string;
    expect((await putStep(deps, a.token, id, 1, picture(m, 0, 5))).status).toBe(204);
    await bareChapters(deps, first.tour_id, 1);
    expect((await commit(deps, a.token, id)).json).toEqual(FULL);
    const theirs = await commit(deps, b.token, id);
    const nobodys = await commit(deps, b.token, "up_" + "0".repeat(24));
    expect([theirs.status, theirs.text]).toEqual([404, '{"error":"not_found","detail":"no such upload"}']);
    expect([nobodys.status, nobodys.text]).toEqual([theirs.status, theirs.text]);
    expect((await send(deps, "DELETE", `/api/v1/uploads/${id}`, { token: a.token })).status).toBe(204);
    expect(await deps.db.all("SELECT id FROM upload")).toEqual([]);
  });

  it("the cap counts the caller's own tour only: another workspace's full tour is no tour, and its count changes nothing here", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const mine = await upload(deps, a.token, [1], "Mine");
    const theirs = await upload(deps, b.token, [2], "Theirs");
    await bareChapters(deps, theirs.tour_id, MAX_CHAPTERS - 1);
    const before = await everything(ctx);
    const r = await createUpload(deps, a.token, manifestOf([3], "Into theirs"), { kind: "chapter", tour_id: theirs.tour_id });
    expect([r.status, r.text]).toEqual([404, '{"error":"not_found","detail":"no such tour"}']);
    expect(await everything(ctx)).toEqual(before);
    // The caller's own tour takes a chapter while theirs is full.
    await upload(deps, a.token, [4], "Mine too", mine.tour_id);
    expect(await chapterCount(deps, mine.tour_id)).toBe(2);
    expect(await chapterCount(deps, theirs.tour_id)).toBe(MAX_CHAPTERS);
  });

  it("a tour already over the cap (made before it) is never stuck: one change down to MAX_CHAPTERS is taken, and from then on any change", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const first = await upload(deps, a.token, [1], "First");
    await bareChapters(deps, first.tour_id, MAX_CHAPTERS + 49);
    const read = (await list(deps, a.token, first.tour_id)).json;
    expect(read.chapters).toHaveLength(MAX_CHAPTERS + 50);
    const all = read.chapters.map((c: Json) => c.id as string);
    // Keeping every chapter lists more ids than a change takes: refused, nothing changed.
    const before = await everything(ctx);
    const tooMany = await change(deps, a.token, first.tour_id, { revision: read.revision, chapters: all });
    expect([tooMany.status, tooMany.json.error]).toEqual([400, "too_many_chapters"]);
    expect(await everything(ctx)).toEqual(before);
    // Removing the 50 over the cap, and moving one, in one change (the box's Save) is taken.
    const kept = [all[1], all[0], ...all.slice(2, MAX_CHAPTERS)];
    const down = await change(deps, a.token, first.tour_id, { revision: read.revision, chapters: kept });
    expect(down.status, down.text).toBe(200);
    expect(down.json.chapters.map((c: Json) => c.id)).toEqual(kept);
    // At the cap, a reorder alone is taken, and a new chapter is refused.
    expect((await change(deps, a.token, first.tour_id, { revision: down.json.revision, chapters: [...kept].reverse() })).status).toBe(200);
    expect((await createUpload(deps, a.token, manifestOf([2], "More"), { kind: "chapter", tour_id: first.tour_id })).json).toEqual(FULL);
  });
});

describe("chapters: the upload time always belongs to the chapter's present pictures (0.1.56)", { timeout: 60_000 }, () => {
  it("a replace written without the time (an older build on the migrated database) leaves no time rather than the earlier one", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const made = ctx.at();
    const t = await upload(deps, a.token, [1, 2], "First");
    expect((await list(deps, a.token, t.tour_id)).json.chapters[0].uploaded_at).toBe(made);
    // What every build before 0.1.55 writes when a replace commits: the revision and the
    // versions, never uploaded_at, which it does not know.
    ctx.advance(60_000);
    await deps.db.run(
      "UPDATE chapter SET revision = ?, replaced_version = (SELECT draft_version FROM tour WHERE id = ?), replaced_from = (SELECT draft_version FROM tour WHERE id = ?) WHERE id = ?",
      ["up_" + "0".repeat(24), t.tour_id, t.tour_id, t.chapter_id],
    );
    expect((await list(deps, a.token, t.tour_id)).json.chapters[0].uploaded_at).toBeNull();
    // This build's next replace dates it again.
    ctx.advance(60_000);
    const replaced = await openReplace(deps, a.token, t, [3]);
    expect((await commit(deps, a.token, replaced.json.upload_id)).status).toBe(201);
    expect((await list(deps, a.token, t.tour_id)).json.chapters[0].uploaded_at).toBe(made + 120_000);
  });

  it("two replaces in the same millisecond both leave the chapter dated; a reorder and a rename keep the dates", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const made = ctx.at();
    const t = await upload(deps, a.token, [1], "First");
    const second = await upload(deps, a.token, [2], "Second", t.tour_id);
    for (const pic of [3, 4]) {
      const r = await openReplace(deps, a.token, t, [pic]);
      expect((await commit(deps, a.token, r.json.upload_id)).status).toBe(201);
      expect((await list(deps, a.token, t.tour_id)).json.chapters[0].uploaded_at).toBe(made);
    }
    ctx.advance(60_000);
    const read = (await list(deps, a.token, t.tour_id)).json;
    expect((await change(deps, a.token, t.tour_id, { revision: read.revision, chapters: [second.chapter_id, t.chapter_id] })).status).toBe(200);
    expect((await send(deps, "PATCH", `/api/v1/tours/${t.tour_id}`, { token: a.token, body: JSON.stringify({ title: "Renamed" }), headers: JSON_HEADERS })).status).toBe(200);
    expect((await list(deps, a.token, t.tour_id)).json.chapters.map((c: Json) => c.uploaded_at)).toEqual([made, made]);
  });
});
