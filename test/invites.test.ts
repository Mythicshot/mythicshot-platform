// Invites (src/invites.ts): the admin's four routes, the invite mail, and the person's two
// requests that look an invite up and accept it. Runs on both targets. No mail is sent:
// every mailer here is the fake one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount, type MakeOptions } from "#harness";
import { AUDIT_EVENTS } from "../src/audit.ts";
import { createApp } from "../src/app.ts";
import { setClientAddress } from "../src/client.ts";
import { INVITE_KEPT_MS, INVITE_MAIL_FAILED, INVITE_MS, MAX_INVITES } from "../src/invites.ts";
import { inviteLink, inviteMail, mailDate } from "../src/mail.ts";
import type { Config, Db, Deps } from "../src/ports.ts";
import { LIMITS_INVITE } from "../src/rate.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode, sessionCookie } from "../src/sessions.ts";
import { send, type Call, type SendOptions } from "./bundle.ts";

const NOW = 1_800_000_000_000; // 15 Jan 2027, 08:00 UTC
const DAY = 86_400_000;
const APP = "https://app.example.com";
const TOURS = "https://tours.example.com";
const TWO: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com" }, storageAllowanceBytes: 5_000_000 };
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const MARA = "mara@example.com";
const PUBLIC_NET = "203.0.113.7";

const NOT_FOUND = '{"error":"not_found"}';
const INVALID = '{"error":"invite_invalid","detail":"This invite no longer works. Ask the person who invited you to send it again."}';
const MAIL_OFF = '{"error":"mail_off","detail":"This site cannot send mail, so nobody can be invited here."}';
const HAS_ACCOUNT = '{"error":"has_account","detail":"That address already has an account."}';
const ACCEPT_HAS_ACCOUNT = '{"error":"has_account","detail":"This address already has an account. Sign in instead."}';
const TAKEN = '{"error":"username_taken","detail":"That username is taken. Try another."}';
const BAD_USERNAME = '{"error":"bad_username","detail":"Use 3 to 30 lowercase letters, digits and hyphens, starting with a letter."}';
const RESERVED = '{"error":"reserved_username","detail":"That username cannot be chosen. Try another."}';
const SIGNED_IN = '{"error":"signed_in","detail":"You are signed in. Sign out first, then open the invite link again."}';
const CREDENTIALS = '{"error":"credentials_not_allowed","detail":"send no token with this request"}';
const MAIL_FAILED = '{"error":"mail_failed","detail":"The invite is saved, but its mail could not be sent. Resend it to try again."}';
const BAD_EMAIL = '{"error":"bad_email"}';
const API_HEADERS = [
  ["cache-control", "no-store"],
  ["content-type", "application/json"],
  ["x-content-type-options", "nosniff"],
];
const CODE = /dpi_[0-9a-f]{40}/g;

afterEach(() => {
  vi.restoreAllMocks();
});

type Signed = { secret: string; sessionId: string; userId: string; cookie: string; csrf: string };

