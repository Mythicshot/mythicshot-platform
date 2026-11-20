// Changing an account's email address (src/email-change.ts): asking for a change, which
// mails a link to the new address, and confirming it, which changes the address once and
// mails a notice to the old one. Runs on both targets. No mail is sent: every mailer here is
// the fake one, or one made in the test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount, type MakeOptions } from "#harness";
import { setEmailOnServer } from "../src/admin.ts";
import { createApp } from "../src/app.ts";
import { EMAIL_CHANGE_LINES, EMAIL_CHANGE_MS, confirmEmailChange } from "../src/email-change.ts";
import { emailChangedMail, emailChangeLink, emailChangeMail, maskEmail } from "../src/mail.ts";
import type { Config, Db, Deps } from "../src/ports.ts";
import { LIMITS_EMAIL_CHANGE, LIMITS_SIGNIN, SITE_KEY, accountKey, recipientKey } from "../src/rate.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { PAD_BUCKET } from "../src/signin.ts";
import { send, type Call, type SendOptions } from "./bundle.ts";

const NOW = 1_800_000_000_000;
const APP = "https://app.example.com";
const TOURS = "https://tours.example.com";
const TWO: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com" } };
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const NEW = "new-address@example.com";

const OK = '{"ok":true}';
const UNAUTHORIZED = '{"error":"unauthorized"}';
const BAD_EMAIL = '{"error":"bad_email"}';
const BAD_CODE = '{"error":"bad_code","detail":"This link no longer works. Ask for a new one from your account page."}';
const MAIL_OFF = '{"error":"mail_off","detail":"This site cannot send mail, so an email address cannot be changed here."}';
const RATE_LIMITED = '{"error":"rate_limited","detail":"Too many requests. Wait a few minutes and try again."}';
const BAD_CSRF = '{"error":"bad_csrf","detail":"the anti-forgery header is missing or wrong"}';
const BAD_ORIGIN = '{"error":"bad_origin","detail":"this request must come from the site\'s own pages"}';
const API_HEADERS = [
  ["cache-control", "no-store"],
  ["content-type", "application/json"],
  ["x-content-type-options", "nosniff"],
];
const EMAIL_CODE = /dpe_[0-9a-f]{40}/g;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A site with a clock the test moves, an admin and two more accounts. */
async function site(config: Partial<Config> = TWO, opts: MakeOptions = {}) {
  const made = await makeDeps(config, opts);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  const admin = await seedAccount(made.deps, { admin: true, username: "boss" });
  const a = await seedAccount(made.deps, { username: "alice" });
  const b = await seedAccount(made.deps);
  return { ...made, clock, admin, a, b };
}

type Signed = { secret: string; sessionId: string; userId: string; cookie: string; csrf: string };

/** A session made as the server makes one. */
async function signIn(deps: Deps, userId: string): Promise<Signed> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), FIREFOX, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { ...made, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** The headers the site's own page on `origin` sends a change with. */
const page = (s: Signed, origin = APP): Record<string, string> => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin", "content-type": "application/json" });

function post(deps: Deps, path: string, body: unknown, s: Signed | null, more: SendOptions & { origin?: string } = {}): Promise<Call> {
  const origin = more.origin ?? APP;
  return send(deps, "POST", path, {
    ...more,
    origin,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...(s === null ? { "content-type": "application/json", origin } : page(s, origin)), ...more.headers },
  });
}

const ask = (deps: Deps, s: Signed | null, email: unknown, more: SendOptions = {}) => post(deps, "/api/v1/account/email", { email }, s, more);
const confirm = (deps: Deps, s: Signed | null, code: unknown, more: SendOptions = {}) => post(deps, "/api/v1/account/email/confirm", { code }, s, more);

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** The one email-change code in a mail. */
function codeIn(text: string): string {
  const found = text.match(EMAIL_CODE) ?? [];
  expect(found, "a mail holds its code once").toHaveLength(1);
  return found[0] ?? "";
}

