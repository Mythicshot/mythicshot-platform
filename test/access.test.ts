// Who may view a tour (src/access.ts) on both targets: the setting and its list, the switch
// that moves a published tour's live pictures between the two stores (interrupted at every
// call and resumed), publishing a restricted tour, the two functions the serving route will
// call, a site without mail, and the call budget with a tour of 60 steps.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { MAX_VIEWERS, mayView, tourForServing } from "../src/access.ts";
import type { Deps, FileStore } from "../src/ports.ts";
import { COPY_BATCH } from "../src/publish.ts";
import { usageOf } from "../src/usage.ts";
import { send, uploadTour, type Call, type Json } from "./bundle.ts";
import { manifestOf } from "./isolation-world.ts";

const SLOW = { timeout: 300_000 };
const VERY_SLOW = { timeout: 1_800_000 };
const JSON_HEADERS = { "content-type": "application/json" };
/** A site that can mail links (a mailer, and an address for links), which restricting needs. */
const MAILS = { siteHost: "tours.example.com" };
const UNKNOWN_SLUG = "aaaaaaaaaa";
const UNKNOWN_NAME = "0".repeat(32) + ".png";

afterEach(() => vi.restoreAllMocks());

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

type Site = Awaited<ReturnType<typeof makeDeps>> & { owner: Awaited<ReturnType<typeof seedAccount>>; other: Awaited<ReturnType<typeof seedAccount>> };

async function site(config: Parameters<typeof makeDeps>[0] = {}): Promise<Site> {
  const ctx = await makeDeps({ ...MAILS, ...config });
  const owner = await seedAccount(ctx.deps);
  const other = await seedAccount(ctx.deps);
  return { ...ctx, owner, other };
}

const getAccess = (deps: Deps, token: string, tourId: string) => send(deps, "GET", `/api/v1/tours/${tourId}/access`, { token });
const setAccess = (deps: Deps, token: string, tourId: string, body: unknown) =>
  send(deps, "PUT", `/api/v1/tours/${tourId}/access`, { token, headers: JSON_HEADERS, body: JSON.stringify(body) });

/** Sends the same change until it is done, as the client does. */
async function untilDone(deps: Deps, token: string, tourId: string, body: unknown): Promise<Call[]> {
  const calls: Call[] = [];
  for (let i = 0; i < 60; i++) {
    const r = await setAccess(deps, token, tourId, body);
    calls.push(r);
    if (r.status !== 202) {
      expect(r.status, r.text).toBe(200);
      return calls;
    }
  }
  throw new Error("the change does not finish");
}

async function publishAll(deps: Deps, token: string, tourId: string): Promise<Call[]> {
  const calls: Call[] = [];
  let r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
  calls.push(r);
  for (let i = 0; r.status === 202; i++) {
    if (i > 60) throw new Error("publish does not finish");
    r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token, headers: JSON_HEADERS, body: JSON.stringify({ publish_id: r.json.publish_id }) });
    calls.push(r);
  }
  expect(r.status, r.text).toBe(200);
  return calls;
}

/** A tour of `steps` steps and a logo, so steps + 1 pictures. */
async function tourOf(s: Site, steps: number, title = "Restricted tour"): Promise<{ id: string; slug: string }> {
  const t = await uploadTour(s.deps, s.owner.token, manifestOf(Array.from({ length: steps }, (_, i) => 200 + i), title, true), { kind: "new" }, 3);
  const row = await s.deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]);
  return { id: t.tour_id, slug: row!.slug };
}

/** The tour's draft as stored: its row's draft columns, its steps and the draft store's keys. */
async function draftOf(s: Site, tourId: string): Promise<Json> {
  return {
    tour: await s.deps.db.first("SELECT title, slug, status, draft_version, logo_key, logo_bytes, cover, theme, cta, end_card FROM tour WHERE id = ?", [tourId]),
    steps: await s.deps.db.all("SELECT * FROM step WHERE tour_id = ? ORDER BY id", [tourId]),
    files: (await s.draftKeys()).filter((k) => k.startsWith("u/")).sort(),
  };
}