/** A session made as the server makes one. */
async function signIn(deps: Deps, userId: string): Promise<Signed> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), FIREFOX, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { ...made, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** A site with a clock the test moves, a signed-in admin called "morgan" and a member. */
async function site(config: Partial<Config> = TWO, opts: MakeOptions & { adminName?: string | null } = {}) {
  const made = await makeDeps(config, opts);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  const admin = await seedAccount(made.deps, { admin: true, username: opts.adminName === null ? undefined : (opts.adminName ?? "morgan") });
  const member = await seedAccount(made.deps, { username: "tess" });
  const adminSession = await signIn(made.deps, admin.userId);
  const memberSession = await signIn(made.deps, member.userId);
  return { ...made, clock, admin, member, adminSession, memberSession };
}

/** The headers the site's own page sends a change with. */
const page = (s: Signed): Record<string, string> => ({ cookie: s.cookie, origin: APP, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin", "content-type": "application/json" });

function adminCall(deps: Deps, s: Signed | null, method: string, path: string, body?: unknown, more: SendOptions = {}): Promise<Call> {
  return send(deps, method, path, {
    ...more,
    origin: more.origin ?? APP,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(s === null ? {} : page(s)), ...more.headers },
  });
}
const invite = (deps: Deps, s: Signed | null, email: unknown, more: SendOptions = {}) => adminCall(deps, s, "POST", "/api/v1/admin/invites", { email }, more);
const list = (deps: Deps, s: Signed | null, more: SendOptions = {}) => adminCall(deps, s, "GET", "/api/v1/admin/invites", undefined, more);
const resend = (deps: Deps, s: Signed | null, id: string, more: SendOptions = {}) => adminCall(deps, s, "POST", `/api/v1/admin/invites/${id}/resend`, undefined, more);
const cancel = (deps: Deps, s: Signed | null, id: string, more: SendOptions = {}) => adminCall(deps, s, "DELETE", `/api/v1/admin/invites/${id}`, undefined, more);

/** The app with the client address an entry would have set. */
const from = (address: string) => (deps: Deps) => ({
  fetch: (req: Request) => {
    setClientAddress(req, address);
    return createApp(deps).fetch(req);
  },
});

/** A POST of JSON from the person's page, with no credential unless `headers` adds one. */
function person(deps: Deps, path: string, body: unknown, more: SendOptions = {}): Promise<Call> {
  return send(deps, "POST", path, {
    app: from(PUBLIC_NET),
    ...more,
    origin: more.origin ?? APP,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", origin: more.origin ?? APP, "sec-fetch-site": "same-origin", "user-agent": FIREFOX, ...more.headers },
  });
}
const check = (deps: Deps, code: unknown, more: SendOptions = {}) => person(deps, "/api/v1/invite/check", { code }, more);
const accept = (deps: Deps, code: unknown, username: unknown, more: SendOptions = {}) => person(deps, "/api/v1/invite/accept", { code, username }, more);

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** The one invite code in a mail. */
function codeIn(text: string): string {
  const found = text.match(CODE) ?? [];
  expect(found, "a mail holds its code once").toHaveLength(1);
  return found[0] ?? "";
}

/** Invites `email` as `s` and returns the entry and the code its mail holds. */
async function invited(deps: Deps, mail: { sent: { to: string; text: string }[] }, s: Signed, email: string): Promise<{ id: string; code: string }> {
  const before = mail.sent.length;
  const r = await invite(deps, s, email);
  expect(r.status, r.text).toBe(201);
  expect(mail.sent.length).toBe(before + 1);
  return { id: r.json.id, code: codeIn(mail.sent[mail.sent.length - 1].text) };
}

const rows = (deps: Deps) => deps.db.all<Record<string, unknown>>("SELECT * FROM invite ORDER BY created_at, id");
const countOf = async (deps: Deps, table: string) => (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
const audits = (deps: Deps, like: string) => deps.db.all<Record<string, unknown>>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event LIKE ? ORDER BY at, rowid", [like]);

/** Records the kind of every database call made through `deps.db` from now on. */
function recordKinds(deps: Deps): string[] {
  const kinds: string[] = [];
  const db = deps.db;
  const wrapped: Db = {
    all: (sql, params) => (kinds.push("all"), db.all(sql, params)),
    first: (sql, params) => (kinds.push("first"), db.first(sql, params)),
    run: (sql, params) => (kinds.push("run"), db.run(sql, params)),
    batch: (stmts) => (kinds.push(`batch ${stmts.length}`), db.batch(stmts)),
  };
  deps.db = wrapped;
  return kinds;
}

describe("the invite mail", () => {
  it("is the mockup's text, with the inviter's username, the link once and the date in UTC", () => {
    const link = inviteLink(APP, "dpi_" + "a".repeat(40));
    expect(link).toBe(`${APP}/invite#dpi_${"a".repeat(40)}`);
    expect(inviteMail(MARA, "morgan", link, Date.UTC(2026, 10, 27, 23, 59))).toEqual({
      to: MARA,
      subject: "You are invited to Mythicshot",
      text: [
        "morgan invited you to Mythicshot, a tool for sharing screenshots, clips and click-through tours.",
        "",
        "Open this link to choose a username and get started:",
        "",
        link,
        "",
        "It works once and until 27 Nov 2026. If you were not expecting this, ignore this mail: nothing happens without the link.",
        "",
      ].join("\n"),
    });
  });

  it("names nobody when the inviter has no username, or one that is not a stored username's shape", () => {
    const link = inviteLink(APP, "dpi_" + "b".repeat(40));
    for (const inviter of [null, "", "Morgan", "a b", "x".repeat(31), "evil\ninjected"]) {
      const mail = inviteMail(MARA, inviter, link, NOW);
      expect(mail.text.split("\n")[0], String(inviter)).toBe("You are invited to Mythicshot, a tool for sharing screenshots, clips and click-through tours.");
      expect(mail.subject).toBe("You are invited to Mythicshot");
    }
  });

  it("writes the date as day, month abbreviation and year, in UTC, with no leading zero", () => {
    expect(mailDate(Date.UTC(2026, 11, 7))).toBe("7 Dec 2026");
    expect(mailDate(Date.UTC(2027, 0, 1, 0, 0))).toBe("1 Jan 2027");
    // Late on the 31st in UTC is still the 31st, whatever the server's own zone.
    expect(mailDate(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("31 Dec 2026");
    expect(mailDate(NOW + INVITE_MS)).toBe("22 Jan 2027");
  });

  it("refuses an origin or a code a link cannot hold", () => {
    expect(() => inviteLink("https://app.example.com/x", "dpi_" + "0".repeat(40))).toThrow("bad origin");
    expect(() => inviteLink(APP, "a#b")).toThrow("bad code");
  });
});

describe("sending an invite", () => {
  it("answers 201 the entry, stores only the code's digest, mails the link and records it", async () => {
    const { deps, mail, admin, adminSession } = await site();
    const r = await invite(deps, adminSession, "  Mara@Example.com ");
    expect(r.status, r.text).toBe(201);
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(r.json).toEqual({ id: expect.stringMatching(/^inv_[0-9a-f]{24}$/), email: MARA, created_at: NOW, expires_at: NOW + 7 * DAY, state: "open" });
    expect(mail.sent).toHaveLength(1);
    const code = codeIn(mail.sent[0].text);
    expect(mail.sent[0]).toEqual({
      to: MARA,
      subject: "You are invited to Mythicshot",
      text: [
        "morgan invited you to Mythicshot, a tool for sharing screenshots, clips and click-through tours.",
        "",
        "Open this link to choose a username and get started:",
        "",
        `${APP}/invite#${code}`,
        "",
        "It works once and until 22 Jan 2027. If you were not expecting this, ignore this mail: nothing happens without the link.",
        "",
      ].join("\n"),
    });
    const stored = await rows(deps);
    expect(stored).toEqual([{ id: r.json.id, email: MARA, code_hash: expect.stringMatching(/^[0-9a-f]{64}$/), invited_by: admin.userId, created_at: NOW, expires_at: NOW + INVITE_MS }]);
    expect(JSON.stringify(stored)).not.toContain(code.slice(4));
    expect(await audits(deps, "invite%")).toEqual([{ event: "invite_sent", user_id: admin.userId, workspace_id: admin.workspaceId, subject: r.json.id, detail: '{"replaced":0}' }]);
  });

  it("mails a sentence without a name when the admin has no username", async () => {
    const { deps, mail, adminSession } = await site(TWO, { adminName: null });
    expect((await invite(deps, adminSession, MARA)).status).toBe(201);
    expect(mail.sent[0].text.split("\n")[0]).toBe("You are invited to Mythicshot, a tool for sharing screenshots, clips and click-through tours.");
  });

  it("a new invite to the same address replaces the open one: the same entry, a new code, and the older link stops working at once", async () => {
    const { deps, mail, admin, adminSession } = await site();
    const first = await invited(deps, mail, adminSession, MARA);
    expect((await check(deps, first.code)).status).toBe(200);
    clock(deps, NOW + 1000);
    const second = await invite(deps, adminSession, MARA);
    expect(second.status).toBe(201);
    expect(second.json).toEqual({ id: first.id, email: MARA, created_at: NOW + 1000, expires_at: NOW + 1000 + INVITE_MS, state: "open" });
    const code = codeIn(mail.sent[1].text);
    expect(code).not.toBe(first.code);
    expect(seen(await check(deps, first.code)).body).toBe(INVALID);
    expect((await check(deps, code)).status).toBe(200);
    expect(await countOf(deps, "invite")).toBe(1);
    expect((await audits(deps, "invite%")).map((a) => [a.event, a.subject, a.detail])).toEqual([
      ["invite_sent", first.id, '{"replaced":0}'],
      ["invite_sent", first.id, '{"replaced":1}'],
    ]);
    expect((await audits(deps, "invite%")).every((a) => a.user_id === admin.userId)).toBe(true);
  });

  it("refuses an address that already has an account, whatever its case, and stores nothing", async () => {
    const { deps, mail, member, adminSession } = await site();
    const r = await invite(deps, adminSession, member.email.toUpperCase());
    expect(seen(r)).toEqual({ status: 409, headers: API_HEADERS, body: HAS_ACCOUNT });
    expect(mail.sent).toEqual([]);
    expect(await countOf(deps, "invite")).toBe(0);
  });

  it("refuses what is not an address, and a body with anything else in it", async () => {
    const { deps, mail, adminSession } = await site();
    for (const email of ["mara@example", "", null, 5, "a b@example.com", "mara@example.com\n"]) {
      expect(seen(await invite(deps, adminSession, email)), String(email)).toEqual({ status: 400, headers: API_HEADERS, body: BAD_EMAIL });
    }
    const extra = await adminCall(deps, adminSession, "POST", "/api/v1/admin/invites", { email: MARA, admin: true });
    expect([extra.status, extra.json.error]).toEqual([400, "bad_request"]);
    const notJson = await send(deps, "POST", "/api/v1/admin/invites", { origin: APP, body: "{", headers: page(adminSession) });
    expect([notJson.status, notJson.json.error]).toEqual([400, "bad_request"]);
    expect(mail.sent).toEqual([]);
    expect(await countOf(deps, "invite")).toBe(0);
  });

  it("with mail off, sending and resending are refused before anything is counted or stored; the list and cancel still work", async () => {
    for (const [what, config, opts] of [
      ["no mailer", TWO, { mail: false }],
      ["no address for links", { storageAllowanceBytes: 1 }, {}],
    ] as const) {
      const { deps, adminSession } = await site(config as Partial<Config>, opts as MakeOptions);
      const origin = config === TWO ? APP : "https://anything.example.org";
      const s = { ...adminSession };
      const headers = { origin, cookie: s.cookie, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin", "content-type": "application/json" };
      const before = await countOf(deps, "rate_counter");
      const r = await send(deps, "POST", "/api/v1/admin/invites", { origin, body: JSON.stringify({ email: MARA }), headers });
      expect(seen(r), what).toEqual({ status: 409, headers: API_HEADERS, body: MAIL_OFF });
      // An invite written by hand (as one sent while mail was on would be).
      await deps.db.run("INSERT INTO invite (id, email, code_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, NULL, ?, ?)", ["inv_" + "1".repeat(24), MARA, "a".repeat(64), NOW, NOW + INVITE_MS]);
      const again = await send(deps, "POST", `/api/v1/admin/invites/inv_${"1".repeat(24)}/resend`, { origin, headers });
      expect(seen(again), what).toEqual({ status: 409, headers: API_HEADERS, body: MAIL_OFF });
      expect(await countOf(deps, "rate_counter"), what).toBe(before);
      const listed = await send(deps, "GET", "/api/v1/admin/invites", { origin, headers: { cookie: s.cookie } });
      expect(listed.json, what).toEqual({ invites: [{ id: "inv_" + "1".repeat(24), email: MARA, created_at: NOW, expires_at: NOW + INVITE_MS, state: "open" }] });
      expect((await send(deps, "DELETE", `/api/v1/admin/invites/inv_${"1".repeat(24)}`, { origin, headers })).status, what).toBe(204);
      expect(await countOf(deps, "invite"), what).toBe(0);
    }
  });

  it("a mail that fails leaves the invite in place and says so; resend then sends a new link", async () => {
    const { deps, mail, adminSession } = await site();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
    mail.failNext();
    const r = await invite(deps, adminSession, MARA);
    expect(seen(r)).toEqual({ status: 502, headers: API_HEADERS, body: MAIL_FAILED });
    expect(lines).toEqual([`${INVITE_MAIL_FAILED} (failed)`]);
    expect(mail.sent).toEqual([]);
    const listed = await list(deps, adminSession);
    expect(listed.json.invites).toHaveLength(1);
    const again = await resend(deps, adminSession, listed.json.invites[0].id);
    expect(again.status, again.text).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect((await check(deps, codeIn(mail.sent[0].text))).status).toBe(200);
  });

  it("an admin sends at most 20 invites an hour, resends included; the 21st stores and sends nothing", async () => {
    const { deps, mail, adminSession } = await site();
    const first = await invited(deps, mail, adminSession, "p0@example.com");
    for (let i = 1; i < 15; i++) expect((await invite(deps, adminSession, `p${i}@example.com`)).status).toBe(201);
    for (let i = 0; i < 5; i++) expect((await resend(deps, adminSession, first.id)).status).toBe(200);
    expect(mail.sent).toHaveLength(LIMITS_INVITE.sendAdmin.most);
    const over = await invite(deps, adminSession, "late@example.com");
    expect([over.status, over.json.error, over.headers.get("retry-after")]).toEqual([429, "rate_limited", String(Math.ceil((3_600_000 - (NOW % 3_600_000)) / 1000))]);
    const overResend = await resend(deps, adminSession, first.id);
    expect(overResend.status).toBe(429);
    expect(mail.sent).toHaveLength(20);
    expect(await countOf(deps, "invite")).toBe(15);
    // The next hour counts afresh.
    clock(deps, NOW + 3_600_000);
    expect((await invite(deps, adminSession, "late@example.com")).status).toBe(201);
  });

  it("the site's invite mails have their own cap of 30 an hour, apart from sign-in's, over all admins", async () => {
    const { deps, mail, adminSession } = await site();
    const second = await seedAccount(deps, { admin: true, username: "second" });
    const secondSession = await signIn(deps, second.userId);
    for (let i = 0; i < 20; i++) expect((await invite(deps, adminSession, `a${i}@example.com`)).status).toBe(201);
    for (let i = 0; i < 10; i++) expect((await invite(deps, secondSession, `b${i}@example.com`)).status).toBe(201);
    const over = await invite(deps, secondSession, "c@example.com");
    expect([over.status, over.json.error]).toEqual([429, "rate_limited"]);
    expect(mail.sent).toHaveLength(LIMITS_INVITE.mailSite.most);
    expect(await countOf(deps, "invite")).toBe(30);
    expect(LIMITS_INVITE.mailSite.bucket).not.toBe("mail_site");
  });

  it("only open invites count toward the 100: rows that ran out never block a send, and the list stays at 100 with every open one", async () => {
    const { deps, mail, adminSession } = await site();
    const row = (i: number, created: number) => ({
      sql: "INSERT INTO invite (id, email, code_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, NULL, ?, ?)",
      params: [`inv_${String(i).padStart(24, "0")}`, `n${i}@example.com`, i.toString(16).padStart(64, "0"), created, created + INVITE_MS],
    });
    // 100 that ran out a day ago, still waiting for the sweep, and 99 open ones.
    await deps.db.batch(Array.from({ length: MAX_INVITES }, (_, i) => row(i, NOW - INVITE_MS - DAY - i)));
    await deps.db.batch(Array.from({ length: MAX_INVITES - 1 }, (_, i) => row(1000 + i, NOW - 1000 + i)));
    expect((await invite(deps, adminSession, MARA)).status).toBe(201);
    const over = await invite(deps, adminSession, "one-more@example.com");
    expect([over.status, over.json.error]).toEqual([409, "too_many_invites"]);
    expect(mail.sent).toHaveLength(1);
    // Replacing an open invite adds no open one, so it goes through at the cap; replacing one
    // that ran out would open it again, so it is refused like a new one.
    expect((await invite(deps, adminSession, "n1001@example.com")).status).toBe(201);
    const reopen = await invite(deps, adminSession, "n5@example.com");
    expect([reopen.status, reopen.json.error]).toEqual([409, "too_many_invites"]);
    expect(mail.sent).toHaveLength(2);
    const resendExpired = await resend(deps, adminSession, `inv_${String(5).padStart(24, "0")}`);
    expect([resendExpired.status, resendExpired.json.error]).toEqual([409, "too_many_invites"]);
    expect((await resend(deps, adminSession, `inv_${String(1001).padStart(24, "0")}`)).status).toBe(200);
    // Once one open invite ends, there is room again.
    expect((await cancel(deps, adminSession, `inv_${String(1000).padStart(24, "0")}`)).status).toBe(204);
    expect((await invite(deps, adminSession, "one-more@example.com")).status).toBe(201);
    // The list holds 100 rows, every open one first.
    const listed = (await list(deps, adminSession)).json.invites as { state: string; created_at: number }[];
    expect(listed).toHaveLength(MAX_INVITES);
    const open = await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM invite WHERE expires_at > ?", [NOW]);
    expect(listed.filter((i) => i.state === "open")).toHaveLength(open!.n);
    expect(open!.n).toBe(MAX_INVITES);
    // No open one comes after one that ran out.
    const firstExpired = listed.findIndex((i) => i.state === "expired");
    if (firstExpired >= 0) expect(listed.slice(firstExpired).every((i) => i.state === "expired")).toBe(true);
    // One fewer open invite, and the newest that ran out shows up at the end of the list.
    expect((await cancel(deps, adminSession, `inv_${String(1001).padStart(24, "0")}`)).status).toBe(204);
    const after = (await list(deps, adminSession)).json.invites as { state: string; email: string }[];
    expect(after).toHaveLength(MAX_INVITES);
    expect(after.at(-1)).toMatchObject({ state: "expired", email: "n0@example.com" });
    expect(listed.map((i) => i.created_at)).toEqual([...listed.map((i) => i.created_at)].sort((x, y) => y - x));
  });

  it("the site holds at most 100 invites; replacing one of them still works", async () => {
    const { deps, mail, adminSession } = await site();
    const stmts = Array.from({ length: MAX_INVITES }, (_, i) => ({
      sql: "INSERT INTO invite (id, email, code_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, NULL, ?, ?)",
      params: [`inv_${String(i).padStart(24, "0")}`, `n${i}@example.com`, i.toString(16).padStart(64, "0"), NOW - 1000 + i, NOW + INVITE_MS],
    }));
    await deps.db.batch(stmts);
    const r = await invite(deps, adminSession, MARA);
    expect([r.status, r.json.error]).toEqual([409, "too_many_invites"]);
    expect(mail.sent).toEqual([]);
    const replaced = await invite(deps, adminSession, "n7@example.com");
    expect(replaced.status, replaced.text).toBe(201);
    expect(replaced.json.id).toBe(`inv_${"7".padStart(24, "0")}`);
    expect(await countOf(deps, "invite")).toBe(MAX_INVITES);
    // Once one is cancelled there is room again.
    expect((await cancel(deps, adminSession, `inv_${"3".padStart(24, "0")}`)).status).toBe(204);
    expect((await invite(deps, adminSession, MARA)).status).toBe(201);
    const listed = await list(deps, adminSession);
    expect(listed.json.invites).toHaveLength(MAX_INVITES);
  });
});

/** Moves the site's clock. */
function clock(deps: Deps, at: number): void {
  deps.now = () => at;
}

describe("the admin's list, resend and cancel", () => {
  it("lists open and expired invites newest first; accepted and cancelled ones are gone", async () => {
    const { deps, mail, adminSession } = await site();
    const old = await invited(deps, mail, adminSession, "old@example.com");
    clock(deps, NOW + DAY);
    const gone = await invited(deps, mail, adminSession, "gone@example.com");
    clock(deps, NOW + 2 * DAY);
    const used = await invited(deps, mail, adminSession, "used@example.com");
    clock(deps, NOW + 3 * DAY);
    const fresh = await invited(deps, mail, adminSession, "fresh@example.com");
    expect((await cancel(deps, adminSession, gone.id)).status).toBe(204);
    expect((await accept(deps, used.code, "user-one")).status).toBe(200);
    clock(deps, NOW + 7 * DAY + 1);
    const r = await list(deps, adminSession);
    expect(seen(r).headers).toEqual(API_HEADERS);
    expect(r.json).toEqual({
      invites: [
        { id: fresh.id, email: "fresh@example.com", created_at: NOW + 3 * DAY, expires_at: NOW + 10 * DAY, state: "open" },
        { id: old.id, email: "old@example.com", created_at: NOW, expires_at: NOW + 7 * DAY, state: "expired" },
      ],
    });
  });

  it("an invite that ran out is listed for 30 days after, then swept", async () => {
    const { deps, mail, admin, adminSession } = await site();
    await invited(deps, mail, adminSession, MARA);
    clock(deps, NOW + INVITE_MS + INVITE_KEPT_MS - 1);
    // The admin's session has ended by now: a new one.
    const later = await signIn(deps, admin.userId);
    expect((await list(deps, later)).json.invites.map((i: { state: string }) => i.state)).toEqual(["expired"]);
    clock(deps, NOW + INVITE_MS + INVITE_KEPT_MS);
    expect((await list(deps, later)).json.invites).toEqual([]);
    expect(await countOf(deps, "invite")).toBe(0);
  });

  it("resend gives the invite a new code for 7 days from now and answers the refreshed entry; the old link stops working", async () => {
    const { deps, mail, admin, adminSession } = await site();
    const first = await invited(deps, mail, adminSession, MARA);
    clock(deps, NOW + 8 * DAY);
    const r = await resend(deps, adminSession, first.id);
    expect(seen(r).status).toBe(200);
    expect(r.json).toEqual({ id: first.id, email: MARA, created_at: NOW + 8 * DAY, expires_at: NOW + 15 * DAY, state: "open" });
    const code = codeIn(mail.sent[1].text);
    expect(mail.sent[1].text).toContain("until 30 Jan 2027");
    expect(seen(await check(deps, first.code)).body).toBe(INVALID);
    expect((await check(deps, code)).json).toEqual({ email: MARA, invited_by: "morgan", expires_at: NOW + 15 * DAY });
    expect((await audits(deps, "invite_resent")).map((a) => [a.user_id, a.workspace_id, a.subject])).toEqual([[admin.userId, admin.workspaceId, first.id]]);
  });

  it("resend refuses an address that got an account meanwhile, and changes nothing", async () => {
    const { deps, mail, adminSession } = await site();
    const first = await invited(deps, mail, adminSession, MARA);
    await deps.db.run("UPDATE user SET email = ? WHERE username = 'tess'", [MARA]);
    expect(seen(await resend(deps, adminSession, first.id)).body).toBe(HAS_ACCOUNT);
    expect(mail.sent).toHaveLength(1);
  });

  it("an id that names no invite, or no invite's shape, is the one 404 on resend and cancel", async () => {
    const { deps, mail, adminSession } = await site();
    const first = await invited(deps, mail, adminSession, MARA);
    for (const id of ["inv_" + "0".repeat(24), "inv_x", "ws_" + "0".repeat(24), first.id.toUpperCase()]) {
      expect(seen(await resend(deps, adminSession, id)), id).toEqual({ status: 404, headers: API_HEADERS, body: NOT_FOUND });
      expect(seen(await cancel(deps, adminSession, id)), id).toEqual({ status: 404, headers: API_HEADERS, body: NOT_FOUND });
    }
    expect(mail.sent).toHaveLength(1);
  });

  it("cancel ends the invite at once; a second cancel and a resend of it are 404", async () => {
    const { deps, mail, admin, adminSession } = await site();
    const first = await invited(deps, mail, adminSession, MARA);
    const r = await cancel(deps, adminSession, first.id);
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect(seen(await check(deps, first.code)).body).toBe(INVALID);
    expect(seen(await accept(deps, first.code, "mara")).body).toBe(INVALID);
    expect((await cancel(deps, adminSession, first.id)).status).toBe(404);
    expect((await resend(deps, adminSession, first.id)).status).toBe(404);
    expect((await audits(deps, "invite_cancelled")).map((a) => [a.user_id, a.subject])).toEqual([[admin.userId, first.id]]);
    // The same address can be invited again.
    expect((await invite(deps, adminSession, MARA)).status).toBe(201);
  });
});

describe("only an admin", () => {
  it("no route here lets a member's session, any token, no credential or a session without its anti-forgery header create, list, resend or cancel", async () => {
    const { deps, mail, admin, member, adminSession, memberSession } = await site();
    const existing = await invited(deps, mail, adminSession, "kept@example.com");
    const before = { invites: await rows(deps), audit: await countOf(deps, "audit"), counters: await deps.db.all("SELECT * FROM rate_counter ORDER BY bucket, key") };
    const callers: [string, SendOptions][] = [
      ["nobody", { headers: { origin: APP, "content-type": "application/json" } }],
      ["the member's session", { headers: page(memberSession) }],
      ["the admin's own token", { token: admin.token, headers: { origin: APP, "content-type": "application/json" } }],
      ["the member's token", { token: member.token, headers: { origin: APP, "content-type": "application/json" } }],
      ["the admin's session and a token", { token: admin.token, headers: page(adminSession) }],
      ["the admin's session without the anti-forgery header", { headers: { ...page(adminSession), "x-csrf-token": "" } }],
      ["the admin's session from another origin", { headers: { ...page(adminSession), origin: TOURS } }],
      ["the admin's session on the tours address", { origin: TOURS, headers: { ...page(adminSession), origin: TOURS } }],
    ];
    const requests: [string, string, unknown][] = [
      ["POST", "/api/v1/admin/invites", { email: MARA }],
      ["GET", "/api/v1/admin/invites", undefined],
      ["POST", `/api/v1/admin/invites/${existing.id}/resend`, undefined],
      ["DELETE", `/api/v1/admin/invites/${existing.id}`, undefined],
    ];
    for (const [method, path, body] of requests) {
      for (const [who, opts] of callers) {
        // A GET takes no anti-forgery header or origin, so those two are no refusal there.
        if (method === "GET" && (who.includes("anti-forgery") || who.includes("another origin"))) continue;
        const r = await send(deps, method, path, { ...opts, origin: opts.origin ?? APP, body: body === undefined ? undefined : JSON.stringify(body) });
        expect(seen(r), `${method} ${path} by ${who}`).toEqual({ status: 404, headers: who.includes("tours") ? [["cache-control", "no-store"], ["content-type", "application/json"]] : API_HEADERS, body: NOT_FOUND });
      }
    }
    expect(mail.sent).toHaveLength(1);
    expect({ invites: await rows(deps), audit: await countOf(deps, "audit"), counters: await deps.db.all("SELECT * FROM rate_counter ORDER BY bucket, key") }).toEqual(before);
  });
});

describe("looking an invite up", () => {
  it("answers the invited address, the inviter's username and when it stops working, and changes nothing", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    const before = await rows(deps);
    const r = await check(deps, code);
    expect(seen(r)).toEqual({ status: 200, headers: API_HEADERS, body: JSON.stringify({ email: MARA, invited_by: "morgan", expires_at: NOW + INVITE_MS }) });
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(await rows(deps)).toEqual(before);
    // Looked up again, it still works.
    expect((await check(deps, code)).status).toBe(200);
  });

  it("invited_by is null when the inviter has no username", async () => {
    const { deps, mail, adminSession } = await site(TWO, { adminName: null });
    const { code } = await invited(deps, mail, adminSession, MARA);
    expect((await check(deps, code)).json).toEqual({ email: MARA, invited_by: null, expires_at: NOW + INVITE_MS });
  });
});

describe("codes that cannot be used", () => {
  /** A site with one invite in each dead state, and the codes. */
  async function deadCodes() {
    const s = await site();
    const { deps, mail, adminSession } = s;
    const used = await invited(deps, mail, adminSession, "used@example.com");
    expect((await accept(deps, used.code, "used-one")).status).toBe(200);
    const cancelled = await invited(deps, mail, adminSession, "cancelled@example.com");
    expect((await cancel(deps, adminSession, cancelled.id)).status).toBe(204);
    const replaced = await invited(deps, mail, adminSession, "replaced@example.com");
    await invited(deps, mail, adminSession, "replaced@example.com");
    const resent = await invited(deps, mail, adminSession, "resent@example.com");
    expect((await resend(deps, adminSession, resent.id)).status).toBe(200);
    clock(deps, NOW - 8 * DAY);
    const expired = await invited(deps, mail, adminSession, "expired@example.com");
    clock(deps, NOW);
    const codes: [string, string][] = [
      ["used", used.code],
      ["cancelled", cancelled.code],
      ["replaced by a new invite", replaced.code],
      ["replaced by resend", resent.code],
      ["expired", expired.code],
      ["unknown", "dpi_" + "0".repeat(40)],
    ];
    return { ...s, codes };
  }

  it("are indistinguishable on check: status, body, headers and database calls", async () => {
    const { deps, codes } = await deadCodes();
    const kinds = recordKinds(deps);
    const answers: { what: string; seen: ReturnType<typeof seen>; calls: string[] }[] = [];
    for (const [what, code] of codes) {
      const r = await check(deps, code);
      answers.push({ what, seen: seen(r), calls: kinds.splice(0) });
    }
    for (const a of answers) {
      expect(a.seen, a.what).toEqual({ status: 404, headers: API_HEADERS, body: INVALID });
      expect(a.calls, a.what).toEqual(answers[answers.length - 1].calls);
    }
    // The network's count and the one read.
    expect(answers[0].calls).toEqual(["first", "first"]);
  });

  it("are indistinguishable on accept, and accepting one changes nothing", async () => {
    const { deps, codes } = await deadCodes();
    const before = { users: await countOf(deps, "user"), invites: await rows(deps) };
    const kinds = recordKinds(deps);
    const answers: { what: string; seen: ReturnType<typeof seen>; calls: string[] }[] = [];
    for (const [what, code] of codes) {
      const r = await accept(deps, code, "fresh-name");
      answers.push({ what, seen: seen(r), calls: kinds.splice(0) });
    }
    for (const a of answers) {
      expect(a.seen, a.what).toEqual({ status: 404, headers: API_HEADERS, body: INVALID });
      expect(a.calls, a.what).toEqual(["first", "first"]);
    }
    expect({ users: await countOf(deps, "user"), invites: await rows(deps) }).toEqual(before);
    // A malformed code gets the same answer.
    for (const code of ["dpi_" + "0".repeat(39), "dpl_" + "0".repeat(40), "", 7, null]) {
      expect(seen(await accept(deps, code, "fresh-name")), String(code)).toEqual(answers[0].seen);
      expect(seen(await check(deps, code)), String(code)).toEqual(answers[0].seen);
    }
  });
});

describe("accepting an invite", () => {
  it("makes the account, its own workspace, its membership, its sign-in method and a session, and signs the browser in as a sign-in link does", async () => {
    const { deps, mail, adminSession } = await site();
    const { id, code } = await invited(deps, mail, adminSession, MARA);
    clock(deps, NOW + 5000);
    const r = await accept(deps, code, "  Mara ");
    expect(seen(r).status, r.text).toBe(200);
    expect(r.text).toBe('{"ok":true}');
    const cookies = r.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const secret = /^__Host-dp_session=(dps_[0-9a-f]{64});/.exec(cookies[0])?.[1] ?? "";
    expect(cookies[0]).toBe(sessionCookie(secret));

    const user = await deps.db.first<Record<string, unknown>>("SELECT * FROM user WHERE email = ?", [MARA]);
    expect(user).toEqual({ id: expect.stringMatching(/^usr_[0-9a-f]{24}$/), workspace_id: expect.stringMatching(/^ws_[0-9a-f]{24}$/), email: MARA, created_at: NOW + 5000, username: "mara", status: "active", is_admin: 0 });
    const userId = user!.id as string;
    const workspaceId = user!.workspace_id as string;
    expect(await deps.db.first("SELECT id, name, storage_allowance_bytes FROM workspace WHERE id = ?", [workspaceId])).toEqual({ id: workspaceId, name: "mara", storage_allowance_bytes: null });
    expect(await deps.db.all("SELECT workspace_id, role FROM membership WHERE user_id = ?", [userId])).toEqual([{ workspace_id: workspaceId, role: "owner" }]);
    expect(await deps.db.all("SELECT kind FROM signin_method WHERE user_id = ?", [userId])).toEqual([{ kind: "email_link" }]);
    expect(await deps.db.all("SELECT label, created_at, revoked_at FROM session WHERE user_id = ?", [userId])).toEqual([{ label: "Firefox on Linux", created_at: NOW + 5000, revoked_at: null }]);
    expect(await countOf(deps, "api_token WHERE workspace_id = '" + workspaceId + "'")).toBe(0);
    expect(await rows(deps)).toEqual([]);
    const events = await deps.db.all<Record<string, unknown>>("SELECT event, user_id, workspace_id, subject FROM audit WHERE user_id = ? ORDER BY rowid", [userId]);
    expect(events.map((e) => e.event).sort()).toEqual(["invite_accepted", "signin"]);
    expect(events.find((e) => e.event === "invite_accepted")).toEqual({ event: "invite_accepted", user_id: userId, workspace_id: workspaceId, subject: id });

    // The session works: the account is the new one, no admin, in its own workspace.
    const session = await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}` } });
    expect(session.json.account).toEqual({ id: userId, username: "mara", email: MARA, admin: false });
    expect(session.json.workspace).toEqual({ id: workspaceId, name: "mara" });
    // Its workspace follows the site's standard allowance.
    const usage = await send(deps, "GET", "/api/v1/usage", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}` } });
    expect(usage.json.allowance_bytes).toBe(5_000_000);
    deps.config.storageAllowanceBytes = 7_000_000;
    expect((await send(deps, "GET", "/api/v1/usage", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}` } })).json.allowance_bytes).toBe(7_000_000);
    // The admin routes do not take it.
    expect((await send(deps, "GET", "/api/v1/admin/invites", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}` } })).text).toBe(NOT_FOUND);
    // And the same code works no more.
    expect(seen(await accept(deps, code, "mara-two")).body).toBe(INVALID);
  });

  it("refuses a username of the wrong shape or a reserved one, and the invite stays usable", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    for (const name of ["Mara_K", "ab", "a".repeat(31), "-mara", "mara-", "ma--ra", "9mara", "", null, 5, "mära"]) {
      expect(seen(await accept(deps, code, name)), String(name)).toEqual({ status: 400, headers: API_HEADERS, body: BAD_USERNAME });
    }
    for (const name of ["admin", "ad-min", "invite", "my-mythicshot"]) expect(seen(await accept(deps, code, name)), name).toEqual({ status: 400, headers: API_HEADERS, body: RESERVED });
    expect(await countOf(deps, "invite")).toBe(1);
    expect((await accept(deps, code, "mara")).status).toBe(200);
  });

  it("a dead code is the one invite_invalid whatever the username: malformed, reserved, taken or fine", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    const madeUp = "dpi_" + "0".repeat(40);
    // 25 requests in all: under the network's 30 in 15 minutes.
    const names: unknown[] = ["Mara_K", "", null, 5, "admin", "my-mythicshot", "tess", "fresh"];
    for (const name of names) {
      for (const dead of [madeUp, "dpi_short"]) expect(seen(await accept(deps, dead, name)), `${String(dead)} ${String(name)}`).toEqual({ status: 404, headers: API_HEADERS, body: INVALID });
    }
    // Used: the same answer for every name.
    expect((await accept(deps, code, "mara")).status).toBe(200);
    for (const name of names) expect(seen(await accept(deps, code, name)), String(name)).toEqual({ status: 404, headers: API_HEADERS, body: INVALID });
  });

  it("refuses a username that is taken, and the invite stays usable", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    for (const name of ["tess", "morgan", "TESS"]) expect(seen(await accept(deps, code, name)), name).toEqual({ status: 409, headers: API_HEADERS, body: TAKEN });
    expect(await countOf(deps, "user")).toBe(2);
    expect((await accept(deps, code, "mara")).status).toBe(200);
  });

  it("refuses an address that got an account between the invite and the accept, and makes nothing", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    await deps.db.run("UPDATE user SET email = ? WHERE username = 'tess'", [MARA]);
    expect(seen(await accept(deps, code, "mara"))).toEqual({ status: 409, headers: API_HEADERS, body: ACCEPT_HAS_ACCOUNT });
    expect(await countOf(deps, "user")).toBe(2);
    expect(await countOf(deps, "invite")).toBe(1);
  });

  it("of two accepts racing on one code, exactly one makes an account", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    // The second accept runs whole between the first one's read and its batch.
    let second: Call | null = null;
    const db = deps.db;
    let held = false;
    deps.db = {
      ...db,
      batch: async (stmts) => {
        if (!held && stmts[0]?.sql.startsWith("DELETE FROM invite WHERE code_hash")) {
          held = true;
          deps.db = db;
          second = await accept(deps, code, "mara-b");
        }
        return db.batch(stmts);
      },
    };
    const first = await accept(deps, code, "mara-a");
    deps.db = db;
    expect([first.status, second!.status].sort()).toEqual([200, 404]);
    expect(second!.status).toBe(200);
    expect(seen(first).body).toBe(INVALID);
    expect(await deps.db.all("SELECT username FROM user WHERE email = ?", [MARA])).toEqual([{ username: "mara-b" }]);
    expect(await countOf(deps, "workspace")).toBe(3);
    expect(await countOf(deps, "session WHERE user_id IN (SELECT id FROM user WHERE email = 'mara@example.com')")).toBe(1);
    // Sent at the same moment, too.
    const other = await invited(deps, mail, adminSession, "other@example.com");
    const both = await Promise.all([accept(deps, other.code, "other-a"), accept(deps, other.code, "other-b")]);
    expect(both.map((b) => b.status).sort()).toEqual([200, 404]);
    expect(await countOf(deps, "user WHERE email = 'other@example.com'")).toBe(1);
  });

  it("of two invites accepted at the same moment with one username, one wins; the other is told it is taken and its invite stays usable", async () => {
    const { deps, mail, adminSession } = await site();
    const a = await invited(deps, mail, adminSession, "a@example.com");
    const b = await invited(deps, mail, adminSession, "b@example.com");
    let second: Call | null = null;
    const db = deps.db;
    let held = false;
    deps.db = {
      ...db,
      batch: async (stmts) => {
        if (!held && stmts[0]?.sql.startsWith("DELETE FROM invite WHERE code_hash")) {
          held = true;
          deps.db = db;
          second = await accept(deps, b.code, "same-name");
        }
        return db.batch(stmts);
      },
    };
    const first = await accept(deps, a.code, "same-name");
    deps.db = db;
    expect(second!.status).toBe(200);
    expect(seen(first)).toEqual({ status: 409, headers: API_HEADERS, body: TAKEN });
    expect(await deps.db.all("SELECT email FROM user WHERE username = 'same-name'")).toEqual([{ email: "b@example.com" }]);
    // Nothing of the loser was kept, and its invite still works with another name.
    expect(await countOf(deps, "user WHERE email = 'a@example.com'")).toBe(0);
    expect(await countOf(deps, "workspace")).toBe(3);
    expect((await accept(deps, a.code, "other-name")).status).toBe(200);
    // And at the same moment.
    const c = await invited(deps, mail, adminSession, "c@example.com");
    const d = await invited(deps, mail, adminSession, "d@example.com");
    const both = await Promise.all([accept(deps, c.code, "twin"), accept(deps, d.code, "twin")]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await countOf(deps, "user WHERE username = 'twin'")).toBe(1);
  });

  it("an address that gets an account between the read and the batch is refused with has_account, never a 500", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    const db = deps.db;
    deps.db = {
      ...db,
      batch: async (stmts) => {
        if (stmts[0]?.sql.startsWith("DELETE FROM invite WHERE code_hash")) await db.run("UPDATE user SET email = ? WHERE username = 'tess'", [MARA]);
        return db.batch(stmts);
      },
    };
    const r = await accept(deps, code, "mara");
    deps.db = db;
    expect(seen(r)).toEqual({ status: 409, headers: API_HEADERS, body: ACCEPT_HAS_ACCOUNT });
    expect(await countOf(deps, "invite")).toBe(1);
  });
});

