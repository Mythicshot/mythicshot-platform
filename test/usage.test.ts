// What a workspace uses against its storage allowance (src/usage.ts), on both targets:
// the sum, the allowance it is held against, the setting, and how sizes are written.
// Nothing here enforces the allowance; the create statement does, in src/uploads.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { parseManifest, type Manifest } from "../src/manifest.ts";
import type { Deps } from "../src/ports.ts";
import { LOGO_RULE } from "../src/sniff.ts";
import { ALLOWANCE_SQL, USED_SQL, allowanceFromSetting, formatBytes, reservedFor, storageFull, usageOf, type Usage } from "../src/usage.ts";
import { SIZE_TABLE } from "./sizes.ts";
import { clone, commit, count, createUpload, fixtures, putStep, send, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const JSON_HEADERS = { "content-type": "application/json" };
const BAD_SETTING = "STORAGE_ALLOWANCE_BYTES is not a number of bytes. Write digits only, such as 1073741824, or leave it out for no limit.";
const NOTHING = { pictures: 0, logos: 0, uploads: 0, media: 0, imageBytes: 0, gifBytes: 0, used: 0, allowance: null, over: false, tours: 0, images: 0, gifs: 0 };

type Ws = { workspaceId: string; token: string };

/** Two workspaces and a clock the test moves. */
async function setup(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps({ retiredGraceMs: 0, ...config });
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

const sum = (m: Json) => (m.steps as Json[]).reduce((n, s) => n + (s.bytes as number), 0);

/** An open upload holding `reserved` bytes, as the create statement will record it. */
async function openUpload(deps: Deps, ws: Ws, reserved: number, manifest: Json = manifestOf([200])): Promise<string> {
  const created = await createUpload(deps, ws.token, manifest);
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text}`);
  const id = created.json.upload_id as string;
  await deps.db.run("UPDATE upload SET reserved_bytes = ? WHERE id = ?", [reserved, id]);
  return id;
}

/** The sum as the create statement will read it: the scalar subquery alone. */
async function usedBySql(deps: Deps, workspaceId: string): Promise<number> {
  return (await deps.db.first<{ used: number }>(`SELECT ${USED_SQL} AS used`, [workspaceId]))!.used;
}

async function publishAll(deps: Deps, token: string, tourId: string): Promise<Call> {
  const path = `/api/v1/tours/${tourId}/publish`;
  let r = await send(deps, "POST", path, { token });
  while (r.status === 202) r = await send(deps, "POST", path, { token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: JSON_HEADERS });
  if (r.status !== 200) throw new Error(`publish failed: ${r.status} ${r.text}`);
  return r;
}

describe("usage of a workspace", () => {
  it("a workspace with nothing uses nothing", async () => {
    const { deps, a, b } = await setup();
    expect(await usageOf(deps, a.workspaceId)).toEqual(NOTHING);
    expect(await usageOf(deps, b.workspaceId)).toEqual(NOTHING);
    expect(await usedBySql(deps, a.workspaceId)).toBe(0);
    // An id no workspace has: nothing, and no error.
    expect(await usageOf(deps, "ws_000000000000000000000000")).toEqual(NOTHING);
    expect(await usedBySql(deps, "ws_000000000000000000000000")).toBe(0);
  });

  it("usage is the bytes of every step, the logos and the reservations of open uploads", async () => {
    const { deps, a } = await setup();
    // A draft tour with a logo, a second chapter in it, and a published tour.
    const first = await uploadTour(deps, a.token, v3);
    const chapter = manifestOf([300, 400], "Second chapter");
    await uploadTour(deps, a.token, chapter, { kind: "chapter", tour_id: first.tour_id });
    const other = manifestOf([1000, 2000, 3000], "Published");
    const published = await uploadTour(deps, a.token, other);
    await publishAll(deps, a.token, published.tour_id);
    const pictures = sum(v3) + sum(chapter) + sum(other);
    expect(pictures).toBe(48213 + 51022 + 402117 + 700 + 6000);

    // The steps, and the size of the first tour's logo, which its commit carried over from the upload.
    expect(await usageOf(deps, a.workspaceId)).toEqual({ ...NOTHING, pictures, logos: 1000, used: pictures + 1000, tours: 2 });
    expect(await deps.db.first("SELECT logo_bytes FROM tour WHERE id = ?", [first.tour_id])).toEqual({ logo_bytes: 1000 });
    // Two open uploads, each holding what its create reserved.
    await openUpload(deps, a, 5000);
    await openUpload(deps, a, 70_000);

    const used = pictures + 1000 + 75_000;
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures, logos: 1000, uploads: 75_000, media: 0, imageBytes: 0, gifBytes: 0, used, allowance: null, over: false, tours: 2, images: 0, gifs: 0 });
    // The scalar subquery the create statement uses gives the same number.
    expect(await usedBySql(deps, a.workspaceId)).toBe(used);
  });

  it("a closing upload is not counted, and an open one counts whatever its age", async () => {
    const { deps, a, advance } = await setup();
    const old = await openUpload(deps, a, 1000);
    const edge = await openUpload(deps, a, 20_000);
    const closing = await openUpload(deps, a, 300_000);
    await openUpload(deps, a, 4_000_000);
    expect((await usageOf(deps, a.workspaceId)).uploads).toBe(4_321_000);

    // An abort marks the upload as closing before its files go.
    await deps.db.run("UPDATE upload SET closing_at = ? WHERE id = ?", [T0, closing]);
    expect((await usageOf(deps, a.workspaceId)).uploads).toBe(4_021_000);

    // An upload can be committed until it is swept, however old it is, so it holds its
    // room until then: at the edge of the day, past it, and later still.
    await deps.db.run("UPDATE upload SET created_at = ? WHERE id = ?", [T0 - DAY, edge]);
    await deps.db.run("UPDATE upload SET created_at = ? WHERE id = ?", [T0 - DAY - 1, old]);
    const usage = await usageOf(deps, a.workspaceId);
    expect(usage).toEqual({ ...NOTHING, uploads: 4_021_000, used: 4_021_000 });
    expect(await usedBySql(deps, a.workspaceId)).toBe(4_021_000);
    advance(30 * DAY);
    expect((await usageOf(deps, a.workspaceId)).uploads).toBe(4_021_000);
    expect(await usedBySql(deps, a.workspaceId)).toBe(4_021_000);
    // The rows are all still there: nothing was removed to make the number.
    expect(await count(deps, "upload")).toBe(4);
  });

  it("a workspace id with no row takes the site's allowance, never no limit", async () => {
    const { deps, a } = await setup({ storageAllowanceBytes: 5000 });
    const nobody = "ws_000000000000000000000000";
    expect(await usageOf(deps, nobody)).toEqual({ ...NOTHING, allowance: 5000 });
    // Also when another workspace has a number of its own.
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = 9 WHERE id = ?", [a.workspaceId]);
    expect((await usageOf(deps, nobody)).allowance).toBe(5000);
    expect((await usageOf(deps, a.workspaceId)).allowance).toBe(9);
    // Zero as the site's number is a limit for it too.
    deps.config.storageAllowanceBytes = 0;
    expect((await usageOf(deps, nobody)).allowance).toBe(0);
  });

  it("published copies, replaced pictures and a deleted tour's files are not counted", async () => {
    const { deps, a, publicKeys } = await setup();
    const m = manifestOf([500, 600, 700]);
    const tour = await uploadTour(deps, a.token, m);
    await uploadTour(deps, a.token, manifestOf([900], "Kept"));
    const before = await usageOf(deps, a.workspaceId);
    expect(before).toEqual({ ...NOTHING, pictures: 2700, used: 2700, tours: 2 });

    // Publishing copies every picture to the public store; the count does not move.
    await publishAll(deps, a.token, tour.tour_id);
    expect(await count(deps, "snapshot_object")).toBe(3);
    expect((await publicKeys()).length).toBe(3);
    expect(await usageOf(deps, a.workspaceId)).toEqual(before);
    // Nor for copies still pending or retired.
    await deps.db.batch([
      { sql: "INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at) VALUES ('0123456789abcdef0123456789abcdef.png', ?, 'pub_x', 'pending', ?)", params: [tour.tour_id, T0] },
      { sql: "INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after) VALUES ('fedcba9876543210fedcba9876543210.png', ?, 'pub_y', 'retired', ?, ?)", params: [tour.tour_id, T0, T0 + 1] },
    ]);
    expect(await usageOf(deps, a.workspaceId)).toEqual(before);

    // A replace takes the old pictures out of the count in its own batch: only the new
    // chapter's steps count, whatever is still waiting to be cleaned up.
    const smaller = manifestOf([100, 150], "Chapter");
    const created = await send(deps, "POST", "/api/v1/uploads", {
      token: a.token,
      body: JSON.stringify({ manifest: smaller, target: { kind: "replace", tour_id: tour.tour_id, chapter_id: tour.chapter_id } }),
      headers: JSON_HEADERS,
    });
    expect(created.status, created.text).toBe(201);
    for (let i = 0; i < smaller.steps.length; i++) expect((await putStep(deps, a.token, created.json.upload_id, i + 1, stepImage(smaller.steps[i], 7))).status).toBe(204);
    expect((await commit(deps, a.token, created.json.upload_id)).status).toBe(201);
    await deps.db.run("INSERT OR IGNORE INTO replaced_object (tour_id, image_key, draft_version, created_at) VALUES (?, 'u/up_000000000000000000000000/step-001.png', 1, ?)", [tour.tour_id, T0]);
    expect(await count(deps, "replaced_object")).toBeGreaterThan(0);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ ...NOTHING, pictures: 250 + 900, used: 250 + 900, tours: 2 });

    // A deleted tour leaves the count with its rows, whatever files still wait.
    await deps.db.run("DELETE FROM replaced_object WHERE image_key = 'u/up_000000000000000000000000/step-001.png'");
    await deps.db.run("DELETE FROM public_object WHERE publish_id IN ('pub_x', 'pub_y')");
    let gone = await send(deps, "DELETE", `/api/v1/tours/${tour.tour_id}`, { token: a.token });
    for (let i = 0; gone.status === 202 && i < 50; i++) gone = await send(deps, "DELETE", `/api/v1/tours/${tour.tour_id}`, { token: a.token });
    expect(gone.status, gone.text).toBe(200);
    await deps.db.batch([
      { sql: "INSERT INTO tour_deletion (tour_id, workspace_id, total, created_at) VALUES ('tour_000000000000000000000000', ?, 2, ?)", params: [a.workspaceId, T0] },
      { sql: "INSERT INTO deleted_object (tour_id, store, image_key) VALUES ('tour_000000000000000000000000', 'drafts', 'u/up_000000000000000000000001/step-001.png')" },
      { sql: "INSERT INTO deleted_object (tour_id, store, image_key) VALUES ('tour_000000000000000000000000', 'public', '00000000000000000000000000000000.png')" },
    ]);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ ...NOTHING, pictures: 900, used: 900, tours: 1 });
    expect(await usedBySql(deps, a.workspaceId)).toBe(900);
  });

  it("another workspace's tours and uploads never enter the sum", async () => {
    const { deps, a, b } = await setup();
    const mine = await uploadTour(deps, a.token, manifestOf([111, 222]));
    await deps.db.run("UPDATE tour SET logo_bytes = 33 WHERE id = ?", [mine.tour_id]);
    await openUpload(deps, a, 4000);

    const theirs = await uploadTour(deps, b.token, manifestOf([50_000, 60_000, 70_000]));
    await uploadTour(deps, b.token, manifestOf([8_000_000 / 4]), { kind: "chapter", tour_id: theirs.tour_id });
    await uploadTour(deps, b.token, manifestOf([900_000], "Another"));
    await deps.db.run("UPDATE tour SET logo_bytes = 150000 WHERE id = ?", [theirs.tour_id]);
    await openUpload(deps, b, 1_000_000);
    await openUpload(deps, b, 2_000_000);
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = 7 WHERE id = ?", [b.workspaceId]);

    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 333, logos: 33, uploads: 4000, media: 0, imageBytes: 0, gifBytes: 0, used: 4366, allowance: null, over: false, tours: 1, images: 0, gifs: 0 });
    expect(await usedBySql(deps, a.workspaceId)).toBe(4366);
    const usedB = 180_000 + 2_000_000 + 900_000 + 150_000 + 3_000_000;
    expect(await usageOf(deps, b.workspaceId)).toEqual({ pictures: 3_080_000, logos: 150_000, uploads: 3_000_000, media: 0, imageBytes: 0, gifBytes: 0, used: usedB, allowance: 7, over: true, tours: 2, images: 0, gifs: 0 });
    expect(await usedBySql(deps, b.workspaceId)).toBe(usedB);
    // The two sums together are everything recorded: nothing is counted twice or left out.
    const all = await deps.db.first<{ n: number }>("SELECT (SELECT coalesce(sum(bytes), 0) FROM step) + (SELECT coalesce(sum(logo_bytes), 0) FROM tour) + (SELECT coalesce(sum(reserved_bytes), 0) FROM upload) AS n");
    expect(all!.n).toBe(4366 + usedB);
  });

  it("the allowance is the workspace's own number, else the site's, else none", async () => {
    const none = await setup();
    expect((await usageOf(none.deps, none.a.workspaceId)).allowance).toBeNull();
    const explicit = await setup({ storageAllowanceBytes: null });
    expect((await usageOf(explicit.deps, explicit.a.workspaceId)).allowance).toBeNull();
    // With no site default, a workspace's own number still holds.
    await explicit.deps.db.run("UPDATE workspace SET storage_allowance_bytes = 2500 WHERE id = ?", [explicit.a.workspaceId]);
    expect((await usageOf(explicit.deps, explicit.a.workspaceId)).allowance).toBe(2500);
    expect((await usageOf(explicit.deps, explicit.b.workspaceId)).allowance).toBeNull();

    const { deps, a, b } = await setup({ storageAllowanceBytes: 1_073_741_824 });
    expect((await usageOf(deps, a.workspaceId)).allowance).toBe(1_073_741_824);
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = 5000 WHERE id = ?", [a.workspaceId]);
    expect((await usageOf(deps, a.workspaceId)).allowance).toBe(5000);
    expect((await usageOf(deps, b.workspaceId)).allowance).toBe(1_073_741_824);
    // Zero is a number of its own, not "use the site's".
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = 0 WHERE id = ?", [a.workspaceId]);
    expect((await usageOf(deps, a.workspaceId)).allowance).toBe(0);
    // Back to null: the site's again.
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = NULL WHERE id = ?", [a.workspaceId]);
    expect((await usageOf(deps, a.workspaceId)).allowance).toBe(1_073_741_824);
    // The expression alone, as the create statement will use it.
    const row = await deps.db.first<{ allowance: number | null }>(`SELECT ${ALLOWANCE_SQL} AS allowance FROM workspace WHERE id = ?`, [42, b.workspaceId]);
    expect(row).toEqual({ allowance: 42 });
    // The database refuses a negative number.
    await expect(deps.db.run("UPDATE workspace SET storage_allowance_bytes = -1 WHERE id = ?", [a.workspaceId])).rejects.toThrow();
    expect((await usageOf(deps, a.workspaceId)).allowance).toBe(1_073_741_824);
    // The largest number the setting takes comes back whole, as the site's and as a workspace's own.
    const big = await setup({ storageAllowanceBytes: Number.MAX_SAFE_INTEGER });
    expect((await usageOf(big.deps, big.a.workspaceId)).allowance).toBe(Number.MAX_SAFE_INTEGER);
    await big.deps.db.run("UPDATE workspace SET storage_allowance_bytes = ? WHERE id = ?", [Number.MAX_SAFE_INTEGER, big.b.workspaceId]);
    big.deps.config.storageAllowanceBytes = 5;
    expect((await usageOf(big.deps, big.b.workspaceId)).allowance).toBe(Number.MAX_SAFE_INTEGER);
    expect((await usageOf(big.deps, big.a.workspaceId)).allowance).toBe(5);
  });

  it("exactly the allowance is not over it", async () => {
    const { deps, a } = await setup();
    await uploadTour(deps, a.token, manifestOf([600, 400]));
    const allow = (n: number | null) => deps.db.run("UPDATE workspace SET storage_allowance_bytes = ? WHERE id = ?", [n, a.workspaceId]);
    await allow(1000);
    expect(await usageOf(deps, a.workspaceId)).toEqual({ ...NOTHING, pictures: 1000, used: 1000, allowance: 1000, over: false, tours: 1 });
    await allow(999);
    expect(await usageOf(deps, a.workspaceId)).toMatchObject({ used: 1000, allowance: 999, over: true });
    await allow(1001);
    expect(await usageOf(deps, a.workspaceId)).toMatchObject({ used: 1000, allowance: 1001, over: false });
    await allow(0);
    expect(await usageOf(deps, a.workspaceId)).toMatchObject({ used: 1000, allowance: 0, over: true });
    await allow(null);
    expect(await usageOf(deps, a.workspaceId)).toMatchObject({ used: 1000, allowance: null, over: false });
    // An empty workspace with an allowance of zero uses exactly its allowance.
    const empty = await setup({ storageAllowanceBytes: 0 });
    expect(await usageOf(empty.deps, empty.a.workspaceId)).toEqual({ ...NOTHING, allowance: 0 });
  });

  it("usage is one database call", async () => {
    const { deps, a, calls } = await setup({ storageAllowanceBytes: 10_000 });
    await uploadTour(deps, a.token, manifestOf([600, 400]));
    await openUpload(deps, a, 50);
    const before = calls();
    const usage = await usageOf(deps, a.workspaceId);
    expect(calls() - before).toBe(1);
    expect(usage).toEqual({ pictures: 1000, logos: 0, uploads: 50, media: 0, imageBytes: 0, gifBytes: 0, used: 1050, allowance: 10_000, over: false, tours: 1, images: 0, gifs: 0 });
  });
});

describe("the largest tours", () => {
  const LARGEST = "/api/v1/usage/largest";

  it("answers the ten largest tours of the caller's own workspace, largest first, ties by id", async () => {
    const { deps, a, b } = await setup();
    // Twelve tours in A: sizes 1100 to 2200, but two of them the same size (1500).
    const sizes = [1100, 1200, 1300, 1400, 1500, 1500, 1700, 1800, 1900, 2000, 2100, 2200];
    const made: { id: string; title: string; bytes: number }[] = [];
    for (const [i, bytes] of sizes.entries()) {
      const title = `Tour ${i + 1}`;
      const t = await uploadTour(deps, a.token, manifestOf([bytes - 100, 100], title), { kind: "new" }, i);
      made.push({ id: t.tour_id, title, bytes });
    }
    // A logo counts in its tour's size, as in the usage.
    const withLogo = await uploadTour(deps, a.token, v3, { kind: "new" }, 99);
    made.push({ id: withLogo.tour_id, title: v3.title as string, bytes: sum(v3) + 1000 });
    // B's tours are larger than all of A's, and never in A's answer.
    await uploadTour(deps, b.token, manifestOf([900_000], "Bravo giant"));

    const r = await send(deps, "GET", LARGEST, { token: a.token });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const want = [...made].sort((x, y) => y.bytes - x.bytes || (x.id < y.id ? -1 : 1)).slice(0, 10);
    expect(r.json).toEqual({ tours: want, largest: want.map((t) => ({ kind: "tour", ...t })) });
    for (const t of r.json.tours) expect(Object.keys(t)).toEqual(["id", "title", "bytes"]);
    // The two of 1500 bytes are both in it, in the order of their ids.
    const tied = made.filter((t) => t.bytes === 1500).map((t) => t.id).sort();
    expect(r.json.tours.filter((t: Json) => t.bytes === 1500).map((t: Json) => t.id)).toEqual(tied);
    // Each size is the one the tour list gives.
    const listed = Object.fromEntries(((await send(deps, "GET", "/api/v1/tours", { token: a.token })).json.tours as Json[]).map((t) => [t.id, t.bytes]));
    for (const t of r.json.tours) expect(t.bytes, t.id).toBe(listed[t.id]);
    // B sees only its own.
    expect((await send(deps, "GET", LARGEST, { token: b.token })).json.tours.map((t: Json) => t.title)).toEqual(["Bravo giant"]);
  });

  it("an empty workspace has no largest tours, and nobody without a credential gets any", async () => {
    const { deps, a } = await setup();
    expect((await send(deps, "GET", LARGEST, { token: a.token })).json).toEqual({ tours: [], largest: [] });
    const nobody = await send(deps, "GET", LARGEST);
    expect([nobody.status, nobody.text]).toEqual([401, '{"error":"unauthorized"}']);
  });

  it("the answer makes as many database calls for many tours as for few", async () => {
    const { deps, a, calls } = await setup();
    await uploadTour(deps, a.token, manifestOf([500]));
    const callsFor = async () => {
      const before = calls();
      expect((await send(deps, "GET", LARGEST, { token: a.token })).status).toBe(200);
      return calls() - before;
    };
    await callsFor();
    const few = await callsFor();
    for (let i = 1; i <= 11; i++) await uploadTour(deps, a.token, manifestOf([500 + i]), { kind: "new" }, i);
    expect(await callsFor()).toBe(few);
  });
});

// ---- Shared items in the usage and the largest list ----

type ItemSpec = { kind: "image" | "clip"; bytes: number; state?: "uploading" | "online" | "closing"; preview?: number; title?: string | null; type?: string };
let itemSeq = 0;

/**
 * One shared item's row, written as src/media.ts leaves it in each state: the declared
 * bytes, the state, and a claimed preview's size. The API's own steps are tested in
 * test/media.test.ts; here only the numbers they leave behind matter.
 */
async function item(deps: Deps, ws: Ws, spec: ItemSpec): Promise<string> {
  itemSeq++;
  const id = "med_" + itemSeq.toString(16).padStart(24, "0");
  // Each hex digit of the number as a letter from a to p: unique, and in the link's alphabet.
  const link = itemSeq.toString(16).padStart(20, "0").replace(/[0-9a-f]/g, (d) => String.fromCharCode(97 + parseInt(d, 16)));
  const type = spec.type ?? (spec.kind === "image" ? "image/png" : "image/gif");
  const preview = spec.preview ?? null;
  const state = spec.state ?? "online";
  await deps.db.run(
    `INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, preview_type, preview_bytes, created_at, online_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 64, 64, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ws.workspaceId, link, spec.kind, type, spec.bytes, spec.kind === "clip" ? 1000 : null, spec.title ?? null, state, preview === null ? null : "png", preview, T0, state === "online" ? T0 : null],
  );
  return id;
}