/** The live snapshot with every picture name taken out, and its publish. */
async function shapeOf(s: Site, tourId: string): Promise<Json> {
  const row = await s.deps.db.first<{ data: string; publish_id: string }>("SELECT data, publish_id FROM snapshot WHERE tour_id = ?", [tourId]);
  if (row === null) return { none: true };
  return { publish: row.publish_id, data: row.data.replace(/"[pv]\/[0-9a-f]{32}\.(png|jpg)"/g, '"PICTURE"') };
}

/** Every key the tour's rows name, live or not. */
async function namedKeys(deps: Deps, tourId: string): Promise<string[]> {
  return (
    await deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ? UNION ALL SELECT image_key FROM public_object WHERE tour_id = ?", [tourId, tourId])
  ).map((r) => r.image_key);
}

/**
 * Deps whose `n`-th call (counted over every port, from now on) fails once: before it is
 * made, or after it took effect, as an answer lost on the way back. As in
 * test/account-removal.test.ts.
 */
function failingAt(deps: Deps, n: number, when: "before" | "after"): { deps: Deps; hit: () => boolean } {
  let count = 0;
  let hit = false;
  const gate = async <T>(run: () => Promise<T>): Promise<T> => {
    count += 1;
    if (count !== n) return run();
    hit = true;
    if (when === "after") await run();
    throw new Error("injected failure");
  };
  const store = (s: FileStore): FileStore => ({ put: (k, b, m) => gate(() => s.put(k, b, m)), get: (k) => gate(() => s.get(k)), delete: (k) => gate(() => s.delete(k)) });
  return {
    deps: {
      ...deps,
      db: {
        all: (sql, p) => gate(() => deps.db.all(sql, p)),
        first: (sql, p) => gate(() => deps.db.first(sql, p)),
        run: (sql, p) => gate(() => deps.db.run(sql, p)),
        batch: (stmts) => gate(() => deps.db.batch(stmts)),
      },
      drafts: store(deps.drafts),
      pub: store(deps.pub),
      now: () => deps.now(),
    },
    hit: () => hit,
  };
}

/** The store wrapped so every call is counted, for "never touches the public store". */
function counting(store: FileStore): { store: FileStore; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    store: {
      put: (k, b, m) => (calls.push(`put ${k}`), store.put(k, b, m)),
      get: (k) => (calls.push(`get ${k}`), store.get(k)),
      delete: (k) => (calls.push(`delete ${k.join(" ")}`), store.delete(k)),
    },
  };
}

