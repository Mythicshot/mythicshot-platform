// Rename and delete of a tour (src/tours.ts), on both targets. Every request goes through
// test/bundle.ts, which holds each one to the call budget.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { SUBREQUEST_BUDGET } from "../src/budget.ts";
import type { Deps } from "../src/ports.ts";
import { STALE_PUBLISH_MS, type Snapshot } from "../src/publish.ts";
import { DELETE_FILES_PER_CALL } from "../src/tours.ts";
import { clone, commit, count, createUpload, fixtures, putStep, send, sendAll, sha256Hex, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
const T0 = 1_800_000_000_000;
const MIN = 60_000;

type Ws = { workspaceId: string; token: string };

/** Two workspaces, replaced images deleted at once unless the test sets a grace, and a clock the test moves. */
async function setup(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps({ retiredGraceMs: 0, ...config });
  const a: Ws = await seedWorkspace(ctx.deps, "Workspace A");
  const b: Ws = await seedWorkspace(ctx.deps, "Workspace B");
  let now = T0;
  ctx.deps.now = () => now;
  return { ...ctx, a, b, advance: (ms: number) => (now += ms) };
}

const JSON_HEADERS = { "content-type": "application/json" };
const rename = (deps: Deps, token: string | null, tourId: string, body: unknown) =>
  send(deps, "PATCH", `/api/v1/tours/${tourId}`, { token, body: typeof body === "string" ? body : JSON.stringify(body), headers: JSON_HEADERS });
const del = (deps: Deps, token: string | null, tourId: string) => send(deps, "DELETE", `/api/v1/tours/${tourId}`, { token });
const publish = (deps: Deps, token: string, tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
const resume = (deps: Deps, token: string, tourId: string, publishId: string) =>
  send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token, body: JSON.stringify({ publish_id: publishId }), headers: JSON_HEADERS });
const list = async (deps: Deps, token: string): Promise<Json[]> => (await send(deps, "GET", "/api/v1/tours", { token })).json.tours;

async function publishAll(deps: Deps, token: string, tourId: string): Promise<Call> {
  let r = await publish(deps, token, tourId);
  while (r.status === 202) r = await resume(deps, token, tourId, r.json.publish_id);
  if (r.status !== 200) throw new Error(`publish failed: ${r.status} ${r.text}`);
  return r;
}

/** Calls delete until it is no longer in progress, as the desktop app does. */
async function deleteAll(deps: Deps, token: string, tourId: string): Promise<Call[]> {
  const calls = [await del(deps, token, tourId)];
  while (calls.at(-1)!.status === 202) {
    if (calls.length > 50) throw new Error("delete does not finish");
    calls.push(await del(deps, token, tourId));
  }
  return calls;
}

async function tourRow(deps: Deps, id: string): Promise<Json | null> {
  return deps.db.first<Json>("SELECT * FROM tour WHERE id = ?", [id]);
}

async function snapshotOf(deps: Deps, tourId: string): Promise<Snapshot | null> {
  const row = await deps.db.first<{ data: string }>("SELECT data FROM snapshot WHERE tour_id = ?", [tourId]);
  return row === null ? null : (JSON.parse(row.data) as Snapshot);
}

/** Every draft key a tour's rows name: its steps and its logo. */
async function draftKeysOf(deps: Deps, tourId: string): Promise<string[]> {
  const steps = await deps.db.all<{ image_key: string }>("SELECT image_key FROM step WHERE tour_id = ?", [tourId]);
  const logo = await deps.db.first<{ logo_key: string | null }>("SELECT logo_key FROM tour WHERE id = ?", [tourId]);
  return [...steps.map((s) => s.image_key), ...(logo?.logo_key ? [logo.logo_key] : [])].sort();
}

/** Every public key a tour's rows name: live, in grace, or pending. */
async function publicKeysOf(deps: Deps, tourId: string): Promise<string[]> {
  const rows = await deps.db.all<{ image_key: string }>(
    "SELECT image_key FROM snapshot_object WHERE tour_id = ? UNION SELECT image_key FROM public_object WHERE tour_id = ?",
    [tourId, tourId],
  );
  return rows.map((r) => r.image_key).sort();
}

/** Row counts of every table that can hold something of a tour. */
async function rowsOf(deps: Deps, tourId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const one = async (name: string, sql: string) => {
    out[name] = (await deps.db.first<{ n: number }>(sql, [tourId]))!.n;
  };
  await one("tour", "SELECT count(*) AS n FROM tour WHERE id = ?");
  for (const t of ["chapter", "step", "upload", "snapshot", "snapshot_object", "public_object", "publish_job", "tour_deletion", "deleted_object"]) {
    await one(t, `SELECT count(*) AS n FROM ${t} WHERE tour_id = ?`);
  }
  return out;
}

const GONE = { tour: 0, chapter: 0, step: 0, upload: 0, snapshot: 0, snapshot_object: 0, public_object: 0, publish_job: 0, tour_deletion: 0, deleted_object: 0 };

