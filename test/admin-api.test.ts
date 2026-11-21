// The admin API (src/admin-api.ts) on both targets: every account's storage use, and the
// allowance of one workspace. The owner needs an overview of how each account uses its
// room, and must not be able to open any of its links or content: an answer holds the
// account's id, username, email, status, whether it is the admin, when it was made, its
// workspace's id and name, its tour count, its usage with the breakdown GET /api/v1/usage
// gives the account itself, and its allowance; never a tour, chapter, step, picture, token
// or session.
//
// Most tests run in the cross-workspace suite's world (test/isolation-world.ts): two
// workspaces that each hold one of everything, the first one's account the site's admin.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { ADMIN_PAGE, decodeAccountCursor, encodeAccountCursor } from "../src/admin-api.ts";
import { hashToken } from "../src/auth.ts";
import type { Hosts } from "../src/hosts.ts";
import type { Deps, Stmt } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, send, type Call, type Json } from "./bundle.ts";
import { dumpOf, manifestOf, namesIn, needlesOf, snapshotOf, world, type Side, type World } from "./isolation-world.ts";

const SLOW = { timeout: 120_000 };
const ACCOUNTS = "/api/v1/admin/accounts";
const SUMMARY = "/api/v1/admin/summary";
const workspacePath = (id: string) => `/api/v1/admin/workspaces/${id}`;
const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const MAX = 9007199254740991;

/** The keys of each answer, exactly. */
const LIST_KEYS = ["accounts", "next"];
const ACCOUNT_KEYS = ["admin", "allowance_bytes", "counted", "created_at", "deleting", "email", "id", "over", "status", "storage_allowance_bytes", "terms", "tours", "used_bytes", "username", "workspace_id", "workspace_name"];
const COUNTED_KEYS = ["gifs", "images", "logos", "pictures", "uploads_in_progress"];
const SUMMARY_KEYS = ["accounts", "standard_allowance_bytes", "used_bytes"];
const SET_KEYS = ["allowance_bytes", "over", "storage_allowance_bytes", "used_bytes", "workspace_id"];

/** The one answer every refusal of an admin route is. */
const REFUSED = {
  status: 404,
  headers: [
    ["cache-control", "no-store"],
    ["content-type", "application/json"],
    ["x-content-type-options", "nosniff"],
  ],
  body: '{"error":"not_found"}',
};

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

async function build(config?: Parameters<typeof makeDeps>[0]): Promise<World> {
  const ctx = await makeDeps(config);
  return world(ctx.deps, { draftKeys: ctx.draftKeys, publicKeys: ctx.publicKeys });
}

/** The headers the site's own page sends with a session: the cookie, its anti-forgery value, and where it comes from. */
function page(session: { cookie: string; csrf: string }, origin = ORIGIN): Record<string, string> {
  return { cookie: session.cookie, "x-csrf-token": session.csrf, origin, "sec-fetch-site": "same-origin" };
}

type Ask = { headers?: Record<string, string>; token?: string | null; json?: unknown; body?: string; origin?: string };

function ask(deps: Deps, method: string, path: string, opts: Ask = {}): Promise<Call> {
  const body = opts.body ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
  const headers = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...opts.headers };
  return send(deps, method, path, { token: opts.token ?? null, body, headers, origin: opts.origin });
}

