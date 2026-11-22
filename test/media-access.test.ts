// Who may view a shared item (src/media-access.ts), on both targets: the access API and its
// refusals, serving a restricted item's page, file, download and preview only past the viewer
// check (src/media-page.ts), the media viewer scope (src/viewers.ts: its own cookie and tables,
// its routes and mail, the limits it shares with the tour gate), the three address modes, an
// account disabled or deleted and an item deleted, the frozen answers of public items, and
// the call budget of the new routes. No mail leaves: the mailer is the fake one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { hashToken, newId } from "../src/auth.ts";
import { SUBREQUEST_BUDGET } from "../src/budget.ts";
import type { Hosts } from "../src/hosts.ts";
import { MAX_SERVED_PARTS, PART_BYTES, RESTRICTED_EXTRA_CALLS, RESTRICTED_SERVED_PARTS, SERVE_LOOKUP_CALLS } from "../src/limits.ts";
import { RESTRICTED_MAX_BYTES } from "../src/media-access.ts";
import { MEDIA_DENIED_HTML, MEDIA_GATE_HTML, MEDIA_LINK_HTML, MEDIA_SIGNOUT_HTML, MEDIA_VIEW_JS } from "../src/media-view-page.ts";
import { PAGE_BASE_CSS } from "../src/brand-css.ts";
import { SHARE_CSS, SHARE_CSS_PATH } from "../src/media-assets.ts";
import { MEDIA_VIEWER_PAGE_HEADERS, RESTRICTED_FILE_CSP, RESTRICTED_SHARE_PAGE_HEADERS } from "../src/media-page.ts";
import { mediaViewerMail } from "../src/mail.ts";
import type { Deps } from "../src/ports.ts";
import { LIMITS_VIEWER } from "../src/rate.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { VIEW_JS } from "../src/view-page.ts";
import { MEDIA_VIEWER_COOKIE, MEDIA_VIEWER_SAYS, VIEWER_CODE_MS, VIEWER_COOKIE } from "../src/viewers.ts";
import { gif, mp4, png, send, sha256Hex, type Call } from "./bundle.ts";
import { FROZEN_MODES, frozenAnswer, frozenRequests, headersFor, seedFrozen, type FrozenAnswer } from "./items-frozen.ts";
import FROZEN from "./fixtures/public-items-0.1.46.json" with { type: "json" };

const SLOW = { timeout: 900_000 };
const T = "https://tours.example.com";
const A = "https://app.example.com";
const I = "https://img.example.com";
const TWO: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...TWO, img: "img.example.com" };
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const JSON_HEADERS = { "content-type": "application/json" };
const LISTED = "mara@example.com";
const OTHER = "bram@example.com";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Mode = { name: string; hosts: Hosts | null; app: string; tours: string; media: string };
const MODES: Mode[] = [
  { name: "one address", hosts: null, app: T, tours: T, media: T },
  { name: "two addresses", hosts: TWO, app: A, tours: T, media: T },
  { name: "three addresses", hosts: THREE, app: A, tours: T, media: I },
];
const [ONE, , THREE_MODE] = MODES as [Mode, Mode, Mode];

afterEach(() => vi.restoreAllMocks());

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

function hasBytes(haystack: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

type Session = { cookie: string; csrf: string };

async function accountSession(deps: Deps, userId: string): Promise<Session> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), FIREFOX, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** The change of who may view an item, as the dashboard on the app address sends it. */
const setAccess = (deps: Deps, mode: Mode, s: Session, id: string, body: unknown) =>
  send(deps, "PUT", `/api/v1/media/${id}/access`, {
    origin: mode.app,
    headers: { ...JSON_HEADERS, cookie: s.cookie, "x-csrf-token": s.csrf, origin: mode.app, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });

type Item = { id: string; link: string; letter: "i" | "r"; ext: string; file: Uint8Array; title: string };

/** Sends an item through the API, as the desktop app does: create, parts, preview, commit. */
async function shareItem(deps: Deps, mode: Mode, token: string, spec: { kind: "image" | "clip"; type: string; width: number; height: number; title: string; file: Uint8Array; preview?: Uint8Array }): Promise<Item> {
  const created = await send(deps, "POST", "/api/v1/media", {
    origin: mode.app,
    token,
    headers: JSON_HEADERS,
    body: JSON.stringify({ kind: spec.kind, content_type: spec.type, bytes: spec.file.length, width: spec.width, height: spec.height, title: spec.title, ...(spec.kind === "clip" ? { duration_ms: 3000 } : {}) }),
  });
  expect(created.status, created.text).toBe(201);
  const id = created.json.id as string;
  for (let n = 0; n < created.json.parts; n++) {
    const r = await send(deps, "PUT", `/api/v1/media/${id}/parts/${n}`, { origin: mode.app, token, body: spec.file.subarray(n * PART_BYTES, (n + 1) * PART_BYTES) });
    expect(r.status, r.text).toBe(204);
  }
  if (spec.preview) expect((await send(deps, "PUT", `/api/v1/media/${id}/preview`, { origin: mode.app, token, body: spec.preview })).status).toBe(204);
  const done = await send(deps, "POST", `/api/v1/media/${id}/commit`, { origin: mode.app, token });
  expect(done.status, done.text).toBe(200);
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "video/mp4": "mp4" }[spec.type]!;
  return { id, link: done.json.link_id, letter: spec.kind === "image" ? "i" : "r", ext, file: spec.file, title: spec.title };
}

/** A media viewer code stored as the link job stores one. */
async function storedMediaCode(deps: Deps, email: string, path: string): Promise<string> {
  const code = "dpi_" + hex(20);
  await deps.db.run("INSERT INTO media_viewer_code (id, email, path, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", ["vcm_" + hex(12), email, path, await hashToken(code), deps.now(), deps.now() + VIEWER_CODE_MS]);
  return code;
}