/** What GET /api/v1/usage answers. */
const usageAnswer = async (deps: Deps, token: string) => (await send(deps, "GET", "/api/v1/usage", { token })).json as Json;

const sumOf = (o: Json) => Object.values(o as Record<string, number>).reduce((x, y) => x + y, 0);

describe("shared items in the usage", () => {
  it("counts images and GIFs apart, each with its preview; an unfinished item counts its bytes but not as an item, a closing one counts nothing", async () => {
    const { deps, a } = await setup({ storageAllowanceBytes: 10_000_000 });
    await uploadTour(deps, a.token, manifestOf([600, 400]));
    await openUpload(deps, a, 50);
    // Images: one online with a preview, one online without, one still being sent with a claimed preview, one closing.
    await item(deps, a, { kind: "image", bytes: 5000, preview: 700 });
    await item(deps, a, { kind: "image", bytes: 3000, type: "image/jpeg" });
    await item(deps, a, { kind: "image", bytes: 2000, state: "uploading", preview: 90 });
    await item(deps, a, { kind: "image", bytes: 400_000, state: "closing", preview: 999 });
    // Clips: a GIF and an MP4 online (one with a preview), one still being sent, one closing.
    await item(deps, a, { kind: "clip", bytes: 40_000, preview: 1200 });
    await item(deps, a, { kind: "clip", bytes: 60_000, type: "video/mp4" });
    await item(deps, a, { kind: "clip", bytes: 9000, state: "uploading" });
    await item(deps, a, { kind: "clip", bytes: 800_000, state: "closing" });

    const imageBytes = 5000 + 700 + 3000 + 2000 + 90;
    const gifBytes = 40_000 + 1200 + 60_000 + 9000;
    const used = 1000 + 50 + imageBytes + gifBytes;
    expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 1000, logos: 0, uploads: 50, media: imageBytes + gifBytes, imageBytes, gifBytes, used, allowance: 10_000_000, over: false, tours: 1, images: 2, gifs: 2 });
    // The create statement holds the workspace against the very same number.
    expect(await usedBySql(deps, a.workspaceId)).toBe(used);

    const r = await send(deps, "GET", "/api/v1/usage", { token: a.token });
    expect(r.status).toBe(200);
    expect(r.text).toBe(
      `{"used_bytes":${used},"allowance_bytes":10000000,"over":false,"tours":1,"images":2,"gifs":2,"counted":{"pictures":1000,"logos":0,"uploads_in_progress":50,"images":${imageBytes},"gifs":${gifBytes}}}`,
    );
    // The numbers of counted add up to used_bytes.
    expect(sumOf(r.json.counted)).toBe(r.json.used_bytes);
    // Finishing the unfinished image makes it an item; its bytes were counted all along.
    await deps.db.run("UPDATE media SET state = 'online' WHERE workspace_id = ? AND kind = 'image' AND state = 'uploading'", [a.workspaceId]);
    expect(await usageAnswer(deps, a.token)).toMatchObject({ used_bytes: used, images: 3, gifs: 2, counted: { images: imageBytes } });
    // Deleting closes an item first: from then on it counts nothing.
    await deps.db.run("UPDATE media SET state = 'closing' WHERE workspace_id = ? AND kind = 'clip' AND bytes = 40000", [a.workspaceId]);
    const after = await usageAnswer(deps, a.token);
    expect(after).toMatchObject({ used_bytes: used - 41_200, gifs: 1, counted: { gifs: gifBytes - 41_200 } });
    expect(sumOf(after.counted)).toBe(after.used_bytes);
    expect(await usedBySql(deps, a.workspaceId)).toBe(used - 41_200);
  });

  it("the sum of counted is used_bytes whatever the workspace holds, and the two kinds add up to every item that is not closing", async () => {
    const { deps, a } = await setup();
    const states = ["uploading", "online", "closing"] as const;
    for (const [i, state] of states.entries()) {
      for (const kind of ["image", "clip"] as const) {
        await item(deps, a, { kind, state, bytes: 1000 * (i + 1) + (kind === "clip" ? 7 : 3) });
        await item(deps, a, { kind, state, bytes: 100 * (i + 1), preview: 11 * (i + 1) });
      }
      await openUpload(deps, a, 10 + i);
      await uploadTour(deps, a.token, manifestOf([300 + i]), { kind: "new" }, i);
      const u = await usageAnswer(deps, a.token);
      expect(sumOf(u.counted), state).toBe(u.used_bytes);
      expect(u.used_bytes, state).toBe(await usedBySql(deps, a.workspaceId));
      const notClosing = await deps.db.first<{ n: number }>("SELECT coalesce(sum(bytes + coalesce(preview_bytes, 0)), 0) AS n FROM media WHERE workspace_id = ? AND state <> 'closing'", [a.workspaceId]);
      expect((u.counted.images as number) + (u.counted.gifs as number), state).toBe(notClosing!.n);
    }
  });

  it("another workspace's items never enter the numbers", async () => {
    const { deps, a, b } = await setup();
    await item(deps, a, { kind: "image", bytes: 1234 });
    await item(deps, b, { kind: "image", bytes: 900_000, preview: 50 });
    await item(deps, b, { kind: "clip", bytes: 800_000, state: "uploading" });
    expect(await usageAnswer(deps, a.token)).toEqual({ used_bytes: 1234, allowance_bytes: null, over: false, tours: 0, images: 1, gifs: 0, counted: { pictures: 0, logos: 0, uploads_in_progress: 0, images: 1234, gifs: 0 } });
    expect(await usageAnswer(deps, b.token)).toEqual({ used_bytes: 1_700_050, allowance_bytes: null, over: false, tours: 0, images: 1, gifs: 0, counted: { pictures: 0, logos: 0, uploads_in_progress: 0, images: 900_050, gifs: 800_000 } });
  });

  it("the storage-full answer names this tour, this image or this GIF", async () => {
    const u: Usage = { pictures: 900, logos: 0, uploads: 0, media: 0, imageBytes: 0, gifBytes: 0, used: 900, allowance: 1000, over: false, tours: 1, images: 0, gifs: 0 };
    const detail = async (of?: "tour" | "image" | "clip") => ((await storageFull(u, 500, of).json()) as Json).detail;
    const room = "needs 500 bytes of room, but the workspace has 100 bytes left of its 1000 bytes allowance. Nothing was uploaded.";
    expect(await detail()).toBe(`this tour ${room} Delete tours you no longer need, or ask the site's admin for more room`);
    expect(await detail("tour")).toBe(await detail());
    expect(await detail("image")).toBe(`this image ${room} Delete what you no longer need, or ask the site's admin for more room`);
    expect(await detail("clip")).toBe(`this GIF ${room} Delete what you no longer need, or ask the site's admin for more room`);
  });
});

