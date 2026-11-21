// Disabling, enabling and deleting an account (src/account-removal.ts) on both targets.
//
// Most tests run in the cross-workspace suite's world (test/isolation-world.ts): two
// workspaces that each hold one of everything, the first one's account the site's admin.
// The admin disables, enables and deletes the second one's. The test that every row and
// every file of a deleted workspace is gone, and nothing of the other, is in
// test/isolation.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { newId, newLinkId, newSlug, newToken } from "../src/auth.ts";
import { SUBREQUEST_BUDGET } from "../src/budget.ts";
import type { Deps, FileStore } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, createUpload, gif, logoPng, putStep, send, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";
import { inventedIds, manifestOf, snapshotOf, world, type Side, type World } from "./isolation-world.ts";

const SLOW = { timeout: 300_000 };
const VERY_SLOW = { timeout: 900_000 };
const JSON_HEADERS = { "content-type": "application/json" };
const account = (id: string, rest = "") => `/api/v1/admin/accounts/${id}${rest}`;

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** The headers the site's own page sends with a session. */
function page(session: { cookie: string; csrf: string }): Record<string, string> {
  return { cookie: session.cookie, "x-csrf-token": session.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin" };
}

/** A new session of the account, as completing a sign-in makes one. */
async function signInAs(deps: Deps, userId: string): Promise<{ id: string; cookie: string; csrf: string; secret: string }> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { id: made.sessionId, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret), secret: made.secret };
}

async function build(config?: Parameters<typeof makeDeps>[0]): Promise<World> {
  const ctx = await makeDeps(config);
  return world(ctx.deps, { draftKeys: ctx.draftKeys, publicKeys: ctx.publicKeys });
}

const asAdmin = (w: World, method: string, path: string, json?: unknown) =>
  send(w.deps, method, path, { headers: { ...page(w.a.session), ...(json === undefined ? {} : JSON_HEADERS) }, body: json === undefined ? undefined : JSON.stringify(json) });

/** Every public answer about the side's workspace, and the same for ids that never existed. */
function publicRequests(side: Side): { what: string; path: string; unknown: string }[] {
  const never = inventedIds();
  const m = side.ids.media;
  return [
    { what: "the tour page", path: `/t/${side.ids.published.slug}`, unknown: `/t/${never.published.slug}` },
    { what: "a live picture", path: `/p/${side.ids.published.publicName}`, unknown: `/p/${never.published.publicName}` },
    { what: "a retired picture in its grace", path: `/p/${side.ids.published.retiredName}`, unknown: `/p/${never.published.publicName}` },
    { what: "the image's page", path: `/i/${m.imageLink}`, unknown: `/i/${never.media.imageLink}` },
    { what: "the image's file", path: `/i/${m.imageLink}.png`, unknown: `/i/${never.media.imageLink}.png` },
    { what: "the image's download", path: `/i/${m.imageLink}/download`, unknown: `/i/${never.media.imageLink}/download` },
    { what: "the image's preview", path: `/i/${m.imageLink}/preview`, unknown: `/i/${never.media.imageLink}/preview` },
    { what: "the clip's page", path: `/r/${m.clipLink}`, unknown: `/r/${never.media.clipLink}` },
    { what: "the clip's file", path: `/r/${m.clipLink}.gif`, unknown: `/r/${never.media.clipLink}.gif` },
  ];
}

/** The app's routes as "<METHOD> <path>" with each parameter filled with a placeholder. Only the host gate is left out. */
function everyRoute(): { key: string; method: string; path: string }[] {
  const app = createApp({ config: { publicImageBase: "", setupCode: null } } as Deps);
  const keys = [...new Set(app.routes.filter((r) => !(r.method === "ALL" && r.path === "/*")).map((r) => `${r.method} ${r.path}`))];
  return keys.map((key) => {
    const [method, path] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
    return { key, method, path: path.replace(/:[a-z_]+(\{[^}]*\})?/g, "x0") };
  });
}

/** One request of the route walk, with a token or a session cookie, and an empty JSON body for a change. */
function walk(deps: Deps, r: { method: string; path: string }, cred: { token?: string; session?: { cookie: string; csrf: string } }): Promise<Call> {
  const change = r.method !== "GET" && r.method !== "HEAD";
  const headers = { ...(change ? JSON_HEADERS : {}), ...(cred.session === undefined ? {} : page(cred.session)) };
  return send(deps, r.method, r.path, { token: cred.token ?? null, headers, body: change ? "{}" : undefined });
}