/** A tours viewer code, as 0.1.46 stores one. */
async function storedTourCode(deps: Deps, email: string): Promise<string> {
  const code = "dpv_" + hex(20);
  await deps.db.run("INSERT INTO viewer_code (id, email, slug, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("vco"), email, "aaaaaaaaaa", await hashToken(code), deps.now(), deps.now() + VIEWER_CODE_MS]);
  return code;
}

const page = (origin: string) => ({ ...JSON_HEADERS, origin, "sec-fetch-site": "same-origin", "user-agent": FIREFOX });

/** A media viewer session for `email`, through the real completion on the media address; its Cookie header. */
async function mediaViewerFor(deps: Deps, mode: Mode, email: string, path = "/i/" + "a".repeat(20)): Promise<string> {
  const r = await send(deps, "POST", "/api/v1/media-view/complete", { origin: mode.media, headers: page(mode.media), body: JSON.stringify({ code: await storedMediaCode(deps, email, path) }) });
  expect(r.status, r.text).toBe(200);
  const cookie = r.headers.getSetCookie()[0];
  expect(cookie.startsWith(`${MEDIA_VIEWER_COOKIE}=dpk_`)).toBe(true);
  return cookie.split(";")[0];
}

/** A tours viewer session for `email`, through the real completion on the tours address. */
async function tourViewerFor(deps: Deps, mode: Mode, email: string): Promise<string> {
  const r = await send(deps, "POST", "/api/v1/view/complete", { origin: mode.tours, headers: page(mode.tours), body: JSON.stringify({ code: await storedTourCode(deps, email) }) });
  expect(r.status, r.text).toBe(200);
  return r.headers.getSetCookie()[0].split(";")[0];
}

/** Every read of an item's object from the private store, from now on. */
function watchItemReads(deps: Deps): string[] {
  const reads: string[] = [];
  const real = deps.drafts;
  deps.drafts = { put: (k, b, m) => real.put(k, b, m), get: (k) => (k.startsWith("m/") && reads.push(k), real.get(k)), delete: (k) => real.delete(k) };
  return reads;
}

/**
 * A site in `mode`: workspace A (owner, its session) with a restricted image (people, with
 * LISTED), a restricted MP4 clip of two parts (me) and a public GIF, and workspace B with a
 * restricted image of its own (people, with OTHER).
 */
async function site(mode: Mode, more: Parameters<typeof makeDeps>[0] = {}) {
  const made = await makeDeps({ hosts: mode.hosts, siteHost: "tours.example.com", ...more });
  const { deps } = made;
  const owner = await seedAccount(deps, { username: "owner" });
  // The site's admin (signing in needs one): the other workspace's account.
  const second = await seedAccount(deps, { username: "second", admin: true });
  const ownerSession = await accountSession(deps, owner.userId);
  const secondSession = await accountSession(deps, second.userId);
  const image = await shareItem(deps, mode, owner.token, { kind: "image", type: "image/png", width: 40, height: 30, title: "Alpha confidential screenshot", file: png(40, 30, 3000, 5), preview: png(16, 12, 300, 6) });
  const clip = await shareItem(deps, mode, owner.token, { kind: "clip", type: "video/mp4", width: 64, height: 36, title: "Alpha confidential recording", file: mp4(PART_BYTES + 777, 4) });
  const open = await shareItem(deps, mode, owner.token, { kind: "clip", type: "image/gif", width: 32, height: 24, title: "Open clip", file: gif(32, 24, 2000, 7) });
  const theirs = await shareItem(deps, mode, second.token, { kind: "image", type: "image/png", width: 20, height: 20, title: "Bravo confidential screenshot", file: png(20, 20, 1500, 8) });
  for (const [s, id, body] of [
    [ownerSession, image.id, { access: "people", viewers: [LISTED] }],
    [ownerSession, clip.id, { access: "me" }],
    [secondSession, theirs.id, { access: "people", viewers: [OTHER] }],
  ] as const) {
    const r = await setAccess(deps, mode, s, id, body);
    expect(r.status, r.text).toBe(200);
  }
  return { ...made, mode, owner, second, ownerSession, secondSession, image, clip, open, theirs };
}
type Site = Awaited<ReturnType<typeof site>>;

const routesOf = (item: Item) => [`/${item.letter}/${item.link}`, `/${item.letter}/${item.link}.${item.ext}`, `/${item.letter}/${item.link}/download`, `/${item.letter}/${item.link}/preview`];

/** Asserts that nothing of the item reaches the answer: no title, no bytes, no ETag, no cookie. */
function expectNothingOf(s: Site, r: Call, what: string): void {
  const headers = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  for (const n of [s.image.title, s.clip.title, s.theirs.title]) {
    expect(r.text.includes(n), `${what}: the body holds ${n}`).toBe(false);
    expect(headers.includes(n), `${what}: a header holds ${n}`).toBe(false);
  }
  expect(hasBytes(r.bytes, PNG_SIGNATURE), `${what}: a picture`).toBe(false);
  expect(r.headers.get("etag"), `${what}: an ETag`).toBeNull();
  expect(r.headers.get("set-cookie"), `${what}: a cookie`).toBeNull();
  expect(r.headers.get("cross-origin-resource-policy"), `${what}: CORP`).toBe("same-origin");
}

describe("the access API of an item", () => {
  it("a token reads the setting and how many addresses; a session reads the list; only a session changes it, with the anti-forgery header", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    const byToken = await send(deps, "GET", `/api/v1/media/${s.image.id}/access`, { origin: mode.app, token: s.owner.token });
    expect(byToken.status).toBe(200);
    expect(byToken.json).toEqual({ access: "people", viewers_count: 1, limit: 200, can_restrict: true });
    const bySession = await send(deps, "GET", `/api/v1/media/${s.image.id}/access`, { origin: mode.app, headers: { cookie: s.ownerSession.cookie } });
    expect(bySession.json).toEqual({ access: "people", viewers: [LISTED], limit: 200, can_restrict: true });
    // The tours address does not take the session; the PUT answers on the app address only.
    expect((await send(deps, "GET", `/api/v1/media/${s.image.id}/access`, { origin: mode.tours, token: s.owner.token })).status).toBe(200);
    const put = (opts: Parameters<typeof send>[3]) => send(deps, "PUT", `/api/v1/media/${s.image.id}/access`, { body: JSON.stringify({ access: "public" }), ...opts });
    expect((await put({ origin: mode.app, token: s.owner.token, headers: JSON_HEADERS })).status).toBe(401);
    expect((await put({ origin: mode.app, headers: { ...JSON_HEADERS, cookie: s.ownerSession.cookie, origin: mode.app, "sec-fetch-site": "same-origin" } })).json.error).toBe("bad_csrf");
    expect((await put({ origin: mode.app, headers: { ...JSON_HEADERS, cookie: s.ownerSession.cookie, "x-csrf-token": s.ownerSession.csrf, origin: "https://evil.example", "sec-fetch-site": "cross-site" } })).json.error).toBe("bad_origin");
    expect((await put({ origin: mode.tours, headers: { ...JSON_HEADERS, cookie: s.ownerSession.cookie, "x-csrf-token": s.ownerSession.csrf, origin: mode.tours, "sec-fetch-site": "same-origin" } })).status).toBe(404);
    // Still restricted after every refusal.
    expect((await send(deps, "GET", `/api/v1/media/${s.image.id}/access`, { origin: mode.app, token: s.owner.token })).json.access).toBe("people");
    // Another workspace's item, an unknown one and a malformed id: the one 404.
    for (const id of [s.theirs.id, newId("med"), "med_nope"]) {
      expect((await send(deps, "GET", `/api/v1/media/${id}/access`, { origin: mode.app, token: s.owner.token })).json).toEqual({ error: "not_found", detail: "no such item" });
      expect((await setAccess(deps, mode, s.ownerSession, id, { access: "public" })).json).toEqual({ error: "not_found", detail: "no such item" });
    }
  });

  it("refuses a bad body by position, never echoing an address, and changes nothing", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    const cases: [unknown, number, string][] = [
      [[], 400, "bad_request"],
      [{ access: "everyone" }, 400, "bad_access"],
      [{ access: "people", viewers: "x@example.com" }, 400, "bad_request"],
      [{ access: "people", viewers: ["ok@example.com", "not an address"] }, 400, "bad_viewer"],
      [{ access: "people", viewers: Array.from({ length: 201 }, (_, i) => `v${i}@example.com`) }, 400, "too_many_viewers"],
    ];
    for (const [body, status, error] of cases) {
      const r = await setAccess(deps, mode, s.ownerSession, s.image.id, body);
      expect([r.status, r.json.error], JSON.stringify(body).slice(0, 60)).toEqual([status, error]);
      expect(r.text).not.toContain("not an address");
    }
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "people", viewers: Array.from({ length: 201 }, () => "v@example.com") })).status).toBe(200);
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "people", viewers: ["ok@example.com", "not an address"] })).json.detail).toBe("viewers[1] is not an email address; nothing was changed");
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "people", viewers: Array.from({ length: 201 }, (_, i) => `v${i}@example.com`) })).json.detail).toBe("an item's list holds at most 200 addresses; nothing was changed");
  });

  it("keeps the real link apart while restricted: link_id holds a name nothing gives out, every answer the real link, and public puts it back", SLOW, async () => {
    const s = await site(MODES[2]);
    const { deps, mode } = s;
    const row = await deps.db.first<{ link_id: string; private_link_id: string | null }>("SELECT link_id, private_link_id FROM media WHERE id = ?", [s.image.id]);
    expect(row!.private_link_id).toBe(s.image.link);
    expect(row!.link_id).not.toBe(s.image.link);
    expect(row!.link_id).toMatch(/^[a-z2-7]{20}$/);
    const decoy = row!.link_id;
    for (const r of [
      await send(deps, "GET", `/api/v1/media/${s.image.id}`, { origin: mode.app, token: s.owner.token }),
      await send(deps, "GET", "/api/v1/media?kind=image", { origin: mode.app, token: s.owner.token }),
      await send(deps, "POST", `/api/v1/media/${s.image.id}/commit`, { origin: mode.app, token: s.owner.token }),
    ]) {
      expect(r.text).toContain(s.image.link);
      expect(r.text).not.toContain(decoy);
    }
    // The list and the item answer the setting and the size of the list.
    const list = await send(deps, "GET", "/api/v1/media?kind=image", { origin: mode.app, token: s.owner.token });
    expect(list.json.items.find((x: { id: string }) => x.id === s.image.id)).toMatchObject({ access: "people", viewers: 1, link_id: s.image.link, link: `${I}/i/${s.image.link}` });
    const clips = await send(deps, "GET", "/api/v1/media?kind=clip", { origin: mode.app, token: s.owner.token });
    expect(clips.json.items.map((x: { access: string; viewers: number }) => [x.access, x.viewers]).sort()).toEqual([["me", 0], ["public", 0]]);
    // The name in link_id serves nothing on any route.
    for (const path of routesOf({ ...s.image, link: decoy })) expect((await send(deps, "GET", path, { origin: mode.media })).status, path).toBe(404);
    // Public again: the link back where it was, served as before.
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "public" })).json).toEqual({ access: "public", viewers: [LISTED], limit: 200, can_restrict: true });
    expect(await deps.db.first("SELECT link_id, private_link_id FROM media WHERE id = ?", [s.image.id])).toEqual({ link_id: s.image.link, private_link_id: null });
    expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media })).status).toBe(200);
    expect((await send(deps, "GET", `/i/${decoy}`, { origin: mode.media })).status).toBe(404);
  });

  it("records each change with the two settings and the list's sizes, never an address", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "me", viewers: [LISTED, OTHER] });
    const rows = await deps.db.all<{ detail: string; subject: string; workspace_id: string }>("SELECT detail, subject, workspace_id FROM audit WHERE event = 'media_access_changed' AND subject = ? ORDER BY at, id", [s.image.id]);
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([
      { from: "public", to: "people", viewers_before: 0, viewers: 1, by: "session" },
      { from: "people", to: "me", viewers_before: 1, viewers: 2, by: "session" },
    ]);
    for (const r of await deps.db.all<{ detail: string }>("SELECT detail FROM audit")) expect(r.detail ?? "").not.toMatch(/@/);
  });

  it("cannot restrict on a site that cannot mail, keeps a restricted item restricted, and moves between people and me", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    const mailer = deps.mail;
    deps.mail = undefined;
    expect((await send(deps, "GET", `/api/v1/media/${s.open.id}/access`, { origin: mode.app, token: s.owner.token })).json.can_restrict).toBe(false);
    const refused = await setAccess(deps, mode, s.ownerSession, s.open.id, { access: "people", viewers: [LISTED] });
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "cannot_restrict", detail: "this site cannot send mail, so nobody could get a link to view a restricted item; the item stays as it is" });
    expect(await deps.db.first("SELECT access FROM media WHERE id = ?", [s.open.id])).toEqual({ access: "public" });
    expect(await deps.db.first("SELECT count(*) AS n FROM media_viewer WHERE media_id = ?", [s.open.id])).toEqual({ n: 0 });
    // Between the two restricted settings, and a list change, nothing is loosened.
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "me", viewers: [OTHER] })).status).toBe(200);
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "people" })).json).toEqual({ access: "people", viewers: [OTHER], limit: 200, can_restrict: false });
    // And making it public is always allowed.
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "public" })).status).toBe(200);
    deps.mail = mailer;
  });

  it("refuses to restrict an item larger than one restricted answer can send", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    expect(RESTRICTED_MAX_BYTES).toBe(RESTRICTED_SERVED_PARTS * PART_BYTES);
    expect(SERVE_LOOKUP_CALLS + RESTRICTED_EXTRA_CALLS + RESTRICTED_SERVED_PARTS).toBe(SUBREQUEST_BUDGET);
    expect(RESTRICTED_SERVED_PARTS).toBeLessThan(MAX_SERVED_PARTS);
    await deps.db.run("UPDATE media SET parts = ? WHERE id = ?", [RESTRICTED_SERVED_PARTS + 1, s.open.id]);
    const r = await setAccess(deps, mode, s.ownerSession, s.open.id, { access: "people" });
    expect([r.status, r.json.error]).toEqual([409, "too_large_to_restrict"]);
    expect(await deps.db.first("SELECT access FROM media WHERE id = ?", [s.open.id])).toEqual({ access: "public" });
  });
});

