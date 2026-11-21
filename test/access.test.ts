// Who may view a tour (src/access.ts) on both targets: the setting and its list, the switch
// that moves a published tour's live pictures between the two stores (interrupted at every
// call and resumed), publishing a restricted tour, the two functions the serving route will
// call, a site without mail, and the call budget with a tour of 60 steps.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { CARRY_AFTER_MS, CARRY_CALLS, MAX_VIEWERS, RESTRICTED_STUB, carryOnSwitch, mayView, tourForServing } from "../src/access.ts";
import type { Deps, FileStore } from "../src/ports.ts";
import { COPY_BATCH, STALE_PUBLISH_MS, randomHex } from "../src/publish.ts";
import { usageOf } from "../src/usage.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, send, uploadTour, type Call, type Json } from "./bundle.ts";
import { manifestOf } from "./isolation-world.ts";
import { oldCommitStatements, oldPage, oldPicture } from "./old-build-0.1.35.ts";

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

/**
 * The signed-in browser of each account, by its token: only a session may change who views a
 * tour, so setAccess sends the session of the account whose token it is given.
 */
const sessionsByToken = new Map<string, Record<string, string>>();

async function signIn(deps: Deps, userId: string, token: string): Promise<void> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  sessionsByToken.set(token, { cookie: `${SESSION_COOKIE}=${made.secret}`, "x-csrf-token": await csrfFor(made.secret), origin: ORIGIN, "sec-fetch-site": "same-origin" });
}

async function site(config: Parameters<typeof makeDeps>[0] = {}): Promise<Site> {
  const ctx = await makeDeps({ ...MAILS, ...config });
  // Signing in needs a site with an admin: the owner is the site's admin.
  const owner = await seedAccount(ctx.deps, { admin: true });
  const other = await seedAccount(ctx.deps);
  await signIn(ctx.deps, owner.userId, owner.token);
  await signIn(ctx.deps, other.userId, other.token);
  return { ...ctx, owner, other };
}

/** The setting as the account's signed-in session reads it, with the list (a token gets only its count). */
const getAccess = (deps: Deps, token: string, tourId: string) => send(deps, "GET", `/api/v1/tours/${tourId}/access`, { headers: sessionsByToken.get(token)! });
/** The change, sent with the signed-in session of the account whose token this is. */
const setAccess = (deps: Deps, token: string, tourId: string, body: unknown) =>
  send(deps, "PUT", `/api/v1/tours/${tourId}/access`, { headers: { ...JSON_HEADERS, ...sessionsByToken.get(token)! }, body: JSON.stringify(body) });

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
  const row = await s.deps.db.first<{ data: string; publish_id: string }>("SELECT coalesce(private_data, data) AS data, publish_id FROM snapshot WHERE tour_id = ?", [tourId]);
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
 * Deps whose `n`-th call (counted over every port, from now on) fails: once before it is
 * made, once after it took effect (an answer lost on the way back), or before it is made
 * and again on the call after it ("twice", a failure that does not go away at once). As in
 * test/account-removal.test.ts, with the third way added.
 */
