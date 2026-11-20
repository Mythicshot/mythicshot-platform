// The storage allowance enforced (src/uploads.ts, src/replace.ts, src/usage.ts), on both
// targets: an upload that would take a workspace over its allowance is refused at create,
// before a byte is stored, in the statement that would have created it; a replace needs
// only its growth; nothing is ever deleted or refused because of an allowance except a
// create; and GET /api/v1/usage tells a workspace its own numbers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import type { Deps, Stmt } from "../src/ports.ts";
import { LOGO_RULE } from "../src/sniff.ts";
import { DEFAULT_MAX_OPEN_UPLOADS, UPLOAD_MAX_AGE_MS } from "../src/uploads.ts";
import { formatBytes, roomSizes, storageFull, usageOf, type Usage } from "../src/usage.ts";
import { abort, clone, commit, counts, createUpload, fixtures, logoPng, putLogo, putStep, send, sha256Hex, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
const T0 = 1_800_000_000_000;
const JSON_HEADERS = { "content-type": "application/json" };
const NEW = { kind: "new" };

type Ws = { workspaceId: string; token: string };
type Tour = { tour_id: string; chapter_id: string; steps: number };

/** Two workspaces and a clock the test moves. `allowance` is the site's setting. */
async function setup(allowance?: number | null, config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps({ retiredGraceMs: 0, ...(allowance === undefined ? {} : { storageAllowanceBytes: allowance }), ...config });
  const a: Ws = await seedWorkspace(ctx.deps, "Workspace A");
  const b: Ws = await seedWorkspace(ctx.deps, "Workspace B");
  let now = T0;
  ctx.deps.now = () => now;
  return { ...ctx, a, b, advance: (ms: number) => (now += ms) };
}

/** A manifest with one 64 x 64 PNG step per entry of `sizes`, each of that many bytes, and no logo. */
function manifestOf(sizes: number[], title = "Chapter"): Json {
  const m = clone(v2);
  m.title = title;
  m.cover = null;
  const base = m.steps[1];
  m.steps = sizes.map((bytes, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes }));
  return m;
}

/** The same with a cover that names a PNG logo (manifest version 3). */
function withLogo(sizes: number[], title = "With a logo"): Json {
  const m = clone(v3);
  m.title = title;
  const base = m.steps[0];
  m.steps = sizes.map((bytes, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes }));
  return m;
}

const sum = (m: Json) => (m.steps as Json[]).reduce((n, s) => n + (s.bytes as number), 0);
const replaceOf = (t: Tour) => ({ kind: "replace", tour_id: t.tour_id, chapter_id: t.chapter_id });
const chapterOf = (t: Tour) => ({ kind: "chapter", tour_id: t.tour_id });

/** The workspace's own allowance, which comes before the site's. */
async function setAllowance(deps: Deps, ws: Ws, bytes: number | null): Promise<void> {
  await deps.db.run("UPDATE workspace SET storage_allowance_bytes = ? WHERE id = ?", [bytes, ws.workspaceId]);
}

async function reservedOf(deps: Deps, uploadId: string): Promise<number | null> {
  return (await deps.db.first<{ reserved_bytes: number }>("SELECT reserved_bytes FROM upload WHERE id = ?", [uploadId]))?.reserved_bytes ?? null;
}

/** A create with a hash per step, as a replace that reuses pictures sends it. */
async function createWithHashes(deps: Deps, token: string, manifest: Json, target: unknown, fill = 0): Promise<Call> {
  const sha256 = await Promise.all((manifest.steps as Json[]).map((s) => sha256Hex(stepImage(s, fill))));
  return send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest, target, sha256 }), headers: JSON_HEADERS });
}

/** Sends every step the create did not answer as already there, the logo when `logo` is given, and commits. */
async function finish(deps: Deps, token: string, created: Call, manifest: Json, fill = 0, logo?: Uint8Array): Promise<Call> {
  const id = created.json.upload_id as string;
  const have = (created.json.have ?? []) as number[];
  for (let i = 0; i < manifest.steps.length; i++) {
    if (have.includes(i + 1)) continue;
    const r = await putStep(deps, token, id, i + 1, stepImage(manifest.steps[i], fill));
    if (r.status !== 204) throw new Error(`step ${i + 1} failed: ${r.status} ${r.text}`);
  }
  if (logo !== undefined) {
    const r = await putLogo(deps, token, id, logo);
    if (r.status !== 204) throw new Error(`logo failed: ${r.status} ${r.text}`);
  }
  return commit(deps, token, id);
}

async function publishAll(deps: Deps, token: string, tourId: string): Promise<Call> {
  const path = `/api/v1/tours/${tourId}/publish`;
  let r = await send(deps, "POST", path, { token });
  while (r.status === 202) r = await send(deps, "POST", path, { token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: JSON_HEADERS });
  return r;
}

/** The refusal's sentence for these three numbers, as the plan's owner approved its meaning. */
function sentence(used: number, allowance: number, needed: number): string {
  const left = Math.max(0, allowance - used);
  // The need is rounded up and the room left down (roomSizes); the allowance as everywhere else.
  const sizes = roomSizes(needed, left);
  return `this tour needs ${sizes.needed} of room, but the workspace has ${sizes.left} left of its ${formatBytes(allowance)} allowance. Nothing was uploaded. Delete tours you no longer need, or ask the site's admin for more room`;
}

/** What a storage refusal must be, in full. */
function expectFull(r: Call, used: number, allowance: number, needed: number): void {
  expect(r.status, r.text).toBe(413);
  expect(r.json).toEqual({ error: "storage_full", detail: sentence(used, allowance, needed), used_bytes: used, allowance_bytes: allowance, needed_bytes: needed });
  expect(Object.keys(r.json)).toEqual(["error", "detail", "used_bytes", "allowance_bytes", "needed_bytes"]);
  expect(r.headers.get("content-type")).toBe("application/json");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("retry-after")).toBeNull();
}