/** A new session of the account, made as completing a sign-in makes one: its cookie and anti-forgery value. */
async function signInAs(deps: Deps, userId: string): Promise<{ id: string; cookie: string; csrf: string }> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { id: made.sessionId, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** The admin's list, asked with the admin's session. */
const list = (w: World, query = "") => ask(w.deps, "GET", ACCOUNTS + query, { headers: page(w.a.session) });
/** Sets a workspace's allowance with the admin's session. */
const setAllowance = (w: World, workspaceId: string, value: unknown) => ask(w.deps, "PATCH", workspacePath(workspaceId), { headers: page(w.a.session), json: { storage_allowance_bytes: value } });
/** What GET /api/v1/usage answers the side itself, by its own token. */
const usageOf = async (w: World, side: Side) => (await send(w.deps, "GET", "/api/v1/usage", { token: side.token })).json as Json;
/** The numbers of a usage answer's counted, added up. */
const sumCounted = (u: Json) => Object.values(u.counted as Record<string, number>).reduce((x, y) => x + y, 0);

/**
 * Everything of a side an admin answer must never hold: its tours' ids, titles and slugs,
 * its chapters, steps and pictures by every name, its uploads, tokens, sessions and their
 * secrets, and its workspace's name. What an admin answer may name of it is left out: the
 * account's id and email and the workspace's id, and for the list of accounts alone
 * (`listed`), the workspace's name, which the admin page's Workspace column shows.
 */
async function forbiddenOf(w: World, side: Side, opts: { listed?: true } = {}): Promise<string[]> {
  const s = await snapshotOf(w.deps, side, w.keys);
  const all = needlesOf(s, [side.token, side.revokedToken, side.tokenId, side.revokedTokenId, side.workspaceName, side.session.secret, side.session.csrf, side.session.id, ...namesIn(side.ids)]);
  const allowed = [side.userId, side.workspaceId, side.email, ...(opts.listed ? [side.workspaceName] : [])];
  return all.filter((n) => !allowed.includes(n));
}

function expectNothingOf(text: string, needles: string[], what: string): void {
  for (const n of needles) expect(text.includes(n), `${what} holds ${n}`).toBe(false);
}

describe("the admin's list of accounts", () => {
  it("the admin sees every account with its tour count, usage and allowance, and nothing else of its workspace", SLOW, async () => {
    const w = await build();
    const r = await list(w);
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(r.json).sort()).toEqual(LIST_KEYS);
    expect(r.json.next).toBeNull();
    expect(r.json.accounts).toHaveLength(2);
    for (const account of r.json.accounts as Json[]) {
      expect(Object.keys(account).sort()).toEqual(ACCOUNT_KEYS);
      expect(Object.keys(account.counted).sort()).toEqual(COUNTED_KEYS);
    }

    // Each account, in the order they were made, with the very numbers its own usage answer gives.
    for (const [i, side] of [w.a, w.b].entries()) {
      const row = await w.deps.db.first<{ created_at: number }>("SELECT created_at FROM user WHERE id = ?", [side.userId]);
      const own = await usageOf(w, side);
      expect(r.json.accounts[i]).toEqual({
        id: side.userId,
        username: null,
        email: side.email,
        status: "active",
        admin: side === w.a,
        created_at: row!.created_at,
        deleting: false,
        workspace_id: side.workspaceId,
        workspace_name: side.workspaceName,
        tours: own.tours,
        used_bytes: own.used_bytes,
        allowance_bytes: own.allowance_bytes,
        storage_allowance_bytes: null,
        // The site's terms (0.1.53): nobody in this world has agreed to any.
        terms: null,
        over: own.over,
        counted: own.counted,
      });
      expect(own.used_bytes).toBeGreaterThan(0);
      expect(own.tours).toBe(5);
      // The shared items are in the totals, as two numbers of bytes and nothing more: each
      // kind's bytes with previews and claims that are not current, the unfinished item included, and the breakdown adds up.
      const items = await w.deps.db.all<{ kind: string; n: number }>(
        "SELECT m.kind, sum(m.bytes + (SELECT coalesce(sum(o.bytes), 0) FROM media_object o WHERE o.media_id = m.id AND (o.current = 0 OR o.n = -1))) AS n FROM media m WHERE m.workspace_id = ? GROUP BY m.kind ORDER BY m.kind",
        [side.workspaceId],
      );
      expect(items.map((x) => x.kind)).toEqual(["clip", "image"]);
      const account = r.json.accounts[i] as Json;
      expect([account.counted.gifs, account.counted.images]).toEqual(items.map((x) => x.n));
      expect(sumCounted(account)).toBe(account.used_bytes);
      for (const k of ["images", "gifs", "largest", "items", "media"]) expect(k in account, k).toBe(false);
    }

    // Nothing of either workspace's content: no tour, chapter, step, picture, upload, token
    // or session, by any of its names. The workspace's name is the one name it carries.
    for (const side of [w.a, w.b]) {
      const needles = await forbiddenOf(w, side, { listed: true });
      // The needles are there to be found: ids, titles, slugs, picture names, secrets.
      for (const n of [side.ids.published.tour, side.ids.published.slug, `${side.name} published tour`, side.ids.published.publicName, side.ids.draft.step, side.ids.draft.chapter, side.ids.upload, side.token, side.session.id]) {
        expect(needles).toContain(n);
      }
      // Its shared items too: their ids, links and titles, finished or not.
      const m = side.ids.media;
      for (const n of [m.image, m.clip, m.uploading, m.imageLink, m.clipLink, m.uploadingLink, `${side.name} shared image`, `${side.name} shared clip`, `${side.name} unfinished item`]) {
        expect(needles).toContain(n);
        expect(r.text.includes(n), `the list holds ${n}`).toBe(false);
      }
      expect(needles).not.toContain(side.workspaceName);
      expect((await forbiddenOf(w, side)).includes(side.workspaceName), "every other admin answer is still checked for the name").toBe(true);
      expect(needles.length).toBeGreaterThan(80);
      expectNothingOf(r.text, needles, "the list");
    }
  });

  it("the workspace's name is the stored text as it is, markup and all, as a JSON string", async () => {
    const { deps } = await makeDeps();
    const admin = await seedAccount(deps, { admin: true });
    const member = await seedAccount(deps);
    const name = '<img src=x onerror="alert(1)"> & </td>';
    await deps.db.run("UPDATE workspace SET name = ? WHERE id = ?", [name, member.workspaceId]);
    const session = await signInAs(deps, admin.userId);
    const r = await ask(deps, "GET", ACCOUNTS, { headers: page(session) });
    expect(r.status, r.text).toBe(200);
    expect((r.json.accounts as Json[]).map((a) => [a.id, a.workspace_id, a.workspace_name])).toEqual([
      [admin.userId, admin.workspaceId, "Account"],
      [member.userId, member.workspaceId, name],
    ]);
    expect(r.headers.get("content-type")).toBe("application/json");
  });

  it("the list pages by 100", SLOW, async () => {
    const { deps } = await makeDeps();
    expect(ADMIN_PAGE).toBe(100);
    const admin = await seedAccount(deps, { admin: true });
    const ids = [admin.userId];
    for (let i = 0; i < 204; i++) ids.push((await seedAccount(deps)).userId);
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), null, null);
    if (made === null) throw new Error("the sign-in was refused");
    const headers = page({ cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) });

    const pages: Json[] = [];
    let after: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = await ask(deps, "GET", ACCOUNTS + (after === null ? "" : `?after=${after}`), { headers });
      expect(r.status, r.text).toBe(200);
      pages.push(r.json);
      after = r.json.next;
      if (after === null) break;
    }
    expect(pages.map((p) => p.accounts.length)).toEqual([100, 100, 5]);
    // `next` is the cursor of the last account of a page that has more after it: its creation time and id.
    expect(pages[0].next).toBe(encodeAccountCursor(pages[0].accounts[99].created_at, pages[0].accounts[99].id));
    expect(pages[1].next).toBe(encodeAccountCursor(pages[1].accounts[99].created_at, pages[1].accounts[99].id));
    expect(decodeAccountCursor(pages[0].next)).toEqual({ createdAt: pages[0].accounts[99].created_at, id: pages[0].accounts[99].id });
    expect(pages[2].next).toBeNull();
    // Every account once, in the order they were made (the id breaks a tie).
    const listed = pages.flatMap((p) => p.accounts as Json[]);
    expect(listed.map((a) => a.id).sort()).toEqual([...ids].sort());
    const order = await deps.db.all<{ id: string }>("SELECT id FROM user ORDER BY created_at, id");
    expect(listed.map((a) => a.id)).toEqual(order.map((o) => o.id));

    // Anything that is not such a cursor is refused, an account id alone (the cursor before 0.1.33) included.
    for (const bad of ["x", "usr_123", admin.userId, "tour_0123456789abcdef01234567", "usr_0123456789ABCDEF01234567", `${admin.userId}&after=${admin.userId}`, btoa("1.usr_123"), btoa(`-1.${admin.userId}`)]) {
      const r = await ask(deps, "GET", `${ACCOUNTS}?after=${encodeURIComponent(bad)}`, { headers });
      expect([r.status, r.json?.error], bad).toEqual([400, "bad_cursor"]);
    }
    // A cursor past every account lists nobody.
    const nobody = await ask(deps, "GET", `${ACCOUNTS}?after=${encodeAccountCursor(Number.MAX_SAFE_INTEGER, `usr_${"0".repeat(24)}`)}`, { headers });
    expect(nobody.json).toEqual({ accounts: [], next: null });

    // The account a cursor was made from is deleted between two pages: the next page is the rest all the same.
    const cursorAccount = pages[0].accounts[99].id as string;
    const name = `gone-${cursorAccount.slice(4, 12)}`;
    await deps.db.run("UPDATE user SET username = ? WHERE id = ?", [name, cursorAccount]);
    expect((await ask(deps, "POST", `${ACCOUNTS}/${cursorAccount}/disable`, { headers })).status).toBe(204);
    let gone = await ask(deps, "DELETE", `${ACCOUNTS}/${cursorAccount}`, { headers, json: { username: name } });
    for (let i = 0; gone.status === 202 && i < 5; i++) gone = await ask(deps, "DELETE", `${ACCOUNTS}/${cursorAccount}`, { headers, json: { username: name } });
    expect(gone.status, gone.text).toBe(200);
    const rest = await ask(deps, "GET", `${ACCOUNTS}?after=${pages[0].next}`, { headers });
    expect(rest.status, rest.text).toBe(200);
    expect(rest.json.accounts.map((a: Json) => a.id)).toEqual(pages[1].accounts.map((a: Json) => a.id));
  });
});

