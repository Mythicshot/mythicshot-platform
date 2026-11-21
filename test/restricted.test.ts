// Serving a restricted tour (src/restricted.ts) on both targets: the page, every picture and
// the logo, for every kind of visitor and every way of asking; the lock-outs on the very next
// request; another workspace's tour; public tours unchanged; the gate src/viewers.ts asks, and
// the viewer link request's answers with that real gate wired; the call counts. Two
// addresses throughout, so the viewer cookie lives on the tours address and the change of who
// may view a tour is made on the app address, as a browser would. No mail is sent: the mailer
// is the fake one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { noDisabledAccount } from "../src/accounts.ts";
import { hashToken, newId } from "../src/auth.ts";
import { createApp } from "../src/app.ts";
import type { Hosts } from "../src/hosts.ts";
import { MalformedSnapshot, notFoundPage, pageTour, renderPage } from "../src/page.ts";
import { ACCOUNT_PAGE_HEADERS } from "../src/pages.ts";
import type { Db, Deps, FileStore } from "../src/ports.ts";
import { COPY_BATCH } from "../src/publish.ts";
import { LIMITS_VIEWER } from "../src/rate.ts";
import { RESTRICTED_GATE, RESTRICTED_PAGE_CSP, RESTRICTED_PAGE_HEADERS, restrictedPageHtml, workspaceKeyOf } from "../src/restricted.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { VIEW_DENIED_HTML, VIEW_GATE_HTML } from "../src/view-page.ts";
import { VIEWER_CODE_MS, VIEWER_COOKIE } from "../src/viewers.ts";
import { send, uploadTour, type Call, type Json } from "./bundle.ts";
import { manifestOf } from "./isolation-world.ts";

const SLOW = { timeout: 900_000 };
const TWO: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const JSON_HEADERS = { "content-type": "application/json" };
const LISTED = "mara@example.com";
const OTHER = "bram@example.com";
const B_LISTED = "cy@example.com";
const UNKNOWN_SLUG = "aaaaaaaaaa";
const MADE_UP = "0".repeat(32) + ".png";
const NOT_FOUND_JSON = '{"error":"not_found"}';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

afterEach(() => vi.restoreAllMocks());

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

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

/** The change of who may view a tour, as the dashboard on the app address sends it. */
const setAccess = (deps: Deps, s: Session, tourId: string, body: unknown) =>
  send(deps, "PUT", `/api/v1/tours/${tourId}/access`, {
    origin: APP,
    headers: { ...JSON_HEADERS, cookie: s.cookie, "x-csrf-token": s.csrf, origin: APP, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });

async function untilDone(deps: Deps, s: Session, tourId: string, body: unknown): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await setAccess(deps, s, tourId, body);
    if (r.status === 200) return;
    expect(r.status, r.text).toBe(202);
  }
  throw new Error("the change does not finish");
}

async function publishAll(deps: Deps, token: string, tourId: string): Promise<void> {
  let r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
  for (let i = 0; r.status === 202; i++) {
    if (i > 60) throw new Error("publish does not finish");
    r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token, headers: JSON_HEADERS, body: JSON.stringify({ publish_id: r.json.publish_id }) });
  }
  expect(r.status, r.text).toBe(200);
}

type Tour = { id: string; slug: string; title: string };

/** A tour of `steps` steps and a logo, uploaded as a draft. */
async function tourOf(deps: Deps, token: string, steps: number, title: string, fill: number): Promise<Tour> {
  const t = await uploadTour(deps, token, manifestOf(Array.from({ length: steps }, (_, i) => 300 + fill * 40 + i), title, true), { kind: "new" }, fill);
  const row = await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]);
  return { id: t.tour_id, slug: row!.slug, title };
}

