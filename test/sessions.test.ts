// Sessions and sign-in codes: the cookie, the anti-forgery value, the origin check, the
// codes, and creating, resolving, revoking and sweeping sessions. Runs on both targets.
//
// Helpers live in this file: the harnesses are not edited by this task.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import type { Deps } from "../src/ports.ts";
import {
  CODE_KEPT_MS,
  REVOKED_KEPT_MS,
  SESSION_COOKIE,
  SESSION_MS,
  SESSION_TOUCH_MS,
  SIGNIN_CODE_MS,
  SWEEP_PAGE,
  clearedCookie,
  createSignInCode,
  csrfFor,
  readSessionCookie,
  redeemSignInCode,
  resolveSession,
  revokeAll,
  revokeSession,
  sameOriginChange,
  sessionCookie,
  sessionCookiePresent,
  sessionLabel,
  sweepSessions,
} from "../src/sessions.ts";

const NOW = 1_800_000_000_000;
const APP = "https://app.example.com";
const CODE = /^dpl_[0-9a-f]{40}$/;
const SECRET = /^dps_[0-9a-f]{64}$/;
/** What Firefox on Linux sends as its User-Agent. */
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

async function sha(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

async function count(deps: Deps, table: string, where = "1 = 1"): Promise<number> {
  return (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))!.n;
}

/** Deps with a clock the test moves, an admin (so sign-in is open) and two more accounts. */
async function site(opts: { admin?: boolean } = {}) {
  const made = await makeDeps();
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  const admin = opts.admin === false ? null : await seedAccount(made.deps, { admin: true, username: "boss" });
  const a = await seedAccount(made.deps);
  const b = await seedAccount(made.deps);
  return { deps: made.deps, calls: made.calls, clock, admin, a, b };
}

/** A new code for the account, redeemed at once. */
async function signIn(deps: Deps, userId: string, replaces: string | null = null) {
  const code = await createSignInCode(deps, userId);
  const made = await redeemSignInCode(deps, code, UA, replaces);
  if (made === null) throw new Error("the sign-in was refused");
  return made;
}

function withCookie(cookie: string | null, method = "GET", origin = APP): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(origin + "/api/v1/tours", { method, headers });
}

const cookieOf = (secret: string) => `${SESSION_COOKIE}=${secret}`;