describe("a restricted item, for every visitor and every way of asking", () => {
  it("bytes only to a listed address or the owner's; the gate without a viewer session, the not-shared page for another address, nothing read from the store first", SLOW, async () => {
    const s = await site(MODES[2]);
    const { deps, mode } = s;
    const reads = watchItemReads(deps);
    const listed = await mediaViewerFor(deps, mode, LISTED);
    const other = await mediaViewerFor(deps, mode, OTHER);
    const owner = await mediaViewerFor(deps, mode, s.owner.email);
    for (const path of routesOf(s.image)) {
      const gate = await send(deps, "GET", path, { origin: mode.media });
      expect([gate.status, gate.text], path).toEqual([403, MEDIA_GATE_HTML.image]);
      expect(Object.fromEntries(gate.headers.entries()), path).toEqual({ ...MEDIA_VIEWER_PAGE_HEADERS, "content-type": "text/html; charset=utf-8" });
      expectNothingOf(s, gate, `${path} gate`);
      expect(gate.calls, path).toBe(2);
      const denied = await send(deps, "GET", path, { origin: mode.media, headers: { cookie: other } });
      expect([denied.status, denied.text], path).toEqual([403, MEDIA_DENIED_HTML.image]);
      expectNothingOf(s, denied, `${path} denied`);
      // A cookie of another kind proves nothing here: the tours viewer cookie, the account's.
      for (const cookie of [listed.replace(MEDIA_VIEWER_COOKIE, VIEWER_COOKIE), s.ownerSession.cookie, `${listed}; ${listed}`, `${MEDIA_VIEWER_COOKIE}=dpk_${"0".repeat(64)}`]) {
        expect((await send(deps, "GET", path, { origin: mode.media, headers: { cookie } })).text, path).toBe(MEDIA_GATE_HTML.image);
      }
      // A token beside the viewer cookie: two credentials, neither counts.
      expect((await send(deps, "GET", path, { origin: mode.media, token: s.owner.token, headers: { cookie: listed } })).text).toBe(MEDIA_GATE_HTML.image);
    }
    expect(reads).toEqual([]);
    // The listed address and the owner's get the item.
    for (const cookie of [listed, owner]) {
      const pageAnswer = await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie } });
      expect(pageAnswer.status).toBe(200);
      expect(pageAnswer.text).toContain(s.image.title);
      expect(pageAnswer.text).not.toContain('property="og:');
      expect(pageAnswer.text).toContain(`<link rel="stylesheet" href="/s/shared.css">`);
      expect(pageAnswer.text).toContain(`<a href="/i/${s.image.link}/signout">Not you?</a>`);
      expect(Object.fromEntries(pageAnswer.headers.entries())).toEqual(RESTRICTED_SHARE_PAGE_HEADERS);
      const file = await send(deps, "GET", `/i/${s.image.link}.png`, { origin: mode.media, headers: { cookie } });
      expect(file.status).toBe(200);
      expect(file.bytes).toEqual(s.image.file);
      expect(file.headers.get("cache-control")).toBe("private, no-store");
      expect(file.headers.get("etag")).toBeNull();
      expect(file.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(file.headers.get("x-frame-options")).toBe("DENY");
      expect(file.headers.get("content-security-policy")).toBe(RESTRICTED_FILE_CSP);
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      const download = await send(deps, "GET", `/i/${s.image.link}/download`, { origin: mode.media, headers: { cookie } });
      expect([download.status, download.headers.get("content-disposition")]).toEqual([200, `attachment; filename="${s.image.link}.png"`]);
      const preview = await send(deps, "GET", `/i/${s.image.link}/preview`, { origin: mode.media, headers: { cookie } });
      expect([preview.status, preview.headers.get("cache-control"), preview.headers.get("etag")]).toEqual([200, "private, no-store", null]);
    }
    // The listed address's page says whom it views as; the owner's too.
    expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie: listed } })).text).toContain(`<p class="dp-shared">Shared with you, ${LISTED} · `);
  });

  it("`me` lets in the owner alone; another workspace's viewer list opens nothing here; the checks are fresh on every request", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    const listed = await mediaViewerFor(deps, mode, LISTED);
    const owner = await mediaViewerFor(deps, mode, s.owner.email);
    const other = await mediaViewerFor(deps, mode, OTHER);
    const clipPage = `/r/${s.clip.link}`;
    expect((await send(deps, "GET", clipPage, { origin: mode.media, headers: { cookie: listed } })).text).toBe(MEDIA_DENIED_HTML.clip);
    expect((await send(deps, "GET", clipPage, { origin: mode.media, headers: { cookie: owner } })).status).toBe(200);
    // OTHER is on workspace B's item's list: that opens B's item, and nothing of A's.
    expect((await send(deps, "GET", `/i/${s.theirs.link}`, { origin: mode.media, headers: { cookie: other } })).status).toBe(200);
    expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie: other } })).text).toBe(MEDIA_DENIED_HTML.image);
    // Removing LISTED closes the item at the very next request, file and all.
    expect((await send(deps, "GET", `/i/${s.image.link}.png`, { origin: mode.media, headers: { cookie: listed } })).status).toBe(200);
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "people", viewers: [] })).status).toBe(200);
    expect((await send(deps, "GET", `/i/${s.image.link}.png`, { origin: mode.media, headers: { cookie: listed } })).text).toBe(MEDIA_DENIED_HTML.image);
    // Made public: the same link serves everyone again, as any public item.
    expect((await setAccess(deps, mode, s.ownerSession, s.image.id, { access: "public" })).status).toBe(200);
    const open = await send(deps, "GET", `/i/${s.image.link}.png`, { origin: mode.media });
    expect([open.status, open.headers.get("cache-control"), open.headers.get("etag") !== null]).toEqual([200, "no-cache", true]);
  });

  it("ranges are answered after the check every time; no 304, and If-Range never matches; HEAD reads no part", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    const owner = await mediaViewerFor(deps, mode, s.owner.email);
    const file = `/r/${s.clip.link}.mp4`;
    const size = s.clip.file.length;
    const ranged = await send(deps, "GET", file, { origin: mode.media, headers: { cookie: owner, range: `bytes=${PART_BYTES - 5}-${PART_BYTES + 4}` } });
    expect([ranged.status, ranged.headers.get("content-range")]).toEqual([206, `bytes ${PART_BYTES - 5}-${PART_BYTES + 4}/${size}`]);
    expect(ranged.bytes).toEqual(s.clip.file.subarray(PART_BYTES - 5, PART_BYTES + 5));
    expect(ranged.headers.get("cache-control")).toBe("private, no-store");
    const conditional = await send(deps, "GET", file, { origin: mode.media, headers: { cookie: owner, "if-none-match": "*" } });
    expect(conditional.status).toBe(200);
    const ifRange = await send(deps, "GET", file, { origin: mode.media, headers: { cookie: owner, range: "bytes=0-9", "if-range": '"anything"' } });
    expect([ifRange.status, ifRange.bytes.length]).toEqual([200, size]);
    const unsatisfiable = await send(deps, "GET", file, { origin: mode.media, headers: { cookie: owner, range: `bytes=${size + 10}-` } });
    expect([unsatisfiable.status, unsatisfiable.headers.get("cache-control")]).toEqual([416, "private, no-store"]);
    // Without the session, a range is the gate like anything else.
    expect((await send(deps, "GET", file, { origin: mode.media, headers: { range: "bytes=0-9" } })).text).toBe(MEDIA_GATE_HTML.clip);
    const reads = watchItemReads(deps);
    const head = await send(deps, "HEAD", file, { origin: mode.media, headers: { cookie: owner } });
    expect([head.status, head.bytes.length, head.headers.get("content-length")]).toEqual([200, 0, String(size)]);
    expect(reads).toEqual([]);
  });

  it("answers as an item that does not exist once it is deleted, unfinished, or of a disabled account; disabling closes it at the next request", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    const listed = await mediaViewerFor(deps, mode, LISTED);
    const unknown = await send(deps, "GET", `/i/${"z".repeat(20)}`, { origin: mode.media, headers: { cookie: listed } });
    expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie: listed } })).status).toBe(200);
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [s.owner.userId]);
    for (const path of routesOf(s.image)) {
      const r = await send(deps, "GET", path, { origin: mode.media, headers: { cookie: listed } });
      expect([r.status, r.text], path).toEqual([404, unknown.text]);
    }
    expect((await send(deps, "GET", `/r/${s.clip.link}`, { origin: mode.media })).status).toBe(404);
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [s.owner.userId]);
    expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie: listed } })).status).toBe(200);
    // Deleted: 404 at once, and its list goes with it (no row can block the item's removal).
    expect((await send(deps, "DELETE", `/api/v1/media/${s.image.id}`, { origin: mode.app, token: s.owner.token })).status).toBe(204);
    expect(await deps.db.first("SELECT count(*) AS n FROM media_viewer WHERE media_id = ?", [s.image.id])).toEqual({ n: 0 });
    expect(await deps.db.first("SELECT count(*) AS n FROM media WHERE id = ?", [s.image.id])).toEqual({ n: 0 });
    for (const path of routesOf(s.image)) expect((await send(deps, "GET", path, { origin: mode.media, headers: { cookie: listed } })).text, path).toBe(unknown.text);
  });

  it("deleting the account removes its items and their lists, and leaves the other workspace's", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mode } = s;
    // The site's admin is the other workspace's account.
    const headers = { cookie: s.secondSession.cookie, "x-csrf-token": s.secondSession.csrf, origin: mode.app, "sec-fetch-site": "same-origin" };
    expect((await send(deps, "POST", `/api/v1/admin/accounts/${s.owner.userId}/disable`, { origin: mode.app, headers })).status).toBe(204);
    let r: Call;
    let tries = 0;
    do {
      r = await send(deps, "DELETE", `/api/v1/admin/accounts/${s.owner.userId}`, { origin: mode.app, headers: { ...headers, ...JSON_HEADERS }, body: JSON.stringify({ username: "owner" }) });
      tries++;
    } while (r.status === 202 && tries < 50);
    expect([r.status, r.json], r.text).toEqual([200, { deleted: true }]);
    expect(await deps.db.first("SELECT count(*) AS n FROM media_viewer v JOIN media m ON m.id = v.media_id WHERE m.workspace_id = ?", [s.owner.workspaceId])).toEqual({ n: 0 });
    expect(await deps.db.first("SELECT count(*) AS n FROM media WHERE workspace_id = ?", [s.owner.workspaceId])).toEqual({ n: 0 });
    expect(await deps.db.all("SELECT email FROM media_viewer")).toEqual([{ email: OTHER }]);
  });
});