describe("the setting and its list", () => {
  it("a draft changes in one request; the list is kept when the setting leaves people; duplicates collapse", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 1);
    expect((await getAccess(s.deps, s.owner.token, t.id)).json).toEqual({ access: "public", viewers: [], limit: MAX_VIEWERS, can_restrict: true, switching: null });
    const set = await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: ["Bo@Example.com", " ana@example.com", "bo@example.com"] });
    expect([set.status, set.json]).toEqual([200, { access: "people", viewers: ["ana@example.com", "bo@example.com"], limit: MAX_VIEWERS, can_restrict: true, switching: null }]);
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "me" })).json.viewers).toEqual(["ana@example.com", "bo@example.com"]);
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "public" })).json).toMatchObject({ access: "public", viewers: ["ana@example.com", "bo@example.com"] });
    // The list is replaced whole, and an empty list empties it.
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: ["cy@example.com"] })).json.viewers).toEqual(["cy@example.com"]);
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: [] })).json.viewers).toEqual([]);
    // Exactly 200 different addresses are taken, 201 are not, and nothing is half applied.
    const full = Array.from({ length: MAX_VIEWERS }, (_, i) => `v${String(i).padStart(3, "0")}@example.com`);
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: [...full, full[0].toUpperCase()] })).json.viewers).toHaveLength(MAX_VIEWERS);
    const over = await setAccess(s.deps, s.owner.token, t.id, { access: "me", viewers: [...full, "one-more@example.com"] });
    expect([over.status, over.json.error]).toEqual([400, "too_many_viewers"]);
    const malformed = await setAccess(s.deps, s.owner.token, t.id, { access: "me", viewers: ["ok@example.com", "secret@", "x@example.com"] });
    expect([malformed.status, malformed.json.error]).toEqual([400, "bad_viewer"]);
    expect(malformed.json.detail).toContain("viewers[1]");
    expect(malformed.text).not.toContain("secret");
    expect(malformed.text).not.toContain("ok@example.com");
    const after = await getAccess(s.deps, s.owner.token, t.id);
    expect([after.json.access, after.json.viewers.length]).toEqual(["people", MAX_VIEWERS]);
    // The tour list and the publish answers say the setting and the count, never an address.
    const list = await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
    expect(list.json.tours[0]).toMatchObject({ id: t.id, access: "people", viewers: MAX_VIEWERS });
    expect(list.text).not.toContain("@example.com");
    const published = await publishAll(s.deps, s.owner.token, t.id);
    expect(published.at(-1)!.json).toMatchObject({ access: "people", viewers: MAX_VIEWERS });
    expect(published.map((c) => c.text).join("")).not.toContain("@example.com");
  });

  it("another workspace cannot read or change the setting or the list, and its token answers as for no tour", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 1);
    await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: ["ana@example.com"] });
    const none = await getAccess(s.deps, s.other.token, "tour_" + "0".repeat(24));
    for (const r of [await getAccess(s.deps, s.other.token, t.id), await setAccess(s.deps, s.other.token, t.id, { access: "public", viewers: [] })]) {
      expect(seen(r)).toEqual(seen(none));
    }
    expect((await getAccess(s.deps, s.owner.token, t.id)).json).toMatchObject({ access: "people", viewers: ["ana@example.com"] });
  });

  it("the audit record holds the settings and the counts, never an address, and no log line names one", SLOW, async () => {
    const s = await site();
    const lines: string[] = [];
    for (const level of ["error", "warn", "log", "info"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const t = await tourOf(s, COPY_BATCH);
    await publishAll(s.deps, s.owner.token, t.id);
    await untilDone(s.deps, s.owner.token, t.id, { access: "people", viewers: ["secret-viewer@example.com", "second@example.com"] });
    await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: ["secret-viewer@example.com"] });
    // A move that fails part way logs its fixed line.
    const store = s.deps.pub;
    s.deps.pub = { ...store, put: () => Promise.reject(new Error("down secret-viewer@example.com")) };
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "public" })).status).toBe(500);
    s.deps.pub = store;
    await untilDone(s.deps, s.owner.token, t.id, { access: "public" });
    const rows = await s.deps.db.all<{ event: string; subject: string; detail: string }>("SELECT event, subject, detail FROM audit WHERE event = 'tour_access_changed' ORDER BY at, id");
    expect(rows.map((r) => [r.subject, JSON.parse(r.detail)])).toEqual([
      [t.id, { from: "public", to: "people", viewers_before: 0, viewers: 2, by: "token" }],
      [t.id, { from: "people", to: "people", viewers_before: 2, viewers: 1, by: "token" }],
      [t.id, { from: "people", to: "public", viewers_before: 1, viewers: 1, by: "token" }],
    ]);
    expect(JSON.stringify(await s.deps.db.all("SELECT * FROM audit"))).not.toContain("@");
    expect(lines.join("\n")).not.toContain("@");
  });
});