/** The names of a tour's live pictures after their store prefix (`v/` or `p/`). */
async function liveNames(deps: Deps, tourId: string): Promise<string[]> {
  return (await deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ? ORDER BY image_key", [tourId])).map((r) => r.image_key.slice(2));
}

/** A code stored as the viewer link job stores one. */
async function storedCode(deps: Deps, email: string, slug: string): Promise<string> {
  const code = "dpv_" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
  await deps.db.run("INSERT INTO viewer_code (id, email, slug, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("vco"), email, slug, await hashToken(code), deps.now(), deps.now() + VIEWER_CODE_MS]);
  return code;
}

/** A viewer session for `email`, made through the real completion on the tours address; its Cookie header. */
async function viewerFor(deps: Deps, email: string, slug: string): Promise<string> {
  const r = await send(deps, "POST", "/api/v1/view/complete", {
    origin: TOURS,
    headers: { ...JSON_HEADERS, origin: TOURS, "sec-fetch-site": "same-origin", "user-agent": FIREFOX },
    body: JSON.stringify({ code: await storedCode(deps, email, slug) }),
  });
  expect(r.status, r.text).toBe(200);
  return r.headers.getSetCookie()[0].split(";")[0];
}

/** Every read of a restricted tour's picture from the private store, from now on. */
function watchPrivateReads(deps: Deps): string[] {
  const reads: string[] = [];
  const real = deps.drafts;
  const watched: FileStore = { put: (k, b, m) => real.put(k, b, m), get: (k) => (k.startsWith("v/") && reads.push(k), real.get(k)), delete: (k) => real.delete(k) };
  deps.drafts = watched;
  return reads;
}

/** Records the kind of every database call from now on; with `statements`, each call's SQL too. */
function recordKinds(deps: Deps, statements?: string[]): string[] {
  const kinds: string[] = [];
  const db = deps.db;
  const note = (kind: string, sql: string) => (kinds.push(kind), statements?.push(`${kind} ${sql.replace(/\s+/g, " ").trim()}`));
  const wrapped: Db = {
    all: (sql, params) => (note("all", sql), db.all(sql, params)),
    first: (sql, params) => (note("first", sql), db.first(sql, params)),
    run: (sql, params) => (note("run", sql), db.run(sql, params)),
    batch: (stmts) => (note("batch", stmts.map((x) => x.sql).join("; ")), db.batch(stmts)),
  };
  deps.db = wrapped;
  return kinds;
}

/**
 * The site most tests use: workspace A (its owner, the site's admin) with a restricted tour A
 * (2 steps and a logo, `people` with LISTED) that was public and published first, so its old
 * public names are retired names now, and a public tour P; workspace B with its restricted tour
 * B (1 step and a logo, `people` with B_LISTED).
 */
async function site() {
  const made = await makeDeps({ hosts: TWO });
  const { deps } = made;
  const owner = await seedAccount(deps, { admin: true, username: "owner" });
  const second = await seedAccount(deps, { username: "second" });
  const ownerSession = await accountSession(deps, owner.userId);
  const secondSession = await accountSession(deps, second.userId);
  const a = await tourOf(deps, owner.token, 2, "Alpha confidential walkthrough", 3);
  await publishAll(deps, owner.token, a.id);
  const retired = await liveNames(deps, a.id);
  await untilDone(deps, ownerSession, a.id, { access: "people", viewers: [LISTED] });
  const p = await tourOf(deps, owner.token, 1, "Public walkthrough", 4);
  await publishAll(deps, owner.token, p.id);
  const b = await tourOf(deps, second.token, 1, "Bravo confidential walkthrough", 5);
  await setAccess(deps, secondSession, b.id, { access: "people", viewers: [B_LISTED] });
  await publishAll(deps, second.token, b.id);
  const aNames = await liveNames(deps, a.id);
  const bNames = await liveNames(deps, b.id);
  expect(aNames).toHaveLength(3);
  expect(bNames).toHaveLength(2);
  // What a leak would carry: the tour's title and the texts of its snapshot.
  const snapshot = (await deps.db.first<{ data: string }>("SELECT private_data AS data FROM snapshot WHERE tour_id = ?", [a.id]))!.data;
  const needles = [a.title, "Invoicing in a minute", "See how to send your first invoice.", "Unpaid invoices", "One click away.", "Start here", "That is all it takes."];
  for (const n of needles) expect(snapshot, n).toContain(n);
  return { ...made, owner, second, ownerSession, secondSession, a, p, b, retired, aNames, bNames, needles };
}

type Site = Awaited<ReturnType<typeof site>>;

/** The bytes of a stored picture, read straight from the private store. */
async function storedBytes(deps: Deps, name: string): Promise<Uint8Array> {
  const file = await deps.drafts.get(`v/${name}`);
  return new Uint8Array(await new Response(file!.body).arrayBuffer());
}

/** Asserts that nothing of the tour is in the answer: no title or text in the body or any header, no picture. */
function expectNothingOf(s: Site, r: Call, what: string): void {
  const headers = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  for (const n of [...s.needles, ...s.aNames, ...s.bNames]) {
    expect(r.text.includes(n), `${what}: the body holds ${n}`).toBe(false);
    expect(headers.includes(n), `${what}: a header holds ${n}`).toBe(false);
  }
  expect(hasBytes(r.bytes, PNG_SIGNATURE), `${what}: a picture`).toBe(false);
  expect(r.headers.get("etag"), `${what}: an ETag`).toBeNull();
  expect(r.headers.get("set-cookie"), `${what}: a cookie`).toBeNull();
}

describe("a restricted tour, for every visitor and every way of asking", () => {
  it("bytes of the tour only to a listed address or the owner's; everything else gets the gate, the not-shared page or the one 404, and the store is never read", SLOW, async () => {
    const s = await site();
    const { deps, a, b } = s;
    const listed = await viewerFor(deps, LISTED, a.slug);
    const unlisted = await viewerFor(deps, OTHER, a.slug);
    const ownerViewer = await viewerFor(deps, s.owner.email, a.slug);
    const expired = await viewerFor(deps, LISTED, a.slug);
    await deps.db.run("UPDATE viewer_session SET expires_at = ? WHERE hash = ?", [deps.now() - 1, await hashToken(expired.split("=")[1])]);
    const account = await accountSession(deps, s.owner.userId);
    // `calls`: what the page costs: the public lookup and the tour, then the session's read
    // only for one well-formed viewer cookie and no token, then mayView only for a live session.
    const credentials: { who: string; headers: Record<string, string>; token?: string; as?: string; denied?: true; calls: number }[] = [
      { who: "no cookie", headers: {}, calls: 2 },
      { who: "a session of an unlisted address", headers: { cookie: unlisted }, denied: true, calls: 4 },
      { who: "a session of the listed address", headers: { cookie: listed }, as: LISTED, calls: 4 },
      { who: "a session of the owner's address", headers: { cookie: ownerViewer }, as: s.owner.email, calls: 4 },
      { who: "an expired session", headers: { cookie: expired }, calls: 3 },
      { who: "a malformed cookie", headers: { cookie: `${VIEWER_COOKIE}=dpw_${"z".repeat(64)}` }, calls: 2 },
      { who: "a well-formed cookie nobody was given", headers: { cookie: `${VIEWER_COOKIE}=dpw_${"0".repeat(64)}` }, calls: 3 },
      { who: "two viewer cookies", headers: { cookie: `${listed}; ${unlisted}` }, calls: 2 },
      { who: "the account's session cookie instead of a viewer cookie", headers: { cookie: account.cookie }, calls: 2 },
      { who: "a token", headers: {}, token: s.owner.token, calls: 2 },
      { who: "a token with the listed viewer's cookie", headers: { cookie: listed }, token: s.owner.token, calls: 2 },
    ];
    const pictures = [...s.aNames];
    const strangers = [MADE_UP, ...s.bNames, ...s.retired, s.aNames[0].replace(/\.png$/, ".jpg"), s.aNames[0].toUpperCase()];
    const unknownPicture = seen(await send(deps, "GET", `/t/${a.slug}/v/${MADE_UP}`, { origin: TOURS }));
    expect(unknownPicture).toEqual({ status: 404, headers: [["cache-control", "no-store"], ["content-type", "application/json"], ["x-content-type-options", "nosniff"]], body: NOT_FOUND_JSON });
    const bytes = new Map<string, Uint8Array>();
    for (const name of pictures) bytes.set(name, await storedBytes(deps, name));
    const reads = watchPrivateReads(deps);

    for (const c of credentials) {
      const ask = (method: string, path: string, more: Record<string, string> = {}) => send(deps, method, path, { origin: TOURS, token: c.token, headers: { ...c.headers, ...more } });
      const allowed = c.as !== undefined;
      // The page, plainly, with HEAD, with If-None-Match and with a Range.
      for (const [how, method, more] of [["GET", "GET", {}], ["HEAD", "HEAD", {}], ["If-None-Match", "GET", { "if-none-match": "*" }], ["Range", "GET", { range: "bytes=0-10" }]] as const) {
        const what = `${c.who}: the page by ${how}`;
        reads.length = 0;
        const r = await ask(method, `/t/${a.slug}`, more);
        expect(reads, what).toEqual([]);
        if (allowed) {
          expect(r.status, what).toBe(200);
          expect(Object.fromEntries(r.headers.entries()), what).toEqual(RESTRICTED_PAGE_HEADERS);
          if (method === "GET") {
            expect(r.text, what).toContain(`<title>${a.title}</title>`);
            expect(r.text, what).toContain(`<p class="dp-shared">Shared with you, ${c.as} · <a href="/view/signout/${a.slug}">Not you?</a></p>`);
            expect(r.text, what).toContain(`{"base":"/t/${a.slug}","tour":`);
          } else expect(r.bytes.length, what).toBe(0);
          expect(r.calls, what).toBe(c.calls);
          continue;
        }
        expect(r.status, what).toBe(403);
        expect(Object.fromEntries(r.headers.entries()), what).toEqual({ ...ACCOUNT_PAGE_HEADERS, "content-type": "text/html; charset=utf-8" });
        expect(r.text, what).toBe(method === "HEAD" ? "" : c.denied ? VIEW_DENIED_HTML : VIEW_GATE_HTML);
        expectNothingOf(s, r, what);
        expect(r.calls, what).toBe(c.calls);
      }
      // Each picture and the logo, by GET, HEAD, If-None-Match and Range; then names that are not the tour's live ones.
      for (const name of [...pictures, ...strangers]) {
        const live = pictures.includes(name);
        for (const [how, method, more] of [["GET", "GET", {}], ["HEAD", "HEAD", {}], ["If-None-Match", "GET", { "if-none-match": "*" }], ["Range", "GET", { range: "bytes=0-10" }]] as const) {
          const what = `${c.who}: picture ${name} by ${how}`;
          reads.length = 0;
          const r = await ask(method, `/t/${a.slug}/v/${name}`, more);
          if (allowed && live) {
            expect(reads, what).toEqual([`v/${name}`]);
            expect(r.status, what).toBe(200);
            expect(Object.fromEntries(r.headers.entries()), what).toEqual({
              "content-type": name.endsWith(".png") ? "image/png" : "image/jpeg",
              "content-length": String(bytes.get(name)!.length),
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'; sandbox",
              "referrer-policy": "no-referrer",
              "cross-origin-resource-policy": "same-origin",
            });
            if (method === "GET") expect(r.bytes, what).toEqual(bytes.get(name));
            else expect(r.bytes.length, what).toBe(0);
            expect(r.calls, what).toBe(4);
            continue;
          }
          expect(reads, what).toEqual([]);
          expect(seen(r), what).toEqual(method === "HEAD" ? { ...unknownPicture, body: "" } : unknownPicture);
          expectNothingOf(s, r, what);
        }
      }
      // Tour B's pictures under B's own slug: nothing for anyone here.
      for (const name of s.bNames) {
        reads.length = 0;
        const r = await ask("GET", `/t/${b.slug}/v/${name}`);
        expect([seen(r), reads], `${c.who}: B's picture ${name}`).toEqual([unknownPicture, []]);
      }
    }
  });

  it("the page holds the address only as escaped text the server wrote, and its policy lets no script but the player's file run and allows no connection", () => {
    const tour = pageTour({
      title: "</title><script>alert(1)</script>",
      spotlight_dim: null,
      theme: { card_style: "dark", accent: "#5dcaa5", hotspot: "pulse", progress_bar: true, backdrop: "auto", spotlight_soft: true },
      zoom: { enabled: false, percent: 100 },
      cover: null,
      cta: null,
      end: null,
      autoplay: { enabled: false, seconds: 5 },
      chapters: [{ title: "<img src=x onerror=alert(1)>", description: null, steps: [] }],
    });
    const html = restrictedPageHtml(tour, "abcdefghij", '"<b>x</b>"@example.com');
    expect(html).toContain('<p class="dp-shared">Shared with you, &quot;&lt;b&gt;x&lt;/b&gt;&quot;@example.com · <a href="/view/signout/abcdefghij">Not you?</a></p>');
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    // The only scripts: the player's own file, and the data block (JSON, not run).
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual([expect.stringMatching(/^<script src="\/player\.[0-9a-f]{16}\.js" defer>$/), '<script type="application/json" id="tour">']);
    expect([...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])).toEqual([expect.stringMatching(/^<link rel="stylesheet" href="\/player\.[0-9a-f]{16}\.css">$/), '<link rel="stylesheet" href="/view/shared.css">']);
    expect(RESTRICTED_PAGE_CSP).toBe("default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(RESTRICTED_PAGE_CSP).not.toContain("connect-src");
    expect(RESTRICTED_PAGE_CSP).not.toContain("unsafe");
    expect(() => restrictedPageHtml(tour, "../evil", "a@example.com")).toThrow();
  });
});

describe("locked out on the very next request", () => {
  type Change = { what: string; act: (s: Site, big: Tour) => Promise<void>; answer: "denied" | "unknown"; big?: true };
  const changes: Change[] = [
    { what: "the address is removed from the list", act: (s) => setAccess(s.deps, s.ownerSession, s.a.id, { access: "people", viewers: [OTHER] }).then((r) => expect(r.status).toBe(200)), answer: "denied" },
    { what: "the tour is switched to me", act: (s) => setAccess(s.deps, s.ownerSession, s.a.id, { access: "me" }).then((r) => expect(r.status).toBe(200)), answer: "denied" },
    { what: "the tour is unpublished", act: (s) => send(s.deps, "POST", `/api/v1/tours/${s.a.id}/unpublish`, { token: s.owner.token }).then((r) => expect(r.status).toBe(204)), answer: "unknown" },
    { what: "the workspace is disabled", act: (s) => s.deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [s.owner.userId]).then(() => {}), answer: "unknown" },
    { what: "a move to public starts", act: (s, big) => setAccess(s.deps, s.ownerSession, big.id, { access: "public" }).then((r) => expect(r.status).toBe(202)), answer: "unknown", big: true },
  ];
  for (const change of changes) {
    it(`${change.what}: the page and every picture close for a signed-in viewer`, SLOW, async () => {
      const s = await site();
      const { deps } = s;
      let tour: Tour = s.a;
      if (change.big) {
        // One picture more than a request moves, so the move is still under way after its first request.
        tour = await tourOf(deps, s.owner.token, COPY_BATCH, "Alpha large confidential walkthrough", 6);
        await setAccess(deps, s.ownerSession, tour.id, { access: "people", viewers: [LISTED] });
        await publishAll(deps, s.owner.token, tour.id);
      }
      const names = await liveNames(deps, tour.id);
      const viewer = await viewerFor(deps, LISTED, tour.slug);
      const ask = (path: string) => send(deps, "GET", path, { origin: TOURS, headers: { cookie: viewer } });
      expect((await ask(`/t/${tour.slug}`)).status).toBe(200);
      for (const name of names) expect((await ask(`/t/${tour.slug}/v/${name}`)).status).toBe(200);
      const unknownPage = seen(await send(deps, "GET", `/t/${UNKNOWN_SLUG}`, { origin: TOURS }));
      const unknownPicture = seen(await send(deps, "GET", `/t/${tour.slug}/v/${MADE_UP}`, { origin: TOURS }));

      await change.act(s, tour);
      const reads = watchPrivateReads(deps);
      const page = await ask(`/t/${tour.slug}`);
      if (change.answer === "denied") expect([page.status, page.text]).toEqual([403, VIEW_DENIED_HTML]);
      else expect(seen(page)).toEqual(unknownPage);
      for (const name of names) expect(seen(await ask(`/t/${tour.slug}/v/${name}`)), name).toEqual(unknownPicture);
      expect(reads).toEqual([]);
    });
  }
});

describe("another workspace's tour", () => {
  it("a viewer of tour A gets nothing of tour B, even with B's exact picture names; nor B's viewer of A", SLOW, async () => {
    const s = await site();
    const { deps, a, b } = s;
    const ofA = await viewerFor(deps, LISTED, a.slug);
    const ofB = await viewerFor(deps, B_LISTED, b.slug);
    const reads = watchPrivateReads(deps);
    const unknownPicture = seen(await send(deps, "GET", `/t/${a.slug}/v/${MADE_UP}`, { origin: TOURS }));
    const ask = (cookie: string, path: string) => send(deps, "GET", path, { origin: TOURS, headers: { cookie } });
    // Each is allowed its own tour: the test is about the other.
    expect((await ask(ofA, `/t/${a.slug}`)).status).toBe(200);
    expect((await ask(ofB, `/t/${b.slug}`)).status).toBe(200);
    reads.length = 0;
    const other = await ask(ofA, `/t/${b.slug}`);
    expect([other.status, other.text]).toEqual([403, VIEW_DENIED_HTML]);
    expect(other.text).not.toContain("Bravo");
    for (const name of s.bNames) {
      expect(seen(await ask(ofA, `/t/${b.slug}/v/${name}`)), name).toEqual(unknownPicture);
      expect(seen(await ask(ofA, `/t/${a.slug}/v/${name}`)), name).toEqual(unknownPicture);
    }
    for (const name of s.aNames) {
      expect(seen(await ask(ofB, `/t/${a.slug}/v/${name}`)), name).toEqual(unknownPicture);
      expect(seen(await ask(ofB, `/t/${b.slug}/v/${name}`)), name).toEqual(unknownPicture);
    }
    expect(reads).toEqual([]);
  });
});

/**
 * GET /t/<slug> as it was before restricted tours could be served (0.1.38), kept here as it
 * was, to compare against: the one lookup, then the page or the not-found page.
 */
async function previousPage(deps: Deps, raw: string, ifNoneMatch: string | null): Promise<Response> {
  const base = deps.config.publicImageBase;
  const slug = /^[a-z2-7]{10}$/.test(raw) ? raw : "";
  const row = await deps.db.first<{ data: string }>(
    `SELECT s.data FROM snapshot s JOIN tour t ON t.id = s.tour_id WHERE t.slug = ? AND t.status = 'published' AND t.access = 'public' AND ${noDisabledAccount("t.workspace_id")}`,
    [slug],
  );
  if (row === null) return notFoundPage(base);
  let tour;
  try {
    tour = pageTour(JSON.parse(row.data));
  } catch (err) {
    if (!(err instanceof MalformedSnapshot) && !(err instanceof SyntaxError)) throw err;
    return notFoundPage(base);
  }
  return renderPage(tour, base, ifNoneMatch);
}

async function seenOf(res: Response) {
  return { status: res.status, headers: [...res.headers.entries()].sort(), body: await res.text() };
}

describe("public tours", () => {
  it("answer byte for byte as before, with one database call, also with a viewer cookie, an account cookie or both", SLOW, async () => {
    const s = await site();
    const { deps, p } = s;
    const listed = await viewerFor(deps, LISTED, s.a.slug);
    const account = await accountSession(deps, s.owner.userId);
    const etag = (await send(deps, "GET", `/t/${p.slug}`, { origin: TOURS })).headers.get("etag")!;
    for (const base of ["", "https://pictures.example.net"]) {
      deps.config.publicImageBase = base;
      for (const [who, cookie] of [["nobody", null], ["a viewer", listed], ["an account", account.cookie], ["both", `${account.cookie}; ${listed}`]] as const) {
        for (const inm of [null, etag, "*"]) {
          const headers: Record<string, string> = {};
          if (cookie !== null) headers.cookie = cookie;
          if (inm !== null) headers["if-none-match"] = inm;
          const now = await send(deps, "GET", `/t/${p.slug}`, { origin: TOURS, headers });
          const before = await seenOf(await previousPage(deps, p.slug, inm));
          expect(seen(now), `${base} ${who} ${inm}`).toEqual(before);
          expect(now.calls, `${base} ${who} ${inm}`).toBe(1);
          expect(now.status).toBe(inm === "*" || (inm === etag && base === "") ? 304 : 200);
        }
      }
    }
    deps.config.publicImageBase = "";
    // A link that finds no tour answers as before; it now also asks whether a restricted tour has it.
    for (const raw of [UNKNOWN_SLUG, "not-a-slug", "UPPERCASE1"]) {
      const now = await send(deps, "GET", `/t/${raw}`, { origin: TOURS, headers: { cookie: listed } });
      expect(seen(now), raw).toEqual(await seenOf(await previousPage(deps, raw, null)));
      expect(now.calls, raw).toBe(raw === UNKNOWN_SLUG ? 2 : 1);
    }
    // A public tour's pictures are not served by the restricted route.
    const pName = (await liveNames(deps, p.id))[0];
    expect((await send(deps, "GET", `/t/${p.slug}/v/${pName}`, { origin: TOURS, headers: { cookie: listed } })).text).toBe(NOT_FOUND_JSON);
    expect((await send(deps, "GET", `/p/${pName}`, { origin: TOURS })).status).toBe(200);
  });
});

describe("the gate the viewer link request asks", () => {
  it("answers yes only for a servable restricted tour the address may view, with a digest for its workspace, after the same two statements every time", SLOW, async () => {
    const s = await site();
    const { deps, a, p } = s;
    const draft = await tourOf(deps, s.owner.token, 1, "Draft walkthrough", 7);
    await setAccess(deps, s.ownerSession, draft.id, { access: "people", viewers: [LISTED] });
    const statements: string[] = [];
    const kinds = recordKinds(deps, statements);
    const key = await workspaceKeyOf(s.owner.workspaceId);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(s.owner.workspaceId.slice(3));
    const cases: [string, string, string, boolean][] = [
      ["the listed address", a.slug, LISTED, true],
      ["the owner's address", a.slug, s.owner.email, true],
      ["an unlisted address", a.slug, OTHER, false],
      ["a malformed address", a.slug, "", false],
      ["a malformed slug", "", LISTED, false],
      ["both malformed", "", "", false],
      ["an unknown tour", UNKNOWN_SLUG, LISTED, false],
      ["a public tour", p.slug, LISTED, false],
      ["a restricted draft", draft.slug, LISTED, false],
      ["another workspace's tour", s.b.slug, LISTED, false],
    ];
    let shape: string[] | null = null;
    for (const [what, slug, email, yes] of cases) {
      kinds.length = 0;
      statements.length = 0;
      const answer = await RESTRICTED_GATE.mayRequest(deps, slug, email);
      expect(answer, what).toEqual(yes ? { allowed: true, workspaceKey: key } : { allowed: false });
      expect(kinds, what).toEqual(["first", "first"]);
      shape ??= [...statements];
      expect(statements, what).toEqual(shape);
    }
    // Disabled, the owner's own address gets no yes either, after the same statements.
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [s.owner.userId]);
    kinds.length = 0;
    statements.length = 0;
    expect(await RESTRICTED_GATE.mayRequest(deps, a.slug, LISTED)).toEqual({ allowed: false });
    expect(statements).toEqual(shape);
  });
});

