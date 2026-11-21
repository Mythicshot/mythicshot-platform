// Who may view something, stated by a token when it creates it (0.1.51), on both targets: a
// shared item's create (POST /api/v1/media, `access` and `viewers`) and a tour's FIRST publish
// (POST /api/v1/tours/:id/publish). The rules each test holds:
// - a restricted item or tour is never served to anyone without access, at any moment between
//   the create (or the first publish's first call) and the final answer, on any address role;
//   what cannot be restricted is refused before anything exists, with the access API's codes;
// - a token never changes the setting of something that exists: PUT .../access stays
//   session-only, and a publish with the fields of a tour published before (now or earlier,
//   unpublished since) or set in the dashboard is refused and changes nothing;
// - the fields left out (or `public` with no addresses) change nothing in any answer;
// - the addresses are checked, collapsed and limited as the PUT does, recorded only as counts
//   (with `at: "creation"` and `by: "token"`), never answered to a token, never logged;
// - a restricted item's link is its real one, kept apart from link_id, so an older build that
//   reads link_id serves nothing; a restricted tour holds the stub where an older build looks;
// - every request stays within the call budget with the largest list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { RESTRICTED_STUB } from "../src/access.ts";
import { hashToken, newId } from "../src/auth.ts";
import { SUBREQUEST_BUDGET } from "../src/budget.ts";
import type { Hosts } from "../src/hosts.ts";
import { MAX_SERVED_PARTS, PART_BYTES, RESTRICTED_SERVED_PARTS } from "../src/limits.ts";
import { MEDIA_DENIED_HTML, MEDIA_GATE_HTML } from "../src/media-view-page.ts";
import type { Deps, FileStore } from "../src/ports.ts";
import { COPY_BATCH } from "../src/publish.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { VIEW_GATE_HTML } from "../src/view-page.ts";
import { MEDIA_VIEWER_COOKIE, VIEWER_CODE_MS } from "../src/viewers.ts";
import { ORIGIN, png, send, uploadTour, type Call, type Json } from "./bundle.ts";
import { manifestOf } from "./isolation-world.ts";
import { oldPage, oldPicture } from "./old-build-0.1.35.ts";

const SLOW = { timeout: 600_000 };
const JSON_HEADERS = { "content-type": "application/json" };
const LISTED = "mara@example.com";
const OTHER = "bram@example.com";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UNKNOWN_SLUG = "aaaaaaaaaa";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

const T = "https://tours.example.com";
const A = "https://app.example.com";
const I = "https://img.example.com";
const TWO: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...TWO, img: "img.example.com" };
type Mode = { name: string; hosts: Hosts | null; app: string; tours: string; media: string };
const MODES: Mode[] = [
  { name: "one address", hosts: null, app: T, tours: T, media: T },
  { name: "two addresses", hosts: TWO, app: A, tours: T, media: T },
  { name: "three addresses", hosts: THREE, app: A, tours: T, media: I },
];
const ONE = MODES[0];

afterEach(() => vi.restoreAllMocks());

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
/** 200 different addresses of the longest form parseEmail takes (254 characters). */
const fullList = () => Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")}${"a".repeat(61)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`);

function hasBytes(haystack: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Every line written to the console from now on. */
function consoleLines(): string[] {
  const lines: string[] = [];
  for (const level of ["error", "warn", "log", "info"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  return lines;
}

/** A store wrapped so every call is counted, for "never touches the public store". */
function counting(store: FileStore): { store: FileStore; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    store: { put: (k, b, m) => (calls.push(`put ${k}`), store.put(k, b, m)), get: (k) => (calls.push(`get ${k}`), store.get(k)), delete: (k) => (calls.push(`delete ${k.join(" ")}`), store.delete(k)) },
  };
}

type Session = Record<string, string>;
async function sessionOf(deps: Deps, userId: string, origin: string): Promise<Session> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), FIREFOX, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { cookie: `${SESSION_COOKIE}=${made.secret}`, "x-csrf-token": await csrfFor(made.secret), origin, "sec-fetch-site": "same-origin" };
}

// ---- Shared items ----

const itemBody = (file: Uint8Array, more: Json = {}) => ({ kind: "image", content_type: "image/png", bytes: file.length, width: 40, height: 30, title: "Secret stated at creation", ...more });
const create = (deps: Deps, mode: Mode, token: string, body: unknown) => send(deps, "POST", "/api/v1/media", { origin: mode.app, token, headers: JSON_HEADERS, body: JSON.stringify(body) });

/** A media viewer session for `email`, through the real completion on the media address; its Cookie header. */
async function mediaViewerFor(deps: Deps, mode: Mode, email: string): Promise<string> {
  const code = "dpi_" + hex(20);
  await deps.db.run("INSERT INTO media_viewer_code (id, email, path, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [
    "vcm_" + hex(12),
    email,
    "/i/" + "a".repeat(20),
    await hashToken(code),
    deps.now(),
    deps.now() + VIEWER_CODE_MS,
  ]);
  const r = await send(deps, "POST", "/api/v1/media-view/complete", { origin: mode.media, headers: { ...JSON_HEADERS, origin: mode.media, "sec-fetch-site": "same-origin", "user-agent": FIREFOX }, body: JSON.stringify({ code }) });
  expect(r.status, r.text).toBe(200);
  return r.headers.getSetCookie()[0].split(";")[0];
}

const itemRoutes = (link: string) => [`/i/${link}`, `/i/${link}.png`, `/i/${link}/download`, `/i/${link}/preview`];

