// Sign-in lifetimes (Plan 2j, src/lifetimes.ts): SESSION_MAX_DAYS, CONNECTION_IDLE_DAYS and
// CONNECTION_MAX_DAYS, read from a setting, checked in the one credential lookup of each kind
// at request time, and shown in the tokens, sessions and session answers. Runs on both targets.
// Every request goes to the app through the harness; nothing is contacted.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { hashToken, newId, newToken, requireAuth } from "../src/auth.ts";
import {
  DAY_MS,
  DEFAULT_LIFETIMES,
  LIFETIME_SETTINGS,
  LIFETIME_UNUSABLE,
  daysSetting,
  lifetimesOf,
  lifetimesSetting,
  type Lifetimes,
} from "../src/lifetimes.ts";
import type { Config, Deps } from "../src/ports.ts";
import { SESSION_COOKIE, SESSION_MS, SESSION_TOUCH_MS, createSignInCode, csrfFor, redeemSignInCode, resolveSession, sweepSessions } from "../src/sessions.ts";
import { send, type Call, type SendOptions } from "./bundle.ts";

const NOW = 1_800_000_000_000;
const TWO: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com" } };
const APP = "https://app.example.com";
const TOURS = "https://tours.example.com";
const UNAUTHORIZED = '{"error":"unauthorized"}';

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** A site with a clock the test moves, an admin (sign-in is open) and one more account. */
async function site(config: Partial<Config> = {}) {
  const made = await makeDeps(config);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  await seedAccount(made.deps, { admin: true, username: "boss" });
  const a = await seedAccount(made.deps, { username: "alice" });
  const setLimits = (l: Partial<Lifetimes>) => void (made.deps.config.lifetimes = l);
  return { ...made, clock, a, setLimits, at: (ms: number) => void (clock.now = ms) };
}

type Signed = { secret: string; sessionId: string; userId: string; cookie: string; csrf: string };

async function signIn(deps: Deps, userId: string): Promise<Signed> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { ...made, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** A token of the workspace of the given kind, made at the clock's time, as connecting makes one. */
async function tokenOf(deps: Deps, workspaceId: string, kind: "sign_in" | "setup" = "sign_in", name = "Work laptop"): Promise<{ id: string; token: string }> {
  const token = newToken();
  const id = newId("tok");
  await deps.db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)", [id, workspaceId, name, await hashToken(token), deps.now(), kind]);
  return { id, token };
}

const lastUsed = async (deps: Deps, id: string) => (await deps.db.first<{ t: number | null }>("SELECT last_used_at AS t FROM api_token WHERE id = ?", [id]))!.t;

const tours = (deps: Deps, token: string, more: SendOptions = {}) => send(deps, "GET", "/api/v1/tours", { token, ...more });
const page = (s: Signed, origin = "https://tours.example.com"): Record<string, string> => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin", "content-type": "application/json" });
const sessionAnswer = (deps: Deps, s: Signed, more: SendOptions = {}) => send(deps, "GET", "/api/v1/session", { ...more, headers: { cookie: s.cookie } });
const tokenList = (deps: Deps, s: Signed, more: SendOptions = {}) => send(deps, "GET", "/api/v1/tokens", { ...more, headers: { cookie: s.cookie } });

