// The mail sent when the desktop app has collected its token (src/connect-mail.ts, and its
// text in src/mail.ts), on both targets: the exact words, one mail per collected token and
// none for a collection that fails or loses a race, a collection that is the same whatever
// the mail does (off, failing, hanging, over its cap, an unusable address), and a mail
// builder that keeps the device's name on its one line. Nothing here contacts anything.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { AUDIT_EVENTS } from "../src/audit.ts";
import { CONNECTED_MAIL_LINES, mailConnection } from "../src/connect-mail.ts";
import { POLL_GAP_MS, VERIFY_PATH } from "../src/connect.ts";
import { connectedMail, type Mailer } from "../src/mail.ts";
import type { Config, Db, Deps } from "../src/ports.ts";
import { LIMITS_CONNECT_MAIL, LIMITS_EMAIL_CHANGE, LIMITS_SIGNIN, SITE_KEY, accountKey } from "../src/rate.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, send, type Call } from "./bundle.ts";

// 2027-01-15 08:00:00 UTC.
const NOW = 1_800_000_000_000;
const WHEN = "15 Jan 2027 at 08:00 UTC";
const TWO: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com" } };
const APP = "https://app.example.com";

const SUBJECT = "A computer was connected to your Mythicshot account";
const withLink = (name: string, when: string, origin: string) =>
  [
    `Mythicshot on the computer "${name}" was connected to your account on ${when}. It can publish, change and delete everything in your workspace.`,
    "",
    "If that was you, nothing needs to be done.",
    "",
    "If it was not, disconnect it here and it stops working at once:",
    "",
    `${origin}/connections`,
    "",
  ].join("\n");
const withoutLink = (name: string, when: string) =>
  [
    `Mythicshot on the computer "${name}" was connected to your account on ${when}. It can publish, change and delete everything in your workspace.`,
    "",
    "If that was you, nothing needs to be done.",
    "",
    "If it was not, open the Connections page of your dashboard and disconnect it there: it stops working at once.",
    "",
  ].join("\n");

type Signed = { sessionId: string; cookie: string; csrf: string };

