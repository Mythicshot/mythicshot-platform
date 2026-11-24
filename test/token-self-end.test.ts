// DELETE /api/v1/token: a token ends itself. The desktop app holds only its bearer token, so
// this is how it tells the site that a connection it drops should end. It takes a token alone,
// revokes exactly the token that sent the request (never one named in the URL or the body), and
// writes one audit record with it in the same batch. It is allowed whatever the workspace's
// billing and whatever the site's terms, because it only takes access away; and it answers on
// the same addresses as the other token routes, never on the tours or img address.
import { describe, expect, it } from "vitest";
import { makeDeps, makeDepsBefore, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { hashToken, newId, newToken } from "../src/auth.ts";
import type { Config, Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { parseTerms, publishTerms } from "../src/terms.ts";
import { ORIGIN, clone, fixtures, send, type Call, type Json } from "./bundle.ts";
import { withBilling } from "./fake-stripe.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const PATH = "/api/v1/token";
const TWO: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com" } };
const THREE: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" } };
const APP = "https://app.example.com";
const TOURS = "https://tours.example.com";
const IMG = "https://img.example.com";

async function site(config: Partial<Config> = {}, opts: { billing?: boolean } = {}) {
  const made = await makeDeps(config);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  // With billing, before the accounts, so their workspaces are made under it as on such a site.
  if (opts.billing === true) withBilling(made.deps);
  await seedAccount(made.deps, { username: "boss", admin: true });
  const a = await seedAccount(made.deps, { username: "alice" });
  const b = await seedAccount(made.deps, { username: "bob" });
  return { ...made, clock, a, b, tick: (ms: number) => void (clock.now += ms) };
}

type Made = { id: string; token: string };

/** One more token of the workspace, written as connecting the app writes one (kind sign_in, naming its account), unless told otherwise. */
async function addToken(deps: Deps, workspaceId: string, more: { userId?: string | null; kind?: "setup" | "sign_in"; usedAt?: number | null; revokedAt?: number | null } = {}): Promise<Made> {
  const token = newToken();
  const id = newId("tok");
  await deps.db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at, last_used_at, revoked_at, kind, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    id, workspaceId, "Laptop", await hashToken(token), more.usedAt ?? deps.now(), more.usedAt ?? null, more.revokedAt ?? null, more.kind ?? "sign_in", more.userId ?? null,
  ]);
  return { id, token };
}

const firstTokenOf = async (deps: Deps, workspaceId: string) => (await deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ? AND kind = 'setup'", [workspaceId]))!.id;
const end = (deps: Deps, token: string | null, more: { origin?: string; path?: string; body?: string; headers?: Record<string, string> } = {}) =>
  send(deps, "DELETE", more.path ?? PATH, { token, origin: more.origin, body: more.body, headers: more.headers });
const me = (deps: Deps, token: string, origin?: string) => send(deps, "GET", "/api/v1/me", { token, origin });

/** Each token's revoked time, by id. */
async function revokedTimes(deps: Deps): Promise<Record<string, number | null>> {
  const rows = await deps.db.all<{ id: string; revoked_at: number | null }>("SELECT id, revoked_at FROM api_token ORDER BY id");
  return Object.fromEntries(rows.map((r) => [r.id, r.revoked_at]));
}

/** Every row of every table, as one value, to show that nothing changed. */
async function everything(deps: Deps): Promise<Record<string, unknown[]>> {
  const tables = await deps.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT IN ('_migrations', 'd1_migrations') ORDER BY name");
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) out[name] = await deps.db.all(`SELECT * FROM "${name}" ORDER BY rowid`);
  return out;
}

async function signIn(deps: Deps, userId: string, origin = ORIGIN): Promise<Record<string, string>> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { cookie: `${SESSION_COOKIE}=${made.secret}`, "x-csrf-token": await csrfFor(made.secret), origin, "sec-fetch-site": "same-origin" };
}

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });
const audits = (deps: Deps) => deps.db.all<Json>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event LIKE 'token_%' ORDER BY rowid");

