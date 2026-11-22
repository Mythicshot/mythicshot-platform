// The terms gate against the whole route table, on both targets: no session request gets past
// the site's terms before the account has agreed to them, but the terms screen's own three, the
// two sign-outs, and the fixed pages and files those need.
//
// Every route of the app is in GATE, keyed "<METHOD> <route path>" exactly as in the route
// table, with its kind:
// - held: takes a session, and answers 403 terms_required (and changes nothing) until the
//   account has agreed to the current terms; each has a request that shows it, and the same
//   request is no longer refused for the terms once the account has agreed.
// - open: takes a session and is reached before agreeing: GET /api/v1/terms, GET
//   /api/v1/terms/agreed, POST /api/v1/terms/agree and the two sign-outs. The list is fixed
//   here, so a route cannot join it without this file changing.
// - page: a fixed page or file of the app address, served with no database call, the terms
//   screen among them: with a session cookie that waits for the terms it answers exactly as
//   without one.
// - none: takes no session at all (a token alone, no credential, a viewer cookie, or the
//   pages of the tours and img addresses). A session cookie that waits for the terms changes
//   nothing of its answer.
// A route in no table fails the first test, and so does a key no route has, so a new route is
// classified before it can be merged; the last test of the first block shows that it does.
// The kinds are also held to the API description: every operation it says takes a session is
// held or open, and every other one is none.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { openapi } from "../src/docs/openapi.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { parseTerms, publishTerms } from "../src/terms.ts";
import { ORIGIN, send, type Call } from "./bundle.ts";

type Kind = "held" | "open" | "page" | "none";
type Sample = { method: string; path: string; json?: unknown; body?: string };
type Entry = { kind: Kind; sample?: Sample; admin?: true };

const T0 = 1_800_000_000_000;
const Z24 = "0".repeat(24);
const TOUR = `tour_${Z24}`;
const UPLOAD = `up_${Z24}`;
const MEDIA = `med_${Z24}`;
const STEP = `st_${Z24}`;
const TOKEN_ID = `tok_${Z24}`;
const SESSION_ID = `ses_${Z24}`;
const WORKSPACE = `ws_${Z24}`;
const ACCOUNT = `usr_${Z24}`;
const INVITE = `inv_${Z24}`;

const held = (method: string, path: string, json?: unknown): Entry => ({ kind: "held", sample: { method, path, json } });
const heldAdmin = (method: string, path: string, json?: unknown): Entry => ({ kind: "held", admin: true, sample: { method, path, json } });
const open = (method: string, path: string, json?: unknown): Entry => ({ kind: "open", sample: { method, path, json } });
const page = (path: string): Entry => ({ kind: "page", sample: { method: "GET", path } });
const none = (method: string, path: string, json?: unknown): Entry => ({ kind: "none", sample: { method, path, json } });