describe("publishing, unpublishing and deleting a restricted tour", () => {
  it("never touches the public store, keeps the setting, and serves nothing publicly; unpublish and delete remove its private pictures", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 3);
    await setAccess(s.deps, s.owner.token, t.id, { access: "me" });
    const spy = counting(s.deps.pub);
    s.deps.pub = spy.store;
    await publishAll(s.deps, s.owner.token, t.id);
    await publishAll(s.deps, s.owner.token, t.id); // a re-publish retires the first version's private pictures
    const live = await namedKeys(s.deps, t.id);
    expect(live.length).toBe(8);
    for (const k of live) expect(k).toMatch(/^v\/[0-9a-f]{32}\.(png|jpg)$/);
    expect((await s.draftKeys()).filter((k) => k.startsWith("v/")).sort()).toEqual([...live].sort());
    expect(await s.publicKeys()).toEqual([]);
    // The page and the picture route answer exactly as for a tour that does not exist.
    expect(seen(await send(s.deps, "GET", `/t/${t.slug}`))).toEqual(seen(await send(s.deps, "GET", `/t/${UNKNOWN_SLUG}`)));
    const missing = seen(await send(s.deps, "GET", `/p/${UNKNOWN_NAME}`));
    for (const k of live) expect(seen(await send(s.deps, "GET", `/p/${k.slice(2)}`))).toEqual(missing);
    expect((await getAccess(s.deps, s.owner.token, t.id)).json.access).toBe("me");
    // The serving task's view of it.
    const served = await tourForServing(s.deps, { slug: t.slug });
    expect(served).toMatchObject({ id: t.id, slug: t.slug, workspaceId: s.owner.workspaceId, access: "me", published: true, enabled: true, switching: false });
    const snapshot = JSON.parse(served!.data!);
    const names = [...snapshot.chapters.flatMap((c: Json) => c.steps.map((x: Json) => x.image)), snapshot.cover.logo];
    expect([...served!.pictures!.keys()].sort()).toEqual(names.map((n: string) => n.slice(2)).sort());
    for (const [name, p] of served!.pictures!) expect(p).toEqual({ key: `v/${name}`, contentType: name.endsWith(".png") ? "image/png" : "image/jpeg" });
    expect(await tourForServing(s.deps, { id: t.id })).toEqual(served);

    expect((await send(s.deps, "POST", `/api/v1/tours/${t.id}/unpublish`, { token: s.owner.token })).status).toBe(204);
    expect((await s.draftKeys()).filter((k) => k.startsWith("v/"))).toEqual([]);
    expect(await namedKeys(s.deps, t.id)).toEqual([]);
    expect((await getAccess(s.deps, s.owner.token, t.id)).json.access).toBe("me");
    await publishAll(s.deps, s.owner.token, t.id);
    for (let i = 0; i < 5; i++) if ((await send(s.deps, "DELETE", `/api/v1/tours/${t.id}`, { token: s.owner.token })).status === 200) break;
    expect((await s.draftKeys()).filter((k) => k.startsWith("v/") || k.startsWith("u/"))).toEqual([]);
    expect(await s.deps.db.all("SELECT * FROM tour_viewer UNION ALL SELECT tour_id, switch_id, 0 FROM access_switch")).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  it("a replace of a chapter of a restricted tour, published, goes to the private store too", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 2);
    await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: ["ana@example.com"] });
    await publishAll(s.deps, s.owner.token, t.id);
    const chapter = await s.deps.db.first<{ id: string }>("SELECT id FROM chapter WHERE tour_id = ?", [t.id]);
    const m = manifestOf([220, 221, 222], "Restricted tour", true);
    const spy = counting(s.deps.pub);
    s.deps.pub = spy.store;
    await uploadTour(s.deps, s.owner.token, m, { kind: "replace", tour_id: t.id, chapter_id: chapter!.id }, 3);
    await publishAll(s.deps, s.owner.token, t.id);
    expect(spy.calls).toEqual([]);
    expect((await namedKeys(s.deps, t.id)).every((k) => k.startsWith("v/"))).toBe(true);
    expect((await tourForServing(s.deps, { id: t.id }))!.pictures!.size).toBe(4);
  });

  it("a publish that started before the tour was made restricted never goes live in the public store", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, COPY_BATCH + 3);
    const started = await send(s.deps, "POST", `/api/v1/tours/${t.id}/publish`, { token: s.owner.token });
    expect(started.status).toBe(202);
    // Unpublished still, so the change is one batch, and it cancels the publish of public pictures.
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people" })).status).toBe(200);
    const next = await send(s.deps, "POST", `/api/v1/tours/${t.id}/publish`, { token: s.owner.token, headers: JSON_HEADERS, body: JSON.stringify({ publish_id: started.json.publish_id }) });
    expect([next.status, next.json.error]).toEqual([409, "publish_cancelled"]);
    expect(await s.publicKeys()).toEqual([]);
    await publishAll(s.deps, s.owner.token, t.id);
    expect(await s.publicKeys()).toEqual([]);
    expect((await namedKeys(s.deps, t.id)).every((k) => k.startsWith("v/"))).toBe(true);
  });
});

