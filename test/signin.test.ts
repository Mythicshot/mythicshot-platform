// The sign-in and session API (src/signin.ts): asking for a link, completing a sign-in,
// the session, the list of sessions, revoking one, and the two sign-outs. Runs on both
// targets. No mail is sent: every mailer here is the fake one, or one made in the test.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount, type MakeOptions } from "#harness";
import { createApp } from "../src/app.ts";
import { setClientAddress } from "../src/client.ts";
import type { Config, Db, Deps } from "../src/ports.ts";
import { LIMITS_SIGNIN, SITE_KEY, SITE_QUIET_KEY, recipientKey } from "../src/rate.ts";
import { SESSION_COOKIE, SIGNIN_CODE_MS, clearedCookie, createSignInCode, csrfFor, redeemSignInCode, sessionCookie } from "../src/sessions.ts";
import { PAD_BUCKET, PAD_KEY, SIGNIN_LINES, signinRoutes } from "../src/signin.ts";
import { send, type Call, type SendOptions } from "./bundle.ts";

const NOW = 1_800_000_000_000;
const APP = "https://app.example.com";
const TOURS = "https://tours.example.com";
const UNKNOWN = "https://evil.example.net";
const TWO: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com" } };
/** What Firefox on Linux, and Chrome on Windows, send as their User-Agent. */
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const STRANGER = "nobody-here@example.com";

const OK = '{"ok":true}';
const UNAUTHORIZED = '{"error":"unauthorized"}';
const NOT_FOUND = '{"error":"not_found"}';
const MIXED = '{"error":"mixed_credentials","detail":"send a token or a session cookie, not both"}';
const BAD_ORIGIN = '{"error":"bad_origin","detail":"this request must come from the site\'s own pages"}';
const BAD_CSRF = '{"error":"bad_csrf","detail":"the anti-forgery header is missing or wrong"}';
const LINK_INVALID = '{"error":"link_invalid","detail":"this sign-in link has expired or was already used"}';
const NO_SESSION = '{"error":"not_found","detail":"no such session"}';
const NEEDS_EMAIL = '{"error":"bad_request","detail":"the body must be JSON such as {\\"email\\": \\"name@example.com\\"}"}';
const NEEDS_CODE = '{"error":"bad_request","detail":"the body must be JSON such as {\\"code\\": \\"…\\"}"}';
const API_HEADERS = [
  ["cache-control", "no-store"],
  ["content-type", "application/json"],
  ["x-content-type-options", "nosniff"],
];
const CODE = /dpl_[0-9a-f]{40}/;
const SECRET = /dps_[0-9a-f]{64}/;
const HOUR_LINE = "signin: the hourly limit of sign-in mails was reached; none was sent";
const RECIPIENT_LINE = "signin: an address asked for more sign-in links than its limit; none was sent";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A site with a clock the test moves, an admin (so sign-in is open) and two more accounts. */
async function site(config: Partial<Config> = TWO, opts: MakeOptions & { admin?: boolean } = {}) {
  const made = await makeDeps(config, opts);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  const admin = await seedAccount(made.deps, { admin: opts.admin !== false, username: "boss" });
  const a = await seedAccount(made.deps, { username: "alice" });
  const b = await seedAccount(made.deps);
  return { ...made, clock, admin, a, b };
}

type Signed = { secret: string; sessionId: string; userId: string; cookie: string; csrf: string };

