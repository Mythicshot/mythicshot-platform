// Connecting the desktop app (src/connect.ts) and the workspace's tokens (src/tokens.ts), on
// both targets: the pair of codes, the dashboard's lookup, confirm and refusal, collecting
// the token once, the limits on guessing a short code, and listing, renaming and revoking
// tokens. Nothing here contacts anything: every request goes to the app through the harness.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { hashToken } from "../src/auth.ts";
import { createApp } from "../src/app.ts";
import { setClientAddress } from "../src/client.ts";
import { CONNECT_MS, CONNECT_SWEEP_PAGE, OPEN_PER_NETWORK, OPEN_UNKNOWN_NETWORK, POLL_GAP_MS, USER_CODE_ALPHABET, formatUserCode, newUserCode, parseDeviceName, parseUserCode } from "../src/connect.ts";
import type { Config, Db, Deps } from "../src/ports.ts";
import { LIMITS_CONNECT, accountKey, networkKey } from "../src/rate.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, send, type Call, type SendOptions } from "./bundle.ts";

const NOW = 1_800_000_000_000;
const TWO: Partial<Config> = { hosts: { tours: "tours.example.com", app: "app.example.com" } };
const APP = "https://app.example.com";
const TOURS = "https://tours.example.com";
const NET_A = "203.0.113.10";
const NET_B = "198.51.100.20";

const EXPIRED = '{"error":"expired_code","detail":"this code has expired or was already used; start again"}';
const NO_REQUEST = '{"error":"not_found","detail":"no such request"}';
const NO_TOKEN = '{"error":"not_found","detail":"no such token"}';
const UNAUTHORIZED = '{"error":"unauthorized"}';
const API_HEADERS = [
  ["cache-control", "no-store"],
  ["content-type", "application/json"],
  ["x-content-type-options", "nosniff"],
];
const DEVICE_CODE = /^dpd_[0-9a-f]{40}$/;
const USER_CODE = new RegExp(`^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`);

/** A site with a clock the test moves, an admin and two more accounts, each with its own workspace. */
async function site(config: Partial<Config> = {}) {
  const made = await makeDeps(config);
  const clock = { now: NOW };
  made.deps.now = () => clock.now;
  const admin = await seedAccount(made.deps, { admin: true, username: "boss" });
  const a = await seedAccount(made.deps, { username: "alice" });
  const b = await seedAccount(made.deps, { username: "bob" });
  await made.deps.db.run("UPDATE workspace SET name = 'Alice workspace' WHERE id = ?", [a.workspaceId]);
  await made.deps.db.run("UPDATE workspace SET name = 'Bob workspace' WHERE id = ?", [b.workspaceId]);
  return { ...made, clock, admin, a, b, tick: (ms: number) => void (clock.now += ms) };
}

type Signed = { secret: string; sessionId: string; userId: string; cookie: string; csrf: string };

async function signIn(deps: Deps, userId: string): Promise<Signed> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { ...made, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** The app with the client address an entry would have set for every request. */
const from = (address: string) => (deps: Deps) => ({
  fetch: (req: Request) => {
    setClientAddress(req, address);
    return createApp(deps).fetch(req);
  },
});

type More = SendOptions & { address?: string };
const opts = (more: More): SendOptions => ({ ...more, ...(more.address !== undefined ? { app: from(more.address) } : {}) });

/** What the app sends: JSON, no credential. */
function appPost(deps: Deps, path: string, body: unknown, more: More = {}): Promise<Call> {
  return send(deps, "POST", path, { ...opts(more), body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...more.headers } });
}
const start = (deps: Deps, name: unknown = "Work laptop", more: More = {}) => appPost(deps, "/api/v1/connect/start", { device_name: name }, more);
const poll = (deps: Deps, code: unknown, more: More = {}) => appPost(deps, "/api/v1/connect/token", { device_code: code }, more);

/** The headers the site's own page sends a change with. */
const page = (s: Signed, origin = ORIGIN): Record<string, string> => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin", "content-type": "application/json" });

const lookup = (deps: Deps, s: Signed, code: string, more: More = {}) =>
  send(deps, "POST", "/api/v1/connect/lookup", { ...opts(more), body: JSON.stringify({ user_code: code }), headers: { ...page(s, more.origin), ...more.headers } });
const settle = (how: "confirm" | "refuse") => (deps: Deps, s: Signed, code: unknown, more: More = {}) =>
  send(deps, "POST", `/api/v1/connect/${how}`, { ...opts(more), body: JSON.stringify({ user_code: code }), headers: { ...page(s, more.origin), ...more.headers } });
const confirm = settle("confirm");
const refuse = settle("refuse");

const listTokens = (deps: Deps, s: Signed, more: More = {}) => send(deps, "GET", "/api/v1/tokens", { ...opts(more), headers: { cookie: s.cookie } });
const rename = (deps: Deps, s: Signed, id: string, name: unknown) => send(deps, "PATCH", `/api/v1/tokens/${id}`, { body: JSON.stringify({ name }), headers: page(s) });
const revoke = (deps: Deps, s: Signed, id: string) => send(deps, "DELETE", `/api/v1/tokens/${id}`, { headers: page(s) });

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