describe("the admin's summary", () => {
  it("answers the number of accounts, the bytes they use in all and the standard allowance, and nothing of any workspace", SLOW, async () => {
    const w = await build();
    const r = await ask(w.deps, "GET", SUMMARY, { headers: page(w.a.session) });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(r.json).sort()).toEqual(SUMMARY_KEYS);
    // The bytes in all are the sum of every account's own usage answer, and of the list's figures.
    const own = [await usageOf(w, w.a), await usageOf(w, w.b)];
    const listed = (await list(w)).json.accounts as Json[];
    expect(r.json).toEqual({ accounts: 2, used_bytes: own[0].used_bytes + own[1].used_bytes, standard_allowance_bytes: null });
    expect(r.json.used_bytes).toBe(listed.reduce((n, a) => n + (a.used_bytes as number), 0));
    expect(r.json.used_bytes).toBeGreaterThan(0);
    // The sum takes in the shared items in every state, with their previews and claims that are not current.
    const items = await w.deps.db.first<{ n: number }>("SELECT sum(m.bytes + (SELECT coalesce(sum(o.bytes), 0) FROM media_object o WHERE o.media_id = m.id AND (o.current = 0 OR o.n = -1))) AS n FROM media m");
    expect(items!.n).toBeGreaterThan(0);
    expect(r.json.used_bytes).toBe(own.reduce((n, u) => n + sumCounted(u), 0));
    expect(own.reduce((n, u) => n + (u.counted.images as number) + (u.counted.gifs as number), 0)).toBe(items!.n);
    // A workspace's own allowance is not the standard one.
    expect((await setAllowance(w, w.b.workspaceId, 5000)).status).toBe(200);
    expect((await ask(w.deps, "GET", SUMMARY, { headers: page(w.a.session) })).json.standard_allowance_bytes).toBeNull();
    for (const side of [w.a, w.b]) expectNothingOf(r.text, await forbiddenOf(w, side), "the summary");
    // HEAD of it is answered too, as for the list.
    expect((await ask(w.deps, "HEAD", SUMMARY, { headers: page(w.a.session) })).status).toBe(200);
  });

  it("the standard allowance is the site's setting, and the count and sum take in every account", SLOW, async () => {
    const { deps, calls } = await makeDeps({ storageAllowanceBytes: 1_073_741_824 });
    const admin = await seedAccount(deps, { admin: true });
    const session = await signInAs(deps, admin.userId);
    const summary = async () => {
      const before = calls();
      const r = await ask(deps, "GET", SUMMARY, { headers: page(session) });
      expect(r.status, r.text).toBe(200);
      return { json: r.json, calls: calls() - before };
    };
    const first = await summary();
    expect(first.json).toEqual({ accounts: 1, used_bytes: 0, standard_allowance_bytes: 1_073_741_824 });
    // More accounts, one with an open upload (its room counts, as in its usage): the same number of calls.
    const member = await seedAccount(deps);
    await seedAccount(deps);
    const m = manifestOf([700, 300], "Member tour");
    const open = await send(deps, "POST", "/api/v1/uploads", { token: member.token, body: JSON.stringify({ manifest: m, target: { kind: "new" } }), headers: { "content-type": "application/json" } });
    expect(open.status, open.text).toBe(201);
    const later = await summary();
    expect(later.json).toEqual({ accounts: 3, used_bytes: 1000, standard_allowance_bytes: 1_073_741_824 });
    expect(later.calls).toBe(first.calls);
  });
});