describe("who may disable, enable, read and delete", () => {
  it("only an admin's session: a member's session or token, the admin's token and nobody get the one 404, and nothing changes", SLOW, async () => {
    const { deps } = await makeDeps();
    const admin = await seedAccount(deps, { admin: true });
    const member = await seedAccount(deps, { username: "rook" });
    const target = await seedAccount(deps, { username: "tess" });
    const adminSession = await signInAs(deps, admin.userId);
    const memberSession = await signInAs(deps, member.userId);
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [target.userId]);
    const requests: [string, string, unknown?][] = [
      ["POST", account(target.userId, "/disable")],
      ["POST", account(target.userId, "/enable")],
      ["GET", account(target.userId, "/removal")],
      ["DELETE", account(target.userId), { username: "tess" }],
    ];
    const callers: [string, { token?: string; headers?: Record<string, string> }][] = [
      ["nobody", {}],
      ["a member's token", { token: member.token }],
      ["the admin's own token", { token: admin.token }],
      ["a member's session", { headers: page(memberSession) }],
      ["the admin's session without the anti-forgery header", { headers: { cookie: adminSession.cookie, origin: ORIGIN } }],
      ["the admin's session from another origin", { headers: { ...page(adminSession), origin: "https://elsewhere.example.com" } }],
    ];
    const state = async () => ({
      users: await deps.db.all("SELECT id, status FROM user ORDER BY id"),
      removals: await deps.db.all("SELECT * FROM account_removal"),
      tokens: await deps.db.all("SELECT id, revoked_at FROM api_token ORDER BY id"),
      audit: await deps.db.all("SELECT event FROM audit WHERE event LIKE 'account_%'"),
    });
    const before = await state();
    for (const [method, path, body] of requests) {
      for (const [who, cred] of callers) {
        const r = await send(deps, method, path, { token: cred.token ?? null, headers: { ...(body === undefined ? {} : JSON_HEADERS), ...cred.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        // A method that only reads is no change, so the session without the header passes the guard; the GET is the admin's.
        if (method === "GET" && who.startsWith("the admin's session")) continue;
        expect([r.status, r.text, r.headers.get("cache-control")], `${method} ${path} by ${who}`).toEqual([404, '{"error":"not_found"}', "no-store"]);
      }
    }
    expect(await state()).toEqual(before);
  });
});

describe("disabling an account", () => {
  it("ends its sessions, codes and email change at once, refuses its tokens everywhere, and serves nothing of its workspace; enabling brings back exactly what was there", VERY_SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const requests = publicRequests(b);

    // Before: what everyone sees, and what the side's tokens see.
    const tokenPaths = ["/api/v1/tours", "/api/v1/usage", "/api/v1/me", `/api/v1/media?kind=image`, `/api/v1/media?kind=clip`];
    const look = async () => ({
      public: await Promise.all(requests.map(async (r) => seen(await send(deps, "GET", r.path)))),
      tokens: await Promise.all(tokenPaths.map(async (p) => seen(await send(deps, "GET", p, { token: b.token })))),
    });
    const before = await look();
    for (const [i, r] of requests.entries()) expect(before.public[i].status, r.what).toBe(200);

    // The tour page and the picture route make the one database call they always made, and the picture its one store read.
    expect((await send(deps, "GET", requests[0].path)).calls).toBe(1);
    expect((await send(deps, "GET", requests[1].path)).calls).toBe(2);
    // A link that finds no public tour also asks whether a restricted tour has it (src/restricted.ts).
    expect((await send(deps, "GET", requests[0].unknown)).calls).toBe(2);
    expect((await send(deps, "GET", requests[1].unknown)).calls).toBe(1);

    // A sign-in code made a moment before, and an open email change, are ended with the sessions.
    const code = await createSignInCode(deps, b.userId);
    w.tick();
    const off = await asAdmin(w, "POST", account(b.userId, "/disable"));
    expect([off.status, off.text]).toEqual([204, ""]);
    expect(off.headers.get("cache-control")).toBe("no-store");
    expect(await deps.db.all("SELECT id FROM session WHERE user_id = ? AND revoked_at IS NULL", [b.userId])).toEqual([]);
    expect(await deps.db.all("SELECT id FROM signin_code WHERE user_id = ? AND used_at IS NULL", [b.userId])).toEqual([]);
    expect(await deps.db.all("SELECT id FROM email_change WHERE user_id = ? AND used_at IS NULL", [b.userId])).toEqual([]);
    expect(await redeemSignInCode(deps, code, null, null)).toBeNull();
    // The tokens are kept, not revoked.
    expect(await deps.db.all("SELECT id FROM api_token WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY id", [b.workspaceId])).toEqual(
      [b.ids.tokens.live, b.ids.tokens.connected].sort().map((id) => ({ id })),
    );
    expect(await deps.db.all("SELECT user_id, workspace_id, subject, detail FROM audit WHERE event = 'account_disabled'")).toEqual([{ user_id: a.userId, workspace_id: b.workspaceId, subject: b.userId, detail: null }]);
    // Again: 204, and nothing more is written.
    const audits = await deps.db.all("SELECT id FROM audit");
    expect((await asAdmin(w, "POST", account(b.userId, "/disable"))).status).toBe(204);
    expect(await deps.db.all("SELECT id FROM audit")).toEqual(audits);

    // Nothing of the workspace is served: every public answer is the one for an id that never existed, byte for byte.
    for (const r of requests) expect(seen(await send(deps, "GET", r.path)), r.what).toEqual(seen(await send(deps, "GET", r.unknown)));
    // Asked with an ETag the page had, the page is still the not-found one.
    const etag = before.public[0].headers.find(([k]) => k === "etag")?.[1] ?? "";
    expect(seen(await send(deps, "GET", requests[0].path, { headers: { "if-none-match": etag } }))).toEqual(seen(await send(deps, "GET", requests[0].unknown, { headers: { "if-none-match": etag } })));
    // The checks cost no call more: the page makes the two calls an unknown link makes (the
    // public lookup, then the look for a restricted tour, src/restricted.ts).
    expect((await send(deps, "GET", requests[0].path)).calls).toBe(2);
    expect((await send(deps, "GET", requests[1].path)).calls).toBe(1);

    // Every route, with each of the workspace's tokens and with the account's session (ended, and
    // also as if its end had been missed), answers exactly as with a token or a session nobody has.
    const unknownSecret = "dps_" + "ab".repeat(32);
    const unknownSession = { cookie: `${SESSION_COOKIE}=${unknownSecret}`, csrf: await csrfFor(unknownSecret) };
    const routes = everyRoute();
    expect(routes.length).toBeGreaterThan(60);
    const nobody = newToken();
    const sweep = async (what: string, cred: { token?: string; session?: { cookie: string; csrf: string } }, like: { token?: string; session?: { cookie: string; csrf: string } }) => {
      for (const r of routes) {
        w.tick();
        const theirs = await walk(deps, r, cred);
        const unknown = await walk(deps, r, like);
        expect(seen(theirs), `${r.key} with ${what}`).toEqual(seen(unknown));
      }
    };
    await sweep("the workspace's first token", { token: b.token }, { token: nobody });
    const tokensUsed = await deps.db.all("SELECT id, last_used_at FROM api_token WHERE workspace_id = ? ORDER BY id", [b.workspaceId]);
    await sweep("the account's ended session", { session: b.session }, { session: unknownSession });
    await deps.db.run("UPDATE session SET revoked_at = NULL WHERE id = ?", [b.session.id]);
    await sweep("the account's session, its end undone", { session: b.session }, { session: unknownSession });
    // A refused token is not even marked as used.
    expect(await deps.db.all("SELECT id, last_used_at FROM api_token WHERE workspace_id = ? ORDER BY id", [b.workspaceId])).toEqual(tokensUsed);

    // Asking for a sign-in link answers as for an address nobody has, and makes no code.
    const ask = (email: string) => send(deps, "POST", "/api/v1/signin/request", { headers: { ...JSON_HEADERS, origin: ORIGIN, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ email }) });
    const codes = await deps.db.all("SELECT id FROM signin_code WHERE user_id = ?", [b.userId]);
    expect(seen(await ask(b.email))).toEqual(seen(await ask("nobody-at-all@example.com")));
    expect(await deps.db.all("SELECT id FROM signin_code WHERE user_id = ?", [b.userId])).toEqual(codes);
    // The removal counts are still there for the admin (the world shares an image, a clip and a restricted image).
    const counts = await asAdmin(w, "GET", account(b.userId, "/removal"));
    expect(counts.json).toEqual({ username: null, email: b.email, tours: 5, items: 3, connections: 2, used_bytes: expect.any(Number) });

    // Enabled: 204, only the status changes, and everything public and by token is byte for byte what it was.
    await deps.db.run("UPDATE session SET revoked_at = ? WHERE id = ?", [deps.now(), b.session.id]);
    w.tick();
    const on = await asAdmin(w, "POST", account(b.userId, "/enable"));
    expect([on.status, on.text]).toEqual([204, ""]);
    expect(await deps.db.all("SELECT user_id, subject FROM audit WHERE event = 'account_enabled'")).toEqual([{ user_id: a.userId, subject: b.userId }]);
    expect(await look()).toEqual(before);
    // The sessions stay ended: the person signs in again.
    expect((await send(deps, "GET", "/api/v1/session", { headers: { cookie: b.session.cookie } })).status).toBe(401);
    expect((await signInAs(deps, b.userId)).id).toMatch(/^ses_/);
    expect((await asAdmin(w, "POST", account(b.userId, "/enable"))).status).toBe(204);
  });

  it("a request to connect the app that the account confirmed cannot be collected once it is disabled, and works again for a new request once enabled", SLOW, async () => {
    const { deps } = await makeDeps();
    const admin = await seedAccount(deps, { admin: true });
    const member = await seedAccount(deps);
    const adminSession = await signInAs(deps, admin.userId);
    const memberSession = await signInAs(deps, member.userId);
    const start = async () => (await send(deps, "POST", "/api/v1/connect/start", { headers: JSON_HEADERS, body: JSON.stringify({ device_name: "Laptop" }) })).json;
    const confirm = (code: string) => send(deps, "POST", "/api/v1/connect/confirm", { headers: { ...page(memberSession), ...JSON_HEADERS }, body: JSON.stringify({ user_code: code }) });
    const collect = (device: string) => send(deps, "POST", "/api/v1/connect/token", { headers: JSON_HEADERS, body: JSON.stringify({ device_code: device }) });
    const pending = await start();
    expect((await confirm(pending.user_code)).status).toBe(204);
    expect((await send(deps, "POST", account(member.userId, "/disable"), { headers: page(adminSession) })).status).toBe(204);
    const r = await collect(pending.device_code);
    expect([r.status, r.json.error]).toEqual([410, "expired_code"]);
    expect(await deps.db.all("SELECT id FROM api_token WHERE kind = 'sign_in'")).toEqual([]);
  });
});