function failingAt(deps: Deps, n: number, when: "before" | "after" | "twice"): { deps: Deps; hit: () => boolean } {
  let count = 0;
  let hit = false;
  const gate = async <T>(run: () => Promise<T>): Promise<T> => {
    count += 1;
    if (count !== n && !(when === "twice" && count === n + 1)) return run();
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
      [t.id, { from: "public", to: "people", viewers_before: 0, viewers: 2, by: "session" }],
      [t.id, { from: "people", to: "people", viewers_before: 2, viewers: 1, by: "session" }],
      [t.id, { from: "people", to: "public", viewers_before: 1, viewers: 1, by: "session" }],
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
      for (const when of ["before", "after", "twice"] as const) {
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
            // Housekeeping's carry runs at every checkpoint too, as if the move had been left.
            await carryOnSwitch(s.deps, s.owner.workspaceId, CARRY_CALLS, 0);
            const row = await s.deps.db.first<{ access: string; slug: string }>("SELECT access, slug FROM tour WHERE id = ?", [t.id]);
            expect(row!.slug, at).toBe(t.slug);
            for (const k of await namedKeys(s.deps, t.id)) ever.add(k);
            if (row!.access !== "public") {
              expect(seen(await send(s.deps, "GET", `/t/${t.slug}`)), at).toEqual(unknownPage);
              for (const k of ever) if (k.startsWith("p/")) expect(seen(await send(s.deps, "GET", `/${k}`)), `${at}: ${k}`).toEqual(unknownPicture);
              // Nor would the build before this feature, gone back to on this database.
              expect(await oldPage(s.deps, t.slug), `${at}: 0.1.35's page`).toBeNull();
              for (const k of ever) expect(await oldPicture(s.deps, k), `${at}: 0.1.35's picture ${k}`).toBe(false);
              expect((await s.deps.db.first<{ data: string }>("SELECT data FROM snapshot WHERE tour_id = ?", [t.id]))?.data ?? RESTRICTED_STUB, at).toBe(RESTRICTED_STUB);
            } else {
              // Public: every live picture is in the public store.
              const live = await s.deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ?", [t.id]);
              for (const { image_key } of live) expect(image_key.startsWith("p/"), at).toBe(true);
              expect(await s.deps.db.first("SELECT 1 AS x FROM access_switch WHERE tour_id = ? AND target = 'public'", [t.id]), at).toBeNull();
            }
            // A move under way says which way it goes, the same way whoever drives it.
            const shown = (await getAccess(s.deps, s.owner.token, t.id)).json.switching;
            if (shown !== null) expect(shown.target, at).toBe(direction === "restricted" ? "restricted" : "public");
            // Every stored picture of the tour is named by one of its rows.
            const named = new Set(await namedKeys(s.deps, t.id));
            for (const k of [...(await s.publicKeys()), ...(await s.draftKeys()).filter((x) => x.startsWith("v/"))]) expect(named.has(k), `${at}: ${k} is named by no row`).toBe(true);
            expect((await usageOf(s.deps, s.owner.workspaceId)).used, at).toBeGreaterThanOrEqual(used);
            expect(await draftOf(s, t.id), at).toEqual(draft);
          };

          const faulty = failingAt(s.deps, n, when);
          let r = await setAccess(faulty.deps, s.owner.token, t.id, target);
          while (r.status === 202 && !faulty.hit()) {
            expect(r.json.target, label).toBe(direction === "restricted" ? "restricted" : "public");
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
  it("refuses to make a public tour restricted, keeps a restricted tour so, and still takes a change between people and me, of its list, or making it public", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 1);
    const kept = await tourOf(s, 1, "Kept");
    await setAccess(s.deps, s.owner.token, kept.id, { access: "people", viewers: ["ana@example.com"] });
    s.deps.config = { ...s.deps.config, siteHost: null };
    const refused = await setAccess(s.deps, s.owner.token, t.id, { access: "people" });
    expect([refused.status, refused.json.error]).toEqual([409, "cannot_restrict"]);
    expect((await getAccess(s.deps, s.owner.token, t.id)).json).toMatchObject({ access: "public", can_restrict: false });
    expect((await getAccess(s.deps, s.owner.token, kept.id)).json).toMatchObject({ access: "people", can_restrict: false });
    // Between the two restricted settings nothing is loosened: allowed.
    expect((await setAccess(s.deps, s.owner.token, kept.id, { access: "me" })).json.access).toBe("me");
    expect((await setAccess(s.deps, s.owner.token, kept.id, { access: "people", viewers: ["bo@example.com"] })).json).toMatchObject({ access: "people", viewers: ["bo@example.com"] });
    expect((await setAccess(s.deps, s.owner.token, kept.id, { access: "public" })).json.access).toBe("public");
    // A site with no mailer at all is the same.
    const bare = await makeDeps(MAILS, { mail: false });
    const acc = await seedAccount(bare.deps, { admin: true });
    await signIn(bare.deps, acc.userId, acc.token);
    const one = await uploadTour(bare.deps, acc.token, manifestOf([200], "Bare"), { kind: "new" }, 3);
    expect((await setAccess(bare.deps, acc.token, one.tour_id, { access: "me" })).json.error).toBe("cannot_restrict");
  });
});