describe("the settings", () => {
  it("unset or empty is the default; 0 and off in any case switch a limit off; 1 to 3650 is that many days", () => {
    for (const fallback of [90, null]) {
      for (const raw of [undefined, null, "", "   "]) expect(daysSetting(raw, fallback), String(raw)).toEqual({ days: fallback, bad: false });
      for (const raw of ["0", "00", "off", "OFF", " Off ", "oFf\n"]) expect(daysSetting(raw, fallback), raw).toEqual({ days: null, bad: false });
      for (const [raw, days] of [["1", 1], ["30", 30], ["007", 7], [" 3650 ", 3650]] as const) expect(daysSetting(raw, fallback), raw).toEqual({ days, bad: false });
    }
  });

  it("anything else is the default and one fixed line that names the setting, never the value", () => {
    const bad = ["3651", "-1", "1.5", "1e3", "90d", "ninety", "0x10", "+5", "1 000", "9999999999", "on", "false"];
    for (const raw of bad) expect(daysSetting(raw, 90), raw).toEqual({ days: 90, bad: true });
    for (const raw of [true, {}, ["1"], 1.5, -3, 4000, Number.NaN]) expect(daysSetting(raw, null), String(raw)).toEqual({ days: null, bad: true });
    // A Worker var written as a JSON number.
    expect([daysSetting(12, 90), daysSetting(0, 90)]).toEqual([{ days: 12, bad: false }, { days: null, bad: false }]);
    expect(lifetimesSetting({})).toEqual({ lifetimes: DEFAULT_LIFETIMES, problems: [] });
    expect(DEFAULT_LIFETIMES).toEqual({ sessionMaxDays: 90, connectionIdleDays: 90, connectionMaxDays: null });
    const all = lifetimesSetting({ SESSION_MAX_DAYS: "90d-secret", CONNECTION_IDLE_DAYS: "-7-secret", CONNECTION_MAX_DAYS: "forever-secret" });
    expect(all.lifetimes).toEqual(DEFAULT_LIFETIMES);
    expect(all.problems).toEqual(LIFETIME_SETTINGS.map((n) => LIFETIME_UNUSABLE[n]));
    expect(all.problems).toEqual([
      "sign-in lifetimes: SESSION_MAX_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default of 90 days applies. The site runs.",
      "sign-in lifetimes: CONNECTION_IDLE_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default of 90 days applies. The site runs.",
      "sign-in lifetimes: CONNECTION_MAX_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default, no limit, applies. The site runs.",
    ]);
    for (const line of all.problems) expect(line).not.toContain("secret");
    // One line for one bad setting; the others are read as written.
    expect(lifetimesSetting({ SESSION_MAX_DAYS: "off", CONNECTION_IDLE_DAYS: "7", CONNECTION_MAX_DAYS: "x" })).toEqual({
      lifetimes: { sessionMaxDays: null, connectionIdleDays: 7, connectionMaxDays: null },
      problems: [LIFETIME_UNUSABLE.CONNECTION_MAX_DAYS],
    });
  });

  it("a config without the key has the defaults; null is off", () => {
    expect(lifetimesOf({})).toEqual(DEFAULT_LIFETIMES);
    expect(lifetimesOf({ lifetimes: { sessionMaxDays: null } })).toEqual({ ...DEFAULT_LIFETIMES, sessionMaxDays: null });
    expect(lifetimesOf({ lifetimes: { connectionMaxDays: 30 } })).toEqual({ ...DEFAULT_LIFETIMES, connectionMaxDays: 30 });
  });
});