async function signIn(deps: Deps, userId: string): Promise<Signed> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { sessionId: made.sessionId, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** A site with a clock the test moves, an admin and two accounts, each with its own workspace. */
async function site(config: Partial<Config> = {}, opts: { mail?: boolean } = {}) {
  const made = await makeDeps(config, opts);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  await seedAccount(made.deps, { admin: true, username: "boss" });
  const a = await seedAccount(made.deps, { username: "alice" });
  const b = await seedAccount(made.deps, { username: "bob" });
  return { ...made, clock, a, b, tick: (ms: number) => void (clock.now += ms) };
}

const json = { "content-type": "application/json" };
const start = (deps: Deps, name = "Work laptop") => send(deps, "POST", "/api/v1/connect/start", { body: JSON.stringify({ device_name: name }), headers: json });
const poll = (deps: Deps, code: string, more: { settle?: boolean } = {}) => send(deps, "POST", "/api/v1/connect/token", { ...more, body: JSON.stringify({ device_code: code }), headers: json });
/** Confirms on `origin`: the app address in two-address mode, where sessions are. */
const confirm = (deps: Deps, s: Signed, code: string, origin: string) =>
  send(deps, "POST", "/api/v1/connect/confirm", { origin, body: JSON.stringify({ user_code: code }), headers: { cookie: s.cookie, origin, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin", ...json } });

/** A request started and confirmed by `s`, with the clock moved on so it can be collected. */
async function confirmed(made: { deps: Deps; tick: (ms: number) => void }, s: Signed, name = "Work laptop"): Promise<string> {
  const r = await start(made.deps, name);
  expect(r.status, r.text).toBe(201);
  const c = await confirm(made.deps, s, r.json.user_code, made.deps.config.hosts ? APP : ORIGIN);
  expect(c.status, c.text).toBe(204);
  made.tick(POLL_GAP_MS);
  return r.json.device_code as string;
}

/** Everything a client can see of an answer, the token aside (it is new each time). */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.json === null ? c.text : { ...c.json, token: typeof c.json.token, workspace: { ...c.json.workspace, id: typeof c.json.workspace?.id } } });

const notSent = (deps: Deps) => deps.db.all<{ user_id: string; workspace_id: string; subject: string; detail: string }>("SELECT user_id, workspace_id, subject, detail FROM audit WHERE event = 'connection_mail_not_sent' ORDER BY at, rowid");

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

describe("the mail's text", () => {
  it("is the approved wording: the subject, the device's name in quotes, the day and time in UTC, and the Connections page", () => {
    const mail = connectedMail("ada@example.com", "ROBIN-DESKTOP", NOW, APP);
    expect(mail).toEqual({ to: "ada@example.com", subject: SUBJECT, text: withLink("ROBIN-DESKTOP", WHEN, APP) });
    // A day of one digit has no zero before it; hours and minutes always have two digits.
    expect(connectedMail("ada@example.com", "x", Date.UTC(2026, 10, 5, 4, 7, 59), APP).text).toContain(" on 5 Nov 2026 at 04:07 UTC.");
    expect(connectedMail("ada@example.com", "x", Date.UTC(2026, 11, 31, 23, 59), APP).text).toContain(" on 31 Dec 2026 at 23:59 UTC.");
    expect(connectedMail("ada@example.com", "x", NOW, "http://localhost:8787").text).toContain("\nhttp://localhost:8787/connections\n");
    // The page is the one the app is sent to.
    expect(VERIFY_PATH).toBe("/connections");
    // Another site name changes the subject only: the app on the computer is Mythicshot.
    const other = connectedMail("ada@example.com", "x", NOW, APP, "Harbor Tours");
    expect(other.subject).toBe("A computer was connected to your Harbor Tours account");
    expect(other.text.startsWith('Mythicshot on the computer "x"')).toBe(true);
  });

  it("without an address for links it says where to go instead, in words, and holds no link", () => {
    for (const origin of [null, "", "app.example.com", "https://app.example.com/connections", "javascript:alert(1)", "https://evil.example.net\nBcc: x@example.com"]) {
      const mail = connectedMail("ada@example.com", "Laptop", NOW, origin);
      expect(mail, String(origin)).toEqual({ to: "ada@example.com", subject: SUBJECT, text: withoutLink("Laptop", WHEN) });
    }
  });

  it("keeps the device's name on its one line inside the quotes, whatever it holds", () => {
    const usual = connectedMail("ada@example.com", "Laptop", NOW, APP);
    const lines = usual.text.split("\n").length;
    const attempts = [
      "Laptop\r\nBcc: victim@example.com",
      "Laptop\nSubject: You won",
      "Laptop\rTo: x@example.com",
      "\r\n\r\nhttps://evil.example.net/connections",
      "Bcc: victim@example.com",
      "Content-Type: text/html",
      "a\u2028b\u2029c\u0085d\u000bf\u000cg",
      "a\u0000b\u001bc\u007fd",
      "a\u202eb\u200bc\u00add\ufeffe",
      "a\ud800b",
      "x".repeat(500),
    ];
    for (const name of attempts) {
      const mail = connectedMail("ada@example.com", name, NOW, APP);
      expect(mail.subject, JSON.stringify(name)).toBe(SUBJECT);
      expect(mail.to).toBe("ada@example.com");
      const text = mail.text.split("\n");
      expect(text.length, JSON.stringify(name)).toBe(lines);
      expect(mail.text, JSON.stringify(name)).not.toMatch(/\r|[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u200b\u202e\u00ad\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])/);
      // Everything after the first line is the approved text, unchanged.
      expect(text.slice(1)).toEqual(usual.text.split("\n").slice(1));
      const first = /^Mythicshot on the computer "(.*)" was connected to your account on 15 Jan 2027 at 08:00 UTC\. It can publish, change and delete everything in your workspace\.$/.exec(text[0]);
      expect(first, JSON.stringify(name)).not.toBeNull();
      // At most 60 characters of the name, and a mark when it was cut.
      expect([...first![1]].length).toBeLessThanOrEqual(61);
    }
    expect(connectedMail("ada@example.com", "Laptop\r\nBcc: victim@example.com", NOW, APP).text.split("\n")[0]).toContain('"Laptop\ufffd\ufffdBcc: victim at example.com"');
    expect(connectedMail("ada@example.com", "x".repeat(61), NOW, APP).text.split("\n")[0]).toContain(`"${"x".repeat(60)}…"`);
    expect(connectedMail("ada@example.com", "😀".repeat(60), NOW, APP).text.split("\n")[0]).toContain(`"${"😀".repeat(60)}"`);
    // A name that is empty, or not text, is still a line of its own.
    for (const name of ["", "   ", null, 5]) expect(connectedMail("ada@example.com", name as string, NOW, APP).text.split("\n")[0], String(name)).toContain('the computer "(no name)" was connected');
  });
  it("makes the name inert: it cannot close its quotes, and no mail client can link anything in it", () => {
    /** The name as the mail shows it, between the sentence's own two quotes. */
    const shown = (name: string) => {
      const line = connectedMail("ada@example.com", name, NOW, APP).text.split("\n")[0];
      const m = /^Mythicshot on the computer "(.*)" was connected to your account on 15 Jan 2027 at 08:00 UTC\. It can publish, change and delete everything in your workspace\.$/.exec(line);
      expect(m, name).not.toBeNull();
      // The sentence's own two quotes are the only double quotes on the line.
      expect(line.split('"').length, name).toBe(3);
      return m![1];
    };
    const example = shown('x" was removed. Click https://evil.example to keep "y');
    expect(example).toBe("x' was removed. Click https:/ /evil.example to keep 'y");
    for (const name of ['x" was removed. Click https://evil.example to keep "y', "Visit www.evil.example now", "WWW.Evil.Example", "mail me@evil.example", "ftp://a and http://b", "me\uff20evil.example or me\ufe6bevil.example"]) {
      const text = shown(name);
      expect(text, name).not.toContain("://");
      expect(text.toLowerCase(), name).not.toContain("www.");
      expect(text, name).not.toMatch(/[@\uff20\ufe6b]/);
    }
    expect(shown("Visit www.evil.example now")).toBe("Visit www .evil.example now");
    expect(shown("mail me@evil.example")).toBe("mail me at evil.example");
    // Every quotation mark that could close the quotes becomes an apostrophe.
    const quotes = ['"', "\u201c", "\u201d", "\u201e", "\u201f", "\u2018", "\u2019", "\u00ab", "\u00bb", "\u2039", "\u203a", "\u2e02", "\uff02", "\uff07", "\u2033", "\u2036", "\u02ba", "\u02dd", "\u02ee", "\u3003", "\u301d", "\u301e", "\u301f", "\u275d", "\u275e"];
    for (const q of quotes) expect(shown(`a${q}b`), q).toBe("a'b");
    // Ordinary names are shown as they are.
    for (const name of ["ROBIN-DESKTOP", "Mara's laptop", "Work laptop", "Büro-PC 2", "Lenovo T14 (home)"]) expect(shown(name)).toBe(name);
    // The cut at 60 characters comes after the replacements.
    expect(shown("@".repeat(30))).toBe(" at ".repeat(30).trim().slice(0, 60) + "…");
    expect([...shown("a@".repeat(30))].length).toBe(61);
  });
});

describe("the mail when the app collects its token", () => {
  it("goes once, after the answer, to the confirming account's current address, in the approved words", async () => {
    const made = await site(TWO);
    const { deps, mail, a, b } = made;
    const sb = await signIn(deps, b.userId);
    const code = await confirmed(made, sb, "Bob's desk");
    // The account's address changed after it confirmed: the mail goes to the address it has now.
    await deps.db.run("UPDATE user SET email = 'bob.new@example.com' WHERE id = ?", [b.userId]);
    const got = await poll(deps, code);
    expect(got.status, got.text).toBe(200);
    expect(got.json).toEqual({ status: "connected", token: expect.any(String), workspace: { id: b.workspaceId, name: "Account" }, account: { username: "bob" }, version: expect.any(String), addresses: { tours: "tours.example.com", app: "app.example.com" } });
    expect(mail.sent).toEqual([{ to: "bob.new@example.com", subject: SUBJECT, text: withLink("Bob's desk", WHEN, APP) }]);
    // Nobody else hears of it, and asking again sends nothing more.
    made.tick(POLL_GAP_MS);
    expect((await poll(deps, code)).status).toBe(410);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent.some((m) => m.to === a.email)).toBe(false);
    expect(await notSent(deps)).toEqual([]);
  });

  it("on one address the link uses SITE_HOST, and with no address for links the mail says where to go in words", async () => {
    const one = await site({ siteHost: "demo.example.com" });
    const s1 = await signIn(one.deps, one.a.userId);
    expect((await poll(one.deps, await confirmed(one, s1))).json.status).toBe("connected");
    expect(one.mail.sent).toEqual([{ to: one.a.email, subject: SUBJECT, text: withLink("Work laptop", WHEN, "https://demo.example.com") }]);

    const bare = await site();
    const s2 = await signIn(bare.deps, bare.a.userId);
    expect((await poll(bare.deps, await confirmed(bare, s2))).json.status).toBe("connected");
    expect(bare.mail.sent).toEqual([{ to: bare.a.email, subject: SUBJECT, text: withoutLink("Work laptop", WHEN) }]);
  });

  it("is not sent for a collection that fails, nor by the collection that loses a race", async () => {
    const made = await site();
    const { deps, mail, a, tick } = made;
    // Pending, expired and refused: no token, no mail.
    const s = await signIn(deps, a.userId);
    const pending = await start(deps, "pending");
    expect((await poll(deps, pending.json.device_code)).json.status).toBe("pending");
    const old = await confirmed(made, s, "old");
    tick(600_000);
    expect((await poll(deps, old)).status).toBe(410);
    // The confirming session ended: no token, no mail.
    const ended = await confirmed(made, s, "ended");
    await deps.db.run("UPDATE session SET revoked_at = ? WHERE id = ?", [deps.now(), s.sessionId]);
    expect((await poll(deps, ended)).status).toBe(410);
    expect(mail.sent).toEqual([]);

    // Two collections at once: one token, one mail.
    const s2 = await signIn(deps, a.userId);
    const both = await confirmed(made, s2, "both");
    const answers = await Promise.all([poll(deps, both), poll(deps, both)]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(mail.sent.map((m) => m.text.split('"')[1])).toEqual(["both"]);

    // The loser read the request before the winner collected: its batch makes nothing, and it sends nothing.
    const raced = await confirmed(made, s2, "raced");
    const realBatch = deps.db.batch.bind(deps.db);
    let winner: Call | null = null;
    deps.db.batch = async (stmts) => {
      if (winner === null && stmts.some((x) => x.sql.includes("INSERT INTO api_token"))) {
        deps.db.batch = realBatch;
        winner = await poll(deps, raced);
      }
      return realBatch(stmts);
    };
    const loser = await poll(deps, raced);
    deps.db.batch = realBatch;
    expect([(winner as Call | null)?.status, loser.status]).toEqual([200, 410]);
    expect(mail.sent.map((m) => m.text.split('"')[1])).toEqual(["both", "raced"]);
    expect(await notSent(deps)).toEqual([]);
  });
});

describe("the collection is the same whatever the mail does", () => {
  /** One collection on a fresh site, with `prepare` run on it first; answers the site and the answer. */
  async function collectOn(prepare: (made: Awaited<ReturnType<typeof site>>) => Promise<void> | void, opts: { mail?: boolean } = {}) {
    const made = await site(TWO, opts);
    const s = await signIn(made.deps, made.a.userId);
    const code = await confirmed(made, s);
    await prepare(made);
    const kinds = recordKinds(made.deps);
    const got = await poll(made.deps, code);
    await made.settle();
    return { made, got, kinds };
  }

  it("with mail off: the same answer, no mail, no record, and the same database calls as before this mail existed", async () => {
    const on = await collectOn(() => {});
    const off = await collectOn(() => {}, { mail: false });
    expect(seen(off.got)).toEqual(seen(on.got));
    expect(off.made.mail.sent).toEqual([]);
    // Exactly the calls of the collection itself: the one read and the one batch, and nothing deferred.
    expect(off.kinds).toEqual(["first", "batch 3"]);
    expect(off.got.calls).toBe(2);
    expect(await notSent(off.made.deps)).toEqual([]);
    // With a mailer: the read of the address, the two counts and the mail, within the budget.
    expect(on.kinds).toEqual(["first", "batch 3", "first", "first", "first"]);
    expect(on.got.calls).toBe(6);
  });

  it("with no mailer the helper defers nothing and calls nothing", async () => {
    const { deps } = await makeDeps({}, { mail: false });
    let deferred = 0;
    let calls = 0;
    const counting: Db = {
      all: () => (calls++, Promise.resolve([])),
      first: () => (calls++, Promise.resolve(null)),
      run: () => (calls++, Promise.resolve({ changes: 0 })),
      batch: () => (calls++, Promise.resolve()),
    };
    mailConnection({ ...deps, db: counting, defer: () => void deferred++ }, { requestId: "crq_" + "0".repeat(24), userId: "usr_" + "0".repeat(24), workspaceId: "ws_" + "0".repeat(24), tokenId: "tok_" + "0".repeat(24) });
    expect([deferred, calls]).toEqual([0, 0]);
  });

  it("a mailer that refuses, throws at once or rejects with its own reason: the same answer, one record without the address, no second try", async () => {
    const usual = await collectOn(() => {});
    const failures: [string, () => Promise<void>, string][] = [
      ["refuses", () => Promise.reject(new Error("could not deliver to account@example.com")), "failed"],
      ["throws at once", () => { throw new Error("boom"); }, "failed"],
      ["times out", () => Promise.reject(Object.assign(new Error("smtp: timeout"), { reason: "timeout" })), "timeout"],
      ["gives a reason of its own", () => Promise.reject(Object.assign(new Error("x"), { reason: "made up account@example.com" })), "failed"],
    ];
    for (const [what, fail, reason] of failures) {
      let tries = 0;
      const { made, got } = await collectOn(({ deps }) => {
        deps.mail = { send: () => (tries++, fail()) };
      });
      expect(seen(got), what).toEqual(seen(usual.got));
      expect(tries, what).toBe(1);
      const rows = await notSent(made.deps);
      const tokenId = (await made.deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE kind = 'sign_in'"))!.id;
      const requestId = (await made.deps.db.first<{ id: string }>("SELECT id FROM connect_request"))!.id;
      expect(rows, what).toEqual([{ user_id: made.a.userId, workspace_id: made.a.workspaceId, subject: tokenId, detail: JSON.stringify({ request: requestId, reason }) }]);
      const audit = JSON.stringify(await made.deps.db.all("SELECT * FROM audit"));
      expect(audit, what).not.toContain("@");
      expect(audit, what).not.toContain("Work laptop");
    }
  });

  it("a mailer that never answers delays nothing: the answer is out while the mail still waits", async () => {
    let release: (() => void) | null = null;
    const made = await site(TWO);
    const s = await signIn(made.deps, made.a.userId);
    const code = await confirmed(made, s);
    made.deps.mail = { send: () => new Promise<void>((resolve) => (release = resolve)) };
    const got = await poll(made.deps, code, { settle: false });
    expect([got.status, got.json.status]).toEqual([200, "connected"]);
    // The token works at once, while the mail is still on its way.
    expect((await send(made.deps, "GET", "/api/v1/me", { token: got.json.token, origin: "https://tours.example.com" })).status).toBe(200);
    for (let i = 0; i < 200 && release === null; i++) await new Promise((r) => setTimeout(r, 5));
    expect(release).not.toBeNull();
    (release as unknown as () => void)();
    await made.settle();
    expect(await notSent(made.deps)).toEqual([]);
  });

  it("over its own caps (5 a day per account, 30 an hour for the site): skipped and recorded, the collection unchanged", async () => {
    expect(LIMITS_CONNECT_MAIL.mailAccountDay).toEqual({ bucket: "connect_mail_account_day", windowMs: 86_400_000, most: 5 });
    expect(LIMITS_CONNECT_MAIL.mailSite).toEqual({ bucket: "connect_mail_site", windowMs: 3_600_000, most: 30 });
    // Buckets of their own, apart from sign-in's and email change's.
    const buckets = [LIMITS_CONNECT_MAIL.mailAccountDay.bucket, LIMITS_CONNECT_MAIL.mailSite.bucket];
    for (const other of [LIMITS_SIGNIN.mailSite.bucket, LIMITS_EMAIL_CHANGE.mailSite.bucket]) expect(buckets).not.toContain(other);

    const made = await site();
    const { deps, mail, a } = made;
    const s = await signIn(deps, a.userId);
    for (let i = 0; i < 6; i++) {
      const got = await poll(deps, await confirmed(made, s, `computer ${i}`));
      expect([got.status, got.json.status], `collection ${i}`).toEqual([200, "connected"]);
    }
    expect(mail.sent.map((m) => m.text.split('"')[1])).toEqual(["computer 0", "computer 1", "computer 2", "computer 3", "computer 4"]);
    expect((await notSent(deps)).map((r) => JSON.parse(r.detail).reason)).toEqual(["limit_account"]);

    // The site's hour is full: another account's notice is skipped too.
    await deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, 30) ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = 30", [LIMITS_CONNECT_MAIL.mailSite.bucket, SITE_KEY, NOW - (NOW % 3_600_000)]);
    const sb = await signIn(deps, made.b.userId);
    const got = await poll(deps, await confirmed(made, sb, "bob's"));
    expect(got.json.status).toBe("connected");
    expect(mail.sent).toHaveLength(5);
    expect((await notSent(deps)).map((r) => [r.user_id, JSON.parse(r.detail).reason])).toEqual([[a.userId, "limit_account"], [made.b.userId, "limit_site"]]);
    // An account over its own day did not count against the site's hour.
    expect(await deps.db.first("SELECT count FROM rate_counter WHERE bucket = ? AND key = ?", [LIMITS_CONNECT_MAIL.mailAccountDay.bucket, await accountKey(a.userId)])).toEqual({ count: 6 });
  });

  it("sign-in's cap being full stops none of these notices", async () => {
    const made = await site();
    await made.deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, 1000)", [LIMITS_SIGNIN.mailSite.bucket, SITE_KEY, NOW - (NOW % 3_600_000)]);
    await made.deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, 1000)", [LIMITS_EMAIL_CHANGE.mailSite.bucket, SITE_KEY, NOW - (NOW % 3_600_000)]);
    const s = await signIn(made.deps, made.a.userId);
    expect((await poll(made.deps, await confirmed(made, s))).json.status).toBe("connected");
    expect(made.mail.sent).toHaveLength(1);
  });

  it("an address that cannot be used: no mail, one record, the collection unchanged", async () => {
    const usual = await collectOn(() => {});
    const { made, got } = await collectOn(async ({ deps, a }) => {
      await deps.db.run("UPDATE user SET email = 'not-an-address' WHERE id = ?", [a.userId]);
    });
    expect(seen(got)).toEqual(seen(usual.got));
    expect(made.mail.sent).toEqual([]);
    expect((await notSent(made.deps)).map((r) => JSON.parse(r.detail).reason)).toEqual(["no_address"]);
  });

  it("a record that cannot be written is one fixed line, and the collection is unchanged", async () => {
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      const { made, got } = await collectOn(({ deps }) => {
        deps.mail = { send: () => Promise.reject(new Error("down")) };
        const realBatch = deps.db.batch.bind(deps.db);
        deps.db.batch = (stmts) => (stmts.some((x) => x.sql.includes("INSERT INTO audit") && x.params?.includes("connection_mail_not_sent")) ? Promise.reject(new Error("disk full")) : realBatch(stmts));
      });
      expect(got.json.status).toBe("connected");
      expect(await notSent(made.deps)).toEqual([]);
    } finally {
      console.error = realError;
    }
    expect(lines).toEqual([CONNECTED_MAIL_LINES.notRecorded]);
  });

  it("the record's event is in the list the audit writer takes", () => {
    expect(AUDIT_EVENTS).toContain("connection_mail_not_sent");
  });
});

describe("the call budget", () => {
  it("the collection with its mail stays within the budget, the worst case (a failed mail and its record) included", async () => {
    const made = await site();
    const s = await signIn(made.deps, made.a.userId);
    const ok = await poll(made.deps, await confirmed(made, s, "one"));
    const mailer: Mailer = { send: () => Promise.reject(new Error("down")) };
    made.deps.mail = mailer;
    const failed = await poll(made.deps, await confirmed(made, s, "two"));
    // The collection's read and batch, then the address, the two counts and the mail; a failed mail adds its record.
    expect([ok.calls, failed.calls]).toEqual([6, 7]);
  });
});