describe("the review's follow-ups", () => {
  it("only a session may change who views a tour; a token may read it", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 1);
    const byToken = await send(s.deps, "PUT", `/api/v1/tours/${t.id}/access`, { token: s.owner.token, headers: JSON_HEADERS, body: JSON.stringify({ access: "me" }) });
    expect([byToken.status, byToken.json]).toEqual([401, { error: "unauthorized" }]);
    expect((await getAccess(s.deps, s.owner.token, t.id)).json.access).toBe("public");
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "me" })).json.access).toBe("me");
  });

  it("the build before this one, gone back to, serves nothing of a restricted tour or one moving either way; made public, the text is back", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, COPY_BATCH + 2);
    await publishAll(s.deps, s.owner.token, t.id);
    const before = (await oldPage(s.deps, t.slug)) as Json;
    expect(before).not.toBeNull(); // public: 0.1.35 serves it, as it always did
    const nothing = async (what: string, also: string[] = []) => {
      expect(await oldPage(s.deps, t.slug), what).toBeNull();
      for (const k of [...(await namedKeys(s.deps, t.id)), ...also]) expect(await oldPicture(s.deps, k), `${what}: ${k}`).toBe(false);
      expect((await s.deps.db.first<{ data: string }>("SELECT data FROM snapshot WHERE tour_id = ?", [t.id]))!.data, what).toBe(RESTRICTED_STUB);
    };
    const publicKeys = (await namedKeys(s.deps, t.id)).filter((k) => k.startsWith("p/"));
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people" })).status).toBe(202);
    await nothing("a move to restricted under way", publicKeys);
    await untilDone(s.deps, s.owner.token, t.id, { access: "people" });
    await nothing("restricted", publicKeys);
    // An older build's rename writes the title into data: the database refuses it (the
    // triggers of migration 0014), and the stub stays.
    await expect(s.deps.db.run("UPDATE snapshot SET data = json_set(data, '$.title', 'Renamed by 0.1.35') WHERE tour_id = ? AND json_valid(data)", [t.id])).rejects.toThrow(/stub/);
    expect(await oldPage(s.deps, t.slug)).toBeNull();
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "public" })).status).toBe(202);
    await nothing("a move to public under way");
    await untilDone(s.deps, s.owner.token, t.id, { access: "public" });
    const after = (await oldPage(s.deps, t.slug)) as Json;
    expect(after.title).toBe(before.title);
    expect(after.chapters.length).toBe(before.chapters.length);
    expect(await s.deps.db.first("SELECT private_data FROM snapshot WHERE tour_id = ?", [t.id])).toEqual({ private_data: null });
    // tourForServing gives a restricted tour's text only with its pictures.
    await setAccess(s.deps, s.owner.token, t.id, { access: "me" });
    const moving = await tourForServing(s.deps, { id: t.id });
    expect([moving!.switching, moving!.pictures, moving!.data]).toEqual([true, null, null]);
  });

  it("a move to restricted its client left is finished by the workspace's housekeeping, and the public store empties as it goes", SLOW, async () => {
    const s = await site();
    let now = Date.now();
    s.deps.now = () => now;
    const t = await tourOf(s, 3 * COPY_BATCH);
    await publishAll(s.deps, s.owner.token, t.id);
    const total = 3 * COPY_BATCH + 1;
    expect(await s.publicKeys()).toHaveLength(total);
    const first = await setAccess(s.deps, s.owner.token, t.id, { access: "people" });
    expect(first.status).toBe(202);
    // The pictures that request moved are already gone from the public store.
    expect(await s.publicKeys()).toHaveLength(total - first.json.done);
    // No access request any more; within the minute housekeeping leaves it to its client.
    await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
    expect(await s.publicKeys()).toHaveLength(total - first.json.done);
    expect((await getAccess(s.deps, s.owner.token, t.id)).json.switching).toEqual({ done: first.json.done, total, target: "restricted" });
    now += CARRY_AFTER_MS + 1;
    // Housekeeping carries it on: still a move to restricted, further on.
    await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
    expect((await getAccess(s.deps, s.owner.token, t.id)).json.switching).toEqual({ done: first.json.done + 4, total, target: "restricted" });
    let lists = 0;
    while ((await s.deps.db.first("SELECT 1 AS x FROM access_switch")) !== null) {
      expect(++lists, "housekeeping finishes it").toBeLessThan(40);
      const shown = await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
      expect(shown.text).not.toContain("@");
      now += 1000;
    }
    expect(await s.publicKeys()).toEqual([]);
    expect(await s.deps.db.all("SELECT image_key FROM public_object")).toEqual([]);
    const served = await tourForServing(s.deps, { id: t.id });
    expect(served!.pictures!.size).toBe(total);
    expect((await getAccess(s.deps, s.owner.token, t.id)).json).toMatchObject({ access: "people", switching: null });
  });

  it("a move to public is cancelled by asking for the setting the tour still has, also when that request is interrupted at any call", VERY_SLOW, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const when of ["before", "after", "twice"] as const) {
      for (let n = 1; ; n++) {
        const label = `cancel, failure ${when} call ${n}`;
        const s = await site();
        let now = Date.now();
        s.deps.now = () => now;
        const t = await tourOf(s, COPY_BATCH + 4);
        await setAccess(s.deps, s.owner.token, t.id, { access: "me" });
        await publishAll(s.deps, s.owner.token, t.id);
        const live = await namedKeys(s.deps, t.id);
        expect((await setAccess(s.deps, s.owner.token, t.id, { access: "public" })).status, label).toBe(202);
        expect((await s.publicKeys()).length, label).toBe(COPY_BATCH);
        const faulty = failingAt(s.deps, n, when);
        let r = await setAccess(faulty.deps, s.owner.token, t.id, { access: "me" });
        const met = faulty.hit();
        expect(seen(await send(s.deps, "GET", `/t/${t.slug}`)), label).toEqual(seen(await send(s.deps, "GET", `/t/${UNKNOWN_SLUG}`)));
        for (let i = 0; i < 5 && r.status !== 200; i++) r = await setAccess(s.deps, s.owner.token, t.id, { access: "me" });
        expect([r.status, r.json.access, r.json.switching], `${label}: ${r.text}`).toEqual([200, "me", null]);
        // Housekeeping retires what a cut-off cancel left pending, after the stale period.
        now += 16 * 60_000;
        await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
        await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
        expect(await s.publicKeys(), label).toEqual([]);
        expect(await s.deps.db.all("SELECT * FROM access_switch"), label).toEqual([]);
        expect((await namedKeys(s.deps, t.id)).sort(), label).toEqual([...live].sort());
        expect((await tourForServing(s.deps, { id: t.id }))!.pictures!.size, label).toBe(COPY_BATCH + 5);
        if (!met) {
          expect(n, "the failure was met").toBeGreaterThan(3);
          break;
        }
      }
    }
  });

  it("a published version that cannot be moved asks to publish again; a request that only cleans up answers the final state", SLOW, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await site();
    const t = await tourOf(s, 1);
    await publishAll(s.deps, s.owner.token, t.id);
    const good = (await s.deps.db.first<{ data: string }>("SELECT data FROM snapshot WHERE tour_id = ?", [t.id]))!.data;
    await s.deps.db.run(`UPDATE snapshot SET data = '{"title":"broken"}' WHERE tour_id = ?`, [t.id]);
    for (let i = 0; i < 2; i++) {
      const r = await setAccess(s.deps, s.owner.token, t.id, { access: "people" });
      expect([r.status, r.json.error]).toEqual([409, "republish_needed"]);
    }
    expect((await getAccess(s.deps, s.owner.token, t.id)).json.access).toBe("public");
    await s.deps.db.run("UPDATE snapshot SET data = ? WHERE tour_id = ?", [good, t.id]);
    await untilDone(s.deps, s.owner.token, t.id, { access: "me" });
    // Made public, with the old private pictures' removal failing: the state is final, so 200.
    const drafts = s.deps.drafts;
    s.deps.drafts = { ...drafts, delete: () => Promise.reject(new Error("down")) };
    const done = await setAccess(s.deps, s.owner.token, t.id, { access: "public" });
    expect([done.status, done.json.access]).toEqual([200, "public"]);
    const again = await setAccess(s.deps, s.owner.token, t.id, { access: "public" });
    expect([again.status, again.json.access, again.json.switching]).toEqual([200, "public", null]);
    s.deps.drafts = drafts;
    await setAccess(s.deps, s.owner.token, t.id, { access: "public" });
    expect((await s.draftKeys()).filter((k) => k.startsWith("v/"))).toEqual([]);
  });
});