describe("the largest of every kind", () => {
  const LARGEST = "/api/v1/usage/largest";

  it("mixes tours, images and GIFs, largest first and ties by id, each with its kind; an item's size holds its preview, and an untitled item has null", async () => {
    const { deps, a, b } = await setup();
    const want: Json[] = [];
    // Tours of 1000 to 5000 bytes.
    const tours: Json[] = [];
    for (const [i, bytes] of [1000, 2000, 3000, 4000, 5000].entries()) {
      const title = `Tour ${i + 1}`;
      const t = await uploadTour(deps, a.token, manifestOf([bytes], title), { kind: "new" }, i);
      tours.push({ id: t.tour_id, title, bytes });
      want.push({ kind: "tour", id: t.tour_id, title, bytes });
    }
    // Items around them: one as large as a tour (a tie, by id), one whose preview takes it past a tour, one untitled, one unfinished.
    const add = async (spec: ItemSpec, kind: "image" | "gif", bytes: number) => want.push({ kind, id: await item(deps, a, spec), title: spec.title ?? null, bytes });
    await add({ kind: "image", bytes: 3000, title: "Tie with Tour 3" }, "image", 3000);
    await add({ kind: "image", bytes: 3900, preview: 200, title: "Image with preview" }, "image", 4100);
    await add({ kind: "clip", bytes: 4500, title: null }, "gif", 4500);
    await add({ kind: "clip", bytes: 4700, type: "video/mp4", title: '<img src=x onerror="alert(1)">' }, "gif", 4700);
    await add({ kind: "image", bytes: 2500, state: "uploading", title: "Still sending" }, "image", 2500);
    await add({ kind: "clip", bytes: 1500, preview: 10, title: "Small" }, "gif", 1510);
    await add({ kind: "image", bytes: 900, title: "Smallest" }, "image", 900);
    // A closing item is not listed, however large; nor is anything of B.
    await item(deps, a, { kind: "clip", bytes: 9_000_000, state: "closing", title: "Being deleted" });
    await item(deps, b, { kind: "image", bytes: 8_000_000, title: "Bravo image" });
    await item(deps, b, { kind: "clip", bytes: 7_000_000, title: "Bravo GIF" });
    await uploadTour(deps, b.token, manifestOf([1_500_000, 1_500_000, 1_500_000, 1_500_000], "Bravo tour"));

    const r = await send(deps, "GET", LARGEST, { token: a.token });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const order = (x: Json, y: Json) => y.bytes - x.bytes || (x.id < y.id ? -1 : 1);
    expect(r.json.largest).toEqual([...want].sort(order).slice(0, 10));
    for (const e of r.json.largest) expect(Object.keys(e)).toEqual(["kind", "id", "title", "bytes"]);
    // The tie: the tour and the image of 3000 bytes, in the order of their ids.
    const tied = want.filter((e) => e.bytes === 3000).map((e) => e.id).sort();
    expect(r.json.largest.filter((e: Json) => e.bytes === 3000).map((e: Json) => e.id)).toEqual(tied);
    // The smallest two of twelve are left out.
    expect(r.json.largest.map((e: Json) => e.title)).not.toContain("Smallest");
    expect(r.json.largest.map((e: Json) => e.title)).not.toContain("Tour 1");
    // The tours list is as it always was: tours only, without a kind.
    expect(r.json.tours).toEqual([...tours].sort(order));
    // A title holding markup comes back as the text it is.
    expect(r.text).toContain(JSON.stringify('<img src=x onerror="alert(1)">'));
    // B sees only its own, and never A's.
    const theirs = (await send(deps, "GET", LARGEST, { token: b.token })).json;
    expect(theirs.largest.map((e: Json) => [e.kind, e.title])).toEqual([
      ["image", "Bravo image"],
      ["gif", "Bravo GIF"],
      ["tour", "Bravo tour"],
    ]);
    const mine = new Set(want.map((e) => e.id));
    for (const e of theirs.largest) expect(mine.has(e.id)).toBe(false);
    for (const e of r.json.largest) expect(["Bravo image", "Bravo GIF", "Bravo tour", "Being deleted"]).not.toContain(e.title);
  });

  it("with fewer than ten things, the sizes add up to what the usage counts for tours and items", async () => {
    const { deps, a } = await setup();
    await uploadTour(deps, a.token, v3);
    await item(deps, a, { kind: "image", bytes: 5000, preview: 100 });
    await item(deps, a, { kind: "clip", bytes: 7000, state: "uploading" });
    await item(deps, a, { kind: "clip", bytes: 9000, state: "closing" });
    const u = await usageAnswer(deps, a.token);
    const listed = (await send(deps, "GET", LARGEST, { token: a.token })).json.largest as Json[];
    expect(listed.map((e) => e.kind).sort()).toEqual(["gif", "image", "tour"]);
    const total = listed.reduce((n, e) => n + (e.bytes as number), 0);
    expect(total).toBe(u.counted.pictures + u.counted.logos + u.counted.images + u.counted.gifs);
  });

  it("the answer is as many database calls for many tours and items as for few, and as many as the usage's one statement", async () => {
    const { deps, a, calls } = await setup();
    await uploadTour(deps, a.token, manifestOf([500]));
    await item(deps, a, { kind: "image", bytes: 300 });
    const callsFor = async (path: string) => {
      const before = calls();
      expect((await send(deps, "GET", path, { token: a.token })).status).toBe(200);
      return calls() - before;
    };
    await callsFor(LARGEST);
    const few = await callsFor(LARGEST);
    for (let i = 1; i <= 11; i++) {
      await uploadTour(deps, a.token, manifestOf([500 + i]), { kind: "new" }, i);
      await item(deps, a, { kind: i % 2 ? "image" : "clip", bytes: 400 + i });
    }
    expect(await callsFor(LARGEST)).toBe(few);
    // The usage reads its numbers in one statement after the credential; the two lists cost the same.
    expect(await callsFor("/api/v1/usage")).toBe(few);
  });
});