describe("the media viewer scope", () => {
  for (const mode of MODES) {
    it(`a session made on the tours address never opens an item, and one made for items never opens a tour (${mode.name})`, SLOW, async () => {
      const s = await site(mode);
      const { deps } = s;
      // A restricted tour of the same owner, shared with LISTED.
      const tourViewer = await tourViewerFor(deps, mode, LISTED);
      const mediaViewer = await mediaViewerFor(deps, mode, LISTED);
      // The tours cookie on the media address (in one and two addresses it is the same host, so the browser sends it).
      expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie: tourViewer } })).text).toBe(MEDIA_GATE_HTML.image);
      expect((await send(deps, "GET", "/api/v1/media-view/session", { origin: mode.media, headers: { cookie: tourViewer } })).status).toBe(401);
      // The tours cookie's secret under the media cookie's name, and the other way round: found in neither table.
      const swappedToMedia = `${MEDIA_VIEWER_COOKIE}=${tourViewer.split("=")[1]}`;
      const swappedToTour = `${VIEWER_COOKIE}=${mediaViewer.split("=")[1]}`;
      expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie: swappedToMedia } })).text).toBe(MEDIA_GATE_HTML.image);
      expect((await send(deps, "GET", "/api/v1/view/session", { origin: mode.tours, headers: { cookie: mediaViewer } })).status).toBe(401);
      expect((await send(deps, "GET", "/api/v1/view/session", { origin: mode.tours, headers: { cookie: swappedToTour } })).status).toBe(401);
      // Each proves its address in its own scope only.
      expect((await send(deps, "GET", "/api/v1/view/session", { origin: mode.tours, headers: { cookie: tourViewer } })).json).toEqual({ email: LISTED });
      expect((await send(deps, "GET", "/api/v1/media-view/session", { origin: mode.media, headers: { cookie: mediaViewer } })).json).toEqual({ email: LISTED });
      // Both sent together (one host): each page reads its own, and signing out of one ends only that one.
      const both = `${tourViewer}; ${mediaViewer}`;
      expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie: both } })).status).toBe(200);
      const out = await send(deps, "POST", "/api/v1/media-view/signout", { origin: mode.media, headers: { ...page(mode.media), cookie: both } });
      expect(out.status).toBe(204);
      expect(out.headers.getSetCookie()).toEqual([`${MEDIA_VIEWER_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`]);
      expect((await send(deps, "GET", "/api/v1/view/session", { origin: mode.tours, headers: { cookie: tourViewer } })).json).toEqual({ email: LISTED });
      expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: mode.media, headers: { cookie: mediaViewer } })).text).toBe(MEDIA_GATE_HTML.image);
      // A tours code is no media code, and a media code is no tours code.
      const tourCode = await storedTourCode(deps, LISTED);
      const mediaCode = await storedMediaCode(deps, LISTED, `/i/${s.image.link}`);
      expect((await send(deps, "POST", "/api/v1/media-view/complete", { origin: mode.media, headers: page(mode.media), body: JSON.stringify({ code: tourCode }) })).json).toEqual({ error: "view_link_invalid", detail: MEDIA_VIEWER_SAYS.invalid });
      expect((await send(deps, "POST", "/api/v1/view/complete", { origin: mode.tours, headers: page(mode.tours), body: JSON.stringify({ code: mediaCode }) })).json.error).toBe("view_link_invalid");
      // Where each scope answers: the media routes on the media address only, the tours ones on the tours address only.
      if (mode.hosts !== null) {
        for (const origin of [mode.app, ...(mode.media === mode.tours ? [] : [mode.tours])]) {
          expect((await send(deps, "GET", "/api/v1/media-view/session", { origin, headers: { cookie: mediaViewer } })).status, origin).toBe(404);
          expect((await send(deps, "GET", "/s/view", { origin })).status, origin).toBe(404);
          expect((await send(deps, "GET", `/i/${s.image.link}/signout`, { origin })).status, origin).toBe(404);
        }
        if (mode.media !== mode.tours) expect((await send(deps, "GET", "/api/v1/view/session", { origin: mode.media, headers: { cookie: tourViewer } })).status).toBe(404);
      }
    });
  }

  it("asks for a link with the same answer for everyone, and mails one only to an address the item may be viewed by, about an image or clip, on the media address", SLOW, async () => {
    const s = await site(THREE_MODE);
    const { deps, mail, settle } = s;
    const ask = (email: string, path: string) => send(deps, "POST", "/api/v1/media-view/request", { origin: I, headers: page(I), body: JSON.stringify({ email, path }) });
    const answers: Call[] = [];
    for (const [email, path] of [
      [LISTED, `/i/${s.image.link}`],
      [OTHER, `/i/${s.image.link}`],
      [LISTED, `/r/${s.open.link}`],
      [LISTED, `/r/${s.image.link}`],
      [LISTED, "/i/not-a-link"],
      ["not an address", `/i/${s.image.link}`],
      [s.owner.email, `/r/${s.clip.link}`],
    ]) answers.push(await ask(email, path));
    await settle();
    for (const r of answers) expect([r.status, r.text]).toEqual([202, '{"ok":true}']);
    // The same calls for every request, but the one mail a request that sends one counts after the answer.
    const quiet = answers.filter((_, i) => i !== 0 && i !== 6).map((r) => r.calls);
    expect(new Set(quiet).size).toBe(1);
    expect([answers[0].calls, answers[6].calls]).toEqual([quiet[0] + 1, quiet[0] + 1]);
    expect(mail.sent.map((m) => m.to)).toEqual([LISTED, s.owner.email]);
    const sent = mail.sent[0];
    const link = /https:\/\/img\.example\.com\/s\/view#(dpi_[0-9a-f]{40})/.exec(sent.text);
    expect(link).not.toBeNull();
    expect(sent).toEqual(mediaViewerMail(LISTED, link![0]));
    expect(sent.subject).toBe("Your link to a Mythicshot image or clip");
    // The page the link opens, the check, the completion.
    expect((await send(deps, "GET", "/s/view", { origin: I })).text).toBe(MEDIA_LINK_HTML);
    const code = link![1];
    const check = await send(deps, "POST", "/api/v1/media-view/check", { origin: I, headers: page(I), body: JSON.stringify({ code }) });
    expect(check.json).toEqual({ email: LISTED, path: `/i/${s.image.link}` });
    const done = await send(deps, "POST", "/api/v1/media-view/complete", { origin: I, headers: page(I), body: JSON.stringify({ code }) });
    expect(done.json).toEqual({ path: `/i/${s.image.link}` });
    const cookie = done.headers.getSetCookie()[0];
    expect(cookie).toMatch(new RegExp(`^${MEDIA_VIEWER_COOKIE}=dpk_[0-9a-f]{64}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000$`));
    expect((await send(deps, "POST", "/api/v1/media-view/complete", { origin: I, headers: page(I), body: JSON.stringify({ code }) })).status).toBe(404);
    expect((await send(deps, "GET", `/i/${s.image.link}`, { origin: I, headers: { cookie: cookie.split(";")[0] } })).status).toBe(200);
    // The rows hold digests only.
    const rows = await deps.db.all<{ hash: string }>("SELECT hash FROM media_viewer_session");
    for (const r of rows) expect(cookie).not.toContain(r.hash);
    expect(await deps.db.first("SELECT count(*) AS n FROM viewer_session")).toEqual({ n: 0 });
  });

  it("shares every mail limit with the tour gate: one address gets no more links from the two together than from one", SLOW, async () => {
    const s = await site(MODES[1]);
    const { deps, mail, settle, mode } = s;
    // A restricted, published tour of the owner shared with LISTED is not needed: the address's own limit counts every request.
    const most = LIMITS_VIEWER.linkRecipient.most;
    for (let i = 0; i < most; i++) {
      const r = await send(deps, "POST", "/api/v1/view/request", { origin: mode.tours, headers: page(mode.tours), body: JSON.stringify({ email: LISTED, slug: "aaaaaaaaaa" }) });
      expect(r.status).toBe(202);
    }
    // The tour requests used up the address's quarter hour: the item's request mails nothing.
    expect((await send(deps, "POST", "/api/v1/media-view/request", { origin: mode.media, headers: page(mode.media), body: JSON.stringify({ email: LISTED, path: `/i/${s.image.link}` }) })).status).toBe(202);
    await settle();
    expect(mail.sent).toEqual([]);
    // Without those, it would have.
    await deps.db.run("DELETE FROM rate_counter");
    await send(deps, "POST", "/api/v1/media-view/request", { origin: mode.media, headers: page(mode.media), body: JSON.stringify({ email: LISTED, path: `/i/${s.image.link}` }) });
    await settle();
    expect(mail.sent.map((m) => m.to)).toEqual([LISTED]);
    // The workspace's own cap is one count for both: the item's gate gives the tour gate's key.
    const keys = await deps.db.all<{ bucket: string }>("SELECT DISTINCT bucket FROM rate_counter ORDER BY bucket");
    expect(keys.map((k) => k.bucket)).toEqual(expect.arrayContaining([LIMITS_VIEWER.linkRecipient.bucket, LIMITS_VIEWER.mailWorkspace.bucket, LIMITS_VIEWER.mailSite.bucket]));
  });

  it("serves the pages around a restricted item as fixed text, and its script is the tour script with the media scope's names", async () => {
    const { deps } = await makeDeps({ hosts: THREE });
    for (const [path, body] of [
      ["/s/view", MEDIA_LINK_HTML],
      [`/i/${"a".repeat(20)}/signout`, MEDIA_SIGNOUT_HTML],
      [`/r/${"a".repeat(20)}/signout`, MEDIA_SIGNOUT_HTML],
    ] as const) {
      const r = await send(deps, "GET", path, { origin: I });
      expect([r.status, r.text, r.calls], path).toEqual([200, body, 0]);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    expect((await send(deps, "GET", "/i/nope/signout", { origin: I })).status).toBe(404);
    const js = await send(deps, "GET", "/s/view.js", { origin: I });
    expect(js.text).toBe(MEDIA_VIEW_JS);
    expect(MEDIA_VIEW_JS).not.toContain("/api/v1/view/");
    expect(MEDIA_VIEW_JS).toContain("/api/v1/media-view/request");
    expect(MEDIA_VIEW_JS).toContain("dpi_");
    expect(MEDIA_VIEW_JS.length).toBeGreaterThan(VIEW_JS.length - 200);
    // The proposed sentences of the pages, pinned.
    expect(MEDIA_GATE_HTML.image).toContain("<h1 id=\"h-ask\" tabindex=\"-1\">This image is shared with specific people</h1>");
    expect(MEDIA_GATE_HTML.clip).toContain("Enter your email address. If the clip is shared with you, we send you a link to open it. There is no password.");
    expect(MEDIA_GATE_HTML.image).toContain("Nothing after a few minutes? Look in your spam folder, or check with the person who sent you the image that they used this address.");
    expect(MEDIA_DENIED_HTML.clip).toContain("and this clip is shared with other people. If you were given this link, ask the person who sent it to add your address.");
    expect(MEDIA_LINK_HTML).toContain("This browser will remember your address for images and clips shared with you, for 30 days of use. It gives no access to anything else.");
    expect(MEDIA_LINK_HTML).toContain("A link works once and for 15 minutes. Open the link you were sent for the image or clip again and ask for a new one.");
    expect(MEDIA_SIGNOUT_HTML).toContain("Sign this browser out of images and clips shared with you, then enter your own address on the page you were sent.");
    for (const html of [MEDIA_GATE_HTML.image, MEDIA_DENIED_HTML.image, MEDIA_LINK_HTML, MEDIA_SIGNOUT_HTML]) expect(html).not.toMatch(/\btour\b/);
    expect(mediaViewerMail("x@example.com", "https://img.example.com/s/view#dpi_x").text).toBe(
      "Open this link to view the image or clip that was shared with you:\n\nhttps://img.example.com/s/view#dpi_x\n\nIt works once and for 15 minutes. If you did not ask for it, ignore this mail: nothing happens without the link.\n",
    );
  });
});

