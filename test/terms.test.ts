// The site's terms on both targets (src/terms.ts, and the gate in src/auth.ts): what a site with
// no terms answers, publishing, agreeing and what is stored, the version that was shown, new
// terms, the body of "I agree", its anti-forgery protection, tokens and viewers untouched, the
// admin held like anyone, the admin's list, untrusted text, deleting an account, and versions
// that are never changed. The gate against every route is test/terms-gate.test.ts; the file
// format is test/terms-file.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import type { Hosts } from "../src/hosts.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { parseTerms, publishTerms, showTerms, TERMS_DETAILS } from "../src/terms.ts";
import { ORIGIN, send, type Call } from "./bundle.ts";

const T0 = 1_800_000_000_000;
const REFUSED = '{"error":"terms_required","detail":"agree to the site\'s terms first"}';
const fileOf = (version: string, more = "") => `title: Site terms\nversion: ${version}\nmain points:\n- One point.\nterms:\nThe terms of ${version}.${more}\n`;

type Signed = { id: string; cookie: string; csrf: string };

async function signIn(deps: Deps, userId: string): Promise<Signed> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { id: made.sessionId, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

async function publish(deps: Deps, text: string): Promise<string> {
  const read = await parseTerms(new TextEncoder().encode(text));
  if (!read.ok) throw new Error(read.reason);
  const made = await publishTerms(deps, read);
  if (!made.ok) throw new Error("not published");
  return made.id;
}

/** A request as the site's own page sends it. */
function ask(deps: Deps, s: Signed | null, method: string, path: string, json?: unknown, extra: Record<string, string> = {}, origin = ORIGIN): Promise<Call> {
  const headers: Record<string, string> = { ...(json !== undefined ? { "content-type": "application/json" } : {}) };
  if (s !== null) Object.assign(headers, { cookie: s.cookie, "x-csrf-token": s.csrf, origin, "sec-fetch-site": "same-origin" });
  Object.assign(headers, extra);
  return send(deps, method, path, { headers, body: json === undefined ? undefined : typeof json === "string" ? json : JSON.stringify(json), origin });
}

const agree = (deps: Deps, s: Signed, terms: unknown) => ask(deps, s, "POST", "/api/v1/terms/agree", { terms });

async function setup(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps(config);
  let now = T0;
  ctx.deps.now = () => now;
  const admin = await seedAccount(ctx.deps, { username: "owner", admin: true });
  const member = await seedAccount(ctx.deps, { username: "member" });
  return { ...ctx, admin, member, tick: (ms = 1000) => void (now += ms), now: () => now };
}

const rows = (deps: Deps, table: string) => deps.db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);

describe("a site that has published no terms", () => {
  it("asks nothing of anyone: the session works as before, the terms answer says there are none, and agreeing to anything is refused", async () => {
    const w = await setup();
    const s = await signIn(w.deps, w.member.userId);
    const session = await ask(w.deps, s, "GET", "/api/v1/session");
    expect(session.status).toBe(200);
    expect(Object.keys(session.json).sort()).toEqual(["account", "csrf", "download_url", "email_change", "limits", "session", "workspace"]);
    const terms = await ask(w.deps, s, "GET", "/api/v1/terms");
    expect(terms.json).toEqual({ terms: null, agreed: null, required: false, csrf: s.csrf });
    expect((await ask(w.deps, s, "GET", "/api/v1/terms/agreed")).json).toEqual({ terms: null, agreed_at: null });
    const r = await agree(w.deps, s, `trm_${"0".repeat(24)}`);
    expect([r.status, r.json]).toEqual([409, { error: "terms_changed", detail: TERMS_DETAILS.changed }]);
    expect(await rows(w.deps, "terms_agreement")).toEqual([]);
    expect((await ask(w.deps, s, "GET", "/api/v1/admin/accounts")).status).toBe(404);
  });
});