describe("what an upload reserves", () => {
  const parsed = (m: Json): Manifest => {
    const r = parseManifest(m);
    if (!r.ok) throw new Error(r.error);
    return r.manifest;
  };

  it("an upload reserves the bytes of all its steps, and 200,000 more for a logo it takes", () => {
    const withLogo = parsed(v3);
    expect(withLogo.cover?.logo).toBe("logo.png");
    expect(LOGO_RULE.maxBytes).toBe(200_000);
    expect(reservedFor(withLogo, true)).toBe(48213 + 51022 + 402117 + 200_000);
    // An upload into an existing tour keeps that tour's logo and sends none.
    expect(reservedFor(withLogo, false)).toBe(48213 + 51022 + 402117);
    // A manifest that names no logo reserves none, whatever the upload could take.
    const plain = parsed(manifestOf([10, 20, 30]));
    expect(reservedFor(plain, true)).toBe(60);
    expect(reservedFor(plain, false)).toBe(60);
  });
});

describe("the STORAGE_ALLOWANCE_BYTES setting", () => {
  it("no setting means no limit", () => {
    for (const raw of [undefined, "", "   ", "\t", "\r\n"]) expect(allowanceFromSetting(raw), JSON.stringify(raw)).toEqual({ ok: true, bytes: null });
  });

  it("digits are the limit, and zero is a limit", () => {
    expect(allowanceFromSetting("0")).toEqual({ ok: true, bytes: 0 });
    expect(allowanceFromSetting("1")).toEqual({ ok: true, bytes: 1 });
    expect(allowanceFromSetting("1073741824")).toEqual({ ok: true, bytes: 1_073_741_824 });
    expect(allowanceFromSetting("9007199254740991")).toEqual({ ok: true, bytes: Number.MAX_SAFE_INTEGER });
    // As written by hand in a settings file: spaces or a line end around it, zeros in front.
    expect(allowanceFromSetting(" 1073741824 \r")).toEqual({ ok: true, bytes: 1_073_741_824 });
    expect(allowanceFromSetting("000")).toEqual({ ok: true, bytes: 0 });
    expect(allowanceFromSetting("0000000000000000000000000000512")).toEqual({ ok: true, bytes: 512 });
  });

  it("a sign, a decimal, a unit or a number past the safe range is refused with the fixed line", () => {
    const bad = [
      "-1", "+5", "-0", "1.5", "1.0", "1,000", "1 000", "1_000", "1e9", "0x10", "1GB", "1 GB", "10mb", "1073741824 bytes", "none", "null", "unlimited", "Infinity", "NaN",
      "9007199254740992", "9007199254740993", "99999999999999999999", "1" + "0".repeat(400),
      "１２３", "٣", "1\n2", "12made-up34",
    ];
    for (const raw of bad) {
      const r = allowanceFromSetting(raw);
      expect(r, JSON.stringify(raw)).toEqual({ ok: false, problem: BAD_SETTING });
    }
    // The line never repeats what was written.
    expect(BAD_SETTING).not.toContain("made-up");
  });
});

describe("how sizes are written", () => {
  it("sizes read as the pages write them: 1024 to a unit, at most one decimal, no trailing .0", () => {
    // The one table the dashboard's script is held to as well (test/sizes.ts).
    for (const [n, text] of SIZE_TABLE) expect(formatBytes(n), String(n)).toBe(text);
    // No size it could be given is negative or not a number; if one were, it reads as nothing.
    for (const n of [-1, -1024, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(formatBytes(n), String(n)).toBe("0 bytes");
    // Never a second digit after the point, a trailing .0, an exponent or a unit past GB.
    for (const n of [999, 1000, 1025, 99_999, 999_999, 1_048_575, 123_456_789, 9_999_999_999, 1024 ** 4 + 1]) expect(formatBytes(n), String(n)).toMatch(/^(\d{1,4} bytes?|\d+(\.[1-9])? (KB|MB|GB))$/);
  });
});