const countOf = async (deps: Deps, table: string) => (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
const counter = async (deps: Deps, bucket: string, key: string) =>
  (await deps.db.first<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM rate_counter WHERE bucket = ? AND key = ?", [bucket, key]))!.n;

/** Every row of every table of the app, as one text. */
async function everythingStored(deps: Deps, leaveOut: string[] = []): Promise<string> {
  const tables = await deps.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT IN ('_migrations', 'd1_migrations') ORDER BY name");
  let text = "";
  for (const t of tables) if (!leaveOut.includes(t.name)) text += JSON.stringify(await deps.db.all(`SELECT * FROM "${t.name}"`));
  return text;
}

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

/** Starts a request and confirms it as `s`; answers both codes. */
async function confirmed(deps: Deps, s: Signed, name = "Work laptop", more: More = {}): Promise<{ deviceCode: string; userCode: string }> {
  const r = await start(deps, name, more);
  expect(r.status, r.text).toBe(201);
  const c = await confirm(deps, s, r.json.user_code, more);
  expect(c.status, c.text).toBe(204);
  return { deviceCode: r.json.device_code, userCode: r.json.user_code };
}

describe("the codes", () => {
  it("a user code is 8 characters of the alphabet, shown with a dash, read in any case with or without it", () => {
    expect(USER_CODE_ALPHABET).toHaveLength(30);
    for (const ch of "0O1IL") expect(USER_CODE_ALPHABET, ch).not.toContain(ch);
    expect(new Set(USER_CODE_ALPHABET).size).toBe(30);
    const seenChars = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const code = newUserCode();
      expect(code).toMatch(new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`));
      for (const ch of code) seenChars.add(ch);
      expect(parseUserCode(formatUserCode(code))).toBe(code);
      expect(parseUserCode(code.toLowerCase())).toBe(code);
      expect(parseUserCode(` ${formatUserCode(code).toLowerCase()} `)).toBe(code);
    }
    expect(seenChars.size).toBe(30);
    for (const bad of ["", "ABCD-EFG", "ABCD-EFGHJ", "ABCDE-FGH", "AB-CD-EF-GH", "ABCD EFGH", "ABCD-EFG0", "ABCD-EFGI", "ABCD-EFGL", "ABCD-EFGO", "ABCD-EFG1", "ſBCD-EFGH", "ABCD–EFGH", 12345678, null, "A".repeat(40)]) {
      expect(parseUserCode(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("a device name is trimmed text of 1 to 60 characters without control or formatting characters", () => {
    expect(parseDeviceName("  Work laptop ")).toBe("Work laptop");
    expect(parseDeviceName("é".repeat(60))).toBe("é".repeat(60));
    expect(parseDeviceName("😀".repeat(60))).toBe("😀".repeat(60));
    for (const bad of ["", "   ", "x".repeat(61), "😀".repeat(61), "a\u0007b", "a\nb", "a​b", "a‮b", "a b", "a­b", "a﻿b", "a\ud800b", "a\u0000b", 5, null, ["x"]]) {
      expect(parseDeviceName(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("starting a request", () => {
  it("answers both codes, the Connections page from the settings, 600 seconds and 5; only digests of the codes are stored", async () => {
    const { deps } = await site(TWO);
    const r = await start(deps, "  Work laptop ", { origin: TOURS });
    expect(r.status, r.text).toBe(201);
    expect(Object.keys(r.json)).toEqual(["device_code", "user_code", "verify_url", "expires_in", "interval"]);
    expect(r.json.device_code).toMatch(DEVICE_CODE);
    expect(r.json.user_code).toMatch(USER_CODE);
    expect(r.json).toMatchObject({ verify_url: `${APP}/connections`, expires_in: 600, interval: 5 });
    expect([...r.headers.entries()].sort()).toEqual(API_HEADERS);
    // The app address too answers it, with the same page.
    const onApp = await start(deps, "Other", { origin: APP });
    expect([onApp.status, onApp.json.verify_url]).toEqual([201, `${APP}/connections`]);

    const rows = await deps.db.all<Record<string, unknown>>("SELECT * FROM connect_request ORDER BY created_at, device_name DESC");
    expect(rows[0]).toEqual({
      id: expect.stringMatching(/^crq_[0-9a-f]{24}$/),
      device_code_hash: await hashToken(r.json.device_code),
      user_code_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      device_name: "Work laptop",
      network_key: null,
      created_at: NOW,
      expires_at: NOW + CONNECT_MS,
      last_poll_at: null,
      confirmed_at: null,
      confirmed_by: null,
      confirmed_session: null,
      workspace_id: null,
      token_id: null,
      refused_at: null,
      collected_at: null,
    });
    // The user code's digest is keyed: not the plain digest of the code in any of its forms.
    const userCode = parseUserCode(r.json.user_code)!;
    for (const form of [userCode, r.json.user_code, "connect user code\n" + userCode]) expect(rows[0].user_code_hash).not.toBe(await hashToken(form));
    // Neither code is anywhere in the database, in any form.
    const stored = await everythingStored(deps);
    for (const text of [r.json.device_code, r.json.device_code.slice(4), userCode, r.json.user_code]) expect(stored).not.toContain(text);
    // The key is the install's own: 64 hex characters.
    expect(await deps.db.first("SELECT key FROM connect_key")).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("the Connections page comes from the settings, never from the request, and is a bare path without them", async () => {
    const one = await site({ siteHost: "demo.example.com" });
    for (const origin of [ORIGIN, "https://evil.example.net", "http://localhost:8787"]) {
      const r = await start(one.deps, "x", { origin, headers: { host: "evil.example.net", "x-forwarded-host": "evil.example.net" } });
      expect(r.json.verify_url, origin).toBe("https://demo.example.com/connections");
    }
    const bare = await site();
    expect((await start(bare.deps, "x", { origin: "https://evil.example.net" })).json.verify_url).toBe("/connections");
    // Never a code in it.
    const r = await start(bare.deps, "x");
    expect(r.json.verify_url).not.toContain(r.json.user_code);
  });

  it("refuses a name it cannot show, a body that is not JSON, and any credential, storing nothing", async () => {
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    const badName = '{"error":"bad_device_name","detail":"the device name must be 1 to 60 characters of text, without control or formatting characters"}';
    for (const name of ["", " ", "x".repeat(61), "a\u0007b", "a‮b", "a​b", 5, null]) {
      const r = await start(deps, name);
      expect([r.status, r.text], JSON.stringify(name)).toEqual([400, badName]);
    }
    const lone = await appPost(deps, "/api/v1/connect/start", '{"device_name":"a\\ud800b"}');
    expect([lone.status, lone.text]).toEqual([400, badName]);
    for (const body of ["not json", "[]", "null", '"x"']) expect((await appPost(deps, "/api/v1/connect/start", body)).json.error, body).toBe("bad_request");
    const plain = await send(deps, "POST", "/api/v1/connect/start", { body: JSON.stringify({ device_name: "x" }), headers: { "content-type": "text/plain" } });
    expect(plain.json.error).toBe("bad_request");
    const tooLong = await appPost(deps, "/api/v1/connect/start", JSON.stringify({ device_name: "x", pad: "y".repeat(3000) }));
    expect(tooLong.json.error).toBe("bad_request");
    // A token, a session cookie, or anything in Authorization: refused before anything is read.
    const refused = '{"error":"credentials_not_allowed","detail":"send no token and no session cookie with this request"}';
    for (const headers of [{ authorization: `Bearer ${a.token}` } as Record<string, string>, { authorization: "Basic eA==" }, { cookie: s.cookie }, { cookie: `${SESSION_COOKIE}=nonsense` }]) {
      for (const path of ["/api/v1/connect/start", "/api/v1/connect/token"]) {
        const r = await appPost(deps, path, { device_name: "x", device_code: "dpd_" + "0".repeat(40) }, { headers });
        expect([r.status, r.text], `${path} ${JSON.stringify(headers)}`).toEqual([400, refused]);
        expect(r.calls).toBe(0);
      }
    }
    expect(await countOf(deps, "connect_request")).toBe(0);
  });

  it("one network asks at most 10 times in 15 minutes and 40 in a day, and has at most 5 requests open", async () => {
    const { deps, tick } = await site();
    // Five open at once; the sixth waits for one to end.
    for (let i = 0; i < OPEN_PER_NETWORK; i++) expect((await start(deps, `d${i}`, { address: NET_A })).status).toBe(201);
    const full = await start(deps, "d5", { address: NET_A });
    expect([full.status, full.json.error, full.headers.get("retry-after")]).toEqual([429, "rate_limited", "600"]);
    expect(full.json.detail).toContain("too many requests waiting");
    // Another network is not held back.
    expect((await start(deps, "other", { address: NET_B })).status).toBe(201);
    // Once they expire, there is room again; the six asks so far count toward the limit of 10.
    tick(CONNECT_MS);
    for (let i = 0; i < 4; i++) expect((await start(deps, `e${i}`, { address: NET_A })).status).toBe(201);
    const over = await start(deps, "e4", { address: NET_A });
    expect([over.status, over.json.error]).toEqual([429, "rate_limited"]);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(over.json.detail).toBe("too many requests; wait a few minutes and try again");
    expect(await counter(deps, LIMITS_CONNECT.startNetwork.bucket, (await networkKey(NET_A))!)).toBe(11);
    // The day's limit: every ask is counted, the refused ones too, up to 40.
    let asked = 11;
    while (asked < 40) {
      tick(LIMITS_CONNECT.startNetwork.windowMs + CONNECT_MS);
      for (let i = 0; i < 5 && asked < 40; i++, asked++) expect((await start(deps, `f${asked}`, { address: NET_A })).status, `ask ${asked + 1}`).toBe(201);
    }
    tick(LIMITS_CONNECT.startNetwork.windowMs + CONNECT_MS);
    expect((await start(deps, "one more", { address: NET_A })).status).toBe(429);
  });

  it("callers whose network is not known share one cap on open requests", async () => {
    const { deps } = await site();
    await deps.db.batch(
      Array.from({ length: OPEN_UNKNOWN_NETWORK - 1 }, (_, i) => ({
        sql: "INSERT INTO connect_request (id, device_code_hash, user_code_hash, device_name, created_at, expires_at) VALUES (?, ?, ?, 'x', ?, ?)",
        params: ["crq_" + i.toString(16).padStart(24, "0"), i.toString(16).padStart(64, "0"), (i + 1000).toString(16).padStart(64, "0"), NOW, NOW + CONNECT_MS],
      })),
    );
    expect((await start(deps, "last")).status).toBe(201);
    expect((await start(deps, "too many")).status).toBe(429);
    // A known network has its own count.
    expect((await start(deps, "known", { address: NET_A })).status).toBe(201);
  });

  it("expired requests are swept by later starts, at most a page at a time", async () => {
    const { deps, tick } = await site();
    await deps.db.batch(
      Array.from({ length: CONNECT_SWEEP_PAGE + 5 }, (_, i) => ({
        sql: "INSERT INTO connect_request (id, device_code_hash, user_code_hash, device_name, created_at, expires_at) VALUES (?, ?, ?, 'x', ?, ?)",
        params: ["crq_" + i.toString(16).padStart(24, "0"), i.toString(16).padStart(64, "0"), (i + 1000).toString(16).padStart(64, "0"), NOW, NOW + 1000],
      })),
    );
    tick(2000);
    await start(deps);
    expect(await countOf(deps, "connect_request")).toBe(5 + 1);
    await start(deps);
    expect(await countOf(deps, "connect_request")).toBe(2);
  });
});

describe("collecting the token", () => {
  it("pending until confirmed, then the token for the confirming workspace, once, and the record says who", async () => {
    const { deps, a, b, tick } = await site();
    const s = await signIn(deps, a.userId);
    const r = await start(deps, "Alice's laptop");
    const code = r.json.device_code as string;
    const pending = await poll(deps, code);
    expect(seen(pending)).toEqual({ status: 200, headers: API_HEADERS, body: '{"status":"pending"}' });

    // The dashboard: the name and when it asked, then confirm.
    const found = await lookup(deps, s, r.json.user_code);
    expect(found.json).toEqual({ device_name: "Alice's laptop", asked_at: NOW, same_network: false });
    expect((await confirm(deps, s, r.json.user_code)).status).toBe(204);
    const row = (await deps.db.first<{ token_id: string; workspace_id: string; confirmed_by: string }>("SELECT token_id, workspace_id, confirmed_by FROM connect_request"))!;
    expect(row).toEqual({ token_id: expect.stringMatching(/^tok_[0-9a-f]{24}$/), workspace_id: a.workspaceId, confirmed_by: a.userId });
    // No token yet: it is made when it is collected.
    expect(await deps.db.first("SELECT 1 AS x FROM api_token WHERE id = ?", [row.token_id])).toBeNull();

    tick(POLL_GAP_MS);
    const got = await poll(deps, code);
    expect(got.status, got.text).toBe(200);
    expect(got.json).toEqual({ status: "connected", token: expect.stringMatching(/^dp_[0-9a-f]{40}$/), workspace: { id: a.workspaceId, name: "Alice workspace" }, account: { username: "alice" }, version: expect.any(String) });
    const token = got.json.token as string;
    // The token is the confirming workspace's, and nobody else's.
    const me = await send(deps, "GET", "/api/v1/me", { token });
    expect(me.json.workspace).toBe("Alice workspace");
    expect(await deps.db.first("SELECT id, workspace_id, name, kind, hash, revoked_at FROM api_token WHERE id = ?", [row.token_id])).toEqual({ id: row.token_id, workspace_id: a.workspaceId, name: "Alice's laptop", kind: "sign_in", hash: await hashToken(token), revoked_at: null });
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM api_token WHERE workspace_id = ?", [b.workspaceId])).toEqual({ n: 1 });

    // Once: asked again, the code is spent.
    tick(POLL_GAP_MS);
    expect(seen(await poll(deps, code))).toEqual({ status: 410, headers: API_HEADERS, body: EXPIRED });
    expect(await countOf(deps, "api_token")).toBe(4);

    // The record: who confirmed, the token's id, the request; never a code or the token.
    const audit = await deps.db.all<Record<string, unknown>>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event LIKE 'connection%' ORDER BY event");
    const id = (await deps.db.first<{ id: string }>("SELECT id FROM connect_request"))!.id;
    expect(audit).toEqual([
      { event: "connection_collected", user_id: a.userId, workspace_id: a.workspaceId, subject: row.token_id, detail: JSON.stringify({ request: id }) },
      { event: "connection_confirmed", user_id: a.userId, workspace_id: a.workspaceId, subject: row.token_id, detail: JSON.stringify({ request: id }) },
    ]);
    const stored = await everythingStored(deps);
    for (const text of [code, code.slice(4), token, token.slice(3), parseUserCode(r.json.user_code)!]) expect(stored).not.toContain(text);
  });

  it("in two-address mode the answer names both addresses, as GET /api/v1/me does", async () => {
    const { deps, a, tick } = await site(TWO);
    const s = await signIn(deps, a.userId);
    const { deviceCode } = await confirmed(deps, s, "Laptop", { origin: APP });
    tick(1);
    const got = await poll(deps, deviceCode, { origin: TOURS });
    expect(got.json.addresses).toEqual({ tours: "tours.example.com", app: "app.example.com" });
    const me = await send(deps, "GET", "/api/v1/me", { token: got.json.token, origin: TOURS });
    expect(me.json.addresses).toEqual(got.json.addresses);
  });

  it("unknown, expired, refused, collected and malformed codes are answered alike: status, body, headers and database calls", async () => {
    const { deps, a, tick } = await site();
    const s = await signIn(deps, a.userId);
    const collected = await confirmed(deps, s, "collected");
    tick(1);
    expect((await poll(deps, collected.deviceCode)).json.status).toBe("connected");
    const refusedReq = await start(deps, "refused");
    expect((await refuse(deps, s, refusedReq.json.user_code)).status).toBe(204);
    const expiredPending = await start(deps, "expired pending");
    const expiredConfirmed = await confirmed(deps, s, "expired confirmed");
    const live = await start(deps, "live");
    tick(CONNECT_MS - 1);
    const fresh = await start(deps, "fresh");
    tick(1);

    const kinds = recordKinds(deps);
    const cases: [string, unknown][] = [
      ["unknown", "dpd_" + "0".repeat(40)],
      ["expired while pending", expiredPending.json.device_code],
      ["expired once confirmed", expiredConfirmed.deviceCode],
      ["refused", refusedReq.json.device_code],
      ["collected", collected.deviceCode],
      ["live but expired now", live.json.device_code],
      ["in capitals", fresh.json.device_code.toUpperCase()],
      ["one character short", fresh.json.device_code.slice(0, -1)],
      ["without its prefix", fresh.json.device_code.slice(4)],
      ["a token", a.token],
      ["the empty text", ""],
      ["a number", 12],
      ["null", null],
      ["missing", undefined],
    ];
    const answers: { what: string; seen: ReturnType<typeof seen>; calls: string[] }[] = [];
    for (const [what, code] of cases) {
      const r = await poll(deps, code);
      answers.push({ what, seen: seen(r), calls: kinds.splice(0) });
    }
    for (const x of answers) {
      expect(x.seen, x.what).toEqual({ status: 410, headers: API_HEADERS, body: EXPIRED });
      // No network is known here: one read each, nothing written.
      expect(x.calls, x.what).toEqual(["first"]);
    }
    // From a known network: its count, then the one read, for every one of them.
    for (const [what, code] of cases) {
      const r = await poll(deps, code, { address: NET_A });
      expect([seen(r), kinds.splice(0)], what).toEqual([{ status: 410, headers: API_HEADERS, body: EXPIRED }, ["first", "first"]]);
    }
    // Asking fast changes nothing: a code that cannot give a token is never slow_down.
    expect((await poll(deps, "dpd_" + "0".repeat(40))).status).toBe(410);
    // The fresh one is still pending.
    expect((await poll(deps, fresh.json.device_code)).json).toEqual({ status: "pending" });
  });

  it("two collections at once give the token to exactly one", async () => {
    const { deps, a, tick } = await site();
    const s = await signIn(deps, a.userId);
    const { deviceCode } = await confirmed(deps, s);
    tick(1);
    const both = await Promise.all([poll(deps, deviceCode), poll(deps, deviceCode)]);
    const statuses = both.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 410]);
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM api_token WHERE kind = 'sign_in'")).toEqual({ n: 1 });

    // And when the second has read the request before the first collects it: its batch makes nothing.
    const second = await confirmed(deps, s, "second");
    tick(1);
    const realBatch = deps.db.batch.bind(deps.db);
    let raced: Call | null = null;
    deps.db.batch = async (stmts) => {
      if (raced === null && stmts.some((x) => x.sql.includes("INSERT INTO api_token"))) {
        deps.db.batch = realBatch;
        // Another collection runs to its end between this one's read and its batch.
        raced = await poll(deps, second.deviceCode);
      }
      return realBatch(stmts);
    };
    const late = await poll(deps, second.deviceCode);
    deps.db.batch = realBatch;
    expect((raced as Call | null)?.status).toBe(200);
    expect(seen(late)).toEqual({ status: 410, headers: API_HEADERS, body: EXPIRED });
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM api_token WHERE kind = 'sign_in'")).toEqual({ n: 2 });
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM audit WHERE event = 'connection_collected'")).toEqual({ n: 2 });
  });

  it("a confirmation nobody collects leaves no token, and none can be collected once it has expired", async () => {
    const { deps, a, tick } = await site();
    const s = await signIn(deps, a.userId);
    const { deviceCode } = await confirmed(deps, s);
    const tokenId = (await deps.db.first<{ token_id: string }>("SELECT token_id FROM connect_request"))!.token_id;
    tick(CONNECT_MS);
    expect((await poll(deps, deviceCode)).text).toBe(EXPIRED);
    expect(await deps.db.first("SELECT 1 AS x FROM api_token WHERE id = ?", [tokenId])).toBeNull();
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM api_token WHERE kind = 'sign_in'")).toEqual({ n: 0 });
    // Swept by a later start, and still no token.
    await start(deps);
    expect(await deps.db.first("SELECT 1 AS x FROM connect_request WHERE token_id = ?", [tokenId])).toBeNull();
    expect(await countOf(deps, "api_token")).toBe(3);
  });

  it("no token once the confirming session has ended: revoked, signed out everywhere or expired before the app collects", async () => {
    const { deps, a, tick } = await site();
    const endings: [string, (s: Signed) => Promise<void>][] = [
      ["ended from another browser", async (s) => {
        const other = await signIn(deps, a.userId);
        expect((await send(deps, "DELETE", `/api/v1/sessions/${s.sessionId}`, { headers: page(other) })).status).toBe(204);
      }],
      ["signed out", async (s) => void expect((await send(deps, "POST", "/api/v1/signout", { headers: page(s) })).status).toBe(204)],
      ["signed out everywhere", async (s) => void expect((await send(deps, "POST", "/api/v1/signout/everywhere", { headers: page(s) })).status).toBe(204)],
      ["expired", async (s) => {
        await deps.db.run("UPDATE session SET expires_at = ? WHERE id = ?", [deps.now() + 1000, s.sessionId]);
        tick(1000);
      }],
      ["removed by a sweep", async (s) => void (await deps.db.run("DELETE FROM session WHERE id = ?", [s.sessionId]))],
    ];
    for (const [what, end] of endings) {
      const s = await signIn(deps, a.userId);
      const { deviceCode } = await confirmed(deps, s, what);
      expect(await deps.db.first("SELECT confirmed_session FROM connect_request WHERE device_name = ?", [what])).toEqual({ confirmed_session: s.sessionId });
      await end(s);
      tick(POLL_GAP_MS);
      const kinds = recordKinds(deps);
      const r = await poll(deps, deviceCode);
      expect(seen(r), what).toEqual({ status: 410, headers: API_HEADERS, body: EXPIRED });
      // The one read and the one batch: the session is judged inside the statement that would make the token.
      expect(kinds, what).toEqual(["first", "batch 3"]);
      expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM api_token WHERE kind = 'sign_in'"), what).toEqual({ n: 0 });
    }
    // With the confirming session live, the same steps give the token.
    const s = await signIn(deps, a.userId);
    const { deviceCode } = await confirmed(deps, s, "live");
    tick(POLL_GAP_MS);
    expect((await poll(deps, deviceCode)).json.status).toBe("connected");
  });

  it("asking sooner than the interval is slow_down for an open request, and changes nothing", async () => {
    const { deps, a, tick } = await site();
    const s = await signIn(deps, a.userId);
    const r = await start(deps);
    const code = r.json.device_code;
    expect((await poll(deps, code)).json.status).toBe("pending");
    tick(POLL_GAP_MS - 1);
    const fast = await poll(deps, code);
    expect(seen(fast)).toEqual({
      status: 429,
      headers: [...API_HEADERS, ["retry-after", "5"]].sort(),
      body: '{"error":"slow_down","detail":"ask at most once every 5 seconds"}',
    });
    // Confirmed in the meantime: still too soon, nothing is collected.
    expect((await confirm(deps, s, r.json.user_code)).status).toBe(204);
    expect((await poll(deps, code)).status).toBe(429);
    expect(await countOf(deps, "api_token")).toBe(3);
    tick(1);
    expect((await poll(deps, code)).json.status).toBe("connected");
  });

  it("a request confirmed by an account that is then disabled cannot be collected, and a disabled account cannot confirm", async () => {
    const { deps, a, b, tick } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const { deviceCode } = await confirmed(deps, sa);
    const open = await start(deps, "open");
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    tick(1);
    expect((await poll(deps, deviceCode)).text).toBe(EXPIRED);
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM api_token WHERE kind = 'sign_in'")).toEqual({ n: 0 });
    // Disabled: the session is nobody, so it can neither look up nor confirm.
    expect((await lookup(deps, sa, open.json.user_code)).text).toBe(UNAUTHORIZED);
    expect((await confirm(deps, sa, open.json.user_code)).text).toBe(UNAUTHORIZED);
    expect(await deps.db.first("SELECT confirmed_at FROM connect_request WHERE device_name = 'open'")).toEqual({ confirmed_at: null });
    // Turned active again, the old confirmation is still collectable while it lives; another account confirms the open one.
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [a.userId]);
    tick(POLL_GAP_MS);
    expect((await poll(deps, deviceCode)).json.status).toBe("connected");
    expect((await confirm(deps, sb, open.json.user_code)).status).toBe(204);
  });
});

describe("the dashboard's lookup, confirm and refusal", () => {
  it("find an open request by its short code in any spelling, and give the same 404 for every other", async () => {
    const { deps, a, b, tick } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const r = await start(deps, "Desk");
    const code = r.json.user_code as string;
    for (const spelling of [code, code.toLowerCase(), code.replace("-", ""), code.replace("-", "").toLowerCase()]) {
      expect((await lookup(deps, sa, spelling)).json, spelling).toEqual({ device_name: "Desk", asked_at: NOW, same_network: false });
    }
    // Confirmed by A: nobody finds it any more, A included; a second confirm and a refusal change nothing.
    expect((await confirm(deps, sa, code.toLowerCase())).status).toBe(204);
    const before = await everythingStored(deps, ["rate_counter"]);
    for (const s of [sa, sb]) {
      expect(seen(await lookup(deps, s, code))).toEqual({ status: 404, headers: API_HEADERS, body: NO_REQUEST });
      expect((await confirm(deps, s, code)).text).toBe(NO_REQUEST);
      expect((await refuse(deps, s, code)).text).toBe(NO_REQUEST);
    }
    // Only the counts of wrong tries changed.
    expect(await everythingStored(deps, ["rate_counter"])).toBe(before);
    expect(await deps.db.first("SELECT confirmed_by, workspace_id FROM connect_request")).toEqual({ confirmed_by: a.userId, workspace_id: a.workspaceId });

    // Refused: settled for good.
    const other = await start(deps, "Other");
    expect((await refuse(deps, sb, other.json.user_code)).status).toBe(204);
    expect((await confirm(deps, sa, other.json.user_code)).text).toBe(NO_REQUEST);
    expect(await deps.db.all("SELECT event, user_id, workspace_id FROM audit WHERE event = 'connection_refused'")).toEqual([{ event: "connection_refused", user_id: b.userId, workspace_id: b.workspaceId }]);
    // Expired, unknown and malformed: the same 404.
    const old = await start(deps, "Old");
    tick(CONNECT_MS);
    tick(LIMITS_CONNECT.wrongAccount.windowMs);
    for (const c of [old.json.user_code, "ABCD-EFGH", "nonsense"]) expect(seen(await lookup(deps, sb, c)), c).toEqual({ status: 404, headers: API_HEADERS, body: NO_REQUEST });
  });

  it("a token and nobody get the 401 every session-only route gives, before anything is counted or read", async () => {
    const { deps, a } = await site();
    const r = await start(deps);
    const sessions = await send(deps, "GET", "/api/v1/sessions", { token: a.token });
    for (const call of [
      await send(deps, "POST", "/api/v1/connect/lookup", { token: a.token, body: JSON.stringify({ user_code: r.json.user_code }), headers: { "content-type": "application/json" } }),
      await send(deps, "POST", "/api/v1/connect/confirm", { token: a.token, body: JSON.stringify({ user_code: r.json.user_code }), headers: { "content-type": "application/json" } }),
      await send(deps, "POST", "/api/v1/connect/refuse", { token: a.token, body: JSON.stringify({ user_code: r.json.user_code }), headers: { "content-type": "application/json" } }),
      await send(deps, "GET", "/api/v1/tokens", { token: a.token }),
      await send(deps, "PATCH", `/api/v1/tokens/tok_${"0".repeat(24)}`, { token: a.token, body: '{"name":"x"}', headers: { "content-type": "application/json" } }),
      await send(deps, "DELETE", `/api/v1/tokens/tok_${"0".repeat(24)}`, { token: a.token }),
      await send(deps, "POST", "/api/v1/connect/lookup", { body: JSON.stringify({ user_code: r.json.user_code }), headers: { "content-type": "application/json" } }),
    ]) {
      expect(seen(call)).toEqual(seen(sessions));
      expect(call.text).toBe(UNAUTHORIZED);
    }
    expect(await countOf(deps, "rate_counter")).toBe(0);
    expect(await deps.db.first("SELECT confirmed_at, refused_at FROM connect_request")).toEqual({ confirmed_at: null, refused_at: null });
  });

  it("the lookup is a POST with the code in its body, needing the anti-forgery header and an Origin of the site like a change; a GET with the code in the address is no route", async () => {
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    const r = await start(deps);
    const code = r.json.user_code as string;
    for (const path of [`/api/v1/connect/lookup/${code}`, `/api/v1/connect/requests/${code}`, `/api/v1/connect/lookup?user_code=${code}`]) {
      const viaLink = await send(deps, "GET", path, { headers: { cookie: s.cookie } });
      expect([viaLink.status, viaLink.text], path).toEqual([404, '{"error":"not_found"}']);
    }
    const noCsrf = await lookup(deps, s, code, { headers: { "x-csrf-token": "" } });
    expect(noCsrf.json.error).toBe("bad_csrf");
    const elsewhere = await lookup(deps, s, code, { headers: { origin: "https://evil.example.net" } });
    expect(elsewhere.json.error).toBe("bad_origin");
    const crossSite = await lookup(deps, s, code, { headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.json.error).toBe("bad_origin");
    // None of them counted a try: a hostile page cannot spend the person's wrong tries.
    expect(await countOf(deps, "rate_counter")).toBe(0);
    expect((await lookup(deps, s, code)).status).toBe(200);
  });

  it("the lookup says whether the person is on the network the app asked from", async () => {
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    const fromA = await start(deps, "From A", { address: NET_A });
    const unknown = await start(deps, "Unknown");
    expect((await lookup(deps, s, fromA.json.user_code, { address: NET_A })).json.same_network).toBe(true);
    // The same /64 of IPv6 counts as one network, as for the limits.
    const v6 = await start(deps, "v6", { address: "2001:db8:1:2::10" });
    expect((await lookup(deps, s, v6.json.user_code, { address: "2001:db8:1:2::99" })).json.same_network).toBe(true);
    expect((await lookup(deps, s, fromA.json.user_code, { address: NET_B })).json.same_network).toBe(false);
    expect((await lookup(deps, s, fromA.json.user_code)).json.same_network).toBe(false);
    expect((await lookup(deps, s, unknown.json.user_code)).json.same_network).toBe(false);
    expect((await lookup(deps, s, unknown.json.user_code, { address: NET_A })).json.same_network).toBe(false);
  });

  it("a change needs the anti-forgery header and an Origin of the site", async () => {
    const { deps, a } = await site();
    const s = await signIn(deps, a.userId);
    const r = await start(deps);
    const noCsrf = await send(deps, "POST", "/api/v1/connect/confirm", { body: JSON.stringify({ user_code: r.json.user_code }), headers: { ...page(s), "x-csrf-token": "" } });
    expect(noCsrf.json.error).toBe("bad_csrf");
    const elsewhere = await send(deps, "POST", "/api/v1/connect/confirm", { body: JSON.stringify({ user_code: r.json.user_code }), headers: page(s, "https://evil.example.net") });
    expect(elsewhere.json.error).toBe("bad_origin");
    expect(await deps.db.first("SELECT confirmed_at FROM connect_request")).toEqual({ confirmed_at: null });
  });
});

describe("guessing a short code", () => {
  it("five wrong tries lock the account for the rest of the window, a right one is not counted, and nobody else is locked", async () => {
    const { deps, a, b, tick } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const r = await start(deps, "Mine");
    const code = r.json.user_code as string;
    const wrong = () => "ABCD-" + newUserCode().slice(0, 4);
    const key = await accountKey(a.userId);
    // Four wrong, then many right lookups: the right ones are given back.
    for (let i = 0; i < 4; i++) expect((await lookup(deps, sa, wrong())).status).toBe(404);
    for (let i = 0; i < 10; i++) expect((await lookup(deps, sa, code)).status).toBe(200);
    expect(await counter(deps, LIMITS_CONNECT.wrongAccount.bucket, key)).toBe(4);
    // The fifth wrong one still answers; after it, everything is 429 for the rest of the window, the right code too.
    expect((await confirm(deps, sa, wrong())).status).toBe(404);
    for (const call of [await lookup(deps, sa, wrong()), await lookup(deps, sa, code), await confirm(deps, sa, code), await refuse(deps, sa, code)]) {
      expect([call.status, call.json.error], call.text).toEqual([429, "rate_limited"]);
      expect(Number(call.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(await deps.db.first("SELECT confirmed_at, refused_at FROM connect_request")).toEqual({ confirmed_at: null, refused_at: null });
    // Another account is not held back by it.
    expect((await lookup(deps, sb, code)).status).toBe(200);
    expect((await lookup(deps, sb, wrong())).status).toBe(404);
    // The next window: the account may try again.
    tick(LIMITS_CONNECT.wrongAccount.windowMs);
    const later = await start(deps, "Later");
    expect((await lookup(deps, sa, later.json.user_code)).status).toBe(200);
    expect((await confirm(deps, sa, later.json.user_code)).status).toBe(204);
  });

  it("a network takes four accounts' worth of wrong tries; a locked account adds nothing to it; another network is not touched", async () => {
    const { deps } = await site();
    const accounts = await Promise.all(Array.from({ length: 6 }, () => seedAccount(deps)));
    const sessions = await Promise.all(accounts.map((x) => signIn(deps, x.userId)));
    const r = await start(deps, "Desk");
    const code = r.json.user_code as string;
    const wrong = () => "ABCD-" + newUserCode().slice(0, 4);
    const netKey = (await networkKey(NET_A))!;
    // The first account fails five times, then keeps hammering while locked.
    for (let i = 0; i < 5; i++) expect((await lookup(deps, sessions[0], wrong(), { address: NET_A })).status).toBe(404);
    for (let i = 0; i < 20; i++) expect((await lookup(deps, sessions[0], wrong(), { address: NET_A })).status).toBe(429);
    expect(await counter(deps, LIMITS_CONNECT.wrongNetwork.bucket, netKey)).toBe(5);
    // A second account on the same network is not locked out by it.
    expect((await lookup(deps, sessions[1], code, { address: NET_A })).status).toBe(200);
    // Three more accounts fill the network's 20.
    for (const s of sessions.slice(1, 4)) for (let i = 0; i < 5; i++) expect((await lookup(deps, s, wrong(), { address: NET_A })).status).toBe(404);
    expect(await counter(deps, LIMITS_CONNECT.wrongNetwork.bucket, netKey)).toBe(20);
    // A fifth account on that network is refused, and its own count is given back.
    const fifth = await lookup(deps, sessions[4], code, { address: NET_A });
    expect([fifth.status, fifth.json.error]).toEqual([429, "rate_limited"]);
    expect(await counter(deps, LIMITS_CONNECT.wrongAccount.bucket, await accountKey(accounts[4].userId))).toBe(0);
    // From another network the same account is answered.
    expect((await lookup(deps, sessions[4], code, { address: NET_B })).status).toBe(200);
  });
});

describe("the workspace's tokens", () => {
  it("lists the workspace's live tokens with their id, name, times and kind, and nothing of the token", async () => {
    const { deps, a, b, tick } = await site();
    const sa = await signIn(deps, a.userId);
    const { deviceCode } = await confirmed(deps, sa, "Laptop");
    tick(1000);
    const token = (await poll(deps, deviceCode)).json.token as string;
    tick(1000);
    await send(deps, "GET", "/api/v1/me", { token });
    const setupId = (await deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ? AND kind = 'setup'", [a.workspaceId]))!.id;
    const connectedId = (await deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ? AND kind = 'sign_in'", [a.workspaceId]))!.id;
    const list = await listTokens(deps, sa);
    expect(list.status).toBe(200);
    expect(list.json).toEqual({
      tokens: [
        { id: connectedId, name: "Laptop", created_at: NOW + 1000, last_used_at: NOW + 2000, kind: "sign_in", expires_at: NOW + 2000 + 90 * 86_400_000, expired: false },
        { id: setupId, name: "First token", created_at: NOW, last_used_at: null, kind: "setup", expires_at: null, expired: false },
      ],
    });
    const hashes = await deps.db.all<{ hash: string }>("SELECT hash FROM api_token");
    for (const text of [token, token.slice(3), token.slice(3, 11), a.token.slice(3, 11), ...hashes.map((h) => h.hash.slice(0, 16))]) expect(list.text).not.toContain(text);
    // B sees only B's.
    const sb = await signIn(deps, b.userId);
    const listB = await listTokens(deps, sb);
    expect(listB.json.tokens.map((t: { id: string }) => t.id)).not.toContain(setupId);
    expect(listB.json.tokens).toHaveLength(1);
  });

  it("renames a token of the workspace, with a record, and refuses a name it cannot show", async () => {
    const { deps, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const id = (await deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ?", [a.workspaceId]))!.id;
    const done = await rename(deps, sa, id, "  Studio PC ");
    expect([done.status, done.json]).toEqual([200, { id, name: "Studio PC", created_at: NOW, last_used_at: null, kind: "setup", expires_at: null, expired: false }]);
    expect(await deps.db.all("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event = 'token_renamed'")).toEqual([{ event: "token_renamed", user_id: a.userId, workspace_id: a.workspaceId, subject: id, detail: null }]);
    for (const name of ["", "x".repeat(61), "a‮b"]) expect((await rename(deps, sa, id, name)).json.error).toBe("bad_name");
    // Another workspace's id, an id nobody has and something that is no id: the one 404, and nothing changes.
    for (const other of [id, "tok_" + "0".repeat(24), "nonsense"]) expect(seen(await rename(deps, sb, other, "Taken"))).toEqual({ status: 404, headers: API_HEADERS, body: NO_TOKEN });
    expect(await deps.db.first("SELECT name FROM api_token WHERE id = ?", [id])).toEqual({ name: "Studio PC" });
  });

  it("revokes a token: the next request with it is refused, and only the workspace's own can be revoked", async () => {
    const { deps, a, b } = await site();
    const sa = await signIn(deps, a.userId);
    const sb = await signIn(deps, b.userId);
    const id = (await deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ?", [a.workspaceId]))!.id;
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).status).toBe(200);
    expect(seen(await revoke(deps, sb, id))).toEqual({ status: 404, headers: API_HEADERS, body: NO_TOKEN });
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).status).toBe(200);
    const done = await revoke(deps, sa, id);
    expect([done.status, done.text]).toEqual([204, ""]);
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).text).toBe(UNAUTHORIZED);
    expect((await listTokens(deps, sa)).json.tokens).toEqual([]);
    expect((await revoke(deps, sa, id)).text).toBe(NO_TOKEN);
    expect((await rename(deps, sa, id, "Back")).text).toBe(NO_TOKEN);
    expect(await deps.db.all("SELECT event, user_id, workspace_id, subject FROM audit WHERE event = 'token_revoked'")).toEqual([{ event: "token_revoked", user_id: a.userId, workspace_id: a.workspaceId, subject: id }]);
    // B's token is untouched.
    expect((await send(deps, "GET", "/api/v1/tours", { token: b.token })).status).toBe(200);
  });

  it("a request already past its token's lookup when the token is revoked finishes; the next one is refused", async () => {
    const { deps, a } = await site();
    const sa = await signIn(deps, a.userId);
    const id = (await deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ?", [a.workspaceId]))!.id;
    const realFirst = deps.db.first.bind(deps.db);
    let revoked: Call | null = null;
    deps.db.first = (async (sql: string, params?: (string | number | null)[]) => {
      const row = await realFirst(sql, params);
      if (revoked === null && sql.includes("FROM api_token WHERE hash = ?")) {
        deps.db.first = realFirst;
        // The revoke commits right after this request's token was looked up.
        revoked = await revoke(deps, sa, id);
      }
      return row;
    }) as Db["first"];
    const inFlight = await send(deps, "GET", "/api/v1/me", { token: a.token });
    deps.db.first = realFirst;
    expect((revoked as Call | null)?.status).toBe(204);
    expect(inFlight.status).toBe(200);
    expect((await send(deps, "GET", "/api/v1/me", { token: a.token })).text).toBe(UNAUTHORIZED);
  });
});

describe("the call budget", () => {
  it("every route here stays far under 40 calls, the worst cases included", async () => {
    const { deps, a, tick } = await site();
    const s = await signIn(deps, a.userId);
    const calls: Record<string, number> = {};
    const note = (key: string, c: Call) => void (calls[key] = Math.max(calls[key] ?? 0, c.calls));
    const r = await start(deps, "x", { address: NET_A });
    note("start", r);
    note("poll pending", await poll(deps, r.json.device_code, { address: NET_A }));
    note("poll unknown", await poll(deps, "dpd_" + "0".repeat(40), { address: NET_A }));
    note("lookup", await lookup(deps, s, r.json.user_code, { address: NET_A }));
    note("lookup wrong", await lookup(deps, s, "ABCD-EFGH", { address: NET_A }));
    note("confirm", await confirm(deps, s, r.json.user_code, { address: NET_A }));
    tick(POLL_GAP_MS);
    note("poll connected", await poll(deps, r.json.device_code, { address: NET_A }));
    const other = await start(deps, "y", { address: NET_A });
    note("refuse", await refuse(deps, s, other.json.user_code, { address: NET_A }));
    note("list", await listTokens(deps, s));
    const id = (await deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ? AND kind = 'sign_in'", [a.workspaceId]))!.id;
    note("rename", await rename(deps, s, id, "z"));
    note("revoke", await revoke(deps, s, id));
    for (const [key, n] of Object.entries(calls)) expect(n, key).toBeLessThanOrEqual(10);
    expect(calls.start).toBeGreaterThan(0);
  });
});