const emailOf = async (deps: Deps, userId: string) => (await deps.db.first<{ email: string }>("SELECT email FROM user WHERE id = ?", [userId]))!.email;
const countOf = async (deps: Deps, table: string) => (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
const changes = (deps: Deps) => deps.db.all<Record<string, unknown>>("SELECT * FROM email_change ORDER BY user_id");
const padCount = async (deps: Deps) => (await deps.db.first<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM rate_counter WHERE bucket = ?", [PAD_BUCKET]))!.n;

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

const ANSWER = "| answer";
/** The app that puts ANSWER into the list the moment the answer is handed back. */
const answered = (list: string[]) => (deps: Deps) => ({
  fetch: async (req: Request) => {
    const res = await createApp(deps).fetch(req);
    list.push(ANSWER);
    return res;
  },
});
function split(list: string[]): { before: string[]; after: string[] } {
  const all = list.splice(0);
  const at = all.indexOf(ANSWER);
  expect(at, "the answer was marked").toBeGreaterThanOrEqual(0);
  return { before: all.slice(0, at), after: all.slice(at + 1) };
}

/** Asks for a change to `email` as `s` and returns the code the mail to it holds. */
async function askedCode(deps: Deps, mail: { sent: { to: string; text: string }[] }, s: Signed, email: string): Promise<string> {
  const before = mail.sent.length;
  const r = await ask(deps, s, email);
  expect(r.text).toBe(OK);
  expect(mail.sent.length, "one link was mailed").toBe(before + 1);
  const sent = mail.sent[mail.sent.length - 1];
  expect(sent.to).toBe(email);
  return codeIn(sent.text);
}

describe("asking for an email change", () => {
  it("mails a link to the new address and stores only the digest of its code; the address does not change yet", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const r = await ask(deps, s, `  ${NEW.toUpperCase()} `);
    expect(seen(r)).toEqual({ status: 200, headers: API_HEADERS, body: OK });
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(mail.sent).toHaveLength(1);
    const code = codeIn(mail.sent[0].text);
    expect(mail.sent[0]).toEqual({
      to: NEW,
      subject: "Confirm your new Mythicshot email address",
      text: [
        "Open this link to make this the email address of your Mythicshot account:",
        "",
        `${APP}/account/email#c=${code}`,
        "",
        "It works once and for 15 minutes, in the browser where you are signed in. Until it is opened, nothing changes. If you did not ask for this, ignore this mail.",
        "",
      ].join("\n"),
    });
    // The mail names neither the account nor its present address.
    expect(mail.sent[0].text).not.toContain(a.email);
    expect(mail.sent[0].text).not.toContain("alice");
    const rows = await changes(deps);
    expect(rows).toEqual([{ id: expect.stringMatching(/^emc_[0-9a-f]{24}$/), user_id: a.userId, new_email: NEW, code_hash: expect.stringMatching(/^[0-9a-f]{64}$/), created_at: NOW, used_at: null }]);
    expect(JSON.stringify(rows)).not.toContain(code.slice(4));
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    expect(await deps.db.all("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event LIKE 'email%'")).toEqual([
      { event: "email_change_requested", user_id: a.userId, workspace_id: a.workspaceId, subject: a.userId, detail: null },
    ]);
  });

  it("answers the same for a free address, another account's and the caller's own: status, body, headers and database calls", async () => {
    const { deps, mail, a, b } = await site();
    const s = await signIn(deps, a.userId);
    const kinds = recordKinds(deps);
    const app = answered(kinds);

    const free = await ask(deps, s, NEW, { app });
    const freeCalls = split(kinds);
    expect(await padCount(deps)).toBe(0);
    kinds.length = 0;
    const taken = await ask(deps, s, b.email, { app });
    const takenCalls = split(kinds);
    expect(await padCount(deps)).toBe(1);
    kinds.length = 0;
    const own = await ask(deps, s, a.email, { app });
    const ownCalls = split(kinds);
    expect(await padCount(deps)).toBe(2);
    kinds.length = 0;

    expect(seen(free)).toEqual({ status: 200, headers: API_HEADERS, body: OK });
    expect(seen(taken)).toEqual(seen(free));
    expect(seen(own)).toEqual(seen(free));
    // Before the answer: the session, the four counts, the one read, the mail cap, the sweep.
    expect(freeCalls.before).toEqual(["all", "first", "first", "first", "first", "first", "first", "run"]);
    expect(takenCalls.before).toEqual(freeCalls.before);
    expect(ownCalls.before).toEqual(freeCalls.before);
    // After it, one batch of two rows each way: the change and its audit row, or the pad and the audit row.
    expect(freeCalls.after).toEqual(["batch 2"]);
    expect(takenCalls.after).toEqual(freeCalls.after);
    expect(ownCalls.after).toEqual(freeCalls.after);

    // A taken address: nothing stored, nothing mailed, neither to it nor to anyone. The free one did get its link.
    expect(mail.sent.map((m) => m.to)).toEqual([NEW]);
    expect((await changes(deps)).map((r) => r.new_email)).toEqual([NEW]);
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    expect(await emailOf(deps, b.userId)).toBe(b.email);
    // Each request is in the audit record, by ids alone.
    expect(await countOf(deps, "audit WHERE event = 'email_change_requested'")).toBe(3);
  });

  it("asking for a taken address does not replace the change the account asked for before", async () => {
    const { deps, mail, a, b } = await site();
    const s = await signIn(deps, a.userId);
    const code = await askedCode(deps, mail, s, NEW);
    expect((await ask(deps, s, b.email)).text).toBe(OK);
    expect((await confirm(deps, s, code)).status).toBe(200);
    expect(await emailOf(deps, a.userId)).toBe(NEW);
  });

  it("refuses an address that is not one: a NUL, a line break, too long, odd unicode", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const bad = [
      "",
      "not an address",
      "a\u0000@example.com",
      "a@example.com\u0000",
      "a@example.com\n",
      "a@exa\nmple.com",
      `${"a".repeat(65)}@example.com`,
      `a@${"b".repeat(250)}.com`,
      "\u00e4@example.com",
      "a@ex\u00e4mple.com",
      "\uff41@example.com",
      "a\u200b@example.com",
      "a@example.com\u202e",
      "a@@example.com",
      "a@localhost",
      "<a@example.com>",
      42,
      null,
      ["a@example.com"],
    ];
    for (const email of bad) {
      const r = await ask(deps, s, email);
      expect([r.status, r.text], JSON.stringify(email)).toEqual([400, BAD_EMAIL]);
    }
    expect(mail.sent).toEqual([]);
    expect(await countOf(deps, "email_change")).toBe(0);
    // Refused before anything was counted.
    expect(await countOf(deps, "rate_counter WHERE bucket LIKE 'email%'")).toBe(0);
  });

  it("takes a session only: a token, no credential and both are refused, and nothing is stored", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const byToken = await send(deps, "POST", "/api/v1/account/email", { origin: APP, token: a.token, body: JSON.stringify({ email: NEW }), headers: { "content-type": "application/json" } });
    expect([byToken.status, byToken.text]).toEqual([401, UNAUTHORIZED]);
    const nobody = await ask(deps, null, NEW);
    expect([nobody.status, nobody.text]).toEqual([401, UNAUTHORIZED]);
    const both = await ask(deps, s, NEW, { token: a.token });
    expect(both.status).toBe(400);
    const tokenConfirm = await send(deps, "POST", "/api/v1/account/email/confirm", { origin: APP, token: a.token, body: JSON.stringify({ code: "dpe_" + "0".repeat(40) }), headers: { "content-type": "application/json" } });
    expect([tokenConfirm.status, tokenConfirm.text]).toEqual([401, UNAUTHORIZED]);
    expect(mail.sent).toEqual([]);
    expect(await countOf(deps, "email_change")).toBe(0);
  });

  it("refuses a change without the anti-forgery header or from another origin, on both routes", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const code = await askedCode(deps, mail, s, NEW);
    for (const path of ["/api/v1/account/email", "/api/v1/account/email/confirm"]) {
      const body = path.endsWith("confirm") ? { code } : { email: "other@example.com" };
      const noCsrf = await post(deps, path, body, s, { headers: { "x-csrf-token": "" } });
      expect([noCsrf.status, noCsrf.text], path).toEqual([403, BAD_CSRF]);
      const wrongCsrf = await post(deps, path, body, s, { headers: { "x-csrf-token": "0".repeat(64) } });
      expect([wrongCsrf.status, wrongCsrf.text], path).toEqual([403, BAD_CSRF]);
      const elsewhere = await post(deps, path, body, s, { headers: { origin: "https://evil.example.net" } });
      expect([elsewhere.status, elsewhere.text], path).toEqual([403, BAD_ORIGIN]);
      const crossSite = await post(deps, path, body, s, { headers: { "sec-fetch-site": "cross-site" } });
      expect([crossSite.status, crossSite.text], path).toEqual([403, BAD_ORIGIN]);
    }
    expect(mail.sent).toHaveLength(1);
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    expect((await changes(deps))[0].used_at).toBeNull();
  });

  it("answers only on the app address: the tours address says not found, and stores nothing", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    for (const path of ["/api/v1/account/email", "/api/v1/account/email/confirm"]) {
      const r = await post(deps, path, { email: NEW, code: "dpe_" + "0".repeat(40) }, s, { origin: TOURS });
      expect([r.status, r.text], path).toEqual([404, '{"error":"not_found"}']);
    }
    expect(mail.sent).toEqual([]);
    expect(await countOf(deps, "email_change")).toBe(0);
  });

  it("with mail off, or no address for links, answers mail_off, counts and stores nothing, and the session says so", async () => {
    for (const [what, config, opts] of [
      ["no mailer", TWO, { mail: false }],
      ["no address for links", {}, {}],
    ] as const) {
      const { deps, mail, a } = await site(config, opts);
      const s = await signIn(deps, a.userId);
      const r = await ask(deps, s, NEW);
      expect(seen(r), what).toEqual({ status: 409, headers: API_HEADERS, body: MAIL_OFF });
      expect(mail.sent, what).toEqual([]);
      expect(await countOf(deps, "email_change"), what).toBe(0);
      expect(await countOf(deps, "rate_counter"), what).toBe(0);
      const session = await send(deps, "GET", "/api/v1/session", { origin: config === TWO ? APP : "https://one.example.com", headers: { cookie: s.cookie } });
      expect(session.json.email_change, what).toBe(false);
    }
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    expect((await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: s.cookie } })).json.email_change).toBe(true);
    // One address with SITE_HOST: links can be mailed.
    const one = await site({ siteHost: "demo.example.com" });
    const t = await signIn(one.deps, one.a.userId);
    expect((await send(one.deps, "GET", "/api/v1/session", { origin: "https://demo.example.com", headers: { cookie: t.cookie } })).json.email_change).toBe(true);
    const asked = await ask(one.deps, t, NEW, { origin: "https://demo.example.com" });
    expect(asked.text).toBe(OK);
    expect(codeIn(one.mail.sent[0].text)).toMatch(EMAIL_CODE);
    expect(one.mail.sent[0].text).toContain("https://demo.example.com/account/email#c=dpe_");
  });

  it("counts per account: three in a quarter hour, ten in a day; over that, 429 with the sentence and nothing sent", async () => {
    const { deps, mail, clock, a } = await site();
    const s = await signIn(deps, a.userId);
    for (let i = 0; i < 3; i++) expect((await ask(deps, s, `free-${i}@example.com`)).text).toBe(OK);
    const over = await ask(deps, s, "free-3@example.com");
    expect([over.status, over.text]).toEqual([429, RATE_LIMITED]);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(over.headers.get("retry-after"))).toBeLessThanOrEqual(900);
    expect(mail.sent).toHaveLength(3);
    // The next quarter hours count again, up to ten tries in the day; the refused one counted too.
    for (const quarter of [1, 2]) {
      clock.now = NOW + quarter * 900_000;
      for (let i = 0; i < 3; i++) expect((await ask(deps, s, `later-${quarter}-${i}@example.com`)).text).toBe(OK);
    }
    clock.now = NOW + 3 * 900_000;
    const day = await ask(deps, s, "one-more@example.com");
    expect([day.status, day.text]).toEqual([429, RATE_LIMITED]);
    expect(mail.sent).toHaveLength(9);
    // The counters hold digests, never the account's id or an address.
    const keys = await deps.db.all<{ key: string }>("SELECT key FROM rate_counter WHERE bucket LIKE 'email%'");
    for (const { key } of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.map((k) => k.key)).toContain(await accountKey(a.userId));
  });

  it("counts per new address, from any account, and whether or not it is taken", async () => {
    const { deps, mail, admin, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const sAdmin = await signIn(deps, admin.userId);
    expect((await ask(deps, sa, NEW)).text).toBe(OK);
    expect((await ask(deps, sb, NEW)).text).toBe(OK);
    expect((await ask(deps, sAdmin, NEW)).text).toBe(OK);
    const over = await ask(deps, sa, NEW);
    expect([over.status, over.text]).toEqual([429, RATE_LIMITED]);
    expect(mail.sent.map((m) => m.to)).toEqual([NEW, NEW, NEW]);
    // A taken address is counted the same, so the 429 says nothing about it.
    for (const s of [sa, sAdmin, sb]) expect((await ask(deps, s, b.email)).text).toBe(OK);
    expect((await ask(deps, sAdmin, b.email)).text).toBe(RATE_LIMITED);
    expect(await deps.db.first("SELECT count FROM rate_counter WHERE bucket = ? AND key = ?", [LIMITS_EMAIL_CHANGE.requestRecipient.bucket, await recipientKey(b.email)])).toEqual({ count: 4 });
  });

  it("a mail the site's hourly cap stops is not sent; the answer is the same and one fixed line is written", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const hour = LIMITS_SIGNIN.mailSite.windowMs;
    await deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, ?)", [LIMITS_SIGNIN.mailSite.bucket, SITE_KEY, NOW - (NOW % hour), LIMITS_SIGNIN.mailSite.most]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await ask(deps, s, NEW);
    expect(seen(r)).toEqual({ status: 200, headers: API_HEADERS, body: OK });
    expect(mail.sent).toEqual([]);
    expect(await countOf(deps, "email_change")).toBe(0);
    expect(errors.mock.calls).toEqual([[EMAIL_CHANGE_LINES.hour]]);
  });

  it("a mail that cannot be sent is one fixed line without the address, and the change waits for a new request", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mail.failNext();
    const r = await ask(deps, s, NEW);
    expect(r.text).toBe(OK);
    expect(errors.mock.calls).toEqual([["mail: an email-change mail could not be sent (failed)"]]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(NEW);
  });
});