describe("the second review", () => {
  it("every request that runs housekeeping stays within the budget with a 60-picture move waiting each way; the tour list finishes one and cancels the other", VERY_SLOW, async () => {
    const s = await site();
    let now = Date.now();
    s.deps.now = () => now;
    const token = s.owner.token;
    const toPrivate = await tourOf(s, 60, "Going restricted");
    await publishAll(s.deps, token, toPrivate.id);
    expect((await setAccess(s.deps, token, toPrivate.id, { access: "people" })).status).toBe(202);
    const toPublic = await tourOf(s, 60, "Going public");
    await setAccess(s.deps, token, toPublic.id, { access: "me" });
    await publishAll(s.deps, token, toPublic.id);
    const going = await setAccess(s.deps, token, toPublic.id, { access: "public" });
    expect([going.status, going.json.target]).toEqual([202, "public"]);
    expect((await send(s.deps, "GET", `/api/v1/tours/${toPublic.id}/access`, { token })).json.switching).toEqual({ done: COPY_BATCH, total: 61, target: "public" });
    const other = await tourOf(s, COPY_BATCH + 1, "Other");
    await publishAll(s.deps, token, other.id);
    const busy = await tourOf(s, COPY_BATCH + 1, "Busy");
    // Both moves left: the one to restricted for more than a minute, the one to public for more than fifteen.
    now += STALE_PUBLISH_MS + 1000;
    expect((await send(s.deps, "POST", `/api/v1/tours/${busy.id}/publish`, { token })).status).toBe(202);
    const requests: [string, () => Promise<Call>][] = [
      ["an upload's create", () => send(s.deps, "POST", "/api/v1/uploads", { token, headers: JSON_HEADERS, body: JSON.stringify({ manifest: manifestOf([200], "New tour"), target: { kind: "new" } }) })],
      ["publish", () => send(s.deps, "POST", `/api/v1/tours/${other.id}/publish`, { token })],
      ["a delete that meets a publish in progress", () => send(s.deps, "DELETE", `/api/v1/tours/${busy.id}`, { token })],
      ["unpublish", () => send(s.deps, "POST", `/api/v1/tours/${other.id}/unpublish`, { token })],
      ["the tour list", () => send(s.deps, "GET", "/api/v1/tours", { token })],
    ];
    for (const [what, run] of requests) {
      const r = await run();
      expect(r.status, `${what}: ${r.text}`).toBeLessThan(500);
      expect(r.calls, what).toBeLessThanOrEqual(40);
    }
    // The tour list, again and again: each within the budget, until both moves are over.
    for (let i = 0; (await s.deps.db.first("SELECT 1 AS x FROM access_switch")) !== null; i++) {
      expect(i, "housekeeping ends both moves").toBeLessThan(40);
      now += 1000;
      const r = await send(s.deps, "GET", "/api/v1/tours", { token });
      expect(r.calls).toBeLessThanOrEqual(40);
    }
    expect((await getAccess(s.deps, token, toPrivate.id)).json).toMatchObject({ access: "people", switching: null });
    // The move to public was cancelled: still restricted, its private pictures live, no public copy left.
    expect((await getAccess(s.deps, token, toPublic.id)).json).toMatchObject({ access: "me", switching: null });
    expect((await tourForServing(s.deps, { id: toPublic.id }))!.pictures!.size).toBe(61);
    // The public store holds only the copies of the publish of the busy tour still in progress.
    const busyKeys = new Set(await namedKeys(s.deps, busy.id));
    expect((await s.publicKeys()).filter((k) => !busyKeys.has(k))).toEqual([]);
  });

  it("a publish by the build before this one, on a restricted tour, fails as a whole and leaves nothing public", SLOW, async () => {
    const s = await site();
    const now = Date.now();
    const published = await tourOf(s, 2, "Restricted and published");
    await setAccess(s.deps, s.owner.token, published.id, { access: "me" });
    await publishAll(s.deps, s.owner.token, published.id);
    const draft = await tourOf(s, 2, "Restricted draft");
    await setAccess(s.deps, s.owner.token, draft.id, { access: "people" });
    const text = (await s.deps.db.first<{ private_data: string }>("SELECT private_data FROM snapshot WHERE tour_id = ?", [published.id]))!.private_data.replace(/"v\//g, '"p/');
    for (const t of [published, draft]) {
      // What 0.1.35's publish leaves before its commit: the job, its pending rows, the public copies.
      const publishId = "pub_" + randomHex(24);
      const keys = [0, 1, 2].map(() => `p/${randomHex(32)}.png`);
      const version = (await s.deps.db.first<{ draft_version: number }>("SELECT draft_version FROM tour WHERE id = ?", [t.id]))!.draft_version;
      await s.deps.db.run("INSERT INTO publish_job (tour_id, publish_id, data, steps, total, draft_version, created_at, touched_at) VALUES (?, ?, ?, 2, 3, ?, ?, ?)", [t.id, publishId, text, version, now, now]);
      for (const [i, key] of keys.entries()) {
        await s.deps.db.run("INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, source_key, seq, copied) VALUES (?, ?, ?, 'pending', ?, 'u/x', ?, 1)", [key, t.id, publishId, now, i]);
        await s.deps.pub.put(key, new Uint8Array([1, 2, 3]), { contentType: "image/png" });
      }
      const before = await s.deps.db.first("SELECT data, private_data FROM snapshot WHERE tour_id = ?", [t.id]);
      await expect(s.deps.db.batch(oldCommitStatements(s.owner.workspaceId, t.id, publishId, [], now, 600_000)), t.id).rejects.toThrow(/restricted tour/);
      expect(await s.deps.db.first("SELECT data, private_data FROM snapshot WHERE tour_id = ?", [t.id]), t.id).toEqual(before);
      expect((await namedKeys(s.deps, t.id)).filter((k) => k.startsWith("p/") && !keys.includes(k)), t.id).toEqual([]);
      expect(await s.deps.db.all("SELECT image_key FROM snapshot_object WHERE tour_id = ? AND image_key LIKE 'p/%'", [t.id]), t.id).toEqual([]);
      expect(await oldPage(s.deps, t.slug), t.id).toBeNull();
      for (const key of keys) expect(await oldPicture(s.deps, key), key).toBe(false);
    }
  });

  it("a picture whose source is gone stops the move with republish_needed; unpublishing and publishing again leaves it; the carry backs off", SLOW, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await site();
    let now = Date.now();
    s.deps.now = () => now;
    const t = await tourOf(s, COPY_BATCH + 3);
    await publishAll(s.deps, s.owner.token, t.id);
    expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people" })).status).toBe(202);
    // The source of the next picture to copy, so the next request and the next carry both meet it.
    const source = (await s.deps.db.first<{ source_key: string }>("SELECT source_key FROM public_object WHERE tour_id = ? AND substr(publish_id, 1, 3) = 'sw_' AND copied = 0 ORDER BY seq LIMIT 1", [t.id]))!.source_key;
    await s.deps.pub.delete([source]);
    for (let i = 0; i < 2; i++) {
      const r = await setAccess(s.deps, s.owner.token, t.id, { access: "people" });
      expect([r.status, r.json.error], r.text).toEqual([409, "republish_needed"]);
      expect(r.json.detail).toContain("unpublish the tour, then publish it again");
    }
    expect((await send(s.deps, "POST", `/api/v1/tours/${t.id}/publish`, { token: s.owner.token })).json.error).toBe("access_switching");
    expect(seen(await send(s.deps, "GET", `/t/${t.slug}`))).toEqual(seen(await send(s.deps, "GET", `/t/${UNKNOWN_SLUG}`)));
    // The carry tries once, fails, and puts the heartbeat on the switch: it waits a minute again.
    now += CARRY_AFTER_MS + 1;
    await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
    expect(await s.deps.db.first("SELECT touched_at FROM access_switch WHERE tour_id = ?", [t.id])).toEqual({ touched_at: now });
    const quiet = await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
    const first = await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token });
    expect(quiet.calls).toBe(first.calls);
    // The way out: unpublish (it ends the move and removes its pictures), then publish again.
    expect((await send(s.deps, "POST", `/api/v1/tours/${t.id}/unpublish`, { token: s.owner.token })).status).toBe(204);
    expect(await s.publicKeys()).toEqual([]);
    expect((await s.draftKeys()).filter((k) => k.startsWith("v/"))).toEqual([]);
    expect(await s.deps.db.all("SELECT * FROM access_switch")).toEqual([]);
    await publishAll(s.deps, s.owner.token, t.id);
    expect((await tourForServing(s.deps, { id: t.id }))!.pictures!.size).toBe(COPY_BATCH + 4);
    expect(await s.publicKeys()).toEqual([]);
  });

  it("housekeeping's carry, failing at any call or meeting an unpublish, leaves no object that no row names, and finishes the move afterwards", VERY_SLOW, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const orphans = async (s: Site, tourId: string) => {
      const named = new Set(await namedKeys(s.deps, tourId));
      return [...(await s.publicKeys()), ...(await s.draftKeys()).filter((k) => k.startsWith("v/"))].filter((k) => !named.has(k));
    };
    const abandoned = async () => {
      const s = await site();
      const t = await tourOf(s, COPY_BATCH + 6);
      await publishAll(s.deps, s.owner.token, t.id);
      expect((await setAccess(s.deps, s.owner.token, t.id, { access: "people" })).status).toBe(202);
      return { s, t };
    };
    for (const when of ["before", "after", "twice"] as const) {
      for (let n = 1; ; n++) {
        const label = `carry, failure ${when} call ${n}`;
        const { s, t } = await abandoned();
        const faulty = failingAt(s.deps, n, when);
        await carryOnSwitch(faulty.deps, s.owner.workspaceId, CARRY_CALLS, 0);
        expect(await orphans(s, t.id), label).toEqual([]);
        for (let i = 0; i < 20 && (await s.deps.db.first("SELECT 1 AS x FROM access_switch")) !== null; i++) {
          await new Promise((r) => setTimeout(r, 2));
          await carryOnSwitch(s.deps, s.owner.workspaceId, CARRY_CALLS, 0);
          expect(await orphans(s, t.id), label).toEqual([]);
        }
        expect(await s.deps.db.all("SELECT * FROM access_switch"), label).toEqual([]);
        expect(await s.publicKeys(), label).toEqual([]);
        expect((await tourForServing(s.deps, { id: t.id }))!.pictures!.size, label).toBe(COPY_BATCH + 7);
        if (!faulty.hit()) {
          expect(n, "the failure was met").toBeGreaterThan(5);
          break;
        }
      }
    }
    // An unpublish lands while the carry copies: what it wrote is deleted, nothing is left.
    const { s, t } = await abandoned();
    const drafts = s.deps.drafts;
    s.deps.drafts = {
      ...drafts,
      put: async (key, body, meta) => {
        s.deps.drafts = drafts;
        await send(s.deps, "POST", `/api/v1/tours/${t.id}/unpublish`, { token: s.owner.token });
        return drafts.put(key, body, meta);
      },
    };
    await carryOnSwitch(s.deps, s.owner.workspaceId, CARRY_CALLS, 0);
    s.deps.drafts = drafts;
    expect(await s.publicKeys()).toEqual([]);
    expect((await s.draftKeys()).filter((k) => k.startsWith("v/"))).toEqual([]);
    expect(await s.deps.db.all("SELECT image_key FROM public_object UNION ALL SELECT image_key FROM snapshot_object")).toEqual([]);
  });

  it("a token reads the setting and how many addresses there are, never the addresses", SLOW, async () => {
    const s = await site();
    const t = await tourOf(s, 1);
    await setAccess(s.deps, s.owner.token, t.id, { access: "people", viewers: ["ana@example.com", "bo@example.com"] });
    const byToken = await send(s.deps, "GET", `/api/v1/tours/${t.id}/access`, { token: s.owner.token });
    expect(byToken.json).toEqual({ access: "people", viewers_count: 2, limit: MAX_VIEWERS, can_restrict: true, switching: null });
    expect(byToken.text).not.toContain("@");
    expect((await getAccess(s.deps, s.owner.token, t.id)).json).toEqual({ access: "people", viewers: ["ana@example.com", "bo@example.com"], limit: MAX_VIEWERS, can_restrict: true, switching: null });
  });
});