describe("a token ends itself", () => {
  it("revokes the token that sent the request, answers 204 with nothing in it, and records it", async () => {
    const { deps, a, b } = await site();
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
    const firstA = await firstTokenOf(deps, a.workspaceId);
    const firstB = await firstTokenOf(deps, b.workspaceId);
    expect((await me(deps, laptop.token)).status).toBe(200);
    const before = await revokedTimes(deps);

    const done = await end(deps, laptop.token);
    expect([done.status, done.text, done.headers.get("cache-control")]).toEqual([204, "", "no-store"]);
    expect(done.headers.get("content-type")).toBeNull();
    // Exactly that token, at the request's time; every other token as it was.
    expect(await revokedTimes(deps)).toEqual({ ...before, [laptop.id]: NOW });
    expect(await audits(deps)).toEqual([{ event: "token_ended_itself", user_id: a.userId, workspace_id: a.workspaceId, subject: laptop.id, detail: null }]);
    // The token is refused from now on; the workspace's other token and the other workspace's are not.
    const unauthorized = await send(deps, "GET", "/api/v1/tours");
    expect(seen(await me(deps, laptop.token))).toEqual(seen(unauthorized));
    expect((await me(deps, a.token)).status).toBe(200);
    expect((await me(deps, b.token)).status).toBe(200);
    expect(before[firstA]).toBeNull();
    expect(before[firstB]).toBeNull();
    // A second call with it: the 401 any request without a valid credential gets, and nothing more is written.
    const again = await end(deps, laptop.token);
    expect(seen(again)).toEqual(seen(unauthorized));
    expect(await audits(deps)).toHaveLength(1);
    expect((await me(deps, b.token)).status).toBe(200);
  });

  it("only a connection ends itself: a token of kind setup gets 409 not_a_connection, changes nothing and keeps working", async () => {
    const { deps, a } = await site();
    const firstA = await firstTokenOf(deps, a.workspaceId);
    const pasted = await addToken(deps, a.workspaceId, { kind: "setup", userId: a.userId });
    for (const token of [a.token, pasted.token]) {
      const before = await everything(deps);
      const r = await end(deps, token);
      expect(seen(r)).toEqual({
        status: 409,
        headers: [["cache-control", "no-store"], ["content-type", "application/json"], ["x-content-type-options", "nosniff"]],
        body: '{"error":"not_a_connection","detail":"only a connection made by signing in from the app can end itself; this token was made at setup"}',
      });
      expect(await everything(deps)).toEqual(before);
      expect((await me(deps, token)).status).toBe(200);
    }
    expect(await audits(deps)).toEqual([]);
    expect(await deps.db.first("SELECT revoked_at FROM api_token WHERE id = ?", [firstA])).toEqual({ revoked_at: null });
    // A connection of the same workspace still ends itself.
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
    expect((await end(deps, laptop.token)).status).toBe(204);
  });

  it("no moment exists in which a setup token is revoked: the guarded update itself leaves it alone", async () => {
    const { deps, a } = await site();
    const firstA = await firstTokenOf(deps, a.workspaceId);
    const batches: string[][] = [];
    const realBatch = deps.db.batch.bind(deps.db);
    deps.db.batch = (async (stmts: { sql: string }[]) => {
      batches.push(stmts.map((s) => s.sql));
      return realBatch(stmts as never);
    }) as typeof deps.db.batch;
    expect((await end(deps, a.token)).status).toBe(409);
    deps.db.batch = realBatch;
    expect(batches).toHaveLength(1);
    expect(batches[0][0]).toBe("UPDATE api_token SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL AND kind = 'sign_in'");
    expect(batches[0][1]).toContain("CASE WHEN changes() = 1");
    expect(await deps.db.first("SELECT revoked_at FROM api_token WHERE id = ?", [firstA])).toEqual({ revoked_at: null });
  });

  it("records no account for a token that names none, nor for one whose account no longer belongs to the workspace", async () => {
    const { deps, a, b } = await site();
    const nobody = await addToken(deps, a.workspaceId, { userId: null });
    // A token naming an account of another workspace (no route makes one; the record still never names it).
    const stray = await addToken(deps, a.workspaceId, { userId: b.userId });
    expect((await end(deps, nobody.token)).status).toBe(204);
    expect((await end(deps, stray.token)).status).toBe(204);
    expect(await audits(deps)).toEqual([
      { event: "token_ended_itself", user_id: null, workspace_id: a.workspaceId, subject: nobody.id, detail: null },
      { event: "token_ended_itself", user_id: null, workspace_id: a.workspaceId, subject: stray.id, detail: null },
    ]);
  });

  it("does not record the token's use: it is ended, not used", async () => {
    const { deps, a } = await site();
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId, usedAt: NOW - DAY });
    expect((await end(deps, laptop.token)).status).toBe(204);
    expect(await deps.db.first("SELECT last_used_at, revoked_at FROM api_token WHERE id = ?", [laptop.id])).toEqual({ last_used_at: NOW - DAY, revoked_at: NOW });
  });

  it("an id or anything else in the URL or the body has no effect: only the calling token ends", async () => {
    const { deps, a, b } = await site();
    const firstA = await firstTokenOf(deps, a.workspaceId);
    const firstB = await firstTokenOf(deps, b.workspaceId);
    const other = await addToken(deps, a.workspaceId, { userId: a.userId });
    // firstA and firstB are setup tokens: named anywhere, they are never what ends.
    const asks: { path?: string; body?: string; headers?: Record<string, string> }[] = [
      { path: `${PATH}?id=${firstA}` },
      { path: `${PATH}?id=${firstB}&token=${encodeURIComponent(b.token)}` },
      { body: JSON.stringify({ id: firstB }), headers: { "content-type": "application/json" } },
      { body: JSON.stringify({ id: other.id, token: b.token, workspace_id: b.workspaceId }), headers: { "content-type": "application/json" } },
      { body: "not json at all", headers: { "content-type": "application/json" } },
      { body: "x".repeat(300_000), headers: { "content-type": "text/plain" } },
    ];
    for (const ask of asks) {
      const caller = await addToken(deps, a.workspaceId, { userId: a.userId });
      const before = await revokedTimes(deps);
      const r = await end(deps, caller.token, ask);
      expect([r.status, r.text], JSON.stringify(ask).slice(0, 80)).toEqual([204, ""]);
      expect(await revokedTimes(deps), JSON.stringify(ask).slice(0, 80)).toEqual({ ...before, [caller.id]: NOW });
    }
    for (const token of [a.token, b.token, other.token]) expect((await me(deps, token)).status).toBe(200);
    // An id after the path is no route at all, with or without a token, and changes nothing.
    const before = await everything(deps);
    for (const path of [`${PATH}/${firstB}`, `${PATH}/${other.id}`, `${PATH}/`]) {
      const r = await end(deps, a.token, { path });
      expect([r.status, r.json], path).toEqual([404, { error: "not_found" }]);
    }
    expect(await everything(deps)).toEqual(before);
  });

  it("reads no request body: one that fails when it is read changes nothing of the answer", async () => {
    const { deps, a } = await site();
    const caller = await addToken(deps, a.workspaceId, { userId: a.userId });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("the body was read"));
      },
    });
    const r = await send(deps, "DELETE", PATH, { token: caller.token, body, headers: { "content-type": "application/json" } });
    expect([r.status, r.text]).toEqual([204, ""]);
    expect(await deps.db.first("SELECT revoked_at FROM api_token WHERE id = ?", [caller.id])).toEqual({ revoked_at: NOW });
  });
});