describe("public items", () => {
  it("answer the very bytes 0.1.46 answered, with the same calls, also with viewer cookies of either kind or an account's, but for Cache-Control: no-cache on an item's answers", SLOW, async () => {
    const frozen = FROZEN as unknown as { modes: Record<string, FrozenAnswer[]> };
    // The one difference from 0.1.46 (see the test below for why): an item's page, file,
    // download and preview answers that said `public, max-age=60` or `public, max-age=3600`
    // say `no-cache`; every other byte, header and call is 0.1.46's. The pages' stylesheet and
    // script keep their hour, and the 404s and 416s their `no-store`.
    const OLD_VALUES = ["public, max-age=60", "public, max-age=3600"];
    // And 0.1.54's: the pages' policy gained font-src 'self' after style-src (the brand's font is
    // served by the site), and the pages' stylesheet is the brand's, a different text with its own ETag.
    const SHARE_CSS_ETAG = `"${(await sha256Hex(new TextEncoder().encode(SHARE_CSS))).slice(0, 32)}"`;
    // The stylesheet let through is the brand's: it starts with the tokens and the font every page stylesheet starts with.
    expect(SHARE_CSS.startsWith(PAGE_BASE_CSS)).toBe(true);
    const fonted = (old: FrozenAnswer): FrozenAnswer => {
      const page = old.headers.some(([k, v]) => k === "content-security-policy" && v.includes("style-src 'self'; ") && !v.includes("font-src"));
      if (!page) return old;
      return { ...old, headers: old.headers.map(([k, v]) => [k, k === "content-security-policy" ? v.replace("style-src 'self'; ", "style-src 'self'; font-src 'self'; ") : v] as [string, string]) };
    };
    const permitted = (r: { path: string }, old: FrozenAnswer): FrozenAnswer => {
      if (r.path === SHARE_CSS_PATH) return { ...old, body: SHARE_CSS, headers: old.headers.map(([k, v]) => [k, k === "etag" ? SHARE_CSS_ETAG : v] as [string, string]) };
      const cc = old.headers.find(([k]) => k === "cache-control")?.[1];
      if (!/^\/[ir]\//.test(r.path) || cc === undefined || !OLD_VALUES.includes(cc)) return fonted(old);
      return fonted({ ...old, headers: old.headers.map(([k, v]) => [k, k === "cache-control" ? "no-cache" : v] as [string, string]) });
    };
    for (const mode of FROZEN_MODES) {
      const changed = frozenRequests().filter((r, i) => permitted(r, frozen.modes[mode.name][i]) !== frozen.modes[mode.name][i]);
      // 59 answers with the cache rule, and from 0.1.54 the pages' policy (the not-found and other-kind pages too) and the stylesheet.
      expect(changed.length, mode.name).toBe(79);
    }
    for (const mode of FROZEN_MODES) {
      const { deps } = await makeDeps({ hosts: mode.hosts, ...(mode.siteHost ? { siteHost: mode.siteHost } : {}) });
      const owner = await seedAccount(deps, { admin: true });
      await seedFrozen(deps, owner.workspaceId);
      const m: Mode = { name: mode.name, hosts: mode.hosts, app: mode.hosts === null ? mode.origin : A, tours: T, media: mode.origin };
      const mediaViewer = await mediaViewerFor(deps, m, owner.email);
      const tourViewer = await tourViewerFor(deps, m, owner.email);
      const account = await accountSession(deps, owner.userId);
      const want = frozen.modes[mode.name];
      expect(want.length, mode.name).toBe(frozenRequests().length);
      for (const cookie of [null, mediaViewer, `${tourViewer}; ${mediaViewer}; ${account.cookie}`]) {
        const got: FrozenAnswer[] = [];
        for (const [i, r] of frozenRequests().entries()) {
          const headers = { ...headersFor(r, got), ...(cookie === null ? {} : { cookie }) };
          const answer = await frozenAnswer(await send(deps, r.method, r.path, { origin: mode.origin, headers }));
          got.push(answer);
          expect(answer, `${mode.name}: ${r.method} ${r.path} #${i} with ${cookie === null ? "no cookie" : "cookies"}`).toEqual(permitted(r, want[i]));
        }
      }
    }
  });
});

describe("caches and a public item made restricted", () => {
  it("no answer of a public item may be kept by a cache without asking the site: once the item is restricted its link must answer the gate, not a copy", SLOW, async () => {
    // Why public items answer `Cache-Control: no-cache` from 0.1.47: an item's address stays
    // the same when it is restricted, so a shared cache (a CDN, a proxy, a tunnel's edge)
    // holding a public answer under max-age would go on serving the bytes to anyone after the
    // restriction, for up to the hour 0.1.46 allowed. With no-cache every reuse asks the site
    // first; the ETag keeps that cheap while the item is public.
    const s = await site(MODES[2]);
    const { deps, mode } = s;
    // A public image with a preview beside the public GIF (which has none), so the preview is covered too.
    const pic = await shareItem(deps, mode, s.owner.token, { kind: "image", type: "image/png", width: 24, height: 18, title: "Open picture", file: png(24, 18, 1600, 9), preview: png(12, 9, 300, 10) });
    const held = new Map<string, string>();
    for (const [item, paths] of [
      [s.open, routesOf(s.open).filter((p) => !p.endsWith("/preview"))],
      [pic, routesOf(pic)],
    ] as const) {
      for (const path of paths) {
        const r = await send(deps, "GET", path, { origin: mode.media });
        expect([r.status, r.headers.get("cache-control")], path).toEqual([200, "no-cache"]);
        expect(r.headers.get("etag"), path).toMatch(/^"[0-9a-f]{32}"$/);
        // A cache asking again with the ETag it holds gets 304 while the item is public ...
        const fresh = await send(deps, "GET", path, { origin: mode.media, headers: { "if-none-match": r.headers.get("etag")! } });
        expect([fresh.status, fresh.headers.get("cache-control"), fresh.bytes.length], path).toEqual([304, "no-cache", 0]);
        held.set(path, r.headers.get("etag")!);
      }
      // ... and once it is restricted, the gate, never a 304 that would let the copy be reused.
      expect((await setAccess(deps, mode, s.ownerSession, item.id, { access: "me" })).status).toBe(200);
    }
    expect([...held.keys()].filter((p) => p.endsWith("/preview"))).toEqual([`/i/${pic.link}/preview`]);
    for (const [path, etag] of held) {
      const again = await send(deps, "GET", path, { origin: mode.media, headers: { "if-none-match": etag } });
      expect([again.status, again.text], path).toEqual([403, path.startsWith("/i/") ? MEDIA_GATE_HTML.image : MEDIA_GATE_HTML.clip]);
      expect(again.headers.get("cache-control"), path).toBe("no-store");
      expect(again.headers.get("etag"), path).toBeNull();
    }
  });
});

describe("a restricted item tells nobody its file type", () => {
  for (const mode of [MODES[0], MODES[2]]) {
    it(`every extension its route takes answers the same gate without a session, and the same not-shared page with one not on the list, with GET and HEAD (${mode.name})`, SLOW, async () => {
      const s = await site(mode);
      const { deps } = s;
      const other = await mediaViewerFor(deps, mode, OTHER);
      const owner = await mediaViewerFor(deps, mode, s.owner.email);
      // Each route takes all four extensions in its name (the other kind's two included), so each must answer them alike.
      const EXTS = ["png", "jpg", "gif", "mp4"] as const;
      for (const [item, html] of [
        [s.image, { gate: MEDIA_GATE_HTML.image, denied: MEDIA_DENIED_HTML.image }],
        [s.clip, { gate: MEDIA_GATE_HTML.clip, denied: MEDIA_DENIED_HTML.clip }],
      ] as const) {
        for (const method of ["GET", "HEAD"] as const) {
          const seen = new Set<string>();
          for (const ext of EXTS) {
            const path = `/${item.letter}/${item.link}.${ext}`;
            const gate = await send(deps, method, path, { origin: mode.media });
            const denied = await send(deps, method, path, { origin: mode.media, headers: { cookie: other } });
            expect([gate.status, gate.text], `${method} ${path}`).toEqual([403, method === "GET" ? html.gate : ""]);
            expect([denied.status, denied.text], `${method} ${path}`).toEqual([403, method === "GET" ? html.denied : ""]);
            seen.add(JSON.stringify([[...gate.headers.entries()].sort(), [...denied.headers.entries()].sort(), gate.calls, denied.calls]));
          }
          // The four extensions cannot be told apart by any header or by the work done.
          expect(seen.size, `${method} ${item.letter}`).toBe(1);
        }
        // To a viewer who may see it, every other extension is the one 404, the right one the file.
        for (const wrong of EXTS.filter((e) => e !== item.ext)) {
          for (const method of ["GET", "HEAD"] as const) expect((await send(deps, method, `/${item.letter}/${item.link}.${wrong}`, { origin: mode.media, headers: { cookie: owner } })).status, `${method} .${wrong}`).toBe(404);
        }
        expect((await send(deps, "GET", `/${item.letter}/${item.link}.${item.ext}`, { origin: mode.media, headers: { cookie: owner } })).status).toBe(200);
        expect((await send(deps, "HEAD", `/${item.letter}/${item.link}.${item.ext}`, { origin: mode.media, headers: { cookie: owner } })).status).toBe(200);
      }
      // An extension no route takes is the one 404 for everyone, as for any link.
      expect((await send(deps, "GET", `/i/${s.image.link}.webp`, { origin: mode.media })).status).toBe(404);
    });
  }
});

describe("the call budget of the new routes", () => {
  it("a restricted item of the most parts it may have is sent whole within the budget, with the session's daily write", SLOW, async () => {
    const bytes = RESTRICTED_SERVED_PARTS * PART_BYTES;
    const s = await site(ONE, { mediaClipMaxBytes: bytes });
    const { deps, mode } = s;
    const big = await shareItem(deps, mode, s.owner.token, { kind: "clip", type: "video/mp4", width: 64, height: 36, title: "Largest restricted", file: mp4(bytes, 1) });
    expect((await setAccess(deps, mode, s.ownerSession, big.id, { access: "me" })).status).toBe(200);
    const owner = await mediaViewerFor(deps, mode, s.owner.email);
    // A day later, so the session's last use is written after the answer too.
    const now = deps.now;
    deps.now = () => now() + 86_400_000 + 1000;
    const r = await send(deps, "GET", `/r/${big.link}.mp4`, { origin: mode.media, headers: { cookie: owner } });
    expect(r.status).toBe(200);
    expect(r.bytes.length).toBe(bytes);
    expect(r.calls).toBe(SUBREQUEST_BUDGET);
    deps.now = now;
  });

  it("the access PUT with a full list, the media viewer routes and the pages stay in the budget", SLOW, async () => {
    const s = await site(ONE);
    const { deps, mode } = s;
    const full = Array.from({ length: 200 }, (_, i) => `v${i}@example.com`);
    for (const body of [{ access: "people", viewers: full }, { access: "me", viewers: full.slice(100) }, { access: "public", viewers: [] }, { access: "people", viewers: full }]) {
      const r = await setAccess(deps, mode, s.ownerSession, s.open.id, body);
      expect(r.status).toBe(200);
      expect(r.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    }
    const get = await send(deps, "GET", `/api/v1/media/${s.open.id}/access`, { origin: mode.app, headers: { cookie: s.ownerSession.cookie } });
    expect(get.json.viewers).toHaveLength(200);
    const asked = await send(deps, "POST", "/api/v1/media-view/request", { origin: mode.media, headers: page(mode.media), body: JSON.stringify({ email: "v1@example.com", path: `/r/${s.open.link}` }) });
    expect(asked.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    await s.settle();
    const code = /#(dpi_[0-9a-f]{40})/.exec(s.mail.sent.at(-1)!.text)![1];
    for (const path of ["check", "complete"]) {
      const r = await send(deps, "POST", `/api/v1/media-view/${path}`, { origin: mode.media, headers: page(mode.media), body: JSON.stringify({ code }) });
      expect(r.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    }
  });
});