/** Every route, by its kind. */
const GATE: Record<string, Entry> = {
  "GET /healthz": none("GET", "/healthz"),
  // The setup wizard: no session, only while the site has no workspace.
  "GET /setup": none("GET", "/setup"),
  "GET /setup/setup.css": none("GET", "/setup/setup.css"),
  "GET /setup/setup.js": none("GET", "/setup/setup.js"),
  "POST /setup/check": none("POST", "/setup/check", { code: "x" }),
  "POST /setup/claim": none("POST", "/setup/claim", { code: "x" }),
  // A token alone.
  "GET /api/v1/setup/connected": none("GET", "/api/v1/setup/connected"),
  // A token or a session: held for the session.
  "POST /api/v1/uploads": held("POST", "/api/v1/uploads", {}),
  "PUT /api/v1/uploads/:id/steps/:n": held("PUT", `/api/v1/uploads/${UPLOAD}/steps/1`),
  "PUT /api/v1/uploads/:id/logo": held("PUT", `/api/v1/uploads/${UPLOAD}/logo`),
  "POST /api/v1/uploads/:id/commit": held("POST", `/api/v1/uploads/${UPLOAD}/commit`),
  "DELETE /api/v1/uploads/:id": held("DELETE", `/api/v1/uploads/${UPLOAD}`),
  "POST /api/v1/media": held("POST", "/api/v1/media", { kind: "image", content_type: "image/png", bytes: 100, width: 8, height: 8, title: "Gate" }),
  "PUT /api/v1/media/:id/parts/:n": held("PUT", `/api/v1/media/${MEDIA}/parts/0`),
  "PUT /api/v1/media/:id/preview": held("PUT", `/api/v1/media/${MEDIA}/preview`),
  "POST /api/v1/media/:id/commit": held("POST", `/api/v1/media/${MEDIA}/commit`),
  "DELETE /api/v1/media/:id": held("DELETE", `/api/v1/media/${MEDIA}`),
  "GET /api/v1/media": held("GET", "/api/v1/media?kind=image"),
  "GET /api/v1/media/:id": held("GET", `/api/v1/media/${MEDIA}`),
  "GET /api/v1/media/:id/preview": held("GET", `/api/v1/media/${MEDIA}/preview`),
  "GET /api/v1/me": held("GET", "/api/v1/me"),
  "GET /api/v1/usage": held("GET", "/api/v1/usage"),
  "GET /api/v1/usage/largest": held("GET", "/api/v1/usage/largest"),
  "GET /api/v1/tours": held("GET", "/api/v1/tours"),
  "PATCH /api/v1/tours/:id": held("PATCH", `/api/v1/tours/${TOUR}`, { title: "Gate" }),
  "DELETE /api/v1/tours/:id": held("DELETE", `/api/v1/tours/${TOUR}`),
  "GET /api/v1/tours/:id/steps/:step_id/image": held("GET", `/api/v1/tours/${TOUR}/steps/${STEP}/image`),
  "POST /api/v1/tours/:id/publish": held("POST", `/api/v1/tours/${TOUR}/publish`),
  "POST /api/v1/tours/:id/unpublish": held("POST", `/api/v1/tours/${TOUR}/unpublish`),
  "GET /api/v1/tours/:id/access": held("GET", `/api/v1/tours/${TOUR}/access`),
  "PUT /api/v1/tours/:id/access": held("PUT", `/api/v1/tours/${TOUR}/access`, { access: "me" }),
  "GET /api/v1/media/:id/access": held("GET", `/api/v1/media/${MEDIA}/access`),
  "PUT /api/v1/media/:id/access": held("PUT", `/api/v1/media/${MEDIA}/access`, { access: "me" }),
  // Signing in takes no session; the session's own requests are held.
  "POST /api/v1/signin/request": none("POST", "/api/v1/signin/request", { email: "nobody@example.com" }),
  "POST /api/v1/signin/complete": none("POST", "/api/v1/signin/complete", { code: "dpl_" + "0".repeat(40) }),
  "GET /api/v1/session": held("GET", "/api/v1/session"),
  "GET /api/v1/sessions": held("GET", "/api/v1/sessions"),
  "DELETE /api/v1/sessions/:id": held("DELETE", `/api/v1/sessions/${SESSION_ID}`),
  "POST /api/v1/signout": open("POST", "/api/v1/signout"),
  "POST /api/v1/signout/everywhere": open("POST", "/api/v1/signout/everywhere"),
  "POST /api/v1/account/email": held("POST", "/api/v1/account/email", { email: "new-address@example.com" }),
  "POST /api/v1/account/email/confirm": held("POST", "/api/v1/account/email/confirm", { code: "dpe_" + "0".repeat(40) }),
  // The site's terms: open.
  "GET /api/v1/terms": open("GET", "/api/v1/terms"),
  "GET /api/v1/terms/agreed": open("GET", "/api/v1/terms/agreed"),
  "POST /api/v1/terms/agree": open("POST", "/api/v1/terms/agree", { terms: `trm_${Z24}` }),
  // Connecting the app: the app's two take no credential; approving a computer is held.
  "POST /api/v1/connect/start": none("POST", "/api/v1/connect/start", { device_name: "Gate" }),
  "POST /api/v1/connect/token": none("POST", "/api/v1/connect/token", { device_code: "dpd_" + "0".repeat(40) }),
  "POST /api/v1/connect/lookup": held("POST", "/api/v1/connect/lookup", { user_code: "ABCD-EFGH" }),
  "POST /api/v1/connect/confirm": held("POST", "/api/v1/connect/confirm", { user_code: "ABCD-EFGH" }),
  "POST /api/v1/connect/refuse": held("POST", "/api/v1/connect/refuse", { user_code: "ABCD-EFGH" }),
  "GET /api/v1/tokens": held("GET", "/api/v1/tokens"),
  "PATCH /api/v1/tokens/:id": held("PATCH", `/api/v1/tokens/${TOKEN_ID}`, { name: "Gate" }),
  "DELETE /api/v1/tokens/:id": held("DELETE", `/api/v1/tokens/${TOKEN_ID}`),
  // The admin's routes: held for the admin (a member gets the one 404 either way).
  "GET /api/v1/admin/summary": heldAdmin("GET", "/api/v1/admin/summary"),
  "GET /api/v1/admin/accounts": heldAdmin("GET", "/api/v1/admin/accounts"),
  "PATCH /api/v1/admin/workspaces/:id": heldAdmin("PATCH", `/api/v1/admin/workspaces/${WORKSPACE}`, { storage_allowance_bytes: 1 }),
  "POST /api/v1/admin/invites": heldAdmin("POST", "/api/v1/admin/invites", { email: "newcomer@example.com" }),
  "GET /api/v1/admin/invites": heldAdmin("GET", "/api/v1/admin/invites"),
  "POST /api/v1/admin/invites/:id/resend": heldAdmin("POST", `/api/v1/admin/invites/${INVITE}/resend`),
  "DELETE /api/v1/admin/invites/:id": heldAdmin("DELETE", `/api/v1/admin/invites/${INVITE}`),
  "POST /api/v1/admin/accounts/:id/disable": heldAdmin("POST", `/api/v1/admin/accounts/${ACCOUNT}/disable`),
  "POST /api/v1/admin/accounts/:id/enable": heldAdmin("POST", `/api/v1/admin/accounts/${ACCOUNT}/enable`),
  "GET /api/v1/admin/accounts/:id/removal": heldAdmin("GET", `/api/v1/admin/accounts/${ACCOUNT}/removal`),
  "DELETE /api/v1/admin/accounts/:id": heldAdmin("DELETE", `/api/v1/admin/accounts/${ACCOUNT}`, { username: "nobody" }),
  // Invites take no credential.
  "POST /api/v1/invite/check": none("POST", "/api/v1/invite/check", { code: "dpi_" + "0".repeat(40) }),
  "POST /api/v1/invite/accept": none("POST", "/api/v1/invite/accept", { code: "dpi_" + "0".repeat(40), username: "newcomer" }),
  // Visitors proving an address: the viewer cookies, never a session.
  "POST /api/v1/view/request": none("POST", "/api/v1/view/request", { email: "viewer@example.com", slug: "abcdefghij" }),
  "POST /api/v1/view/check": none("POST", "/api/v1/view/check", { code: "dpv_" + "0".repeat(40) }),
  "POST /api/v1/view/complete": none("POST", "/api/v1/view/complete", { code: "dpv_" + "0".repeat(40) }),
  "POST /api/v1/view/signout": none("POST", "/api/v1/view/signout", {}),
  "GET /api/v1/view/session": none("GET", "/api/v1/view/session"),
  "POST /api/v1/media-view/request": none("POST", "/api/v1/media-view/request", { email: "viewer@example.com", page: "/i/abcdefghijklmnopqrst" }),
  "POST /api/v1/media-view/check": none("POST", "/api/v1/media-view/check", { code: "dpi_" + "0".repeat(40) }),
  "POST /api/v1/media-view/complete": none("POST", "/api/v1/media-view/complete", { code: "dpi_" + "0".repeat(40) }),
  "POST /api/v1/media-view/signout": none("POST", "/api/v1/media-view/signout", {}),
  "GET /api/v1/media-view/session": none("GET", "/api/v1/media-view/session"),
  // The fixed pages and files of the app address: the sign-in pages, the invite page, the
  // dashboard's pages and files, and the terms screen with its script.
  "GET /signin": page("/signin"),
  "GET /signin/link": page("/signin/link"),
  "GET /signin/signin.css": page("/signin/signin.css"),
  "GET /signin/signin.js": page("/signin/signin.js"),
  "GET /invite": page("/invite"),
  "GET /invite/invite.js": page("/invite/invite.js"),
  "GET /": page("/"),
  "GET /tours": page("/tours"),
  "GET /dash/tours.js": page("/dash/tours.js"),
  "GET /dash/dash.css": page("/dash/dash.css"),
  "GET /dash/dash.js": page("/dash/dash.js"),
  "GET /images": page("/images"),
  "GET /dash/images.js": page("/dash/images.js"),
  "GET /gifs": page("/gifs"),
  "GET /dash/gifs.js": page("/dash/gifs.js"),
  "GET /storage": page("/storage"),
  "GET /dash/storage.js": page("/dash/storage.js"),
  "GET /connections": page("/connections"),
  "GET /dash/connections.js": page("/dash/connections.js"),
  "GET /admin": page("/admin"),
  "GET /dash/admin.js": page("/dash/admin.js"),
  "GET /account": page("/account"),
  "GET /dash/account.js": page("/dash/account.js"),
  "GET /account/email": page("/account/email"),
  "GET /dash/account-email.js": page("/dash/account-email.js"),
  "GET /terms": page("/terms"),
  "GET /dash/terms.js": page("/dash/terms.js"),
  // The product's mark (src/brand-assets.ts, src/brand.ts): fixed bytes every page above shows, no session read, no database call.
  "GET /dash/mark.svg": page("/dash/mark.svg"),
  // The pages visitors open, the player's files and the documentation: no session.
  "GET /p/:name": none("GET", "/p/" + "0".repeat(32) + ".png"),
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": none("GET", "/player.js"),
  "GET /t/:slug": none("GET", "/t/abcdefghij"),
  "GET /t/:slug/v/:name": none("GET", "/t/abcdefghij/v/" + "0".repeat(32) + ".png"),
  "GET /view": none("GET", "/view"),
  "GET /view/signout/:slug": none("GET", "/view/signout/abcdefghij"),
  "GET /view/view.js": none("GET", "/view/view.js"),
  "GET /view/view.css": none("GET", "/view/view.css"),
  "GET /view/shared.css": none("GET", "/view/shared.css"),
  "GET /i/:name": none("GET", "/i/abcdefghijklmnopqrst"),
  "GET /i/:name/download": none("GET", "/i/abcdefghijklmnopqrst/download"),
  "GET /i/:name/preview": none("GET", "/i/abcdefghijklmnopqrst/preview"),
  "GET /r/:name": none("GET", "/r/abcdefghijklmnopqrst"),
  "GET /r/:name/download": none("GET", "/r/abcdefghijklmnopqrst/download"),
  "GET /r/:name/preview": none("GET", "/r/abcdefghijklmnopqrst/preview"),
  "GET /s/share.css": none("GET", "/s/share.css"),
  "GET /s/share.js": none("GET", "/s/share.js"),
  "GET /i/:name/signout": none("GET", "/i/abcdefghijklmnopqrst/signout"),
  "GET /r/:name/signout": none("GET", "/r/abcdefghijklmnopqrst/signout"),
  "GET /s/view": none("GET", "/s/view"),
  "GET /s/view.js": none("GET", "/s/view.js"),
  "GET /s/view.css": none("GET", "/s/view.css"),
  "GET /s/shared.css": none("GET", "/s/shared.css"),
  "GET /docs": none("GET", "/docs"),
  "GET /docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}": none("GET", "/docs/viewer.0123456789abcdef.js"),
  "GET /docs/licences.txt": none("GET", "/docs/licences.txt"),
  // The brand's files (src/brand-routes.ts): the tab icon, the fonts and their licences, fixed files that take no session.
  "GET /favicon.svg": none("GET", "/favicon.svg"),
  "GET /favicon.ico": none("GET", "/favicon.ico"),
  "GET /fonts/:file{manrope(?:\\.[0-9a-f]{16})?\\.ttf}": none("GET", "/fonts/manrope.ttf"),
  "GET /fonts/manrope-OFL.txt": none("GET", "/fonts/manrope-OFL.txt"),
  "GET /fonts/:file{cinzel(?:\\.[0-9a-f]{16})?\\.ttf}": none("GET", "/fonts/cinzel.ttf"),
  "GET /fonts/cinzel-OFL.txt": none("GET", "/fonts/cinzel-OFL.txt"),
  "GET /api/v1/openapi.json": none("GET", "/api/v1/openapi.json"),
  "GET /api/v1/openapi.yaml": none("GET", "/api/v1/openapi.yaml"),
};