describe("SESSION_MAX_DAYS", () => {
  it("a session in steady use ends 90 days after it was made: served one ms before, refused at and after", async () => {
    const { deps, a, at } = await site();
    const s = await signIn(deps, a.userId);
    // Used every 20 days, so its 30-day sliding end never comes first.
    for (let t = NOW + 20 * DAY_MS; t < NOW + 90 * DAY_MS; t += 20 * DAY_MS) {
      at(t);
      expect((await sessionAnswer(deps, s)).status, `day ${(t - NOW) / DAY_MS}`).toBe(200);
    }
    at(NOW + 90 * DAY_MS - 1);
    expect((await sessionAnswer(deps, s)).status).toBe(200);
    at(NOW + 90 * DAY_MS);
    expect((await sessionAnswer(deps, s)).text).toBe(UNAUTHORIZED);
    at(NOW + 90 * DAY_MS + 1);
    expect((await sessionAnswer(deps, s)).text).toBe(UNAUTHORIZED);
  });

  it("a setting made smaller applies to a session that already exists, and a larger one or off brings it back", async () => {
    const { deps, a, at, setLimits } = await site();
    const s = await signIn(deps, a.userId);
    at(NOW + 2 * DAY_MS);
    expect((await sessionAnswer(deps, s)).status).toBe(200);
    // Its stored end is 30 days on; the new limit counts from when it was made.
    setLimits({ sessionMaxDays: 1 });
    at(NOW + DAY_MS + 2 * SESSION_TOUCH_MS);
    expect((await sessionAnswer(deps, s)).text).toBe(UNAUTHORIZED);
    expect((await resolveSession(new Request(TOURS + "/", { headers: { cookie: s.cookie } }), deps))).toBeNull();
    setLimits({ sessionMaxDays: null });
    expect((await sessionAnswer(deps, s)).status).toBe(200);
    setLimits({ sessionMaxDays: 3 });
    expect((await sessionAnswer(deps, s)).status).toBe(200);
  });

  it("off: a session in use lives past 90 days", async () => {
    const { deps, a, at, setLimits } = await site();
    setLimits({ sessionMaxDays: null });
    const s = await signIn(deps, a.userId);
    for (let t = NOW + 20 * DAY_MS; t <= NOW + 400 * DAY_MS; t += 20 * DAY_MS) {
      at(t);
      expect((await sessionAnswer(deps, s)).status).toBe(200);
    }
    const row = await deps.db.first<{ expires_at: number }>("SELECT expires_at FROM session WHERE id = ?", [s.sessionId]);
    expect(row!.expires_at).toBe(NOW + 400 * DAY_MS + SESSION_MS);
  });

  it("the stored end never passes created_at + max: at sign-in and when use pushes it on", async () => {
    const { deps, a, at, setLimits } = await site();
    setLimits({ sessionMaxDays: 1 });
    const s = await signIn(deps, a.userId);
    const end = async () => (await deps.db.first<{ e: number }>("SELECT expires_at AS e FROM session WHERE id = ?", [s.sessionId]))!.e;
    expect(await end()).toBe(NOW + DAY_MS);
    at(NOW + 2 * SESSION_TOUCH_MS);
    expect((await sessionAnswer(deps, s)).status).toBe(200);
    expect(await end()).toBe(NOW + DAY_MS);
    // A stored end that was capped is where the session ended: a larger setting later does not
    // move it (only the sliding end written by a use could, and no use is served after it).
    setLimits({ sessionMaxDays: 40 });
    at(NOW + DAY_MS);
    expect((await sessionAnswer(deps, s)).text).toBe(UNAUTHORIZED);
    // With 40 days, a use near the end pushes the stored end to the cap, not past it.
    at(NOW + 2 * DAY_MS);
    const t = await signIn(deps, a.userId);
    const endOf = async () => (await deps.db.first<{ e: number }>("SELECT expires_at AS e FROM session WHERE id = ?", [t.sessionId]))!.e;
    expect(await endOf()).toBe(NOW + 2 * DAY_MS + SESSION_MS);
    at(NOW + 22 * DAY_MS);
    expect((await sessionAnswer(deps, t)).status).toBe(200);
    expect(await endOf()).toBe(NOW + 42 * DAY_MS);
  });

  it("the session answer has ends_at and the three limits; the sessions list has each session's ends_at", async () => {
    const { deps, a, setLimits } = await site();
    const s = await signIn(deps, a.userId);
    const r = await sessionAnswer(deps, s);
    expect(r.json.session).toEqual({ id: s.sessionId, created_at: NOW, expires_at: NOW + SESSION_MS, ends_at: NOW + 90 * DAY_MS });
    expect(r.json.limits).toEqual({ session_max_days: 90, connection_idle_days: 90, connection_max_days: null });
    const list = await send(deps, "GET", "/api/v1/sessions", { headers: { cookie: s.cookie } });
    expect(list.json.sessions.map((x: { ends_at: number | null }) => x.ends_at)).toEqual([NOW + 90 * DAY_MS]);
    setLimits({ sessionMaxDays: null, connectionIdleDays: 7, connectionMaxDays: 30 });
    expect((await sessionAnswer(deps, s)).json.limits).toEqual({ session_max_days: null, connection_idle_days: 7, connection_max_days: 30 });
    expect((await sessionAnswer(deps, s)).json.session.ends_at).toBeNull();
    expect((await send(deps, "GET", "/api/v1/sessions", { headers: { cookie: s.cookie } })).json.sessions[0].ends_at).toBeNull();
  });

  it("a lapsed session is not listed among the account's sessions, and a sweep removes it", async () => {
    const { deps, a, at, setLimits } = await site();
    const old = await signIn(deps, a.userId);
    at(NOW + 10 * DAY_MS);
    const fresh = await signIn(deps, a.userId);
    setLimits({ sessionMaxDays: 5 });
    const list = await send(deps, "GET", "/api/v1/sessions", { headers: { cookie: fresh.cookie } });
    expect(list.json.sessions.map((x: { id: string }) => x.id)).toEqual([fresh.sessionId]);
    await sweepSessions(deps);
    expect((await deps.db.all<{ id: string }>("SELECT id FROM session ORDER BY created_at")).map((r) => r.id)).toEqual([fresh.sessionId]);
    expect(old.sessionId).not.toBe(fresh.sessionId);
  });

  it("sign-out, the token list and the connect confirm refuse a lapsed session as they refuse a revoked one", async () => {
    const { deps, a, at, setLimits } = await site();
    const lapsed = await signIn(deps, a.userId);
    const revoked = await signIn(deps, a.userId);
    await deps.db.run("UPDATE session SET revoked_at = ? WHERE id = ?", [NOW, revoked.sessionId]);
    at(NOW + 3 * DAY_MS);
    setLimits({ sessionMaxDays: 2 });
    const start = await send(deps, "POST", "/api/v1/connect/start", { body: JSON.stringify({ device_name: "Laptop" }), headers: { "content-type": "application/json" } });
    expect(start.status, start.text).toBe(201);
    for (const s of [lapsed, revoked]) {
      const calls = [
        await send(deps, "POST", "/api/v1/signout", { headers: page(s) }),
        await tokenList(deps, s),
        await send(deps, "POST", "/api/v1/connect/confirm", { body: JSON.stringify({ user_code: start.json.user_code }), headers: page(s) }),
        await send(deps, "POST", "/api/v1/connect/lookup", { body: JSON.stringify({ user_code: start.json.user_code }), headers: page(s) }),
      ];
      for (const c of calls) expect(c.text).toBe(UNAUTHORIZED);
    }
    // The lapsed session was not revoked by its sign-out: it was refused before anything.
    expect((await deps.db.first<{ r: number | null }>("SELECT revoked_at AS r FROM session WHERE id = ?", [lapsed.sessionId]))!.r).toBeNull();
  });

  it("a request confirmed from a session that lapses before Mythicshot collects makes no token", async () => {
    const { deps, a, at, setLimits } = await site();
    const s = await signIn(deps, a.userId);
    at(NOW + 3 * DAY_MS);
    const start = await send(deps, "POST", "/api/v1/connect/start", { body: JSON.stringify({ device_name: "Laptop" }), headers: { "content-type": "application/json" } });
    const ok = await send(deps, "POST", "/api/v1/connect/confirm", { body: JSON.stringify({ user_code: start.json.user_code }), headers: page(s) });
    expect(ok.status, ok.text).toBe(204);
    setLimits({ sessionMaxDays: 3 });
    const poll = await send(deps, "POST", "/api/v1/connect/token", { body: JSON.stringify({ device_code: start.json.device_code }), headers: { "content-type": "application/json" } });
    expect([poll.status, poll.json.error]).toEqual([410, "expired_code"]);
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM api_token WHERE kind = 'sign_in'"))!.n).toBe(0);
  });
});

