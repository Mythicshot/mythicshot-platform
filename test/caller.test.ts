// The caller: requireAuth resolves a token or a session cookie to exactly one workspace,
// and refuses everything that is neither, both, or in the wrong place. Runs on both targets.
//
// Helpers live in this file: the harnesses are not edited by this task.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount, seedWorkspace } from "#harness";
import { requireAuth, type Auth } from "../src/auth.ts";
import type { Config, Db, Deps } from "../src/ports.ts";
import { SESSION_COOKIE, SESSION_TOUCH_MS, createSignInCode, csrfFor, redeemSignInCode, resolveSession, revokeAll, revokeSession } from "../src/sessions.ts";
import { send } from "./bundle.ts";

const NOW = 1_800_000_000_000;
const APP = "https://app.example.com";
const TOURS = "https://tours.example.com";
/** What Firefox on Linux sends as its User-Agent. */
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const TWO: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com" } };

const UNAUTHORIZED = '{"error":"unauthorized"}';
const MIXED = '{"error":"mixed_credentials","detail":"send a token or a session cookie, not both"}';
const BAD_ORIGIN = '{"error":"bad_origin","detail":"this request must come from the site\'s own pages"}';
const BAD_CSRF = '{"error":"bad_csrf","detail":"the anti-forgery header is missing or wrong"}';
const NOT_FOUND = '{"error":"not_found"}';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Deps with a clock the test moves, an admin (so sign-in is open) and two more accounts. */
async function site(config?: Partial<Config>) {
  const made = await makeDeps(config);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  const admin = await seedAccount(made.deps, { admin: true, username: "boss" });
  const a = await seedAccount(made.deps);
  const b = await seedAccount(made.deps);
  return { deps: made.deps, calls: made.calls, clock, admin, a, b };
}