describe("who may call an admin route", () => {
  /** Each admin route, with a request that would change or show something for the admin. */
  const routes = (w: World): { what: string; method: string; path: string; json?: unknown }[] => [
    { what: "the list", method: "GET", path: ACCOUNTS },
    { what: "the summary", method: "GET", path: SUMMARY },
    { what: "the allowance", method: "PATCH", path: workspacePath(w.b.workspaceId), json: { storage_allowance_bytes: 1 } },
  ];

  it("a member's session, any token and no credential all get not found", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const nobodyCookie = "dps_" + "0".repeat(64);
    const callers: [string, Ask][] = [
      ["no credential", {}],
      ["a member's session", { headers: page(b.session) }],
      ["a member's token", { token: b.token }],
      ["the admin's own workspace's token", { token: a.token }],
      ["the admin's revoked token", { token: a.revokedToken }],
      ["the admin's session together with the admin's token", { headers: page(a.session), token: a.token }],
      ["a session nobody was given", { headers: page({ cookie: `${SESSION_COOKIE}=${nobodyCookie}`, csrf: await csrfFor(nobodyCookie) }) }],
      ["the admin's session id as the cookie", { headers: page({ cookie: `${SESSION_COOKIE}=${a.session.id}`, csrf: a.session.csrf }) }],
      ["the hash of the admin's token as a token", { token: await hashToken(a.token) }],
    ];
    // Two more sessions of the admin: one signed out, one past its end.
    const revoked = await signInAs(deps, a.userId);
    const expired = await signInAs(deps, a.userId);
    await deps.db.run("UPDATE session SET revoked_at = ? WHERE id = ?", [deps.now(), revoked.id]);
    await deps.db.run("UPDATE session SET expires_at = ? WHERE id = ?", [deps.now() - 1, expired.id]);
    callers.push(["the admin's signed-out session", { headers: page(revoked) }], ["the admin's expired session", { headers: page(expired) }]);
    const before = await dumpOf(deps, w.keys, { files: true, touched: [a.session.id, b.session.id] });
    for (const route of routes(w)) {
      for (const [who, opts] of callers) {
        w.tick();
        const r = await ask(deps, route.method, route.path, { ...opts, json: route.json });
        expect(seen(r), `${route.what}: ${who}`).toEqual(REFUSED);
      }
    }
    // A demoted admin is a member like any other.
    await deps.db.run("UPDATE user SET is_admin = 0 WHERE id = ?", [a.userId]);
    for (const route of routes(w)) expect(seen(await ask(deps, route.method, route.path, { headers: page(a.session), json: route.json })), `${route.what}: a former admin`).toEqual(REFUSED);
    await deps.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [a.userId]);
    // So is a disabled admin: nobody at all.
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    for (const route of routes(w)) expect(seen(await ask(deps, route.method, route.path, { headers: page(a.session), json: route.json })), `${route.what}: a disabled admin`).toEqual(REFUSED);
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [a.userId]);
    // HEAD of the list: the same status and headers, without the body.
    for (const [who, opts] of [["nobody", {}], ["a member's session", { headers: page(b.session) }], ["the admin's own token", { token: a.token }]] as [string, Ask][]) {
      const r = await ask(deps, "HEAD", ACCOUNTS, opts);
      expect(seen(r), `HEAD of the list: ${who}`).toEqual({ ...REFUSED, body: "" });
    }
    // Nothing changed, nothing was stored.
    expect(w.writes()).toEqual([]);
    expect(await dumpOf(deps, w.keys, { files: true, touched: [a.session.id, b.session.id] })).toEqual(before);
    // The admin's session itself is answered: the refusals were about the caller.
    for (const route of routes(w)) expect((await ask(deps, route.method, route.path, { headers: page(a.session), json: route.json })).status, route.what).toBe(200);
    expect((await ask(deps, "HEAD", ACCOUNTS, { headers: page(a.session) })).status).toBe(200);
  });

  it("the change needs the anti-forgery header", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const path = workspacePath(b.workspaceId);
    const json = { storage_allowance_bytes: 1 };
    const { "x-csrf-token": _csrf, ...noCsrf } = page(a.session);
    const { origin: _origin, ...noOrigin } = page(a.session);
    const variants: [string, Record<string, string>][] = [
      ["no anti-forgery header", noCsrf],
      ["another session's anti-forgery value", { ...page(a.session), "x-csrf-token": b.session.csrf }],
      ["the anti-forgery value in capitals", { ...page(a.session), "x-csrf-token": a.session.csrf.toUpperCase() }],
      ["no Origin", noOrigin],
      ["the Origin of another site", page(a.session, "https://evil.example.net")],
      ["the Origin of the plain-http address", page(a.session, "http://tours.example.com")],
      ["a browser that says the request came from another site", { ...page(a.session), "sec-fetch-site": "cross-site" }],
      ["a browser that says the request came from a sibling address", { ...page(a.session), "sec-fetch-site": "same-site" }],
    ];
    const before = await dumpOf(deps, w.keys, { touched: [a.session.id] });
    for (const [what, headers] of variants) {
      w.tick();
      expect(seen(await ask(deps, "PATCH", path, { headers, json })), what).toEqual(REFUSED);
      expect(await dumpOf(deps, w.keys, { touched: [a.session.id] }), what).toEqual(before);
    }
    // The list changes nothing, so it needs none of them: a page reads it with the cookie alone.
    expect((await ask(deps, "GET", ACCOUNTS, { headers: { cookie: a.session.cookie } })).status).toBe(200);
    // With all of them the change is made.
    expect((await ask(deps, "PATCH", path, { headers: page(a.session), json })).status).toBe(200);
  });

  it("no admin route answers on the tours address, and the refusal there is the same for everyone", SLOW, async () => {
    const w = await build({ hosts: HOSTS });
    const { deps, a, b } = w;
    const before = await dumpOf(deps, w.keys, { touched: [a.session.id] });
    // The tours address's answer for a route only the app address has (the host gate's),
    // whoever asks: the same status and body as every refusal on the app address. Its
    // headers are the gate's, which lack only x-content-type-options; they say which
    // address was asked, which the caller knows, and nothing of the caller.
    const ON_TOURS = { ...REFUSED, headers: REFUSED.headers.filter(([name]) => name !== "x-content-type-options") };
    for (const route of routes(w)) {
      expect(seen(await ask(deps, route.method, route.path, { origin: APP, json: route.json })), `${route.what}: nobody on the app address`).toEqual(REFUSED);
      expect(seen(await ask(deps, route.method, route.path, { origin: APP, headers: page(b.session, APP), json: route.json })), `${route.what}: a member on the app address`).toEqual(REFUSED);
      for (const [who, opts] of [
        ["nobody", {}],
        ["the admin's session", { headers: page(a.session, TOURS) }],
        ["the admin's session, as if from the app address's page", { headers: page(a.session, APP) }],
        ["a member's session", { headers: page(b.session, TOURS) }],
        ["the admin's own token", { token: a.token }],
      ] as [string, Ask][]) {
        const r = await ask(deps, route.method, route.path, { ...opts, origin: TOURS, json: route.json });
        expect(seen(r), `${route.what} on the tours address: ${who}`).toEqual(ON_TOURS);
        expect(r.calls, `${route.what} on the tours address: ${who}`).toBe(0);
      }
    }
    expect(await dumpOf(deps, w.keys, { touched: [a.session.id] })).toEqual(before);
    // On the app address the admin is answered.
    for (const route of routes(w)) expect((await ask(deps, route.method, route.path, { origin: APP, headers: page(a.session, APP), json: route.json })).status, route.what).toBe(200);
  });
});