describe("the person's requests and credentials", () => {
  it("refuse a token, whatever it is worth, before anything is looked up", async () => {
    const { deps, mail, admin, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    for (const token of [admin.token, "dp_" + "0".repeat(40), "nonsense"]) {
      expect(seen(await check(deps, code, { token })), token).toEqual({ status: 400, headers: API_HEADERS, body: CREDENTIALS });
      expect(seen(await accept(deps, code, "mara", { token })), token).toEqual({ status: 400, headers: API_HEADERS, body: CREDENTIALS });
    }
    expect(await countOf(deps, "invite")).toBe(1);
  });

  it("refuse a browser signed in to another account with signed_in, and never switch it", async () => {
    const { deps, mail, member, adminSession, memberSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    for (const s of [memberSession, adminSession]) {
      expect(seen(await check(deps, code, { headers: { cookie: s.cookie } }))).toEqual({ status: 409, headers: API_HEADERS, body: SIGNED_IN });
      const r = await accept(deps, code, "mara", { headers: { cookie: s.cookie } });
      expect(seen(r)).toEqual({ status: 409, headers: API_HEADERS, body: SIGNED_IN });
      expect(r.headers.getSetCookie()).toEqual([]);
    }
    expect(await countOf(deps, "invite")).toBe(1);
    expect(await countOf(deps, `session WHERE user_id = '${member.userId}' AND revoked_at IS NULL`)).toBe(1);
  });

  it("a cookie that names no live session is no session: the accept goes through and its cookie replaces it", async () => {
    const { deps, mail, adminSession, memberSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    expect((await send(deps, "POST", "/api/v1/signout", { origin: APP, headers: { ...page(memberSession) } })).status).toBe(204);
    expect((await check(deps, code, { headers: { cookie: memberSession.cookie } })).status).toBe(200);
    const r = await accept(deps, code, "mara", { headers: { cookie: `${memberSession.cookie}; other=1` } });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.getSetCookie()[0]).toMatch(/^__Host-dp_session=dps_/);
    expect((await accept(deps, "dpi_" + "0".repeat(40), "x-name", { headers: { cookie: `${SESSION_COOKIE}=garbage` } })).text).toBe(INVALID);
  });

  it("must come from a page of the app address, as JSON, as completing a sign-in must", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    for (const path of ["/api/v1/invite/check", "/api/v1/invite/accept"]) {
      const body = JSON.stringify({ code, username: "mara" });
      const noOrigin = await send(deps, "POST", path, { origin: APP, body, headers: { "content-type": "application/json" } });
      expect([noOrigin.status, noOrigin.json.error], path).toEqual([403, "bad_origin"]);
      const crossSite = await send(deps, "POST", path, { origin: APP, body, headers: { "content-type": "application/json", origin: APP, "sec-fetch-site": "cross-site" } });
      expect([crossSite.status, crossSite.json.error], path).toEqual([403, "bad_origin"]);
      const form = await send(deps, "POST", path, { origin: APP, body, headers: { "content-type": "text/plain", origin: APP } });
      expect([form.status, form.json.error], path).toEqual([400, "bad_request"]);
      const tours = await send(deps, "POST", path, { origin: TOURS, body, headers: { "content-type": "application/json", origin: TOURS } });
      expect([tours.status, tours.text], path).toEqual([404, NOT_FOUND]);
    }
    expect(await countOf(deps, "invite")).toBe(1);
    expect(await countOf(deps, "user")).toBe(2);
  });

  it("a network may look up and accept 30 times in 15 minutes, together; callers of no known network share a bound of their own", async () => {
    const { deps, mail, adminSession } = await site();
    const { code } = await invited(deps, mail, adminSession, MARA);
    for (let i = 0; i < 15; i++) expect((await check(deps, code)).status).toBe(200);
    for (let i = 0; i < 15; i++) expect((await accept(deps, code, "Bad_Name")).status).toBe(400);
    const over = await check(deps, code);
    expect([over.status, over.json.error, over.headers.get("retry-after")]).toEqual([429, "rate_limited", String(Math.ceil((900_000 - (NOW % 900_000)) / 1000))]);
    expect((await accept(deps, code, "mara")).status).toBe(429);
    // Another network is not held up, and neither is a caller whose network is not known.
    expect((await check(deps, code, { app: from("198.51.100.9") })).status).toBe(200);
    expect((await check(deps, code, { app: (d) => createApp(d) })).status).toBe(200);
    await deps.db.run("UPDATE rate_counter SET count = ? WHERE bucket = ?", [LIMITS_INVITE.codeUnknownNetwork.most, LIMITS_INVITE.codeUnknownNetwork.bucket]);
    expect((await check(deps, code, { app: (d) => createApp(d) })).status).toBe(429);
    expect((await check(deps, code, { app: from("198.51.100.9") })).status).toBe(200);
    // The invite was never used up.
    expect(await countOf(deps, "invite")).toBe(1);
  });
});

describe("the record and the call budget", () => {
  it("the audit rows of invites hold ids and a number only: never a code or an address", async () => {
    const { deps, mail, adminSession } = await site();
    const first = await invited(deps, mail, adminSession, MARA);
    await resend(deps, adminSession, first.id);
    const code = codeIn(mail.sent[1].text);
    await accept(deps, code, "mara");
    const other = await invited(deps, mail, adminSession, "other@example.com");
    await cancel(deps, adminSession, other.id);
    const recorded = await audits(deps, "invite%");
    expect(recorded.map((a) => a.event)).toEqual(["invite_sent", "invite_resent", "invite_accepted", "invite_sent", "invite_cancelled"]);
    const text = JSON.stringify(recorded);
    expect(text).not.toMatch(/@|dpi_|[0-9a-f]{32}/);
    for (const e of ["invite_sent", "invite_resent", "invite_cancelled", "invite_accepted"]) expect(AUDIT_EVENTS).toContain(e);
  });

  it("every route here stays far under the 40 calls a request may make", async () => {
    const { deps, mail, adminSession } = await site();
    const counts: Record<string, number> = {};
    const note = (key: string, r: Call) => (counts[key] = Math.max(counts[key] ?? 0, r.calls));
    const sent = await invite(deps, adminSession, MARA);
    note("send", sent);
    note("send again", await invite(deps, adminSession, MARA));
    note("list", await list(deps, adminSession));
    note("resend", await resend(deps, adminSession, sent.json.id));
    const code = codeIn(mail.sent[mail.sent.length - 1].text);
    note("check", await check(deps, code));
    note("accept, taken", await accept(deps, code, "tess"));
    note("accept", await accept(deps, code, "mara"));
    const other = await invited(deps, mail, adminSession, "other@example.com");
    note("cancel", await cancel(deps, adminSession, other.id));
    for (const [key, n] of Object.entries(counts)) expect(n, key).toBeLessThan(15);
  });
});