async function signIn(deps: Deps, userId: string) {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), UA, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { ...made, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

type Presented = { method?: string; origin?: string; authorization?: string; cookie?: string; headers?: Record<string, string> };

function request(p: Presented): Request {
  const headers = new Headers(p.headers);
  if (p.authorization !== undefined) headers.set("authorization", p.authorization);
  if (p.cookie !== undefined) headers.set("cookie", p.cookie);
  return new Request((p.origin ?? APP) + "/api/v1/tours", { method: p.method ?? "GET", headers });
}

/** A changing request as the site's own page sends it for this session. */
function change(s: { cookie: string; csrf: string }, method = "POST", origin = APP): Presented {
  return { method, origin, cookie: s.cookie, headers: { origin, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin" } };
}

/** The answer of a refusal, whole: status, body and every header. */
async function refusal(r: Auth | Response): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  if (!(r instanceof Response)) throw new Error("expected a refusal, got a caller");
  return { status: r.status, body: await r.text(), headers: Object.fromEntries(r.headers) };
}

const JSON_ERROR_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const is401 = { status: 401, body: UNAUTHORIZED, headers: { "content-type": "application/json" } };
const is400 = { status: 400, body: MIXED, headers: JSON_ERROR_HEADERS };
const is403origin = { status: 403, body: BAD_ORIGIN, headers: JSON_ERROR_HEADERS };
const is403csrf = { status: 403, body: BAD_CSRF, headers: JSON_ERROR_HEADERS };
const is404 = { status: 404, body: NOT_FOUND, headers: JSON_ERROR_HEADERS };

/** Records every statement sent through `deps.db` from now on. */
function recordSql(deps: Deps): string[] {
  const seen: string[] = [];
  const db = deps.db;
  const wrapped: Db = {
    all: (sql, params) => (seen.push(sql), db.all(sql, params)),
    first: (sql, params) => (seen.push(sql), db.first(sql, params)),
    run: (sql, params) => (seen.push(sql), db.run(sql, params)),
    batch: (stmts) => (seen.push(...stmts.map((s) => s.sql)), db.batch(stmts)),
  };
  deps.db = wrapped;
  return seen;
}

const tokenRow = (deps: Deps, workspaceId: string) =>
  deps.db.first<{ id: string; last_used_at: number | null }>("SELECT id, last_used_at FROM api_token WHERE workspace_id = ?", [workspaceId]);

describe("the caller", () => {
  it("a token resolves as before, byte for byte", async () => {
    const { deps, calls, a, b } = await site();
    const id = (await tokenRow(deps, a.workspaceId))!.id;

    // The same answer object, with no new key, in two calls: the lookup and the touch.
    let before = calls();
    const auth = await requireAuth(request({ origin: TOURS, authorization: "Bearer " + a.token }), deps);
    expect(calls() - before).toBe(2);
    expect(auth).toStrictEqual({ workspaceId: a.workspaceId, tokenId: id });
    expect(Object.keys(auth)).toEqual(["workspaceId", "tokenId"]);
    expect(await tokenRow(deps, a.workspaceId)).toEqual({ id, last_used_at: NOW });
    expect(await tokenRow(deps, b.workspaceId)).toMatchObject({ last_used_at: null });

    // Without the touch: one call.
    before = calls();
    expect(await requireAuth(request({ authorization: "bearer " + b.token }), deps, { touch: false })).toStrictEqual({ workspaceId: b.workspaceId, tokenId: (await tokenRow(deps, b.workspaceId))!.id });
    expect(calls() - before).toBe(2); // the lookup, and this test's own read of the token row
    expect(await tokenRow(deps, b.workspaceId)).toMatchObject({ last_used_at: null });

    // The statements are the ones 0.1.8 sent: the same lookup with one more condition, the same touch.
    const sql = recordSql(deps);
    await requireAuth(request({ authorization: "Bearer " + a.token }), deps);
    expect(sql).toHaveLength(2);
    expect(sql[0].startsWith("SELECT id, workspace_id, hash FROM api_token WHERE hash = ? AND revoked_at IS NULL")).toBe(true);
    expect(sql[1]).toBe("UPDATE api_token SET last_used_at = ? WHERE id = ? AND workspace_id = ?");

    // Every refusal is the one 401 with the one header, and none of these reaches the database
    // except the well-formed token nobody has, which is looked up once.
    const refused: [string | undefined, number][] = [
      [undefined, 0],
      ["", 0],
      ["dp_" + "0".repeat(40), 0],
      ["Bearer nope", 0],
      ["Bearer " + a.token.toUpperCase(), 0],
      ["Bearer  " + a.token, 0],
      ["Basic " + a.token, 0],
      ["Bearer dp_" + "0".repeat(40), 1],
    ];
    for (const [authorization, expected] of refused) {
      before = calls();
      expect(await refusal(await requireAuth(request({ authorization }), deps)), String(authorization).slice(0, 12)).toEqual(is401);
      expect(calls() - before, String(authorization).slice(0, 12)).toBe(expected);
    }

    // Through the app, on either address, with no cookie anywhere: as 0.1.8 answered.
    const me = await send(deps, "GET", "/api/v1/me", { token: a.token });
    expect(me.status).toBe(200);
    expect(Object.keys(me.json)).toEqual(["workspace", "version"]);
    expect(me.calls).toBe(3);
    expect(me.headers.get("set-cookie")).toBeNull();
    const none = await send(deps, "GET", "/api/v1/me");
    expect([none.status, none.text, none.headers.get("content-type"), none.headers.get("set-cookie"), none.calls]).toEqual([401, UNAUTHORIZED, "application/json", null, 0]);
    // A changing request with a token needs no Origin and no anti-forgery header, as before.
    const rename = await send(deps, "PATCH", "/api/v1/tours/tour_" + "0".repeat(24), { token: a.token, body: '{"title":"x"}', headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect([rename.status, rename.json.detail]).toEqual([404, "no such tour"]);
  });

  it("a session resolves to its account's one workspace", async () => {
    const { deps, admin, a, b } = await site();
    await deps.db.run("UPDATE workspace SET name = 'Workspace A' WHERE id = ?", [a.workspaceId]);
    await deps.db.run("UPDATE workspace SET name = 'Workspace B' WHERE id = ?", [b.workspaceId]);
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const boss = await signIn(deps, admin.userId);

    const auth = await requireAuth(request({ cookie: sa.cookie }), deps);
    expect(auth).toStrictEqual({ workspaceId: a.workspaceId, tokenId: "", session: { id: sa.sessionId, userId: a.userId, admin: false } });
    expect(await requireAuth(request({ cookie: sb.cookie }), deps)).toStrictEqual({ workspaceId: b.workspaceId, tokenId: "", session: { id: sb.sessionId, userId: b.userId, admin: false } });
    expect(await requireAuth(request({ cookie: boss.cookie }), deps)).toStrictEqual({ workspaceId: admin.workspaceId, tokenId: "", session: { id: boss.sessionId, userId: admin.userId, admin: true } });
    // An admin is still in one workspace: its own.
    expect(admin.workspaceId).not.toBe(a.workspaceId);

    // Through the app, each session reaches its own workspace on an existing route.
    const meA = await send(deps, "GET", "/api/v1/me", { origin: APP, headers: { cookie: sa.cookie } });
    const meB = await send(deps, "GET", "/api/v1/me", { origin: APP, headers: { cookie: sb.cookie } });
    expect([meA.status, meA.json.workspace, meB.status, meB.json.workspace]).toEqual([200, "Workspace A", 200, "Workspace B"]);
    // A session never touches a token row.
    expect(await tokenRow(deps, a.workspaceId)).toMatchObject({ last_used_at: null });

    // The workspace comes from the membership only. The older column on the account's own
    // row is not read: pointing it at another workspace moves nobody.
    await deps.db.run("UPDATE user SET workspace_id = ? WHERE id = ?", [b.workspaceId, a.userId]);
    expect(await requireAuth(request({ cookie: sa.cookie }), deps)).toMatchObject({ workspaceId: a.workspaceId });
    await deps.db.run("UPDATE user SET workspace_id = ? WHERE id = ?", [a.workspaceId, a.userId]);

    // No membership: nobody, though the account, its session and its workspace exist. The
    // workspace's token works as it did.
    await deps.db.run("DELETE FROM membership WHERE user_id = ?", [a.userId]);
    expect(await refusal(await requireAuth(request({ cookie: sa.cookie }), deps))).toEqual(is401);
    expect(await refusal(await requireAuth(request(change(sa)), deps))).toEqual(is401);
    expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps)).toMatchObject({ workspaceId: a.workspaceId });
    expect(await requireAuth(request({ cookie: sb.cookie }), deps)).toMatchObject({ workspaceId: b.workspaceId });
  });

  it("a token and a session cookie together are refused whatever each is worth", async () => {
    const { deps, calls, a, b } = await site();
    const s = await signIn(deps, a.userId);
    const revoked = await signIn(deps, a.userId);
    await revokeSession(deps, a.userId, revoked.sessionId);
    const authorizations = ["Bearer " + a.token, "Bearer " + b.token, "Bearer dp_" + "0".repeat(40), "Bearer nope", "Basic abc", "x", ""];
    const cookies = [
      s.cookie,
      `theme=dark; ${s.cookie}`,
      revoked.cookie,
      `${SESSION_COOKIE}=dps_${"0".repeat(64)}`,
      `${SESSION_COOKIE}=`,
      `${SESSION_COOKIE}=x`,
      `${s.cookie}; ${s.cookie}`,
      `${s.cookie}; ${revoked.cookie}`,
    ];
    const before = calls();
    for (const authorization of authorizations) {
      for (const cookie of cookies) {
        for (const p of [{ authorization, cookie }, { ...change(s), authorization, cookie }] as Presented[]) {
          const label = `${authorization.slice(0, 10)} | ${cookie.length} | ${p.method ?? "GET"}`;
          for (const opts of [undefined, { only: "session" as const }, { touch: false }]) {
            expect(await refusal(await requireAuth(request(p), deps, opts)), `${label} | ${JSON.stringify(opts)}`).toEqual(is400);
          }
          // An admin route answers what it answers everybody.
          expect(await refusal(await requireAuth(request(p), deps, { admin: true })), label).toEqual(is404);
        }
      }
    }
    // Decided from the headers alone: nothing was read, and no token was marked as used.
    expect(calls()).toBe(before);
    expect(await tokenRow(deps, a.workspaceId)).toMatchObject({ last_used_at: null });
    expect(await tokenRow(deps, b.workspaceId)).toMatchObject({ last_used_at: null });

    // A token-only route never looks at a cookie: the token is judged alone, as in 0.1.8,
    // whatever the cookie is worth and however the request was made.
    for (const cookie of cookies) {
      for (const p of [{ cookie }, { ...change(s), cookie }, { method: "POST", cookie, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }] as Presented[]) {
        expect(await requireAuth(request({ ...p, authorization: "Bearer " + a.token }), deps, { only: "token", touch: false }), String(cookie.length)).toStrictEqual({ workspaceId: a.workspaceId, tokenId: (await tokenRow(deps, a.workspaceId))!.id });
        for (const authorization of ["Bearer dp_" + "0".repeat(40), "Bearer nope", "Basic abc", "x", ""]) {
          expect(await refusal(await requireAuth(request({ ...p, authorization }), deps, { only: "token" })), authorization).toEqual(is401);
        }
        // And with no Authorization header the cookie is still nothing there.
        expect(await refusal(await requireAuth(request(p), deps, { only: "token" }))).toEqual(is401);
      }
    }
    expect(await tokenRow(deps, a.workspaceId)).toMatchObject({ last_used_at: null });
    const wizard = await send(deps, "GET", "/api/v1/setup/connected", { origin: APP, token: a.token, headers: { cookie: s.cookie } });
    expect([wizard.status, wizard.json]).toEqual([200, { connected: false }]);
    const wizardStale = await send(deps, "GET", "/api/v1/setup/connected", { origin: APP, token: a.token, headers: { cookie: `${SESSION_COOKIE}=stale` } });
    expect([wizardStale.status, wizardStale.json]).toEqual([200, { connected: false }]);

    // Through the app too, on a route that existed before.
    const both = await send(deps, "GET", "/api/v1/me", { origin: APP, token: a.token, headers: { cookie: s.cookie } });
    expect([both.status, both.text, both.calls]).toEqual([400, MIXED, 0]);
    // A cookie that is not the session cookie is no credential: the token works as ever.
    const other = await send(deps, "GET", "/api/v1/me", { origin: APP, token: a.token, headers: { cookie: "theme=dark; dp_session=1" } });
    expect(other.status).toBe(200);
  });

  it("a session is not accepted on the tours address", async () => {
    const { deps, calls, a } = await site(TWO);
    const s = await signIn(deps, a.userId);
    expect(await requireAuth(request({ origin: APP, cookie: s.cookie }), deps)).toMatchObject({ workspaceId: a.workspaceId });
    expect(await requireAuth(request(change(s)), deps)).toMatchObject({ workspaceId: a.workspaceId });

    const before = calls();
    for (const origin of [TOURS, "https://other.example.com", "https://app.example.com:8443", "https://app.example.com.evil.example"]) {
      expect(await refusal(await requireAuth(request({ origin, cookie: s.cookie }), deps)), origin).toEqual(is401);
      // Also with everything a changing request needs, and without it: the place is wrong first.
      expect(await refusal(await requireAuth(request(change(s, "POST", origin)), deps)), origin).toEqual(is401);
      expect(await refusal(await requireAuth(request({ method: "POST", origin, cookie: s.cookie }), deps)), origin).toEqual(is401);
      expect(await resolveSession(request({ origin, cookie: s.cookie }), deps), origin).toBeNull();
    }
    expect(calls()).toBe(before);

    // Through the app: the route answers on both addresses, the session only on one.
    expect((await send(deps, "GET", "/api/v1/me", { origin: APP, headers: { cookie: s.cookie } })).status).toBe(200);
    const onTours = await send(deps, "GET", "/api/v1/me", { origin: TOURS, headers: { cookie: s.cookie } });
    expect([onTours.status, onTours.text, onTours.calls]).toEqual([401, UNAUTHORIZED, 0]);
    // The token is as welcome on the tours address as before.
    expect((await send(deps, "GET", "/api/v1/me", { origin: TOURS, token: a.token })).status).toBe(200);
  });

  it("with the img address set, neither a session nor a token is accepted there, and the other two are as before", async () => {
    const IMG = "https://img.example.com";
    const { deps, calls, a } = await site({ hosts: { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" } });
    const s = await signIn(deps, a.userId);
    expect(await requireAuth(request({ origin: APP, cookie: s.cookie }), deps)).toMatchObject({ workspaceId: a.workspaceId });
    expect(await requireAuth(request(change(s)), deps)).toMatchObject({ workspaceId: a.workspaceId });
    for (const origin of [TOURS, APP]) expect(await requireAuth(request({ origin, authorization: `Bearer ${a.token}` }), deps), origin).toMatchObject({ workspaceId: a.workspaceId });
    expect(await refusal(await requireAuth(request({ origin: TOURS, cookie: s.cookie }), deps))).toEqual(is401);

    // The gate already answers 404 there; the caller refuses on its own too, before any lookup.
    const before = calls();
    expect(await refusal(await requireAuth(request({ origin: IMG, cookie: s.cookie }), deps))).toEqual(is401);
    expect(await refusal(await requireAuth(request(change(s, "POST", IMG)), deps))).toEqual(is401);
    expect(await refusal(await requireAuth(request({ origin: IMG, authorization: `Bearer ${a.token}` }), deps))).toEqual(is401);
    expect(await refusal(await requireAuth(request({ origin: IMG, authorization: `Bearer ${a.token}` }), deps, { only: "token" }))).toEqual(is401);
    expect(await refusal(await requireAuth(request({ origin: IMG, cookie: s.cookie }), deps, { admin: true }))).toEqual(is404);
    expect(await resolveSession(request({ origin: IMG, cookie: s.cookie }), deps)).toBeNull();
    expect(calls()).toBe(before);
  });

  it("with one address a session is accepted on it", async () => {
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    for (const origin of [APP, TOURS, "http://localhost:8787"]) {
      expect(await requireAuth(request({ origin, cookie: s.cookie }), deps), origin).toMatchObject({ workspaceId: a.workspaceId });
      expect(await requireAuth(request(change(s, "POST", origin)), deps), origin).toMatchObject({ workspaceId: a.workspaceId });
    }
  });

  it("a session change without the header, with another session's header, or from another origin is refused", async () => {
    const { deps, calls, clock, a, b } = await site(TWO);
    const s = await signIn(deps, a.userId);
    const mine2 = await signIn(deps, a.userId);
    const theirs = await signIn(deps, b.userId);
    // An hour on, so that a request that got as far as the session would write it.
    clock.now = NOW + SESSION_TOUCH_MS;
    const lastUsed = () => deps.db.first("SELECT last_used_at FROM session WHERE id = ?", [s.sessionId]);

    const before = calls();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const good = change(s, method);
      const withHeaders = (headers: Record<string, string>): Presented => ({ ...good, headers });
      const origins: Record<string, string>[] = [
        { "x-csrf-token": s.csrf },
        { "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin" },
        { origin: "null", "x-csrf-token": s.csrf },
        { origin: TOURS, "x-csrf-token": s.csrf },
        { origin: "https://evil.example", "x-csrf-token": s.csrf },
        { origin: "https://app.example.com.evil.example", "x-csrf-token": s.csrf },
        { origin: APP, "sec-fetch-site": "same-site", "x-csrf-token": s.csrf },
        { origin: APP, "sec-fetch-site": "cross-site", "x-csrf-token": s.csrf },
        { origin: APP, "sec-fetch-site": "none", "x-csrf-token": s.csrf },
        { referer: APP + "/account", "x-csrf-token": s.csrf },
      ];
      for (const headers of origins) expect(await refusal(await requireAuth(request(withHeaders(headers)), deps)), `${method} ${JSON.stringify(headers).slice(0, 60)}`).toEqual(is403origin);

      const tokens: (string | null)[] = [null, "", "x", mine2.csrf, theirs.csrf, s.csrf.toUpperCase(), s.csrf + "0", s.csrf.slice(0, -1), "x" + s.csrf, s.secret, s.sessionId, "0".repeat(64)];
      for (const token of tokens) {
        const headers: Record<string, string> = { origin: APP, "sec-fetch-site": "same-origin" };
        if (token !== null) headers["x-csrf-token"] = token;
        expect(await refusal(await requireAuth(request(withHeaders(headers)), deps)), `${method} ${token === null ? "none" : token.length}`).toEqual(is403csrf);
      }
      // The header in the cookie's place, or as a query, counts for nothing.
      expect(await refusal(await requireAuth(new Request(`${APP}/api/v1/tours?x-csrf-token=${s.csrf}`, { method, headers: { cookie: `${s.cookie}; x-csrf-token=${s.csrf}`, origin: APP } }), deps))).toEqual(is403csrf);
    }
    // Every one of those was refused before the database was asked, and none kept the session alive.
    expect(calls()).toBe(before);
    expect(await lastUsed()).toEqual({ last_used_at: NOW });

    // With its own header from its own origin, each method is the caller.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(await requireAuth(request(change(s, method)), deps), method).toMatchObject({ workspaceId: a.workspaceId, session: { id: s.sessionId } });
    }
    // Sec-Fetch-Site is only checked when the browser sends it.
    expect(await requireAuth(request({ method: "POST", cookie: s.cookie, headers: { origin: APP, "x-csrf-token": s.csrf } }), deps)).toMatchObject({ workspaceId: a.workspaceId });
    // A session that is over is nobody, even with the right header.
    await revokeAll(deps, a.userId);
    expect(await refusal(await requireAuth(request(change(s)), deps))).toEqual(is401);

    // Through the app, on a route that changes something.
    const path = "/api/v1/tours/tour_" + "0".repeat(24);
    const body = '{"title":"x"}';
    const forged = await send(deps, "PATCH", path, { origin: APP, body, headers: { cookie: theirs.cookie, origin: TOURS, "x-csrf-token": theirs.csrf } });
    expect([forged.status, forged.text, forged.calls]).toEqual([403, BAD_ORIGIN, 0]);
    const bare = await send(deps, "PATCH", path, { origin: APP, body, headers: { cookie: theirs.cookie, origin: APP } });
    expect([bare.status, bare.text, bare.calls]).toEqual([403, BAD_CSRF, 0]);
    const own = await send(deps, "PATCH", path, { origin: APP, body, headers: { cookie: theirs.cookie, origin: APP, "x-csrf-token": theirs.csrf } });
    expect([own.status, own.json.detail]).toEqual([404, "no such tour"]);
  });

  it("GET and HEAD need no header", async () => {
    const { deps, a } = await site(TWO);
    const s = await signIn(deps, a.userId);
    for (const method of ["GET", "HEAD"]) {
      expect(await requireAuth(request({ method, cookie: s.cookie }), deps), method).toMatchObject({ workspaceId: a.workspaceId });
      // Whatever the browser says about where a read came from: a read changes nothing.
      expect(await requireAuth(request({ method, cookie: s.cookie, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), deps), method).toMatchObject({ workspaceId: a.workspaceId });
    }
    const list = await send(deps, "GET", "/api/v1/tours", { origin: APP, headers: { cookie: s.cookie } });
    expect([list.status, list.json]).toEqual([200, { tours: [] }]);
  });

  it("a token-only route refuses a session, and a session-only route a token", async () => {
    const { deps, calls, a } = await site();
    const s = await signIn(deps, a.userId);

    const before = calls();
    expect(await refusal(await requireAuth(request({ cookie: s.cookie }), deps, { only: "token" }))).toEqual(is401);
    expect(await refusal(await requireAuth(request(change(s)), deps, { only: "token" }))).toEqual(is401);
    expect(await refusal(await requireAuth(request({ authorization: "Bearer " + a.token }), deps, { only: "session" }))).toEqual(is401);
    expect(await refusal(await requireAuth(request({ authorization: "Bearer nope" }), deps, { only: "session" }))).toEqual(is401);
    expect(await refusal(await requireAuth(request({}), deps, { only: "session" }))).toEqual(is401);
    expect(await refusal(await requireAuth(request({}), deps, { only: "token" }))).toEqual(is401);
    expect(calls()).toBe(before);
    // The refused token was not marked as used.
    expect(await tokenRow(deps, a.workspaceId)).toMatchObject({ last_used_at: null });

    // Each still takes its own kind.
    expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps, { only: "token", touch: false })).toMatchObject({ workspaceId: a.workspaceId, tokenId: expect.stringMatching(/^tok_/) });
    expect(await requireAuth(request({ cookie: s.cookie }), deps, { only: "session" })).toMatchObject({ workspaceId: a.workspaceId, tokenId: "", session: { id: s.sessionId } });

    // The one route that reads the token's own row asks for a token only.
    const connected = await send(deps, "GET", "/api/v1/setup/connected", { origin: APP, headers: { cookie: s.cookie } });
    expect([connected.status, connected.text, connected.calls]).toEqual([401, UNAUTHORIZED, 0]);
    const byToken = await send(deps, "GET", "/api/v1/setup/connected", { token: a.token });
    expect([byToken.status, byToken.json]).toEqual([200, { connected: false }]);
  });

  it("an admin route answers not found to a member and to a token", async () => {
    const { deps, calls, admin, a } = await site();
    const member = await signIn(deps, a.userId);
    const boss = await signIn(deps, admin.userId);
    const admins = { admin: true };

    // No credential, any token (the admin's own workspace's too), and anything malformed: no database call.
    const before = calls();
    for (const p of [{}, { authorization: "Bearer " + a.token }, { authorization: "Bearer " + admin.token }, { authorization: "Bearer nope" }, { cookie: `${SESSION_COOKIE}=x` }, { cookie: `${boss.cookie}; ${boss.cookie}` }]) {
      expect(await refusal(await requireAuth(request(p), deps, admins)), JSON.stringify(Object.keys(p))).toEqual(is404);
    }
    expect(calls()).toBe(before);
    expect(await tokenRow(deps, admin.workspaceId)).toMatchObject({ last_used_at: null });

    // A member, a session that is over, and a secret nobody has.
    expect(await refusal(await requireAuth(request({ cookie: member.cookie }), deps, admins))).toEqual(is404);
    expect(await refusal(await requireAuth(request(change(member)), deps, admins))).toEqual(is404);
    expect(await refusal(await requireAuth(request({ cookie: `${SESSION_COOKIE}=dps_${"0".repeat(64)}` }), deps, admins))).toEqual(is404);

    // The admin, by session: and a change still needs the header.
    expect(await requireAuth(request({ cookie: boss.cookie }), deps, admins)).toStrictEqual({ workspaceId: admin.workspaceId, tokenId: "", session: { id: boss.sessionId, userId: admin.userId, admin: true } });
    expect(await requireAuth(request(change(boss, "PATCH")), deps, admins)).toMatchObject({ session: { admin: true } });
    // Every refusal there is the one not-found, for the admin and for a member alike: a
    // missing or wrong anti-forgery value, another origin, a token beside the cookie.
    const idle = calls();
    for (const who of [boss, member]) {
      const refusedChanges: Presented[] = [
        { method: "PATCH", cookie: who.cookie, headers: { origin: APP } },
        { method: "PATCH", cookie: who.cookie, headers: { origin: APP, "x-csrf-token": member.csrf === who.csrf ? boss.csrf : member.csrf } },
        { method: "PATCH", cookie: who.cookie, headers: { origin: TOURS, "x-csrf-token": who.csrf } },
        { method: "PATCH", cookie: who.cookie, headers: { "x-csrf-token": who.csrf } },
        { method: "DELETE", cookie: who.cookie, headers: { origin: APP, "x-csrf-token": who.csrf, "sec-fetch-site": "cross-site" } },
        { cookie: who.cookie, authorization: "Bearer " + admin.token },
        { ...change(who, "PATCH"), authorization: "Bearer nope" },
        { ...change(who, "PATCH"), cookie: who.cookie + "0" },
      ];
      for (const p of refusedChanges) expect(await refusal(await requireAuth(request(p), deps, admins)), JSON.stringify(p.headers ?? {}).slice(0, 50)).toEqual(is404);
    }
    expect(calls()).toBe(idle);

    // Taking the admin flag away is felt on the next request; so is disabling the admin.
    await deps.db.run("UPDATE user SET is_admin = 0 WHERE id = ?", [admin.userId]);
    expect(await refusal(await requireAuth(request({ cookie: boss.cookie }), deps, admins))).toEqual(is404);
    await deps.db.run("UPDATE user SET is_admin = 1, status = 'disabled' WHERE id = ?", [admin.userId]);
    expect(await refusal(await requireAuth(request({ cookie: boss.cookie }), deps, admins))).toEqual(is404);
  });

  it("a disabled account's session and its workspace's token both get 401", async () => {
    const { deps, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);

    expect(await refusal(await requireAuth(request({ cookie: sa.cookie }), deps))).toEqual(is401);
    expect(await refusal(await requireAuth(request(change(sa)), deps))).toEqual(is401);
    expect(await refusal(await requireAuth(request({ authorization: "Bearer " + a.token }), deps))).toEqual(is401);
    expect(await refusal(await requireAuth(request({ authorization: "Bearer " + a.token }), deps, { touch: false }))).toEqual(is401);
    expect(await tokenRow(deps, a.workspaceId)).toMatchObject({ last_used_at: null });
    const viaApp = await send(deps, "GET", "/api/v1/me", { token: a.token });
    expect([viaApp.status, viaApp.text]).toEqual([401, UNAUTHORIZED]);
    // Nothing of the account was removed.
    expect(await deps.db.first("SELECT count(*) AS n FROM session WHERE user_id = ? AND revoked_at IS NULL", [a.userId])).toEqual({ n: 1 });

    // The other account is not touched by it.
    expect(await requireAuth(request({ cookie: sb.cookie }), deps)).toMatchObject({ workspaceId: b.workspaceId });
    expect(await requireAuth(request({ authorization: "Bearer " + b.token }), deps)).toMatchObject({ workspaceId: b.workspaceId });

    // Enabled again: both work again.
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [a.userId]);
    expect(await requireAuth(request({ cookie: sa.cookie }), deps)).toMatchObject({ workspaceId: a.workspaceId });
    expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps)).toMatchObject({ workspaceId: a.workspaceId });
  });

  it("a disabled owner without a membership row still stops that workspace's token", async () => {
    const { deps, a, b } = await site();
    // An account row an older build wrote: tied to its workspace by its own column only.
    await deps.db.run("DELETE FROM membership WHERE user_id = ?", [a.userId]);
    expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps)).toMatchObject({ workspaceId: a.workspaceId });
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    expect(await refusal(await requireAuth(request({ authorization: "Bearer " + a.token }), deps))).toEqual(is401);
    expect(await requireAuth(request({ authorization: "Bearer " + b.token }), deps)).toMatchObject({ workspaceId: b.workspaceId });
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [a.userId]);
    expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps)).toMatchObject({ workspaceId: a.workspaceId });

    // A workspace with no account row at all (the oldest databases) resolves as it always did.
    const bare = await seedWorkspace(deps, "Bare");
    await deps.db.batch([
      { sql: "DELETE FROM membership WHERE workspace_id = ?", params: [bare.workspaceId] },
      { sql: "DELETE FROM signin_method WHERE user_id IN (SELECT id FROM user WHERE workspace_id = ?)", params: [bare.workspaceId] },
      { sql: "DELETE FROM user WHERE workspace_id = ?", params: [bare.workspaceId] },
    ]);
    expect(await requireAuth(request({ authorization: "Bearer " + bare.token }), deps)).toMatchObject({ workspaceId: bare.workspaceId });
  });

  it("a disabled account that is a member of the workspace stops its token, whatever its own row names", async () => {
    const { deps, a, b } = await site();
    const spare = await seedWorkspace(deps, "Spare");
    // The account is tied to its workspace by its membership only: the older column on
    // its own row names another workspace.
    await deps.db.run("UPDATE user SET workspace_id = ? WHERE id = ?", [spare.workspaceId, a.userId]);
    expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps)).toMatchObject({ workspaceId: a.workspaceId });
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    expect(await refusal(await requireAuth(request({ authorization: "Bearer " + a.token }), deps))).toEqual(is401);
    // The workspace its row names is closed too, and nobody else's is.
    expect(await refusal(await requireAuth(request({ authorization: "Bearer " + spare.token }), deps))).toEqual(is401);
    expect(await requireAuth(request({ authorization: "Bearer " + b.token }), deps)).toMatchObject({ workspaceId: b.workspaceId });
  });

  it("on a database without the account tables a token resolves as it did, and no other failure does", async () => {
    // The membership table is not there yet: the real refusal of each target's database.
    {
      const { deps, calls, a } = await site();
      await deps.db.batch([{ sql: "DROP TABLE membership" }]);
      const sql = recordSql(deps);
      const before = calls();
      expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps, { touch: false })).toMatchObject({ workspaceId: a.workspaceId });
      expect(calls() - before).toBe(2);
      expect(sql).toHaveLength(2);
      expect(sql[1]).toBe("SELECT id, workspace_id, hash FROM api_token WHERE hash = ? AND revoked_at IS NULL");
      expect(await refusal(await requireAuth(request({ authorization: "Bearer dp_" + "0".repeat(40) }), deps))).toEqual(is401);
    }
    // The status column is not there yet: again the database's own words.
    {
      const { deps, a } = await site();
      await deps.db.batch([{ sql: "ALTER TABLE user DROP COLUMN status" }]);
      const sql = recordSql(deps);
      expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps, { touch: false })).toMatchObject({ workspaceId: a.workspaceId });
      expect(sql).toHaveLength(2);
    }
    // Any other failure of the lookup is a failure: nothing is looked up a second time,
    // and nobody is let in.
    const { deps, a } = await site();
    const db = deps.db;
    const failures = [
      "database is locked",
      "D1_ERROR: database is locked: SQLITE_BUSY",
      "no such table: api_token",
      "no such table: user",
      "no such table: membership_old",
      "no such column: u.status_code",
      "no such column: status",
      "no such column: m.user_id",
      "disk I/O error",
      "",
    ];
    for (const message of failures) {
      let lookups = 0;
      deps.db = {
        ...db,
        first: async () => {
          lookups++;
          throw new Error(message);
        },
      };
      await expect(requireAuth(request({ authorization: "Bearer " + a.token }), deps), message).rejects.toThrow();
      expect(lookups, message).toBe(1);
    }
    // The two texts that do mean "not migrated yet", bare and as each target wraps them.
    for (const message of ["no such table: membership", "D1_ERROR: no such table: membership: SQLITE_ERROR", "no such column: u.status", "D1_ERROR: no such column: u.status at offset 122: SQLITE_ERROR"]) {
      const seen: string[] = [];
      deps.db = {
        ...db,
        first: async (sql, params) => {
          seen.push(sql);
          if (seen.length === 1) throw new Error(message);
          return db.first(sql, params) as never;
        },
      };
      expect(await requireAuth(request({ authorization: "Bearer " + a.token }), deps, { touch: false }), message).toMatchObject({ workspaceId: a.workspaceId });
      expect(seen, message).toHaveLength(2);
      expect(seen[1]).toBe("SELECT id, workspace_id, hash FROM api_token WHERE hash = ? AND revoked_at IS NULL");
    }
    // The same text wrapped as the cause of another error.
    deps.db = { ...db, first: async () => Promise.reject(new Error("query failed", { cause: new Error("database is locked") })) };
    await expect(requireAuth(request({ authorization: "Bearer " + a.token }), deps)).rejects.toThrow();
    deps.db = db;
  });

  it("nothing of a cookie, a code or a header is ever logged", async () => {
    const { deps, a, b } = await site(TWO);
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const code = await createSignInCode(deps, a.userId);
    const made = await redeemSignInCode(deps, code, UA, null);
    const s = { ...made!, cookie: `${SESSION_COOKIE}=${made!.secret}`, csrf: await csrfFor(made!.secret) };
    const other = await signIn(deps, b.userId);
    await redeemSignInCode(deps, code, UA, s.secret);

    const answers: string[] = [];
    const presented: [Presented, Parameters<typeof requireAuth>[2]?][] = [
      [{ cookie: s.cookie }],
      [change(s)],
      [{ origin: TOURS, cookie: s.cookie }],
      [{ method: "POST", cookie: s.cookie }],
      [{ method: "POST", cookie: s.cookie, headers: { origin: APP, "x-csrf-token": other.csrf } }],
      [{ cookie: `${s.cookie}; ${other.cookie}` }],
      [{ cookie: s.cookie + "0" }],
      [{ cookie: s.cookie, authorization: "Bearer " + a.token }],
      [{ cookie: s.cookie }, { only: "token" }],
      [{ cookie: s.cookie }, { admin: true }],
      [{ authorization: "Bearer " + a.token }, { only: "session" }],
    ];
    for (const [p, opts] of presented) {
      const r = await requireAuth(request(p), deps, opts);
      if (r instanceof Response) answers.push(await r.text(), JSON.stringify(Object.fromEntries(r.headers)));
    }
    for (const path of ["/api/v1/me", "/api/v1/tours", "/api/v1/usage"]) {
      const r = await send(deps, "GET", path, { origin: APP, headers: { cookie: s.cookie } });
      answers.push(r.text, JSON.stringify(Object.fromEntries(r.headers)));
    }
    await revokeSession(deps, a.userId, s.sessionId);
    await revokeAll(deps, a.userId);
    answers.push((await send(deps, "GET", "/api/v1/me", { origin: APP, headers: { cookie: s.cookie } })).text);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    const audit = (await deps.db.all<Record<string, unknown>>("SELECT * FROM audit")).map((row) => JSON.stringify(row));
    expect(audit.length).toBeGreaterThan(2);
    for (const text of [...answers, ...audit]) {
      for (const secret of [code, s.secret, other.secret, s.csrf, other.csrf, a.token]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(secret.slice(4, 24));
      }
      expect(text).not.toContain(a.email);
    }
  });

  it("resolving a session is at most two calls", async () => {
    const { deps, calls, clock, a } = await site();
    const s = await signIn(deps, a.userId);
    const measure = async (p: Presented) => {
      const before = calls();
      const auth = await requireAuth(request(p), deps);
      expect(auth).toMatchObject({ workspaceId: a.workspaceId });
      return calls() - before;
    };
    // Within the hour: one read, for a read and for a change.
    expect(await measure({ cookie: s.cookie })).toBe(1);
    expect(await measure(change(s))).toBe(1);
    // An hour on: the read and the one write, then one read again.
    clock.now = NOW + SESSION_TOUCH_MS;
    expect(await measure(change(s, "DELETE"))).toBe(2);
    expect(await measure({ cookie: s.cookie })).toBe(1);
    clock.now = NOW + SESSION_TOUCH_MS * 2;
    expect(await measure({ cookie: s.cookie })).toBe(2);

    // A whole request through the app: the session's one call in place of the token's two.
    clock.now += 1;
    const bySession = await send(deps, "GET", "/api/v1/me", { origin: APP, headers: { cookie: s.cookie } });
    const byToken = await send(deps, "GET", "/api/v1/me", { token: a.token });
    expect([bySession.status, bySession.calls, byToken.status, byToken.calls]).toEqual([200, 2, 200, 3]);
  });
});