/** The only session routes a person reaches before agreeing. */
const OPEN_BEFORE_AGREEING = ["GET /api/v1/terms", "GET /api/v1/terms/agreed", "POST /api/v1/terms/agree", "POST /api/v1/signout", "POST /api/v1/signout/everywhere"];

/** The app's routes as keys, the host gate left out. */
function routeKeysOf(app: { routes: { method: string; path: string }[] }): string[] {
  return [...new Set(app.routes.filter((r) => !(r.method === "ALL" && r.path === "/*")).map((r) => `${r.method} ${r.path}`))];
}

/** Everything wrong between a route list and GATE: one line per problem. */
function gateProblems(routes: string[], gate: Record<string, Entry> = GATE): string[] {
  const problems: string[] = [];
  for (const key of routes) if (!Object.hasOwn(gate, key)) problems.push(`${key} is not classified: add it to GATE in test/terms-gate.test.ts as held (a session route the terms hold back), open, page or none, with a request that shows it`);
  for (const key of Object.keys(gate)) if (!routes.includes(key)) problems.push(`${key} is in GATE but no route has it: remove it`);
  return problems;
}

const routes = () => routeKeysOf(createApp({ config: { publicImageBase: "", setupCode: null } } as Deps));

describe("every route is classified for the terms", () => {
  it("every route of the route table is in GATE, and nothing else is", () => {
    expect(gateProblems(routes())).toEqual([]);
    expect(routes().length).toBeGreaterThan(100);
  });

  it("the routes open before agreeing are exactly the terms screen's three and the two sign-outs", () => {
    expect(Object.keys(GATE).filter((k) => GATE[k].kind === "open").sort()).toEqual([...OPEN_BEFORE_AGREEING].sort());
  });

  it("the kinds agree with the API description: an operation that takes a session is held or open, any other is none", () => {
    const doc = openapi();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const key = `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`;
        const takesSession = JSON.stringify(op.security).includes('"session"');
        expect(GATE[key]?.kind, key).toBe(takesSession ? (OPEN_BEFORE_AGREEING.includes(key) ? "open" : "held") : "none");
      }
    }
  });

  it("in the code, only those five routes ask requireAuth to let a session through before agreeing", () => {
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const asks = Object.entries(sources).flatMap(([file, text]) => [...text.matchAll(/requireAuth\([^)]*terms: "open"[^)]*\)/g)].map(() => file));
    expect(asks.sort()).toEqual(["../src/signin.ts", "../src/signin.ts", "../src/terms.ts", "../src/terms.ts", "../src/terms.ts"]);
    // And the two in src/signin.ts are the two sign-outs.
    const signin = sources["../src/signin.ts"];
    for (const path of ["signout", "signout/everywhere"]) expect(signin).toContain(`app.post("/api/v1/${path}", async (c) => {\n    const auth = await requireAuth(c.req.raw, deps, { only: "session", terms: "open" });`);
  });

  it("the check itself fails for a new route nobody classified, and for a key left behind", () => {
    const app = createApp({ config: { publicImageBase: "", setupCode: null } } as Deps);
    app.get("/api/v1/export", (c) => c.json({}));
    expect(gateProblems(routeKeysOf(app))).toEqual([
      "GET /api/v1/export is not classified: add it to GATE in test/terms-gate.test.ts as held (a session route the terms hold back), open, page or none, with a request that shows it",
    ]);
    expect(gateProblems(routes().filter((k) => k !== "GET /api/v1/me"))).toEqual(["GET /api/v1/me is in GATE but no route has it: remove it"]);
  });
});