/** A manifest of `n` small PNG steps. */
function manyStepManifest(n: number, title = "Many steps"): Json {
  const m = clone(v2);
  m.title = title;
  const base = m.steps[1];
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120 }));
  return m;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the tour list", { timeout: 60_000 }, () => {
  it("gives the desktop app the link, the slug and when a tour was published; a draft has no link", async () => {
    const { deps, a, advance } = await setup();
    const draft = await uploadTour(deps, a.token, v2);
    advance(1000);
    const live = await uploadTour(deps, a.token, v3);
    advance(1000);
    const published = await publishAll(deps, a.token, live.tour_id);
    const slugOf = async (id: string) => (await tourRow(deps, id))!.slug as string;
    expect(await list(deps, a.token)).toEqual([
      { id: live.tour_id, title: "Send an invoice", status: "published", slug: await slugOf(live.tour_id), url: published.json.url, chapters: 1, steps: 3, updated_at: T0 + 1000, published_at: T0 + 2000, unpublished_changes: false },
      { id: draft.tour_id, title: "Send an invoice", status: "draft", slug: await slugOf(draft.tour_id), url: null, chapters: 1, steps: 3, updated_at: T0, published_at: null, unpublished_changes: false },
    ]);
    expect(published.json.url).toBe(`/t/${await slugOf(live.tour_id)}`);
    // Unpublished again: a draft, with no link.
    expect((await send(deps, "POST", `/api/v1/tours/${live.tour_id}/unpublish`, { token: a.token })).status).toBe(204);
    const again = (await list(deps, a.token)).find((t) => t.id === live.tour_id)!;
    expect([again.status, again.url, again.published_at]).toEqual(["draft", null, null]);
  });
});