const ANSWER = "| answer";

describe("asking for a viewer link, with the real gate", () => {
  it("answers the same after the same calls for listed and unlisted addresses, unknown, public, draft and disabled tours; only a listed address of a servable tour is mailed", SLOW, async () => {
    const s = await site();
    const { deps, mail, settle, a, p } = s;
    // No gate is registered here: the one this file sees is the one loading the app registered.
    const draft = await tourOf(deps, s.owner.token, 1, "Draft walkthrough", 7);
    await setAccess(deps, s.ownerSession, draft.id, { access: "people", viewers: [LISTED] });
    const third = await seedAccount(deps, { username: "third" });
    const thirdSession = await accountSession(deps, third.userId);
    const off = await tourOf(deps, third.token, 1, "Disabled walkthrough", 8);
    await setAccess(deps, thirdSession, off.id, { access: "people", viewers: [LISTED] });
    await publishAll(deps, third.token, off.id);
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [third.userId]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kinds = recordKinds(deps);
    const app = (d: Deps) => ({
      fetch: async (req: Request) => {
        const res = await createApp(d).fetch(req);
        kinds.push(ANSWER);
        return res;
      },
    });
    const cases: [string, unknown, unknown][] = [
      ["an unlisted address", OTHER, a.slug],
      ["an unknown slug", LISTED, UNKNOWN_SLUG],
      ["a public tour", LISTED, p.slug],
      ["a restricted draft", LISTED, draft.slug],
      ["a tour of a disabled workspace", LISTED, off.slug],
      ["another workspace's tour", LISTED, s.b.slug],
      ["a malformed address", "not an address", a.slug],
      ["a malformed slug", LISTED, "../../etc"],
      ["no slug", LISTED, undefined],
      ["the listed address", LISTED, a.slug],
    ];
    const answers: Record<string, unknown> = {};
    for (const [what, email, slug] of cases) {
      await deps.db.run("DELETE FROM rate_counter");
      kinds.length = 0;
      const r = await send(deps, "POST", "/api/v1/view/request", {
        origin: TOURS,
        app,
        body: JSON.stringify({ email, slug }),
        headers: { ...JSON_HEADERS, origin: TOURS, "sec-fetch-site": "same-origin", "user-agent": FIREFOX },
      });
      await settle();
      const all = kinds.splice(0);
      const at = all.indexOf(ANSWER);
      answers[what] = { seen: seen(r), before: all.slice(0, at), after: all.slice(at + 1) };
    }
    const sent = answers["the listed address"];
    // Three counts, the gate's two reads, the two caps, the two sweeps; then one write and one batch.
    expect(sent).toEqual({
      seen: { status: 202, headers: [["cache-control", "no-store"], ["content-type", "application/json"], ["x-content-type-options", "nosniff"]], body: '{"ok":true}' },
      before: ["first", "first", "first", "first", "first", "first", "first", "batch", "run"],
      after: ["run", "batch"],
    });
    for (const [what] of cases) expect(answers[what], what).toEqual(sent);
    expect(mail.sent.map((m) => m.to)).toEqual([LISTED]);
    expect(await deps.db.all("SELECT email, slug FROM viewer_code WHERE email = ? AND slug = ? AND used_at IS NULL", [LISTED, a.slug])).toHaveLength(1);
    expect(LIMITS_VIEWER.mailWorkspace.most).toBeGreaterThan(1);
  });
});
