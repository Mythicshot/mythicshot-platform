// Accounts in the database: what a new workspace writes, the lookups, the email rule and
// the audit record. Runs on both targets.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount, seedWorkspace } from "#harness";
import { accountByEmail, hasAdmin, healMemberships, parseEmail, workspaceOf } from "../src/accounts.ts";
import { AUDIT_EVENTS, auditStatement } from "../src/audit.ts";
import { hashToken, requireAuth } from "../src/auth.ts";
import type { Deps } from "../src/ports.ts";
import { createWorkspace, workspaceStatements } from "../src/workspaces.ts";

const NOW = 1_800_000_000_000;

async function count(deps: Deps, table: string): Promise<number> {
  return (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
}

/** Every value of every column of every account table, as text. */
async function everyAccountValue(deps: Deps): Promise<string[]> {
  const out: string[] = [];
  for (const t of ["user", "membership", "signin_method", "signin_code", "session", "rate_counter", "audit"]) {
    for (const row of await deps.db.all<Record<string, unknown>>(`SELECT * FROM ${t}`)) for (const v of Object.values(row)) out.push(String(v));
  }
  return out;
}

describe("accounts", () => {
  it("a new workspace gets its owner's membership and sign-in method in the same batch", async () => {
    const { deps, calls } = await makeDeps();
    deps.now = () => NOW;
    const w = await workspaceStatements(deps, "Acme", "Owner@Example.com");
    expect(w.userId).toMatch(/^usr_[0-9a-f]{24}$/);
    expect(w.workspaceId).toMatch(/^ws_[0-9a-f]{24}$/);
    // Nothing is written until the caller's batch runs.
    expect(await count(deps, "user")).toBe(0);

    // The same batch: when a statement after them fails, none of it is there.
    await expect(deps.db.batch([...w.stmts, { sql: "INSERT INTO workspace (id) VALUES (NULL)" }])).rejects.toThrow();
    for (const t of ["workspace", "user", "api_token", "membership", "signin_method"]) expect(await count(deps, t), t).toBe(0);

    await deps.db.batch(w.stmts);
    expect(await deps.db.all("SELECT * FROM user")).toEqual([
      { id: w.userId, workspace_id: w.workspaceId, email: "owner@example.com", created_at: NOW, username: null, status: "active", is_admin: 0 },
    ]);
    expect(await deps.db.all("SELECT * FROM membership")).toEqual([{ workspace_id: w.workspaceId, user_id: w.userId, role: "owner", created_at: NOW }]);
    expect(await deps.db.all("SELECT * FROM signin_method")).toEqual([{ user_id: w.userId, kind: "email_link", created_at: NOW }]);
    // The token works as it always did, and no other account table has a row.
    expect(await requireAuth(new Request("https://tours.example.com/api/v1/me", { headers: { authorization: "Bearer " + w.token } }), deps)).toMatchObject({ workspaceId: w.workspaceId });
    for (const t of ["signin_code", "session", "rate_counter", "audit"]) expect(await count(deps, t), t).toBe(0);

    // createWorkspace is still one call to the database, and returns what it returned before.
    const before = calls();
    const made = await createWorkspace(deps, "Other", "other@example.com");
    expect(calls() - before).toBe(1);
    expect(Object.keys(made).sort()).toEqual(["token", "workspaceId"]);
    expect(await deps.db.all("SELECT workspace_id, role FROM membership WHERE workspace_id = ?", [made.workspaceId])).toEqual([{ workspace_id: made.workspaceId, role: "owner" }]);
    expect(await count(deps, "signin_method")).toBe(2);
  });

  it("every account's membership names the workspace its row names", async () => {
    const { deps } = await makeDeps();
    const a = await seedAccount(deps);
    const b = await seedAccount(deps, { username: "sam" });
    const c = await seedWorkspace(deps, "C");
    await createWorkspace(deps, "D", "d@example.com");
    // One membership per account, and it is the account's own workspace.
    expect(await count(deps, "user")).toBe(4);
    expect(await count(deps, "membership")).toBe(4);
    expect(await deps.db.all("SELECT u.id FROM user u LEFT JOIN membership m ON m.user_id = u.id WHERE m.workspace_id IS NULL OR m.workspace_id <> u.workspace_id OR m.role <> 'owner'")).toEqual([]);
    expect(await deps.db.all("SELECT u.id FROM user u LEFT JOIN signin_method s ON s.user_id = u.id AND s.kind = 'email_link' WHERE s.user_id IS NULL")).toEqual([]);

    expect(await workspaceOf(deps, a.userId)).toBe(a.workspaceId);
    expect(await workspaceOf(deps, b.userId)).toBe(b.workspaceId);
    const ownerC = (await deps.db.first<{ id: string }>("SELECT id FROM user WHERE workspace_id = ?", [c.workspaceId]))!.id;
    expect(await workspaceOf(deps, ownerC)).toBe(c.workspaceId);
    // Nobody, and an account whose membership is gone, have no workspace: user.workspace_id is not consulted.
    expect(await workspaceOf(deps, "usr_" + "0".repeat(24))).toBeNull();
    expect(await workspaceOf(deps, a.workspaceId)).toBeNull();
    await deps.db.run("DELETE FROM membership WHERE user_id = ?", [a.userId]);
    expect(await workspaceOf(deps, a.userId)).toBeNull();
    expect(await workspaceOf(deps, b.userId)).toBe(b.workspaceId);
  });

  it("an account written without a membership or a sign-in method is given both by the repair, once", async () => {
    const { deps } = await makeDeps();
    const a = await seedAccount(deps, { username: "sam" });
    const b = await seedWorkspace(deps, "B");
    // Nothing is missing: the repair changes nothing.
    const before = await deps.db.all("SELECT * FROM membership ORDER BY user_id");
    const methodsBefore = await deps.db.all("SELECT * FROM signin_method ORDER BY user_id");
    const stmts = healMemberships(deps);
    expect(stmts.length).toBeGreaterThan(0);
    await deps.db.batch(stmts);
    expect(await deps.db.all("SELECT * FROM membership ORDER BY user_id")).toEqual(before);
    expect(await deps.db.all("SELECT * FROM signin_method ORDER BY user_id")).toEqual(methodsBefore);

    // An older build ran on this database for a while: its three statements make a
    // workspace, an owner and a token, and nothing else. A second owner lost only its
    // membership, a third only its sign-in method.
    const old = async (n: string, at: number) => {
      await deps.db.batch([
        { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, 'Old', ?)", params: [`ws_${n.repeat(24)}`, at] },
        { sql: "INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)", params: [`usr_${n.repeat(24)}`, `ws_${n.repeat(24)}`, `old-${n}@example.com`, at] },
        { sql: "INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, 'First token', ?, ?)", params: [`tok_${n.repeat(24)}`, `ws_${n.repeat(24)}`, n.repeat(64), at] },
      ]);
    };
    const OLD = ["c", "d", "e"].map((n) => `'usr_${n.repeat(24)}'`).join(", ");
    await old("c", 111);
    await old("d", 222);
    await old("e", 333);
    await deps.db.run("INSERT INTO signin_method (user_id, kind, created_at) VALUES (?, 'email_link', 222)", ["usr_" + "d".repeat(24)]);
    await deps.db.run("INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', 333)", ["ws_" + "e".repeat(24), "usr_" + "e".repeat(24)]);
    expect(await workspaceOf(deps, "usr_" + "c".repeat(24))).toBeNull();
    expect(await workspaceOf(deps, "usr_" + "d".repeat(24))).toBeNull();

    // The statements were made before the rows were missing, and still find them: they hold no list of accounts.
    await deps.db.batch(stmts);
    for (const n of ["c", "d", "e"]) expect(await workspaceOf(deps, `usr_${n.repeat(24)}`), n).toBe(`ws_${n.repeat(24)}`);
    // Each new row is dated as its account is, like the rows the migration wrote: no clock is read.
    expect(await deps.db.all(`SELECT workspace_id, user_id, role, created_at FROM membership WHERE user_id IN (${OLD}) ORDER BY user_id`)).toEqual([
      { workspace_id: "ws_" + "c".repeat(24), user_id: "usr_" + "c".repeat(24), role: "owner", created_at: 111 },
      { workspace_id: "ws_" + "d".repeat(24), user_id: "usr_" + "d".repeat(24), role: "owner", created_at: 222 },
      { workspace_id: "ws_" + "e".repeat(24), user_id: "usr_" + "e".repeat(24), role: "owner", created_at: 333 },
    ]);
    expect(await deps.db.all(`SELECT user_id, kind, created_at FROM signin_method WHERE user_id IN (${OLD}) ORDER BY user_id`)).toEqual([
      { user_id: "usr_" + "c".repeat(24), kind: "email_link", created_at: 111 },
      { user_id: "usr_" + "d".repeat(24), kind: "email_link", created_at: 222 },
      { user_id: "usr_" + "e".repeat(24), kind: "email_link", created_at: 333 },
    ]);
    // Every account now has exactly one of each, and the rows that were there are as they were.
    expect(await deps.db.all("SELECT u.id FROM user u WHERE (SELECT count(*) FROM membership m WHERE m.user_id = u.id AND m.workspace_id = u.workspace_id) <> 1 OR (SELECT count(*) FROM signin_method s WHERE s.user_id = u.id) <> 1")).toEqual([]);
    expect(await deps.db.all(`SELECT * FROM membership WHERE user_id NOT IN (${OLD}) ORDER BY user_id`)).toEqual(before);
    expect(await workspaceOf(deps, a.userId)).toBe(a.workspaceId);
    expect(await deps.db.first("SELECT username, is_admin FROM user WHERE id = ?", [a.userId])).toEqual({ username: "sam", is_admin: 0 });
    expect(await hasAdmin(deps)).toBe(false);

    // Again, and twice in one batch: nothing more is written and nothing fails.
    const settled = [await deps.db.all("SELECT * FROM membership ORDER BY user_id"), await deps.db.all("SELECT * FROM signin_method ORDER BY user_id")];
    await deps.db.batch([...healMemberships(deps), ...healMemberships(deps)]);
    expect([await deps.db.all("SELECT * FROM membership ORDER BY user_id"), await deps.db.all("SELECT * FROM signin_method ORDER BY user_id")]).toEqual(settled);
    // The older build's token was never in question.
    expect(await deps.db.first("SELECT count(*) AS n FROM api_token WHERE workspace_id = ?", [b.workspaceId])).toEqual({ n: 1 });
  });

  it("seedAccount makes an account with its workspace, a token that authenticates, and the username and admin flag asked for", async () => {
    const { deps } = await makeDeps();
    const plain = await seedAccount(deps);
    const named = await seedAccount(deps, { username: "sam" });
    const admin = await seedAccount(deps, { username: "alex", admin: true });
    for (const s of [plain, named, admin]) {
      expect(Object.keys(s).sort()).toEqual(["email", "token", "userId", "workspaceId"]);
      expect(s.userId).toMatch(/^usr_[0-9a-f]{24}$/);
      expect(parseEmail(s.email)).toBe(s.email);
      expect(await requireAuth(new Request("https://tours.example.com/api/v1/me", { headers: { authorization: "Bearer " + s.token } }), deps)).toMatchObject({ workspaceId: s.workspaceId });
      expect(await deps.db.first("SELECT hash FROM api_token WHERE workspace_id = ?", [s.workspaceId])).toEqual({ hash: await hashToken(s.token) });
    }
    expect(await deps.db.all("SELECT id, workspace_id, email, username, status, is_admin FROM user ORDER BY created_at, rowid")).toEqual([
      { id: plain.userId, workspace_id: plain.workspaceId, email: plain.email, username: null, status: "active", is_admin: 0 },
      { id: named.userId, workspace_id: named.workspaceId, email: named.email, username: "sam", status: "active", is_admin: 0 },
      { id: admin.userId, workspace_id: admin.workspaceId, email: admin.email, username: "alex", status: "active", is_admin: 1 },
    ]);
    expect(new Set([plain.email, named.email, admin.email]).size).toBe(3);
  });

  it("nobody is an admin until someone is made one", async () => {
    const { deps, calls } = await makeDeps();
    expect(await hasAdmin(deps)).toBe(false);
    const a = await seedAccount(deps, { username: "sam" });
    await seedWorkspace(deps, "B");
    await createWorkspace(deps, "C", "c@example.com");
    expect(await hasAdmin(deps)).toBe(false);
    expect(await deps.db.first("SELECT count(*) AS n FROM user WHERE is_admin <> 0")).toEqual({ n: 0 });
    expect(await accountByEmail(deps, a.email)).toEqual({ id: a.userId, status: "active", admin: false, username: "sam" });
    expect(await accountByEmail(deps, "c@example.com")).toMatchObject({ status: "active", admin: false, username: null });

    const boss = await seedAccount(deps, { username: "alex", admin: true });
    expect(await hasAdmin(deps)).toBe(true);
    expect(await accountByEmail(deps, boss.email)).toEqual({ id: boss.userId, status: "active", admin: true, username: "alex" });
    expect(await accountByEmail(deps, a.email)).toMatchObject({ admin: false });

    // A stranger, and an address that only differs in case from a stored one: the lookup is exact.
    expect(await accountByEmail(deps, "stranger@example.com")).toBeNull();
    expect(await accountByEmail(deps, a.email.toUpperCase())).toBeNull();
    expect(await accountByEmail(deps, parseEmail(" " + a.email.toUpperCase() + " ")!)).toMatchObject({ id: a.userId });
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    expect(await accountByEmail(deps, a.email)).toEqual({ id: a.userId, status: "disabled", admin: false, username: "sam" });

    // Each lookup is one call, whether or not it finds anyone.
    for (const look of [() => accountByEmail(deps, a.email), () => accountByEmail(deps, "stranger@example.com"), () => hasAdmin(deps), () => workspaceOf(deps, a.userId), () => workspaceOf(deps, "usr_none")]) {
      const before = calls();
      await look();
      expect(calls() - before).toBe(1);
    }
  });

  it("an email is trimmed and lowercased, and its domain is a host name", () => {
    expect(parseEmail("sam@example.com")).toBe("sam@example.com");
    expect(parseEmail("  Sam.Smith+tours@Example.COM\t")).toBe("sam.smith+tours@example.com");
    expect(parseEmail("a@b.co")).toBe("a@b.co");
    expect(parseEmail("first_last%x-y@mail.sub.example.org")).toBe("first_last%x-y@mail.sub.example.org");
    expect(parseEmail("a".repeat(64) + "@example.com")).toBe("a".repeat(64) + "@example.com");
    expect(parseEmail("sam@xn--bcher-kva.example")).toBe("sam@xn--bcher-kva.example");
    // 254 characters is the longest; one more is not an email.
    const longest = "a@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(63) + "." + "e".repeat(56) + ".com";
    expect(longest.length).toBe(254);
    expect(parseEmail(longest)).toBe(longest);
    expect(parseEmail("aa@" + longest.slice(2))).toBeNull();
  });

  it("an address with a line break, a space, two @ or a bad domain is not an email", () => {
    const bad: unknown[] = [
      // Line breaks anywhere, also at the ends: nothing with one is ever stored or mailed.
      "sam@example.com\n", "\nsam@example.com", "sam@example.com\r\n", "sam\n@example.com", "sam@exam\rple.com", "sam@example.com\r\nBcc: x@example.org", "sam@example.com\u2028", "sam@example.com\u0085", "sam\u000b@example.com", "sam@example.com\u0000",
      // Spaces inside, and white space that is not a plain space or tab at the ends.
      "sam smith@example.com", "sam@ example.com", "sam @example.com", "sam@example .com", "\u00a0sam@example.com", "sam@example.com\u3000",
      // Hidden and non-ASCII characters.
      "sam\u200b@example.com", "sam@example.com\u200e", "\ufeffsam@example.com", "s\u00e1m@example.com", "sam@ex\u00e1mple.com", "sam@\u0435xample.com", "\u212aim@example.com",
      // Not exactly one @.
      "sam@@example.com", "sam@x@example.com", "@example.com", "sam@", "sam", "@", "",
      // The local part.
      "a".repeat(65) + "@example.com", "sam<x>@example.com", "<sam@example.com>", "sam,x@example.com", "sam;x@example.com", "\"sam\"@example.com", "sam(x)@example.com", "sam:x@example.com", "sam\\x@example.com", "sam!x@example.com", "sam/x@example.com", "sam'x@example.com",
      // The domain.
      "sam@localhost", "sam@example", "sam@example.com:25", "sam@example.com:443", "sam@example.com.", "sam@.example.com", "sam@example..com", "sam@-example.com", "sam@example-.com", "sam@exa_mple.com", "sam@[127.0.0.1]", "sam@127.0.0.1", "sam@example.123", "sam@*.example.com", "sam@example.com/x", "sam@https://example.com", "sam@" + "b".repeat(64) + ".com",
      // Not a string.
      null, undefined, 5, {}, ["sam@example.com"], true,
    ];
    for (const v of bad) expect(parseEmail(v), JSON.stringify(v)).toBeNull();
    // Too long, whatever it is made of.
    expect(parseEmail("a@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(63) + "." + "e".repeat(60) + ".com")).toBeNull();
    expect(parseEmail("a".repeat(100_000) + "@example.com")).toBeNull();
  });

  it("an audit row holds the time, the event and ids, and its detail as JSON", async () => {
    const { deps } = await makeDeps();
    deps.now = () => NOW;
    const a = await seedAccount(deps);
    expect(AUDIT_EVENTS).toEqual(["first_admin", "signin_link_sent", "signin_link_printed", "signin", "signout", "signout_everywhere", "session_revoked", "allowance_set", "email_change_requested", "email_changed", "email_changed_on_server", "connection_confirmed", "connection_refused", "connection_collected", "connection_mail_not_sent", "token_renamed", "token_revoked", "invite_sent", "invite_resent", "invite_cancelled", "invite_accepted", "account_disabled", "account_enabled", "account_deleted", "account_removal_undone", "billing_warning_sent", "billing_removal_started", "billing_removal_step", "billing_removal_finished", "billing_removal_stopped", "billing_warning_claim_cleared", "tour_access_changed", "media_access_changed", "viewer_link_sent", "viewer_signin", "terms_agreed", "billing_checkout_started", "billing_changed", "billing_checkout_mismatch", "billing_checkout_unmatched", "billing_second_subscription", "billing_unlinked_subscription", "billing_payment_failed", "billing_risk", "billing_cancelled_for_deletion", "billing_stale_confirmed", "billing_answer_refused"]);
    const first = auditStatement(deps, { event: "allowance_set", userId: a.userId, workspaceId: a.workspaceId, subject: a.workspaceId, detail: { old: 1_073_741_824, new: 0 } });
    // A statement for the caller's batch: nothing is written by making it.
    expect(await count(deps, "audit")).toBe(0);
    await deps.db.batch([
      first,
      auditStatement(deps, { event: "signin", userId: a.userId, workspaceId: a.workspaceId, subject: "ses_" + "1".repeat(24) }),
      auditStatement(deps, { event: "signout_everywhere" }),
      // An allowance of null is the site's default, and both numbers are recorded as they were.
      auditStatement(deps, { event: "allowance_set", userId: a.userId, workspaceId: a.workspaceId, subject: a.workspaceId, detail: { old: null, new: 5_000_000 } }),
      auditStatement(deps, { event: "allowance_set", userId: a.userId, workspaceId: a.workspaceId, subject: a.workspaceId, detail: { old: 5_000_000, new: null, unit: "bytes" } }),
      auditStatement(deps, { event: "signout", userId: null, workspaceId: null, subject: null, detail: null }),
      auditStatement(deps, { event: "signout", detail: {} }),
    ]);
    const rows = await deps.db.all<{ id: string; at: number; event: string; user_id: string | null; workspace_id: string | null; subject: string | null; detail: string | null }>("SELECT * FROM audit ORDER BY rowid");
    expect(rows.map(({ id: _id, ...rest }) => rest)).toEqual([
      { at: NOW, event: "allowance_set", user_id: a.userId, workspace_id: a.workspaceId, subject: a.workspaceId, detail: '{"old":1073741824,"new":0}' },
      { at: NOW, event: "signin", user_id: a.userId, workspace_id: a.workspaceId, subject: "ses_" + "1".repeat(24), detail: null },
      { at: NOW, event: "signout_everywhere", user_id: null, workspace_id: null, subject: null, detail: null },
      { at: NOW, event: "allowance_set", user_id: a.userId, workspace_id: a.workspaceId, subject: a.workspaceId, detail: '{"old":null,"new":5000000}' },
      { at: NOW, event: "allowance_set", user_id: a.userId, workspace_id: a.workspaceId, subject: a.workspaceId, detail: '{"old":5000000,"new":null,"unit":"bytes"}' },
      { at: NOW, event: "signout", user_id: null, workspace_id: null, subject: null, detail: null },
      { at: NOW, event: "signout", user_id: null, workspace_id: null, subject: null, detail: "{}" },
    ]);
    for (const r of rows) expect(r.id).toMatch(/^aud_[0-9a-f]{24}$/);
    expect(new Set(rows.map((r) => r.id)).size).toBe(7);
    // An event that is not one of the list is refused, whatever the type checker was told.
    expect(() => auditStatement(deps, { event: "signin; DROP TABLE audit" as never })).toThrow("audit: unknown event");
    expect(() => auditStatement(deps, { event: "toString" as never })).toThrow("audit: unknown event");
  });

  it("an audit row never holds an email, a token, a code or a cookie", async () => {
    const { deps } = await makeDeps();
    const a = await seedAccount(deps);
    const token = a.token;
    const code = "dpl_" + "0123456789".repeat(4);
    const emailCode = "dpe_" + "9876543210".repeat(4);
    const secret = "dps_" + "0123456789abcdef".repeat(4);
    const cookie = "__Host-dp_session=" + secret;
    const hash = await hashToken(token);
    const secrets: (string | number)[] = [
      token, code, emailCode, emailCode.slice(0, 30), secret, cookie, hash, a.email,
      // Inside other text, in capitals, and cut short enough to still be most of the secret.
      `token ${token} was used`, token.toUpperCase(), token.slice(0, 30), code.slice(0, 30), secret.slice(4), "Bearer " + token, hash.toUpperCase(), hash.slice(0, 40), "Sam <sam@example.com>", "sam@localhost", "@",
      // A network address is not recorded either.
      "203.0.113.7", "from 203.0.113.7:4431", "2001:db8::1", "::1", "fe80::1%eth0",
      // Nor a line break, anything long, or a number that is not a plain whole one.
      "a\nb", "a\rb", "x".repeat(201), Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53,
    ];
    for (const s of secrets) {
      const where = JSON.stringify(s) ?? String(s);
      expect(() => auditStatement(deps, { event: "signin", userId: a.userId, detail: { note: s } }), where).toThrow("audit: a value that must not be recorded");
      if (typeof s !== "string") continue;
      expect(() => auditStatement(deps, { event: "signin", userId: a.userId, detail: { [s]: 1 } }), where).toThrow("audit: a value that must not be recorded");
      expect(() => auditStatement(deps, { event: "signin", userId: a.userId, subject: s }), where).toThrow("audit: a value that must not be recorded");
      expect(() => auditStatement(deps, { event: "signin", userId: s }), where).toThrow("audit: a value that must not be recorded");
      expect(() => auditStatement(deps, { event: "signin", workspaceId: s }), where).toThrow("audit: a value that must not be recorded");
    }
    // The refusal does not repeat what it refused.
    let message = "";
    try {
      auditStatement(deps, { event: "signin", detail: { note: token } });
    } catch (err) {
      message = String((err as Error).message) + String((err as Error).stack);
    }
    expect(message).toContain("audit: a value that must not be recorded");
    expect(message).not.toContain(token.slice(3));
    // A detail that is not a flat record of whole numbers, nulls and short lowercase words is refused too.
    const proto = JSON.parse('{"__proto__": 1}');
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
    class Detail {
      old = 1;
    }
    for (const d of [
      { a: { b: 1 } }, { a: [1] }, { a: true }, { a: undefined }, [1], "text", new Detail(), new Map([["a", 1]]),
      // A word: a lowercase letter, then at most 39 lowercase letters, digits and underscores.
      { a: "" }, { a: "Bytes" }, { a: "two words" }, { a: "a.b" }, { a: "a-b" }, { a: "9lives" }, { a: "_x" }, { a: "x".repeat(41) }, { a: "caf\u00e9" },
      // A word that is most of a secret is still one.
      { a: "dp_" + "ab".repeat(10) }, { a: "dpl_" + "0".repeat(12) }, { a: "dpe_" + "0".repeat(12) }, { a: "x" + "ab".repeat(16) },
      // Keys follow the same rule, and a key that names a part of every object is refused, not dropped.
      { "": 1 }, { Old: 1 }, { "a b": 1 }, { ["x".repeat(41)]: 1 }, proto, { constructor: 1 }, { prototype: 1 }, { ["__proto__"]: 1 }, many,
    ]) {
      expect(() => auditStatement(deps, { event: "signin", detail: d as never }), JSON.stringify(d)).toThrow("audit: a value that must not be recorded");
    }
    expect(Object.keys(proto)).toEqual(["__proto__"]);

    // An account, a workspace and a subject are named by id and by nothing else: a prefix of
    // two to four lowercase letters, an underscore and 24 lowercase hex characters.
    const HEX = "0123456789abcdef01234567";
    for (const id of ["", "usr_1", "ses_1", "usr_" + HEX.slice(1), "usr_" + HEX + "0", "USR_" + HEX, "usr_" + HEX.toUpperCase(), "u_" + HEX, "users_" + HEX, "usr-" + HEX, HEX, " usr_" + HEX, "usr_" + HEX + "\n", "owner", "alex"]) {
      for (const field of ["userId", "workspaceId", "subject"]) {
        expect(() => auditStatement(deps, { event: "signin", [field]: id }), `${field} ${JSON.stringify(id)}`).toThrow("audit: a value that must not be recorded");
      }
    }
    for (const id of ["usr_" + HEX, "ws_" + HEX, "tour_" + HEX, "ses_" + HEX, "aud_" + HEX]) auditStatement(deps, { event: "signin", userId: id, workspaceId: id, subject: id });

    // What is recorded: ids and plain numbers, and none of the secrets anywhere in the account tables.
    await deps.db.batch([
      auditStatement(deps, { event: "first_admin", userId: a.userId, workspaceId: a.workspaceId, subject: a.userId }),
      auditStatement(deps, { event: "allowance_set", userId: a.userId, workspaceId: a.workspaceId, subject: a.workspaceId, detail: { old: 0, new: 5_000_000, unit: "bytes" } }),
    ]);
    expect(await count(deps, "audit")).toBe(2);
    await deps.db.run("UPDATE user SET email = 'hidden' WHERE id = ?", [a.userId]);
    for (const v of await everyAccountValue(deps)) {
      for (const s of [token, token.slice(3), code, secret, a.email, "@"]) expect(v).not.toContain(s);
    }
  });
});