describe("rename", { timeout: 60_000 }, () => {
  it("renames a tour and answers its id and the saved title", async () => {
    const { deps, a, advance } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    const before = (await tourRow(deps, t.tour_id))!;
    advance(5000);
    const r = await rename(deps, a.token, t.tour_id, { title: "Pay an invoice" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: t.tour_id, title: "Pay an invoice" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const after = (await tourRow(deps, t.tour_id))!;
    expect(after).toEqual({ ...before, title: "Pay an invoice", updated_at: T0 + 5000 });
    expect(after.slug).toBe(before.slug);
    expect((await list(deps, a.token))[0].title).toBe("Pay an invoice");
    // The chapter keeps its own title.
    expect((await deps.db.first<{ title: string }>("SELECT title FROM chapter WHERE tour_id = ?", [t.tour_id]))!.title).toBe("Send an invoice");
  });

  it("cleans the title up the way a manifest title is: trimmed, at most 200 characters", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    const padded = await rename(deps, a.token, t.tour_id, { title: " \u00a0\u2003 Quarterly review \u3000" });
    expect(padded.status).toBe(200);
    expect(padded.json.title).toBe("Quarterly review");
    const longest = "é".repeat(199) + "😀";
    const ok = await rename(deps, a.token, t.tour_id, { title: longest });
    expect(ok.status).toBe(200);
    expect(ok.json.title).toBe(longest);
    expect((await tourRow(deps, t.tour_id))!.title).toBe(longest);
    // An unknown extra field is ignored.
    expect((await rename(deps, a.token, t.tour_id, { title: "Kept", slug: "abcdefghij" })).json).toEqual({ id: t.tour_id, title: "Kept" });
  });

  it("a title that is empty after clean-up, not text, too long or unsafe answers 400 with a sentence and changes nothing", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    const before = await tourRow(deps, t.tour_id);
    const cases: [unknown, string, string][] = [
      [{ title: "" }, "bad_title", "the title must not be empty"],
      [{ title: " \u00a0 \u3000" }, "bad_title", "the title must not be empty"],
      [{ title: 5 }, "bad_title", "the title must be a string"],
      [{ title: null }, "bad_title", "the title must be a string"],
      [{ title: ["A"] }, "bad_title", "the title must be a string"],
      [{}, "bad_title", "the title must be a string"],
      [{ title: "x".repeat(201) }, "bad_title", "the title must be at most 200 characters"],
      [{ title: "bad\u0000title" }, "bad_title", "the title contains a control or format character"],
      [{ title: "right\u202eto left" }, "bad_title", "the title contains a control or format character"],
      [{ title: "two\nlines" }, "bad_title", "the title contains a control or format character"],
      ["not json", "bad_request", 'the body must be JSON such as {"title": "New name"}'],
      ["[]", "bad_request", 'the body must be JSON such as {"title": "New name"}'],
      ['"Title"', "bad_request", 'the body must be JSON such as {"title": "New name"}'],
      ["", "bad_request", 'the body must be JSON such as {"title": "New name"}'],
    ];
    for (const [body, error, detail] of cases) {
      const r = await rename(deps, a.token, t.tour_id, body);
      expect([r.status, r.json], JSON.stringify(body)).toEqual([400, { error, detail }]);
    }
    const big = await rename(deps, a.token, t.tour_id, { title: "x", padding: "y".repeat(5000) });
    expect(big.status).toBe(413);
    expect(big.json.error).toBe("too_large");
    expect(await tourRow(deps, t.tour_id)).toEqual(before);
  });

  it("another workspace's tour, an unknown tour and a malformed id answer 404; no token answers 401; nothing changes", async () => {
    const { deps, a, b } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    await publishAll(deps, a.token, t.tour_id);
    const before = [await tourRow(deps, t.tour_id), await snapshotOf(deps, t.tour_id)];
    const other = await rename(deps, b.token, t.tour_id, { title: "Taken over" });
    expect([other.status, other.json]).toEqual([404, { error: "not_found", detail: "no such tour" }]);
    expect((await rename(deps, a.token, "tour_" + "0".repeat(24), { title: "X" })).status).toBe(404);
    expect((await rename(deps, a.token, "nonsense", { title: "X" })).status).toBe(404);
    const anon = await rename(deps, null, t.tour_id, { title: "X" });
    expect([anon.status, anon.text]).toEqual([401, '{"error":"unauthorized"}']);
    expect((await rename(deps, "dp_" + "1".repeat(40), t.tour_id, { title: "X" })).status).toBe(401);
    expect([await tourRow(deps, t.tour_id), await snapshotOf(deps, t.tour_id)]).toEqual(before);
  });

  it("the public page of a published tour shows the new title at once, at the same link, and nothing else of it changes", async () => {
    const { deps, a, b } = await setup();
    const t = await uploadTour(deps, a.token, v3);
    const other = await uploadTour(deps, b.token, v3);
    const url = (await publishAll(deps, a.token, t.tour_id)).json.url as string;
    const otherUrl = (await publishAll(deps, b.token, other.tour_id)).json.url as string;
    const before = (await snapshotOf(deps, t.tour_id))!;
    const pageBefore = await send(deps, "GET", url);
    expect(pageBefore.text).toContain("<title>Send an invoice</title>");
    const otherBefore = await send(deps, "GET", otherUrl);

    const r = await rename(deps, a.token, t.tour_id, { title: 'Billing & "more" <b>' });
    expect(r.status).toBe(200);
    const page = await send(deps, "GET", url);
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>Billing &amp; &quot;more&quot; &lt;b&gt;</title>");
    expect(page.text).not.toContain("<title>Send an invoice</title>");
    // A browser that revalidates gets the new page, not a 304 for the old one.
    expect(page.headers.get("etag")).not.toBe(pageBefore.headers.get("etag"));
    expect((await send(deps, "GET", url, { headers: { "if-none-match": pageBefore.headers.get("etag")! } })).status).toBe(200);
    // Only the title changed: same steps, same images (still served), same settings.
    const after = (await snapshotOf(deps, t.tour_id))!;
    expect(after).toEqual({ ...before, title: 'Billing & "more" <b>' });
    for (const st of after.chapters.flatMap((c) => c.steps)) expect((await send(deps, "GET", "/" + st.image)).status).toBe(200);
    const row = (await tourRow(deps, t.tour_id))!;
    expect([row.status, `/t/${row.slug}`]).toEqual(["published", url]);
    // The other workspace's tour and page are untouched.
    const otherAfter = await send(deps, "GET", otherUrl);
    expect(otherAfter.text).toBe(otherBefore.text);
  });

  it("a publish in progress goes live with the new title", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, manyStepManifest(30, "Old name"));
    const started = await publish(deps, a.token, t.tour_id);
    expect(started.status).toBe(202);
    expect((await rename(deps, a.token, t.tour_id, { title: "New name" })).status).toBe(200);
    let r = started;
    while (r.status === 202) r = await resume(deps, a.token, t.tour_id, started.json.publish_id);
    expect(r.status).toBe(200);
    expect((await snapshotOf(deps, t.tour_id))!.title).toBe("New name");
    expect((await send(deps, "GET", r.json.url)).text).toContain("<title>New name</title>");
  });

  it("a rename that lands while a publish is starting, after it read the draft, still goes live", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, manyStepManifest(30, "Old name"));
    const realBatch = deps.db.batch.bind(deps.db);
    let raced: Call | null = null;
    deps.db.batch = async (stmts) => {
      // The publish has read the draft and built its snapshot; its job is not recorded yet.
      if (raced === null && stmts[0].sql.startsWith("INSERT INTO publish_job")) raced = await rename(deps, a.token, t.tour_id, { title: "New name" });
      return realBatch(stmts);
    };
    let r = await publish(deps, a.token, t.tour_id);
    deps.db.batch = realBatch;
    expect(raced!.status).toBe(200);
    const id = r.json.publish_id as string;
    while (r.status === 202) r = await resume(deps, a.token, t.tour_id, id);
    expect(r.status).toBe(200);
    expect((await snapshotOf(deps, t.tour_id))!.title).toBe("New name");
    expect((await send(deps, "GET", r.json.url)).text).toContain("<title>New name</title>");
    expect((await tourRow(deps, t.tour_id))!.title).toBe("New name");
  });

  it("a snapshot that is not JSON does not stop a rename", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    await publishAll(deps, a.token, t.tour_id);
    await deps.db.run("UPDATE snapshot SET data = 'not json' WHERE tour_id = ?", [t.tour_id]);
    expect((await rename(deps, a.token, t.tour_id, { title: "Still works" })).status).toBe(200);
    expect((await tourRow(deps, t.tour_id))!.title).toBe("Still works");
  });
});