/** Nothing of the item (its title, a picture's bytes) reaches a visitor without access, on any route of any address role, by its real link or its link_id. */
async function nothingOfItem(deps: Deps, mode: Mode, links: string[], title: string, what: string, cookies: (string | null)[]): Promise<void> {
  for (const origin of new Set([mode.app, mode.tours, mode.media])) {
    for (const link of links) {
      for (const path of itemRoutes(link)) {
        for (const cookie of cookies) {
          const r = await send(deps, "GET", path, { origin, headers: cookie === null ? {} : { cookie } });
          const where = `${what}: ${origin}${path}${cookie === null ? "" : " with a viewer not on the list"}`;
          expect(r.status, where).not.toBe(200);
          expect(r.text.includes(title), `${where}: the title`).toBe(false);
          expect(hasBytes(r.bytes, PNG_SIGNATURE), `${where}: a picture`).toBe(false);
        }
      }
    }
  }
}

describe("a shared item made restricted by its create", () => {
  for (const mode of MODES) {
    it(`is restricted from its first moment: nothing of it reaches anyone without access at any step, its link is the real one, an older build finds nothing (${mode.name})`, SLOW, async () => {
      const { deps } = await makeDeps({ hosts: mode.hosts, siteHost: "tours.example.com" });
      const owner = await seedAccount(deps, { admin: true });
      const file = png(40, 30, 3000, 5);
      const title = "Secret stated at creation";
      const created = await create(deps, mode, owner.token, itemBody(file, { access: "people", viewers: [LISTED, "Second@Example.com", LISTED.toUpperCase()] }));
      expect(created.status, created.text).toBe(201);
      expect(created.json).toEqual({ id: expect.stringMatching(/^med_[0-9a-f]{24}$/), parts: 1, part_bytes: PART_BYTES, access: "people", viewers: 2 });
      expect(created.text).not.toContain("@");
      const id = created.json.id as string;
      const row = (await deps.db.first<{ link_id: string; private_link_id: string | null; access: string }>("SELECT link_id, private_link_id, access FROM media WHERE id = ?", [id]))!;
      expect(row.access).toBe("people");
      expect(row.private_link_id).toMatch(/^[a-z2-7]{20}$/);
      expect(row.link_id).toMatch(/^[a-z2-7]{20}$/);
      expect(row.link_id).not.toBe(row.private_link_id);
      const real = row.private_link_id!;
      expect((await deps.db.all<{ email: string }>("SELECT email FROM media_viewer WHERE media_id = ? ORDER BY email", [id])).map((r) => r.email)).toEqual([LISTED, "second@example.com"]);
      const other = await mediaViewerFor(deps, mode, OTHER);
      const links = [real, row.link_id];
      await nothingOfItem(deps, mode, links, title, "after the create", [null, other]);
      expect((await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { origin: mode.app, token: owner.token, body: file })).status).toBe(204);
      await nothingOfItem(deps, mode, links, title, "after its part", [null, other]);
      expect((await send(deps, "PUT", `/api/v1/media/${id}/preview`, { origin: mode.app, token: owner.token, body: png(16, 12, 300, 6) })).status).toBe(204);
      await nothingOfItem(deps, mode, links, title, "after its preview", [null, other]);
      const done = await send(deps, "POST", `/api/v1/media/${id}/commit`, { origin: mode.app, token: owner.token });
      expect(done.status, done.text).toBe(200);
      // The link handed back is the one that works for an allowed viewer: the real one.
      expect(done.json).toEqual({ id, link_id: real, kind: "image", path: `/i/${real}`, link: `${mode.media}/i/${real}` });
      await nothingOfItem(deps, mode, links, title, "online", [null, other]);
      // Online: the real link answers the gate, the not-shared page, and the bytes to the listed address.
      expect((await send(deps, "GET", `/i/${real}`, { origin: mode.media })).text).toBe(MEDIA_GATE_HTML.image);
      expect((await send(deps, "GET", `/i/${real}`, { origin: mode.media, headers: { cookie: other } })).text).toBe(MEDIA_DENIED_HTML.image);
      const listed = await mediaViewerFor(deps, mode, LISTED);
      const page = await send(deps, "GET", `/i/${real}`, { origin: mode.media, headers: { cookie: listed } });
      expect([page.status, page.text.includes(title)]).toEqual([200, true]);
      expect((await send(deps, "GET", `/i/${real}.png`, { origin: mode.media, headers: { cookie: listed } })).bytes).toEqual(file);
      // An older build looks an online item up by link_id alone: the real link finds nothing,
      // and link_id is a name nothing gave out.
      expect(await deps.db.first("SELECT id FROM media WHERE link_id = ? AND state = 'online'", [real])).toBeNull();
      for (const r of [
        await send(deps, "GET", `/api/v1/media/${id}`, { origin: mode.app, token: owner.token }),
        await send(deps, "GET", "/api/v1/media?kind=image", { origin: mode.app, token: owner.token }),
        await send(deps, "GET", `/api/v1/media/${id}/access`, { origin: mode.app, token: owner.token }),
      ]) {
        expect(r.text).not.toContain(row.link_id);
        // A token gets the setting and how many addresses, never one.
        expect(r.text).not.toContain("@");
      }
      expect((await send(deps, "GET", `/api/v1/media/${id}/access`, { origin: mode.app, token: owner.token })).json).toEqual({ access: "people", viewers_count: 2, limit: 200, can_restrict: true });
    });
  }

  it("`me` lets in the owner alone, from the commit on", SLOW, async () => {
    const { deps } = await makeDeps({ siteHost: "tours.example.com" });
    const owner = await seedAccount(deps, { admin: true });
    const file = png(40, 30, 2000, 3);
    const created = await create(deps, ONE, owner.token, itemBody(file, { access: "me" }));
    expect(created.json).toMatchObject({ access: "me", viewers: 0 });
    const id = created.json.id as string;
    await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token: owner.token, body: file });
    const done = await send(deps, "POST", `/api/v1/media/${id}/commit`, { token: owner.token });
    const listed = await mediaViewerFor(deps, ONE, LISTED);
    expect((await send(deps, "GET", `/i/${done.json.link_id}`, { headers: { cookie: listed } })).text).toBe(MEDIA_DENIED_HTML.image);
    const mine = await mediaViewerFor(deps, ONE, owner.email);
    expect((await send(deps, "GET", `/i/${done.json.link_id}.png`, { headers: { cookie: mine } })).bytes).toEqual(file);
  });

  it("refuses what cannot be restricted, and a bad list, before anything exists: the access API's codes and words", SLOW, async () => {
    // Clips as long as one answer can send, so one may have more parts than a restricted answer can.
    const { deps } = await makeDeps({ siteHost: "tours.example.com", mediaClipMaxBytes: MAX_SERVED_PARTS * PART_BYTES });
    const owner = await seedAccount(deps, { admin: true });
    const file = png(40, 30, 2000, 3);
    const nothing = async (what: string) => {
      expect(await deps.db.first("SELECT (SELECT count(*) FROM media) AS m, (SELECT count(*) FROM media_viewer) AS v, (SELECT count(*) FROM audit WHERE event = 'media_access_changed') AS a"), what).toEqual({ m: 0, v: 0, a: 0 });
    };
    const cases: [unknown, number, Json][] = [
      [itemBody(file, { access: "everyone" }), 400, { error: "bad_access", detail: "access must be one of public, people and me" }],
      [itemBody(file, { viewers: [LISTED] }), 400, { error: "bad_access", detail: "access must be given with viewers: one of public, people and me" }],
      [itemBody(file, { access: "people", viewers: "x@example.com" }), 400, { error: "bad_request", detail: 'the body must be JSON such as {"access": "people", "viewers": ["ana@example.com"]}' }],
      [itemBody(file, { access: "people", viewers: ["ok@example.com", "secret not an address"] }), 400, { error: "bad_viewer", detail: "viewers[1] is not an email address; nothing was changed" }],
      [itemBody(file, { access: "people", viewers: Array.from({ length: 201 }, (_, i) => `v${i}@example.com`) }), 400, { error: "too_many_viewers", detail: "an item's list holds at most 200 addresses; nothing was changed" }],
    ];
    for (const [body, status, answer] of cases) {
      const r = await create(deps, ONE, owner.token, body);
      expect([r.status, r.json], JSON.stringify(body).slice(0, 120)).toEqual([status, answer]);
      expect(r.text).not.toContain("secret");
      await nothing(JSON.stringify(body).slice(0, 80));
    }
    // 201 entries that collapse to one address are one address, as the PUT takes them.
    expect((await create(deps, ONE, owner.token, itemBody(file, { access: "people", viewers: Array.from({ length: 201 }, () => "v@example.com") }))).json).toMatchObject({ access: "people", viewers: 1 });
    await deps.db.run("DELETE FROM audit");
    await deps.db.run("DELETE FROM media_viewer");
    await deps.db.run("DELETE FROM media");

    // Too many parts for one restricted answer: too_large_to_restrict, as the PUT.
    const big = (RESTRICTED_SERVED_PARTS + 1) * PART_BYTES;
    const large = await create(deps, ONE, owner.token, { kind: "clip", content_type: "video/mp4", bytes: big, width: 64, height: 36, duration_ms: 3000, access: "me" });
    expect([large.status, large.json.error]).toEqual([409, "too_large_to_restrict"]);
    expect(large.json.detail).toBe(`a restricted item may have at most ${RESTRICTED_SERVED_PARTS * PART_BYTES} bytes on this site, so this one cannot be restricted; the item stays as it is`);
    await nothing("too large");
    // The largest that may be restricted is taken.
    expect((await create(deps, ONE, owner.token, { kind: "clip", content_type: "video/mp4", bytes: RESTRICTED_SERVED_PARTS * PART_BYTES, width: 64, height: 36, duration_ms: 3000, access: "me" })).status).toBe(201);
    await deps.db.run("DELETE FROM audit");
    await deps.db.run("DELETE FROM media");

    // A site that cannot mail: cannot_restrict, as the PUT words it; public (with a list) is still taken.
    deps.mail = undefined;
    for (const access of ["people", "me"]) {
      const r = await create(deps, ONE, owner.token, itemBody(file, { access, viewers: [LISTED] }));
      expect([r.status, r.json]).toEqual([409, { error: "cannot_restrict", detail: "this site cannot send mail, so nobody could get a link to view a restricted item; the item stays as it is" }]);
      await nothing(`cannot mail, ${access}`);
    }
    expect((await create(deps, ONE, owner.token, itemBody(file, { access: "public", viewers: [LISTED] }))).status).toBe(201);
  });

  it("the fields left out answer exactly as before; public with no addresses makes the very same item; a body over the old size without them is refused as before", SLOW, async () => {
    const { deps } = await makeDeps({ siteHost: "tours.example.com" });
    const owner = await seedAccount(deps, { admin: true });
    const file = png(40, 30, 2000, 3);
    const plain = await create(deps, ONE, owner.token, itemBody(file));
    expect(plain.json).toEqual({ id: plain.json.id, parts: 1, part_bytes: PART_BYTES });
    expect(Object.keys(plain.json)).toEqual(["id", "parts", "part_bytes"]);
    const nulls = await create(deps, ONE, owner.token, itemBody(file, { access: null, viewers: null }));
    expect(Object.keys(nulls.json)).toEqual(["id", "parts", "part_bytes"]);
    const stated = await create(deps, ONE, owner.token, itemBody(file, { access: "public", viewers: [] }));
    expect(stated.json).toEqual({ id: stated.json.id, parts: 1, part_bytes: PART_BYTES, access: "public", viewers: 0 });
    const rows = await deps.db.all<Json>("SELECT access, private_link_id, length(link_id) AS l, state, title FROM media ORDER BY created_at, id");
    expect(rows).toEqual([0, 1, 2].map(() => ({ access: "public", private_link_id: null, l: 20, state: "uploading", title: "Secret stated at creation" })));
    expect(await deps.db.all("SELECT * FROM audit WHERE event = 'media_access_changed'")).toEqual([]);
    expect(await deps.db.all("SELECT * FROM media_viewer")).toEqual([]);
    // Over 4096 bytes without the fields: the very answer of before.
    const padded = await create(deps, ONE, owner.token, itemBody(file, { pad: "x".repeat(5000) }));
    expect([padded.status, padded.json]).toEqual([413, { error: "too_large", detail: "the request is over 4096 bytes" }]);
    const notJson = await send(deps, "POST", "/api/v1/media", { token: owner.token, headers: JSON_HEADERS, body: "x".repeat(5000) });
    expect([notJson.status, notJson.json]).toEqual([413, { error: "too_large", detail: "the request is over 4096 bytes" }]);
    const huge = await send(deps, "POST", "/api/v1/media", { token: owner.token, headers: JSON_HEADERS, body: JSON.stringify(itemBody(file, { access: "people", pad: "x".repeat(80_000) })) });
    expect([huge.status, huge.json]).toEqual([413, { error: "too_large", detail: "the request is over 4096 bytes" }]);
    // With the fields, a full list of the longest addresses is taken.
    const full = await create(deps, ONE, owner.token, itemBody(file, { access: "people", viewers: fullList() }));
    expect([full.status, full.json.viewers]).toEqual([201, 200]);
  });

  it("records the setting as the access API does, marked as stated at creation by a token, with no address in the record or a log line", SLOW, async () => {
    const lines = consoleLines();
    const { deps } = await makeDeps({ siteHost: "tours.example.com" });
    const owner = await seedAccount(deps, { admin: true });
    const file = png(40, 30, 2000, 3);
    const a = (await create(deps, ONE, owner.token, itemBody(file, { access: "people", viewers: ["secret-viewer@example.com", OTHER] }))).json.id;
    const b = (await create(deps, ONE, owner.token, itemBody(file, { access: "me" }))).json.id;
    const c = (await create(deps, ONE, owner.token, itemBody(file, { access: "public", viewers: [LISTED] }))).json.id;
    const rows = await deps.db.all<{ subject: string; detail: string; user_id: string | null; workspace_id: string }>("SELECT subject, detail, user_id, workspace_id FROM audit WHERE event = 'media_access_changed' ORDER BY at, id");
    expect(rows.map((r) => [r.subject, JSON.parse(r.detail), r.user_id, r.workspace_id])).toEqual([
      [a, { from: "public", to: "people", viewers_before: 0, viewers: 2, by: "token", at: "creation" }, null, owner.workspaceId],
      [b, { from: "public", to: "me", viewers_before: 0, viewers: 0, by: "token", at: "creation" }, null, owner.workspaceId],
      [c, { from: "public", to: "public", viewers_before: 0, viewers: 1, by: "token", at: "creation" }, null, owner.workspaceId],
    ]);
    expect(JSON.stringify(await deps.db.all("SELECT * FROM audit"))).not.toContain("@");
    expect(lines.join("\n")).not.toContain("@");
  });

  it("a full allowance refuses the restricted create as the plain one, with nothing written", SLOW, async () => {
    const { deps } = await makeDeps({ siteHost: "tours.example.com" });
    const owner = await seedAccount(deps, { admin: true });
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = 1000 WHERE id = ?", [owner.workspaceId]);
    const file = png(40, 30, 2000, 3);
    const plain = await create(deps, ONE, owner.token, itemBody(file));
    const restricted = await create(deps, ONE, owner.token, itemBody(file, { access: "people", viewers: [LISTED] }));
    expect(restricted.status).toBe(plain.status);
    expect(restricted.json).toEqual(plain.json);
    expect(await deps.db.first("SELECT (SELECT count(*) FROM media) AS m, (SELECT count(*) FROM media_viewer) AS v, (SELECT count(*) FROM audit WHERE event = 'media_access_changed') AS a")).toEqual({ m: 0, v: 0, a: 0 });
  });

  it("a token still cannot change the setting afterwards: the PUT answers it 401 and the item stays restricted", SLOW, async () => {
    const { deps } = await makeDeps({ siteHost: "tours.example.com" });
    const owner = await seedAccount(deps, { admin: true });
    const id = (await create(deps, ONE, owner.token, itemBody(png(40, 30, 2000, 3), { access: "me" }))).json.id;
    const put = await send(deps, "PUT", `/api/v1/media/${id}/access`, { token: owner.token, headers: JSON_HEADERS, body: JSON.stringify({ access: "public" }) });
    expect(put.status).toBe(401);
    expect(await deps.db.first("SELECT access FROM media WHERE id = ?", [id])).toEqual({ access: "me" });
    // Nor does any field of the item's other requests: a part, the preview or the commit take none.
    expect((await send(deps, "POST", `/api/v1/media/${id}/commit`, { token: owner.token, headers: JSON_HEADERS, body: JSON.stringify({ access: "public" }) })).json.error).toBe("incomplete");
    expect(await deps.db.first("SELECT access FROM media WHERE id = ?", [id])).toEqual({ access: "me" });
  });

  it("a create with the largest list of the longest addresses stays within the call budget", SLOW, async () => {
    const { deps } = await makeDeps({ siteHost: "tours.example.com" });
    const owner = await seedAccount(deps, { admin: true });
    const r = await create(deps, ONE, owner.token, itemBody(png(40, 30, 2000, 3), { access: "people", viewers: fullList() }));
    expect(r.status, r.text).toBe(201);
    expect(r.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(await deps.db.first("SELECT count(*) AS n FROM media_viewer")).toEqual({ n: 200 });
  });
});