describe("the switch", () => {
  it("made restricted, the tour stops being served at once, retired names in their grace included, and the public store ends empty", SLOW, async () => {
    const s = await site(); // retired pictures keep their grace of ten minutes
    const t = await tourOf(s, 2);
    await publishAll(s.deps, s.owner.token, t.id);
    const first = await namedKeys(s.deps, t.id);
    await publishAll(s.deps, s.owner.token, t.id);
    for (const k of first) expect((await send(s.deps, "GET", `/${k}`)).status).toBe(200); // retired, in grace
    expect((await send(s.deps, "GET", `/t/${t.slug}`)).status).toBe(200);
    const calls = await untilDone(s.deps, s.owner.token, t.id, { access: "people", viewers: ["ana@example.com"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].json).toEqual({ access: "people", viewers: ["ana@example.com"], limit: MAX_VIEWERS, can_restrict: true, switching: null });
    expect(await s.publicKeys()).toEqual([]);
    expect((await namedKeys(s.deps, t.id)).filter((k) => k.startsWith("p/"))).toEqual([]);
    const missing = seen(await send(s.deps, "GET", `/p/${UNKNOWN_NAME}`));
    for (const k of first) expect(seen(await send(s.deps, "GET", `/${k}`))).toEqual(missing);
    expect(seen(await send(s.deps, "GET", `/t/${t.slug}`))).toEqual(seen(await send(s.deps, "GET", `/t/${UNKNOWN_SLUG}`)));
    // Back to public: the same link, served again, and nothing left in the private store.
    await untilDone(s.deps, s.owner.token, t.id, { access: "public" });
    expect((await send(s.deps, "GET", `/t/${t.slug}`)).status).toBe(200);
    expect((await s.draftKeys()).filter((k) => k.startsWith("v/"))).toEqual([]);
    for (const k of await namedKeys(s.deps, t.id)) expect((await send(s.deps, "GET", `/${k}`)).status).toBe(200);
  });

  it("people and me, and a change of the list, move nothing", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 2);
    await setAccess(s.deps, s.owner.token, t.id, { access: "people" });
    await publishAll(s.deps, s.owner.token, t.id);
    const before = await namedKeys(s.deps, t.id);
    const spy = counting(s.deps.drafts);
    s.deps.drafts = spy.store;
    const r = await setAccess(s.deps, s.owner.token, t.id, { access: "me", viewers: ["ana@example.com"] });
    expect(r.status).toBe(200);
    expect(r.calls).toBeLessThanOrEqual(5);
    expect(spy.calls).toEqual([]);
    expect(await namedKeys(s.deps, t.id)).toEqual(before);
  });

  it("unpublish or delete during a switch removes every picture of it, in both stores", SLOW, async () => {
    for (const end of ["unpublish", "delete"] as const) {
      const s = await site();
      const t = await tourOf(s, COPY_BATCH + 5);
      await publishAll(s.deps, s.owner.token, t.id);
      expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people" })).status).toBe(202);
      const r = end === "unpublish" ? await send(s.deps, "POST", `/api/v1/tours/${t.id}/unpublish`, { token: s.owner.token }) : await send(s.deps, "DELETE", `/api/v1/tours/${t.id}`, { token: s.owner.token });
      expect([200, 204], end).toContain(r.status);
      expect(await s.publicKeys(), end).toEqual([]);
      expect((await s.draftKeys()).filter((k) => k.startsWith("v/")), end).toEqual([]);
      expect(await s.deps.db.all("SELECT * FROM access_switch"), end).toEqual([]);
      expect(await s.deps.db.all("SELECT * FROM public_object"), end).toEqual([]);
      if (end === "unpublish") {
        // The setting was in force from the switch's first request; sent again, it is simply done.
        expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people" })).json).toMatchObject({ access: "people", switching: null });
      }
    }
  });

  for (const direction of ["restricted", "public"] as const) {
    it(`made ${direction} at a failure at every call, before or after it takes effect: never served while restricted, nothing orphaned, usage never lower, the draft and the link untouched`, VERY_SLOW, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const target = direction === "restricted" ? { access: "people", viewers: ["ana@example.com"] } : { access: "public" };
      for (const when of ["before", "after"] as const) {
        for (let n = 1; ; n++) {
          const label = `${direction}, failure ${when} call ${n}`;
          const s = await site();
          // COPY_BATCH steps and a logo: one picture more than one request copies.
          const t = await tourOf(s, COPY_BATCH);
          if (direction === "public") await setAccess(s.deps, s.owner.token, t.id, { access: "me" });
          await publishAll(s.deps, s.owner.token, t.id);
          const used = (await usageOf(s.deps, s.owner.workspaceId)).used;
          const draft = await draftOf(s, t.id);
          const shape = await shapeOf(s, t.id);
          const ever = new Set(await namedKeys(s.deps, t.id));
          const unknownPage = seen(await send(s.deps, "GET", `/t/${UNKNOWN_SLUG}`));
          const unknownPicture = seen(await send(s.deps, "GET", `/p/${UNKNOWN_NAME}`));

          const check = async (at: string) => {
            const row = await s.deps.db.first<{ access: string; slug: string }>("SELECT access, slug FROM tour WHERE id = ?", [t.id]);
            expect(row!.slug, at).toBe(t.slug);
            for (const k of await namedKeys(s.deps, t.id)) ever.add(k);
            if (row!.access !== "public") {
              expect(seen(await send(s.deps, "GET", `/t/${t.slug}`)), at).toEqual(unknownPage);
              for (const k of ever) if (k.startsWith("p/")) expect(seen(await send(s.deps, "GET", `/${k}`)), `${at}: ${k}`).toEqual(unknownPicture);
            } else {
              // Public: every live picture is in the public store.
              const live = await s.deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ?", [t.id]);
              for (const { image_key } of live) expect(image_key.startsWith("p/"), at).toBe(true);
              expect(await s.deps.db.first("SELECT 1 AS x FROM access_switch WHERE tour_id = ? AND target = 'public'", [t.id]), at).toBeNull();
            }
            // Every stored picture of the tour is named by one of its rows.
            const named = new Set(await namedKeys(s.deps, t.id));
            for (const k of [...(await s.publicKeys()), ...(await s.draftKeys()).filter((x) => x.startsWith("v/"))]) expect(named.has(k), `${at}: ${k} is named by no row`).toBe(true);
            expect((await usageOf(s.deps, s.owner.workspaceId)).used, at).toBeGreaterThanOrEqual(used);
            expect(await draftOf(s, t.id), at).toEqual(draft);
          };

          const faulty = failingAt(s.deps, n, when);
          let r = await setAccess(faulty.deps, s.owner.token, t.id, target);
          while (r.status === 202 && !faulty.hit()) {
            await check(`${label}, on the way`);
            r = await setAccess(faulty.deps, s.owner.token, t.id, target);
          }
          const met = faulty.hit();
          if (met) {
            await check(`${label}, where it stopped`);
            for (let i = 0; i < 10; i++) {
              r = await setAccess(s.deps, s.owner.token, t.id, target);
              await check(`${label}, resumed`);
              if (r.status !== 202) break;
            }
          }
          expect(r.status, `${label}: ${r.text}`).toBe(200);
          expect(r.json.access, label).toBe(target.access);

          // Done: one store holds the live pictures, the other nothing of the tour; no row
          // names a missing object; the live version is the same one, renamed.
          const live = (await s.deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ?", [t.id])).map((x) => x.image_key);
          expect(live, label).toHaveLength(COPY_BATCH + 1);
          expect(await s.deps.db.all("SELECT image_key, state FROM public_object WHERE tour_id = ?", [t.id]), label).toEqual([]);
          expect(await s.deps.db.all("SELECT * FROM access_switch"), label).toEqual([]);
          const pub = await s.publicKeys();
          const priv = (await s.draftKeys()).filter((k) => k.startsWith("v/"));
          if (direction === "restricted") {
            expect(pub, label).toEqual([]);
            expect(priv.sort(), label).toEqual([...live].sort());
          } else {
            expect(priv, label).toEqual([]);
            expect(pub.sort(), label).toEqual([...live].sort());
            expect((await send(s.deps, "GET", `/t/${t.slug}`)).status, label).toBe(200);
          }
          expect(await shapeOf(s, t.id), label).toEqual(shape);
          expect(await draftOf(s, t.id), label).toEqual(draft);
          expect((await usageOf(s.deps, s.owner.workspaceId)).used, label).toBe(used);
          if (!met) {
            expect(n, "the failure was met at least once").toBeGreaterThan(30);
            break;
          }
        }
      }
    });
  }
});