describe("setting a workspace's allowance", () => {
  it("setting an allowance changes that workspace only and is in the audit record with both numbers", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    // Asking a workspace's own usage records its token's use: that is left out of the comparison.
    const touched = [a.session.id, a.tokenId, b.tokenId];
    // Read before the change: its audit row names the workspace changed beside the admin's account.
    const forbidden = [...(await forbiddenOf(w, a)), ...(await forbiddenOf(w, b))];
    const forbiddenListed = [...(await forbiddenOf(w, a, { listed: true })), ...(await forbiddenOf(w, b, { listed: true }))];
    const before = await dumpOf(deps, w.keys, { files: true, touched });
    const usedB = (await usageOf(w, b)).used_bytes as number;
    const usageA = await usageOf(w, a);

    // The change and its audit row are written in one batch.
    const batches: Stmt[][] = [];
    const realBatch = deps.db.batch.bind(deps.db);
    deps.db.batch = (stmts) => (batches.push(stmts), realBatch(stmts));
    const r = await setAllowance(w, b.workspaceId, 12_345);
    deps.db.batch = realBatch;
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(r.json).sort()).toEqual(SET_KEYS);
    expect(r.json).toEqual({ workspace_id: b.workspaceId, allowance_bytes: 12_345, storage_allowance_bytes: 12_345, used_bytes: usedB, over: usedB > 12_345 });
    expect(batches).toHaveLength(1);
    expect(batches[0].map((s) => s.sql.split(" ").slice(0, 3).join(" "))).toEqual(["UPDATE workspace SET", "INSERT INTO audit"]);

    // Only that workspace's allowance changed, and one audit row was added.
    const after = await dumpOf(deps, w.keys, { files: true, touched });
    const audit = await deps.db.all<Json>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event = 'allowance_set'");
    expect(audit).toEqual([{ event: "allowance_set", user_id: a.userId, workspace_id: b.workspaceId, subject: b.workspaceId, detail: '{"old_bytes":null,"new_bytes":12345}' }]);
    const withoutAllowance = (d: typeof before) => ({ ...d, rows: { ...d.rows, audit: d.rows.audit.filter((x) => x.event !== "allowance_set"), workspace: d.rows.workspace.map((x) => ({ ...x, storage_allowance_bytes: null })) } });
    expect(withoutAllowance(after)).toEqual(withoutAllowance(before));
    expect(after.rows.workspace.find((x) => x.id === b.workspaceId)!.storage_allowance_bytes).toBe(12_345);
    expect(after.rows.workspace.find((x) => x.id === a.workspaceId)!.storage_allowance_bytes).toBeNull();
    expect(w.writes()).toEqual([]);

    // Both workspaces see it as it is: the one changed, the other not.
    expect(await usageOf(w, b)).toMatchObject({ allowance_bytes: 12_345, used_bytes: usedB });
    expect(await usageOf(w, a)).toEqual(usageA);

    // Again, with the number it had as the old one; the edges of the range are taken.
    for (const [value, old] of [[777, 12_345], [0, 777], [MAX, 0]] as const) {
      const again = await setAllowance(w, b.workspaceId, value);
      expect(again.json, String(value)).toMatchObject({ allowance_bytes: value, storage_allowance_bytes: value });
      const last = await deps.db.first<{ detail: string }>("SELECT detail FROM audit WHERE event = 'allowance_set' ORDER BY at DESC, rowid DESC LIMIT 1");
      expect(JSON.parse(last!.detail)).toEqual({ old_bytes: old, new_bytes: value });
    }
    expect((await deps.db.all("SELECT 1 AS x FROM audit WHERE event = 'allowance_set'")).length).toBe(4);
    // The admin's own workspace can be set too.
    expect((await setAllowance(w, a.workspaceId, 5)).json).toMatchObject({ workspace_id: a.workspaceId, allowance_bytes: 5 });

    // No answer holds anything of either workspace's content.
    const listed = await list(w);
    expect(listed.json.accounts.map((x: Json) => x.storage_allowance_bytes)).toEqual([5, MAX]);
    expectNothingOf(r.text, forbidden, "the change");
    // The list names each workspace, and nothing more of either.
    expectNothingOf(listed.text, forbiddenListed, "the list");
    expect(listed.json.accounts.map((x: Json) => x.workspace_name)).toEqual([a.workspaceName, b.workspaceName]);
  });

  it("null goes back to the site's number", SLOW, async () => {
    const SITE = 5_000_000;
    const w = await build({ storageAllowanceBytes: SITE });
    const { deps, b } = w;
    expect((await usageOf(w, b)).allowance_bytes).toBe(SITE);
    expect((await setAllowance(w, b.workspaceId, 100)).json).toMatchObject({ allowance_bytes: 100, storage_allowance_bytes: 100, over: true });
    const back = await setAllowance(w, b.workspaceId, null);
    expect(back.status, back.text).toBe(200);
    expect(back.json).toMatchObject({ workspace_id: b.workspaceId, allowance_bytes: SITE, storage_allowance_bytes: null, over: false });
    expect((await usageOf(w, b)).allowance_bytes).toBe(SITE);
    expect((await list(w)).json.accounts[1]).toMatchObject({ allowance_bytes: SITE, storage_allowance_bytes: null });
    const last = await deps.db.first<{ detail: string }>("SELECT detail FROM audit WHERE event = 'allowance_set' ORDER BY at DESC, rowid DESC LIMIT 1");
    expect(JSON.parse(last!.detail)).toEqual({ old_bytes: 100, new_bytes: null });
    expect(await deps.db.first("SELECT storage_allowance_bytes FROM workspace WHERE id = ?", [b.workspaceId])).toEqual({ storage_allowance_bytes: null });

    // On a site with no number of its own, null is no limit.
    const open = await build();
    await setAllowance(open, open.b.workspaceId, 100);
    expect((await setAllowance(open, open.b.workspaceId, null)).json).toMatchObject({ allowance_bytes: null, storage_allowance_bytes: null, over: false });
    expect((await usageOf(open, open.b)).allowance_bytes).toBeNull();
  });

  it("a negative number, a decimal, text or a number past the safe range is refused", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    await setAllowance(w, b.workspaceId, 4_000);
    const before = await dumpOf(deps, w.keys, { touched: [a.session.id] });
    const field = (raw: string) => `{"storage_allowance_bytes":${raw}}`;
    const badValues: [string, string][] = [
      ["a negative number", field("-1")],
      ["a large negative number", field("-9007199254740991")],
      ["a decimal", field("1.5")],
      ["a tiny decimal", field("0.000001")],
      ["a number past the safe range", field("9007199254740992")],
      ["a number far past it", field("1e400")],
      ["a number as text", field('"100"')],
      ["empty text", field('""')],
      ["true", field("true")],
      ["an object", field("{}")],
      ["a list", field("[100]")],
      ["no field at all", "{}"],
    ];
    const badBodies: [string, string][] = [
      ["no body", ""],
      ["not JSON", "storage_allowance_bytes=100"],
      ["a JSON list", "[100]"],
      ["a bare number", "100"],
      ["JSON null", "null"],
      ["another field beside it", '{"storage_allowance_bytes":100,"tour_id":"tour_0123456789abcdef01234567"}'],
      ["a body past the cap", `{"storage_allowance_bytes":100,"x":"${"y".repeat(5000)}"}`],
      // Valid in every other way: only its length is wrong.
      ["a good body padded past the cap", `{"storage_allowance_bytes":100}${" ".repeat(1100)}`],
    ];
    for (const [cases, code] of [[badValues, "bad_allowance"], [badBodies, "bad_request"]] as const) {
      for (const [what, body] of cases) {
        w.tick();
        const r = await ask(deps, "PATCH", workspacePath(b.workspaceId), { headers: page(a.session), body: body === "" ? undefined : body });
        expect([r.status, r.json?.error], `${what}: ${r.text}`).toEqual([400, code]);
        expect(typeof r.json.detail, what).toBe("string");
        expect(r.headers.get("cache-control"), what).toBe("no-store");
      }
    }
    // The detail names the rule, never the value sent.
    const r = await ask(deps, "PATCH", workspacePath(b.workspaceId), { headers: page(a.session), body: field('"secret-value-123"') });
    expect(r.json).toEqual({ error: "bad_allowance", detail: "storage_allowance_bytes must be a whole number of bytes from 0 to 9007199254740991, or null for the site's default" });
    // Nothing changed and nothing was recorded.
    expect(await dumpOf(deps, w.keys, { touched: [a.session.id] })).toEqual(before);
    // The padded body is refused for its length alone: within the cap, the same value is taken.
    const within = await ask(deps, "PATCH", workspacePath(b.workspaceId), { headers: page(a.session), body: `{"storage_allowance_bytes":100}${" ".repeat(900)}` });
    expect(within.json).toMatchObject({ storage_allowance_bytes: 100 });
  });

  it("a change that another change overtakes is read again, and its audit row names the number it really replaced", SLOW, async () => {
    const w = await build();
    const { deps, b } = w;
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = 4000 WHERE id = ?", [b.workspaceId]);
    const name = async () => (await deps.db.first<{ name: string }>("SELECT name FROM workspace WHERE id = ?", [b.workspaceId]))!.name;
    const audit = () => deps.db.all<{ detail: string }>("SELECT detail FROM audit WHERE event = 'allowance_set'");
    const realBatch = deps.db.batch.bind(deps.db);
    /** Before each write of the allowance (up to `times` of them), another change lands with a number of its own. */
    const compete = (times: number) => {
      let n = 0;
      deps.db.batch = async (stmts) => {
        if (stmts[0]?.sql.startsWith("UPDATE workspace SET storage_allowance_bytes") && n < times) {
          n++;
          await deps.db.run("UPDATE workspace SET storage_allowance_bytes = ? WHERE id = ?", [990 + n, b.workspaceId]);
        }
        return realBatch(stmts);
      };
      return () => n;
    };

    // Overtaken once: the second try reads 991 and replaces it.
    const once = compete(1);
    const r = await setAllowance(w, b.workspaceId, 5000);
    deps.db.batch = realBatch;
    expect(once()).toBe(1);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ allowance_bytes: 5000, storage_allowance_bytes: 5000 });
    expect((await audit()).map((x) => JSON.parse(x.detail))).toEqual([{ old_bytes: 991, new_bytes: 5000 }]);
    expect(await name()).toBe(b.workspaceName);

    // Overtaken on every try: it gives up with the server's one failure, and records nothing.
    const always = compete(Number.MAX_SAFE_INTEGER);
    const failed = await setAllowance(w, b.workspaceId, 6000);
    deps.db.batch = realBatch;
    expect(always()).toBe(3);
    expect([failed.status, failed.text]).toEqual([500, '{"error":"internal"}']);
    expect(await audit()).toHaveLength(1);
    expect(await name()).toBe(b.workspaceName);
    // The workspace keeps the number the last competing change gave it.
    expect(await deps.db.first("SELECT storage_allowance_bytes FROM workspace WHERE id = ?", [b.workspaceId])).toEqual({ storage_allowance_bytes: 993 });
  });

  it("lowering it below usage is accepted, answers over, and deletes nothing", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const usage = await usageOf(w, b);
    // Listing its tours runs the workspace's own housekeeping (a replaced picture is removed): done first, so it is not counted below.
    const tours = await send(deps, "GET", "/api/v1/tours", { token: b.token });
    w.forgetWrites();
    const pageBefore = await send(deps, "GET", `/t/${b.ids.published.slug}`);
    expect(pageBefore.status).toBe(200);
    const before = await snapshotOf(deps, b, w.keys);
    const beforeA = await snapshotOf(deps, a, w.keys);

    const r = await setAllowance(w, b.workspaceId, 1);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ workspace_id: b.workspaceId, allowance_bytes: 1, storage_allowance_bytes: 1, used_bytes: usage.used_bytes, over: true });

    // Nothing of the workspace is gone or changed but its allowance: rows, files, tours, the page.
    const after = await snapshotOf(deps, b, w.keys);
    expect(w.writes()).toEqual([]);
    expect(after.files).toEqual(before.files);
    const { workspace: _w1, audit: _a1, session: _s1, ...rowsBefore } = before.rows;
    const { workspace: _w2, audit: _a2, session: _s2, ...rowsAfter } = after.rows;
    expect(rowsAfter).toEqual(rowsBefore);
    expect(await snapshotOf(deps, a, w.keys)).toEqual({ ...beforeA, rows: { ...beforeA.rows, audit: expect.any(Array), session: expect.any(Array) } });
    expect(await send(deps, "GET", "/api/v1/tours", { token: b.token })).toMatchObject({ status: 200, text: tours.text });
    expect(seen(await send(deps, "GET", `/t/${b.ids.published.slug}`))).toEqual(seen(pageBefore));
    // Its own usage answer is the same but for the allowance, which it is now over.
    expect(await usageOf(w, b)).toEqual({ ...usage, allowance_bytes: 1, over: true });

    // Only new room is refused: its next upload, with the numbers.
    const full = await send(deps, "POST", "/api/v1/uploads", { token: b.token, body: JSON.stringify({ manifest: manifestOf([10], "Bravo one more"), target: { kind: "new" } }), headers: { "content-type": "application/json" } });
    expect(full.status, full.text).toBe(413);
    expect(full.json).toMatchObject({ error: "storage_full", used_bytes: usage.used_bytes, allowance_bytes: 1 });
    expect(w.writes()).toEqual([]);
  });

  it("an unknown workspace id answers not found", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const before = await dumpOf(deps, w.keys, { touched: [a.session.id] });
    const ids: [string, string][] = [
      ["a workspace id that never existed", "ws_" + "0123456789abcdef".repeat(2).slice(0, 24)],
      ["the account's id in place of its workspace's", b.userId],
      ["a tour's id", b.ids.published.tour],
      ["the workspace id in capitals", b.workspaceId.toUpperCase()],
      ["the workspace id with a character more", b.workspaceId + "0"],
      ["not an id at all", "everything"],
    ];
    for (const [what, id] of ids) {
      w.tick();
      // The one 404 every refusal of an admin route is: it tells nothing more.
      expect(seen(await ask(deps, "PATCH", workspacePath(id), { headers: page(a.session), json: { storage_allowance_bytes: 1 } })), what).toEqual(REFUSED);
    }
    expect(await dumpOf(deps, w.keys, { touched: [a.session.id] })).toEqual(before);
    expect(await deps.db.all("SELECT 1 AS x FROM audit WHERE event = 'allowance_set'")).toEqual([]);
  });
});