describe("who may end a token", () => {
  it("a session alone, nothing at all, a revoked, lapsed, unknown or malformed token: the one 401, and nothing changes", async () => {
    const { deps, a, tick } = await site({ lifetimes: { connectionIdleDays: 1 } });
    const revoked = await addToken(deps, a.workspaceId, { userId: a.userId, revokedAt: NOW - DAY });
    const lapsed = await addToken(deps, a.workspaceId, { userId: a.userId, usedAt: NOW - 2 * DAY });
    const live = await addToken(deps, a.workspaceId, { userId: a.userId });
    // The lapsed token is refused everywhere already: it is not about this route.
    expect((await me(deps, lapsed.token)).status).toBe(401);
    const session = await signIn(deps, a.userId);
    const unauthorized = seen(await send(deps, "GET", "/api/v1/tours"));
    const before = await everything(deps);
    const asks: [string, Record<string, string>][] = [
      ["nothing", {}],
      ["a session alone, with its anti-forgery header, from the site's own page", session],
      ["a revoked token", { authorization: `Bearer ${revoked.token}` }],
      ["a lapsed connection", { authorization: `Bearer ${lapsed.token}` }],
      ["a token nobody was given", { authorization: `Bearer ${newToken()}` }],
      ["the token's id", { authorization: `Bearer ${live.id}` }],
      ["the token's digest", { authorization: `Bearer ${await hashToken(live.token)}` }],
      ["the token as a Basic credential", { authorization: `Basic ${live.token}` }],
      ["the bare token", { authorization: live.token }],
      ["the token in capitals", { authorization: `Bearer ${live.token.toUpperCase()}` }],
    ];
    for (const [what, headers] of asks) {
      tick(1);
      const r = await end(deps, null, { headers });
      expect(seen(r), what).toEqual(unauthorized);
    }
    expect(await everything(deps)).toEqual(before);
    expect((await me(deps, live.token)).status).toBe(200);
  });

  it("a token cannot use the session's revoke on itself, and a session's revoke still revokes the token it names", async () => {
    const { deps, a, b } = await site();
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
    const before = await everything(deps);
    const byToken = await send(deps, "DELETE", `/api/v1/tokens/${laptop.id}`, { token: laptop.token });
    expect(byToken.status).toBe(401);
    expect(await everything(deps)).toEqual(before);
    // The session's route answers for the id it is given, never as this one.
    const session = await signIn(deps, a.userId);
    const firstA = await firstTokenOf(deps, a.workspaceId);
    expect((await send(deps, "DELETE", `/api/v1/tokens/${laptop.id}`, { headers: session })).status).toBe(204);
    expect((await me(deps, laptop.token)).status).toBe(401);
    expect((await me(deps, a.token)).status).toBe(200);
    expect(await audits(deps)).toEqual([{ event: "token_revoked", user_id: a.userId, workspace_id: a.workspaceId, subject: laptop.id, detail: null }]);
    // Another workspace's session cannot revoke A's first token by the session route, and this route takes no session.
    const sb = await signIn(deps, b.userId);
    expect((await send(deps, "DELETE", `/api/v1/tokens/${firstA}`, { headers: sb })).status).toBe(404);
    expect((await send(deps, "DELETE", PATH, { headers: sb })).status).toBe(401);
    expect((await me(deps, a.token)).status).toBe(200);
  });

  it("each route answers its own path: the router matches exactly one route for each", () => {
    const app = createApp({ config: {} } as Deps);
    const matched = (path: string) =>
      app.router
        .match("DELETE", path)[0]
        .map(([[, r]]) => r as unknown as { method: string; path: string })
        .filter((r) => !(r.method === "ALL" && r.path === "/*"))
        .map((r) => `${r.method} ${r.path}`);
    expect(matched(PATH)).toEqual(["DELETE /api/v1/token"]);
    expect(matched(`/api/v1/tokens/tok_${"0".repeat(24)}`)).toEqual(["DELETE /api/v1/tokens/:id"]);
    expect(matched("/api/v1/tokens")).toEqual([]);
    expect(matched(`${PATH}/tok_${"0".repeat(24)}`)).toEqual([]);
  });

  it("a token with a session cookie beside it still ends only itself: the cookie is not looked at", async () => {
    const { deps, a, b } = await site();
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
    const sb = await signIn(deps, b.userId);
    const before = await revokedTimes(deps);
    expect((await end(deps, laptop.token, { headers: sb })).status).toBe(204);
    expect(await revokedTimes(deps)).toEqual({ ...before, [laptop.id]: NOW });
    expect((await audits(deps))[0]).toMatchObject({ user_id: a.userId, workspace_id: a.workspaceId, subject: laptop.id });
  });
  it("a token revoked between its lookup and its end gets the 401 it would get a moment later, and nothing more is written", async () => {
    const { deps, a } = await site();
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
    const session = await signIn(deps, a.userId);
    const unauthorized = seen(await send(deps, "GET", "/api/v1/tours"));
    const realFirst = deps.db.first.bind(deps.db);
    let revoked: Call | null = null;
    deps.db.first = (async (sql: string, params?: (string | number | null)[]) => {
      const row = await realFirst(sql, params);
      if (revoked === null && sql.includes("FROM api_token WHERE hash = ?")) {
        deps.db.first = realFirst;
        // The dashboard's revoke commits right after this request's token was looked up.
        revoked = await send(deps, "DELETE", `/api/v1/tokens/${laptop.id}`, { headers: session });
      }
      return row;
    }) as Deps["db"]["first"];
    const r = await end(deps, laptop.token);
    deps.db.first = realFirst;
    expect((revoked as Call | null)?.status).toBe(204);
    expect(seen(r)).toEqual(unauthorized);
    expect((await audits(deps)).map((e) => e.event)).toEqual(["token_revoked"]);
  });
});