describe("the call budget", () => {
  it("every request with a tour of 60 steps stays within the budget: publish, both switches, a restricted publish, unpublish and delete", VERY_SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 60);
    const all: Call[] = [];
    all.push(...(await publishAll(s.deps, s.owner.token, t.id)));
    const toPeople = await untilDone(s.deps, s.owner.token, t.id, { access: "people", viewers: Array.from({ length: MAX_VIEWERS }, (_, i) => `v${i}@example.com`) });
    expect(toPeople.length).toBeGreaterThan(4);
    all.push(...toPeople);
    expect(await s.publicKeys()).toEqual([]);
    all.push(...(await publishAll(s.deps, s.owner.token, t.id)));
    all.push(...(await untilDone(s.deps, s.owner.token, t.id, { access: "me" })));
    const toPublic = await untilDone(s.deps, s.owner.token, t.id, { access: "public" });
    all.push(...toPublic);
    expect((await s.draftKeys()).filter((k) => k.startsWith("v/"))).toEqual([]);
    all.push(await getAccess(s.deps, s.owner.token, t.id));
    all.push(await send(s.deps, "POST", `/api/v1/tours/${t.id}/unpublish`, { token: s.owner.token }));
    for (let i = 0; i < 5; i++) {
      const r = await send(s.deps, "DELETE", `/api/v1/tours/${t.id}`, { token: s.owner.token });
      all.push(r);
      if (r.status === 200) break;
    }
    // send() already fails any request over the budget; this records the largest.
    expect(Math.max(...all.map((c) => c.calls))).toBeLessThanOrEqual(40);
  });
});