describe("CONNECTION_IDLE_DAYS", () => {
  it("a connection never used is refused 90 days after it was made: served one ms before, refused at and after", async () => {
    const { deps, a, at } = await site();
    const t = await tokenOf(deps, a.workspaceId);
    at(NOW + 90 * DAY_MS - 1);
    // A lookup that does not record the use, so the next two are judged from created_at too.
    expect(await requireAuth(new Request(TOURS + "/api/v1/tours", { headers: { authorization: "Bearer " + t.token } }), deps, { touch: false })).toEqual({ workspaceId: a.workspaceId, tokenId: t.id });
    at(NOW + 90 * DAY_MS);
    expect((await tours(deps, t.token)).text).toBe(UNAUTHORIZED);
    at(NOW + 90 * DAY_MS + 1);
    expect((await tours(deps, t.token)).text).toBe(UNAUTHORIZED);
    expect(await lastUsed(deps, t.id)).toBeNull();
  });

  it("each use records itself, so a connection in regular use never lapses; the limit counts from the last use", async () => {
    const { deps, a, at } = await site();
    const t = await tokenOf(deps, a.workspaceId);
    for (let day = 89; day <= 89 * 5; day += 89) {
      at(NOW + day * DAY_MS);
      expect((await tours(deps, t.token)).status, `day ${day}`).toBe(200);
      expect(await lastUsed(deps, t.id)).toBe(NOW + day * DAY_MS);
    }
    const last = NOW + 89 * 5 * DAY_MS;
    at(last + 90 * DAY_MS - 1);
    expect((await tours(deps, t.token)).status).toBe(200);
    at(last + 90 * DAY_MS - 1 + 90 * DAY_MS);
    expect((await tours(deps, t.token)).text).toBe(UNAUTHORIZED);
  });

  it("a lapsed connection's own request does not record a use, so it cannot bring itself back", async () => {
    const { deps, a, at } = await site();
    const t = await tokenOf(deps, a.workspaceId);
    at(NOW + DAY_MS);
    expect((await tours(deps, t.token)).status).toBe(200);
    at(NOW + 91 * DAY_MS);
    for (let i = 0; i < 3; i++) expect((await tours(deps, t.token)).text).toBe(UNAUTHORIZED);
    expect(await lastUsed(deps, t.id)).toBe(NOW + DAY_MS);
  });

  it("a request whose lookup ran before the limit passed is served, and records the time of its lookup", async () => {
    const { deps, a, clock } = await site();
    const t = await tokenOf(deps, a.workspaceId);
    const end = NOW + 90 * DAY_MS;
    // The first reading of the clock is the lookup's; every later one is past the end.
    let reads = 0;
    deps.now = () => (reads++ === 0 ? end - 1 : end + 5000);
    const auth = await requireAuth(new Request(TOURS + "/api/v1/tours", { headers: { authorization: "Bearer " + t.token } }), deps);
    expect(auth).toEqual({ workspaceId: a.workspaceId, tokenId: t.id });
    expect(await lastUsed(deps, t.id)).toBe(end - 1);
    deps.now = () => clock.now;
  });

  it("a setting made smaller applies to a connection that already exists; off brings it back", async () => {
    const { deps, a, at, setLimits } = await site();
    const t = await tokenOf(deps, a.workspaceId);
    at(NOW + 10 * DAY_MS);
    expect((await tours(deps, t.token)).status).toBe(200);
    at(NOW + 15 * DAY_MS);
    setLimits({ connectionIdleDays: 5 });
    expect((await tours(deps, t.token)).text).toBe(UNAUTHORIZED);
    setLimits({ connectionIdleDays: null });
    expect((await tours(deps, t.token)).status).toBe(200);
  });

  it("the setup token and a token made before connections are never touched by either limit", async () => {
    const { deps, a, at, setLimits } = await site();
    const made = await tokenOf(deps, a.workspaceId, "setup");
    setLimits({ connectionIdleDays: 1, connectionMaxDays: 1 });
    at(NOW + 3000 * DAY_MS);
    expect((await tours(deps, a.token)).status).toBe(200);
    expect((await tours(deps, made.token)).status).toBe(200);
    expect((await tokenList(deps, await signIn(deps, a.userId))).json.tokens.map((x: { kind: string; expires_at: unknown; expired: unknown }) => [x.kind, x.expires_at, x.expired])).toEqual([
      ["setup", null, false],
      ["setup", null, false],
    ]);
  });
});