describe("refusals", () => {
  it("own account, an account in that state already, an enable while deleting, a wrong body or name, and a delete of an account that is not disabled", SLOW, async () => {
    const { deps } = await makeDeps();
    const admin = await seedAccount(deps, { admin: true, username: "mara" });
    const member = await seedAccount(deps, { username: "rook" });
    const nameless = await seedAccount(deps);
    await uploadTour(deps, member.token, manifestOf([200, 201], "Rook's tour"));
    const s = await signInAs(deps, admin.userId);
    const call = (method: string, path: string, body?: unknown) =>
      send(deps, method, path, { headers: { ...page(s), ...(body === undefined ? {} : JSON_HEADERS) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const code = (r: Call) => [r.status, r.json?.error];
    for (const how of ["/disable", "/enable"]) expect(code(await call("POST", account(admin.userId, how)))).toEqual([409, "own_account"]);
    expect(code(await call("DELETE", account(admin.userId), { username: "mara" }))).toEqual([409, "own_account"]);
    expect(code(await call("DELETE", account(member.userId), { username: "rook" }))).toEqual([409, "not_disabled"]);
    expect((await call("POST", account(member.userId, "/enable"))).status).toBe(204);
    expect((await call("POST", account(member.userId, "/disable"))).status).toBe(204);
    for (const body of ["", "[]", "{}", '{"username":"rook","x":1}', '{"username":1}', "nope"]) expect(code(await call("DELETE", account(member.userId), body)), body).toEqual([400, "bad_request"]);
    for (const name of ["Rook", " rook", "rook ", member.email, ""]) expect(code(await call("DELETE", account(member.userId), { username: name })), name).toEqual([400, "username_mismatch"]);
    // An account with no username is confirmed with its address, exactly as stored.
    expect((await call("POST", account(nameless.userId, "/disable"))).status).toBe(204);
    expect(code(await call("DELETE", account(nameless.userId), { username: nameless.email.toUpperCase() }))).toEqual([400, "username_mismatch"]);
    expect((await call("DELETE", account(nameless.userId), { username: nameless.email })).status).toBe(200);
    // Nothing of a refused delete was recorded or removed.
    expect(await deps.db.all("SELECT * FROM account_removal")).toEqual([]);
    expect(await deps.db.first("SELECT count(*) AS n FROM api_token WHERE workspace_id = ?", [member.workspaceId])).toEqual({ n: 1 });
    // A delete in progress cannot be enabled: a store that fails stops the first request part way.
    const realDelete = deps.drafts.delete.bind(deps.drafts);
    deps.drafts.delete = () => Promise.reject(new Error("the store is down"));
    const log = console.error;
    console.error = () => {};
    try {
      expect(code(await call("DELETE", account(member.userId), { username: "rook" }))).toEqual([500, "cleanup_pending"]);
    } finally {
      console.error = log;
      deps.drafts.delete = realDelete;
    }
    expect(code(await call("POST", account(member.userId, "/enable")))).toEqual([409, "deleting"]);
    const list = (await call("GET", "/api/v1/admin/accounts")).json.accounts as Json[];
    expect(list.find((x) => x.id === member.userId)).toMatchObject({ status: "disabled", deleting: true });
    expect((await call("DELETE", account(member.userId), { username: "rook" })).status).toBe(200);
    expect(code(await call("DELETE", account(member.userId), { username: "rook" }))).toEqual([404, "not_found"]);
    expect(code(await call("POST", account(member.userId, "/enable")))).toEqual([404, "not_found"]);
  });
});

// ---- A delete interrupted at every call ----

/** A small workspace of each kind of thing a delete removes, made through the API, and its account disabled by the admin. */
async function smallWorld(): Promise<{ deps: Deps; keys: { draftKeys: () => Promise<string[]>; publicKeys: () => Promise<string[]> }; admin: { userId: string; session: { cookie: string; csrf: string } }; member: { userId: string; workspaceId: string; email: string } }> {
  // A site that can mail links, so a tour can be made restricted.
  const ctx = await makeDeps({ siteHost: "tours.example.com" });
  const { deps } = ctx;
  let now = 1_800_000_000_000;
  deps.now = () => now;
  const admin = await seedAccount(deps, { admin: true });
  const member = await seedAccount(deps, { username: "rook" });
  const other = await seedAccount(deps);
  const token = member.token;
  // A tour published twice (live and retired pictures), and a tour of the other workspace.
  const published = await uploadTour(deps, token, manifestOf([301, 302], "Published", true), { kind: "new" }, 1);
  for (let i = 0; i < 2; i++) if ((await send(deps, "POST", `/api/v1/tours/${published.tour_id}/publish`, { token })).status !== 200) throw new Error("publish");
  await uploadTour(deps, other.token, manifestOf([401], "Other's"), { kind: "new" }, 2);
  // A restricted tour with two addresses on its list, published twice to the private store
  // (live and retired private pictures), and a public one whose switch to restricted is
  // half done (live public pictures, and private ones already copied).
  const restricted = await uploadTour(deps, token, manifestOf([307, 308], "Restricted", true), { kind: "new" }, 1);
  // Only a session may change who views a tour.
  const memberSession = await signInAs(deps, member.userId);
  const access = (tourId: string, body: Json) => send(deps, "PUT", `/api/v1/tours/${tourId}/access`, { headers: { ...page(memberSession), ...JSON_HEADERS }, body: JSON.stringify(body) });
  if ((await access(restricted.tour_id, { access: "people", viewers: ["ana@example.com", "bo@example.com"] })).status !== 200) throw new Error("restrict");
  for (let i = 0; i < 2; i++) if ((await send(deps, "POST", `/api/v1/tours/${restricted.tour_id}/publish`, { token })).status !== 200) throw new Error("restricted publish");
  const switching = await uploadTour(deps, token, manifestOf(Array.from({ length: 13 }, (_, i) => 320 + i), "Switching", false), { kind: "new" }, 1);
  let pub = await send(deps, "POST", `/api/v1/tours/${switching.tour_id}/publish`, { token });
  while (pub.status === 202) pub = await send(deps, "POST", `/api/v1/tours/${switching.tour_id}/publish`, { token, headers: JSON_HEADERS, body: JSON.stringify({ publish_id: pub.json.publish_id }) });
  if ((await access(switching.tour_id, { access: "me" })).status !== 202) throw new Error("switch");
  // An open upload with one step sent.
  const m = manifestOf([303, 304], "Open");
  const up = (await createUpload(deps, token, m)).json.upload_id as string;
  if ((await putStep(deps, token, up, 1, stepImage(m.steps[0], 1))).status !== 204) throw new Error("step");
  // A tour whose own delete was cut off before its files went.
  const gone = await uploadTour(deps, token, manifestOf([305], "Gone"), { kind: "new" }, 1);
  const broken: Deps = { ...deps, drafts: { ...deps.drafts, delete: () => Promise.reject(new Error("down")) } };
  const log = console.error;
  console.error = () => {};
  try {
    await send(broken, "DELETE", `/api/v1/tours/${gone.tour_id}`, { token });
  } finally {
    console.error = log;
  }
  // An online clip with a preview.
  const made = await send(deps, "POST", "/api/v1/media", { token, headers: JSON_HEADERS, body: JSON.stringify({ kind: "clip", content_type: "image/gif", bytes: 306, width: 32, height: 32, duration_ms: 1000 }) });
  const id = made.json.id as string;
  await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token, body: gif(32, 32, 306, 1) as NonNullable<RequestInit["body"]> });
  await send(deps, "PUT", `/api/v1/media/${id}/preview`, { token, body: logoPng(1000) as NonNullable<RequestInit["body"]> });
  if ((await send(deps, "POST", `/api/v1/media/${id}/commit`, { token })).status !== 200) throw new Error("commit");
  const s = await signInAs(deps, admin.userId);
  await signInAs(deps, member.userId);
  now += 1000;
  if ((await send(deps, "POST", account(member.userId, "/disable"), { headers: page(s) })).status !== 204) throw new Error("disable");
  return { deps, keys: { draftKeys: ctx.draftKeys, publicKeys: ctx.publicKeys }, admin: { userId: admin.userId, session: s }, member };
}

/**
 * Deps whose `n`-th call (counted over every port, from now on) fails once: before it is
 * made ("before"), or after it took effect, as an answer lost on the way back ("after").
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

describe("a delete interrupted at any call", () => {
  it("leaves the account disabled and listed with every file still named by a row, and asking again finishes it, for a failure at every call, before or after it takes effect", VERY_SLOW, async () => {
    for (const when of ["before", "after"] as const) {
      for (let n = 1; ; n++) {
        const { deps, keys, admin, member } = await smallWorld();
        const del = (d: Deps) => send(d, "DELETE", account(member.userId), { headers: { ...page(admin.session), ...JSON_HEADERS }, body: JSON.stringify({ username: "rook" }) });
        const before = await snapshotOf(deps, member, keys);
        const memberKeys = Object.entries(before.files).filter(([, v]) => v !== "missing").map(([k]) => k);
        expect(memberKeys.length, "the small world holds files").toBeGreaterThan(8);
        const other = await deps.db.first<{ id: string }>("SELECT workspace_id AS id FROM membership WHERE user_id NOT IN (?, ?)", [member.userId, admin.userId]);
        const otherBefore = await snapshotOf(deps, { workspaceId: other!.id }, keys);

        const faulty = failingAt(deps, n, when);
        const log = console.error;
        console.error = () => {};
        let r: Call;
        try {
          r = await del(faulty.deps);
          while (r.status === 202 && !faulty.hit()) r = await del(faulty.deps);
        } finally {
          console.error = log;
        }
        const label = `failure ${when} call ${n}`;
        if (!faulty.hit()) {
          // Past the last call: the delete finished without meeting the failure.
          expect(r.status, label).toBe(200);
          expect(n, "the failure was met at least once").toBeGreaterThan(20);
          break;
        }
        // Where it stopped: still listed and disabled (unless the failure came after the last batch took effect), and every file of it still in a store is named by one of its rows.
        const row = await deps.db.first<{ status: string }>("SELECT status FROM user WHERE id = ?", [member.userId]);
        if (row !== null) {
          expect(row.status, label).toBe("disabled");
          const listed = (await send(deps, "GET", "/api/v1/admin/accounts", { headers: page(admin.session) })).json.accounts as Json[];
          expect(listed.find((x) => x.id === member.userId), label).toMatchObject({ status: "disabled" });
          const now = await snapshotOf(deps, member, keys);
          const stored = new Set([...(await keys.draftKeys()), ...(await keys.publicKeys())]);
          for (const key of memberKeys) if (stored.has(key)) expect(Object.keys(now.files), `${label}: ${key} is stored but named by no row`).toContain(key);
        }
        // Asked again with nothing failing, it finishes (a delete whose last batch took effect answers 404: gone).
        for (let i = 0; i < 10; i++) {
          r = await del(deps);
          if (r.status === 200 || r.status === 404) break;
          expect(r.status, `${label}: ${r.text}`).toBe(202);
        }
        expect([200, 404], label).toContain(r.status);
        expect(await deps.db.first("SELECT id FROM user WHERE id = ?", [member.userId]), label).toBeNull();
        expect(await deps.db.all("SELECT tour_id FROM tour_viewer UNION ALL SELECT tour_id FROM access_switch"), `${label}: rows of who may view a tour left`).toEqual([]);
        const stored = new Set([...(await keys.draftKeys()), ...(await keys.publicKeys())]);
        expect(memberKeys.filter((k) => stored.has(k)), `${label}: files left`).toEqual([]);
        expect(await snapshotOf(deps, { workspaceId: other!.id }, keys), label).toEqual(otherBefore);
        expect(await deps.db.all("SELECT event FROM audit WHERE event = 'account_deleted'"), label).toEqual([{ event: "account_deleted" }]);
      }
    }
  });
});

// ---- The call budget ----

describe("the call budget", () => {
  it("every request of a delete of a workspace with many tours and a 27-part clip stays within the budget, and reports its progress", VERY_SLOW, async () => {
    const { deps } = await makeDeps();
    const admin = await seedAccount(deps, { admin: true });
    const member = await seedAccount(deps, { username: "rook" });
    const s = await signInAs(deps, admin.userId);
    // 24 tours, every other one published.
    for (let i = 0; i < 24; i++) {
      const t = await uploadTour(deps, member.token, manifestOf([500 + i, 600 + i], `Tour ${i}`, i % 3 === 0), { kind: "new" }, i);
      if (i % 2 === 0) expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: member.token })).status).toBe(200);
    }
    // A clip of 27 parts (the most a 50 MB clip has) and its preview, with small stand-in files: the rows are what the delete reads.
    const id = newId("med");
    const now = deps.now();
    await deps.db.run(
      "INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, created_at, online_at) VALUES (?, ?, ?, 'clip', 'video/mp4', 52428800, 27, 64, 64, 1000, NULL, 'online', ?, ?)",
      [id, member.workspaceId, newLinkId(), now, now],
    );
    const objects: string[] = [];
    for (let n = -1; n < 27; n++) {
      const claim = newId("up").slice(3);
      await deps.db.run("INSERT INTO media_object (media_id, claim, n, ext, bytes, claimed_at, stored_at, current) VALUES (?, ?, ?, ?, ?, ?, ?, 1)", [id, claim, n, n === -1 ? "png" : null, n === -1 ? 100 : n === 26 ? 428800 : 2000000, now, now]);
      const key = n === -1 ? `m/${id}/preview.${claim}.png` : `m/${id}/part-${String(n).padStart(3, "0")}.${claim}`;
      await deps.drafts.put(key, new Uint8Array([n + 2]), { contentType: "application/octet-stream", cacheControl: "no-store" });
      objects.push(key);
    }
    expect((await send(deps, "POST", account(member.userId, "/disable"), { headers: page(s) })).status).toBe(204);
    const del = () => send(deps, "DELETE", account(member.userId), { headers: { ...page(s), ...JSON_HEADERS }, body: JSON.stringify({ username: "rook" }) });
    let r = await del();
    const progress: number[] = [];
    let total = -1;
    let requests = 1;
    while (r.status === 202) {
      expect(r.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
      if (total === -1) total = r.json.total;
      expect(r.json.total).toBe(total);
      progress.push(r.json.done);
      r = await del();
      requests += 1;
      expect(requests).toBeLessThan(40);
    }
    expect(r.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ deleted: true });
    // Several requests were needed, the count only grew, and never past the total.
    expect(progress.length).toBeGreaterThan(1);
    expect(total).toBeGreaterThan(24 * 2 + 27);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    for (const p of progress) expect(p).toBeLessThanOrEqual(total);
    for (const key of objects) expect(await deps.drafts.get(key), key).toBeNull();
  });
});

// ---- After a delete ----

describe("after a delete", () => {
  it("the address and the username can be used by a new account", SLOW, async () => {
    const { deps } = await makeDeps();
    const admin = await seedAccount(deps, { admin: true });
    const member = await seedAccount(deps, { username: "rook" });
    const s = await signInAs(deps, admin.userId);
    expect((await send(deps, "POST", account(member.userId, "/disable"), { headers: page(s) })).status).toBe(204);
    expect((await send(deps, "DELETE", account(member.userId), { headers: { ...page(s), ...JSON_HEADERS }, body: JSON.stringify({ username: "rook" }) })).status).toBe(200);
    const fresh = { ws: newId("ws"), user: newId("usr") };
    await deps.db.batch([
      { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, 'New', ?)", params: [fresh.ws, deps.now()] },
      { sql: "INSERT INTO user (id, workspace_id, email, username, created_at) VALUES (?, ?, ?, 'rook', ?)", params: [fresh.user, fresh.ws, member.email, deps.now()] },
      { sql: "INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", params: [fresh.ws, fresh.user, deps.now()] },
    ]);
    expect(await deps.db.first("SELECT id, username FROM user WHERE email = ?", [member.email])).toEqual({ id: fresh.user, username: "rook" });
    // The record keeps that it happened, by whom, and the ids, and nothing else of the person.
    const record = await deps.db.all<Json>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event = 'account_deleted'");
    expect(record).toEqual([{ event: "account_deleted", user_id: admin.userId, workspace_id: member.workspaceId, subject: member.userId, detail: null }]);
    expect(JSON.stringify(await deps.db.all("SELECT * FROM audit"))).not.toContain(member.email);
    // A slug is no help either: nothing answers it.
    expect((await send(deps, "GET", `/t/${newSlug()}`)).status).toBe(404);
  });
});

// ---- A workspace of more than one account ----

describe("a workspace of more than one account", () => {
  /** A member's workspace that a second account joins: its own membership moved there, as a team would have it. */
  async function team() {
    const { deps } = await makeDeps();
    const admin = await seedAccount(deps, { admin: true });
    const owner = await seedAccount(deps, { username: "rook" });
    const second = await seedAccount(deps, { username: "tess" });
    const s = await signInAs(deps, admin.userId);
    const tour = await uploadTour(deps, owner.token, manifestOf([700, 701], "Shared tour"));
    expect((await send(deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token: owner.token })).status).toBe(200);
    await deps.db.run("UPDATE membership SET workspace_id = ? WHERE user_id = ?", [owner.workspaceId, second.userId]);
    const slug = (await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [tour.tour_id]))!.slug;
    return { deps, admin, owner, second, s, tour, slug };
  }

  it("deleting one of its accounts is refused with shared_workspace, and nothing of anyone's is changed", SLOW, async () => {
    const { deps, owner, second, s, slug } = await team();
    const call = (method: string, path: string, json?: unknown) => send(deps, method, path, { headers: { ...page(s), ...(json === undefined ? {} : JSON_HEADERS) }, body: json === undefined ? undefined : JSON.stringify(json) });
    for (const [target, name] of [[owner.userId, "rook"], [second.userId, "tess"]] as const) {
      expect((await call("POST", account(target, "/disable"))).status).toBe(204);
      const dump = async () => Object.fromEntries(await Promise.all(["user", "membership", "workspace", "tour", "step", "snapshot_object", "api_token", "account_removal", "tour_deletion"].map(async (t) => [t, await deps.db.all(`SELECT * FROM ${t}`)])));
      const before = await dump();
      const r = await call("DELETE", account(target), { username: name });
      expect([r.status, r.json?.error], name).toEqual([409, "shared_workspace"]);
      expect(await dump(), name).toEqual(before);
      expect((await call("POST", account(target, "/enable"))).status).toBe(204);
    }
    // Both accounts enabled again: the workspace's tour and its page are as they were.
    expect((await send(deps, "GET", `/t/${slug}`)).status).toBe(200);
    expect((await send(deps, "GET", "/api/v1/tours", { token: owner.token })).json.tours).toHaveLength(1);
  });

  it("disabling one of its accounts hides the whole workspace, its links and its tokens, for every member: today's rule, to be revisited with teams", SLOW, async () => {
    const { deps, owner, second, s, slug } = await team();
    expect((await send(deps, "POST", account(second.userId, "/disable"), { headers: page(s) })).status).toBe(204);
    expect((await send(deps, "GET", `/t/${slug}`)).status).toBe(404);
    expect((await send(deps, "GET", "/api/v1/tours", { token: owner.token })).status).toBe(401);
    expect((await send(deps, "POST", account(second.userId, "/enable"), { headers: page(s) })).status).toBe(204);
    expect((await send(deps, "GET", `/t/${slug}`)).status).toBe(200);
    expect((await send(deps, "GET", "/api/v1/tours", { token: owner.token })).status).toBe(200);
  });
});