describe("agreeing", () => {
  it("records the account, the version and the time, nothing else, with one audit row of ids; from then on the session works", async () => {
    const w = await setup();
    const s = await signIn(w.deps, w.member.userId);
    const id = await publish(w.deps, fileOf("1"));
    expect((await ask(w.deps, s, "GET", "/api/v1/session")).text).toBe(REFUSED);
    const shown = await ask(w.deps, s, "GET", "/api/v1/terms");
    expect(shown.json.required).toBe(true);
    expect(shown.json.terms.id).toBe(id);
    expect(shown.json.agreed).toBeNull();
    w.tick();
    const r = await agree(w.deps, s, id);
    expect([r.status, r.text]).toEqual([204, ""]);
    // The table holds the account, the version and the time: no address, browser or email anywhere.
    const columns = (await w.deps.db.all<{ name: string }>("SELECT name FROM pragma_table_info('terms_agreement') ORDER BY cid")).map((c) => c.name);
    expect(columns).toEqual(["user_id", "terms_id", "agreed_at"]);
    expect(await rows(w.deps, "terms_agreement")).toEqual([{ user_id: w.member.userId, terms_id: id, agreed_at: w.now() }]);
    const audit = await w.deps.db.all<Record<string, unknown>>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event = 'terms_agreed'");
    expect(audit).toEqual([{ event: "terms_agreed", user_id: w.member.userId, workspace_id: w.member.workspaceId, subject: id, detail: null }]);
    expect(JSON.stringify(audit)).not.toContain(w.member.email);
    // The session works, and its answer names the agreement for the Account page.
    const session = await ask(w.deps, s, "GET", "/api/v1/session");
    expect(session.status).toBe(200);
    expect(session.json.terms_agreed).toEqual({ version: "1", agreed_at: w.now() });
    expect((await ask(w.deps, s, "GET", "/api/v1/terms")).json).toMatchObject({ required: false, agreed: { terms_id: id, version: "1", agreed_at: w.now() } });
    expect((await ask(w.deps, s, "GET", "/api/v1/terms/agreed")).json).toMatchObject({ terms: { id, version: "1" }, agreed_at: w.now() });
    // Every other session of the same account works too: the agreement is the account's.
    const other = await signIn(w.deps, w.member.userId);
    expect((await ask(w.deps, other, "GET", "/api/v1/tokens")).status).toBe(200);
  });

  it("agreeing twice is harmless: 204, one row and one audit row", async () => {
    const w = await setup();
    const s = await signIn(w.deps, w.member.userId);
    const id = await publish(w.deps, fileOf("1"));
    expect((await agree(w.deps, s, id)).status).toBe(204);
    w.tick();
    expect((await agree(w.deps, s, id)).status).toBe(204);
    expect(await rows(w.deps, "terms_agreement")).toHaveLength(1);
    expect(await w.deps.db.all("SELECT 1 FROM audit WHERE event = 'terms_agreed'")).toHaveLength(1);
  });

  it("a version published after the screen was shown: nothing is recorded, 409, and the new one is what the screen shows next", async () => {
    const w = await setup();
    const s = await signIn(w.deps, w.member.userId);
    const first = await publish(w.deps, fileOf("1"));
    expect((await ask(w.deps, s, "GET", "/api/v1/terms")).json.terms.id).toBe(first);
    const second = await publish(w.deps, fileOf("2"));
    const r = await agree(w.deps, s, first);
    expect([r.status, r.json]).toEqual([409, { error: "terms_changed", detail: TERMS_DETAILS.changed }]);
    expect(await rows(w.deps, "terms_agreement")).toEqual([]);
    expect(await w.deps.db.all("SELECT 1 FROM audit WHERE event = 'terms_agreed'")).toHaveLength(0);
    expect((await ask(w.deps, s, "GET", "/api/v1/session")).text).toBe(REFUSED);
    expect((await ask(w.deps, s, "GET", "/api/v1/terms")).json.terms.id).toBe(second);
    expect((await agree(w.deps, s, second)).status).toBe(204);
    expect((await ask(w.deps, s, "GET", "/api/v1/session")).status).toBe(200);
  });

  it("new terms ask again at the next request, and the older agreement stays on record", async () => {
    const w = await setup();
    const s = await signIn(w.deps, w.member.userId);
    const first = await publish(w.deps, fileOf("1"));
    expect((await agree(w.deps, s, first)).status).toBe(204);
    expect((await ask(w.deps, s, "GET", "/api/v1/tours")).status).toBe(200);
    w.tick();
    const second = await publish(w.deps, fileOf("2"));
    // The very next request of the same session is held.
    expect((await ask(w.deps, s, "GET", "/api/v1/tours")).text).toBe(REFUSED);
    const state = (await ask(w.deps, s, "GET", "/api/v1/terms")).json;
    expect([state.required, state.terms.id, state.agreed.terms_id]).toEqual([true, second, first]);
    expect((await ask(w.deps, s, "GET", "/api/v1/terms/agreed")).json.terms.id).toBe(first);
    w.tick();
    expect((await agree(w.deps, s, second)).status).toBe(204);
    expect((await rows(w.deps, "terms_agreement")).map((r) => r.terms_id)).toEqual([first, second]);
    expect((await ask(w.deps, s, "GET", "/api/v1/terms/agreed")).json.terms.id).toBe(second);
  });

  it("the body is one field, the id of the version shown; anything else is refused and records nothing, and an account agrees only for itself", async () => {
    const w = await setup();
    const s = await signIn(w.deps, w.member.userId);
    const id = await publish(w.deps, fileOf("1"));
    const bad = [undefined, "", "not json", "[]", "null", '"trm_x"', JSON.stringify({}), JSON.stringify({ terms: 1 }), JSON.stringify({ terms: "trm_x" }), JSON.stringify({ terms: id, user_id: w.admin.userId }), JSON.stringify({ terms: id, agreed_at: 1 }), JSON.stringify({ terms: id, pad: "x".repeat(300) }), JSON.stringify({ terms: id.toUpperCase() })];
    for (const body of bad) {
      const r = await send(w.deps, "POST", "/api/v1/terms/agree", { headers: { cookie: s.cookie, "x-csrf-token": s.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body });
      expect([r.status, r.json], String(body)).toEqual([400, { error: "bad_request", detail: 'the body must be JSON such as {"terms": "trm_…"}, the id of the terms shown, with nothing else in it' }]);
    }
    expect(TERMS_DETAILS.changed).toBe("these are not the current terms: read the new version and agree to it");
    // Labelled as anything but JSON, or not at all: refused as every other session change refuses it, whatever the body.
    for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const headers: Record<string, string> = { cookie: s.cookie, "x-csrf-token": s.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin", ...(type === null ? {} : { "content-type": type }) };
      const r = await send(w.deps, "POST", "/api/v1/terms/agree", { headers, body: JSON.stringify({ terms: id }) });
      expect([r.status, r.json], String(type)).toEqual([400, { error: "bad_request", detail: 'the body must be JSON such as {"terms": "trm_…"}, the id of the terms shown, with nothing else in it' }]);
    }
    expect(await rows(w.deps, "terms_agreement")).toEqual([]);
    // The account is the session's, whatever else is sent: the admin, who sent nothing, has not agreed.
    expect((await agree(w.deps, s, id)).status).toBe(204);
    expect((await rows(w.deps, "terms_agreement")).map((r) => r.user_id)).toEqual([w.member.userId]);
    // Now agreed, typing a computer's short code (another session change with a JSON body) refuses the same labels the same way.
    for (const type of [null, "text/plain"]) {
      const headers: Record<string, string> = { cookie: s.cookie, "x-csrf-token": s.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin", ...(type === null ? {} : { "content-type": type }) };
      const lookup = await send(w.deps, "POST", "/api/v1/connect/lookup", { headers, body: JSON.stringify({ user_code: "ABCD-EFGH" }) });
      expect([lookup.status, lookup.json?.error], String(type)).toEqual([400, "bad_request"]);
    }
    const adminSession = await signIn(w.deps, w.admin.userId);
    expect((await ask(w.deps, adminSession, "GET", "/api/v1/terms")).json.required).toBe(true);
  });

  it("is a session change like the others: the anti-forgery header and an Origin of this address, POST only, on the app address only, never by a token", async () => {
    const hosts: Hosts = { tours: "tours.example.com", app: "app.example.com" };
    const w = await setup({ hosts });
    const APP = "https://app.example.com";
    const s = await signIn(w.deps, w.member.userId);
    const id = await publish(w.deps, fileOf("1"));
    const body = JSON.stringify({ terms: id });
    const post = (headers: Record<string, string>, origin = APP) => send(w.deps, "POST", "/api/v1/terms/agree", { headers: { "content-type": "application/json", ...headers }, body, origin });
    expect((await post({ cookie: s.cookie, origin: APP })).json.error).toBe("bad_csrf");
    expect((await post({ cookie: s.cookie, origin: APP, "x-csrf-token": "0".repeat(64) })).json.error).toBe("bad_csrf");
    expect((await post({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: "https://tours.example.com" })).json.error).toBe("bad_origin");
    expect((await post({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: "https://evil.example.net" })).json.error).toBe("bad_origin");
    expect((await post({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: APP, "sec-fetch-site": "cross-site" })).json.error).toBe("bad_origin");
    expect((await post({ cookie: s.cookie, "x-csrf-token": s.csrf })).json.error).toBe("bad_origin");
    expect((await post({ authorization: `Bearer ${w.member.token}` })).status).toBe(401);
    // Not on the tours address, and no other method.
    expect((await post({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: "https://tours.example.com" }, "https://tours.example.com")).status).toBe(404);
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) expect((await send(w.deps, method, "/api/v1/terms/agree", { headers: { cookie: s.cookie, "x-csrf-token": s.csrf, origin: APP }, origin: APP })).status, method).toBe(404);
    expect(await rows(w.deps, "terms_agreement")).toEqual([]);
    expect((await post({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: APP, "sec-fetch-site": "same-origin" })).status).toBe(204);
  });
});

describe("what the terms leave alone", () => {
  it("a token's requests answer byte for byte as before and cost the same calls, whatever the account's terms", async () => {
    const w = await setup();
    const asked = async () => {
      const out: unknown[] = [];
      for (const path of ["/api/v1/me", "/api/v1/tours", "/api/v1/usage", "/api/v1/media?kind=image", "/api/v1/setup/connected"]) {
        const r = await send(w.deps, "GET", path, { token: w.member.token });
        out.push([path, r.status, r.text, [...r.headers.entries()].sort(), r.calls]);
      }
      return out;
    };
    const before = await asked();
    await publish(w.deps, fileOf("1"));
    expect(await asked()).toEqual(before);
    // A token with a session cookie is still refused as two credentials, before anything is looked up.
    const s = await signIn(w.deps, w.member.userId);
    const mixed = await send(w.deps, "GET", "/api/v1/tours", { token: w.member.token, headers: { cookie: s.cookie } });
    expect(mixed.json.error).toBe("mixed_credentials");
  });

  it("the tours and img addresses answer as before, with or without a session cookie: viewers never see the terms", async () => {
    const hosts: Hosts = { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" };
    const w = await setup({ hosts });
    const s = await signIn(w.deps, w.member.userId);
    const paths: [string, string][] = [
      ["https://tours.example.com", "/healthz"],
      ["https://tours.example.com", "/t/abcdefghij"],
      ["https://tours.example.com", "/view"],
      ["https://tours.example.com", "/api/v1/view/session"],
      ["https://tours.example.com", "/api/v1/tours"],
      ["https://img.example.com", "/i/abcdefghijklmnopqrst"],
      ["https://img.example.com", "/api/v1/media-view/session"],
    ];
    const asked = async () => {
      const out: unknown[] = [];
      for (const [origin, path] of paths) for (const cookie of [null, s.cookie]) {
        const r = await send(w.deps, "GET", path, { origin, headers: cookie === null ? {} : { cookie } });
        out.push([origin, path, cookie !== null, r.status, r.text, [...r.headers.entries()].filter(([k]) => k !== "date").sort()]);
      }
      return out;
    };
    const before = await asked();
    await publish(w.deps, fileOf("1"));
    expect(await asked()).toEqual(before);
  });
});

describe("the admin", () => {
  it("is held like anyone; a member gets the one 404 from an admin route either way; the server command's side is the only way round", async () => {
    const w = await setup();
    const admin = await signIn(w.deps, w.admin.userId);
    const member = await signIn(w.deps, w.member.userId);
    const id = await publish(w.deps, fileOf("1"));
    expect((await ask(w.deps, admin, "GET", "/api/v1/admin/accounts")).text).toBe(REFUSED);
    expect((await ask(w.deps, member, "GET", "/api/v1/admin/accounts")).text).toBe('{"error":"not_found"}');
    expect((await agree(w.deps, admin, id)).status).toBe(204);
    expect((await ask(w.deps, admin, "GET", "/api/v1/admin/accounts")).status).toBe(200);
    expect((await ask(w.deps, member, "GET", "/api/v1/admin/accounts")).text).toBe('{"error":"not_found"}');
  });

  it("the list of accounts gives each account's newest agreement, its version's label and the time, or null; nothing else of it", async () => {
    const w = await setup();
    const admin = await signIn(w.deps, w.admin.userId);
    const member = await signIn(w.deps, w.member.userId);
    const id1 = await publish(w.deps, fileOf("First version"));
    expect((await agree(w.deps, admin, id1)).status).toBe(204);
    const at1 = w.now();
    let answer = (await ask(w.deps, admin, "GET", "/api/v1/admin/accounts")).json;
    expect(answer.current_terms).toEqual({ version: "First version" });
    let list = answer.accounts as { id: string; terms: unknown }[];
    expect(Object.fromEntries(list.map((a) => [a.id, a.terms]))).toEqual({
      [w.admin.userId]: { version: "First version", agreed_at: at1, current: true },
      [w.member.userId]: null,
    });
    expect((await agree(w.deps, member, id1)).status).toBe(204);
    w.tick();
    // New terms: the admin agrees to them; the member's agreement is to the older version, and says so.
    const id2 = await publish(w.deps, fileOf("Second version"));
    expect((await agree(w.deps, admin, id2)).status).toBe(204);
    answer = (await ask(w.deps, admin, "GET", "/api/v1/admin/accounts")).json;
    expect(answer.current_terms).toEqual({ version: "Second version" });
    list = answer.accounts;
    expect(Object.fromEntries(list.map((a) => [a.id, a.terms]))).toEqual({
      [w.admin.userId]: { version: "Second version", agreed_at: w.now(), current: true },
      [w.member.userId]: { version: "First version", agreed_at: at1, current: false },
    });
    expect((await agree(w.deps, member, id2)).status).toBe(204);
    list = (await ask(w.deps, admin, "GET", "/api/v1/admin/accounts")).json.accounts;
    expect(list.map((a) => a.terms)).toEqual([
      { version: "Second version", agreed_at: w.now(), current: true },
      { version: "Second version", agreed_at: w.now(), current: true },
    ]);
    expect(JSON.stringify(list)).not.toContain("The terms of");
  });
});

describe("the terms are the site's text, and still untrusted", () => {
  it("markup, script, quotes and odd Unicode in every field come back exactly, as JSON data, never as markup", async () => {
    const w = await setup();
    const s = await signIn(w.deps, w.member.userId);
    const rtl = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd) + " " + String.fromCodePoint(0x645, 0x631, 0x62d, 0x628, 0x627);
    const zwj = String.fromCodePoint(0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const odd = `<script>alert(1)</script> "><img src=x onerror=alert(1)> &amp; </title> ${rtl} ${zwj} e${String.fromCodePoint(0x301)}`;
    const file = `title: ${odd}\nversion: ${odd}\nlink: ${odd.slice(0, 50)} | https://example.com/t?a=1&b=2\nmain points:\n- ${odd}\nterms:\n# ${odd}\n${odd}\n- ${odd}\n`;
    const id = await publish(w.deps, file);
    const r = await ask(w.deps, s, "GET", "/api/v1/terms");
    expect([r.headers.get("content-type"), r.headers.get("x-content-type-options"), r.headers.get("cache-control")]).toEqual(["application/json", "nosniff", "no-store"]);
    expect(r.json.terms).toEqual({
      id,
      title: odd,
      version: odd,
      points: [odd],
      links: [{ label: odd.slice(0, 50).trim(), url: "https://example.com/t?a=1&b=2" }],
      body: [{ kind: "heading", text: odd }, { kind: "paragraph", text: odd }, { kind: "list", items: [odd] }],
      published_at: T0,
    });
    // As bytes, the answer is JSON: no raw "<" ever starts a tag outside a JSON string.
    expect(JSON.parse(r.text)).toEqual(r.json);
  });
});

describe("a stored version is served as it was published, whatever a later rule says", () => {
  it("a link the current rule refuses is left out, a body or point a stricter rule would refuse is served as text, and it can be agreed to", async () => {
    const w = await setup();
    const s = await signIn(w.deps, w.member.userId);
    const id = "trm_" + "a".repeat(24);
    const longPoint = "p".repeat(400);
    const longHeading = "h".repeat(400);
    // Written as an older release could have published it: rules tightened since.
    await w.deps.db.run("INSERT INTO terms_version (id, seq, title, version_label, points, links, body, sha256, published_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      "Old terms",
      "Old version",
      JSON.stringify([longPoint, 5]),
      JSON.stringify([{ label: "Gone", url: "http://example.com/" }, { label: "Kept", url: "https://example.com/kept" }, { label: 3, url: "https://example.com/" }, "nonsense"]),
      `#\n-\n\n# ${longHeading}\nText.`,
      "b".repeat(64),
      T0,
    ]);
    const state = await ask(w.deps, s, "GET", "/api/v1/terms");
    expect(state.status, state.text).toBe(200);
    expect(state.json.terms).toEqual({
      id,
      title: "Old terms",
      version: "Old version",
      points: [longPoint],
      links: [{ label: "Kept", url: "https://example.com/kept" }],
      body: [{ kind: "paragraph", text: "# -" }, { kind: "heading", text: longHeading }, { kind: "paragraph", text: "Text." }],
      published_at: T0,
    });
    expect((await agree(w.deps, s, id)).status).toBe(204);
    const agreed = await ask(w.deps, s, "GET", "/api/v1/terms/agreed");
    expect([agreed.status, agreed.json.terms.links]).toEqual([200, [{ label: "Kept", url: "https://example.com/kept" }]]);
    expect((await ask(w.deps, s, "GET", "/api/v1/tours")).status).toBe(200);
  });
});

describe("what is kept", () => {
  it("a published version is never changed or deleted, by anyone; the same content again is refused", async () => {
    const w = await setup();
    const id = await publish(w.deps, fileOf("1"));
    await expect(w.deps.db.run("UPDATE terms_version SET title = 'Changed' WHERE id = ?", [id])).rejects.toThrow(/never changed/);
    await expect(w.deps.db.run("DELETE FROM terms_version WHERE id = ?", [id])).rejects.toThrow(/never deleted/);
    const read = await parseTerms(new TextEncoder().encode(fileOf("1")));
    if (!read.ok) throw new Error(read.reason);
    expect(await publishTerms(w.deps, read)).toEqual({ ok: false, problem: "same", version: { seq: 1, id } });
    expect((await showTerms(w.deps, id))?.answer.title).toBe("Site terms");
    expect(await w.deps.db.all("SELECT id FROM terms_version")).toHaveLength(1);
  });

  it("deleting an account removes its agreements and keeps its audit rows, ids only; the versions stay", async () => {
    const w = await setup();
    const admin = await signIn(w.deps, w.admin.userId);
    const member = await signIn(w.deps, w.member.userId);
    const id = await publish(w.deps, fileOf("1"));
    expect((await agree(w.deps, admin, id)).status).toBe(204);
    expect((await agree(w.deps, member, id)).status).toBe(204);
    expect((await ask(w.deps, admin, "POST", `/api/v1/admin/accounts/${w.member.userId}/disable`)).status).toBe(204);
    let r = await ask(w.deps, admin, "DELETE", `/api/v1/admin/accounts/${w.member.userId}`, { username: "member" });
    for (let i = 0; r.status === 202 && i < 20; i++) r = await ask(w.deps, admin, "DELETE", `/api/v1/admin/accounts/${w.member.userId}`, { username: "member" });
    expect(r.status, r.text).toBe(200);
    expect((await rows(w.deps, "terms_agreement")).map((x) => x.user_id)).toEqual([w.admin.userId]);
    expect(await w.deps.db.all("SELECT user_id, subject FROM audit WHERE event = 'terms_agreed' ORDER BY at, id")).toHaveLength(2);
    expect(await w.deps.db.all("SELECT id FROM terms_version")).toEqual([{ id }]);
  });
});