describe("confirming an email change", () => {
  it("changes the address once, keeps the sessions signed in, mails the notice to the old address and records it by ids", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const other = await signIn(deps, a.userId);
    const code = await askedCode(deps, mail, s, NEW);
    const r = await confirm(deps, s, code);
    expect(seen(r)).toEqual({ status: 200, headers: API_HEADERS, body: JSON.stringify({ email: NEW, previous_email: a.email }) });
    expect(await emailOf(deps, a.userId)).toBe(NEW);
    expect(mail.sent[1]).toEqual({
      to: a.email,
      subject: "Your Mythicshot email address was changed",
      text: ['The email address of the Mythicshot account "alice" was changed to n…@example.com.', "", "If this was you, there is nothing to do.", "If it was not, answer this mail or contact the person who runs this site.", ""].join("\n"),
    });
    expect(mail.sent).toHaveLength(2);
    // Both sessions are still signed in, and the session shows the new address.
    for (const t of [s, other]) {
      const session = await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: t.cookie } });
      expect(session.status).toBe(200);
      expect(session.json.account.email).toBe(NEW);
    }
    expect((await changes(deps))[0].used_at).toBe(NOW);
    expect(await deps.db.all("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event = 'email_changed'")).toEqual([
      { event: "email_changed", user_id: a.userId, workspace_id: a.workspaceId, subject: a.userId, detail: null },
    ]);
  });

  it("a link opened twice changes nothing the second time, and gets the one refusal", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const code = await askedCode(deps, mail, s, NEW);
    expect((await confirm(deps, s, code)).status).toBe(200);
    const again = await confirm(deps, s, code);
    expect(seen(again)).toEqual({ status: 400, headers: API_HEADERS, body: BAD_CODE });
    expect(mail.sent).toHaveLength(2);
    expect(await countOf(deps, "audit WHERE event = 'email_changed'")).toBe(1);
  });

  it("a link works for 15 minutes and not a moment longer", async () => {
    const { deps, mail, clock, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const late = await askedCode(deps, mail, sa, NEW);
    const inTime = await askedCode(deps, mail, sb, "in-time@example.com");
    clock.now = NOW + EMAIL_CHANGE_MS;
    const r = await confirm(deps, sa, late);
    expect(seen(r)).toEqual({ status: 400, headers: API_HEADERS, body: BAD_CODE });
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    clock.now = NOW + EMAIL_CHANGE_MS - 1;
    expect((await confirm(deps, sb, inTime)).status).toBe(200);
    expect(await emailOf(deps, b.userId)).toBe("in-time@example.com");
  });

  it("asking again replaces the earlier change: its link no longer works, the new one does", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const first = await askedCode(deps, mail, s, NEW);
    const second = await askedCode(deps, mail, s, "second@example.com");
    expect(await countOf(deps, "email_change")).toBe(1);
    expect(seen(await confirm(deps, s, first))).toEqual({ status: 400, headers: API_HEADERS, body: BAD_CODE });
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    expect((await confirm(deps, s, second)).json).toEqual({ email: "second@example.com", previous_email: a.email });
  });

  it("another account's code gets the one refusal and changes nothing of either account", async () => {
    const { deps, mail, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const code = await askedCode(deps, mail, sa, NEW);
    const before = await changes(deps);
    const r = await confirm(deps, sb, code);
    expect(seen(r)).toEqual(seen(await confirm(deps, sb, "dpe_" + "0".repeat(40))));
    expect(r.text).toBe(BAD_CODE);
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    expect(await emailOf(deps, b.userId)).toBe(b.email);
    expect(await changes(deps)).toEqual(before);
    // The account that asked can still use it.
    expect((await confirm(deps, sa, code)).status).toBe(200);
    expect(await emailOf(deps, a.userId)).toBe(NEW);
  });

  it("a sign-in code is never an email-change code, and an email-change code is never a sign-in code", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const emailCode = await askedCode(deps, mail, s, NEW);
    const signInCode = await createSignInCode(deps, a.userId);
    const hex = (code: string) => code.slice(4);
    // A sign-in code, as it is and with the other prefix, to the confirm route.
    for (const code of [signInCode, "dpe_" + hex(signInCode)]) {
      expect(seen(await confirm(deps, s, code)), code.slice(0, 4)).toEqual({ status: 400, headers: API_HEADERS, body: BAD_CODE });
    }
    // The email-change code, as it is and with the sign-in prefix, to the sign-in route.
    const asIs = await send(deps, "POST", "/api/v1/signin/complete", { origin: APP, body: JSON.stringify({ code: emailCode }), headers: { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin" } });
    expect([asIs.status, asIs.text]).toEqual([400, '{"error":"bad_code"}']);
    const swapped = await send(deps, "POST", "/api/v1/signin/complete", { origin: APP, body: JSON.stringify({ code: "dpl_" + hex(emailCode) }), headers: { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin" } });
    expect(swapped.status).toBe(403);
    expect(swapped.json.error).toBe("link_invalid");
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    // Both still work where they belong.
    expect((await confirm(deps, s, emailCode)).status).toBe(200);
    expect(await redeemSignInCode(deps, signInCode, null, null)).toBeNull(); // spent by the change: it went to the old address
  });

  it("malformed codes and bodies get the refusals they always get, and store nothing", async () => {
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    for (const code of ["", "dpe_", "dpe_" + "0".repeat(39), "dpe_" + "0".repeat(41), "DPE_" + "0".repeat(40), "dpe_" + "G".repeat(40), " dpe_" + "0".repeat(40), "dpe_" + "0".repeat(39) + "\u0000", 7, null]) {
      expect((await confirm(deps, s, code)).text, JSON.stringify(code)).toBe(BAD_CODE);
    }
    const notJson = await post(deps, "/api/v1/account/email/confirm", "{", s);
    expect([notJson.status, notJson.json.error]).toEqual([400, "bad_request"]);
    const notObject = await post(deps, "/api/v1/account/email", "[]", s);
    expect([notObject.status, notObject.json.error]).toEqual([400, "bad_request"]);
    const asForm = await post(deps, "/api/v1/account/email", `email=${NEW}`, s, { headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect([asForm.status, asForm.json.error]).toEqual([400, "bad_request"]);
    expect(await countOf(deps, "email_change")).toBe(0);
  });

  it("of two confirms at once, exactly one changes the address", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const code = await askedCode(deps, mail, s, NEW);
    const both = await Promise.all([confirm(deps, s, code), confirm(deps, s, code)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(both.find((r) => r.status === 400)?.text).toBe(BAD_CODE);
    expect(await emailOf(deps, a.userId)).toBe(NEW);
    expect(await countOf(deps, "audit WHERE event = 'email_changed'")).toBe(1);
    expect(mail.sent.filter((m) => m.to === a.email)).toHaveLength(1);
  });

  it("an address another account took in the meantime is refused, and the link is spent", async () => {
    const { deps, mail, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const codeA = await askedCode(deps, mail, sa, NEW);
    const codeB = await askedCode(deps, mail, sb, NEW);
    // The other account confirms first.
    expect((await confirm(deps, sb, codeB)).status).toBe(200);
    const r = await confirm(deps, sa, codeA);
    expect(seen(r)).toEqual({ status: 400, headers: API_HEADERS, body: BAD_CODE });
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    expect(await emailOf(deps, b.userId)).toBe(NEW);
    expect((await changes(deps)).find((x) => x.user_id === a.userId)?.used_at).toBe(NOW);
    expect(await countOf(deps, "audit WHERE event = 'email_changed'")).toBe(1);
  });

  it("of two accounts confirming the same address at once, exactly one gets it", async () => {
    const { deps, mail, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const codeA = await askedCode(deps, mail, sa, NEW);
    const codeB = await askedCode(deps, mail, sb, NEW);
    const both = await Promise.all([confirm(deps, sa, codeA), confirm(deps, sb, codeB)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
    const owners = await deps.db.all<{ id: string }>("SELECT id FROM user WHERE email = ?", [NEW]);
    expect(owners).toHaveLength(1);
    expect(owners[0].id).toBe(both[0].status === 200 ? a.userId : b.userId);
    expect(await countOf(deps, "audit WHERE event = 'email_changed'")).toBe(1);
  });

  it("the batch decides: a change read as usable but taken before the batch runs is refused on both targets", async () => {
    const { deps, mail, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const code = await askedCode(deps, mail, sa, NEW);
    // Between the read and the batch, another account takes the address.
    const db = deps.db;
    deps.db = {
      ...db,
      all: (sql, params) => db.all(sql, params),
      first: async (sql, params) => {
        const row = await db.first(sql, params);
        if (sql.includes("FROM email_change e")) await db.run("UPDATE user SET email = ? WHERE id = ?", [NEW, b.userId]);
        return row as never;
      },
      run: (sql, params) => db.run(sql, params),
      batch: (stmts) => db.batch(stmts),
    };
    expect(await confirmEmailChange(deps, a.userId, code)).toBeNull();
    deps.db = db;
    expect(await emailOf(deps, a.userId)).toBe(a.email);
    expect(await countOf(deps, "audit WHERE event = 'email_changed'")).toBe(0);
  });

  it("the changed address signs in from now on, the old one does not, and open sign-in links to the old one are spent", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const open = await createSignInCode(deps, a.userId);
    const code = await askedCode(deps, mail, s, NEW);
    expect((await confirm(deps, s, code)).status).toBe(200);
    expect(await redeemSignInCode(deps, open, null, null)).toBeNull();
    const askLink = (email: string) => send(deps, "POST", "/api/v1/signin/request", { origin: APP, body: JSON.stringify({ email }), headers: { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin" } });
    mail.sent.length = 0;
    expect((await askLink(a.email)).text).toBe(OK);
    expect(mail.sent).toEqual([]);
    expect((await askLink(NEW)).text).toBe(OK);
    expect(mail.sent.map((m) => m.to)).toEqual([NEW]);
    const link = (mail.sent[0].text.match(/dpl_[0-9a-f]{40}/) ?? [""])[0];
    expect(await redeemSignInCode(deps, link, null, null)).not.toBeNull();
  });

  it("counts code tries per account: twenty in a quarter hour, then 429 with the sentence", async () => {
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    for (let i = 0; i < 20; i++) expect((await confirm(deps, s, "dpe_" + String(i).padStart(40, "0"))).text).toBe(BAD_CODE);
    const over = await confirm(deps, s, "dpe_" + "f".repeat(40));
    expect([over.status, over.text]).toEqual([429, RATE_LIMITED]);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("with mail off by the time the link is opened, the change is made and one fixed line says no notice was sent", async () => {
    const { deps, mail, a } = await site();
    const s = await signIn(deps, a.userId);
    const code = await askedCode(deps, mail, s, NEW);
    delete deps.mail;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await confirm(deps, s, code)).status).toBe(200);
    expect(errors.mock.calls).toEqual([[EMAIL_CHANGE_LINES.noticeOff]]);
  });

  it("no audit row, counter or log line holds an address or a code", async () => {
    const { deps, mail, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const lines: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args));
    const code = await askedCode(deps, mail, sa, NEW);
    await ask(deps, sa, b.email);
    await confirm(deps, sa, "dpe_" + "1".repeat(40));
    await confirm(deps, sa, code);
    const audit = JSON.stringify(await deps.db.all("SELECT * FROM audit"));
    const counters = JSON.stringify(await deps.db.all("SELECT * FROM rate_counter"));
    for (const secret of [NEW, a.email, b.email, "@", code, code.slice(4)]) {
      expect(audit.includes(secret), secret).toBe(false);
      expect(counters.includes(secret), secret).toBe(false);
      expect(JSON.stringify(lines).includes(secret), secret).toBe(false);
    }
    expect(audit).toContain("email_change_requested");
    expect(audit).toContain("email_changed");
  });
});

describe("the mail texts", () => {
  it("hides the new address in the notice: its first character, then …, then the @ and the domain", () => {
    expect(maskEmail("new@example.com")).toBe("n…@example.com");
    expect(maskEmail("n@example.com")).toBe("n…@example.com");
    expect(maskEmail("first.last+tag@sub.example.co.uk")).toBe("f…@sub.example.co.uk");
    expect(maskEmail("@example.com")).toBe("…");
    expect(maskEmail("no-at-sign")).toBe("…");
  });

  it("an account without a username is called your account in the notice", () => {
    expect(emailChangedMail("old@example.com", null, "new@example.com").text.split("\n")[0]).toBe("The email address of your Mythicshot account was changed to n…@example.com.");
    expect(emailChangedMail("old@example.com", 'x"\nBcc: y', "new@example.com").text.split("\n")[0]).toBe("The email address of your Mythicshot account was changed to n…@example.com.");
    expect(emailChangedMail("old@example.com", "solex", "new@example.com", "Harbor Tours").subject).toBe("Your Harbor Tours email address was changed");
  });

  it("the link takes only an origin and a code, and puts the code after the #", () => {
    expect(emailChangeLink("https://app.example.com", "dpe_" + "a".repeat(40))).toBe(`https://app.example.com/account/email#c=dpe_${"a".repeat(40)}`);
    expect(() => emailChangeLink("https://app.example.com/x", "dpe_a")).toThrow("bad origin");
    expect(() => emailChangeLink("http://app.example.com", "dpe_a")).toThrow("bad origin");
    expect(() => emailChangeLink("https://app.example.com", "dpe a")).toThrow("bad code");
    expect(emailChangeMail("x@example.com", "LINK", "Site\nBcc: y").subject).toBe("Confirm your new Mythicshot email address");
  });
});

describe("the server's change-email", () => {
  it("changes the address at once, ends the account's open change and sign-in links, and records it by ids", async () => {
    const { deps, mail, a, b } = await site();
    const s = await signIn(deps, a.userId);
    const code = await askedCode(deps, mail, s, NEW);
    const open = await createSignInCode(deps, a.userId);
    expect(await setEmailOnServer(deps, { username: " Alice ", email: "Fixed@Example.com" })).toEqual({ ok: true, userId: a.userId, email: "fixed@example.com" });
    expect(await emailOf(deps, a.userId)).toBe("fixed@example.com");
    expect((await confirm(deps, s, code)).text).toBe(BAD_CODE);
    expect(await redeemSignInCode(deps, open, null, null)).toBeNull();
    expect(await deps.db.all("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event = 'email_changed_on_server'")).toEqual([
      { event: "email_changed_on_server", user_id: a.userId, workspace_id: a.workspaceId, subject: a.userId, detail: null },
    ]);
    // Refusals change nothing.
    expect(await setEmailOnServer(deps, { username: "alice", email: b.email })).toEqual({ ok: false, problem: "email_taken" });
    expect(await setEmailOnServer(deps, { username: "alice", email: "fixed@example.com" })).toEqual({ ok: false, problem: "same_email" });
    expect(await setEmailOnServer(deps, { username: "nobody", email: "x@example.com" })).toEqual({ ok: false, problem: "no_account" });
    expect(await setEmailOnServer(deps, { username: "a\u0000lice", email: "x@example.com" })).toEqual({ ok: false, problem: "no_account" });
    expect(await setEmailOnServer(deps, { username: "alice", email: "x\u0000@example.com" })).toEqual({ ok: false, problem: "bad_email" });
    expect(await emailOf(deps, a.userId)).toBe("fixed@example.com");
    expect(await countOf(deps, "audit WHERE event = 'email_changed_on_server'")).toBe(1);
  });
});