/** A session made as the server makes one, without the two requests. */
async function signIn(deps: Deps, userId: string, agent: string = FIREFOX): Promise<Signed> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), agent, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { ...made, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** The headers of a request the site's own page sends with this session; with `change`, the anti-forgery ones too. */
function by(s: Signed, change = false, origin = APP): Record<string, string> {
  return change ? { cookie: s.cookie, origin, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin" } : { cookie: s.cookie };
}

/** A POST of JSON as the site's own page on `origin` sends it. */
function post(deps: Deps, path: string, body: unknown, more: SendOptions = {}): Promise<Call> {
  const origin = more.origin ?? APP;
  return send(deps, "POST", path, {
    ...more,
    origin,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", ...more.headers },
  });
}

const ask = (deps: Deps, email: string, more: SendOptions = {}) => post(deps, "/api/v1/signin/request", { email }, more);
const complete = (deps: Deps, code: string, more: SendOptions = {}) => post(deps, "/api/v1/signin/complete", { code }, { ...more, headers: { "user-agent": FIREFOX, ...more.headers } });

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** The one code in a mail's text. */
function codeIn(text: string): string {
  const found = text.match(/dpl_[0-9a-f]{40}/g) ?? [];
  expect(found, "a mail holds its code once").toHaveLength(1);
  return found[0] ?? "";
}

/**
 * Records the kind of every database call made through `deps.db` from now on; with
 * `statements`, also each call's kind and SQL text (every statement of a batch).
 */
function recordKinds(deps: Deps, statements?: string[]): string[] {
  const kinds: string[] = [];
  const db = deps.db;
  const note = (kind: string, sql: string) => (kinds.push(kind), statements?.push(`${kind} ${sql.replace(/\s+/g, " ").trim()}`));
  const wrapped: Db = {
    all: (sql, params) => (note("all", sql), db.all(sql, params)),
    first: (sql, params) => (note("first", sql), db.first(sql, params)),
    run: (sql, params) => (note("run", sql), db.run(sql, params)),
    batch: (stmts) => (note("batch", stmts.map((x) => x.sql).join("; ")), db.batch(stmts)),
  };
  deps.db = wrapped;
  return kinds;
}

/** What every link request awaits before its answer: the two counts per recipient, the account read, the mail cap, the two sweeps. */
const AWAITED = ["first", "first", "first", "first", "batch", "run"];
/**
 * What the job after the answer does, for every request: one write and then one batch.
 * For an account that gets a link they write its code and the audit row; for any other
 * request they add to the pad counter, so the job costs the same either way.
 */
const JOB = ["run", "batch"];
/** The pad counter's total: two more for every request whose job makes no link. */
const padCount = async (deps: Deps) => (await deps.db.first<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM rate_counter WHERE bucket = ?", [PAD_BUCKET]))!.n;
/** The mark `answered` puts among the recorded calls when the app has handed back its answer. */
const ANSWER = "| answer";

/**
 * The app (with the client address an entry would have set, if one is given) that puts
 * ANSWER into each list the moment the answer is handed back, so the calls before it are
 * the ones the answer waited for.
 */
const answered = (lists: string[][], address?: string) => (deps: Deps) => ({
  fetch: async (req: Request) => {
    if (address !== undefined) setClientAddress(req, address);
    const res = await createApp(deps).fetch(req);
    for (const list of lists) list.push(ANSWER);
    return res;
  },
});

/** Empties the list, and splits what it held at ANSWER: what came before the answer and what came after. */
function split(list: string[]): { before: string[]; after: string[] } {
  const all = list.splice(0);
  const at = all.indexOf(ANSWER);
  expect(at, "the answer was marked").toBeGreaterThanOrEqual(0);
  return { before: all.slice(0, at), after: all.slice(at + 1) };
}

/** The app with the client address an entry would have set for every request. */
const from = (address: string) => (deps: Deps) => ({
  fetch: (req: Request) => {
    setClientAddress(req, address);
    return createApp(deps).fetch(req);
  },
});

const rowsOf = <T>(deps: Deps, sql: string, params: (string | number)[] = []) => deps.db.all<T>(sql, params);
const countOf = async (deps: Deps, table: string) => (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
const counter = async (deps: Deps, bucket: string, key: string) =>
  (await deps.db.first<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM rate_counter WHERE bucket = ? AND key = ?", [bucket, key]))!.n;

/** Every row of every table of the app, as one text. */
async function everythingStored(deps: Deps): Promise<string> {
  const tables = await deps.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT IN ('_migrations', 'd1_migrations')");
  let text = "";
  for (const t of tables) text += JSON.stringify(await deps.db.all(`SELECT * FROM "${t.name}"`));
  return text;
}

describe("asking for a sign-in link", () => {
  it("asking for a link answers the same for an account and for a stranger: status, body, headers and database calls", async () => {
    const { deps, mail, a } = await site();
    const kinds = recordKinds(deps);
    const app = answered([kinds]);

    const known = await ask(deps, a.email, { app });
    const knownCalls = split(kinds);
    expect(await padCount(deps)).toBe(0);
    kinds.length = 0;
    const stranger = await ask(deps, STRANGER, { app });
    const strangerCalls = split(kinds);
    // Each of the stranger's two job calls changed a row: the pad counter moved by two.
    expect(await padCount(deps)).toBe(2);
    kinds.length = 0;

    expect(seen(known)).toEqual({ status: 200, headers: API_HEADERS, body: OK });
    expect(seen(stranger)).toEqual(seen(known));
    expect(known.headers.getSetCookie()).toEqual([]);
    // Before the answer: the same database calls, of the same kinds, in the same order.
    expect(strangerCalls.before).toEqual(knownCalls.before);
    expect(knownCalls.before).toEqual(AWAITED);
    // After it, the same kinds of calls in the same order: the account's code and audit row, the stranger's pad.
    expect(knownCalls.after).toEqual(JOB);
    expect(strangerCalls.after).toEqual(JOB);
    // And they really were two different requests: one mail, to the account.
    expect(mail.sent.map((m) => m.to)).toEqual([a.email]);
    expect(await countOf(deps, "signin_code")).toBe(1);

    // The address as a person types it is the same address. (The count above was recorded too.)
    kinds.length = 0;
    const typed = await ask(deps, `  ${a.email.toUpperCase()} `, { app });
    expect(seen(typed)).toEqual(seen(known));
    expect(split(kinds)).toEqual(knownCalls);
    expect(mail.sent.map((m) => m.to)).toEqual([a.email, a.email]);

    // With a network to count for, each makes the same one call more, first.
    const there = answered([kinds], "203.0.113.7");
    const knownThere = await ask(deps, a.email, { app: there });
    const knownThereCalls = split(kinds);
    const strangerThere = await ask(deps, STRANGER, { app: there });
    expect(split(kinds).before).toEqual(knownThereCalls.before);
    expect(knownThereCalls.before).toEqual(["first", ...AWAITED]);
    expect(seen(strangerThere)).toEqual(seen(knownThere));
    expect(seen(knownThere)).toEqual(seen(known));
    // Nothing was recorded for the address nobody has: the audit holds the three links sent.
    expect(await rowsOf(deps, "SELECT event, user_id FROM audit")).toEqual(Array(3).fill({ event: "signin_link_sent", user_id: a.userId }));
  });

  it("no write that only an account causes runs before the answer is out", async () => {
    const { deps, mail, a } = await site();
    const statements: string[] = [];
    recordKinds(deps, statements);
    // The mail is marked among the statements when it is handed over.
    const sent = mail.send.bind(mail);
    deps.mail = { send: (m) => (statements.push("mail"), sent(m)) };
    const app = answered([statements]);
    const accountOnly = /^(run|batch) INSERT INTO (signin_code|audit)\b|^mail$/;

    await ask(deps, a.email, { app });
    const known = split(statements);
    await ask(deps, STRANGER, { app });
    const stranger = split(statements);

    // Before the answer: no write of a code, an audit row, the pad or a mail, and the very same statements for both.
    expect(known.before.filter((x) => accountOnly.test(x) || x.includes(PAD_BUCKET))).toEqual([]);
    expect(known.before).toEqual(stranger.before);
    // After it: the account's code, its audit row and one mail, in that order; the stranger's two pad writes, of the same kinds.
    expect(known.after.map((x) => x.split(" (")[0])).toEqual(["run INSERT INTO signin_code", "batch INSERT INTO audit", "mail"]);
    expect(stranger.after.map((x) => x.split(" (")[0])).toEqual(["run INSERT INTO rate_counter", "batch INSERT INTO rate_counter"]);
    // Nothing but the mail hand-over tells the two jobs apart by kind.
    expect(known.after.filter((x) => x !== "mail").map((x) => x.split(" ")[0])).toEqual(stranger.after.map((x) => x.split(" ")[0]));
    expect(mail.sent.map((m) => m.to)).toEqual([a.email]);
  });

  it("the pad keeps one row an hour, is swept like any counter, and no limit reads it", async () => {
    const { deps, clock } = await site();
    const hour = 3_600_000;
    clock.now = NOW - (NOW % hour);
    for (let i = 0; i < 5; i++) await ask(deps, `stranger-${i}@example.com`);
    clock.now += hour;
    await ask(deps, STRANGER);
    const rows = await rowsOf<{ key: string; window_start: number; count: number }>(deps, "SELECT key, window_start, count FROM rate_counter WHERE bucket = ? ORDER BY window_start", [PAD_BUCKET]);
    expect(rows).toEqual([
      { key: PAD_KEY, window_start: NOW - (NOW % hour), count: 10 },
      { key: PAD_KEY, window_start: NOW - (NOW % hour) + hour, count: 2 },
    ]);
    // The bucket and key fit the counter's columns, and the bucket is none of the limits'.
    expect(new TextEncoder().encode(PAD_BUCKET).length).toBeLessThanOrEqual(40);
    expect(new TextEncoder().encode(PAD_KEY).length).toBeLessThanOrEqual(100);
    expect(Object.values(LIMITS_SIGNIN).map((limit) => limit.bucket)).not.toContain(PAD_BUCKET);
    // A day and more later the counter sweep that rides on every request removes the old rows.
    clock.now += 2 * 86_400_000;
    await ask(deps, STRANGER);
    const left = await rowsOf<{ window_start: number }>(deps, "SELECT window_start FROM rate_counter WHERE bucket = ?", [PAD_BUCKET]);
    expect(left).toEqual([{ window_start: clock.now - (clock.now % hour) }]);
  });

  it("the job starts only after the answer, also when nothing in it has to wait", async () => {
    const { deps } = await site();
    const kinds = recordKinds(deps);
    // Every digest answers at once, so the job itself never yields on its way to the database:
    // only the wait for the answer keeps its writes after it. (A digest of zeros is enough for
    // one stranger's request: it is a key no limit is near.)
    vi.spyOn(crypto.subtle, "digest").mockImplementation(() => Promise.resolve(new ArrayBuffer(32)));
    await ask(deps, STRANGER, { app: answered([kinds]) });
    expect(split(kinds)).toEqual({ before: AWAITED, after: JOB });
  });

  it("a code or audit row that cannot be written still answers as always, and sends nothing", async () => {
    const { deps, mail, a } = await site();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const reference = seen(await ask(deps, STRANGER));
    const db = deps.db;
    for (const [what, table] of [["the code", "signin_code"], ["the audit row", "audit"]] as const) {
      const failing: Db = {
        ...db,
        all: (sql, params) => db.all(sql, params),
        first: (sql, params) => db.first(sql, params),
        run: (sql, params) => (sql.includes(`INSERT INTO ${table}`) ? Promise.reject(new Error(`disk full ${a.email}`)) : db.run(sql, params)),
        batch: (stmts) => (stmts.some((x) => x.sql.includes(`INSERT INTO ${table}`)) ? Promise.reject(new Error(`disk full ${a.email}`)) : db.batch(stmts)),
      };
      deps.db = failing;
      errors.mockClear();
      const r = await ask(deps, a.email);
      deps.db = db;
      // Not a 500 that only a real account could get: the answer every address gets.
      expect(seen(r), what).toEqual(reference);
      expect(mail.sent, what).toEqual([]);
      expect(errors.mock.calls, what).toEqual([[SIGNIN_LINES.notMade]]);
    }
    // Nothing was recorded, and the line holds neither the address nor the failure's words.
    expect(await countOf(deps, "audit")).toBe(0);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(a.email);
  });

  it("the answer does not wait for the mail", async () => {
    const { deps, settle, a } = await site();
    let handed = 0;
    let release = (): void => {};
    deps.mail = {
      send: () =>
        new Promise<void>((resolve) => {
          handed += 1;
          release = resolve;
        }),
    };
    // The mail server never answers while the request is looked at; the answer is there all the same.
    const r = await ask(deps, a.email, { settle: false });
    expect(seen(r)).toEqual({ status: 200, headers: API_HEADERS, body: OK });
    // The answer came before the mail was even handed over; the job hands it over after.
    expect(handed).toBe(0);
    await vi.waitFor(() => expect(handed).toBe(1));
    release();
    await settle();

    // A mail server that refuses changes nothing of the answer either, is one fixed line, and is not tried again.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let tries = 0;
    deps.mail = {
      send: () => {
        tries += 1;
        return Promise.reject(Object.assign(new Error(`smtp: 550 no such user ${a.email}`), { reason: "refused", bodyWritten: true }));
      },
    };
    const refused = await ask(deps, a.email);
    await settle();
    expect(seen(refused)).toEqual(seen(r));
    expect(tries).toBe(1);
    expect(errors.mock.calls).toEqual([["mail: a sign-in mail could not be sent (refused)"]]);
    // A failure that names no reason of the mail client's own is not repeated in the line.
    errors.mockClear();
    deps.mail = { send: () => Promise.reject(Object.assign(new Error("boom " + a.email), { reason: "see " + a.email })) };
    await ask(deps, a.email);
    await settle();
    expect(errors.mock.calls).toEqual([["mail: a sign-in mail could not be sent (failed)"]]);
  });

  it("an account gets one mail with a link on the configured app address", async () => {
    const { deps, mail, a } = await site();
    await ask(deps, a.email);
    expect(mail.sent).toHaveLength(1);
    const sent = mail.sent[0];
    expect(sent.to).toBe(a.email);
    const lines = sent.text.split("\n");
    const links = lines.filter((line) => line.includes("://"));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^https:\/\/app\.example\.com\/signin\/link#c=dpl_[0-9a-f]{40}$/);
    expect(sent.subject + sent.text).not.toContain(a.userId);
    // The code is stored only as a digest, lasts 15 minutes, and the link signs in.
    const code = codeIn(sent.text);
    const stored = await rowsOf<{ user_id: string; hash: string; created_at: number; expires_at: number; used_at: number | null }>(deps, "SELECT user_id, hash, created_at, expires_at, used_at FROM signin_code");
    expect(stored).toEqual([{ user_id: a.userId, hash: expect.stringMatching(/^[0-9a-f]{64}$/), created_at: NOW, expires_at: NOW + SIGNIN_CODE_MS, used_at: null }]);
    expect(stored[0].hash).not.toContain(code.slice(4));
    expect(await rowsOf(deps, "SELECT event, user_id, workspace_id, subject, detail FROM audit")).toEqual([{ event: "signin_link_sent", user_id: a.userId, workspace_id: a.workspaceId, subject: null, detail: null }]);
    expect((await complete(deps, code)).status).toBe(200);

    // On a site with one address the link starts with SITE_HOST.
    const one = await site({ siteHost: "site.example.com" });
    await ask(one.deps, one.a.email, { origin: "https://site.example.com" });
    expect(one.mail.sent).toHaveLength(1);
    expect(one.mail.sent[0].text.split("\n").filter((line) => line.includes("://"))[0]).toMatch(/^https:\/\/site\.example\.com\/signin\/link#c=dpl_[0-9a-f]{40}$/);
  });

  it("a forged Host or forwarded header never reaches the link", async () => {
    const forged = {
      host: "evil.example.net",
      "x-forwarded-host": "evil.example.net",
      "x-forwarded-proto": "http",
      "x-forwarded-for": "198.51.100.9",
      forwarded: "host=evil.example.net;proto=http",
      "x-original-host": "evil.example.net",
      referer: "https://evil.example.net/signin",
    };
    const two = await site();
    expect((await ask(two.deps, two.a.email, { headers: forged })).status).toBe(200);
    expect(two.mail.sent).toHaveLength(1);
    expect(two.mail.sent[0].text).toContain("\nhttps://app.example.com/signin/link#c=dpl_");
    expect(two.mail.sent[0].subject + two.mail.sent[0].text).not.toContain("evil");

    // One address: whatever name the request came to, the link has the configured one.
    const one = await site({ siteHost: "site.example.com" });
    expect((await ask(one.deps, one.a.email, { origin: UNKNOWN, headers: forged })).status).toBe(200);
    expect(one.mail.sent).toHaveLength(1);
    expect(one.mail.sent[0].text).toContain("\nhttps://site.example.com/signin/link#c=dpl_");
    expect(one.mail.sent[0].subject + one.mail.sent[0].text).not.toContain("evil");
  });

  it("no admin, no link host, a disabled account, or mail off: the same answer and no mail", async () => {
    const reference = await site();
    const kinds = recordKinds(reference.deps);
    const sent = seen(await ask(reference.deps, reference.a.email, { app: answered([kinds]) }));
    const sentCalls = split(kinds);
    expect(sentCalls.after).toEqual(JOB);
    expect(reference.mail.sent).toHaveLength(1);

    // Each site is made only when its turn comes: on Workers every site is the one test database, emptied anew.
    const cases: [string, () => Promise<Awaited<ReturnType<typeof site>>>][] = [
      ["no admin yet", () => site(TWO, { admin: false })],
      ["no link host", () => site({})],
      ["mail off", () => site(TWO, { mail: false })],
      [
        "a disabled account",
        async () => {
          const s = await site();
          await s.deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [s.a.userId]);
          return s;
        },
      ],
      [
        "an account without the sign-in method",
        async () => {
          const s = await site();
          await s.deps.db.run("DELETE FROM signin_method WHERE user_id = ?", [s.a.userId]);
          return s;
        },
      ],
    ];

    for (const [what, make] of cases) {
      const s = await make();
      const seenKinds = recordKinds(s.deps);
      // On a site with one address the request goes to whatever name it has.
      const r = await ask(s.deps, s.a.email, { app: answered([seenKinds]) });
      expect(seen(r), what).toEqual(sent);
      // The same calls before the answer, and the same kinds after it, each of which changed a row of the pad.
      expect(split(seenKinds), what).toEqual(sentCalls);
      expect(await padCount(s.deps), what).toBe(2);
      expect(s.mail.sent, what).toEqual([]);
      expect(await countOf(s.deps, "signin_code"), what).toBe(0);
      expect(await countOf(s.deps, "audit"), what).toBe(0);
      // Nothing of the mail cap was spent.
      expect(await counter(s.deps, LIMITS_SIGNIN.mailSite.bucket, SITE_KEY), what).toBe(0);
      expect(await counter(s.deps, LIMITS_SIGNIN.mailSite.bucket, SITE_QUIET_KEY), what).toBe(1);
    }
  });

  it("the fourth request for one address in 15 minutes sends nothing and answers as always", async () => {
    const { deps, mail, clock, a, b } = await site();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The clock starts at the beginning of a quarter hour and of a day's window.
    clock.now = NOW - (NOW % 86_400_000) + 86_400_000;
    const first = seen(await ask(deps, a.email));
    for (let i = 0; i < 2; i++) expect(seen(await ask(deps, a.email))).toEqual(first);
    expect(mail.sent).toHaveLength(3);
    expect(errors).not.toHaveBeenCalled();
    const kinds = recordKinds(deps);
    expect(seen(await ask(deps, a.email))).toEqual(first);
    expect(seen(await ask(deps, a.email.toUpperCase()))).toEqual(first);
    expect(mail.sent).toHaveLength(3);
    // The calls every request waits for, and the job's two, which add to the pad: no code, no audit row.
    expect(kinds).toEqual([...AWAITED, ...JOB, ...AWAITED, ...JOB]);
    expect(await padCount(deps)).toBe(4);
    expect(await countOf(deps, "signin_code")).toBe(3);
    // Each one held back is one fixed line, which names no address.
    expect(errors.mock.calls).toEqual([[RECIPIENT_LINE], [RECIPIENT_LINE]]);
    // Another address is not held back by it, and a stranger asked four times is answered the same.
    expect(seen(await ask(deps, b.email))).toEqual(first);
    expect(mail.sent.map((m) => m.to)).toEqual([a.email, a.email, a.email, b.email]);
    errors.mockClear();
    for (let i = 0; i < 4; i++) expect(seen(await ask(deps, STRANGER))).toEqual(first);
    expect(mail.sent).toHaveLength(4);
    // A stranger's address is counted like an account's: four requests, and the fourth over the limit.
    expect(await counter(deps, LIMITS_SIGNIN.linkRecipient.bucket, await recipientKey(STRANGER))).toBe(4);
    expect(await counter(deps, LIMITS_SIGNIN.linkRecipientDay.bucket, await recipientKey(STRANGER))).toBe(4);
    expect(errors.mock.calls).toEqual([[RECIPIENT_LINE]]);
    // Nothing of the mail cap was spent by the requests that sent nothing.
    expect(await counter(deps, LIMITS_SIGNIN.mailSite.bucket, SITE_KEY)).toBe(4);

    // The next quarter hour it sends again, until ten were asked for in the day.
    // The day's limit counts every request, also the ones the quarter hour held back: five so far.
    for (const [quarter, asked, total] of [[1, 3, 6], [2, 3, 8], [3, 2, 8]]) {
      clock.now = NOW - (NOW % 86_400_000) + 86_400_000 + quarter * 900_000;
      for (let i = 0; i < asked; i++) expect(seen(await ask(deps, a.email))).toEqual(first);
      expect(mail.sent.filter((m) => m.to === a.email), `quarter ${quarter}`).toHaveLength(total);
    }
    // And the next day it sends again.
    clock.now += 86_400_000;
    await ask(deps, a.email);
    expect(mail.sent.filter((m) => m.to === a.email)).toHaveLength(9);
  });

  it("the eleventh from one network is 429", async () => {
    const { deps, mail, calls, a } = await site();
    const app = from("203.0.113.7");
    for (let i = 0; i < 10; i++) expect((await ask(deps, `person-${i}@example.com`, { app })).status, String(i)).toBe(200);
    const kinds = recordKinds(deps);
    const before = calls();
    const eleventh = await ask(deps, a.email, { app });
    const retry = String(Math.ceil((900_000 - (NOW % 900_000)) / 1000));
    expect(seen(eleventh)).toEqual({ status: 429, headers: [...API_HEADERS, ["retry-after", retry]].sort(), body: '{"error":"rate_limited"}' });
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
    expect(Number(retry)).toBeLessThanOrEqual(900);
    // One call, the count itself; nothing was looked up and nothing sent.
    expect(calls() - before).toBe(1);
    expect(kinds).toEqual(["first"]);
    expect(mail.sent).toEqual([]);
    // A stranger's address gets the same answer there.
    expect(seen(await ask(deps, STRANGER, { app }))).toEqual(seen(eleventh));
    // The same network written another way, and another address of the same IPv6 /64, are the same network.
    expect((await ask(deps, a.email, { app: from("::ffff:203.0.113.7") })).status).toBe(429);
    for (let i = 0; i < 10; i++) expect((await ask(deps, `other-${i}@example.com`, { app: from(`2001:db8:1:2::${i + 1}`) })).status).toBe(200);
    expect((await ask(deps, a.email, { app: from("2001:db8:1:2:ffff::1") })).status).toBe(429);
    // Another network is not held back by it, and neither is a caller whose network is unknown or private.
    expect((await ask(deps, a.email, { app: from("203.0.113.8") })).status).toBe(200);
    for (let i = 0; i < 12; i++) expect((await ask(deps, `inside-${i}@example.com`, { app: from("10.0.0.5") })).status).toBe(200);
    for (let i = 0; i < 12; i++) expect((await ask(deps, `unknown-${i}@example.com`)).status).toBe(200);
    expect(mail.sent.map((m) => m.to)).toEqual([a.email]);
  });

  it("past the hourly cap nothing is sent", async () => {
    const { deps, mail, clock, a, b } = await site();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const hour = LIMITS_SIGNIN.mailSite.windowMs;
    const sentSoFar = (n: number) => deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, ?) ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = excluded.count", [LIMITS_SIGNIN.mailSite.bucket, SITE_KEY, clock.now - (clock.now % hour), n]);

    // 99 mails were sent this hour. Requests that send nothing spend nothing of the cap.
    await sentSoFar(LIMITS_SIGNIN.mailSite.most - 1);
    for (let i = 0; i < 5; i++) await ask(deps, `stranger-${i}@example.com`);
    expect(await counter(deps, LIMITS_SIGNIN.mailSite.bucket, SITE_KEY)).toBe(99);
    expect(await counter(deps, LIMITS_SIGNIN.mailSite.bucket, SITE_QUIET_KEY)).toBe(5);
    // So the hundredth is still sent, and the next one is not.
    const hundredth = await ask(deps, a.email);
    expect(mail.sent.map((m) => m.to)).toEqual([a.email]);
    expect(errors).not.toHaveBeenCalled();
    const kinds = recordKinds(deps);
    const over = await ask(deps, b.email);
    expect(seen(over)).toEqual(seen(hundredth));
    expect(kinds).toEqual([...AWAITED, ...JOB]);
    // The job wrote all the same: both its calls changed the pad's row.
    expect(await padCount(deps)).toBe(12);
    expect(mail.sent).toHaveLength(1);
    expect(errors.mock.calls).toEqual([[HOUR_LINE]]);
    // No code was made for a mail that was not sent, and nothing recorded.
    expect(await rowsOf(deps, "SELECT user_id FROM signin_code")).toEqual([{ user_id: a.userId }]);
    expect(await rowsOf(deps, "SELECT event, user_id FROM audit")).toEqual([{ event: "signin_link_sent", user_id: a.userId }]);
    // A stranger asking past the cap is not a line in the log: nothing was held back.
    errors.mockClear();
    expect(seen(await ask(deps, STRANGER))).toEqual(seen(hundredth));
    expect(errors).not.toHaveBeenCalled();
    // The next hour mails go out again.
    clock.now += hour;
    await ask(deps, b.email);
    expect(mail.sent.map((m) => m.to)).toEqual([a.email, b.email]);
  });

  it("a request from another origin, or without JSON, is refused before anything is counted", async () => {
    const { deps, mail, calls, a } = await site();
    const before = calls();
    const body = JSON.stringify({ email: a.email });
    const json = { "content-type": "application/json" };
    const refused = (text: string, status = 403) => ({ status, headers: API_HEADERS, body: text });

    for (const path of ["/api/v1/signin/request", "/api/v1/signin/complete"]) {
      const needs = path.endsWith("request") ? NEEDS_EMAIL : NEEDS_CODE;
      const sendTo = (headers: Record<string, string>, text: string = body) => send(deps, "POST", path, { origin: APP, body: text, headers });
      // Not from a page of this address: no Origin, the sibling address, another site, a sandboxed page, a page loaded without https.
      const origins: Record<string, string>[] = [
        {},
        { origin: TOURS },
        { origin: UNKNOWN },
        { origin: "null" },
        { origin: "http://app.example.com" },
        { origin: "https://app.example.com:8443" },
        { origin: APP, "sec-fetch-site": "same-site" },
        { origin: APP, "sec-fetch-site": "cross-site" },
        { origin: APP, "sec-fetch-site": "none" },
        { referer: APP + "/signin" },
      ];
      for (const headers of origins) expect(seen(await sendTo({ ...json, ...headers })), `${path} ${JSON.stringify(headers)}`).toEqual(refused(BAD_ORIGIN));
      // From this address, but not JSON: what a form on any page can send.
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "text/json", ""]) {
        const headers: Record<string, string> = type === "" ? { origin: APP } : { origin: APP, "content-type": type };
        expect(seen(await sendTo(headers)), `${path} ${type}`).toEqual(refused(needs, 400));
      }
      // JSON by its label, and not an object with the field.
      for (const text of ["", "{", "[]", "null", '"text"', "5", " ".repeat(5000), JSON.stringify({ email: "x".repeat(5000) })]) {
        expect(seen(await sendTo({ ...json, origin: APP }, text)), `${path} ${text.slice(0, 20)}`).toEqual(refused(needs, 400));
      }
      // JSON with a parameter on its label is JSON.
      expect((await sendTo({ origin: APP, "content-type": "application/json; charset=utf-8" }, "{}")).status).toBe(400);
    }
    // An object without an address, or with something that is none.
    for (const email of [undefined, null, 5, "", "nobody", "a@b", "two@@example.com", "line\nbreak@example.com", "a b@example.com", ["a@example.com"]]) {
      expect(seen(await post(deps, "/api/v1/signin/request", { email })), String(email)).toEqual(refused('{"error":"bad_email"}', 400));
    }
    // An object without a code, or with something that is none.
    for (const code of [undefined, null, 5, "", "dpl_", "dpl_" + "0".repeat(39), "dpl_" + "0".repeat(41), "DPL_" + "0".repeat(40), "dpl_" + "G".repeat(40), " dpl_" + "0".repeat(40), "dps_" + "0".repeat(64)]) {
      expect(seen(await post(deps, "/api/v1/signin/complete", { code })), String(code)).toEqual(refused('{"error":"bad_code"}', 400));
    }
    // None of it reached the database or the mailer.
    expect(calls()).toBe(before);
    expect(mail.sent).toEqual([]);
    expect(await countOf(deps, "rate_counter")).toBe(0);
  });
});

describe("completing a sign-in", () => {
  it("completing with the mailed code sets the cookie and answers ok", async () => {
    const { deps, mail, a } = await site();
    await ask(deps, a.email);
    const code = codeIn(mail.sent[0].text);
    const r = await complete(deps, code);
    expect([r.status, r.text]).toEqual([200, OK]);
    const cookies = r.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-dp_session=dps_[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000$/);
    const secret = cookies[0].match(SECRET)![0];
    expect(cookies[0]).toBe(sessionCookie(secret));
    expect([...r.headers.entries()].filter(([name]) => name !== "set-cookie").sort()).toEqual(API_HEADERS);
    // The answer repeats neither the code nor the secret, and the cookie is the session.
    expect(r.text).not.toMatch(/dp[ls]_/);
    const session = await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}` } });
    expect(session.status).toBe(200);
    expect(session.json.account.id).toBe(a.userId);
    expect(await rowsOf(deps, "SELECT user_id, label, created_at, revoked_at FROM session")).toEqual([{ user_id: a.userId, label: "Firefox on Linux", created_at: NOW, revoked_at: null }]);
    expect((await rowsOf<{ event: string }>(deps, "SELECT event, user_id, subject FROM audit")).sort((x, y) => (x.event < y.event ? -1 : 1))).toEqual([
      { event: "signin", user_id: a.userId, subject: session.json.session.id },
      { event: "signin_link_sent", user_id: a.userId, subject: null },
    ]);

    // Signing in again in the same browser ends the session it had.
    await ask(deps, a.email);
    const again = await complete(deps, codeIn(mail.sent[1].text), { headers: { cookie: `${SESSION_COOKIE}=${secret}`, "user-agent": CHROME } });
    expect(again.status).toBe(200);
    const next = again.headers.getSetCookie()[0].match(SECRET)![0];
    expect(next).not.toBe(secret);
    expect((await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}` } })).status).toBe(401);
    expect((await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${next}` } })).status).toBe(200);
    expect(await rowsOf(deps, "SELECT label FROM session WHERE revoked_at IS NULL")).toEqual([{ label: "Chrome on Windows" }]);
    // An Authorization header is not looked at here: there is no session to mix it with.
    await ask(deps, a.email);
    expect((await complete(deps, codeIn(mail.sent[2].text), { token: a.token })).status).toBe(200);
  });

  it("a wrong, used or expired code gets the one answer and no cookie", async () => {
    const { deps, clock, a, b } = await site();
    const refusal = { status: 403, headers: API_HEADERS, body: LINK_INVALID };

    // A code nobody was given.
    expect(seen(await complete(deps, "dpl_" + "0".repeat(40)))).toEqual(refusal);
    // Pressed twice.
    const twice = await createSignInCode(deps, a.userId);
    expect((await complete(deps, twice)).status).toBe(200);
    expect(seen(await complete(deps, twice))).toEqual(refusal);
    // Pressed on two devices at once: one of them is signed in.
    const both = await createSignInCode(deps, a.userId);
    const presses = await Promise.all([complete(deps, both), complete(deps, both, { headers: { "user-agent": CHROME } })]);
    expect(presses.map((p) => p.status).sort()).toEqual([200, 403]);
    expect(seen(presses.find((p) => p.status === 403)!)).toEqual(refusal);
    expect(presses.filter((p) => p.headers.getSetCookie().length > 0)).toHaveLength(1);
    // Pressed after 15 minutes; one second earlier it still worked.
    const late = await createSignInCode(deps, a.userId);
    const inTime = await createSignInCode(deps, a.userId);
    clock.now += SIGNIN_CODE_MS - 1000;
    expect((await complete(deps, inTime)).status).toBe(200);
    clock.now += 1000;
    expect(seen(await complete(deps, late))).toEqual(refusal);
    // Pressed after the account was disabled.
    const disabled = await createSignInCode(deps, b.userId);
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [b.userId]);
    expect(seen(await complete(deps, disabled))).toEqual(refusal);
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [b.userId]);
    expect(seen(await complete(deps, disabled))).toEqual(refusal);
    // Three sessions were made in all, none for the second account.
    expect(await rowsOf(deps, "SELECT DISTINCT user_id FROM session")).toEqual([{ user_id: a.userId }]);
    expect(await countOf(deps, "session")).toBe(3);

    // The twenty-first try from one network in a quarter hour is told to wait, whatever the code.
    const app = from("203.0.113.7");
    for (let i = 0; i < 20; i++) expect(seen(await complete(deps, "dpl_" + String(i).padStart(40, "0"), { app })), String(i)).toEqual(refusal);
    const good = await createSignInCode(deps, a.userId);
    const held = await complete(deps, good, { app });
    const retry = String(Math.ceil((900_000 - (clock.now % 900_000)) / 1000));
    expect(seen(held)).toEqual({ status: 429, headers: [...API_HEADERS, ["retry-after", retry]].sort(), body: '{"error":"rate_limited"}' });
    // The code was not spent by the try that was not looked at: from elsewhere it signs in.
    expect((await complete(deps, good, { app: from("203.0.113.8") })).status).toBe(200);
  });

  it("the code is never in a log line, an error body or an audit row", async () => {
    const { deps, mail, settle, a } = await site();
    const logged: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args));
    const answers: Call[] = [];
    const keep = (c: Call) => (answers.push(c), c);

    keep(await ask(deps, a.email));
    const code = codeIn(mail.sent[0].text);
    // A mail that could not be sent: its code is in no line.
    mail.failNext();
    keep(await ask(deps, a.email));
    await settle();
    expect(logged).toEqual([["mail: a sign-in mail could not be sent (failed)"]]);
    // The database fails while the code is being redeemed: the app's own answer, with nothing of it.
    const realBatch = deps.db.batch.bind(deps.db);
    deps.db.batch = () => Promise.reject(new Error(`database unavailable while redeeming ${code}`));
    const failed = keep(await complete(deps, code));
    deps.db.batch = realBatch;
    expect([failed.status, failed.text]).toEqual([500, '{"error":"internal"}']);
    // The code in the wrong places: an address, a header of a request that is refused.
    keep(await send(deps, "POST", `/api/v1/signin/complete?code=${code}`, { origin: APP, body: JSON.stringify({ code }), headers: { "content-type": "text/plain", origin: APP } }));
    keep(await send(deps, "GET", `/api/v1/signin/complete/${code}`, { origin: APP }));
    keep(await post(deps, "/api/v1/signin/complete", { code }, { origin: TOURS }));
    keep(await post(deps, "/api/v1/signin/complete", { code }, { headers: { origin: UNKNOWN } }));
    // The press that works, the same code again, and the session's own answers.
    const signedIn = keep(await complete(deps, code));
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie()[0];
    const secret = cookie.match(SECRET)![0];
    keep(await complete(deps, code));
    const session = keep(await send(deps, "GET", "/api/v1/session", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}` } }));
    keep(await send(deps, "GET", "/api/v1/sessions", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}` } }));
    keep(await send(deps, "POST", "/api/v1/signout", { origin: APP, headers: { cookie: `${SESSION_COOKIE}=${secret}`, origin: APP, "x-csrf-token": session.json.csrf } }));

    expect(answers.map((c) => c.status)).toEqual([200, 200, 500, 400, 404, 404, 403, 200, 403, 200, 200, 204]);
    for (const c of answers) {
      // No answer holds a code, in its body or in a header, and none redirects.
      expect(c.text, `${c.status} ${c.text}`).not.toMatch(CODE);
      expect(c.headers.get("location")).toBeNull();
      for (const [name, value] of c.headers) expect(value, name).not.toMatch(CODE);
      // The secret is in the two Set-Cookie headers that sign in, and nowhere else.
      expect(c.text).not.toMatch(SECRET);
      for (const [name, value] of c.headers) if (name !== "set-cookie") expect(value, name).not.toMatch(SECRET);
    }
    expect(answers.filter((c) => SECRET.test(c.headers.get("set-cookie") ?? "")).map((c) => c.status)).toEqual([200, 200]);
    // No line of the log holds a code, a secret, the anti-forgery value or the address.
    const lines = JSON.stringify(logged);
    expect(lines).not.toMatch(/dp[ls]_/);
    expect(lines).not.toContain(session.json.csrf);
    expect(lines).not.toContain(a.email);
    // Nothing stored holds the code or the secret: only their digests, and the audit names ids alone.
    const stored = await everythingStored(deps);
    for (const text of [code, code.slice(4), secret, secret.slice(4), session.json.csrf]) expect(stored.includes(text), text.slice(0, 8)).toBe(false);
    const audit = await rowsOf<Record<string, unknown>>(deps, "SELECT * FROM audit");
    expect(audit.map((row) => row.event).sort()).toEqual(["signin", "signin_link_sent", "signin_link_sent", "signout"]);
    for (const row of audit) {
      expect(JSON.stringify(row)).not.toMatch(/dp[ls]?_[0-9a-f]{8}|[0-9a-f]{32}|@/);
      expect(row.detail).toBeNull();
    }
  });
});

describe("the session", () => {
  it("session tells who you are and gives the anti-forgery value", async () => {
    const { deps, calls, admin, a, b } = await site();
    const s = await signIn(deps, a.userId);
    const before = calls();
    const r = await send(deps, "GET", "/api/v1/session", { origin: APP, headers: by(s) });
    // The session is resolved in one call, and the answer read in one more.
    expect(calls() - before).toBe(2);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      account: { id: a.userId, username: "alice", email: a.email, admin: false },
      workspace: { id: a.workspaceId, name: "Account" },
      session: { id: s.sessionId, created_at: NOW, expires_at: NOW + 2_592_000_000 },
      csrf: s.csrf,
    });
    expect(Object.keys(r.json)).toEqual(["account", "workspace", "session", "csrf"]);
    expect(Object.keys(r.json.account)).toEqual(["id", "username", "email", "admin"]);
    expect(r.json.csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(r.text).not.toMatch(SECRET);
    // The cookie again, the same one, and nothing may keep the answer.
    expect(r.headers.getSetCookie()).toEqual([sessionCookie(s.secret)]);
    expect([...r.headers.entries()].filter(([name]) => name !== "set-cookie").sort()).toEqual(API_HEADERS);
    // The value it gives is the one a change needs.
    expect((await send(deps, "POST", "/api/v1/signout", { origin: APP, headers: { cookie: s.cookie, origin: APP, "x-csrf-token": r.json.csrf } })).status).toBe(204);

    // An account without a username, and the site's admin.
    const plain = await send(deps, "GET", "/api/v1/session", { origin: APP, headers: by(await signIn(deps, b.userId)) });
    expect(plain.json.account).toEqual({ id: b.userId, username: null, email: b.email, admin: false });
    const boss = await send(deps, "GET", "/api/v1/session", { origin: APP, headers: by(await signIn(deps, admin.userId)) });
    expect(boss.json.account).toEqual({ id: admin.userId, username: "boss", email: admin.email, admin: true });
    expect(boss.json.csrf).not.toBe(plain.json.csrf);

    // Nobody, a token, a token with a cookie, a session that is over: never the data, never a cookie.
    const live = await signIn(deps, b.userId);
    const refusals: [string, SendOptions, number, string][] = [
      ["no credential", {}, 401, UNAUTHORIZED],
      ["a token", { token: b.token }, 401, UNAUTHORIZED],
      ["a token and a session", { token: b.token, headers: by(live) }, 400, MIXED],
      ["a session that was signed out", { headers: by(s) }, 401, UNAUTHORIZED],
      ["a cookie nobody was given", { headers: { cookie: `${SESSION_COOKIE}=dps_${"0".repeat(64)}` } }, 401, UNAUTHORIZED],
      ["two session cookies", { headers: { cookie: `${live.cookie}; ${live.cookie}` } }, 401, UNAUTHORIZED],
    ];
    for (const [what, opts, status, body] of refusals) {
      for (const path of ["/api/v1/session", "/api/v1/sessions"]) {
        const refused = await send(deps, "GET", path, { origin: APP, ...opts });
        expect([refused.status, refused.text], `${path} with ${what}`).toEqual([status, body]);
        expect(refused.headers.getSetCookie(), `${path} with ${what}`).toEqual([]);
      }
    }
    // HEAD answers as GET does, without the body.
    const head = await send(deps, "HEAD", "/api/v1/session", { origin: APP, headers: by(live) });
    expect([head.status, head.bytes.byteLength]).toEqual([200, 0]);
  });

  it("sign out ends this session and clears the cookie", async () => {
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    const other = await signIn(deps, a.userId, CHROME);
    const alive = async (x: Signed) => (await send(deps, "GET", "/api/v1/session", { origin: APP, headers: by(x) })).status === 200;

    // Without the anti-forgery header, with another session's, or from another origin: refused, and still signed in.
    const forged: [Record<string, string>, string][] = [
      [{ cookie: s.cookie, origin: APP }, BAD_CSRF],
      [{ cookie: s.cookie, origin: APP, "x-csrf-token": other.csrf }, BAD_CSRF],
      [{ cookie: s.cookie, "x-csrf-token": s.csrf }, BAD_ORIGIN],
      [{ cookie: s.cookie, origin: TOURS, "x-csrf-token": s.csrf }, BAD_ORIGIN],
      [{ cookie: s.cookie, origin: APP, "x-csrf-token": s.csrf, "sec-fetch-site": "same-site" }, BAD_ORIGIN],
    ];
    for (const path of ["/api/v1/signout", "/api/v1/signout/everywhere"]) {
      for (const [headers, body] of forged) {
        const r = await send(deps, "POST", path, { origin: APP, headers });
        expect(seen(r), `${path} ${JSON.stringify(Object.keys(headers))}`).toEqual({ status: 403, headers: API_HEADERS, body });
      }
    }
    expect(await alive(s)).toBe(true);

    const r = await send(deps, "POST", "/api/v1/signout", { origin: APP, headers: by(s, true) });
    expect([r.status, r.bytes.byteLength]).toEqual([204, 0]);
    expect(r.headers.getSetCookie()).toEqual([clearedCookie()]);
    expect(r.headers.getSetCookie()[0]).toBe("__Host-dp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(r.headers.get("cache-control")).toBe("no-store");
    // This session is over; the account's other one is not.
    expect(await alive(s)).toBe(false);
    expect(await alive(other)).toBe(true);
    expect(await rowsOf(deps, "SELECT event, user_id, workspace_id, subject FROM audit WHERE event != 'signin'")).toEqual([{ event: "signout", user_id: a.userId, workspace_id: a.workspaceId, subject: s.sessionId }]);
    // Asked again with the cookie that is over: nobody, and nothing is cleared twice.
    const again = await send(deps, "POST", "/api/v1/signout", { origin: APP, headers: by(s, true) });
    expect([again.status, again.text, again.headers.getSetCookie()]).toEqual([401, UNAUTHORIZED, []]);
    // A token signs nobody out.
    const byToken = await send(deps, "POST", "/api/v1/signout", { origin: APP, token: a.token });
    expect([byToken.status, byToken.text, byToken.headers.getSetCookie()]).toEqual([401, UNAUTHORIZED, []]);
  });

  it("sign out everywhere ends them all", async () => {
    const { deps, a, b } = await site();
    const here = await signIn(deps, a.userId);
    const there = await signIn(deps, a.userId, CHROME);
    const theirs = await signIn(deps, b.userId);
    const status = async (x: Signed) => (await send(deps, "GET", "/api/v1/session", { origin: APP, headers: by(x) })).status;

    const r = await send(deps, "POST", "/api/v1/signout/everywhere", { origin: APP, headers: by(here, true) });
    expect([r.status, r.bytes.byteLength]).toEqual([204, 0]);
    expect(r.headers.getSetCookie()).toEqual([clearedCookie()]);
    expect([await status(here), await status(there)]).toEqual([401, 401]);
    // Another account's session is untouched, and so is this account's token.
    expect(await status(theirs)).toBe(200);
    expect((await send(deps, "GET", "/api/v1/me", { token: a.token })).status).toBe(200);
    expect(await rowsOf(deps, "SELECT event, user_id, workspace_id, subject FROM audit WHERE event != 'signin'")).toEqual([{ event: "signout_everywhere", user_id: a.userId, workspace_id: a.workspaceId, subject: null }]);
    expect(await rowsOf(deps, "SELECT user_id FROM session WHERE revoked_at IS NULL")).toEqual([{ user_id: b.userId }]);
  });

  it("the sessions list holds only your own and marks the current one", async () => {
    const { deps, clock, a, b } = await site();
    const first = await signIn(deps, a.userId);
    clock.now += 60_000;
    const second = await signIn(deps, a.userId, CHROME);
    const gone = await signIn(deps, a.userId);
    await deps.db.run("UPDATE session SET revoked_at = ? WHERE id = ?", [clock.now, gone.sessionId]);
    const expired = await signIn(deps, a.userId);
    await deps.db.run("UPDATE session SET expires_at = ? WHERE id = ?", [clock.now, expired.sessionId]);
    const theirs = await signIn(deps, b.userId);

    const r = await send(deps, "GET", "/api/v1/sessions", { origin: APP, headers: by(second) });
    expect(r.status).toBe(200);
    // The current one first, then the others, and nothing of a session that is over or of another account.
    expect(r.json).toEqual({
      sessions: [
        { id: second.sessionId, label: "Chrome on Windows", created_at: NOW + 60_000, last_used_at: NOW + 60_000, expires_at: NOW + 60_000 + 2_592_000_000, current: true },
        { id: first.sessionId, label: "Firefox on Linux", created_at: NOW, last_used_at: NOW, expires_at: NOW + 2_592_000_000, current: false },
      ],
    });
    expect(Object.keys(r.json.sessions[0])).toEqual(["id", "label", "created_at", "last_used_at", "expires_at", "current"]);
    for (const text of [theirs.sessionId, b.userId, b.email, gone.sessionId, expired.sessionId]) expect(r.text.includes(text)).toBe(false);
    // No secret, no digest and no anti-forgery value is in a list, and listing sets no cookie.
    expect(r.text).not.toMatch(/dps_|[0-9a-f]{32}/);
    expect(r.headers.getSetCookie()).toEqual([]);
    expect([...r.headers.entries()].sort()).toEqual(API_HEADERS);
    // Each sees its own list, with its own session marked.
    const other = await send(deps, "GET", "/api/v1/sessions", { origin: APP, headers: by(first) });
    expect(other.json.sessions.map((x: { id: string; current: boolean }) => [x.id, x.current])).toEqual([[first.sessionId, true], [second.sessionId, false]]);
    const b1 = await send(deps, "GET", "/api/v1/sessions", { origin: APP, headers: by(theirs) });
    expect(b1.json.sessions.map((x: { id: string }) => x.id)).toEqual([theirs.sessionId]);
  });

  it("another account's session id answers not found and stays live", async () => {
    const { deps, a, b } = await site();
    const mine = await signIn(deps, a.userId);
    const other = await signIn(deps, a.userId, CHROME);
    const theirs = await signIn(deps, b.userId);
    const del = (id: string, s: Signed = mine, headers: Record<string, string> = by(s, true)) => send(deps, "DELETE", `/api/v1/sessions/${id}`, { origin: APP, headers });
    const status = async (x: Signed) => (await send(deps, "GET", "/api/v1/session", { origin: APP, headers: by(x) })).status;
    const refusal = { status: 404, headers: API_HEADERS, body: NO_SESSION };

    const before = await rowsOf(deps, "SELECT * FROM session ORDER BY id");
    const audit = await countOf(deps, "audit");
    // Another account's session answers exactly as an id that never existed, and as something that is no id.
    expect(seen(await del(theirs.sessionId))).toEqual(refusal);
    expect(seen(await del("ses_" + "0".repeat(24)))).toEqual(refusal);
    expect(seen(await del("nothing"))).toEqual(refusal);
    expect(seen(await del(b.userId))).toEqual(refusal);
    expect(await rowsOf(deps, "SELECT * FROM session ORDER BY id")).toEqual(before);
    expect(await countOf(deps, "audit")).toBe(audit);
    expect(await status(theirs)).toBe(200);
    // Without the anti-forgery header nothing is ended either, also not one's own.
    expect(seen(await del(other.sessionId, mine, { cookie: mine.cookie, origin: APP }))).toEqual({ status: 403, headers: API_HEADERS, body: BAD_CSRF });
    expect(seen(await del(other.sessionId, mine, { cookie: mine.cookie, "x-csrf-token": mine.csrf }))).toEqual({ status: 403, headers: API_HEADERS, body: BAD_ORIGIN });
    const byToken = await send(deps, "DELETE", `/api/v1/sessions/${other.sessionId}`, { origin: APP, token: a.token });
    expect([byToken.status, byToken.text]).toEqual([401, UNAUTHORIZED]);
    expect(await status(other)).toBe(200);

    // One's own other session ends, with no cookie touched; asked again, there is no such session.
    const ended = await del(other.sessionId);
    expect([ended.status, ended.bytes.byteLength, ended.headers.getSetCookie()]).toEqual([204, 0, []]);
    expect([...ended.headers.entries()]).toEqual([["cache-control", "no-store"]]);
    expect(await status(other)).toBe(401);
    expect(await status(mine)).toBe(200);
    expect(seen(await del(other.sessionId))).toEqual(refusal);
    expect(await rowsOf(deps, "SELECT event, user_id, subject FROM audit WHERE event != 'signin'")).toEqual([{ event: "session_revoked", user_id: a.userId, subject: other.sessionId }]);
    // The session one is in can be ended by its id too; that is a sign-out in the record.
    expect((await del(mine.sessionId)).status).toBe(204);
    expect(await status(mine)).toBe(401);
    expect((await rowsOf<{ event: string }>(deps, "SELECT event FROM audit WHERE subject = ?", [mine.sessionId])).map((row) => row.event).sort()).toEqual(["signin", "signout"]);
    expect(await status(theirs)).toBe(200);
  });
});

describe("where the sign-in routes answer", () => {
  /** Every route of this file, each as a request that works on the app address. */
  async function requests(deps: Deps, userId: string) {
    const s = await signIn(deps, userId);
    const target = await signIn(deps, userId, CHROME);
    const code = await createSignInCode(deps, userId);
    const json = (origin: string) => ({ "content-type": "application/json", origin, "user-agent": FIREFOX });
    const list: { key: string; method: string; path: string; body?: string; headers: (origin: string) => Record<string, string> }[] = [
      { key: "POST /api/v1/signin/request", method: "POST", path: "/api/v1/signin/request", body: JSON.stringify({ email: STRANGER }), headers: json },
      { key: "POST /api/v1/signin/complete", method: "POST", path: "/api/v1/signin/complete", body: JSON.stringify({ code }), headers: json },
      { key: "GET /api/v1/session", method: "GET", path: "/api/v1/session", headers: () => by(s) },
      { key: "GET /api/v1/sessions", method: "GET", path: "/api/v1/sessions", headers: () => by(s) },
      { key: "DELETE /api/v1/sessions/:id", method: "DELETE", path: `/api/v1/sessions/${target.sessionId}`, headers: (origin) => by(s, true, origin) },
      { key: "POST /api/v1/signout/everywhere", method: "POST", path: "/api/v1/signout/everywhere", headers: (origin) => by(s, true, origin) },
      // Last of the session's own: the one before it ended every session, so this one is made anew.
      { key: "POST /api/v1/signout", method: "POST", path: "/api/v1/signout", headers: (origin) => by(s, true, origin) },
    ];
    return { s, target, code, list };
  }
  const KEYS = ["POST /api/v1/signin/request", "POST /api/v1/signin/complete", "GET /api/v1/session", "GET /api/v1/sessions", "DELETE /api/v1/sessions/:id", "POST /api/v1/signout/everywhere", "POST /api/v1/signout"];

  it("no route here answers on the tours address", async () => {
    const { deps, calls, mail, a } = await site();
    const { s, target, code, list } = await requests(deps, a.userId);
    // The routes of this file are the ones the app has under these names.
    const routes = createApp(deps).routes.map((r) => `${r.method} ${r.path}`);
    expect(list.map((r) => r.key)).toEqual(KEYS);
    for (const key of KEYS) expect(routes).toContain(key);
    expect(routes.filter((key) => /\/(signin|signout|sessions?)\b/.test(key)).sort()).toEqual([...KEYS].sort());

    const stored = await everythingStored(deps);
    const before = calls();
    for (const r of list) {
      const onTours = await send(deps, r.method, r.path, { origin: TOURS, body: r.body, headers: r.headers(TOURS) });
      expect(seen(onTours), r.key).toEqual({ status: 404, headers: [["cache-control", "no-store"], ["content-type", "application/json"]], body: NOT_FOUND });
      const elsewhere = await send(deps, r.method, r.path, { origin: UNKNOWN, body: r.body, headers: r.headers(UNKNOWN) });
      expect([elsewhere.status, elsewhere.bytes.byteLength, elsewhere.headers.getSetCookie()], r.key).toEqual([421, 0, []]);
    }
    // Nothing was read, counted, sent, spent or ended.
    expect(calls()).toBe(before);
    expect(await everythingStored(deps)).toBe(stored);
    expect(mail.sent).toEqual([]);
    // On the app address each of them answers: the same requests, sent there.
    const statuses: Record<string, number> = {};
    for (const r of list) {
      const fresh = r.key === "POST /api/v1/signout" ? await signIn(deps, a.userId) : s;
      const headers = r.key === "POST /api/v1/signout" ? by(fresh, true) : r.headers(APP);
      statuses[r.key] = (await send(deps, r.method, r.path, { origin: APP, body: r.body, headers })).status;
    }
    expect(statuses).toEqual({ [KEYS[0]]: 200, [KEYS[1]]: 200, [KEYS[2]]: 200, [KEYS[3]]: 200, [KEYS[4]]: 204, [KEYS[5]]: 204, [KEYS[6]]: 204 });
    expect(target.sessionId).not.toBe(s.sessionId);
    expect(code).toMatch(/^dpl_/);
  });

  it("only sign-in, session and the two sign-outs ever set a cookie, and only on the app address", async () => {
    const { deps, a, b } = await site();
    const setters: Record<string, string[]> = {};
    const note = (key: string, c: Call) => {
      const cookies = c.headers.getSetCookie();
      for (const cookie of cookies) expect(cookie.startsWith(`${SESSION_COOKIE}=`), `${key} sets ${cookie.split("=")[0]}`).toBe(true);
      if (cookies.length > 0) (setters[key] ??= []).push(`${c.status} ${cookies.length} ${cookies[0].includes("Max-Age=0") ? "cleared" : "set"}`);
    };

    // Every route of this file, as it works.
    const { s, list } = await requests(deps, a.userId);
    for (const r of list) {
      const fresh = r.key === "POST /api/v1/signout" ? await signIn(deps, a.userId) : s;
      const headers = r.key === "POST /api/v1/signout" ? by(fresh, true) : r.headers(APP);
      note(r.key, await send(deps, r.method, r.path, { origin: APP, body: r.body, headers }));
    }
    // Every route of this file, refused: nobody, a session that is over, a change without its header, a code that is none.
    const over = s;
    const live = await signIn(deps, b.userId);
    for (const r of list) {
      for (const headers of [{}, by(over, true), { cookie: live.cookie, origin: APP }, { ...r.headers(APP), cookie: `${SESSION_COOKIE}=dps_${"0".repeat(64)}`, "content-type": "text/plain" }]) {
        const c = await send(deps, r.method, r.path, { origin: APP, body: r.body, headers });
        if (r.key !== "GET /api/v1/session" && r.key !== "GET /api/v1/sessions" && !r.key.includes("signin")) expect(c.status, `${r.key} ${JSON.stringify(Object.keys(headers))}`).toBeGreaterThanOrEqual(400);
        if (c.status >= 400) expect(c.headers.getSetCookie(), `${r.key} answered ${c.status} with a cookie`).toEqual([]);
        else note(r.key, c);
      }
    }
    // Every other route of the app, asked by a live session: none touches the cookie.
    const app = createApp(deps);
    const others = [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))].filter((key) => !KEYS.includes(key));
    expect(others.length).toBeGreaterThan(25);
    for (const key of others) {
      const [method, route] = key.split(" ");
      const path = route.startsWith("/:file") ? "/player.js" : route.startsWith("/docs/:file") ? "/docs/viewer.0123456789abcdef.js" : route.replace(/:[a-z_]+/g, "tour_" + "0".repeat(24));
      for (const origin of [APP, TOURS]) {
        const c = await send(deps, method, path, { origin, headers: method === "GET" ? by(live) : by(live, true, origin) });
        expect(c.headers.getSetCookie(), `${key} on ${origin}`).toEqual([]);
      }
    }

    expect(setters).toEqual({
      "POST /api/v1/signin/complete": ["200 1 set"],
      "GET /api/v1/session": ["200 1 set", "200 1 set"],
      "POST /api/v1/signout/everywhere": ["204 1 cleared"],
      "POST /api/v1/signout": ["204 1 cleared"],
    });

    // Not on the tours address, also if the gate in front of the routes were not there:
    // the routes themselves refuse to sign anyone in, or out, on an address that takes no session.
    const bare = new Hono();
    signinRoutes(bare, deps);
    const code = await createSignInCode(deps, b.userId);
    const pressed = await bare.fetch(new Request(TOURS + "/api/v1/signin/complete", { method: "POST", body: JSON.stringify({ code }), headers: { "content-type": "application/json", origin: TOURS } }));
    expect([pressed.status, pressed.headers.getSetCookie()]).toEqual([404, []]);
    for (const [method, path] of [["GET", "/api/v1/session"], ["POST", "/api/v1/signout"], ["POST", "/api/v1/signout/everywhere"]]) {
      const r = await bare.fetch(new Request(TOURS + path, { method, headers: by(live, true, TOURS) }));
      expect([r.status, r.headers.getSetCookie()], path).toEqual([401, []]);
    }
    // The code was not spent there: on the app address it signs in, with the cookie.
    const signedIn = await complete(deps, code);
    expect([signedIn.status, signedIn.headers.getSetCookie().length]).toEqual([200, 1]);
    // In one-address mode the one address is where sessions live.
    const one = await site({});
    const there = await complete(one.deps, await createSignInCode(one.deps, one.a.userId), { origin: "https://site.example.com" });
    expect([there.status, there.headers.getSetCookie().length]).toEqual([200, 1]);
  });
});