describe("mayView and tourForServing", () => {
  it("answers every combination fresh: the list, the owner's address as it is now, an address removed, a disabled workspace", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 1);
    const tour = { id: t.id };
    const owner = s.owner.email;
    const may = (email: string | null) => mayView(s.deps, tour, email);

    // Public: everyone, with or without an address.
    expect([await may(null), await may("anyone@example.com"), await may("not an address")]).toEqual([true, true, true]);
    // People: the list and the owner, nobody else; addresses compared as sign-in writes them.
    await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: ["ana@example.com"] });
    expect([await may(null), await may("ana@example.com"), await may(" ANA@Example.com "), await may(owner), await may(owner.toUpperCase()), await may("bo@example.com"), await may(s.other.email), await may("ana@example.com\n")]).toEqual([
      false, true, true, true, true, false, false, false,
    ]);
    // Me: the owner alone, even with the list kept.
    await setAccess(s.deps, s.owner.token, t.id, { access: "me" });
    expect([await may("ana@example.com"), await may(owner), await may(null)]).toEqual([false, true, false]);
    // An address taken off the list loses its way in at the next check.
    await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: ["bo@example.com"] });
    expect([await may("ana@example.com"), await may("bo@example.com")]).toEqual([false, true]);
    // The owner's address is read at the check: a changed one counts at once, the old one no longer.
    await s.deps.db.run("UPDATE user SET email = ? WHERE id = ?", ["renamed-owner@example.com", s.owner.userId]);
    expect([await may(owner), await may("renamed-owner@example.com")]).toEqual([false, true]);
    // One call each time.
    const before = s.calls();
    await may("bo@example.com");
    expect(s.calls() - before).toBe(1);
    // A disabled workspace: nobody, whatever the setting.
    await s.deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [s.owner.userId]);
    expect([await may("bo@example.com"), await may("renamed-owner@example.com")]).toEqual([false, false]);
    await s.deps.db.run("UPDATE tour SET access = 'public' WHERE id = ?", [t.id]);
    expect(await may(null)).toBe(false);
    expect(await mayView(s.deps, { id: "tour_" + "0".repeat(24) }, null)).toBe(false);
    expect((await tourForServing(s.deps, { id: t.id }))!.enabled).toBe(false);
  });

  it("tourForServing: unknown, draft, public, restricted, and a switch to restricted under way", SLOW, async () => {
    const s = await site();
    expect(await tourForServing(s.deps, { slug: UNKNOWN_SLUG })).toBeNull();
    expect(await tourForServing(s.deps, { slug: "Not a slug" })).toBeNull();
    const t = await tourOf(s, COPY_BATCH + 2);
    expect(await tourForServing(s.deps, { slug: t.slug })).toMatchObject({ access: "public", published: false, data: null, pictures: null, switching: false });
    await publishAll(s.deps, s.owner.token, t.id);
    expect(await tourForServing(s.deps, { slug: t.slug })).toMatchObject({ access: "public", published: true, pictures: null });
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people" })).status).toBe(202);
    expect(await tourForServing(s.deps, { slug: t.slug })).toMatchObject({ access: "people", published: true, switching: true, pictures: null });
    await untilDone(s.deps, s.owner.token, t.id, { access: "people" });
    expect((await tourForServing(s.deps, { slug: t.slug }))!.pictures!.size).toBe(COPY_BATCH + 3);
    // Going public, it stays restricted, with its private pictures, until the last step.
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "public" })).status).toBe(202);
    const during = await tourForServing(s.deps, { slug: t.slug });
    expect(during).toMatchObject({ access: "people", switching: true });
    expect(during!.pictures!.size).toBe(COPY_BATCH + 3);
    expect(seen(await send(s.deps, "GET", `/t/${t.slug}`))).toEqual(seen(await send(s.deps, "GET", `/t/${UNKNOWN_SLUG}`)));
  });
});