// ---- Invites ----

describe("invites", () => {
  it("a delete removes an invite to the account's address, and an invite it sent stays valid and can be accepted, with no inviter named", SLOW, async () => {
    const { deps, mail } = await makeDeps({ siteHost: "tours.example.com" });
    const admin = await seedAccount(deps, { admin: true });
    const sender = await seedAccount(deps, { admin: true, username: "rook" });
    const s = await signInAs(deps, admin.userId);
    const senderSession = await signInAs(deps, sender.userId);
    const SITE = "https://tours.example.com";
    // The second admin invites an address through the API; its code is in the mail.
    const sent = await send(deps, "POST", "/api/v1/admin/invites", { headers: { ...page(senderSession), origin: SITE, ...JSON_HEADERS }, body: JSON.stringify({ email: "friend@example.com" }), origin: SITE });
    expect(sent.status, sent.text).toBe(201);
    const code = (mail.sent[mail.sent.length - 1].text.match(/dpi_[0-9a-f]{40}/) ?? [""])[0];
    const check = () => send(deps, "POST", "/api/v1/invite/check", { headers: { ...JSON_HEADERS, origin: SITE }, body: JSON.stringify({ code }), origin: SITE });
    expect((await check()).json.invited_by).toBe("rook");
    // An invite to the sender's own address cannot be made through the API while the account exists; one is written here.
    await deps.db.run("INSERT INTO invite (id, email, code_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("inv"), sender.email, "e".repeat(64), admin.userId, deps.now(), deps.now() + 86_400_000]);

    expect((await send(deps, "POST", account(sender.userId, "/disable"), { headers: page(s) })).status).toBe(204);
    // Disabling cancels nothing there.
    expect(await deps.db.all("SELECT email, invited_by FROM invite ORDER BY email")).toEqual([
      { email: sender.email, invited_by: admin.userId },
      { email: "friend@example.com", invited_by: sender.userId },
    ].sort((x, y) => (x.email < y.email ? -1 : 1)));
    const r = await send(deps, "DELETE", account(sender.userId), { headers: { ...page(s), ...JSON_HEADERS }, body: JSON.stringify({ username: "rook" }) });
    expect(r.status, r.text).toBe(200);
    expect(await deps.db.all("SELECT id, email, invited_by FROM invite ORDER BY email")).toEqual([{ id: sent.json.id, email: "friend@example.com", invited_by: null }]);

    // The invite it sent still works: its page names no inviter, and accepting it makes the account.
    const found = await check();
    expect(found.json).toEqual({ email: "friend@example.com", invited_by: null, expires_at: expect.any(Number) });
    const accepted = await send(deps, "POST", "/api/v1/invite/accept", { headers: { ...JSON_HEADERS, origin: SITE }, body: JSON.stringify({ code, username: "friend" }), origin: SITE });
    expect([accepted.status, accepted.json]).toEqual([200, { ok: true }]);
    expect(await deps.db.first("SELECT username FROM user WHERE email = 'friend@example.com'")).toEqual({ username: "friend" });
  });
});