/** Every value of every column of every table, as text. */
async function everyStoredValue(deps: Deps): Promise<string[]> {
  const tables = await deps.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_*' AND name NOT GLOB 'd1_*'",
  );
  const out: string[] = [];
  for (const { name } of tables) {
    for (const row of await deps.db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`)) for (const v of Object.values(row)) out.push(String(v));
  }
  return out;
}

describe("sign-in codes", () => {
  it("a code works once", async () => {
    const { deps, calls, a } = await site();
    const code = await createSignInCode(deps, a.userId);
    expect(code).toMatch(CODE);
    expect(await deps.db.all("SELECT user_id, created_at, expires_at, used_at, session_id FROM signin_code")).toEqual([
      { user_id: a.userId, created_at: NOW, expires_at: NOW + SIGNIN_CODE_MS, used_at: null, session_id: null },
    ]);

    // One read and one batch.
    const before = calls();
    const made = await redeemSignInCode(deps, code, UA, null);
    expect(calls() - before).toBe(2);
    expect(made).not.toBeNull();
    expect(Object.keys(made!).sort()).toEqual(["secret", "sessionId", "userId"]);
    expect(made!.secret).toMatch(SECRET);
    expect(made!.sessionId).toMatch(/^ses_[0-9a-f]{24}$/);
    expect(made!.userId).toBe(a.userId);
    expect(await deps.db.all("SELECT id, user_id, label, created_at, last_used_at, expires_at, revoked_at FROM session")).toEqual([
      { id: made!.sessionId, user_id: a.userId, label: "Firefox on Linux", created_at: NOW, last_used_at: NOW, expires_at: NOW + SESSION_MS, revoked_at: null },
    ]);
    expect(await deps.db.all("SELECT used_at, session_id FROM signin_code")).toEqual([{ used_at: NOW, session_id: made!.sessionId }]);
    // The record of it, written with it.
    expect(await deps.db.all("SELECT at, event, user_id, workspace_id, subject, detail FROM audit")).toEqual([
      { at: NOW, event: "signin", user_id: a.userId, workspace_id: a.workspaceId, subject: made!.sessionId, detail: null },
    ]);

    // The same code again, and again: nothing.
    expect(await redeemSignInCode(deps, code, UA, null)).toBeNull();
    expect(await redeemSignInCode(deps, code, UA, null)).toBeNull();
    expect(await count(deps, "session")).toBe(1);
    expect(await count(deps, "audit")).toBe(1);

    // A code nobody was given, and things that are not codes at all (no database call for those).
    expect(await redeemSignInCode(deps, "dpl_" + "0".repeat(40), UA, null)).toBeNull();
    const idle = calls();
    for (const bad of ["", "dpl_", code.toUpperCase(), code + "0", code.slice(0, -1), " " + code, code + "\n", "dps_" + "0".repeat(64), "dp_" + "0".repeat(40)]) {
      expect(await redeemSignInCode(deps, bad, UA, null), JSON.stringify(bad.slice(0, 8))).toBeNull();
    }
    expect(calls()).toBe(idle);
    expect(await count(deps, "session")).toBe(1);
    expect(await count(deps, "audit")).toBe(1);
  });

  it("two presses at once make one session", async () => {
    const { deps, a, b } = await site();
    for (let round = 0; round < 6; round++) {
      const code = await createSignInCode(deps, a.userId);
      const presses = await Promise.all([
        redeemSignInCode(deps, code, UA, null),
        redeemSignInCode(deps, code, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", null),
        redeemSignInCode(deps, code, null, null),
      ]);
      const won = presses.filter((p) => p !== null);
      expect(won, `round ${round}`).toHaveLength(1);
      expect(await count(deps, "session")).toBe(round + 1);
      expect(await count(deps, "audit")).toBe(round + 1);
      // The code names the session that was made, and that session is the winner's.
      expect(await deps.db.first("SELECT session_id FROM signin_code WHERE hash = ?", [await sha(code)])).toEqual({ session_id: won[0]!.sessionId });
      expect(await resolveSession(withCookie(cookieOf(won[0]!.secret)), deps)).toMatchObject({ sessionId: won[0]!.sessionId, userId: a.userId });
    }
    // One after the other is the same.
    const code = await createSignInCode(deps, b.userId);
    expect(await redeemSignInCode(deps, code, UA, null)).not.toBeNull();
    expect(await redeemSignInCode(deps, code, UA, null)).toBeNull();
    expect(await count(deps, "session", "user_id = '" + b.userId + "'")).toBe(1);
  });

  it("a code is refused after 15 minutes, for a disabled account, and while the site has no admin", async () => {
    const { deps, clock, a, b } = await site();

    // The last millisecond works; the fifteenth minute does not.
    const late = await createSignInCode(deps, a.userId);
    const tooLate = await createSignInCode(deps, a.userId);
    clock.now = NOW + SIGNIN_CODE_MS - 1;
    expect(await redeemSignInCode(deps, late, UA, null)).not.toBeNull();
    clock.now = NOW + SIGNIN_CODE_MS;
    expect(await redeemSignInCode(deps, tooLate, UA, null)).toBeNull();
    clock.now = NOW + SIGNIN_CODE_MS * 4;
    expect(await redeemSignInCode(deps, tooLate, UA, null)).toBeNull();
    expect(await count(deps, "session")).toBe(1);
    expect(await count(deps, "audit")).toBe(1);

    // A disabled account: refused, and the press spent the code, so enabling the account
    // again does not bring the link back.
    const forDisabled = await createSignInCode(deps, b.userId);
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [b.userId]);
    expect(await redeemSignInCode(deps, forDisabled, UA, null)).toBeNull();
    expect(await count(deps, "session", "user_id = '" + b.userId + "'")).toBe(0);
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [b.userId]);
    expect(await redeemSignInCode(deps, forDisabled, UA, null)).toBeNull();
    expect(await count(deps, "session", "user_id = '" + b.userId + "'")).toBe(0);
    expect(await count(deps, "audit")).toBe(1);
    // A new code for the enabled account works.
    expect(await redeemSignInCode(deps, await createSignInCode(deps, b.userId), UA, null)).not.toBeNull();
  });

  it("a code is refused while the site has no admin, and for an account with no workspace", async () => {
    const { deps, a, b } = await site({ admin: false });
    const early = await createSignInCode(deps, a.userId);
    expect(await redeemSignInCode(deps, early, UA, null)).toBeNull();
    expect(await count(deps, "session")).toBe(0);
    expect(await count(deps, "audit")).toBe(0);
    // Once somebody is the admin, sign-in is open: for a new code, not for the spent one.
    await deps.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [b.userId]);
    expect(await redeemSignInCode(deps, early, UA, null)).toBeNull();
    expect(await redeemSignInCode(deps, await createSignInCode(deps, a.userId), UA, null)).not.toBeNull();

    // An account row without a membership (one an older build wrote) cannot sign in.
    const orphan = await seedAccount(deps);
    await deps.db.run("DELETE FROM membership WHERE user_id = ?", [orphan.userId]);
    expect(await redeemSignInCode(deps, await createSignInCode(deps, orphan.userId), UA, null)).toBeNull();
    expect(await count(deps, "session", "user_id = '" + orphan.userId + "'")).toBe(0);
  });

  it("only hashes of the code and the session are stored", async () => {
    const { deps, a } = await site();
    const code = await createSignInCode(deps, a.userId);
    const unused = await createSignInCode(deps, a.userId);
    const made = (await redeemSignInCode(deps, code, UA, null))!;
    const second = await signIn(deps, a.userId, made.secret);
    await resolveSession(withCookie(cookieOf(second.secret)), deps);
    await revokeSession(deps, a.userId, second.sessionId);
    await revokeAll(deps, a.userId);

    expect(await deps.db.all("SELECT hash FROM signin_code WHERE hash IN (?, ?) ORDER BY created_at, hash", [await sha(code), await sha(unused)])).toHaveLength(2);
    expect(await deps.db.first("SELECT id FROM session WHERE hash = ?", [await sha(made.secret)])).toEqual({ id: made.sessionId });

    const csrf = await csrfFor(made.secret);
    const stored = await everyStoredValue(deps);
    expect(stored.length).toBeGreaterThan(20);
    for (const v of stored) {
      for (const secret of [code, unused, made.secret, second.secret]) {
        expect(v).not.toContain(secret);
        expect(v).not.toContain(secret.slice(4));
      }
      expect(v).not.toContain(csrf);
    }
  });
});

describe("sessions", () => {
  it("a session lasts 30 days from its last use and is written at most once an hour", async () => {
    const { deps, calls, clock, a } = await site();
    const s = await signIn(deps, a.userId);
    const row = () => deps.db.first<{ last_used_at: number; expires_at: number }>("SELECT last_used_at, expires_at FROM session WHERE id = ?", [s.sessionId]);
    const use = async () => {
      const before = calls();
      const who = await resolveSession(withCookie(cookieOf(s.secret)), deps);
      return { who, calls: calls() - before };
    };

    // Within the hour: read, never written.
    for (const at of [NOW, NOW + 1, NOW + 600_000, NOW + SESSION_TOUCH_MS - 1]) {
      clock.now = at;
      const used = await use();
      expect(used.who).toStrictEqual({ sessionId: s.sessionId, userId: a.userId, workspaceId: a.workspaceId, admin: false, csrf: await csrfFor(s.secret) });
      expect(JSON.stringify(used.who)).not.toContain(s.secret.slice(4));
      expect(used.calls).toBe(1);
    }
    expect(await row()).toEqual({ last_used_at: NOW, expires_at: NOW + SESSION_MS });

    // An hour after the last write: written once, then not again for an hour.
    const t1 = NOW + SESSION_TOUCH_MS;
    clock.now = t1;
    expect((await use()).calls).toBe(2);
    expect(await row()).toEqual({ last_used_at: t1, expires_at: t1 + SESSION_MS });
    clock.now = t1 + 5;
    expect((await use()).calls).toBe(1);
    expect(await row()).toEqual({ last_used_at: t1, expires_at: t1 + SESSION_MS });

    // Used on its last millisecond, it lives 30 more days from then.
    const t2 = t1 + SESSION_MS - 1;
    clock.now = t2;
    expect((await use()).who).not.toBeNull();
    expect(await row()).toEqual({ last_used_at: t2, expires_at: t2 + SESSION_MS });

    // Not used for 30 days: over, and no use brings it back.
    clock.now = t2 + SESSION_MS;
    const dead = await use();
    expect(dead.who).toBeNull();
    expect(dead.calls).toBe(1);
    clock.now = t2 + SESSION_MS + SESSION_TOUCH_MS;
    expect((await use()).who).toBeNull();
    expect(await row()).toEqual({ last_used_at: t2, expires_at: t2 + SESSION_MS });
  });

  it("a revoked or expired session is nobody", async () => {
    const { deps, calls, clock, a, b } = await site();
    const s = await signIn(deps, a.userId);
    const other = await signIn(deps, a.userId);
    const theirs = await signIn(deps, b.userId);
    const who = (secret: string) => resolveSession(withCookie(cookieOf(secret)), deps);
    expect(await who(s.secret)).toMatchObject({ sessionId: s.sessionId });

    // A secret nobody was given.
    expect(await who("dps_" + "0".repeat(64))).toBeNull();
    // No cookie at all: no database call.
    const idle = calls();
    expect(await resolveSession(withCookie(null), deps)).toBeNull();
    expect(calls()).toBe(idle);

    // Another account cannot revoke it, an unknown id revokes nothing, and both leave it live.
    expect(await revokeSession(deps, b.userId, s.sessionId)).toBe(false);
    expect(await revokeSession(deps, a.userId, "ses_" + "0".repeat(24))).toBe(false);
    expect(await revokeSession(deps, a.userId, theirs.sessionId)).toBe(false);
    expect(await who(s.secret)).not.toBeNull();
    expect(await who(theirs.secret)).not.toBeNull();
    expect(await count(deps, "audit", "event <> 'signin'")).toBe(0);

    // Its own account can: once.
    clock.now = NOW + 1000;
    expect(await revokeSession(deps, a.userId, s.sessionId)).toBe(true);
    expect(await who(s.secret)).toBeNull();
    expect(await revokeSession(deps, a.userId, s.sessionId)).toBe(false);
    expect(await deps.db.first("SELECT revoked_at FROM session WHERE id = ?", [s.sessionId])).toEqual({ revoked_at: NOW + 1000 });
    expect(await deps.db.all("SELECT at, event, user_id, workspace_id, subject FROM audit WHERE event <> 'signin'")).toEqual([
      { at: NOW + 1000, event: "session_revoked", user_id: a.userId, workspace_id: a.workspaceId, subject: s.sessionId },
    ]);
    // The account's other session and the other account's are untouched.
    expect(await who(other.secret)).toMatchObject({ sessionId: other.sessionId });
    expect(await who(theirs.secret)).toMatchObject({ sessionId: theirs.sessionId, workspaceId: b.workspaceId });

    // A sign-out is recorded as one.
    expect(await revokeSession(deps, a.userId, other.sessionId, "signout")).toBe(true);
    expect(await deps.db.all("SELECT event, subject FROM audit WHERE event = 'signout'")).toEqual([{ event: "signout", subject: other.sessionId }]);
    expect(await who(other.secret)).toBeNull();

    // A disabled account's session is nobody, and is somebody again when the account is enabled.
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [b.userId]);
    expect(await who(theirs.secret)).toBeNull();
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [b.userId]);
    expect(await who(theirs.secret)).not.toBeNull();
    // An account without a membership has no workspace, so its session is nobody.
    await deps.db.run("DELETE FROM membership WHERE user_id = ?", [b.userId]);
    expect(await who(theirs.secret)).toBeNull();
  });

  it("sign out everywhere ends every session of that account and no other account's", async () => {
    const { deps, clock, admin, a, b } = await site();
    const mine = [await signIn(deps, a.userId), await signIn(deps, a.userId), await signIn(deps, a.userId)];
    const theirs = [await signIn(deps, b.userId), await signIn(deps, b.userId)];
    const boss = await signIn(deps, admin!.userId);
    const who = (secret: string) => resolveSession(withCookie(cookieOf(secret)), deps);
    // One was already signed out: its time stays.
    await revokeSession(deps, a.userId, mine[2].sessionId);

    clock.now = NOW + 2000;
    expect(await revokeAll(deps, a.userId)).toBeUndefined();
    for (const s of mine) expect(await who(s.secret)).toBeNull();
    for (const s of theirs) expect(await who(s.secret)).toMatchObject({ userId: b.userId, workspaceId: b.workspaceId });
    expect(await who(boss.secret)).toMatchObject({ admin: true });
    expect(await deps.db.all("SELECT id, revoked_at FROM session WHERE user_id = ? ORDER BY revoked_at, id", [a.userId])).toEqual(
      [
        { id: mine[2].sessionId, revoked_at: NOW },
        ...[mine[0].sessionId, mine[1].sessionId].sort().map((id) => ({ id, revoked_at: NOW + 2000 })),
      ],
    );
    expect(await count(deps, "session", "revoked_at IS NULL")).toBe(3);
    expect(await deps.db.all("SELECT at, event, user_id, workspace_id, subject FROM audit WHERE event = 'signout_everywhere'")).toEqual([
      { at: NOW + 2000, event: "signout_everywhere", user_id: a.userId, workspace_id: a.workspaceId, subject: null },
    ]);
    // A new sign-in afterwards works.
    expect(await who((await signIn(deps, a.userId)).secret)).not.toBeNull();
  });

  it("signing in again replaces the session the browser had", async () => {
    const { deps, clock, a, b } = await site();
    const who = (secret: string) => resolveSession(withCookie(cookieOf(secret)), deps);
    const first = await signIn(deps, a.userId);
    const elsewhere = await signIn(deps, a.userId);
    clock.now = NOW + 3000;
    const second = await signIn(deps, a.userId, first.secret);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await who(first.secret)).toBeNull();
    expect(await deps.db.first("SELECT revoked_at FROM session WHERE id = ?", [first.sessionId])).toEqual({ revoked_at: NOW + 3000 });
    expect(await who(second.secret)).toMatchObject({ sessionId: second.sessionId });
    // The account's session in another browser is not that browser's.
    expect(await who(elsewhere.secret)).not.toBeNull();

    // A sign-in that is refused replaces nothing.
    expect(await redeemSignInCode(deps, "dpl_" + "0".repeat(40), UA, second.secret)).toBeNull();
    const spent = await createSignInCode(deps, a.userId);
    await redeemSignInCode(deps, spent, UA, null);
    expect(await redeemSignInCode(deps, spent, UA, second.secret)).toBeNull();
    expect(await who(second.secret)).not.toBeNull();

    // Something that is no session secret, or a secret nobody has, is ignored.
    for (const junk of ["", "x", "dps_" + "0".repeat(64), second.sessionId, "' OR 1=1 --"]) {
      const made = await signIn(deps, a.userId, junk);
      expect(await who(made.secret)).not.toBeNull();
    }
    expect(await who(second.secret)).not.toBeNull();

    // The browser held another account's session: signing in ends that one too, since the
    // browser showed its secret, and nothing else of that account.
    const theirs = await signIn(deps, b.userId);
    const theirOther = await signIn(deps, b.userId);
    const third = await signIn(deps, a.userId, theirs.secret);
    expect(await who(theirs.secret)).toBeNull();
    expect(await who(theirOther.secret)).toMatchObject({ userId: b.userId });
    expect(await who(third.secret)).toMatchObject({ userId: a.userId, workspaceId: a.workspaceId });
  });

  it("the cookie is host-only, HttpOnly, Secure and SameSite, and the cleared one expires at once", () => {
    const secret = "dps_" + "ab".repeat(32);
    expect(SESSION_COOKIE).toBe("__Host-dp_session");
    expect(SESSION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(SESSION_TOUCH_MS).toBe(60 * 60 * 1000);
    expect(SIGNIN_CODE_MS).toBe(15 * 60 * 1000);
    expect(sessionCookie(secret)).toBe(`__Host-dp_session=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`);
    expect(clearedCookie()).toBe("__Host-dp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    for (const cookie of [sessionCookie(secret), clearedCookie()]) {
      const attributes = cookie.split("; ").slice(1);
      // Host-only: a cookie with the __Host- prefix must have no Domain, the path / and Secure.
      expect(attributes.some((a) => a.toLowerCase().startsWith("domain"))).toBe(false);
      for (const needed of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) expect(attributes, needed).toContain(needed);
    }
    // What is not a secret never becomes a cookie.
    for (const bad of ["", "x", secret + "; Domain=example.com", secret.toUpperCase(), secret + "\r\nset-cookie: a=b"]) {
      expect(() => sessionCookie(bad)).toThrow("not a session secret");
    }
  });

  it("two session cookies, or a malformed one, are no session", async () => {
    const { deps, calls, a } = await site();
    const s = await signIn(deps, a.userId);
    const other = await signIn(deps, a.userId);
    const good = cookieOf(s.secret);
    const read = (cookie: string | null) => readSessionCookie(withCookie(cookie));
    const shown = (cookie: string | null) => String(cookie).replaceAll(s.secret, "<secret>").replaceAll(other.secret, "<other>");

    // Exactly one well-formed value, wherever it stands among other cookies. Pairs are
    // separated by ";" and only spaces and tabs around a pair are dropped.
    for (const cookie of [good, `theme=dark; ${good}`, `${good}; theme=dark`, `a=1;${good};b=2`, `  ${good}  `, `a=1;\t${good}\t;b=2`, `dp_session=x; ${good}`, `__Host-dp_sessionx=1; ${good}`, `x=a,b; ${good}`]) {
      expect(read(cookie), shown(cookie)).toBe(s.secret);
      expect(sessionCookiePresent(withCookie(cookie)), shown(cookie)).toBe(true);
    }
    expect(await resolveSession(withCookie(`theme=dark; ${good}`), deps)).toMatchObject({ sessionId: s.sessionId });

    // No cookie of that name. A comma is part of another cookie's value, so a cookie that
    // another host set as `x=a,__Host-dp_session=...` is that host's cookie `x` and nothing
    // else; and a name with any other character before or after it is another name.
    const idle = calls();
    const absent = [
      null,
      "",
      "theme=dark",
      "dp_session=" + s.secret,
      "__host-dp_session=" + s.secret,
      "__HOST-DP_SESSION=" + s.secret,
      "x__Host-dp_session=" + s.secret,
      "__Host-dp_session",
      "theme=__Host-dp_session",
      `x=a,${good}`,
      `x=a, ${good}`,
      `x=a,${good}; theme=dark`,
      `theme=dark; x=a,${good}`,
      `x=a,${good},y=b`,
      `x="a;b",${good}`.replace(";", ","),
      ` ${good}`,
      `a=1; ${good}`,
      `\u000b${good}`,
      `a=1; \u000b${good}`,
      `\u000c${good}`,
      `a=1;\u000c${good}`,
      `${SESSION_COOKIE} =${s.secret}`,
      `%5F%5FHost-dp_session=${s.secret}`,
      `__Host%2Ddp_session=${s.secret}`,
    ];
    for (const cookie of absent) {
      expect(read(cookie), shown(cookie)).toBeNull();
      expect(sessionCookiePresent(withCookie(cookie)), shown(cookie)).toBe(false);
      expect(await resolveSession(withCookie(cookie), deps), shown(cookie)).toBeNull();
    }

    // Two of them, in any form, and every malformed one: present, and no session.
    const none = [
      `${good}; ${good}`,
      `${good}; ${cookieOf(other.secret)}`,
      `${cookieOf(other.secret)}; a=1; ${good}`,
      `${good}; ${SESSION_COOKIE}=`,
      `${good}, ${cookieOf(other.secret)}`,
      `${good},x=a`,
      `${good}, x=a`,
      `${SESSION_COOKIE}=`,
      `${SESSION_COOKIE}=x`,
      `${SESSION_COOKIE}="${s.secret}"`,
      `${SESSION_COOKIE}=${s.secret.toUpperCase()}`,
      `${SESSION_COOKIE}=${s.secret}0`,
      `${SESSION_COOKIE}=${s.secret.slice(0, -1)}`,
      `${SESSION_COOKIE}=${s.secret.slice(4)}`,
      `${SESSION_COOKIE}=dpl_${s.secret.slice(4)}`,
      `${SESSION_COOKIE}=${s.secret} x`,
      `${SESSION_COOKIE}=${s.secret}=`,
      `${SESSION_COOKIE}=${s.secret.replace("_", "%5F")}`,
      `${SESSION_COOKIE}= ${s.secret}`,
      `${SESSION_COOKIE}=${s.secret}\u000b`,
      `${SESSION_COOKIE} =${s.secret}; ${SESSION_COOKIE}=${s.secret}`,
    ];
    for (const cookie of none) {
      expect(read(cookie), shown(cookie)).toBeNull();
      expect(sessionCookiePresent(withCookie(cookie)), shown(cookie)).toBe(true);
      expect(await resolveSession(withCookie(cookie), deps), shown(cookie)).toBeNull();
    }
    expect(calls()).toBe(idle);
  });

  it("the anti-forgery value differs per session and does not contain the secret", async () => {
    const { deps, a } = await site();
    const one = await signIn(deps, a.userId);
    const two = await signIn(deps, a.userId);
    const csrf = await csrfFor(one.secret);
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(csrf).toBe(await sha("csrf\n" + one.secret));
    expect(await csrfFor(one.secret)).toBe(csrf);
    expect(await csrfFor(two.secret)).not.toBe(csrf);
    expect(csrf).not.toContain(one.secret.slice(4, 20));
    // It is not what the database holds for the session either.
    expect(csrf).not.toBe(await sha(one.secret));
    expect(await count(deps, "session", `hash = '${csrf}'`)).toBe(0);
  });

  it("a change needs an Origin of this host and is refused when the browser says same-site or cross-site", () => {
    const change = (url: string, headers: Record<string, string>) => sameOriginChange(new Request(url, { method: "POST", headers }));
    const url = APP + "/api/v1/signout";
    expect(change(url, { origin: APP })).toBe(true);
    expect(change(url, { origin: APP, "sec-fetch-site": "same-origin" })).toBe(true);
    // A proxy may end TLS, so the request's own scheme is not compared: the host is, with its port.
    expect(change("http://app.example.com/api/v1/signout", { origin: APP })).toBe(true);
    expect(change("https://APP.example.com/api/v1/signout", { origin: "https://app.EXAMPLE.com" })).toBe(true);
    expect(change("https://app.example.com:8443/api/v1/signout", { origin: "https://app.example.com:8443" })).toBe(true);

    // The page itself must have been loaded over https: a page of this host loaded without
    // it can be anybody's, whatever the browser says about the site.
    for (const target of [url, "http://app.example.com/api/v1/signout"]) {
      expect(change(target, { origin: "http://app.example.com" }), target).toBe(false);
      expect(change(target, { origin: "http://app.example.com", "sec-fetch-site": "same-origin" }), target).toBe(false);
    }
    expect(change("https://app.example.com:8080/x", { origin: "http://app.example.com:8080" })).toBe(false);
    expect(change("http://192.168.1.10:8787/x", { origin: "http://192.168.1.10:8787" })).toBe(false);
    expect(change("http://localhost.example.com/x", { origin: "http://localhost.example.com" })).toBe(false);
    expect(change("http://notlocalhost/x", { origin: "http://notlocalhost" })).toBe(false);
    // Except on a development host, which has no https.
    for (const local of ["http://localhost:8787", "http://localhost", "http://app.localhost:8787", "http://127.0.0.1:8787"]) {
      expect(change(local + "/api/v1/signout", { origin: local }), local).toBe(true);
      expect(change(local + "/api/v1/signout", { origin: local, "sec-fetch-site": "same-origin" }), local).toBe(true);
      expect(change(local + "/api/v1/signout", { origin: local, "sec-fetch-site": "same-site" }), local).toBe(false);
    }

    for (const site of ["same-site", "cross-site", "none", "", "SAME-ORIGIN ", "same-origin, same-origin"]) {
      expect(change(url, { origin: APP, "sec-fetch-site": site }), site).toBe(false);
    }
    const others = [
      "https://tours.example.com",
      "https://example.com",
      "https://app.example.com.evil.example",
      "https://evil.example",
      "https://app.example.com:8443",
      "http://localhost:8787",
      "null",
      "",
      "app.example.com",
      "//app.example.com",
      "ftp://app.example.com",
      "file://app.example.com",
      "https://app.example.com@evil.example",
      "https://evil.example/https://app.example.com",
      "https://app.example.com, https://evil.example",
    ];
    for (const origin of others) expect(change(url, { origin }), origin).toBe(false);
    // No Origin at all, also when the browser says same-origin.
    expect(change(url, {})).toBe(false);
    expect(change(url, { "sec-fetch-site": "same-origin" })).toBe(false);
    // The port is part of the host.
    expect(change("http://localhost:8787/api/v1/signout", { origin: "http://localhost:3000" })).toBe(false);
    // A Referer or a forwarded host is never read.
    expect(change(url, { referer: APP + "/account", "x-forwarded-host": "app.example.com", host: "app.example.com" })).toBe(false);
  });

  it("the label names a browser and a system and nothing else", () => {
    const cases: [string, string][] = [
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Chrome on Windows"],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", "Firefox on Linux"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Safari on macOS"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Edge on Windows"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0", "Opera on Windows"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iOS"],
      ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1", "Chrome on iOS"],
      ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
      ["Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0", "Firefox on Android"],
      ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
      ["Firefox/1.0 <script>alert(1)</script>\u0000 owner@example.com 203.0.113.9", "Firefox"],
    ];
    for (const [agent, label] of cases) expect(sessionLabel(agent), agent).toBe(label);
    for (const agent of [null, "", "curl/8.10.1", "Mythicshot/0.2.8", "Mozilla/5.0", "<b>", "x".repeat(100_000)]) {
      expect(sessionLabel(agent), String(agent).slice(0, 20)).toBe("Unknown browser");
    }
    // Only fixed words ever come out: no version, no address, nothing the browser chose.
    const hostile = "Chrome/1 Windows " + "A".repeat(5000) + " dps_" + "0".repeat(64);
    for (const agent of [...cases.map((c) => c[0]), hostile, "Firefox/9 (Windows; Linux; Android; iPhone; CrOS; Macintosh)"]) {
      const label = sessionLabel(agent);
      expect(label.length).toBeLessThanOrEqual(40);
      expect(label).toMatch(/^(?:Chrome|Firefox|Safari|Edge|Opera)(?: on (?:Windows|macOS|Linux|Android|iOS|ChromeOS))?$/);
    }
  });

  it("only the fixed words of a label are ever stored, whatever the browser sent", async () => {
    const { deps, a } = await site();
    const agents: [string | null, string][] = [
      [UA, "Firefox on Linux"],
      [null, "Unknown browser"],
      ["", "Unknown browser"],
      // A ready-made label is not a User-Agent: nothing is taken over as it stands.
      ["Firefox on Linux", "Unknown browser"],
      ["Totally Legit Admin Console", "Unknown browser"],
      ["<script>alert(1)</script>", "Unknown browser"],
      ["owner@example.com", "Unknown browser"],
      ["x".repeat(5000), "Unknown browser"],
      ["Firefox/1.0 <script>alert(1)</script> owner@example.com 203.0.113.9 dps_" + "0".repeat(64), "Firefox"],
      ["Chrome/1 (Windows) \u0000\r\nSet-Cookie: a=b; " + "é".repeat(300), "Chrome on Windows"],
    ];
    for (const [agent, label] of agents) {
      const made = await redeemSignInCode(deps, await createSignInCode(deps, a.userId), agent, null);
      expect(await deps.db.first("SELECT label FROM session WHERE id = ?", [made!.sessionId]), String(agent).slice(0, 30)).toEqual({ label });
    }
    // Something that is not text at all, from a caller that does not check its types.
    const made = await redeemSignInCode(deps, await createSignInCode(deps, a.userId), { toString: () => "Firefox/1" } as unknown as string, null);
    expect(await deps.db.first("SELECT label FROM session WHERE id = ?", [made!.sessionId])).toEqual({ label: "Unknown browser" });
    for (const row of await deps.db.all<{ label: string }>("SELECT label FROM session")) {
      expect(row.label).toMatch(/^(?:Unknown browser|(?:Chrome|Firefox|Safari|Edge|Opera)(?: on (?:Windows|macOS|Linux|Android|iOS|ChromeOS))?)$/);
    }
  });

  it("of two revokes of one session at once, one ended it and one audit row says so", async () => {
    const { deps, a } = await site();
    for (let round = 0; round < 5; round++) {
      const s = await signIn(deps, a.userId);
      const done = await Promise.all([revokeSession(deps, a.userId, s.sessionId), revokeSession(deps, a.userId, s.sessionId, "signout"), revokeSession(deps, a.userId, s.sessionId)]);
      expect(done.filter((d) => d), `round ${round}`).toHaveLength(1);
      expect(await deps.db.first("SELECT count(*) AS n FROM audit WHERE subject = ? AND event <> 'signin'", [s.sessionId])).toEqual({ n: 1 });
      const row = await deps.db.first<{ revoked_at: number | null; label: string }>("SELECT revoked_at, label FROM session WHERE id = ?", [s.sessionId]);
      expect(row).toEqual({ revoked_at: NOW, label: "Firefox on Linux" });
    }
  });

  it("a session revoked between the read and the hourly write is not written", async () => {
    const { deps, clock, a } = await site();
    const s = await signIn(deps, a.userId);
    clock.now = NOW + SESSION_TOUCH_MS;
    // The session is revoked by another request just after this one read it.
    const db = deps.db;
    deps.db = {
      ...db,
      all: async (sql, params) => {
        const rows = await db.all(sql, params);
        await db.run("UPDATE session SET revoked_at = ? WHERE id = ?", [NOW + 5, s.sessionId]);
        return rows as never;
      },
    };
    expect(await resolveSession(withCookie(cookieOf(s.secret)), deps)).not.toBeNull();
    deps.db = db;
    expect(await deps.db.first("SELECT last_used_at, expires_at, revoked_at FROM session WHERE id = ?", [s.sessionId])).toEqual({ last_used_at: NOW, expires_at: NOW + SESSION_MS, revoked_at: NOW + 5 });
    expect(await resolveSession(withCookie(cookieOf(s.secret)), deps)).toBeNull();
  });

  it("sweeping removes only expired and long-revoked rows, a page at a time", async () => {
    const { deps, calls, clock, a, b } = await site();
    const live = await signIn(deps, a.userId);
    const theirs = await signIn(deps, b.userId);
    const justRevoked = await signIn(deps, a.userId);
    await revokeSession(deps, a.userId, justRevoked.sessionId);
    const freshCode = await createSignInCode(deps, a.userId);

    const hash = (kind: string, i: number) => kind + i.toString(16).padStart(63, "0");
    // Row ids of the form every id has: a prefix and 24 hex characters.
    const rowId = (prefix: string, kind: string, i: number) => `${prefix}_${kind}${i.toString(16).padStart(23, "0")}`;
    const session = (id: string, h: string, expiresAt: number, revokedAt: number | null) => ({
      sql: "INSERT INTO session (id, user_id, hash, label, created_at, last_used_at, expires_at, revoked_at) VALUES (?, ?, ?, 'Unknown browser', ?, ?, ?, ?)",
      params: [id, a.userId, h, NOW - SESSION_MS, NOW - SESSION_MS, expiresAt, revokedAt],
    });
    const code = (id: string, h: string, expiresAt: number, usedAt: number | null) => ({
      sql: "INSERT INTO signin_code (id, user_id, hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)",
      params: [id, a.userId, h, expiresAt - SIGNIN_CODE_MS, expiresAt, usedAt],
    });
    const KEPT_REVOKED = rowId("ses", "b", 2);
    const ALMOST = rowId("ses", "b", 3);
    const RECENT_CODE = rowId("sic", "d", 1);
    // The codes this test seeds as long past: nothing else was made before now.
    const OLD_CODES = `created_at < ${NOW} AND id <> '${RECENT_CODE}'`;
    const expired = SWEEP_PAGE + 50;
    const rows = [];
    for (let i = 0; i < expired; i++) rows.push(session(rowId("ses", "e", i), hash("a", i), i % 2 === 0 ? NOW : NOW - 1 - i, null));
    // Revoked long ago and not yet expired; revoked a little less long ago; expiring in a millisecond.
    rows.push(session(rowId("ses", "b", 1), hash("b", 1), NOW + SESSION_MS, NOW - REVOKED_KEPT_MS));
    rows.push(session(KEPT_REVOKED, hash("b", 2), NOW + SESSION_MS, NOW - REVOKED_KEPT_MS + 1));
    rows.push(session(ALMOST, hash("b", 3), NOW + 1, null));
    // Codes: long past, used or not, go; one past by less than the keeping time stays.
    for (let i = 0; i < SWEEP_PAGE + 5; i++) rows.push(code(rowId("sic", "c", i), hash("c", i), NOW - CODE_KEPT_MS - i, i % 2 === 0 ? NOW - CODE_KEPT_MS - SIGNIN_CODE_MS : null));
    rows.push(code(RECENT_CODE, hash("d", 1), NOW - CODE_KEPT_MS + 1, null));
    for (let i = 0; i < rows.length; i += 50) await deps.db.batch(rows.slice(i, i + 50));

    const keptSessions = [live.sessionId, theirs.sessionId, justRevoked.sessionId, KEPT_REVOKED, ALMOST].sort();
    const total = expired + 1 + keptSessions.length;
    expect(await count(deps, "session")).toBe(total);

    // One bounded call each time.
    let before = calls();
    expect(await sweepSessions(deps)).toBeUndefined();
    expect(calls() - before).toBe(1);
    expect(await count(deps, "session")).toBe(total - SWEEP_PAGE);
    expect(await count(deps, "signin_code", OLD_CODES)).toBe(5);

    before = calls();
    await sweepSessions(deps);
    expect(calls() - before).toBe(1);
    expect((await deps.db.all<{ id: string }>("SELECT id FROM session ORDER BY id")).map((r) => r.id)).toEqual(keptSessions);
    expect(await count(deps, "signin_code", OLD_CODES)).toBe(0);

    // Nothing left to remove: a third sweep changes nothing.
    await sweepSessions(deps);
    expect((await deps.db.all<{ id: string }>("SELECT id FROM session ORDER BY id")).map((r) => r.id)).toEqual(keptSessions);
    expect(await count(deps, "signin_code", `id = '${RECENT_CODE}'`)).toBe(1);
    expect(await count(deps, "signin_code", `hash = '${await sha(freshCode)}'`)).toBe(1);
    // The live sessions still resolve, and the fresh code still works.
    expect(await resolveSession(withCookie(cookieOf(live.secret)), deps)).toMatchObject({ sessionId: live.sessionId });
    expect(await resolveSession(withCookie(cookieOf(theirs.secret)), deps)).toMatchObject({ workspaceId: b.workspaceId });
    expect(await redeemSignInCode(deps, freshCode, UA, null)).not.toBeNull();
    // No audit row is ever swept.
    clock.now = NOW + SESSION_MS * 3;
    await sweepSessions(deps);
    expect(await count(deps, "audit")).toBeGreaterThan(0);
  });
});