describe("CONNECTION_MAX_DAYS", () => {
  it("a connection in steady use is refused this long after it was made: served one ms before, refused at and after", async () => {
    const { deps, a, at, setLimits } = await site();
    setLimits({ connectionMaxDays: 10 });
    const t = await tokenOf(deps, a.workspaceId);
    for (let day = 1; day < 10; day++) {
      at(NOW + day * DAY_MS);
      expect((await tours(deps, t.token)).status).toBe(200);
    }
    at(NOW + 10 * DAY_MS - 1);
    expect((await tours(deps, t.token)).status).toBe(200);
    at(NOW + 10 * DAY_MS);
    expect((await tours(deps, t.token)).text).toBe(UNAUTHORIZED);
    at(NOW + 10 * DAY_MS + 1);
    expect((await tours(deps, t.token)).text).toBe(UNAUTHORIZED);
    expect(await lastUsed(deps, t.id)).toBe(NOW + 10 * DAY_MS - 1);
  });

  it("off by default: a connection in use works past any age", async () => {
    const { deps, a, at } = await site();
    const t = await tokenOf(deps, a.workspaceId);
    for (let day = 80; day <= 800; day += 80) {
      at(NOW + day * DAY_MS);
      expect((await tours(deps, t.token)).status).toBe(200);
    }
  });
});

