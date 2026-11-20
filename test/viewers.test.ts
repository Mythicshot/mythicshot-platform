// Viewers (src/viewers.ts): a visitor proving an email address on the tours address. Asking
// for a link, looking a code up, completing it, the viewer session and signing out, the
// cookie, the limits, the mail and the call counts. Runs on both targets. No mail is sent:
// every mailer here is the fake one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount, type MakeOptions } from "#harness";
import { noDisabledAccount } from "../src/accounts.ts";
import { createApp } from "../src/app.ts";
import { auditStatement } from "../src/audit.ts";
import { hashToken, newId } from "../src/auth.ts";
import { setClientAddress } from "../src/client.ts";
import type { Hosts } from "../src/hosts.ts";
import { viewerLink, viewerLinkOrigin, viewerMail } from "../src/mail.ts";
import type { Config, Db, Deps } from "../src/ports.ts";
import { LIMITS_SIGNIN, LIMITS_VIEWER, SITE_KEY, recipientKey, viewerPairKey, viewerWorkspaceKey } from "../src/rate.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { PAD_BUCKET } from "../src/signin.ts";
import {
  NO_VIEWER_GATE,
  VIEWER_CODE_MS,
  VIEWER_COOKIE,
  VIEWER_IDLE_MS,
  VIEWER_LINES,
  VIEWER_MAX_MS,
  VIEWER_ROLES,
  VIEWER_TOUCH_MS,
  clearedViewerCookie,
  provedEmail,
  sweepViewers,
  useViewerGate,
  viewerCookie,
  type ViewerGate,
} from "../src/viewers.ts";
import { send, type Call, type SendOptions } from "./bundle.ts";

const NOW = 1_800_000_000_000;
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const IMG = "https://img.example.com";
const TWO: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...TWO, img: "img.example.com" };
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

const OK = '{"ok":true}';
const UNAUTHORIZED = '{"error":"unauthorized"}';
const INVALID = '{"error":"view_link_invalid","detail":"this link no longer works; open the tour\'s own link again and ask for a new one"}';
const BAD_ORIGIN = '{"error":"bad_origin","detail":"this request must come from the site\'s own pages"}';
const CREDENTIALS = '{"error":"credentials_not_allowed","detail":"send no token with this request"}';
const API_HEADERS = [
  ["cache-control", "no-store"],
  ["content-type", "application/json"],
  ["x-content-type-options", "nosniff"],
];

/** The slugs of the site every test builds: each a tour in one state, or none. */
const SLUGS = {
  open: "openpublic",
  restricted: "restricted",
  second: "secondtour",
  third: "thirdtourz",
  draft: "draftonlyz",
  disabled: "disabledws",
  none: "nosuchtour",
} as const;
const LISTED = "mara@example.com";
const OTHER = "bram@example.com";

afterEach(() => {
  useViewerGate(null);
  vi.restoreAllMocks();
});

/**
 * The gate the parallel task will register, as a stand-in: one read for every question,
 * whatever it answers, that finds a published tour of a workspace with no disabled account,
 * and then a list held here. A tour not in `lists` is public. A yes carries the workspace's
 * id as its key (the real gate may derive any opaque key).
 */
function gateOf(lists: Record<string, string[]>): ViewerGate {
  return {
    async mayRequest(deps, slug, email) {
      const row = await deps.db.first<{ slug: string; workspace_id: string }>(`SELECT t.slug, t.workspace_id FROM tour t WHERE t.slug = ? AND t.status = 'published' AND ${noDisabledAccount("t.workspace_id")}`, [slug]);
      return row !== null && (lists[row.slug] ?? []).includes(email) ? { allowed: true, workspaceKey: row.workspace_id } : { allowed: false };
    },
  };
}

/** Sets a counter of this hour to `n`, as that many hits would have. */
async function fillCounter(deps: Deps, bucket: string, key: string, n: number, windowMs = 3_600_000): Promise<void> {
  const now = deps.now();
  await deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, ?) ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = excluded.count", [bucket, key, now - (now % windowMs), n]);
}

async function addTour(deps: Deps, workspaceId: string, slug: string, status: "published" | "draft" = "published"): Promise<void> {
  await deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'A tour', ?, ?, ?, ?)", [newId("tour"), workspaceId, slug, status, NOW, NOW]);
}

/**
 * A site with a clock the test moves, an owner whose workspace holds a public tour, three tours
 * restricted to LISTED and a draft, a second owner (disabled) whose workspace holds one
 * restricted to LISTED, and the stand-in gate registered.
 */
async function site(config: Partial<Config> = { hosts: TWO }, opts: MakeOptions = {}) {
  const made = await makeDeps(config, opts);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  const owner = await seedAccount(made.deps, { admin: true, username: "boss" });
  const off = await seedAccount(made.deps, { username: "gone" });
  for (const slug of [SLUGS.open, SLUGS.restricted, SLUGS.second, SLUGS.third]) await addTour(made.deps, owner.workspaceId, slug);
  await addTour(made.deps, owner.workspaceId, SLUGS.draft, "draft");
  await addTour(made.deps, off.workspaceId, SLUGS.disabled);
  await made.deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [off.userId]);
  useViewerGate(gateOf({ [SLUGS.restricted]: [LISTED], [SLUGS.second]: [LISTED], [SLUGS.third]: [LISTED], [SLUGS.disabled]: [LISTED], [SLUGS.draft]: [LISTED] }));
  return { ...made, clock, owner, off };
}

/** A POST of JSON as the tours address's own page sends it. */
function post(deps: Deps, path: string, body: unknown, more: SendOptions = {}): Promise<Call> {
  const origin = more.origin ?? TOURS;
  return send(deps, "POST", path, {
    ...more,
    origin,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "user-agent": FIREFOX, ...more.headers },
  });
}

const ask = (deps: Deps, email: unknown, slug: unknown, more: SendOptions = {}) => post(deps, "/api/v1/view/request", { email, slug }, more);
const check = (deps: Deps, code: unknown, more: SendOptions = {}) => post(deps, "/api/v1/view/check", { code }, more);
const complete = (deps: Deps, code: unknown, more: SendOptions = {}) => post(deps, "/api/v1/view/complete", { code }, more);
const sessionOf = (deps: Deps, cookie: string | null, origin = TOURS) => send(deps, "GET", "/api/v1/view/session", { origin, headers: cookie === null ? {} : { cookie } });

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** The one viewer code in a mail's text. */
function codeIn(text: string): string {
  const found = text.match(/dpv_[0-9a-f]{40}/g) ?? [];
  expect(found, "a mail holds its code once").toHaveLength(1);
  return found[0] ?? "";
}

/** The viewer cookie a completion set, as a Cookie header carries it. */
function cookieOf(c: Call): string {
  const set = c.headers.getSetCookie();
  expect(set).toHaveLength(1);
  return set[0].split(";")[0];
}