/** The README, read through Vite's ?raw import, which works under both Vitest configs. */
const README = (import.meta.glob("../README.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../README.md"];

const CAP_BODY = `{"error":"too_many_uploads","detail":"this workspace already has ${DEFAULT_MAX_OPEN_UPLOADS} open uploads; finish or cancel one first"}`;

afterEach(() => vi.restoreAllMocks());

describe("an upload against the allowance", () => {
  it("an upload that fits is created and reserves its declared bytes", async () => {
    const { deps, a } = await setup(1000);
    const m = manifestOf([300, 400]);
    const created = await createUpload(deps, a.token, m);
    expect(created.status, created.text).toBe(201);
    expect(created.json).toEqual({ upload_id: created.json.upload_id, steps: 2 });
    expect(await reservedOf(deps, created.json.upload_id)).toBe(700);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 0, logos: 0, uploads: 700, media: 0, used: 700, allowance: 1000, over: false, tours: 0 });

    // Exactly the room that is left fits: 700 + 300 is the allowance, not over it.
    const exact = await createUpload(deps, a.token, manifestOf([300]));
    expect(exact.status, exact.text).toBe(201);
    expect(await reservedOf(deps, exact.json.upload_id)).toBe(300);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(1000);
    // One byte more does not.
    expectFull(await createUpload(deps, a.token, manifestOf([1])), 1000, 1000, 1);

    // A new chapter reserves its steps the same way.
    await abort(deps, a.token, exact.json.upload_id);
    const tour = (await finish(deps, a.token, created, m)).json as Tour;
    const chapter = await createUpload(deps, a.token, manifestOf([250], "Second"), chapterOf(tour));
    expect(chapter.status, chapter.text).toBe(201);
    expect(await reservedOf(deps, chapter.json.upload_id)).toBe(250);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 700, logos: 0, uploads: 250, media: 0, used: 950, allowance: 1000, over: false, tours: 1 });
  });

  it("an upload that would go over is refused with 413 storage_full, the three numbers and the sentence", async () => {
    const { deps, a } = await setup(1000);
    await uploadTour(deps, a.token, manifestOf([250, 350]));
    const refused = await createUpload(deps, a.token, manifestOf([200, 300]));
    expectFull(refused, 600, 1000, 500);
    expect(refused.json.detail).toBe(
      "this tour needs 500 bytes of room, but the workspace has 400 bytes left of its 1000 bytes allowance. Nothing was uploaded. Delete tours you no longer need, or ask the site's admin for more room",
    );
    // The numbers are whole bytes, whatever the sentence rounds to.
    const { deps: big, a: owner } = await setup(1_073_741_824);
    await uploadTour(big, owner.token, manifestOf([1_500_000, 1_500_001]));
    await setAllowance(big, owner, 3_100_000);
    const large = await createUpload(big, owner.token, manifestOf([2_000_000]));
    expectFull(large, 3_000_001, 3_100_000, 2_000_000);
    // Sizes are written as the pages write them: at most one decimal, no trailing ".0".
    expect(large.json.detail).toContain("this tour needs 2 MB of room, but the workspace has 97.6 KB left of its 3 MB allowance.");
  });

  it('the sentence is under 200 characters and reads after "Could not start the upload: "', async () => {
    const usage = (used: number, allowance: number): Usage => ({ pictures: used, logos: 0, uploads: 0, media: 0, used, allowance, over: used > allowance, tours: 1 });
    const MAX = Number.MAX_SAFE_INTEGER;
    // The longest sizes there are: four digits of bytes or KB, and the largest allowance in GB.
    const cases: [Usage, number][] = [
      [usage(600, 1000), 500],
      [usage(0, 0), 1],
      [usage(5000, 10), 1023],
      [usage(MAX - 1023, MAX), 1023 * 1024],
      [usage(0, MAX), MAX],
      [usage(MAX, MAX), MAX],
      [usage(1_073_741_824 - 1_023_000, 1_073_741_824), 200 * 2_000_000 + LOGO_RULE.maxBytes],
    ];
    for (const [u, needed] of cases) {
      const res = storageFull(u, needed);
      expect(res.status).toBe(413);
      const body = (await res.json()) as Json;
      const detail = body.detail as string;
      expect(body).toEqual({ error: "storage_full", detail, used_bytes: u.used, allowance_bytes: u.allowance, needed_bytes: needed });
      expect(detail).toBe(sentence(u.used, u.allowance!, needed));
      expect(detail.length, detail).toBeLessThan(200);
      // It continues a sentence, and the client closes it: " (HTTP 413)." comes after.
      expect(detail).toMatch(/^[a-z]/);
      expect(detail).toMatch(/[a-z]$/);
      expect(detail).not.toMatch(/[\r\n\t]|\s{2}|HTTP|storage_full/);
      const shown = `Could not start the upload: ${detail} (HTTP 413).`;
      expect(shown).toMatch(/^Could not start the upload: this tour needs \d[\d.]* (bytes?|KB|MB|GB) of room, but the workspace has \d[\d.]* (bytes?|KB|MB|GB) left of its \d[\d.]* (bytes?|KB|MB|GB) allowance\. Nothing was uploaded\. Delete tours you no longer need, or ask the site's admin for more room \(HTTP 413\)\.$/);
    }
    // The README's example is a real answer, byte for byte.
    expect(README).toContain(await storageFull(usage(1_070_491_238, 1_073_741_824), 14_889_779).text());
    expect(((await storageFull(usage(1_070_491_238, 1_073_741_824), 14_889_779).json()) as Json).detail).toBe(
      "this tour needs 14.2 MB of room, but the workspace has 3.1 MB left of its 1 GB allowance. Nothing was uploaded. Delete tours you no longer need, or ask the site's admin for more room",
    );
    // Over its allowance, a workspace has nothing left, never a negative size.
    expect(((await storageFull(usage(5000, 10), 7).json()) as Json).detail).toContain("has 0 bytes left of its 10 bytes allowance");
    // It says nothing was uploaded, and never that the site deletes anything.
    expect(sentence(1, 2, 3)).toContain("Nothing was uploaded.");
    expect(sentence(1, 2, 3)).not.toMatch(/will be deleted|was deleted|removed/);
  });

  it("the sentence never shows the room left as large as the room needed: the need rounds up, what is left rounds down", async () => {
    const usage = (used: number, allowance: number): Usage => ({ pictures: used, logos: 0, uploads: 0, media: 0, used, allowance, over: used > allowance, tours: 1 });
    const detailOf = async (used: number, allowance: number, needed: number) => ((await storageFull(usage(used, allowance), needed).json()) as Json).detail as string;
    // 3,250,000 needed and 3,230,000 left would both read 3.1 MB to the nearest tenth.
    expect(await detailOf(7_255_760, 10_485_760, 3_250_000)).toContain("this tour needs 3.1 MB of room, but the workspace has 3 MB left of its 10 MB allowance.");
    // The same in KB: 1130 needed and 1100 left would both read 1.1 KB.
    expect(await detailOf(900, 2000, 1130)).toContain("this tour needs 1.2 KB of room, but the workspace has 1 KB left of its 2 KB allowance.");
    // At a unit's edge: just under 1 MB left stays in KB, rounded down; just over 1 MB needed goes up to MB.
    expect(await detailOf(1, 1_048_576, 1_048_577)).toContain("this tour needs 1.1 MB of room, but the workspace has 1023.9 KB left of its 1 MB allowance.");
    // Nothing left.
    expect(await detailOf(5000, 5000, 1)).toContain("this tour needs 1 byte of room, but the workspace has 0 bytes left of its 4.9 KB allowance.");
    expect(await detailOf(5000, 10, 7)).toContain("this tour needs 7 bytes of room, but the workspace has 0 bytes left of its 10 bytes allowance.");

    // Whenever more is needed than is left, the two sizes read differently, at every scale.
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const pairs: [number, number][] = [];
    for (let i = 0; i < 3000; i++) {
      const scale = 2 ** (next() % 44);
      const left = Math.floor((next() / 2147483648) * scale);
      // Mostly a hair more than is left, sometimes much more.
      const more = i % 3 === 0 ? 1 + (next() % 1000) : i % 3 === 1 ? 1 + Math.floor((next() / 2147483648) * Math.max(1, left / 50)) : 1 + Math.floor((next() / 2147483648) * scale);
      pairs.push([left + more, left]);
    }
    for (const left of [0, 1023, 1024, 1_048_575, 1_048_576, 1_073_741_823, 1_073_741_824, Number.MAX_SAFE_INTEGER - 1]) pairs.push([left + 1, left]);
    for (const [needed, left] of pairs) {
      const sizes = roomSizes(needed, left);
      expect(sizes.needed, `needed ${needed}, left ${left}`).not.toBe(sizes.left);
      expect(sizes.needed, `needed ${needed}`).toMatch(/^(\d+ bytes?|\d+(\.\d*[1-9])? (KB|MB|GB))$/);
      expect(sizes.left, `left ${left}`).toMatch(/^(\d+ bytes?|\d+(\.\d*[1-9])? (KB|MB|GB))$/);
    }
    // Two sizes that still read the same get more decimals until they differ, and at most their exact bytes.
    expect(roomSizes(1100, 1150)).toEqual({ needed: "1.08 KB", left: "1.12 KB" });
    expect(roomSizes(1024, 1024)).toEqual({ needed: "1024 bytes", left: "1024 bytes" });
    // formatBytes itself is unchanged for every other use: to the nearest tenth.
    expect([formatBytes(3_250_000), formatBytes(3_230_000), formatBytes(1130), formatBytes(1100)]).toEqual(["3.1 MB", "3.1 MB", "1.1 KB", "1.1 KB"]);
  });

  it("nothing is stored and no row is left for a refused upload", async () => {
    const { deps, a, draftKeys, publicKeys } = await setup(2000);
    const m = manifestOf([500, 600]);
    const tour = await uploadTour(deps, a.token, m, NEW, 3);
    const rows = await counts(deps);
    const keys = [await draftKeys(), await publicKeys()];
    const before = await usageOf(deps, a.workspaceId);

    // A new tour, a new chapter, and a replace with hashes (the create that is a batch).
    const grown = manifestOf([500, 600, 950]);
    expectFull(await createUpload(deps, a.token, manifestOf([901])), 1100, 2000, 901);
    expectFull(await createUpload(deps, a.token, manifestOf([901]), chapterOf(tour)), 1100, 2000, 901);
    const replace = await createWithHashes(deps, a.token, grown, replaceOf(tour), 3);
    expectFull(replace, 1100, 2000, 950);
    expect(replace.json.upload_id).toBeUndefined();

    expect(await counts(deps)).toEqual(rows);
    expect(rows.upload).toBe(0);
    expect(rows.upload_step).toBe(0);
    expect([await draftKeys(), await publicKeys()]).toEqual(keys);
    expect(await usageOf(deps, a.workspaceId)).toEqual(before);
    // The same replace fits once there is room, and reuses the two pictures it has.
    await setAllowance(deps, a, 2050);
    const fits = await createWithHashes(deps, a.token, grown, replaceOf(tour), 3);
    expect([fits.status, fits.json.have], fits.text).toEqual([201, [1, 2]]);
    expect(await reservedOf(deps, fits.json.upload_id)).toBe(950);
  });

  it("two uploads that each fit and together do not: one is created", async () => {
    const { deps, a } = await setup(1000);
    const m = manifestOf([600]);
    // At the same moment.
    const both = await Promise.all([createUpload(deps, a.token, m), createUpload(deps, a.token, m)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 413]);
    const won = both.find((r) => r.status === 201)!;
    expectFull(both.find((r) => r.status === 413)!, 600, 1000, 600);
    expect((await counts(deps)).upload).toBe(1);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(600);
    await abort(deps, a.token, won.json.upload_id);

    // One after the other.
    const first = await createUpload(deps, a.token, m);
    const second = await createUpload(deps, a.token, m);
    expect(first.status, first.text).toBe(201);
    expectFull(second, 600, 1000, 600);
    expect((await counts(deps)).upload).toBe(1);
    await abort(deps, a.token, first.json.upload_id);

    // And two replaces of two chapters that each grow by 600, the batch path included.
    await setAllowance(deps, a, 3000);
    const one = await uploadTour(deps, a.token, manifestOf([700], "One"), NEW, 1);
    const two = await uploadTour(deps, a.token, manifestOf([800], "Two"), NEW, 2);
    await setAllowance(deps, a, 2500);
    const pair = await Promise.all([
      createWithHashes(deps, a.token, manifestOf([700, 600], "One"), replaceOf(one), 1),
      createUpload(deps, a.token, manifestOf([800, 600], "Two"), replaceOf(two)),
    ]);
    expect(pair.map((r) => r.status).sort()).toEqual([201, 413]);
    expectFull(pair.find((r) => r.status === 413)!, 2100, 2500, 600);
    expect((await counts(deps)).upload).toBe(1);
  });

  it("the reservation becomes the steps' bytes at commit, with no moment counted twice or not at all", async () => {
    const { deps, a } = await setup(5000);
    const m = manifestOf([1000, 1500]);
    const created = await createUpload(deps, a.token, m);
    const id = created.json.upload_id as string;
    const open = { pictures: 0, logos: 0, uploads: 2500, media: 0, used: 2500, allowance: 5000, over: false, tours: 0 };
    expect(await usageOf(deps, a.workspaceId)).toEqual(open);
    // Sending the pictures adds nothing: the reservation already holds them.
    for (let i = 0; i < 2; i++) {
      expect((await putStep(deps, a.token, id, i + 1, stepImage(m.steps[i]))).status).toBe(204);
      expect(await usageOf(deps, a.workspaceId)).toEqual(open);
    }

    // The commit is one batch: the steps come and the upload goes together, or neither does.
    const batches: Stmt[][] = [];
    const realBatch = deps.db.batch.bind(deps.db);
    deps.db.batch = async (stmts) => {
      batches.push(stmts);
      return realBatch(stmts);
    };
    const done = await commit(deps, a.token, id);
    deps.db.batch = realBatch;
    expect(done.status, done.text).toBe(201);
    expect(batches).toHaveLength(1);
    const sql = batches[0].map((s) => s.sql);
    expect(sql.filter((s) => s.startsWith("INSERT INTO step")).length).toBe(2);
    expect(sql.filter((s) => s.startsWith("DELETE FROM upload WHERE")).length).toBe(1);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 2500, logos: 0, uploads: 0, media: 0, used: 2500, allowance: 5000, over: false, tours: 1 });

    // A commit that fails changes nothing: the reservation stays and no step counts.
    const again = await createUpload(deps, a.token, manifestOf([400], "Again"));
    deps.db.batch = async (stmts) => realBatch([...stmts, { sql: "INSERT INTO upload (id) VALUES (NULL)" }]);
    expect((await putStep(deps, a.token, again.json.upload_id, 1, stepImage(manifestOf([400]).steps[0]))).status).toBe(204);
    expect((await commit(deps, a.token, again.json.upload_id)).status).toBe(404); // read as "aborted meanwhile": NOT NULL failed
    deps.db.batch = realBatch;
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 2500, logos: 0, uploads: 400, media: 0, used: 2900, allowance: 5000, over: false, tours: 1 });

    // A replace too: the old steps go, the new ones come and the upload goes in one batch.
    const tour = done.json as Tour;
    const bigger = manifestOf([1000, 1500, 700]);
    const replace = await createUpload(deps, a.token, bigger, replaceOf(tour));
    expect(await reservedOf(deps, replace.json.upload_id)).toBe(700);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(2500 + 400 + 700);
    expect((await finish(deps, a.token, replace, bigger, 4)).status).toBe(201);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3200, logos: 0, uploads: 400, media: 0, used: 3600, allowance: 5000, over: false, tours: 1 });
  });

  it("an aborted upload gives its room back", async () => {
    const { deps, a, advance } = await setup(1000);
    const m = manifestOf([800]);
    const held = await createUpload(deps, a.token, m);
    expect(held.status).toBe(201);
    expectFull(await createUpload(deps, a.token, m), 800, 1000, 800);
    expect((await abort(deps, a.token, held.json.upload_id)).status).toBe(204);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(0);
    const next = await createUpload(deps, a.token, m);
    expect(next.status, next.text).toBe(201);

    // An upload nobody finished gives its room back after a day, like its place under the cap.
    expectFull(await createUpload(deps, a.token, m), 800, 1000, 800);
    advance(UPLOAD_MAX_AGE_MS + 1);
    const later = await createUpload(deps, a.token, m);
    expect(later.status, later.text).toBe(201);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(800);
  });

  it("an upload that left the 24-hour window cannot be committed past the allowance", async () => {
    const { deps, a, advance } = await setup(1000);
    const old = manifestOf([100], "Old");
    const stale = await createUpload(deps, a.token, old);
    expect(stale.status).toBe(201);
    advance(UPLOAD_MAX_AGE_MS + 60_000);
    // It is past the window, yet nothing has swept it (here: the sweep cannot look), so it
    // can still be committed, and so it still holds its room.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const realAll = deps.db.all.bind(deps.db);
    deps.db.all = (async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SELECT id, manifest, logo_key FROM upload WHERE workspace_id = ? AND created_at <")) throw new Error("database busy");
      return realAll(sql, params as never);
    }) as typeof deps.db.all;
    const realRun = deps.db.run.bind(deps.db);
    deps.db.run = (async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("UPDATE upload SET closing_at = ? WHERE workspace_id = ? AND created_at <")) throw new Error("database busy");
      return realRun(sql, params as never);
    }) as typeof deps.db.run;
    expect((await usageOf(deps, a.workspaceId)).uploads).toBe(100);
    expectFull(await createUpload(deps, a.token, manifestOf([901], "New")), 100, 1000, 901);
    const fresh = manifestOf([900], "New");
    const created = await createUpload(deps, a.token, fresh);
    expect(created.status, created.text).toBe(201);

    // Both are committed, and the workspace is at its allowance, not past it.
    const first = await finish(deps, a.token, stale, old);
    expect(first.status, first.text).toBe(201);
    expect((await finish(deps, a.token, created, fresh)).status).toBe(201);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 1000, logos: 0, uploads: 0, media: 0, used: 1000, allowance: 1000, over: false, tours: 2 });
    deps.db.all = realAll;
    deps.db.run = realRun;
  });

  it("the database refuses a negative reservation and a negative logo size", async () => {
    const { deps, a } = await setup();
    const tour = await uploadTour(deps, a.token, withLogo([100]));
    const open = await createUpload(deps, a.token, manifestOf([100]));
    await expect(deps.db.run("UPDATE upload SET reserved_bytes = -1 WHERE id = ?", [open.json.upload_id])).rejects.toThrow();
    await expect(deps.db.run("UPDATE tour SET logo_bytes = -1 WHERE id = ?", [tour.tour_id])).rejects.toThrow();
    expect(await reservedOf(deps, open.json.upload_id)).toBe(100);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 100, logos: 1000, uploads: 100, media: 0, used: 1200, allowance: null, over: false, tours: 1 });
    // Zero, and no recorded logo size, stay allowed.
    await deps.db.run("UPDATE upload SET reserved_bytes = 0 WHERE id = ?", [open.json.upload_id]);
    await deps.db.run("UPDATE tour SET logo_bytes = NULL WHERE id = ?", [tour.tour_id]);
  });

  it("a logo reserves 200,000 bytes and counts as its real size after commit", async () => {
    const { deps, a } = await setup(300_000);
    expect(LOGO_RULE.maxBytes).toBe(200_000);
    const m = withLogo([1000, 2000]);
    const created = await createUpload(deps, a.token, m);
    expect(created.status, created.text).toBe(201);
    expect(await reservedOf(deps, created.json.upload_id)).toBe(203_000);
    // The logo's own bytes are not counted on top while the upload is open.
    const id = created.json.upload_id as string;
    expect((await putLogo(deps, a.token, id, logoPng(1234))).status).toBe(204);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 0, logos: 0, uploads: 203_000, media: 0, used: 203_000, allowance: 300_000, over: false, tours: 0 });
    // A second one would need room for a logo of its own.
    expectFull(await createUpload(deps, a.token, withLogo([1000])), 203_000, 300_000, 201_000);

    const tour = (await finish(deps, a.token, created, m)).json as Tour;
    expect((await deps.db.first<{ logo_bytes: number }>("SELECT logo_bytes FROM tour WHERE id = ?", [tour.tour_id]))!.logo_bytes).toBe(1234);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3000, logos: 1234, uploads: 0, media: 0, used: 4234, allowance: 300_000, over: false, tours: 1 });

    // A new chapter keeps the tour's logo, so a logo its manifest names reserves nothing.
    const chapter = await createUpload(deps, a.token, withLogo([500], "Second"), chapterOf(tour));
    expect(await reservedOf(deps, chapter.json.upload_id)).toBe(500);
    await abort(deps, a.token, chapter.json.upload_id);
    // A manifest without a logo reserves its steps alone.
    const plain = await createUpload(deps, a.token, manifestOf([500]));
    expect(await reservedOf(deps, plain.json.upload_id)).toBe(500);
    await abort(deps, a.token, plain.json.upload_id);

    // Replacing the tour's first chapter carries the logo: the new one's room is held
    // against the old one's size, and the commit records the new size.
    const update = withLogo([1000, 2000]);
    const replace = await createUpload(deps, a.token, update, replaceOf(tour));
    expect([replace.status, replace.json.settings], replace.text).toEqual([201, true]);
    expect(await reservedOf(deps, replace.json.upload_id)).toBe(LOGO_RULE.maxBytes - 1234);
    expect((await finish(deps, a.token, replace, update, 9, logoPng(777))).status).toBe(201);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3000, logos: 777, uploads: 0, media: 0, used: 3777, allowance: 300_000, over: false, tours: 1 });
    // And a first chapter replaced without a logo takes the logo out of the count.
    const bare = manifestOf([1000, 2000]);
    const without = await createUpload(deps, a.token, bare, replaceOf(tour));
    expect(await reservedOf(deps, without.json.upload_id)).toBe(0);
    expect((await finish(deps, a.token, without, bare, 8)).status).toBe(201);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3000, logos: 0, uploads: 0, media: 0, used: 3000, allowance: 300_000, over: false, tours: 1 });
  });

  it("a replace with the same pictures needs no room and works at the limit", async () => {
    const { deps, a } = await setup();
    const m = manifestOf([500, 600]);
    const tour = await uploadTour(deps, a.token, m, NEW, 5);
    await setAllowance(deps, a, 1100);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 1100, logos: 0, uploads: 0, media: 0, used: 1100, allowance: 1100, over: false, tours: 1 });

    // With hashes, nothing is sent again; without, every picture is sent again. Both fit.
    const reusing = await createWithHashes(deps, a.token, m, replaceOf(tour), 5);
    expect([reusing.status, reusing.json.have], reusing.text).toEqual([201, [1, 2]]);
    expect(await reservedOf(deps, reusing.json.upload_id)).toBe(0);
    expect((await commit(deps, a.token, reusing.json.upload_id)).status).toBe(201);
    const resending = await createUpload(deps, a.token, m, replaceOf(tour));
    expect(resending.status, resending.text).toBe(201);
    expect(await reservedOf(deps, resending.json.upload_id)).toBe(0);
    expect((await finish(deps, a.token, resending, m, 6)).status).toBe(201);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(1100);

    // A smaller chapter needs none either, also in a workspace already over its allowance.
    await setAllowance(deps, a, 10);
    const smaller = manifestOf([500, 100]);
    const shrink = await createUpload(deps, a.token, smaller, replaceOf(tour));
    expect(shrink.status, shrink.text).toBe(201);
    expect(await reservedOf(deps, shrink.json.upload_id)).toBe(0);
    expect((await finish(deps, a.token, shrink, smaller, 7)).status).toBe(201);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 600, logos: 0, uploads: 0, media: 0, used: 600, allowance: 10, over: true, tours: 1 });
  });

  it("a replace that grows the chapter needs only the growth", async () => {
    const { deps, a } = await setup(1500);
    const tour = await uploadTour(deps, a.token, manifestOf([500, 600]), NEW, 1);
    // The whole new chapter (1,400) would not fit beside the old one; its growth (300) does.
    const grown = manifestOf([500, 600, 300]);
    const fits = await createUpload(deps, a.token, grown, replaceOf(tour));
    expect(fits.status, fits.text).toBe(201);
    expect(await reservedOf(deps, fits.json.upload_id)).toBe(300);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(1400);
    // A second replace of the same chapter is held against the same chapter, and the first one's room.
    expectFull(await createUpload(deps, a.token, manifestOf([500, 600, 101]), replaceOf(tour)), 1400, 1500, 101);
    expect((await finish(deps, a.token, fits, grown, 2)).status).toBe(201);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(1400);

    // Growing by more than is left is refused, and the number is the growth alone.
    expectFull(await createUpload(deps, a.token, manifestOf([900, 601]), replaceOf(tour)), 1400, 1500, 101);
    const exact = await createUpload(deps, a.token, manifestOf([900, 600]), replaceOf(tour));
    expect(exact.status, exact.text).toBe(201);
    expect(await reservedOf(deps, exact.json.upload_id)).toBe(100);

    // Only the replaced chapter's own steps are set against the new ones, never another chapter's.
    await abort(deps, a.token, exact.json.upload_id);
    await setAllowance(deps, a, 100_000);
    const second = await uploadTour(deps, a.token, manifestOf([5000], "Second"), chapterOf(tour), 3);
    const other = await createUpload(deps, a.token, manifestOf([5200], "Second"), { kind: "replace", tour_id: tour.tour_id, chapter_id: second.chapter_id });
    expect(await reservedOf(deps, other.json.upload_id)).toBe(200);
  });

  it("with no limit nothing is ever refused", async () => {
    const { deps, a } = await setup();
    const huge = manifestOf(Array.from({ length: 50 }, () => 2_000_000));
    for (let i = 0; i < DEFAULT_MAX_OPEN_UPLOADS; i++) {
      const r = await createUpload(deps, a.token, i === 0 ? withLogo([2_000_000]) : huge);
      expect(r.status, r.text).toBe(201);
      expect(Object.keys(r.json)).toEqual(["upload_id", "steps"]);
      expect(await reservedOf(deps, r.json.upload_id)).toBe(i === 0 ? 2_200_000 : 100_000_000);
    }
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 0, logos: 0, uploads: 402_200_000, media: 0, used: 402_200_000, allowance: null, over: false, tours: 0 });
    // The only refusal is the one there always was, word for word.
    const capped = await createUpload(deps, a.token, huge);
    expect([capped.status, capped.text, capped.headers.get("retry-after")]).toEqual([429, CAP_BODY, "60"]);

    // A workspace's own number comes before the site's, and null there means the site's.
    const { deps: limited, a: owner } = await setup(100);
    expectFull(await createUpload(limited, owner.token, manifestOf([101])), 0, 100, 101);
    await setAllowance(limited, owner, 1_000_000);
    expect((await createUpload(limited, owner.token, manifestOf([101]))).status).toBe(201);
    await setAllowance(limited, owner, null);
    expectFull(await createUpload(limited, owner.token, manifestOf([101])), 101, 100, 101);
  });

  it("a full cap still answers 429 when there is room, and another workspace's use never counts", async () => {
    const { deps, a, b } = await setup(10_000);
    // Workspace B fills its own allowance to the last byte.
    await uploadTour(deps, b.token, manifestOf([9000]));
    const held = await createUpload(deps, b.token, manifestOf([1000]));
    expect(held.status).toBe(201);
    expectFull(await createUpload(deps, b.token, manifestOf([1])), 10_000, 10_000, 1);
    // A is untouched by it.
    expect((await usageOf(deps, a.workspaceId)).used).toBe(0);
    const mine = await uploadTour(deps, a.token, manifestOf([100], "Mine"));
    for (let i = 0; i < DEFAULT_MAX_OPEN_UPLOADS; i++) expect((await createUpload(deps, a.token, manifestOf([100]))).status).toBe(201);
    const capped = await createUpload(deps, a.token, manifestOf([100]));
    expect([capped.status, capped.text, capped.headers.get("retry-after")]).toEqual([429, CAP_BODY, "60"]);
    // With the cap full and no room either, the answer is the one that waiting cannot fix.
    expectFull(await createUpload(deps, a.token, manifestOf([9401])), 600, 10_000, 9401);
    // B cannot aim an upload at A's tour to use A's room: that tour does not exist for B,
    // and the answer is the same whether or not B itself has room.
    for (const target of [chapterOf(mine), replaceOf(mine)]) {
      const r = await createUpload(deps, b.token, manifestOf([1]), target);
      expect([r.status, r.text]).toEqual([404, '{"error":"not_found","detail":"no such tour"}']);
    }
    expect((await usageOf(deps, a.workspaceId)).used).toBe(600);
    expect((await usageOf(deps, b.workspaceId)).used).toBe(10_000);
  });

  it("an allowance of zero refuses every new tour and still lets a tour be deleted", async () => {
    const { deps, a, draftKeys } = await setup();
    const tour = await uploadTour(deps, a.token, manifestOf([500, 600]));
    await setAllowance(deps, a, 0);
    expectFull(await createUpload(deps, a.token, manifestOf([1])), 1100, 0, 1);
    expect((await createUpload(deps, a.token, manifestOf([1]))).json.detail).toContain("has 0 bytes left of its 0 bytes allowance");
    expect((await draftKeys()).length).toBe(2);
    const gone = await send(deps, "DELETE", `/api/v1/tours/${tour.tour_id}`, { token: a.token });
    expect([gone.status, gone.json], gone.text).toEqual([200, { deleted: true }]);
    expect(await draftKeys()).toEqual([]);
    // Empty, and still nothing fits: zero is a limit.
    expectFull(await createUpload(deps, a.token, manifestOf([1])), 0, 0, 1);

    // The site's own setting of zero does the same.
    const { deps: closed, a: owner } = await setup(0);
    expectFull(await createUpload(closed, owner.token, manifestOf([1])), 0, 0, 1);
  });
});