describe("a lapsed credential answers as a revoked one, byte for byte", () => {
  it("a token on the tours and the app address, and a session on the app address", async () => {
    const { deps, a, at, setLimits } = await site(TWO);
    const lapsed = await tokenOf(deps, a.workspaceId, "sign_in", "Old");
    const revoked = await tokenOf(deps, a.workspaceId, "sign_in", "Gone");
    await deps.db.run("UPDATE api_token SET revoked_at = ? WHERE id = ?", [NOW, revoked.id]);
    const lapsedSession = await signIn(deps, a.userId);
    const revokedSession = await signIn(deps, a.userId);
    await deps.db.run("UPDATE session SET revoked_at = ? WHERE id = ?", [NOW, revokedSession.sessionId]);
    at(NOW + 2 * DAY_MS);
    setLimits({ connectionIdleDays: 1, sessionMaxDays: 1 });
    const pairs: [string, Call, Call][] = [
      ["GET /api/v1/tours on tours", await tours(deps, lapsed.token, { origin: TOURS }), await tours(deps, revoked.token, { origin: TOURS })],
      ["GET /api/v1/tours on app", await tours(deps, lapsed.token, { origin: APP }), await tours(deps, revoked.token, { origin: APP })],
      ["GET /api/v1/usage on tours", await send(deps, "GET", "/api/v1/usage", { token: lapsed.token, origin: TOURS }), await send(deps, "GET", "/api/v1/usage", { token: revoked.token, origin: TOURS })],
      ["GET /api/v1/tokens", await tokenList(deps, lapsedSession, { origin: APP }), await tokenList(deps, revokedSession, { origin: APP })],
      ["GET /api/v1/session", await sessionAnswer(deps, lapsedSession, { origin: APP }), await sessionAnswer(deps, revokedSession, { origin: APP })],
      ["POST /api/v1/signout", await send(deps, "POST", "/api/v1/signout", { origin: APP, headers: page(lapsedSession, APP) }), await send(deps, "POST", "/api/v1/signout", { origin: APP, headers: page(revokedSession, APP) })],
    ];
    for (const [what, l, r] of pairs) {
      expect(l.status, what).toBe(401);
      expect(seen(l), what).toEqual(seen(r));
    }
    // And the same as a token nobody has.
    expect(seen(pairs[0][1])).toEqual(seen(await tours(deps, newToken(), { origin: TOURS })));
  });

  it("the calls are the same too: no route makes a call more for a lapsed credential", async () => {
    const { deps, a, at, setLimits } = await site();
    const lapsed = await tokenOf(deps, a.workspaceId);
    const live = await tokenOf(deps, a.workspaceId);
    at(NOW + 2 * DAY_MS);
    await tours(deps, live.token);
    setLimits({ connectionIdleDays: 1 });
    const unknown = await tours(deps, newToken());
    expect((await tours(deps, lapsed.token)).calls).toBe(unknown.calls);
    expect((await tours(deps, live.token)).calls).toBe((await tours(deps, a.token)).calls);
  });
});