describe("a site that cannot mail", () => {
  it("refuses to make a tour restricted, keeps a restricted tour so, and still takes a change of its list or making it public", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 1);
    const kept = await tourOf(s, 1, "Kept");
    await setAccess(s.deps, s.owner.token, kept.id, { access: "people", viewers: ["ana@example.com"] });
    s.deps.config = { ...s.deps.config, siteHost: null };
    const refused = await setAccess(s.deps, s.owner.token, t.id, { access: "people" });
    expect([refused.status, refused.json.error]).toEqual([409, "cannot_restrict"]);
    expect((await getAccess(s.deps, s.owner.token, t.id)).json).toMatchObject({ access: "public", can_restrict: false });
    expect((await getAccess(s.deps, s.owner.token, kept.id)).json).toMatchObject({ access: "people", can_restrict: false });
    expect((await setAccess(s.deps, s.owner.token, kept.id, { access: "me" })).json.error).toBe("cannot_restrict");
    expect((await setAccess(s.deps, s.owner.token, kept.id, { access: "people", viewers: ["bo@example.com"] })).json).toMatchObject({ access: "people", viewers: ["bo@example.com"] });
    expect((await setAccess(s.deps, s.owner.token, kept.id, { access: "public" })).json.access).toBe("public");
    // A site with no mailer at all is the same.
    const bare = await makeDeps(MAILS, { mail: false });
    const acc = await seedAccount(bare.deps);
    const one = await uploadTour(bare.deps, acc.token, manifestOf([200], "Bare"), { kind: "new" }, 3);
    expect((await setAccess(bare.deps, acc.token, one.tour_id, { access: "me" })).json.error).toBe("cannot_restrict");
  });
});