/** A code stored as the job stores one, for `email` and `slug`, made `ago` milliseconds ago. */
async function storedCode(deps: Deps, email: string, slug: string = SLUGS.restricted, ago = 0): Promise<string> {
  const code = "dpv_" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
  const at = deps.now() - ago;
  await deps.db.run("INSERT INTO viewer_code (id, email, slug, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("vco"), email, slug, await hashToken(code), at, at + VIEWER_CODE_MS]);
  return code;
}

/** A viewer session for `email`, made through the real completion; its Cookie header. */
async function viewerFor(deps: Deps, email: string, origin = TOURS): Promise<string> {
  const r = await complete(deps, await storedCode(deps, email), { origin });
  expect(r.status).toBe(200);
  return cookieOf(r);
}

/** An account session as the server makes one. */
async function accountSession(deps: Deps, userId: string): Promise<{ cookie: string; csrf: string; secret: string }> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), FIREFOX, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret), secret: made.secret };
}

/** Records the kind of every database call made through `deps.db` from now on; with `statements`, also each call's SQL. */
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

const ANSWER = "| answer";
/** The app (with a client address, if given) that marks ANSWER in each list when its answer is handed back. */
const answered = (lists: string[][], address?: string) => (deps: Deps) => ({
  fetch: async (req: Request) => {
    if (address !== undefined) setClientAddress(req, address);
    const res = await createApp(deps).fetch(req);
    for (const list of lists) list.push(ANSWER);
    return res;
  },
});
/** The app with the client address an entry would have set. */
const from = (address: string) => (deps: Deps) => ({
  fetch: (req: Request) => {
    setClientAddress(req, address);
    return createApp(deps).fetch(req);
  },
});

function split(list: string[]): { before: string[]; after: string[] } {
  const all = list.splice(0);
  const at = all.indexOf(ANSWER);
  expect(at, "the answer was marked").toBeGreaterThanOrEqual(0);
  return { before: all.slice(0, at), after: all.slice(at + 1) };
}