describe("delete", { timeout: 60_000 }, () => {
  it("deletes a draft tour: its rows and its draft images, and nothing of any other tour", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const t = await uploadTour(deps, a.token, v3, { kind: "new" }, 1);
    await uploadTour(deps, a.token, v2, { kind: "chapter", tour_id: t.tour_id }, 2);
    const sibling = await uploadTour(deps, a.token, v3, { kind: "new" }, 3);
    const foreign = await uploadTour(deps, b.token, v3, { kind: "new" }, 4);
    const own = await draftKeysOf(deps, t.tour_id);
    expect(own).toHaveLength(7); // two chapters of three steps, and the logo
    const others = [...(await draftKeysOf(deps, sibling.tour_id)), ...(await draftKeysOf(deps, foreign.tour_id))].sort();
    const totals = { chapter: await count(deps, "chapter"), step: await count(deps, "step") };

    const r = await del(deps, a.token, t.tour_id);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ deleted: true });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await ctx.draftKeys()).toEqual(others);
    expect(await count(deps, "chapter")).toBe(totals.chapter - 2);
    expect(await count(deps, "step")).toBe(totals.step - 6);
    expect((await list(deps, a.token)).map((x) => x.id)).toEqual([sibling.tour_id]);
    expect((await list(deps, b.token)).map((x) => x.id)).toEqual([foreign.tour_id]);
    // The other tours still work.
    expect((await publishAll(deps, a.token, sibling.tour_id)).status).toBe(200);
  });

  it("deletes a published tour: the page and the images answer 404 and both stores hold nothing of it", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const t = await uploadTour(deps, a.token, v3, { kind: "new" }, 1);
    const sibling = await uploadTour(deps, a.token, v3, { kind: "new" }, 2);
    const foreign = await uploadTour(deps, b.token, v3, { kind: "new" }, 3);
    const url = (await publishAll(deps, a.token, t.tour_id)).json.url as string;
    const siblingUrl = (await publishAll(deps, a.token, sibling.tour_id)).json.url as string;
    const foreignUrl = (await publishAll(deps, b.token, foreign.tour_id)).json.url as string;
    const ownPublic = await publicKeysOf(deps, t.tour_id);
    expect(ownPublic).toHaveLength(4);
    const otherDrafts = [...(await draftKeysOf(deps, sibling.tour_id)), ...(await draftKeysOf(deps, foreign.tour_id))].sort();
    const otherPublic = [...(await publicKeysOf(deps, sibling.tour_id)), ...(await publicKeysOf(deps, foreign.tour_id))].sort();
    expect((await send(deps, "GET", url)).status).toBe(200);

    const r = await del(deps, a.token, t.tour_id);
    expect([r.status, r.json]).toEqual([200, { deleted: true }]);
    expect((await send(deps, "GET", url)).status).toBe(404);
    for (const k of ownPublic) expect((await send(deps, "GET", "/" + k)).status).toBe(404);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await ctx.draftKeys()).toEqual(otherDrafts);
    expect(await ctx.publicKeys()).toEqual(otherPublic);
    // The other tours' pages and images are still served.
    expect((await send(deps, "GET", siblingUrl)).status).toBe(200);
    expect((await send(deps, "GET", foreignUrl)).status).toBe(200);
    for (const k of otherPublic) expect((await send(deps, "GET", "/" + k)).status).toBe(200);
  });

  it("also removes images a re-publish replaced that are still in their grace period", async () => {
    const ctx = await setup({ retiredGraceMs: 10 * MIN });
    const { deps, a, advance } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    await publishAll(deps, a.token, t.tour_id);
    const first = await publicKeysOf(deps, t.tour_id);
    advance(1000);
    await publishAll(deps, a.token, t.tour_id);
    expect(await publicKeysOf(deps, t.tour_id)).toHaveLength(6);
    expect((await send(deps, "GET", "/" + first[0])).status).toBe(200); // in grace: still served
    expect((await del(deps, a.token, t.tour_id)).status).toBe(200);
    expect((await send(deps, "GET", "/" + first[0])).status).toBe(404);
    expect(await ctx.publicKeys()).toEqual([]);
    expect(await ctx.draftKeys()).toEqual([]);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
  });

  it("removes unfinished uploads into the tour, and leaves other unfinished uploads alone", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadTour(deps, a.token, v2, { kind: "new" }, 1);
    const keep = await uploadTour(deps, a.token, v2, { kind: "new" }, 2);
    // Into the tour: one with every step sent, one with a single step sent.
    const full = await sendAll(deps, a.token, v2, { kind: "chapter", tour_id: t.tour_id }, 3);
    const partial = (await createUpload(deps, a.token, v2, { kind: "chapter", tour_id: t.tour_id })).json.upload_id as string;
    expect((await putStep(deps, a.token, partial, 2, stepImage(v2.steps[1], 4))).status).toBe(204);
    // Not into the tour: a new tour's upload and one into another tour.
    const fresh = await sendAll(deps, a.token, v3, { kind: "new" }, 5);
    const elsewhere = await sendAll(deps, a.token, v2, { kind: "chapter", tour_id: keep.tour_id }, 6);
    const before = await ctx.draftKeys();
    const mine = before.filter((k) => k.startsWith(`u/${full}/`) || k.startsWith(`u/${partial}/`));
    expect(mine).toHaveLength(4);
    const own = await draftKeysOf(deps, t.tour_id);

    expect((await del(deps, a.token, t.tour_id)).status).toBe(200);
    expect(await ctx.draftKeys()).toEqual(before.filter((k) => !mine.includes(k) && !own.includes(k)));
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect((await deps.db.all<{ id: string }>("SELECT id FROM upload ORDER BY id")).map((u) => u.id)).toEqual([fresh, elsewhere].sort());
    expect(await count(deps, "upload_step")).toBe(6);
    // The removed uploads are gone for their client too; the others still commit.
    expect((await commit(deps, a.token, full)).status).toBe(404);
    expect((await putStep(deps, a.token, partial, 1, stepImage(v2.steps[0], 4))).status).toBe(404);
    expect((await commit(deps, a.token, fresh)).status).toBe(201);
    expect((await commit(deps, a.token, elsewhere)).status).toBe(201);
  });

  it("deleting a tour also removes pictures a replace left for removal", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await uploadTour(deps, a.token, v2, { kind: "new" }, 1);
    const keep = await uploadTour(deps, a.token, v2, { kind: "new" }, 2);
    const old = await draftKeysOf(deps, t.tour_id);
    // The chapter is replaced, and the store cannot delete just then: the three old
    // pictures stay in the store, each named by a row.
    const realDelete = deps.drafts.delete.bind(deps.drafts);
    deps.drafts.delete = async () => {
      throw new Error("bucket unavailable");
    };
    const replaced = await uploadTour(deps, a.token, v2, { kind: "replace", tour_id: t.tour_id, chapter_id: t.chapter_id }, 3);
    deps.drafts.delete = realDelete;
    expect(replaced.chapter_id).toBe(t.chapter_id);
    const left = (await deps.db.all<{ image_key: string }>("SELECT image_key FROM replaced_object WHERE tour_id = ? ORDER BY image_key", [t.tour_id])).map((r) => r.image_key);
    expect(left).toEqual(old);
    const keepDrafts = await draftKeysOf(deps, keep.tour_id);
    expect(await ctx.draftKeys()).toHaveLength(9);

    const r = await del(deps, a.token, t.tour_id);
    expect([r.status, r.json]).toEqual([200, { deleted: true }]);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await count(deps, "replaced_object")).toBe(0);
    // Neither the replaced pictures nor the current ones are left; the other tour's are.
    expect(await ctx.draftKeys()).toEqual(keepDrafts);
    expect((await del(deps, a.token, t.tour_id)).status).toBe(404);
  });

  it("deleting a tour with an open replace upload into it leaves no file behind", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadTour(deps, a.token, v2, { kind: "new" }, 1);
    const keep = await uploadTour(deps, a.token, v2, { kind: "new" }, 2);
    const keepDrafts = await draftKeysOf(deps, keep.tour_id);
    // A replace that keeps the first picture, has sent the second and not yet the third.
    const sha256 = await Promise.all(v2.steps.map((s: Json, i: number) => sha256Hex(stepImage(s, i === 0 ? 1 : 6))));
    const created = await send(deps, "POST", "/api/v1/uploads", {
      token: a.token,
      body: JSON.stringify({ manifest: v2, target: { kind: "replace", tour_id: t.tour_id, chapter_id: t.chapter_id }, sha256 }),
      headers: JSON_HEADERS,
    });
    expect(created.status).toBe(201);
    expect(created.json.have).toEqual([1]);
    const up = created.json.upload_id as string;
    expect((await putStep(deps, a.token, up, 2, stepImage(v2.steps[1], 6))).status).toBe(204);
    expect(await ctx.draftKeys()).toHaveLength(7);

    const r = await del(deps, a.token, t.tour_id);
    expect([r.status, r.json]).toEqual([200, { deleted: true }]);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await count(deps, "upload_step")).toBe(0);
    expect(await ctx.draftKeys()).toEqual(keepDrafts);
    // The upload is gone for its client too.
    expect((await putStep(deps, a.token, up, 3, stepImage(v2.steps[2], 6))).status).toBe(404);
    expect((await commit(deps, a.token, up)).status).toBe(404);
    expect(await ctx.draftKeys()).toEqual(keepDrafts);
  });

  it("a published 200-step tour is deleted over several calls, each within the call budget, and is gone for every route after the first", async () => {
    const ctx = await setup({ retiredGraceMs: 10 * MIN });
    const { deps, a, advance } = ctx;
    const t = await uploadTour(deps, a.token, manyStepManifest(200));
    const keep = await uploadTour(deps, a.token, v3, { kind: "new" }, 9);
    const url = (await publishAll(deps, a.token, t.tour_id)).json.url as string;
    advance(1000);
    await publishAll(deps, a.token, t.tour_id); // a second set, still in its grace
    const keepUrl = (await publishAll(deps, a.token, keep.tour_id)).json.url as string;
    const keepDrafts = await draftKeysOf(deps, keep.tour_id);
    const keepPublic = await publicKeysOf(deps, keep.tour_id);
    const files = 600;
    expect((await ctx.draftKeys()).length + (await ctx.publicKeys()).length).toBe(files + keepDrafts.length + keepPublic.length);

    const first = await del(deps, a.token, t.tour_id);
    expect(first.status).toBe(202);
    expect(first.json).toEqual({ status: "in_progress", done: DELETE_FILES_PER_CALL, total: files });
    expect(first.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    // Half-deleted: not a tour any more, for any route.
    expect((await list(deps, a.token)).map((x) => x.id)).toEqual([keep.tour_id]);
    expect((await send(deps, "GET", url)).status).toBe(404);
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(404);
    expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/unpublish`, { token: a.token })).status).toBe(404);
    expect((await rename(deps, a.token, t.tour_id, { title: "Back again" })).status).toBe(404);
    expect((await createUpload(deps, a.token, v2, { kind: "chapter", tour_id: t.tour_id })).status).toBe(404);
    expect(await rowsOf(deps, t.tour_id)).toMatchObject({ tour: 0, chapter: 0, step: 0, snapshot: 0, snapshot_object: 0, public_object: 0, tour_deletion: 1, deleted_object: files - DELETE_FILES_PER_CALL });
    for (const k of await ctx.publicKeys()) if (!keepPublic.includes(k)) expect((await send(deps, "GET", "/" + k)).status).toBe(404);

    const rest = await deleteAll(deps, a.token, t.tour_id);
    const calls = [first, ...rest];
    expect(calls).toHaveLength(Math.ceil(files / DELETE_FILES_PER_CALL));
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    for (const c of calls.slice(0, -1)) expect(c.status).toBe(202);
    const done = calls.slice(0, -1).map((c) => c.json.done as number);
    expect(done).toEqual([...done].sort((x, y) => x - y));
    expect(new Set(done).size).toBe(done.length);
    expect([calls.at(-1)!.status, calls.at(-1)!.json]).toEqual([200, { deleted: true }]);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await ctx.draftKeys()).toEqual(keepDrafts);
    expect(await ctx.publicKeys()).toEqual(keepPublic);
    expect((await send(deps, "GET", keepUrl)).status).toBe(200);
  }, 300_000);

  it("a call interrupted while deleting files is resumed by the next call, and the tour is already gone meanwhile", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await uploadTour(deps, a.token, v3);
    const keep = await uploadTour(deps, a.token, v2, { kind: "new" }, 5);
    const url = (await publishAll(deps, a.token, t.tour_id)).json.url as string;
    const keepDrafts = await draftKeysOf(deps, keep.tour_id);

    // The public store fails: the rows are gone, the files recorded, none lost.
    const realDelete = deps.pub.delete.bind(deps.pub);
    deps.pub.delete = async () => {
      throw new Error("bucket unavailable");
    };
    const failed = await del(deps, a.token, t.tour_id);
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain("bucket");
    deps.pub.delete = realDelete;
    expect((await list(deps, a.token)).map((x) => x.id)).toEqual([keep.tour_id]);
    expect((await send(deps, "GET", url)).status).toBe(404);
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(404);
    expect(await rowsOf(deps, t.tour_id)).toMatchObject({ tour: 0, step: 0, tour_deletion: 1 });
    expect((await ctx.publicKeys()).length).toBe(4);

    // The files go, then the database fails before their rows do: the next call finishes.
    const realBatch = deps.db.batch.bind(deps.db);
    deps.db.batch = async (stmts) => {
      if (stmts[0].sql.startsWith("DELETE FROM deleted_object")) throw new Error("database unavailable");
      return realBatch(stmts);
    };
    expect((await del(deps, a.token, t.tour_id)).status).toBe(500);
    deps.db.batch = realBatch;
    expect(await ctx.publicKeys()).toEqual([]);
    expect((await rowsOf(deps, t.tour_id)).deleted_object).toBe(8);

    const r = await del(deps, a.token, t.tour_id);
    expect([r.status, r.json]).toEqual([200, { deleted: true }]);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await ctx.draftKeys()).toEqual(keepDrafts);
    expect((await del(deps, a.token, t.tour_id)).status).toBe(404);
  });

  it("answers 409 publish_busy while a publish of the tour is in progress, and changes nothing", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadTour(deps, a.token, manyStepManifest(30));
    const started = await publish(deps, a.token, t.tour_id);
    expect(started.status).toBe(202);
    const before = { rows: await rowsOf(deps, t.tour_id), drafts: await ctx.draftKeys(), pub: await ctx.publicKeys(), tour: await tourRow(deps, t.tour_id) };
    const r = await del(deps, a.token, t.tour_id);
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "publish_busy", detail: "a publish of this tour is in progress; wait for it to finish, or unpublish the tour to stop it, then delete it again" });
    expect({ rows: await rowsOf(deps, t.tour_id), drafts: await ctx.draftKeys(), pub: await ctx.publicKeys(), tour: await tourRow(deps, t.tour_id) }).toEqual(before);
    // The publish still finishes, and then the tour can be deleted.
    let p = started;
    while (p.status === 202) p = await resume(deps, a.token, t.tour_id, started.json.publish_id);
    expect(p.status).toBe(200);
    expect((await send(deps, "GET", p.json.url)).status).toBe(200);
    expect((await deleteAll(deps, a.token, t.tour_id)).at(-1)!.status).toBe(200);
    expect(await ctx.draftKeys()).toEqual([]);
    expect(await ctx.publicKeys()).toEqual([]);
  });

  it("unpublish stops a publish in progress, after which delete goes through", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadTour(deps, a.token, manyStepManifest(30));
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(202);
    expect((await del(deps, a.token, t.tour_id)).status).toBe(409);
    expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/unpublish`, { token: a.token })).status).toBe(204);
    expect((await del(deps, a.token, t.tour_id)).status).toBe(200);
    expect(await ctx.draftKeys()).toEqual([]);
    expect(await ctx.publicKeys()).toEqual([]);
  });

  it("a publish abandoned for 15 minutes does not block delete, and its copied images go too", async () => {
    const ctx = await setup();
    const { deps, a, advance } = ctx;
    const t = await uploadTour(deps, a.token, manyStepManifest(30));
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(202);
    expect((await ctx.publicKeys()).length).toBeGreaterThan(0);
    advance(STALE_PUBLISH_MS + MIN);
    const calls = await deleteAll(deps, a.token, t.tour_id);
    expect(calls.at(-1)!.status).toBe(200);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await ctx.draftKeys()).toEqual([]);
    expect(await ctx.publicKeys()).toEqual([]);
  });

  it("a publish that starts at the same moment as a delete either blocks it or finds the tour gone; no file is left behind", async () => {
    // The publish records its job between the delete's look at the tour and its batch.
    {
      const ctx = await setup();
      const { deps, a } = ctx;
      const t = await uploadTour(deps, a.token, manyStepManifest(30));
      const realBatch = deps.db.batch.bind(deps.db);
      let raced: Call | null = null;
      deps.db.batch = async (stmts) => {
        if (raced === null && stmts[0].sql.startsWith("INSERT INTO tour_deletion")) raced = await publish(deps, a.token, t.tour_id);
        return realBatch(stmts);
      };
      const r = await del(deps, a.token, t.tour_id);
      deps.db.batch = realBatch;
      expect(raced!.status).toBe(202);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("publish_busy");
      expect(await rowsOf(deps, t.tour_id)).toMatchObject({ tour: 1, step: 30, publish_job: 1, tour_deletion: 0, deleted_object: 0 });
      expect(await ctx.draftKeys()).toHaveLength(30);
      const done = await publishAll(deps, a.token, t.tour_id);
      expect((await send(deps, "GET", done.json.url)).status).toBe(200);
    }
    // The delete lands between the publish's read of the draft and its job.
    {
      const ctx = await setup();
      const { deps, a } = ctx;
      const t = await uploadTour(deps, a.token, manyStepManifest(30));
      const realBatch = deps.db.batch.bind(deps.db);
      let raced: Call | null = null;
      deps.db.batch = async (stmts) => {
        if (raced === null && stmts[0].sql.startsWith("INSERT INTO publish_job")) raced = await del(deps, a.token, t.tour_id);
        return realBatch(stmts);
      };
      const r = await publish(deps, a.token, t.tour_id);
      deps.db.batch = realBatch;
      expect(raced!.status).toBe(200);
      expect([r.status, r.json]).toEqual([404, { error: "not_found", detail: "no such tour" }]);
      expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
      expect(await ctx.draftKeys()).toEqual([]);
      expect(await ctx.publicKeys()).toEqual([]);
    }
  });

  it("a step image that arrives for an upload into the tour while it is deleted is not left behind", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadTour(deps, a.token, v2);
    const up = (await createUpload(deps, a.token, v2, { kind: "chapter", tour_id: t.tour_id })).json.upload_id as string;
    const realPut = deps.drafts.put.bind(deps.drafts);
    let raced: Call | null = null;
    deps.drafts.put = async (k, body, m) => {
      // The step is claimed; the tour is deleted before its image is written.
      if (raced === null) raced = await del(deps, a.token, t.tour_id);
      return realPut(k, body, m);
    };
    const r = await putStep(deps, a.token, up, 1, stepImage(v2.steps[0], 7));
    deps.drafts.put = realPut;
    expect(raced!.status).toBe(200);
    expect(r.status).toBe(404);
    expect(await ctx.draftKeys()).toEqual([]);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await count(deps, "upload_step")).toBe(0);
  });

  it("a repeat after it is gone, an unknown tour and a malformed id answer 404; no token answers 401", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v2);
    expect((await del(deps, null, t.tour_id)).status).toBe(401);
    expect((await del(deps, "dp_" + "1".repeat(40), t.tour_id)).status).toBe(401);
    expect(await tourRow(deps, t.tour_id)).not.toBeNull();
    expect((await del(deps, a.token, t.tour_id)).status).toBe(200);
    const again = await del(deps, a.token, t.tour_id);
    expect([again.status, again.json]).toEqual([404, { error: "not_found", detail: "no such tour" }]);
    expect((await del(deps, a.token, "tour_" + "0".repeat(24))).status).toBe(404);
    expect((await del(deps, a.token, "nonsense")).status).toBe(404);
  });

  it("another workspace's tour answers 404 and nothing of it changes, whole or half-deleted", async () => {
    const ctx = await setup();
    const { deps, a, b } = ctx;
    const t = await uploadTour(deps, a.token, manyStepManifest(DELETE_FILES_PER_CALL / 2 + 10));
    const url = (await publishAll(deps, a.token, t.tour_id)).json.url as string;
    const before = { rows: await rowsOf(deps, t.tour_id), drafts: await ctx.draftKeys(), pub: await ctx.publicKeys() };
    const r = await del(deps, b.token, t.tour_id);
    expect([r.status, r.json]).toEqual([404, { error: "not_found", detail: "no such tour" }]);
    expect({ rows: await rowsOf(deps, t.tour_id), drafts: await ctx.draftKeys(), pub: await ctx.publicKeys() }).toEqual(before);
    expect((await send(deps, "GET", url)).status).toBe(200);

    // Half-deleted by its owner: the other workspace still cannot move it along.
    expect((await del(deps, a.token, t.tour_id)).status).toBe(202);
    const half = { rows: await rowsOf(deps, t.tour_id), drafts: await ctx.draftKeys(), pub: await ctx.publicKeys() };
    expect(half.rows.deleted_object).toBe(20);
    expect((await del(deps, b.token, t.tour_id)).status).toBe(404);
    expect({ rows: await rowsOf(deps, t.tour_id), drafts: await ctx.draftKeys(), pub: await ctx.publicKeys() }).toEqual(half);
    expect((await del(deps, a.token, t.tour_id)).status).toBe(200);
    expect(await ctx.draftKeys()).toEqual([]);
    expect(await ctx.publicKeys()).toEqual([]);
  });

  it("two delete calls at once finish the job between them", async () => {
    const ctx = await setup();
    const { deps, a } = ctx;
    const t = await uploadTour(deps, a.token, manyStepManifest(DELETE_FILES_PER_CALL / 2 + 10));
    await publishAll(deps, a.token, t.tour_id);
    for (let round = 0; round < 10; round++) {
      const rs = await Promise.all([del(deps, a.token, t.tour_id), del(deps, a.token, t.tour_id)]);
      for (const r of rs) expect([200, 202, 404, 409]).toContain(r.status);
      if (rs.every((r) => r.status === 404)) break;
    }
    expect((await del(deps, a.token, t.tour_id)).status).toBe(404);
    expect(await rowsOf(deps, t.tour_id)).toEqual(GONE);
    expect(await ctx.draftKeys()).toEqual([]);
    expect(await ctx.publicKeys()).toEqual([]);
  });

  it("a tour with no steps and no files is deleted in one call", async () => {
    const { deps, a } = await setup();
    const id = "tour_" + "a".repeat(24);
    await deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'Empty', 'emptyempty', 'draft', 1, 1)", [id, a.workspaceId]);
    const r = await del(deps, a.token, id);
    expect([r.status, r.json]).toEqual([200, { deleted: true }]);
    expect(await rowsOf(deps, id)).toEqual(GONE);
  });
});