// ---- Tours ----

type Site = Awaited<ReturnType<typeof makeDeps>> & { owner: Awaited<ReturnType<typeof seedAccount>>; session: Session };

async function tourSite(config: Parameters<typeof makeDeps>[0] = {}): Promise<Site> {
  const ctx = await makeDeps({ siteHost: "tours.example.com", ...config });
  const owner = await seedAccount(ctx.deps, { admin: true });
  return { ...ctx, owner, session: await sessionOf(ctx.deps, owner.userId, ORIGIN) };
}

async function tourOf(s: Site, steps: number, title = "Secret tour title"): Promise<{ id: string; slug: string }> {
  const t = await uploadTour(s.deps, s.owner.token, manifestOf(Array.from({ length: steps }, (_, i) => 200 + i), title, true), { kind: "new" }, 3);
  const row = await s.deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]);
  return { id: t.tour_id, slug: row!.slug };
}

const publish = (s: Site, id: string, body?: unknown, token = s.owner.token) =>
  send(s.deps, "POST", `/api/v1/tours/${id}/publish`, { token, ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }) });

/** Drives a publish to its end from its first answer, calling `each` after every answer. */
async function finish(s: Site, id: string, first: Call, each: (c: Call) => Promise<void> = async () => {}): Promise<Call[]> {
  const calls = [first];
  await each(first);
  let r = first;
  for (let i = 0; r.status === 202; i++) {
    if (i > 60) throw new Error("publish does not finish");
    r = await publish(s, id, { publish_id: r.json.publish_id });
    calls.push(r);
    await each(r);
  }
  expect(r.status, r.text).toBe(200);
  return calls;
}