describe("it only reduces access, so nothing holds it back", () => {
  it("works while the workspace is read-only for billing", async () => {
    const { deps, a } = await site({}, { billing: true });
    await deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_A', stripe_subscription_id = 'sub_A', subscription_status = 'canceled', subscription_ended_at = ? WHERE id = ?", [NOW - DAY, a.workspaceId]);
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
    // Read-only indeed: an upload is refused.
    const manifest = clone(fixtures.v2 as Json);
    const refused = await send(deps, "POST", "/api/v1/uploads", { token: laptop.token, body: JSON.stringify({ manifest, target: { kind: "new" } }), headers: { "content-type": "application/json" } });
    expect([refused.status, refused.json.error]).toEqual([402, "subscription_ended"]);
    const done = await end(deps, laptop.token);
    expect([done.status, done.text]).toEqual([204, ""]);
    expect((await me(deps, laptop.token)).status).toBe(401);
  });

  it("works while the site's terms wait for the account's agreement", async () => {
    const { deps, a } = await site();
    const read = await parseTerms(new TextEncoder().encode("title: Terms\nversion: 1\nmain points:\n- One point.\nterms:\nThe terms.\n"));
    if (!read.ok) throw new Error(read.reason);
    expect((await publishTerms(deps, read)).ok).toBe(true);
    const session = await signIn(deps, a.userId);
    expect((await send(deps, "GET", "/api/v1/tours", { headers: session })).json.error).toBe("terms_required");
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
    expect((await end(deps, laptop.token)).status).toBe(204);
    expect((await me(deps, laptop.token)).status).toBe(401);
  });

  it("works on a database migration 0025 has not reached, with no account in the record", async () => {
    const made = await makeDepsBefore((n) => n < "0025");
    const { deps } = made;
    deps.now = () => NOW;
    const ws = newId("ws");
    await deps.db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, 'Old', ?)", [ws, NOW]);
    const token = newToken();
    const id = newId("tok");
    await deps.db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at, kind) VALUES (?, ?, 'Old laptop', ?, ?, 'sign_in')", [id, ws, await hashToken(token), NOW]);
    expect((await me(deps, token)).status).toBe(200);
    expect((await end(deps, token)).status).toBe(204);
    expect((await me(deps, token)).status).toBe(401);
    expect(await deps.db.all("SELECT event, user_id, workspace_id, subject FROM audit WHERE event = 'token_ended_itself'")).toEqual([{ event: "token_ended_itself", user_id: null, workspace_id: ws, subject: id }]);
  });

  it("on a database before connections (migration 0011), where every token is a setup token, the same 409 and nothing changes", async () => {
    const made = await makeDepsBefore((n) => n < "0011");
    const { deps } = made;
    deps.now = () => NOW;
    const ws = newId("ws");
    await deps.db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, 'Old', ?)", [ws, NOW]);
    const token = newToken();
    await deps.db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, 'Old token', ?, ?)", [newId("tok"), ws, await hashToken(token), NOW]);
    expect((await me(deps, token)).status).toBe(200);
    const before = await everything(deps);
    const r = await end(deps, token);
    expect([r.status, r.json.error, r.headers.get("cache-control")]).toEqual([409, "not_a_connection", "no-store"]);
    expect(await everything(deps)).toEqual(before);
    expect((await me(deps, token)).status).toBe(200);
  });
});