describe("an allowance lowered below what is used", () => {
  /** A published tour with a logo, a draft tour with two chapters and an open upload, then an allowance far below them. */
  async function lowered() {
    const ctx = await setup();
    const { deps, a } = ctx;
    const first = withLogo([1000, 2000], "Published");
    const published = await uploadTour(deps, a.token, first, NEW, 1);
    expect((await publishAll(deps, a.token, published.tour_id)).status).toBe(200);
    const draft = await uploadTour(deps, a.token, manifestOf([3000], "Draft"), NEW, 2);
    const second = await uploadTour(deps, a.token, manifestOf([4000], "Second"), chapterOf(draft), 3);
    const open = await createUpload(deps, a.token, manifestOf([500], "Open"));
    await setAllowance(deps, a, 100);
    const used = 10_000 + 1000 + 500;
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 10_000, logos: 1000, uploads: 500, media: 0, used, allowance: 100, over: true, tours: 2 });
    return { ...ctx, published, draft, second, open: open.json.upload_id as string, used };
  }

  it("over the allowance, list, publish, unpublish, rename and delete still work and nothing is removed", async () => {
    const { deps, a, published, draft, open, used, draftKeys, publicKeys } = await lowered();
    const drafts = await draftKeys();
    const pub = await publicKeys();
    const rows = await counts(deps);
    expect([drafts.length, pub.length]).toEqual([5, 3]);

    const list = await send(deps, "GET", "/api/v1/tours", { token: a.token });
    expect([list.status, list.json.tours.length]).toEqual([200, 2]);
    const slug = (list.json.tours as Json[]).find((t) => t.id === published.tour_id)!.slug as string;
    // The public page and a draft picture still answer.
    expect((await send(deps, "GET", `/t/${slug}`)).status).toBe(200);
    const step = (await deps.db.first<{ id: string }>("SELECT id FROM step WHERE tour_id = ? LIMIT 1", [draft.tour_id]))!.id;
    expect((await send(deps, "GET", `/api/v1/tours/${draft.tour_id}/steps/${step}/image`, { token: a.token })).status).toBe(200);
    // The open upload can still be filled and finished: its room was held when it began.
    expect((await putStep(deps, a.token, open, 1, stepImage(manifestOf([500]).steps[0]))).status).toBe(204);
    expect((await commit(deps, a.token, open)).status).toBe(201);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(used);

    // Nothing was deleted or unpublished by any of it, or by the lowering itself.
    expect((await draftKeys()).filter((k) => drafts.includes(k))).toEqual(drafts);
    expect(await publicKeys()).toEqual(pub);
    expect(await counts(deps)).toEqual({ ...rows, tour: rows.tour + 1, chapter: rows.chapter + 1, step: rows.step + 1, upload: 0, upload_step: 0 });

    // Publish (a draft, and a published tour again), rename, unpublish, delete.
    expect((await publishAll(deps, a.token, draft.tour_id)).status).toBe(200);
    expect((await publishAll(deps, a.token, published.tour_id)).status).toBe(200);
    const renamed = await send(deps, "PATCH", `/api/v1/tours/${draft.tour_id}`, { token: a.token, body: JSON.stringify({ title: "Renamed" }), headers: JSON_HEADERS });
    expect([renamed.status, renamed.json.title]).toEqual([200, "Renamed"]);
    expect((await send(deps, "POST", `/api/v1/tours/${published.tour_id}/unpublish`, { token: a.token })).status).toBe(204);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(used);
    const gone = await send(deps, "DELETE", `/api/v1/tours/${published.tour_id}`, { token: a.token });
    expect([gone.status, gone.json], gone.text).toEqual([200, { deleted: true }]);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 7500, logos: 0, uploads: 0, media: 0, used: 7500, allowance: 100, over: true, tours: 2 });
    // The usage route says so.
    const usage = await send(deps, "GET", "/api/v1/usage", { token: a.token });
    expect(usage.json).toEqual({ used_bytes: 7500, allowance_bytes: 100, over: true, tours: 2, counted: { pictures: 7500, logos: 0, uploads_in_progress: 0 } });
  });

  it("over the allowance, a new tour, a new chapter and a growing replace are refused", async () => {
    const { deps, a, draft, second, used, draftKeys } = await lowered();
    const keys = await draftKeys();
    const rows = await counts(deps);
    expectFull(await createUpload(deps, a.token, manifestOf([1])), used, 100, 1);
    expectFull(await createUpload(deps, a.token, manifestOf([1]), chapterOf(draft)), used, 100, 1);
    const target = { kind: "replace", tour_id: draft.tour_id, chapter_id: second.chapter_id };
    expectFull(await createUpload(deps, a.token, manifestOf([4001], "Second"), target), used, 100, 1);
    expectFull(await createWithHashes(deps, a.token, manifestOf([4000, 50], "Second"), target, 3), used, 100, 50);
    expect(await counts(deps)).toEqual(rows);
    expect(await draftKeys()).toEqual(keys);
    // A replace that does not grow the workspace still works.
    const same = await createUpload(deps, a.token, manifestOf([4000], "Second"), target);
    expect(same.status, same.text).toBe(201);
    // Raising the allowance, or deleting, makes room again; nothing else does.
    await setAllowance(deps, a, used + 1);
    expect((await createUpload(deps, a.token, manifestOf([1]))).status).toBe(201);
  });
});