describe("the tokens answer", () => {
  it("each entry has expires_at, null for a setup token, and expired; a lapsed connection is listed, a revoked one is not", async () => {
    const { deps, a, at, setLimits } = await site();
    at(NOW + 1);
    const used = await tokenOf(deps, a.workspaceId, "sign_in", "Used");
    at(NOW + DAY_MS);
    const never = await tokenOf(deps, a.workspaceId, "sign_in", "Never used");
    const gone = await tokenOf(deps, a.workspaceId, "sign_in", "Revoked");
    await deps.db.run("UPDATE api_token SET revoked_at = ? WHERE id = ?", [NOW + DAY_MS, gone.id]);
    at(NOW + 5 * DAY_MS);
    expect((await tours(deps, used.token)).status).toBe(200);
    const s = await signIn(deps, a.userId);
    const list = async () => (await tokenList(deps, s)).json.tokens.map((x: { name: string; expires_at: number | null; expired: boolean }) => [x.name, x.expires_at, x.expired]);
    expect(await list()).toEqual([
      ["Never used", NOW + DAY_MS + 90 * DAY_MS, false],
      ["Used", NOW + 5 * DAY_MS + 90 * DAY_MS, false],
      ["First token", null, false],
    ]);
    // The age limit comes first when it is earlier.
    setLimits({ connectionMaxDays: 50 });
    expect(await list()).toEqual([
      ["Never used", NOW + DAY_MS + 50 * DAY_MS, false],
      ["Used", NOW + 1 + 50 * DAY_MS, false],
      ["First token", null, false],
    ]);
    // Lapsed: still listed, so its owner sees why the computer asks to sign in again, and can remove it.
    setLimits({ connectionIdleDays: 3 });
    expect(await list()).toEqual([
      ["Never used", NOW + DAY_MS + 3 * DAY_MS, true],
      ["Used", NOW + 5 * DAY_MS + 3 * DAY_MS, false],
      ["First token", null, false],
    ]);
    at(NOW + 8 * DAY_MS);
    expect((await list()).map((x: unknown[]) => x[2])).toEqual([true, true, false]);
    const drop = await send(deps, "DELETE", `/api/v1/tokens/${never.id}`, { headers: page(s) });
    expect(drop.status).toBe(204);
    expect((await list()).map((x: unknown[]) => x[0])).toEqual(["Used", "First token"]);
    // Both limits off: no end for anything.
    setLimits({ connectionIdleDays: null, connectionMaxDays: null });
    expect(await list()).toEqual([
      ["Used", null, false],
      ["First token", null, false],
    ]);
  });
});

describe("the app's own routes reach the same check", () => {
  it("a lapsed session reads nothing on any session route", async () => {
    const { deps, a, at, setLimits } = await site();
    const s = await signIn(deps, a.userId);
    at(NOW + 2 * DAY_MS);
    setLimits({ sessionMaxDays: 1 });
    for (const path of ["/api/v1/session", "/api/v1/sessions", "/api/v1/tokens", "/api/v1/usage", "/api/v1/tours"]) {
      const r = await send(deps, "GET", path, { headers: { cookie: s.cookie } });
      expect(r.text, path).toBe(UNAUTHORIZED);
    }
    // The app itself, without the harness's helper, answers the same.
    const res = await createApp(deps).fetch(new Request(TOURS + "/api/v1/session", { headers: { cookie: s.cookie } }));
    expect([res.status, await res.text()]).toEqual([401, UNAUTHORIZED]);
  });
});

describe("the settings on Workers, in the README and in the API description", () => {
  it("the vars reach the config, a default leaves the key out, and the entry says each bad one once per instance", async () => {
    const load = import.meta.glob("../src/cloudflare/entry.ts");
    const entry = (await load["../src/cloudflare/entry.ts"]()) as {
      depsFromEnv(env: Record<string, unknown>, hosts: null): { config: Record<string, unknown> };
    };
    const config = (env: Record<string, unknown>) => entry.depsFromEnv({ DB: {}, DRAFTS: {}, PUB: {}, ...env }, null).config;
    expect("lifetimes" in config({})).toBe(false);
    expect("lifetimes" in config({ SESSION_MAX_DAYS: "90", CONNECTION_IDLE_DAYS: "", CONNECTION_MAX_DAYS: "nonsense" })).toBe(false);
    expect(config({ SESSION_MAX_DAYS: "off", CONNECTION_IDLE_DAYS: 30, CONNECTION_MAX_DAYS: "365" }).lifetimes).toEqual({ sessionMaxDays: null, connectionIdleDays: 30, connectionMaxDays: 365 });
    const source = (import.meta.glob("../src/cloudflare/entry.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../src/cloudflare/entry.ts"];
    expect(source).toContain("    if (!lifetimesSaid) {\n      lifetimesSaid = true;\n      for (const line of lifetimesSetting(lifetimeVars(env)).problems) console.error(line);\n    }");
  });

  it("the README names each setting in one line of its settings table, for both targets", () => {
    const readme = (import.meta.glob("../README.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../README.md"];
    for (const name of LIFETIME_SETTINGS) {
      const rows = readme.split("\n").filter((l) => l.startsWith(`| \`${name}\` | both |`));
      expect(rows, name).toHaveLength(1);
      expect(rows[0], name).toContain(LIFETIME_UNUSABLE[name]);
    }
  });
});