const countOf = async (deps: Deps, table: string) => (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
const counter = async (deps: Deps, bucket: string, key: string) =>
  (await deps.db.first<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM rate_counter WHERE bucket = ? AND key = ?", [bucket, key]))!.n;

/** What every link request awaits before its answer (no known network): three counts, the gate's one read, the two mail caps, the two sweeps. */
const AWAITED = ["first", "first", "first", "first", "first", "first", "batch", "run"];
/** What the job after the answer does: one write, then one batch. */
const JOB = ["run", "batch"];

describe("asking for a viewer link", () => {
  it("answers the same, after the same database calls, for every tour and address; mail goes out only to a listed address of a restricted tour", async () => {
    const { deps, mail, settle, owner } = await site();
    const statements: string[] = [];
    const kinds = recordKinds(deps, statements);
    const app = answered([kinds, statements]);
    const lines = vi.spyOn(console, "error").mockImplementation(() => {});
    const ownersKey = await viewerWorkspaceKey(owner.workspaceId);

    const cases: [string, unknown, unknown, ((d: Deps) => Promise<void>)?][] = [
      ["the listed address, with the tour's workspace's hour used up", LISTED, SLUGS.restricted, (d) => fillCounter(d, LIMITS_VIEWER.mailWorkspace.bucket, ownersKey, LIMITS_VIEWER.mailWorkspace.most)],
      ["the listed address, with the site's backstop reached", LISTED, SLUGS.restricted, (d) => fillCounter(d, LIMITS_VIEWER.mailSite.bucket, SITE_KEY, LIMITS_VIEWER.mailSite.most)],
      ["an unknown slug", LISTED, SLUGS.none],
      ["a public tour", LISTED, SLUGS.open],
      ["a restricted tour that does not list the address", OTHER, SLUGS.restricted],
      ["a restricted tour of a disabled workspace", LISTED, SLUGS.disabled],
      ["a draft", LISTED, SLUGS.draft],
      ["a malformed address", "not an address", SLUGS.restricted],
      ["an address that is not text", 42, SLUGS.restricted],
      ["a malformed slug", LISTED, "../../etc"],
      ["no slug", LISTED, undefined],
      ["the listed address of a restricted tour", LISTED, SLUGS.restricted],
    ];
    const answers: Record<string, { seen: ReturnType<typeof seen>; before: string[]; after: string[] }> = {};
    for (const [what, email, slug, prepare] of cases) {
      // Each case starts with no count, so no limit stands between it and the one that mails, but the one it sets itself.
      await deps.db.run("DELETE FROM rate_counter");
      await prepare?.(deps);
      kinds.length = 0;
      statements.length = 0;
      const r = await ask(deps, email, slug, { app });
      await settle();
      const calls = split(kinds);
      split(statements);
      answers[what] = { seen: seen(r), before: calls.before, after: calls.after };
    }
    const sent = answers["the listed address of a restricted tour"];
    expect(sent.seen).toEqual({ status: 202, headers: API_HEADERS, body: OK });
    expect(sent.before).toEqual(AWAITED);
    expect(sent.after).toEqual(JOB);
    for (const [what] of cases) expect(answers[what], what).toEqual(sent);
    // Only the one case was mailed, and only it stored a code. The two full caps each said so in one line of the log alone.
    expect(mail.sent.map((m) => m.to)).toEqual([LISTED]);
    expect(lines.mock.calls.map((c) => c[0])).toEqual([VIEWER_LINES.hour, VIEWER_LINES.hour]);
    expect(await countOf(deps, "viewer_code")).toBe(1);
    expect(await deps.db.all("SELECT email, slug FROM viewer_code")).toEqual([{ email: LISTED, slug: SLUGS.restricted }]);
  });

  it("no write that only a mailed link causes runs before the answer is out, and the job writes the same kinds either way", async () => {
    const { deps, mail } = await site();
    const statements: string[] = [];
    recordKinds(deps, statements);
    const sent = mail.send.bind(mail);
    deps.mail = { send: (m) => (statements.push("mail"), sent(m)) };
    const app = answered([statements]);

    await ask(deps, LISTED, SLUGS.restricted, { app });
    const listed = split(statements);
    await ask(deps, OTHER, SLUGS.restricted, { app });
    const other = split(statements);

    const linkOnly = /^(run|batch) INSERT INTO (viewer_code|audit)\b|^mail$/;
    expect(listed.before.filter((x) => linkOnly.test(x) || x.includes(PAD_BUCKET))).toEqual([]);
    expect(listed.before.map((x) => x.split(" (")[0])).toEqual(other.before.map((x) => x.split(" (")[0]));
    expect(listed.after.map((x) => x.split(" (")[0])).toEqual(["run INSERT INTO viewer_code", "batch INSERT INTO audit", "mail"]);
    expect(other.after.map((x) => x.split(" (")[0])).toEqual(["run INSERT INTO rate_counter", "batch INSERT INTO rate_counter"]);
  });

  it("with a known network the network is counted first, the same for everyone; its eleventh request is 429 and nothing else is counted", async () => {
    const { deps, mail } = await site();
    const kinds = recordKinds(deps);
    const there = answered([kinds], "203.0.113.9");
    await ask(deps, LISTED, SLUGS.restricted, { app: there });
    const listed = split(kinds);
    await ask(deps, OTHER, SLUGS.none, { app: there });
    expect(split(kinds)).toEqual(listed);
    expect(listed.before).toEqual(["first", ...AWAITED]);
    for (let i = 3; i <= LIMITS_VIEWER.linkNetwork.most; i++) expect((await ask(deps, OTHER, SLUGS.open, { app: from("203.0.113.9") })).status).toBe(202);
    const over = await ask(deps, LISTED, SLUGS.second, { app: from("203.0.113.9") });
    expect([over.status, over.text, over.headers.get("retry-after")]).toEqual([429, '{"error":"rate_limited"}', expect.stringMatching(/^[1-9][0-9]*$/)]);
    // Another network is not held up.
    expect((await ask(deps, LISTED, SLUGS.second, { app: from("198.51.100.4") })).status).toBe(202);
    expect(mail.sent).toHaveLength(2);
  });

  it("one address is mailed no more than its own limits allow, however many tours and networks ask", async () => {
    const { deps, mail, clock, owner } = await site();
    const slugs = ["restricted", "secondtour", "thirdtourz", "fourthtour", "fifthtourz", "sixthtourz"];
    for (const slug of slugs.slice(3)) await addTour(deps, owner.workspaceId, slug);
    useViewerGate(gateOf(Object.fromEntries(slugs.map((s) => [s, [LISTED]]))));
    // Six tours from six networks in one quarter hour: three mails.
    for (const [i, slug] of slugs.entries()) expect((await ask(deps, LISTED, slug, { app: from(`203.0.113.${10 + i}`) })).status).toBe(202);
    expect(mail.sent).toHaveLength(LIMITS_VIEWER.linkRecipient.most);
    // The next day, one request a quarter hour, each for another tour from another network: ten, then nothing more that day.
    clock.now += LIMITS_VIEWER.linkRecipientDay.windowMs;
    for (let q = 0; q < 16; q++) {
      expect((await ask(deps, LISTED, slugs[q % slugs.length], { app: from(`198.51.100.${q + 1}`) })).status).toBe(202);
      clock.now += LIMITS_VIEWER.linkRecipient.windowMs;
    }
    expect(mail.sent).toHaveLength(LIMITS_VIEWER.linkRecipient.most + LIMITS_VIEWER.linkRecipientDay.most);
    expect(new Set(mail.sent.map((m) => m.to))).toEqual(new Set([LISTED]));
  });

  it("one address asking for one tour again and again is stopped by its own pair limit first", async () => {
    const { deps, mail, settle } = await site();
    const lines = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) expect(seen(await ask(deps, LISTED, SLUGS.restricted))).toEqual({ status: 202, headers: API_HEADERS, body: OK });
    await settle();
    expect(mail.sent).toHaveLength(LIMITS_VIEWER.linkPair.most);
    // The third was held back by the pair's count alone: the address's own count is at its limit, not over it.
    expect(await counter(deps, LIMITS_VIEWER.linkPair.bucket, await viewerPairKey(LISTED, SLUGS.restricted))).toBe(3);
    expect(await counter(deps, LIMITS_VIEWER.linkRecipient.bucket, await recipientKey(LISTED))).toBe(LIMITS_VIEWER.linkRecipient.most);
    expect(lines.mock.calls.map((c) => c[0])).toEqual([VIEWER_LINES.recipient]);
  });

  it("the viewer mail caps and the sign-in mail cap are independent", async () => {
    const { deps, mail, owner } = await site();
    const fill = (bucket: string, n: number) => fillCounter(deps, bucket, SITE_KEY, n);
    const lines = vi.spyOn(console, "error").mockImplementation(() => {});
    // Sign-in's hour used up: a viewer link still goes.
    await fill(LIMITS_SIGNIN.mailSite.bucket, LIMITS_SIGNIN.mailSite.most);
    await ask(deps, LISTED, SLUGS.restricted);
    expect(mail.sent.map((m) => m.subject)).toEqual(["Your link to a Mythicshot tour"]);
    await post(deps, "/api/v1/signin/request", { email: owner.email }, { origin: APP });
    expect(mail.sent).toHaveLength(1);
    // The viewer backstop reached: no viewer link; sign-in, with its hour back, still goes.
    await deps.db.run("DELETE FROM rate_counter WHERE bucket = ?", [LIMITS_SIGNIN.mailSite.bucket]);
    await fill(LIMITS_VIEWER.mailSite.bucket, LIMITS_VIEWER.mailSite.most);
    expect((await ask(deps, LISTED, SLUGS.second)).status).toBe(202);
    expect(mail.sent).toHaveLength(1);
    await post(deps, "/api/v1/signin/request", { email: owner.email }, { origin: APP });
    expect(mail.sent.map((m) => m.subject)).toEqual(["Your link to a Mythicshot tour", "Your Mythicshot sign-in link"]);
    expect(lines.mock.calls.map((c) => c[0])).toContain(VIEWER_LINES.hour);
    // A request that sends nothing never spends either viewer cap.
    expect(await counter(deps, LIMITS_VIEWER.mailSite.bucket, SITE_KEY)).toBe(LIMITS_VIEWER.mailSite.most + 1);
    await deps.db.run("DELETE FROM rate_counter WHERE bucket IN (?, ?)", [LIMITS_VIEWER.mailSite.bucket, LIMITS_VIEWER.mailWorkspace.bucket]);
    for (const slug of [SLUGS.open, SLUGS.none, SLUGS.disabled]) await ask(deps, LISTED, slug);
    expect(await counter(deps, LIMITS_VIEWER.mailSite.bucket, SITE_KEY)).toBe(0);
    expect(await deps.db.all("SELECT key FROM rate_counter WHERE bucket = ? AND key != 'site_quiet'", [LIMITS_VIEWER.mailWorkspace.bucket])).toEqual([]);
  });

  it("each workspace's tours have their own hour of viewer mails: one that is full stops no other", async () => {
    const { deps, mail, owner, settle } = await site();
    const other = await seedAccount(deps, { username: "other" });
    await addTour(deps, other.workspaceId, "othertourz");
    useViewerGate(gateOf({ [SLUGS.restricted]: [LISTED], othertourz: [OTHER] }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await fillCounter(deps, LIMITS_VIEWER.mailWorkspace.bucket, await viewerWorkspaceKey(owner.workspaceId), LIMITS_VIEWER.mailWorkspace.most);
    expect((await ask(deps, LISTED, SLUGS.restricted)).status).toBe(202);
    expect((await ask(deps, OTHER, "othertourz")).status).toBe(202);
    await settle();
    expect(mail.sent.map((m) => m.to)).toEqual([OTHER]);
    // The other workspace's mail was counted under its own key; the full one only counted the request it refused.
    expect(await counter(deps, LIMITS_VIEWER.mailWorkspace.bucket, await viewerWorkspaceKey(other.workspaceId))).toBe(1);
    expect(await counter(deps, LIMITS_VIEWER.mailWorkspace.bucket, await viewerWorkspaceKey(owner.workspaceId))).toBe(LIMITS_VIEWER.mailWorkspace.most + 1);
    // The thirty-first mail of one workspace in an hour is not sent; the next hour it is.
    const many = await seedAccount(deps, { username: "many" });
    const slugs = Array.from({ length: LIMITS_VIEWER.mailWorkspace.most + 1 }, (_, i) => "many" + "abcdefghijklmnopqrstuvwxyz234567"[i].repeat(6));
    for (const slug of slugs) await addTour(deps, many.workspaceId, slug);
    const readers = slugs.map((_, i) => `reader${i}@example.com`);
    useViewerGate(gateOf(Object.fromEntries(slugs.map((s, i) => [s, [readers[i]]]))));
    for (const [i, slug] of slugs.entries()) await ask(deps, readers[i], slug);
    await settle();
    expect(mail.sent.filter((m) => m.to.startsWith("reader")).map((m) => m.to)).toEqual(readers.slice(0, LIMITS_VIEWER.mailWorkspace.most));
  }, 60_000);

  it("a workspace's owner learns nothing about another workspace's list from whether their own mails still go", async () => {
    // The attack: fill the count one short with links to your own addresses on your own tour, ask
    // for a link for the victim on someone else's tour, then see whether your next own mail arrives.
    const run = async (victimListed: boolean) => {
      const { deps, mail, owner, settle } = await site();
      const attacker = await seedAccount(deps, { username: "mallory" });
      await addTour(deps, attacker.workspaceId, "mallorysss");
      const own = Array.from({ length: LIMITS_VIEWER.mailWorkspace.most }, (_, i) => `mallory${i}@example.com`);
      useViewerGate(gateOf({ mallorysss: own, [SLUGS.restricted]: victimListed ? [LISTED] : [] }));
      vi.spyOn(console, "error").mockImplementation(() => {});
      for (const address of own.slice(0, -1)) await ask(deps, address, "mallorysss");
      const victim = await ask(deps, LISTED, SLUGS.restricted);
      const last = await ask(deps, own[own.length - 1], "mallorysss");
      await settle();
      expect(await counter(deps, LIMITS_VIEWER.mailWorkspace.bucket, await viewerWorkspaceKey(owner.workspaceId))).toBe(victimListed ? 1 : 0);
      return { victim: seen(victim), last: seen(last), mine: mail.sent.filter((m) => m.to.startsWith("mallory")).map((m) => m.to) };
    };
    const listed = await run(true);
    const unlisted = await run(false);
    expect(listed).toEqual(unlisted);
    expect(listed.mine).toHaveLength(LIMITS_VIEWER.mailWorkspace.most);
  }, 60_000);

  it("the mail has the approved words, and its link is on the configured tours address whatever the request says", async () => {
    const { deps, mail } = await site();
    const forged = { host: "evil.example.net", "x-forwarded-host": "evil.example.net", "x-forwarded-proto": "http", forwarded: "host=evil.example.net;proto=http", referer: "https://evil.example.net/t/restricted" };
    await ask(deps, `  ${LISTED.toUpperCase()} `, SLUGS.restricted, { headers: forged });
    expect(mail.sent).toHaveLength(1);
    const code = codeIn(mail.sent[0].text);
    expect(mail.sent[0]).toEqual({
      to: LISTED,
      subject: "Your link to a Mythicshot tour",
      text: `Open this link to view the tour that was shared with you:\n\nhttps://tours.example.com/view#${code}\n\nIt works once and for 15 minutes. If you did not ask for it, ignore this mail: nothing happens without the link.\n`,
    });
    expect(viewerMail(LISTED, viewerLink("https://tours.example.com", code))).toEqual(mail.sent[0]);
    // The origin comes from the settings: the tours address, else SITE_HOST, else none.
    expect(viewerLinkOrigin({ publicImageBase: "", setupCode: null, hosts: TWO })).toBe(TOURS);
    expect(viewerLinkOrigin({ publicImageBase: "", setupCode: null, hosts: THREE })).toBe(TOURS);
    expect(viewerLinkOrigin({ publicImageBase: "", setupCode: null, siteHost: "site.example.com" })).toBe("https://site.example.com");
    expect(viewerLinkOrigin({ publicImageBase: "", setupCode: null, siteHost: "localhost:8787" })).toBe("http://localhost:8787");
    expect(viewerLinkOrigin({ publicImageBase: "", setupCode: null })).toBeNull();
    expect(() => viewerLink("https://tours.example.com/x", code)).toThrow("bad origin");
    expect(() => viewerLink(TOURS, "a b")).toThrow("bad code");
  });

  it("without a configured address, or with mail off, nothing is sent and the answer is the same", async () => {
    for (const [what, config, opts] of [
      ["no address for links", {}, {}],
      ["mail off", { hosts: TWO }, { mail: false }],
    ] as const) {
      const { deps, mail } = await site(config, opts);
      const kinds = recordKinds(deps);
      const r = await ask(deps, LISTED, SLUGS.restricted, { app: answered([kinds]), origin: TOURS });
      expect(seen(r), what).toEqual({ status: 202, headers: API_HEADERS, body: OK });
      expect(split(kinds), what).toEqual({ before: AWAITED, after: JOB });
      expect(mail.sent, what).toEqual([]);
      expect(await countOf(deps, "viewer_code"), what).toBe(0);
    }
  });

  it("without a registered gate nothing is ever mailed, and the gate is asked nothing of the database", async () => {
    const { deps, mail } = await site();
    useViewerGate(null);
    const kinds = recordKinds(deps);
    expect((await ask(deps, LISTED, SLUGS.restricted, { app: answered([kinds]) })).status).toBe(202);
    expect(split(kinds).before).toEqual(["first", "first", "first", "first", "first", "batch", "run"]);
    expect(mail.sent).toEqual([]);
    expect(await NO_VIEWER_GATE.mayRequest(deps, SLUGS.restricted, LISTED)).toEqual({ allowed: false });
  });

  it("another origin, a form, a token or a body that is not an object is refused before anything is counted", async () => {
    const { deps, mail } = await site();
    const before = await countOf(deps, "rate_counter");
    const json = { "content-type": "application/json" };
    const refusals: [string, Promise<Call>, number, string][] = [
      ["another site", send(deps, "POST", "/api/v1/view/request", { origin: TOURS, body: JSON.stringify({ email: LISTED, slug: SLUGS.restricted }), headers: { ...json, origin: "https://evil.example.net" } }), 403, BAD_ORIGIN],
      ["the app address's page", send(deps, "POST", "/api/v1/view/request", { origin: TOURS, body: JSON.stringify({ email: LISTED, slug: SLUGS.restricted }), headers: { ...json, origin: APP } }), 403, BAD_ORIGIN],
      ["no origin", send(deps, "POST", "/api/v1/view/request", { origin: TOURS, body: JSON.stringify({ email: LISTED, slug: SLUGS.restricted }), headers: json }), 403, BAD_ORIGIN],
      ["a cross-site fetch", ask(deps, LISTED, SLUGS.restricted, { headers: { "sec-fetch-site": "cross-site" } }), 403, BAD_ORIGIN],
      ["a form", ask(deps, LISTED, SLUGS.restricted, { headers: { "content-type": "application/x-www-form-urlencoded" } }), 400, ""],
      ["a list", post(deps, "/api/v1/view/request", [LISTED]), 400, ""],
      ["a token", ask(deps, LISTED, SLUGS.restricted, { token: "dp_" + "0".repeat(40) }), 400, CREDENTIALS],
    ];
    for (const [what, p, status, body] of refusals) {
      const r = await p;
      expect(r.status, what).toBe(status);
      if (body !== "") expect(r.text, what).toBe(body);
      expect(r.headers.getSetCookie(), what).toEqual([]);
    }
    expect(await countOf(deps, "rate_counter")).toBe(before);
    expect(mail.sent).toEqual([]);
  });
});

describe("a viewer code", () => {
  it("is looked up without being used, and completing it sets a new viewer cookie with exactly these attributes", async () => {
    const { deps, mail } = await site();
    await ask(deps, LISTED, SLUGS.restricted);
    const code = codeIn(mail.sent[0].text);
    for (let i = 0; i < 2; i++) {
      const looked = await check(deps, code);
      expect(seen(looked)).toEqual({ status: 200, headers: API_HEADERS, body: JSON.stringify({ email: LISTED, slug: SLUGS.restricted }) });
    }
    const done = await complete(deps, code);
    expect([done.status, done.text]).toEqual([200, JSON.stringify({ slug: SLUGS.restricted })]);
    const set = done.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^__Host-dp_viewer=dpw_[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000$/);
    expect(set[0]).not.toMatch(/Domain/i);
    expect(VIEWER_COOKIE).not.toBe(SESSION_COOKIE);
    expect(VIEWER_ROLES).toEqual(["tours"]);
    expect(viewerCookie(set[0].slice(VIEWER_COOKIE.length + 1, set[0].indexOf(";")))).toBe(set[0]);
    expect(clearedViewerCookie()).toBe("__Host-dp_viewer=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    for (const bad of ["", "dps_" + "0".repeat(64), "dpw_" + "0".repeat(63), "dpw_" + "A".repeat(64), "x; Domain=example.com"]) expect(() => viewerCookie(bad), bad).toThrow("not a viewer secret");
    // Only the digest of the secret is stored.
    const secret = cookieOf(done).split("=")[1];
    expect(await deps.db.all("SELECT email FROM viewer_session WHERE hash = ?", [await hashToken(secret)])).toEqual([{ email: LISTED }]);
    expect(JSON.stringify(await deps.db.all("SELECT * FROM viewer_session"))).not.toContain(secret);
    expect(JSON.stringify(await deps.db.all("SELECT * FROM viewer_code"))).not.toContain(code);
    // The session proves the address.
    expect(seen(await sessionOf(deps, cookieOf(done)))).toEqual({ status: 200, headers: API_HEADERS, body: JSON.stringify({ email: LISTED }) });
  });

  it("used, expired, unknown and malformed codes get one answer, byte for byte, and no cookie", async () => {
    const { deps, clock } = await site();
    const used = await storedCode(deps, LISTED);
    expect((await complete(deps, used)).status).toBe(200);
    const expired = await storedCode(deps, LISTED, SLUGS.restricted, VIEWER_CODE_MS);
    const unknown = "dpv_" + "0".repeat(40);
    const answers: Call[] = [];
    for (const code of [used, expired, unknown, "dpv_short", "dpl_" + "0".repeat(40), 7, null]) {
      clock.now += 1;
      for (const r of [await check(deps, code), await complete(deps, code)]) {
        expect(r.headers.getSetCookie()).toEqual([]);
        answers.push(r);
      }
    }
    for (const r of answers) expect(seen(r)).toEqual({ status: 404, headers: API_HEADERS, body: INVALID });
    // The last moment a code works, and the first it does not.
    const edge = await storedCode(deps, LISTED);
    clock.now += VIEWER_CODE_MS - 1;
    expect((await check(deps, edge)).status).toBe(200);
    clock.now += 1;
    expect((await check(deps, edge)).status).toBe(404);
    expect((await complete(deps, edge)).status).toBe(404);
  });

  it("of two completions of one code exactly one wins", async () => {
    const { deps } = await site();
    const code = await storedCode(deps, LISTED);
    const both = await Promise.all([complete(deps, code), complete(deps, code)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await countOf(deps, "viewer_session")).toBe(1);
    expect(await deps.db.all("SELECT event FROM audit WHERE event = 'viewer_signin'")).toHaveLength(1);
  });

  it("a code for one address can only ever prove that address", async () => {
    const { deps } = await site();
    const code = await storedCode(deps, LISTED);
    const r = await post(deps, "/api/v1/view/complete", { code, email: OTHER });
    expect(r.status).toBe(200);
    const cookie = cookieOf(r);
    expect((await sessionOf(deps, cookie)).json).toEqual({ email: LISTED });
    expect(await deps.db.all("SELECT email FROM viewer_session")).toEqual([{ email: LISTED }]);
    // A session row is only ever made from the code row that names it: an insert whose code names another session finds no address and fails.
    const sid = newId("vse");
    await expect(
      deps.db.run("INSERT INTO viewer_session (id, email, hash, created_at, last_used_at, expires_at) VALUES (?, (SELECT email FROM viewer_code WHERE code_hash = ? AND session_id = ?), ?, ?, ?, ?)", [
        sid,
        await hashToken(code),
        sid,
        "f".repeat(64),
        NOW,
        NOW,
        NOW + 1,
      ]),
    ).rejects.toThrow(/NOT NULL/);
  });

  it("completing replaces the viewer cookie the browser had: a new session, the old one ended, never merged", async () => {
    const { deps } = await site();
    const first = await viewerFor(deps, OTHER);
    const r = await complete(deps, await storedCode(deps, LISTED), { headers: { cookie: first } });
    expect(r.status).toBe(200);
    const second = cookieOf(r);
    expect(second).not.toBe(first);
    expect((await sessionOf(deps, first)).status).toBe(401);
    expect((await sessionOf(deps, second)).json).toEqual({ email: LISTED });
    expect(await deps.db.all("SELECT email FROM viewer_session")).toEqual([{ email: LISTED }]);
    // The same address again: still a new session id each time.
    const third = cookieOf(await complete(deps, await storedCode(deps, LISTED), { headers: { cookie: second } }));
    expect(third).not.toBe(second);
    expect((await sessionOf(deps, second)).status).toBe(401);
  });

  it("another site cannot complete a code into a visitor's browser, nor look one up", async () => {
    const { deps } = await site();
    // An attacker who may view a tour mails themself a link and tries to make a visitor's browser adopt that session.
    const code = await storedCode(deps, OTHER);
    const json = { "content-type": "application/json" };
    const body = JSON.stringify({ code });
    const tries: [string, Promise<Call>, number][] = [
      ["a page of another site", send(deps, "POST", "/api/v1/view/complete", { origin: TOURS, body, headers: { ...json, origin: "https://evil.example.net" } }), 403],
      ["the same site's other address", send(deps, "POST", "/api/v1/view/complete", { origin: TOURS, body, headers: { ...json, origin: APP, "sec-fetch-site": "same-site" } }), 403],
      ["a fetch the browser marks cross-site", complete(deps, code, { headers: { "sec-fetch-site": "cross-site" } }), 403],
      ["no origin at all", send(deps, "POST", "/api/v1/view/complete", { origin: TOURS, body, headers: json }), 403],
      ["an origin of null", send(deps, "POST", "/api/v1/view/complete", { origin: TOURS, body, headers: { ...json, origin: "null" } }), 403],
      ["a page of this host without https", send(deps, "POST", "/api/v1/view/complete", { origin: TOURS, body, headers: { ...json, origin: "http://tours.example.com" } }), 403],
      ["a form post", complete(deps, code, { headers: { "content-type": "application/x-www-form-urlencoded" } }), 400],
      ["a text/plain post", complete(deps, code, { headers: { "content-type": "text/plain" } }), 400],
    ];
    for (const [what, p, status] of tries) {
      const r = await p;
      expect(r.status, what).toBe(status);
      expect(r.headers.getSetCookie(), what).toEqual([]);
    }
    const lookups = await send(deps, "POST", "/api/v1/view/check", { origin: TOURS, body, headers: { ...json, origin: "https://evil.example.net" } });
    expect([lookups.status, lookups.text]).toEqual([403, BAD_ORIGIN]);
    // The code is untouched and no session was made.
    expect(await countOf(deps, "viewer_session")).toBe(0);
    expect((await check(deps, code)).status).toBe(200);
  });

  it("check and complete refuse a token, and are counted per network", async () => {
    const { deps } = await site();
    const code = await storedCode(deps, LISTED);
    for (const path of ["/api/v1/view/check", "/api/v1/view/complete"]) {
      const r = await post(deps, path, { code }, { token: "dp_" + "0".repeat(40) });
      expect(seen(r), path).toEqual({ status: 400, headers: API_HEADERS, body: CREDENTIALS });
    }
    for (let i = 0; i < LIMITS_VIEWER.codeNetwork.most; i++) expect((await check(deps, "dpv_" + "1".repeat(40), { app: from("203.0.113.40") })).status).toBe(404);
    const over = await complete(deps, code, { app: from("203.0.113.40") });
    expect([over.status, over.text]).toEqual([429, '{"error":"rate_limited"}']);
    expect(await countOf(deps, "viewer_session")).toBe(0);
    expect((await complete(deps, code, { app: from("198.51.100.40") })).status).toBe(200);
  });
});

describe("the viewer session", () => {
  it("sign-out ends the session on the server and clears the cookie", async () => {
    const { deps } = await site();
    const cookie = await viewerFor(deps, LISTED);
    const other = await viewerFor(deps, LISTED);
    const out = await send(deps, "POST", "/api/v1/view/signout", { origin: TOURS, headers: { cookie, origin: TOURS, "sec-fetch-site": "same-origin" } });
    expect([out.status, out.text, out.headers.getSetCookie()]).toEqual([204, "", [clearedViewerCookie()]]);
    expect(out.calls).toBe(1);
    // The secret no longer names anything, even when the browser keeps sending it.
    expect(seen(await sessionOf(deps, cookie))).toEqual({ status: 401, headers: API_HEADERS, body: UNAUTHORIZED });
    expect(await provedEmail(new Request(TOURS + "/t/x", { headers: { cookie } }), deps)).toBeNull();
    // The browser's other session (another browser) is untouched.
    expect((await sessionOf(deps, other)).json).toEqual({ email: LISTED });
    expect(await countOf(deps, "viewer_session")).toBe(1);
    // Without a viewer cookie it answers the same status, and sets and asks nothing; a malformed one is cleared.
    const none = await send(deps, "POST", "/api/v1/view/signout", { origin: TOURS, headers: { origin: TOURS } });
    expect([none.status, none.headers.getSetCookie(), none.calls]).toEqual([204, [], 0]);
    const broken = await send(deps, "POST", "/api/v1/view/signout", { origin: TOURS, headers: { origin: TOURS, cookie: `${VIEWER_COOKIE}=nonsense` } });
    expect([broken.status, broken.headers.getSetCookie(), broken.calls]).toEqual([204, [clearedViewerCookie()], 0]);
    // Another site cannot sign a browser out, nor can a request with a token.
    const forged = await send(deps, "POST", "/api/v1/view/signout", { origin: TOURS, headers: { cookie: other, origin: "https://evil.example.net" } });
    expect([forged.status, forged.text, forged.headers.getSetCookie()]).toEqual([403, BAD_ORIGIN, []]);
    const token = await send(deps, "POST", "/api/v1/view/signout", { origin: TOURS, token: "dp_" + "0".repeat(40), headers: { cookie: other, origin: TOURS } });
    expect([token.status, token.text]).toEqual([400, CREDENTIALS]);
    expect((await sessionOf(deps, other)).status).toBe(200);
  });

  it("lasts 30 days after its last use, is written at most once a day, and never lives past 180 days", async () => {
    const { deps, clock, settle } = await site();
    const cookie = await viewerFor(deps, LISTED);
    const req = () => new Request(TOURS + "/t/restricted", { headers: { cookie } });
    const row = () => deps.db.first<{ last_used_at: number; expires_at: number; created_at: number }>("SELECT last_used_at, expires_at, created_at FROM viewer_session");
    const made = (await row())!;
    expect(made).toEqual({ created_at: NOW, last_used_at: NOW, expires_at: NOW + VIEWER_IDLE_MS });
    // Within the day: one read, no write.
    clock.now = NOW + VIEWER_TOUCH_MS - 1;
    const kinds = recordKinds(deps);
    expect(await provedEmail(req(), deps)).toBe(LISTED);
    await settle();
    expect(kinds).toEqual(["first"]);
    // A day on: one read, and one write after it, handed to the work after the answer.
    clock.now = NOW + VIEWER_TOUCH_MS;
    kinds.length = 0;
    expect(await provedEmail(req(), deps)).toBe(LISTED);
    expect(kinds).toEqual(["first"]);
    await settle();
    expect(kinds).toEqual(["first", "run"]);
    expect(await row()).toEqual({ created_at: NOW, last_used_at: NOW + VIEWER_TOUCH_MS, expires_at: NOW + VIEWER_TOUCH_MS + VIEWER_IDLE_MS });
    // Unused for 30 days after that: over.
    clock.now = NOW + VIEWER_TOUCH_MS + VIEWER_IDLE_MS;
    expect(await provedEmail(req(), deps)).toBeNull();
    await settle();
    // Used every day: it still ends 180 days after it was made.
    const daily = await viewerFor(deps, LISTED);
    const start = clock.now;
    const used = () => provedEmail(new Request(TOURS + "/", { headers: { cookie: daily } }), deps);
    for (let day = 1; day * VIEWER_TOUCH_MS < VIEWER_MAX_MS; day += 7) {
      clock.now = start + day * VIEWER_TOUCH_MS;
      expect(await used(), `day ${day}`).toBe(LISTED);
      await settle();
    }
    clock.now = start + VIEWER_MAX_MS - 1;
    expect(await used()).toBe(LISTED);
    await settle();
    expect((await deps.db.first<{ expires_at: number }>("SELECT expires_at FROM viewer_session WHERE created_at = ?", [start]))!.expires_at).toBe(start + VIEWER_MAX_MS);
    clock.now = start + VIEWER_MAX_MS;
    expect(await used()).toBeNull();
    // The database itself refuses a session that would outlive its cap.
    await expect(deps.db.run("UPDATE viewer_session SET expires_at = created_at + ? WHERE created_at = ?", [VIEWER_MAX_MS + 1, start])).rejects.toThrow();
  });

  it("provedEmail makes no call without a viewer cookie and one with one, and proves nothing with a token beside it or two cookies", async () => {
    const { deps, owner } = await site();
    const cookie = await viewerFor(deps, LISTED);
    const account = await accountSession(deps, owner.userId);
    const kinds = recordKinds(deps);
    const at = (headers: Record<string, string>, origin = TOURS) => provedEmail(new Request(origin + "/t/restricted", { headers }), deps);
    const none: [string, Record<string, string>][] = [
      ["no cookie", {}],
      ["the account's session cookie", { cookie: account.cookie }],
      ["a viewer secret under the account's cookie name", { cookie: `${SESSION_COOKIE}=${cookie.split("=")[1]}` }],
      ["a token beside the viewer cookie", { cookie, authorization: "Bearer dp_" + "0".repeat(40) }],
      ["any Authorization header beside the viewer cookie", { cookie, authorization: "Basic eA==" }],
      ["the viewer cookie twice", { cookie: `${cookie}; ${cookie}` }],
      ["a malformed viewer cookie", { cookie: `${VIEWER_COOKIE}=dpw_${"Z".repeat(64)}` }],
      ["the account's secret under the viewer cookie's name", { cookie: `${VIEWER_COOKIE}=${account.secret}` }],
      ["the name in another case", { cookie: cookie.replace(VIEWER_COOKIE, VIEWER_COOKIE.toLowerCase()) }],
      ["another host's cookie with the name inside its value", { cookie: `x=a,${cookie}` }],
    ];
    for (const [what, headers] of none) {
      kinds.length = 0;
      expect(await at(headers), what).toBeNull();
      expect(kinds, what).toEqual([]);
    }
    kinds.length = 0;
    expect(await at({ cookie: `${account.cookie}; ${cookie}` })).toBe(LISTED);
    expect(kinds).toEqual(["first"]);
    kinds.length = 0;
    expect(await at({ cookie: `${VIEWER_COOKIE}=dpw_${"0".repeat(64)}` })).toBeNull();
    expect(kinds).toEqual(["first"]);
    // On the app address the viewer cookie is nothing, and nothing is asked.
    kinds.length = 0;
    expect(await at({ cookie }, APP)).toBeNull();
    expect(kinds).toEqual([]);
  });

  it("GET session answers the address, refuses a token, and is 401 for anything that proves nothing", async () => {
    const { deps } = await site();
    const cookie = await viewerFor(deps, LISTED);
    expect(seen(await sessionOf(deps, cookie))).toEqual({ status: 200, headers: API_HEADERS, body: JSON.stringify({ email: LISTED }) });
    expect(seen(await sessionOf(deps, null))).toEqual({ status: 401, headers: API_HEADERS, body: UNAUTHORIZED });
    const token = await send(deps, "GET", "/api/v1/view/session", { origin: TOURS, token: "dp_" + "0".repeat(40), headers: { cookie } });
    expect(seen(token)).toEqual({ status: 400, headers: API_HEADERS, body: CREDENTIALS });
    expect((await sessionOf(deps, cookie)).headers.getSetCookie()).toEqual([]);
  });

  it("the routes make no more database calls than this", async () => {
    const { deps, mail } = await site();
    // Asking: three counts, the gate's read, the two caps, two sweeps; the job's two and the mail; with a known network one more.
    expect((await ask(deps, LISTED, SLUGS.restricted)).calls).toBe(11);
    expect((await ask(deps, LISTED, SLUGS.second, { app: from("203.0.113.50") })).calls).toBe(12);
    expect((await ask(deps, OTHER, SLUGS.second)).calls).toBe(10);
    const code = codeIn(mail.sent[0].text);
    // Looking up: one read (and the network's count when it is known). Completing: one read and one batch.
    expect((await check(deps, code)).calls).toBe(1);
    expect((await check(deps, code, { app: from("203.0.113.51") })).calls).toBe(2);
    const done = await complete(deps, code, { app: from("203.0.113.52") });
    expect([done.status, done.calls]).toEqual([200, 3]);
    expect((await sessionOf(deps, cookieOf(done))).calls).toBe(1);
    expect((await sessionOf(deps, null)).calls).toBe(0);
  });

  it("disabling or deleting an account does not end a viewer session for the same address", async () => {
    const { deps, owner } = await site();
    const target = await seedAccount(deps, { username: "rook" });
    const viewer = await viewerFor(deps, target.email);
    const admin = await accountSession(deps, owner.userId);
    const asAdmin = (method: string, path: string, json?: unknown) =>
      send(deps, method, path, { origin: APP, body: json === undefined ? undefined : JSON.stringify(json), headers: { cookie: admin.cookie, origin: APP, "x-csrf-token": admin.csrf, "sec-fetch-site": "same-origin", ...(json === undefined ? {} : { "content-type": "application/json" }) } });
    // In one-address mode the admin's routes and the viewer's share one host; here two addresses keep them apart.
    expect((await asAdmin("POST", `/api/v1/admin/accounts/${target.userId}/disable`)).status).toBe(204);
    expect((await sessionOf(deps, viewer)).json).toEqual({ email: target.email });
    let r = await asAdmin("DELETE", `/api/v1/admin/accounts/${target.userId}`, { username: "rook" });
    for (let i = 0; r.status === 202 && i < 10; i++) r = await asAdmin("DELETE", `/api/v1/admin/accounts/${target.userId}`, { username: "rook" });
    expect(r.status).toBe(200);
    expect(await countOf(deps, "user")).toBe(2);
    expect((await sessionOf(deps, viewer)).json).toEqual({ email: target.email });
  });

  it("the audit record says a link was sent and a viewer signed in, by ids alone", async () => {
    const { deps, mail } = await site();
    await ask(deps, LISTED, SLUGS.restricted);
    const done = await complete(deps, codeIn(mail.sent[0].text));
    const rows = await deps.db.all<{ event: string; user_id: string | null; workspace_id: string | null; subject: string; detail: string | null }>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event LIKE 'viewer_%' ORDER BY at, event");
    const codeId = (await deps.db.first<{ id: string; session_id: string }>("SELECT id, session_id FROM viewer_code"))!;
    expect(rows).toEqual([
      { event: "viewer_link_sent", user_id: null, workspace_id: null, subject: codeId.id, detail: null },
      { event: "viewer_signin", user_id: null, workspace_id: null, subject: codeId.session_id, detail: null },
    ]);
    const text = JSON.stringify(await deps.db.all("SELECT * FROM audit"));
    expect(text).not.toContain(LISTED);
    expect(text).not.toMatch(/dp[vw]_/);
    expect(done.text).not.toMatch(/dp[vw]_/);
    // The audit writer refuses the two new secrets wherever they would go.
    for (const secret of ["dpv_" + "a".repeat(40), "dpw_" + "b".repeat(64)]) {
      expect(() => auditStatement(deps, { event: "viewer_signin", subject: secret })).toThrow("audit: a value that must not be recorded");
      expect(() => auditStatement(deps, { event: "viewer_signin", detail: { k: secret.slice(0, 12) } })).toThrow("audit: a value that must not be recorded");
    }
  });

  it("no code, secret or address reaches a log line", async () => {
    const { deps, mail } = await site();
    const lines: string[] = [];
    for (const m of ["error", "log", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    mail.failNext();
    await ask(deps, LISTED, SLUGS.restricted);
    await ask(deps, LISTED, SLUGS.restricted);
    const done = await complete(deps, codeIn(mail.sent[0].text));
    await sessionOf(deps, cookieOf(done));
    const text = lines.join("\n");
    expect(lines).toContain(`${VIEWER_LINES.mailFailed} (failed)`);
    expect(text).not.toMatch(/dp[vw]_|@/);
  });

  it("sweeps remove ended sessions and codes a day after they ran out, and nothing live", async () => {
    const { deps, clock } = await site();
    const live = await viewerFor(deps, LISTED);
    await storedCode(deps, LISTED);
    clock.now += VIEWER_IDLE_MS;
    const fresh = await viewerFor(deps, OTHER);
    await storedCode(deps, OTHER);
    await sweepViewers(deps);
    expect(await deps.db.all("SELECT email FROM viewer_session")).toEqual([{ email: OTHER }]);
    // Codes: the two used ones and two unused; those that ran out a day ago or more go.
    expect(await countOf(deps, "viewer_code")).toBe(2);
    expect((await sessionOf(deps, live)).status).toBe(401);
    expect((await sessionOf(deps, fresh)).status).toBe(200);
    // Asking for a link sweeps too.
    clock.now += VIEWER_IDLE_MS;
    await ask(deps, OTHER, SLUGS.none);
    expect(await countOf(deps, "viewer_session")).toBe(0);
    expect(await countOf(deps, "viewer_code")).toBe(0);
  });
});

describe("the viewer cookie and the account session never stand in for each other", () => {
  for (const [mode, config, tours, app] of [
    ["one address", {}, "https://site.example.com", "https://site.example.com"],
    ["two addresses", { hosts: TWO }, TOURS, APP],
    ["three addresses", { hosts: THREE }, TOURS, APP],
  ] as const) {
    it(`in ${mode}`, async () => {
      const { deps, owner } = await site(config);
      const viewer = await viewerFor(deps, owner.email, tours);
      const account = await accountSession(deps, owner.userId);
      const viewerSecret = viewer.split("=")[1];
      // The account's routes: a viewer cookie, alone or under the account cookie's name, is no session.
      for (const cookie of [viewer, `${SESSION_COOKIE}=${viewerSecret}`]) {
        for (const path of ["/api/v1/session", "/api/v1/tours", "/api/v1/me"]) {
          const r = await send(deps, "GET", path, { origin: app, headers: { cookie } });
          expect([r.status, r.text], `${path} with ${cookie.split("=")[0]}`).toEqual([401, UNAUTHORIZED]);
        }
      }
      expect((await send(deps, "GET", "/api/v1/session", { origin: app, headers: { cookie: account.cookie } })).status).toBe(200);
      // With both cookies the account's session is the account's alone, and the same answer as with it alone.
      const both = await send(deps, "GET", "/api/v1/session", { origin: app, headers: { cookie: `${account.cookie}; ${viewer}` } });
      const alone = await send(deps, "GET", "/api/v1/session", { origin: app, headers: { cookie: account.cookie } });
      expect(seen(both)).toEqual(seen(alone));
      // The viewer's routes: an account session, alone or under the viewer cookie's name, proves no address.
      for (const cookie of [account.cookie, `${VIEWER_COOKIE}=${account.secret}`]) {
        const r = await sessionOf(deps, cookie, tours);
        expect([r.status, r.text], cookie.split("=")[0]).toEqual([401, UNAUTHORIZED]);
        expect(await provedEmail(new Request(tours + "/t/restricted", { headers: { cookie } }), deps)).toBeNull();
      }
      expect((await sessionOf(deps, viewer, tours)).json).toEqual({ email: owner.email });
      if (mode !== "one address") {
        // On the app address (and the img address) the viewer routes do not answer, and provedEmail proves nothing there.
        for (const origin of mode === "three addresses" ? [APP, IMG] : [APP]) {
          const r = await send(deps, "GET", "/api/v1/view/session", { origin, headers: { cookie: viewer } });
          expect([r.status, r.text]).toEqual([404, '{"error":"not_found"}']);
          expect(await provedEmail(new Request(origin + "/", { headers: { cookie: viewer } }), deps)).toBeNull();
        }
        // The account's session cookie on the tours address is no session of the account either, as before.
        expect((await send(deps, "GET", "/api/v1/me", { origin: tours, headers: { cookie: account.cookie } })).status).toBe(401);
      }
    });
  }
});

describe("the recipient key a link request counts", () => {
  it("is the address's own, and a malformed address is counted under one key that no address has", async () => {
    const { deps } = await site();
    await ask(deps, `  ${LISTED.toUpperCase()}`, SLUGS.open);
    await ask(deps, "not an address", SLUGS.open);
    await ask(deps, 12, SLUGS.open);
    expect(await counter(deps, LIMITS_VIEWER.linkRecipient.bucket, await recipientKey(LISTED))).toBe(1);
    expect(await counter(deps, LIMITS_VIEWER.linkRecipient.bucket, await recipientKey(""))).toBe(2);
  });
});