const setAccess = (s: Site, id: string, body: unknown) => send(s.deps, "PUT", `/api/v1/tours/${id}/access`, { headers: { ...JSON_HEADERS, ...s.session }, body: JSON.stringify(body) });

/** Everything about the tour's setting a token's request could change. */
async function settingOf(deps: Deps, id: string): Promise<Json> {
  return {
    tour: await deps.db.first("SELECT access, status, published_at FROM tour WHERE id = ?", [id]),
    viewers: await deps.db.all("SELECT email FROM tour_viewer WHERE tour_id = ? ORDER BY email", [id]),
    audit: await deps.db.all("SELECT detail FROM audit WHERE event = 'tour_access_changed' AND subject = ? ORDER BY at, id", [id]),
    jobs: await deps.db.all("SELECT publish_id FROM publish_job WHERE tour_id = ?", [id]),
    pending: await deps.db.all("SELECT image_key FROM public_object WHERE tour_id = ? AND state = 'pending' ORDER BY image_key", [id]),
    snapshot: await deps.db.all("SELECT publish_id FROM snapshot WHERE tour_id = ?", [id]),
  };
}

async function namedKeys(deps: Deps, tourId: string): Promise<string[]> {
  return (await deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ? UNION ALL SELECT image_key FROM public_object WHERE tour_id = ?", [tourId, tourId])).map((r) => r.image_key);
}

/** A tours viewer session for `email`, through the real completion on the tours address. */
async function tourViewerFor(deps: Deps, email: string, origin = ORIGIN): Promise<string> {
  const code = "dpv_" + hex(20);
  await deps.db.run("INSERT INTO viewer_code (id, email, slug, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("vco"), email, UNKNOWN_SLUG, await hashToken(code), deps.now(), deps.now() + VIEWER_CODE_MS]);
  const r = await send(deps, "POST", "/api/v1/view/complete", { origin, headers: { ...JSON_HEADERS, origin, "sec-fetch-site": "same-origin", "user-agent": FIREFOX }, body: JSON.stringify({ code }) });
  expect(r.status, r.text).toBe(200);
  return r.headers.getSetCookie()[0].split(";")[0];
}

/** Nothing of the tour reaches a visitor without access: its page on every address role, every name it has as a public picture, and an older build's page and pictures. */
async function nothingOfTour(s: Site, t: { id: string; slug: string }, title: string, what: string, origins: string[], cookies: (string | null)[]): Promise<void> {
  for (const origin of origins) {
    for (const cookie of cookies) {
      const r = await send(s.deps, "GET", `/t/${t.slug}`, { origin, headers: cookie === null ? {} : { cookie } });
      expect(r.status, `${what}: ${origin} page`).not.toBe(200);
      expect(r.text.includes(title), `${what}: ${origin} page holds the title`).toBe(false);
    }
  }
  for (const k of await namedKeys(s.deps, t.id)) {
    expect(k.startsWith("v/"), `${what}: ${k} is not a private key`).toBe(true);
    const r = await send(s.deps, "GET", `/p/${k.slice(2)}`);
    expect(r.status, `${what}: /p/ for ${k}`).toBe(404);
    expect(await oldPicture(s.deps, k), `${what}: an older build's picture route, ${k}`).toBe(false);
    for (const origin of origins) expect((await send(s.deps, "GET", `/t/${t.slug}/${k}`, { origin })).status, `${what}: ${origin} restricted picture without access`).not.toBe(200);
  }
  expect(await oldPage(s.deps, t.slug), `${what}: an older build's page`).toBeNull();
  expect(await s.publicKeys(), `${what}: the public store`).toEqual([]);
}

describe("a tour made restricted by its first publish", () => {
  for (const mode of [MODES[0], MODES[2]]) {
    it(`is never served to anyone without access, from the first call to the last, and never touches the public store (${mode.name})`, SLOW, async () => {
      const s = await tourSite({ hosts: mode.hosts });
      const t = await tourOf(s, COPY_BATCH + 3);
      const title = "Secret tour title";
      const spy = counting(s.deps.pub);
      s.deps.pub = spy.store;
      const other = await tourViewerFor(s.deps, OTHER, mode.tours);
      const origins = [...new Set([mode.app, mode.tours, mode.media])];
      const first = await send(s.deps, "POST", `/api/v1/tours/${t.id}/publish`, { origin: mode.app, token: s.owner.token, headers: JSON_HEADERS, body: JSON.stringify({ access: "people", viewers: [LISTED, " Second@Example.com"] }) });
      expect(first.status, first.text).toBe(202);
      expect(first.json).toMatchObject({ status: "in_progress", access: "people", viewers: 2 });
      const calls = await finish(s, t.id, first, async (c) => {
        expect(c.text).not.toContain("@");
        expect(c.json.access).toBe("people");
        await nothingOfTour(s, t, title, `after an answer ${c.status}`, origins, [null, other]);
      });
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.at(-1)!.json).toEqual({ slug: t.slug, url: `/t/${t.slug}`, steps: COPY_BATCH + 3, access: "people", viewers: 2 });
      expect(spy.calls).toEqual([]);
      // Published restricted: the gate without a viewer, the tour to a listed address, at the very url handed back.
      expect((await send(s.deps, "GET", `/t/${t.slug}`, { origin: mode.tours })).text).toBe(VIEW_GATE_HTML);
      const listed = await tourViewerFor(s.deps, "second@example.com", mode.tours);
      const page = await send(s.deps, "GET", `/t/${t.slug}`, { origin: mode.tours, headers: { cookie: listed } });
      expect([page.status, page.text.includes(title)]).toEqual([200, true]);
      // Where an older build looks there is the stub, and its text where no older build looks.
      expect(await s.deps.db.first("SELECT data, private_data IS NOT NULL AS p FROM snapshot WHERE tour_id = ?", [t.id])).toEqual({ data: RESTRICTED_STUB, p: 1 });
      expect((await settingOf(s.deps, t.id)).viewers).toEqual([{ email: LISTED }, { email: "second@example.com" }]);
      // A token reads the count, never the list.
      expect((await send(s.deps, "GET", `/api/v1/tours/${t.id}/access`, { token: s.owner.token })).json).toEqual({ access: "people", viewers_count: 2, limit: 200, can_restrict: true, switching: null });
    });
  }

  it("`me`, on a tour of one picture published in one call, and the audit record says it was stated at creation by a token, with no address anywhere", SLOW, async () => {
    const lines = consoleLines();
    const s = await tourSite();
    const t = await tourOf(s, 1);
    const r = await publish(s, t.id, { access: "me", viewers: ["secret-viewer@example.com"] });
    expect([r.status, r.json]).toEqual([200, { slug: t.slug, url: `/t/${t.slug}`, steps: 1, access: "me", viewers: 1 }]);
    await nothingOfTour(s, t, "Secret tour title", "published", [ORIGIN], [null, await tourViewerFor(s.deps, "secret-viewer@example.com")]);
    const mine = await tourViewerFor(s.deps, s.owner.email);
    expect((await send(s.deps, "GET", `/t/${t.slug}`, { headers: { cookie: mine } })).status).toBe(200);
    const rows = await s.deps.db.all<{ detail: string; user_id: string | null }>("SELECT detail, user_id FROM audit WHERE event = 'tour_access_changed' AND subject = ?", [t.id]);
    expect(rows.map((x) => [JSON.parse(x.detail), x.user_id])).toEqual([[{ from: "public", to: "me", viewers_before: 0, viewers: 1, by: "token", at: "creation" }, null]]);
    expect(JSON.stringify(await s.deps.db.all("SELECT * FROM audit"))).not.toContain("@");
    expect(lines.join("\n")).not.toContain("@");
  });

  it("refuses what cannot be applied before anything changes: a site that cannot mail, a bad list, the fields with a publish_id", SLOW, async () => {
    const s = await tourSite();
    const t = await tourOf(s, 2);
    const before = await settingOf(s.deps, t.id);
    const cases: [unknown, number, Json][] = [
      [{ access: "everyone" }, 400, { error: "bad_access", detail: "access must be one of public, people and me" }],
      [{ viewers: [LISTED] }, 400, { error: "bad_access", detail: "access must be given with viewers: one of public, people and me" }],
      [{ access: "people", viewers: ["ok@example.com", "secret@"] }, 400, { error: "bad_viewer", detail: "viewers[1] is not an email address; nothing was changed" }],
      [{ access: "people", viewers: Array.from({ length: 201 }, (_, i) => `v${i}@example.com`) }, 400, { error: "too_many_viewers", detail: "a tour's list holds at most 200 addresses; nothing was changed" }],
      [{ access: "me", publish_id: "pub_" + "0".repeat(24) }, 400, { error: "bad_request", detail: "access and viewers go on the call that starts a tour's first publish only, never with publish_id" }],
    ];
    for (const [body, status, answer] of cases) {
      const r = await publish(s, t.id, body);
      expect([r.status, r.json], JSON.stringify(body).slice(0, 100)).toEqual([status, answer]);
      expect(r.text).not.toContain("secret");
      expect(await settingOf(s.deps, t.id)).toEqual(before);
    }
    const mailer = s.deps.mail;
    s.deps.mail = undefined;
    for (const access of ["people", "me"]) {
      const r = await publish(s, t.id, { access, viewers: [LISTED] });
      expect([r.status, r.json]).toEqual([409, { error: "cannot_restrict", detail: "this site cannot send mail, so nobody could get a link to view a restricted tour; the tour stays as it is" }]);
      expect(await settingOf(s.deps, t.id)).toEqual(before);
    }
    s.deps.mail = mailer;
    expect(await s.publicKeys()).toEqual([]);
  });

  it("a failure of the batch that records the publish leaves the setting as it was: the two are written together or not at all", SLOW, async () => {
    const s = await tourSite();
    const t = await tourOf(s, 2);
    const before = await settingOf(s.deps, t.id);
    const real = s.deps.db.batch.bind(s.deps.db);
    s.deps.db.batch = async (stmts) => {
      if (stmts.some((x) => x.sql.includes("INSERT INTO publish_job"))) throw new Error("injected failure");
      return real(stmts);
    };
    const r = await publish(s, t.id, { access: "people", viewers: [LISTED] });
    expect(r.status).toBe(500);
    s.deps.db.batch = real;
    expect(await settingOf(s.deps, t.id)).toEqual(before);
    expect(await s.publicKeys()).toEqual([]);
    // And sent again, it applies.
    await finish(s, t.id, await publish(s, t.id, { access: "people", viewers: [LISTED] }));
    expect((await settingOf(s.deps, t.id)).tour).toMatchObject({ access: "people", status: "published" });
  });
});

describe("a token never changes the setting of a tour that exists", () => {
  it("a tour published before, now or unpublished since, refuses the fields (public too) and changes nothing; without them it publishes as before", SLOW, async () => {
    const s = await tourSite();
    const t = await tourOf(s, 2);
    await finish(s, t.id, await publish(s, t.id));
    const refused = { error: "already_published", detail: "this tour has been published before, so who may view it can be changed in the dashboard only; publish without access and viewers to publish it as it is set" };
    const check = async (what: string) => {
      const before = await settingOf(s.deps, t.id);
      const keys = await s.publicKeys();
      for (const body of [{ access: "me" }, { access: "people", viewers: [LISTED] }, { access: "public" }, { access: "public", viewers: [] }]) {
        const r = await publish(s, t.id, body);
        expect([r.status, r.json], `${what}: ${JSON.stringify(body)}`).toEqual([409, refused]);
        expect(await settingOf(s.deps, t.id), `${what}: ${JSON.stringify(body)}`).toEqual(before);
        expect(await s.publicKeys(), what).toEqual(keys);
      }
    };
    await check("published");
    expect((await send(s.deps, "POST", `/api/v1/tours/${t.id}/unpublish`, { token: s.owner.token })).status).toBe(204);
    await check("unpublished since");
    // The tour list still says it is a draft, with no publish time, as before.
    const listed = (await send(s.deps, "GET", "/api/v1/tours", { token: s.owner.token })).json.tours.find((x: Json) => x.id === t.id);
    expect([listed.status, listed.published_at, listed.url]).toEqual(["draft", null, null]);
    // Without the fields, the publish is today's.
    const again = await finish(s, t.id, await publish(s, t.id));
    expect(again.at(-1)!.json).toEqual({ slug: t.slug, url: `/t/${t.slug}`, steps: 2, access: "public", viewers: 0 });
    // A publish in progress counts too, once it has gone live in between.
    const u = await tourOf(s, COPY_BATCH + 3);
    const started = await publish(s, u.id);
    await finish(s, u.id, started);
    expect((await publish(s, u.id, { access: "me" })).json.error).toBe("already_published");
  });

  it("a tour whose setting or list was set in the dashboard refuses a different one, takes the very same, and the PUT stays session-only", SLOW, async () => {
    const s = await tourSite();
    const t = await tourOf(s, 2);
    expect((await setAccess(s, t.id, { access: "me" })).status).toBe(200);
    const before = await settingOf(s.deps, t.id);
    const refused = { error: "access_already_set", detail: "who may view this tour was already set in the dashboard; publish without access and viewers to publish it as it is set, or change it in the dashboard" };
    for (const body of [{ access: "public" }, { access: "people" }, { access: "me", viewers: [LISTED] }]) {
      const r = await publish(s, t.id, body);
      expect([r.status, r.json], JSON.stringify(body)).toEqual([409, refused]);
      expect(await settingOf(s.deps, t.id)).toEqual(before);
    }
    // A public tour with a list the dashboard kept is set too.
    const u = await tourOf(s, 1);
    await setAccess(s, u.id, { access: "people", viewers: [LISTED] });
    await setAccess(s, u.id, { access: "public" });
    expect((await publish(s, u.id, { access: "public", viewers: [] })).json).toEqual(refused);
    expect((await publish(s, u.id, { access: "me" })).json).toEqual(refused);
    // The very setting it has: the publish of today, no audit row.
    const same = await finish(s, t.id, await publish(s, t.id, { access: "me" }));
    expect(same.at(-1)!.json).toMatchObject({ access: "me", viewers: 0 });
    expect((await settingOf(s.deps, t.id)).audit).toEqual(before.audit);
    // A token's PUT is the one 401, as before.
    const put = await send(s.deps, "PUT", `/api/v1/tours/${u.id}/access`, { token: s.owner.token, headers: JSON_HEADERS, body: JSON.stringify({ access: "me" }) });
    expect(put.status).toBe(401);
  });

  it("the call sent again after a lost answer takes the setting it already has and continues the same publish", SLOW, async () => {
    const s = await tourSite();
    const t = await tourOf(s, 2 * COPY_BATCH + 3);
    const first = await publish(s, t.id, { access: "people", viewers: [LISTED] });
    expect(first.status).toBe(202);
    const again = await publish(s, t.id, { access: "people", viewers: [LISTED] });
    expect([again.status, again.json.publish_id, again.json.access]).toEqual([202, first.json.publish_id, "people"]);
    await finish(s, t.id, again);
    expect((await settingOf(s.deps, t.id)).audit.length).toBe(1);
    expect(await s.publicKeys()).toEqual([]);
  });

  it("a publish of the public store in progress is cancelled by a first publish made restricted, and leaves nothing in the public store", SLOW, async () => {
    const s = await tourSite();
    const t = await tourOf(s, COPY_BATCH + 3);
    const old = await publish(s, t.id);
    expect(old.status).toBe(202);
    expect((await s.publicKeys()).length).toBeGreaterThan(0);
    const first = await publish(s, t.id, { access: "me" });
    expect(first.status).toBe(202);
    expect(first.json.publish_id).not.toBe(old.json.publish_id);
    expect(await s.publicKeys()).toEqual([]);
    const stale = await publish(s, t.id, { publish_id: old.json.publish_id });
    expect([stale.status, stale.json.error]).toEqual([409, "publish_cancelled"]);
    await finish(s, t.id, first, async () => expect(await s.publicKeys()).toEqual([]));
    expect((await namedKeys(s.deps, t.id)).every((k) => k.startsWith("v/"))).toBe(true);
  });

  it("public stated with no addresses equals leaving the fields out; a body over the old size without them is refused as before", SLOW, async () => {
    const s = await tourSite();
    const a = await tourOf(s, 1);
    const b = await tourOf(s, 1);
    const plain = await publish(s, a.id);
    const stated = await publish(s, b.id, { access: "public", viewers: [] });
    expect(stated.json).toEqual({ ...plain.json, slug: b.slug, url: `/t/${b.slug}` });
    expect(Object.keys(stated.json)).toEqual(Object.keys(plain.json));
    expect((await settingOf(s.deps, b.id)).audit).toEqual([]);
    expect((await send(s.deps, "GET", `/t/${b.slug}`)).status).toBe(200);
    // Public with a list stores the list, as the PUT does, and serves it publicly.
    const c = await tourOf(s, 1);
    expect((await publish(s, c.id, { access: "public", viewers: [LISTED] })).json).toMatchObject({ access: "public", viewers: 1 });
    expect((await send(s.deps, "GET", `/t/${c.slug}`)).status).toBe(200);
    const d = await tourOf(s, 1);
    const padded = await publish(s, d.id, { pad: "x".repeat(2000) });
    expect([padded.status, padded.json]).toEqual([413, { error: "too_large", detail: "the request is over 1024 bytes" }]);
    const notJson = await send(s.deps, "POST", `/api/v1/tours/${d.id}/publish`, { token: s.owner.token, headers: JSON_HEADERS, body: "x".repeat(2000) });
    expect([notJson.status, notJson.json]).toEqual([413, { error: "too_large", detail: "the request is over 1024 bytes" }]);
    expect((await settingOf(s.deps, d.id)).tour).toMatchObject({ access: "public", status: "draft" });
  });

  it("another workspace's token reaches nothing through the fields: the one 404, and nothing of the tour changes", SLOW, async () => {
    const s = await tourSite();
    const intruder = await seedAccount(s.deps);
    const t = await tourOf(s, 2);
    const before = await settingOf(s.deps, t.id);
    const none = await publish(s, "tour_" + "0".repeat(24), { access: "me" }, intruder.token);
    for (const body of [{ access: "people", viewers: ["intruder@example.com"] }, { access: "me" }, { access: "public" }]) {
      const r = await publish(s, t.id, body, intruder.token);
      expect([r.status, r.text]).toEqual([404, none.text]);
    }
    expect(await settingOf(s.deps, t.id)).toEqual(before);
  });

  it("a first publish of a tour of 60 steps with the largest list of the longest addresses stays within the call budget", SLOW, async () => {
    const s = await tourSite();
    const t = await tourOf(s, 60);
    const calls = await finish(s, t.id, await publish(s, t.id, { access: "people", viewers: fullList() }));
    expect(Math.max(...calls.map((c) => c.calls))).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect((await settingOf(s.deps, t.id)).viewers.length).toBe(200);
    expect(await s.publicKeys()).toEqual([]);
  });
});