describe("GET /api/v1/usage", () => {
  it("usage answers for a token with the workspace's own numbers", async () => {
    const { deps, a, b } = await setup(500_000);
    const tour = await uploadTour(deps, a.token, withLogo([1000, 2000]));
    const open = await createUpload(deps, a.token, manifestOf([700]));
    await uploadTour(deps, b.token, manifestOf([100, 200, 300]));
    await uploadTour(deps, b.token, manifestOf([400], "Another"));
    await setAllowance(deps, b, 100);

    const mine = await send(deps, "GET", "/api/v1/usage", { token: a.token });
    expect(mine.status, mine.text).toBe(200);
    expect(mine.text).toBe('{"used_bytes":4700,"allowance_bytes":500000,"over":false,"tours":1,"counted":{"pictures":3000,"logos":1000,"uploads_in_progress":700}}');
    expect(mine.headers.get("content-type")).toBe("application/json");
    expect(mine.headers.get("cache-control")).toBe("no-store");
    // The README shows this answer, with the allowance of its own example.
    expect(README).toContain(mine.text.replace('"allowance_bytes":500000', '"allowance_bytes":1073741824'));
    // The token's lookup, its touch, and one statement for the numbers.
    expect(mine.calls).toBe(3);

    const theirs = await send(deps, "GET", "/api/v1/usage", { token: b.token });
    expect(theirs.json).toEqual({ used_bytes: 1000, allowance_bytes: 100, over: true, tours: 2, counted: { pictures: 1000, logos: 0, uploads_in_progress: 0 } });
    // No id in the address or the body can point it at another workspace.
    for (const path of [`/api/v1/usage?workspace_id=${a.workspaceId}`, `/api/v1/usage?id=${tour.tour_id}&upload_id=${open.json.upload_id}`]) {
      expect((await send(deps, "GET", path, { token: b.token })).text, path).toBe(theirs.text);
    }
    expect((await send(deps, "GET", `/api/v1/usage/${a.workspaceId}`, { token: b.token })).status).toBe(404);

    // Without a token, or with one no workspace has: the one 401, and no number.
    for (const token of [null, "dp_" + "0".repeat(40)]) {
      const r = await send(deps, "GET", "/api/v1/usage", { token });
      expect([r.status, r.text]).toEqual([401, '{"error":"unauthorized"}']);
    }
    // It only reads: asking changes nothing.
    expect((await send(deps, "GET", "/api/v1/usage", { token: a.token })).text).toBe(mine.text);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((await send(deps, method, "/api/v1/usage", { token: a.token })).status, method).toBe(404);

    // With no limit the allowance is null and nothing is over.
    const { deps: free, a: owner } = await setup();
    expect((await send(free, "GET", "/api/v1/usage", { token: owner.token })).text).toBe(
      '{"used_bytes":0,"allowance_bytes":null,"over":false,"tours":0,"counted":{"pictures":0,"logos":0,"uploads_in_progress":0}}',
    );
  });

  it("usage answers on both addresses", async () => {
    const { deps, a } = await setup(9000, { hosts: { tours: "tours.example.com", app: "app.example.com" } });
    await uploadTour(deps, a.token, manifestOf([123]));
    const answers = [];
    for (const origin of ["https://tours.example.com", "https://app.example.com"]) {
      const r = await send(deps, "GET", "/api/v1/usage", { token: a.token, origin });
      expect(r.status, origin).toBe(200);
      answers.push(r.text);
    }
    expect(answers[0]).toBe('{"used_bytes":123,"allowance_bytes":9000,"over":false,"tours":1,"counted":{"pictures":123,"logos":0,"uploads_in_progress":0}}');
    expect(answers[1]).toBe(answers[0]);
    const elsewhere = await send(deps, "GET", "/api/v1/usage", { token: a.token, origin: "https://other.example.net" });
    expect([elsewhere.status, elsewhere.bytes.byteLength]).toEqual([421, 0]);
  });
});