describe("where it answers", () => {
  it("with two addresses: on the app and the tours address, as every route a token calls; another host is 421 and ends nothing", async () => {
    const { deps, a } = await site(TWO);
    const stray = await addToken(deps, a.workspaceId, { userId: a.userId });
    const before = await everything(deps);
    expect((await end(deps, stray.token, { origin: "https://evil.example.net" })).status).toBe(421);
    expect(await everything(deps)).toEqual(before);
    for (const origin of [APP, TOURS]) {
      const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
      expect((await end(deps, laptop.token, { origin })).status, origin).toBe(204);
      expect((await me(deps, laptop.token, origin)).status, origin).toBe(401);
    }
    expect((await audits(deps)).map((e) => e.event)).toEqual(["token_ended_itself", "token_ended_itself"]);
  });

  it("a session cookie alone, on the tours or the app address, is the one 401 and changes nothing: no cookie is read", async () => {
    const { deps, a } = await site(TWO);
    await addToken(deps, a.workspaceId, { userId: a.userId });
    const unauthorized = seen(await send(deps, "GET", "/api/v1/tours", { origin: TOURS }));
    for (const origin of [TOURS, APP]) {
      const session = await signIn(deps, a.userId, origin);
      const before = await everything(deps);
      const r = await end(deps, null, { origin, headers: session });
      expect(seen(r), origin).toEqual(unauthorized);
      expect(await everything(deps), origin).toEqual(before);
    }
  });

  it("with an img address too: never on the img address", async () => {
    const { deps, a } = await site(THREE);
    const laptop = await addToken(deps, a.workspaceId, { userId: a.userId });
    const before = await everything(deps);
    const r = await end(deps, laptop.token, { origin: IMG });
    expect([r.status, r.json]).toEqual([404, { error: "not_found" }]);
    expect(await everything(deps)).toEqual(before);
    expect((await end(deps, laptop.token, { origin: TOURS })).status).toBe(204);
  });
});