// ---- Sending ----

type Signed = { cookie: string; csrf: string };

async function signIn(deps: Deps, userId: string): Promise<Signed> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** A request as the site's own page sends it: the cookie, and for a change the Origin and the anti-forgery header. */
function fire(deps: Deps, s: Sample, who: Signed | null): Promise<Call> {
  const headers: Record<string, string> = {};
  if (s.json !== undefined) headers["content-type"] = "application/json";
  if (who !== null) Object.assign(headers, { cookie: who.cookie, "x-csrf-token": who.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin" });
  return send(deps, s.method, s.path, { headers, body: s.json !== undefined ? JSON.stringify(s.json) : s.body });
}

const TERMS_FILE = "title: Terms\nversion: 1\nmain points:\n- One point.\nterms:\nThe terms.\n";

async function publish(deps: Deps, text = TERMS_FILE): Promise<string> {
  const read = await parseTerms(new TextEncoder().encode(text));
  if (!read.ok) throw new Error(read.reason);
  const made = await publishTerms(deps, read);
  if (!made.ok) throw new Error("not published");
  return made.id;
}

/** Every row of every table of the app, by table, in a fixed order. */
async function dumpAll(deps: Deps): Promise<Record<string, unknown[]>> {
  const tables = await deps.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name");
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) out[name] = await deps.db.all(`SELECT * FROM "${name}" ORDER BY rowid`);
  return out;
}

const REFUSED = '{"error":"terms_required","detail":"agree to the site\'s terms first"}';

async function world() {
  const ctx = await makeDeps();
  let now = T0;
  ctx.deps.now = () => now;
  const admin = await seedAccount(ctx.deps, { username: "owner", admin: true });
  const member = await seedAccount(ctx.deps, { username: "member" });
  return { ...ctx, admin, member, tick: () => void (now += 10) };
}

describe("before the account agrees to the site's terms", () => {
  it("every held route answers 403 terms_required, the one refusal, and changes nothing; once agreed, none of them is refused for the terms", { timeout: 120_000 }, async () => {
    const w = await world();
    const adminSession = await signIn(w.deps, w.admin.userId);
    const memberSession = await signIn(w.deps, w.member.userId);
    const id = await publish(w.deps);
    const before = await dumpAll(w.deps);
    const heldKeys = Object.keys(GATE).filter((k) => GATE[k].kind === "held");
    expect(heldKeys.length).toBe(48);
    for (const key of heldKeys) {
      const e = GATE[key];
      const r = await fire(w.deps, e.sample!, e.admin ? adminSession : memberSession);
      expect([r.status, r.text], key).toEqual([403, REFUSED]);
      expect(Object.fromEntries(r.headers.entries()), key).toEqual({ "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      // A member asking an admin route gets the one 404 an admin route answers everyone else, terms or not.
      if (e.admin) expect((await fire(w.deps, e.sample!, memberSession)).text, key).toBe('{"error":"not_found"}');
    }
    expect(await dumpAll(w.deps), "a refused request changed something").toEqual(before);
    expect(w.mail.sent).toEqual([]);
    // The member and the admin agree; from then on no held route is refused for the terms.
    for (const s of [adminSession, memberSession]) expect((await fire(w.deps, { method: "POST", path: "/api/v1/terms/agree", json: { terms: id } }, s)).status).toBe(204);
    for (const key of heldKeys) {
      const e = GATE[key];
      w.tick();
      const r = await fire(w.deps, e.sample!, e.admin ? adminSession : memberSession);
      expect(r.json?.error, `${key}: ${r.status} ${r.text}`).not.toBe("terms_required");
    }
  });

  it("the open routes answer, the pages and files are served as without the terms, and no route that takes no session sees them", { timeout: 120_000 }, async () => {
    const w = await world();
    await publish(w.deps);
    for (const key of Object.keys(GATE).filter((k) => GATE[k].kind !== "held")) {
      const e = GATE[key];
      // A fresh session for each, so a sign-out ends only its own.
      const pending = await signIn(w.deps, w.member.userId);
      w.tick();
      const r = await fire(w.deps, e.sample!, pending);
      expect(r.json?.error, `${key}: ${r.status} ${r.text}`).not.toBe("terms_required");
      if (e.kind === "page") {
        const bare = await fire(w.deps, e.sample!, null);
        expect(r.status, key).toBe(key === "GET /" ? 302 : 200);
        expect(r.calls, `${key}: database calls`).toBe(0);
        if (key !== "GET /") expect(r.text, key).toBe(bare.text);
      }
      if (e.kind === "open") expect([200, 204, 409], `${key}: ${r.text}`).toContain(r.status);
    }
  });

  it("a session request costs no database call more with terms published, whether it is refused or the terms are agreed to", async () => {
    const w = await world();
    const s = await signIn(w.deps, w.member.userId);
    const ask = () => fire(w.deps, { method: "GET", path: "/api/v1/tokens" }, s);
    await ask();
    const without = (await ask()).calls;
    const id = await publish(w.deps);
    const refused = await ask();
    expect(refused.status).toBe(403);
    expect(refused.calls).toBeLessThanOrEqual(without);
    expect((await fire(w.deps, { method: "POST", path: "/api/v1/terms/agree", json: { terms: id } }, s)).status).toBe(204);
    const agreed = await ask();
    expect(agreed.status).toBe(200);
    expect(agreed.calls).toBe(without);
  });
});