/** A created upload with its one step sent and not committed; returns its id. */
async function openWithStep(deps: Deps, token: string, manifest: Json, fill: number): Promise<string> {
  const created = await createUpload(deps, token, manifest);
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text}`);
  const r = await putStep(deps, token, created.json.upload_id, 1, stepImage(manifest.steps[0], fill));
  if (r.status !== 204) throw new Error(`step failed: ${r.status}`);
  return created.json.upload_id as string;
}

describe("a declared logo size", () => {
  /** A create that also says how many bytes its logo has. */
  const createDeclared = (deps: Deps, token: string, manifest: Json, target: unknown, logo_bytes: unknown) =>
    send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest, target, logo_bytes }), headers: JSON_HEADERS });

  it("an unchanged update of a tour with a logo needs no room when the logo's size is declared", async () => {
    const { deps, a } = await setup();
    const m = withLogo([1000, 2000]);
    const first = await createUpload(deps, a.token, m);
    const tour = (await finish(deps, a.token, first, m, 4, logoPng(1234))).json as Tour;
    // Exactly full.
    await setAllowance(deps, a, 4234);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3000, logos: 1234, uploads: 0, media: 0, used: 4234, allowance: 4234, over: false, tours: 1 });
    const update = await createDeclared(deps, a.token, m, replaceOf(tour), 1234);
    expect([update.status, update.json.settings], update.text).toEqual([201, true]);
    expect(await reservedOf(deps, update.json.upload_id)).toBe(0);
    expect((await finish(deps, a.token, update, m, 5, logoPng(1234))).status).toBe(201);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(4234);

    // And with the allowance lowered below what is used.
    await setAllowance(deps, a, 10);
    const over = await createDeclared(deps, a.token, m, replaceOf(tour), 1234);
    expect(over.status, over.text).toBe(201);
    expect(await reservedOf(deps, over.json.upload_id)).toBe(0);
    expect((await finish(deps, a.token, over, m, 6, logoPng(1234))).status).toBe(201);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3000, logos: 1234, uploads: 0, media: 0, used: 4234, allowance: 10, over: true, tours: 1 });
    // A smaller logo fits as well; a larger one needs its growth and nothing more.
    const smaller = await createDeclared(deps, a.token, m, replaceOf(tour), 1000);
    expect(await reservedOf(deps, smaller.json.upload_id)).toBe(0);
    await abort(deps, a.token, smaller.json.upload_id);
    expectFull(await createDeclared(deps, a.token, m, replaceOf(tour), 1300), 4234, 10, 66);
    // Without the size, the same update needs room for the largest logo there can be.
    expectFull(await createUpload(deps, a.token, m, replaceOf(tour)), 4234, 10, LOGO_RULE.maxBytes - 1234);
  });

  it("a declared logo size is held to at upload", async () => {
    const { deps, a, draftKeys } = await setup(100_000);
    const m = withLogo([1000]);
    const created = await createDeclared(deps, a.token, m, NEW, 1234);
    expect(created.status, created.text).toBe(201);
    expect(created.json).toEqual({ upload_id: created.json.upload_id, steps: 1 });
    const id = created.json.upload_id as string;
    expect(await reservedOf(deps, id)).toBe(2234);
    // A logo of any other length is refused, as a step of the wrong length is, and nothing is stored.
    for (const size of [1233, 1235, 5000]) {
      const r = await putLogo(deps, a.token, id, logoPng(size));
      expect([r.status, r.text], String(size)).toEqual([400, '{"error":"bad_image","detail":"logo: image length differs from the declared logo_bytes"}']);
    }
    expect(await draftKeys()).toEqual([]);
    expect((await commit(deps, a.token, id)).status).toBe(409);
    expect((await putLogo(deps, a.token, id, logoPng(1234))).status).toBe(204);
    const tour = (await finish(deps, a.token, created, m)).json as Tour;
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 1000, logos: 1234, uploads: 0, media: 0, used: 2234, allowance: 100_000, over: false, tours: 1 });

    // Not a whole number of bytes from 1 to the most a logo may weigh: refused, nothing made.
    for (const bad of [0, -1, 1.5, LOGO_RULE.maxBytes + 1, "1234", null, true, [1234]]) {
      const r = await createDeclared(deps, a.token, m, NEW, bad);
      expect([r.status, r.text], JSON.stringify(bad)).toEqual([400, `{"error":"bad_request","detail":"logo_bytes must be a whole number of bytes from 1 to ${LOGO_RULE.maxBytes}"}`]);
    }
    expect((await counts(deps)).upload).toBe(0);
    // The most a logo may weigh is taken as a size, and held against the allowance like any other.
    const most = await createDeclared(deps, a.token, withLogo([1000]), NEW, LOGO_RULE.maxBytes);
    expectFull(most, 2234, 100_000, 201_000);

    // Where the upload carries no logo the number means nothing: nothing is reserved for it.
    const chapter = await createDeclared(deps, a.token, withLogo([500], "Second"), chapterOf(tour), 9999);
    expect(await reservedOf(deps, chapter.json.upload_id)).toBe(500);
    const bare = await createDeclared(deps, a.token, manifestOf([500]), NEW, 9999);
    expect(await reservedOf(deps, bare.json.upload_id)).toBe(500);
  });

  it("without a declared size a logo reserves 200,000 bytes", async () => {
    const { deps, a } = await setup();
    const m = withLogo([1000]);
    const plain = await createUpload(deps, a.token, m);
    expect(await reservedOf(deps, plain.json.upload_id)).toBe(1000 + 200_000);
    const declared = await createDeclared(deps, a.token, m, NEW, 5000);
    expect(await reservedOf(deps, declared.json.upload_id)).toBe(6000);
    // Without a declared size any logo within the rule is taken, as before.
    const tour = (await finish(deps, a.token, plain, m, 0, logoPng(4321))).json as Tour;
    expect((await usageOf(deps, a.workspaceId)).logos).toBe(4321);
    const update = await createUpload(deps, a.token, m, replaceOf(tour));
    expect(await reservedOf(deps, update.json.upload_id)).toBe(200_000 - 4321);
  });

  it("a tour whose logo size was never recorded counts its logo as nothing until an update records it", async () => {
    const { deps, a } = await setup();
    const m = withLogo([1000, 2000]);
    const tour = await uploadTour(deps, a.token, m, NEW, 1);
    // As every tour made before this version: a logo, and no size for it.
    await deps.db.run("UPDATE tour SET logo_bytes = NULL WHERE id = ?", [tour.tour_id]);
    await setAllowance(deps, a, 3000);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3000, logos: 0, uploads: 0, media: 0, used: 3000, allowance: 3000, over: false, tours: 1 });
    // Its logo now counts for the first time, so the update needs room for it.
    expectFull(await createDeclared(deps, a.token, m, replaceOf(tour), 1000), 3000, 3000, 1000);
    expectFull(await createUpload(deps, a.token, m, replaceOf(tour)), 3000, 3000, 200_000);
    await setAllowance(deps, a, 4000);
    const update = await createDeclared(deps, a.token, m, replaceOf(tour), 1000);
    expect(update.status, update.text).toBe(201);
    expect(await reservedOf(deps, update.json.upload_id)).toBe(1000);
    expect((await finish(deps, a.token, update, m, 2, logoPng(1000))).status).toBe(201);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3000, logos: 1000, uploads: 0, media: 0, used: 4000, allowance: 4000, over: false, tours: 1 });
    // From then on the same update needs nothing.
    const again = await createDeclared(deps, a.token, m, replaceOf(tour), 1000);
    expect(await reservedOf(deps, again.json.upload_id)).toBe(0);
    // An update of another chapter never touches the logo, recorded or not.
    await deps.db.run("UPDATE tour SET logo_bytes = NULL WHERE id = ?", [tour.tour_id]);
    await abort(deps, a.token, again.json.upload_id);
    await setAllowance(deps, a, null);
    const second = await uploadTour(deps, a.token, manifestOf([500], "Second"), chapterOf(tour), 3);
    await setAllowance(deps, a, 3500);
    const other = await createDeclared(deps, a.token, manifestOf([500], "Second"), { kind: "replace", tour_id: tour.tour_id, chapter_id: second.chapter_id }, 1000);
    expect([other.status, other.json.settings], other.text).toEqual([201, false]);
    expect(await reservedOf(deps, other.json.upload_id)).toBe(0);
  });
});

describe("a create refused while room appears", () => {
  const isCreate = (sql: string) => sql.startsWith("INSERT INTO upload (id");

  /** Runs `between` once, right after the first create statement ran. Counts the create statements. */
  function afterFirstCreate(deps: Deps, between: () => Promise<void>) {
    const real = { run: deps.db.run.bind(deps.db), batch: deps.db.batch.bind(deps.db) };
    let creates = 0;
    deps.db.run = async (sql, params) => {
      const res = await real.run(sql, params);
      if (isCreate(sql) && ++creates === 1) await between();
      return res;
    };
    deps.db.batch = async (stmts) => {
      await real.batch(stmts);
      if (stmts.some((s) => isCreate(s.sql)) && ++creates === 1) await between();
    };
    return {
      creates: () => creates,
      restore: () => {
        deps.db.run = real.run;
        deps.db.batch = real.batch;
      },
    };
  }

  it("room that appears between the refusal and the look at why is used: the create is tried once more", async () => {
    const { deps, a } = await setup(1000);
    const held = await createUpload(deps, a.token, manifestOf([800]));
    // Another request aborts the upload that held the room, at that very moment.
    const hook = afterFirstCreate(deps, async () => {
      await deps.db.run("UPDATE upload SET closing_at = ? WHERE id = ?", [T0, held.json.upload_id]);
    });
    const made = await createUpload(deps, a.token, manifestOf([900]));
    hook.restore();
    expect(made.status, made.text).toBe(201);
    expect(hook.creates()).toBe(2);
    expect(await reservedOf(deps, made.json.upload_id)).toBe(900);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(900);
  });

  it("the cap's answer is given only when the cap is reached", async () => {
    const { deps, a } = await setup(null, { maxOpenUploads: 2 });
    const one = await createUpload(deps, a.token, manifestOf([100]));
    await createUpload(deps, a.token, manifestOf([100]));
    // The cap is full when the statement runs, and free again when the request looks.
    const hook = afterFirstCreate(deps, async () => {
      await deps.db.run("UPDATE upload SET closing_at = ? WHERE id = ?", [T0, one.json.upload_id]);
    });
    const made = await createUpload(deps, a.token, manifestOf([100]));
    hook.restore();
    expect(made.status, made.text).toBe(201);
    expect(hook.creates()).toBe(2);
    // Really full: the cap's answer, after one statement and no second try.
    const again = afterFirstCreate(deps, async () => {});
    const capped = await createUpload(deps, a.token, manifestOf([100]));
    again.restore();
    expect([capped.status, capped.json.error, capped.headers.get("retry-after")]).toEqual([429, "too_many_uploads", "60"]);
    expect(again.creates()).toBe(1);
    expect(capped.json.detail).toBe("this workspace already has 2 open uploads; finish or cancel one first");
  });

  it("a replace with hashes is tried once more too, and a second refusal answers what is true then", async () => {
    const { deps, a } = await setup(5000);
    const m = manifestOf([1000, 1000]);
    const tour = await uploadTour(deps, a.token, m, NEW, 1);
    const held = await createUpload(deps, a.token, manifestOf([2900]));
    const grown = manifestOf([1000, 1000, 500]);
    // Room appears, then the allowance drops before the second try: storage is the true answer.
    const hook = afterFirstCreate(deps, async () => {
      await deps.db.run("UPDATE upload SET closing_at = ? WHERE id = ?", [T0, held.json.upload_id]);
    });
    const hooked = deps.db.batch.bind(deps.db);
    let batches = 0;
    deps.db.batch = async (stmts) => {
      if (stmts.some((s) => isCreate(s.sql)) && ++batches === 2) await setAllowance(deps, a, 2100);
      return hooked(stmts);
    };
    const refused = await createWithHashes(deps, a.token, grown, replaceOf(tour), 1);
    hook.restore();
    expect(batches).toBe(2);
    expectFull(refused, 2000, 2100, 500);
    expect((await counts(deps)).upload_step).toBe(0);
    // Left alone, it is created at the second try, with its reused steps.
    await setAllowance(deps, a, null);
    const other = await createUpload(deps, a.token, manifestOf([2900]));
    const hook2 = afterFirstCreate(deps, async () => {
      await deps.db.run("UPDATE upload SET closing_at = ? WHERE id = ?", [T0, other.json.upload_id]);
    });
    const made = await createWithHashes(deps, a.token, grown, replaceOf(tour), 1);
    hook2.restore();
    expect([made.status, made.json.have], made.text).toEqual([201, [1, 2]]);
    expect(hook2.creates()).toBe(2);
  });
});

describe("the sweep and the allowance", () => {
  it("stale uploads whose files cannot be deleted are all closed at once and never hold room or a place", async () => {
    const { deps, a, advance } = await setup(10_000, { maxOpenUploads: 8 });
    const old = manifestOf([1000], "Old");
    const stale: string[] = [];
    for (let i = 0; i < 8; i++) stale.push(await openWithStep(deps, a.token, old, i));
    expect((await usageOf(deps, a.workspaceId)).uploads).toBe(8000);
    advance(UPLOAD_MAX_AGE_MS + 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const realDelete = deps.drafts.delete.bind(deps.drafts);
    deps.drafts.delete = async () => {
      throw new Error("bucket unavailable");
    };
    // One create closes all eight, although it can remove none of them.
    const made = await createUpload(deps, a.token, manifestOf([9500], "New"));
    expect(made.status, made.text).toBe(201);
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM upload WHERE closing_at IS NULL"))!.n).toBe(1);
    expect((await counts(deps)).upload).toBe(9);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 0, logos: 0, uploads: 9500, media: 0, used: 9500, allowance: 10_000, over: false, tours: 0 });
    // None of them can be committed any more.
    for (const id of stale) expect((await commit(deps, a.token, id)).status, id).toBe(404);
    expect((await usageOf(deps, a.workspaceId)).used).toBe(9500);
    // Once the store works again, later creates remove them, five at a time.
    deps.drafts.delete = realDelete;
    expect((await createUpload(deps, a.token, manifestOf([100], "Next"))).status).toBe(201);
    expect((await counts(deps)).upload).toBe(2 + 3);
    expect((await createUpload(deps, a.token, manifestOf([100], "Next"))).status).toBe(201);
    expect((await counts(deps)).upload).toBe(3);
    expect((await counts(deps)).upload_step).toBe(0);
  });
});
