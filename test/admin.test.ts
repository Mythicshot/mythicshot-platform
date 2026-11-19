// The first admin and the printed sign-in link, as the server command uses them. Runs on
// both targets: nothing here is the command itself (test/node-admin-command.test.ts).
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount, seedWorkspace } from "#harness";
import { hasAdmin, workspaceOf } from "../src/accounts.ts";
import { claimFirstAdmin, signInLinkFor } from "../src/admin.ts";
import { requireAuth } from "../src/auth.ts";
import type { Deps } from "../src/ports.ts";
import { redeemSignInCode } from "../src/sessions.ts";
import { workspaceStatements } from "../src/workspaces.ts";

const NOW = 1_800_000_000_000;
const TWO_ADDRESSES = { hosts: { tours: "tours.example.com", app: "app.example.com" } };

/** A site as the setup wizard leaves it: one workspace, its owner, one token and the setup row. */
async function setUpSite(deps: Deps, email = "typed-at-setup@example.com"): Promise<{ workspaceId: string; userId: string; token: string }> {
  const w = await workspaceStatements(deps, "Acme", email);
  await deps.db.batch([...w.stmts, { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, ?)", params: [w.workspaceId, deps.now()] }]);
  return { workspaceId: w.workspaceId, userId: w.userId, token: w.token };
}

/** Every row of the tables a claim or a printed link may write, in a fixed order. */
async function accountRows(deps: Deps): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const t of ["user", "membership", "signin_method", "signin_code", "session", "audit", "workspace", "api_token", "setup"]) {
    out[t] = await deps.db.all(`SELECT * FROM ${t} ORDER BY 1, 2`);
  }
  return out;
}

async function tokenWorks(deps: Deps, token: string): Promise<string | null> {
  const auth = await requireAuth(new Request("https://tours.example.com/api/v1/me", { headers: { authorization: "Bearer " + token } }), deps);
  return auth instanceof Response ? null : auth.workspaceId;
}

describe("the first admin", () => {
  it("the owner becomes the admin with the given email and username", async () => {
    const { deps, calls } = await makeDeps();
    deps.now = () => NOW;
    const site = await setUpSite(deps);
    const other = await seedAccount(deps);
    const otherBefore = await deps.db.first("SELECT * FROM user WHERE id = ?", [other.userId]);

    const before = calls();
    // The address and the name are stored in their one form, whatever case they were typed in.
    const claim = await claimFirstAdmin(deps, { email: "  You@Example.com ", username: " Alex\n" });
    expect(claim).toEqual({ ok: true, userId: site.userId });
    // One read and one batch.
    expect(calls() - before).toBe(2);

    expect(await deps.db.first("SELECT * FROM user WHERE id = ?", [site.userId])).toEqual({
      id: site.userId,
      workspace_id: site.workspaceId,
      email: "you@example.com",
      created_at: NOW,
      username: "alex",
      status: "active",
      is_admin: 1,
    });
    expect(await hasAdmin(deps)).toBe(true);
    // Nobody else changed, and nothing of the workspace did: its token still resolves to it.
    expect(await deps.db.first("SELECT * FROM user WHERE id = ?", [other.userId])).toEqual(otherBefore);
    expect(await deps.db.all("SELECT id FROM user WHERE is_admin = 1")).toEqual([{ id: site.userId }]);
    expect(await tokenWorks(deps, site.token)).toBe(site.workspaceId);
    expect(await tokenWorks(deps, other.token)).toBe(other.workspaceId);
    expect(await workspaceOf(deps, site.userId)).toBe(site.workspaceId);
    expect(await deps.db.all("SELECT kind FROM signin_method WHERE user_id = ?", [site.userId])).toEqual([{ kind: "email_link" }]);
    // No sign-in code and no session is made by the claim itself.
    expect(await deps.db.all("SELECT * FROM signin_code")).toEqual([]);
    expect(await deps.db.all("SELECT * FROM session")).toEqual([]);
  });

  it("an owner whose stored address is not one gets the address given", async () => {
    const { deps } = await makeDeps();
    // The setup wizard took any text with one @ in it.
    const site = await setUpSite(deps, "owner@localhost");
    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" })).toEqual({ ok: true, userId: site.userId });
    expect(await deps.db.first("SELECT email FROM user WHERE id = ?", [site.userId])).toEqual({ email: "you@example.com" });
    // The owner's own address, given again, is not somebody else's.
    const again = await makeDeps();
    const same = await setUpSite(again.deps, "you@example.com");
    expect(await claimFirstAdmin(again.deps, { email: "You@example.com", username: "alex" })).toEqual({ ok: true, userId: same.userId });
  });

  it("on a site that was rolled back and forward the owner is found by its own row and gets its membership and sign-in method", async () => {
    const { deps } = await makeDeps();
    deps.now = () => NOW;
    // The version before accounts ran on this database after it was migrated: its setup
    // wrote a workspace, an owner, a token and the setup row, and nothing else.
    const ws = "ws_" + "a".repeat(24);
    const owner = "usr_" + "a".repeat(24);
    await deps.db.batch([
      { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, 'Old', 111)", params: [ws] },
      { sql: "INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, 'old@example.com', 111)", params: [owner, ws] },
      { sql: "INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, 'First token', ?, 111)", params: ["tok_" + "a".repeat(24), ws, "a".repeat(64)] },
      { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, 111)", params: [ws] },
    ]);
    expect(await workspaceOf(deps, owner)).toBeNull();
    expect(await deps.db.all("SELECT * FROM signin_method")).toEqual([]);

    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" })).toEqual({ ok: true, userId: owner });
    expect(await deps.db.first("SELECT email, username, is_admin FROM user WHERE id = ?", [owner])).toEqual({ email: "you@example.com", username: "alex", is_admin: 1 });
    // The rows are dated as the account is, like the ones the migration wrote.
    expect(await deps.db.all("SELECT * FROM membership")).toEqual([{ workspace_id: ws, user_id: owner, role: "owner", created_at: 111 }]);
    expect(await deps.db.all("SELECT * FROM signin_method")).toEqual([{ user_id: owner, kind: "email_link", created_at: 111 }]);
    expect(await deps.db.first("SELECT user_id, workspace_id, subject FROM audit WHERE event = 'first_admin'")).toEqual({ user_id: owner, workspace_id: ws, subject: owner });

    // So a printed link signs this owner in.
    const link = await signInLinkFor({ ...deps, config: { ...deps.config, ...TWO_ADDRESSES } }, "you@example.com");
    if (!link.ok) throw new Error("no link");
    const signedIn = await redeemSignInCode(deps, link.link.split("#c=")[1], null, null);
    expect(signedIn?.userId).toBe(owner);
  });

  it("it works once", async () => {
    const { deps, calls } = await makeDeps();
    const site = await setUpSite(deps);
    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" })).toEqual({ ok: true, userId: site.userId });
    const after = await accountRows(deps);

    // The same claim again, and another one: both are told what is already true.
    const before = calls();
    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" })).toEqual({ ok: false, problem: "has_admin" });
    // Refused by the one read: nothing is sent to be written.
    expect(calls() - before).toBe(1);
    expect(await claimFirstAdmin(deps, { email: "other@example.com", username: "sam" })).toEqual({ ok: false, problem: "has_admin" });
    expect(await accountRows(deps)).toEqual(after);

    // An admin that is not the owner, or one that is disabled, still is the site's admin.
    const second = await makeDeps();
    await setUpSite(second.deps);
    const admin = await seedAccount(second.deps, { username: "sam", admin: true });
    await second.deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [admin.userId]);
    const rows = await accountRows(second.deps);
    expect(await claimFirstAdmin(second.deps, { email: "you@example.com", username: "alex" })).toEqual({ ok: false, problem: "has_admin" });
    expect(await accountRows(second.deps)).toEqual(rows);
  });

  it("two claims at once make one admin", async () => {
    const { deps } = await makeDeps();
    const site = await setUpSite(deps);
    const results = await Promise.all([
      claimFirstAdmin(deps, { email: "one@example.com", username: "one" }),
      claimFirstAdmin(deps, { email: "two@example.com", username: "two" }),
      claimFirstAdmin(deps, { email: "one@example.com", username: "one" }),
    ]);
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, userId: site.userId }]);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, problem: "has_admin" }, { ok: false, problem: "has_admin" }]);
    expect(await deps.db.all("SELECT id FROM user WHERE is_admin = 1")).toEqual([{ id: site.userId }]);
    expect(await deps.db.all("SELECT event FROM audit")).toEqual([{ event: "first_admin" }]);
    // The account is whole: the address and the name are of one claim, not of two.
    const row = (await deps.db.first<{ email: string; username: string }>("SELECT email, username FROM user WHERE id = ?", [site.userId]))!;
    expect([row.email, row.username]).toEqual(results[0].ok ? ["one@example.com", "one"] : results[1].ok ? ["two@example.com", "two"] : ["one@example.com", "one"]);
  });

  it("a claim that loses the race after its own read changes nothing", async () => {
    const { deps } = await makeDeps();
    const site = await setUpSite(deps);
    // Another claim is written between this claim's read and its batch.
    const realBatch = deps.db.batch.bind(deps.db);
    let raced = false;
    deps.db.batch = async (stmts) => {
      if (!raced) {
        raced = true;
        await realBatch([{ sql: "UPDATE user SET is_admin = 1, username = 'first' WHERE id = ?", params: [site.userId] }]);
      }
      return realBatch(stmts);
    };
    const before = await deps.db.first("SELECT email FROM user WHERE id = ?", [site.userId]);
    expect(await claimFirstAdmin(deps, { email: "late@example.com", username: "late" })).toEqual({ ok: false, problem: "has_admin" });
    expect(await deps.db.first("SELECT email, username, is_admin FROM user WHERE id = ?", [site.userId])).toEqual({ ...(before as object), username: "first", is_admin: 1 });
    expect(await deps.db.all("SELECT * FROM audit")).toEqual([]);
  });

  it("a site that was never set up has nobody to make admin", async () => {
    const { deps } = await makeDeps();
    // An empty database, and one with workspaces but no setup row.
    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" })).toEqual({ ok: false, problem: "not_set_up" });
    await seedWorkspace(deps, "No setup");
    const rows = await accountRows(deps);
    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" })).toEqual({ ok: false, problem: "not_set_up" });
    expect(await accountRows(deps)).toEqual(rows);
    expect(await hasAdmin(deps)).toBe(false);
  });

  it("a reserved or taken username and a taken email are refused and nothing changes", async () => {
    const { deps, calls } = await makeDeps();
    await setUpSite(deps);
    const other = await seedAccount(deps, { username: "sam" });
    const rows = await accountRows(deps);

    const before = calls();
    for (const email of ["", "you", "you@localhost", "you@example.com\n", "a b@example.com", "<you@example.com>", 5 as unknown as string]) {
      expect(await claimFirstAdmin(deps, { email, username: "alex" }), String(email)).toEqual({ ok: false, problem: "bad_email" });
    }
    for (const username of ["", "al", "1alex", "alex-", "al--ex", "al ex", "a".repeat(31), "álex", null as unknown as string]) {
      expect(await claimFirstAdmin(deps, { email: "you@example.com", username }), String(username)).toEqual({ ok: false, problem: "bad_username" });
    }
    for (const username of ["admin", "Admin", "ad-min", "root", "support", "mythicshot", "my-mythicshot-fan", "no-reply"]) {
      expect(await claimFirstAdmin(deps, { email: "you@example.com", username }), username).toEqual({ ok: false, problem: "reserved" });
    }
    // None of these reached the database.
    expect(calls() - before).toBe(0);

    expect(await claimFirstAdmin(deps, { email: other.email.toUpperCase(), username: "alex" })).toEqual({ ok: false, problem: "email_taken" });
    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "SAM" })).toEqual({ ok: false, problem: "username_taken" });
    expect(await accountRows(deps)).toEqual(rows);
    expect(await hasAdmin(deps)).toBe(false);

    // A name or an address taken between the read and the batch is refused the same way.
    const realBatch = deps.db.batch.bind(deps.db);
    const third = await seedAccount(deps);
    let step = 0;
    deps.db.batch = async (stmts) => {
      step += 1;
      if (step === 1) await realBatch([{ sql: "UPDATE user SET username = 'alex' WHERE id = ?", params: [third.userId] }]);
      if (step === 2) await realBatch([{ sql: "UPDATE user SET email = 'you@example.com' WHERE id = ?", params: [third.userId] }]);
      return realBatch(stmts);
    };
    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" })).toEqual({ ok: false, problem: "username_taken" });
    expect(await claimFirstAdmin(deps, { email: "you@example.com", username: "kim" })).toEqual({ ok: false, problem: "email_taken" });
    expect(await hasAdmin(deps)).toBe(false);
    expect(await deps.db.all("SELECT * FROM audit")).toEqual([]);
  });

  it("the claim is in the audit record without the email", async () => {
    const { deps } = await makeDeps();
    deps.now = () => NOW;
    const site = await setUpSite(deps);
    // A refused claim is not recorded.
    expect((await claimFirstAdmin(deps, { email: "you@example.com", username: "admin" })).ok).toBe(false);
    expect(await deps.db.all("SELECT * FROM audit")).toEqual([]);

    await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" });
    const rows = await deps.db.all<Record<string, unknown>>("SELECT * FROM audit");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: expect.stringMatching(/^aud_[0-9a-f]{24}$/), at: NOW, event: "first_admin", user_id: site.userId, workspace_id: site.workspaceId, subject: site.userId, detail: null });
    const text = JSON.stringify(rows);
    for (const never of ["you@example.com", "example.com", "alex", "typed-at-setup", "@"]) expect(text, never).not.toContain(never);
  });
});

describe("the printed sign-in link", () => {
  it("is a link on the configured address that signs the account in once, recorded with ids only", async () => {
    const { deps } = await makeDeps(TWO_ADDRESSES);
    deps.now = () => NOW;
    const site = await setUpSite(deps);
    await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" });
    const member = await seedAccount(deps);

    const made = await signInLinkFor(deps, " You@Example.com ");
    if (!made.ok) throw new Error("no link");
    expect(made).toEqual({ ok: true, whole: true, userId: site.userId, link: expect.stringMatching(/^https:\/\/app\.example\.com\/signin\/link#c=dpl_[0-9a-f]{40}$/) });
    const code = made.link.split("#c=")[1];
    // Only the code's digest is stored, and it ends 15 minutes later.
    const stored = await deps.db.all<Record<string, unknown>>("SELECT * FROM signin_code");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ user_id: site.userId, created_at: NOW, expires_at: NOW + 900_000, used_at: null });
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(JSON.stringify(stored)).not.toContain(code.slice(4));

    const audit = await deps.db.all<Record<string, unknown>>("SELECT * FROM audit WHERE event = 'signin_link_printed'");
    expect(audit).toEqual([{ id: expect.stringMatching(/^aud_[0-9a-f]{24}$/), at: NOW, event: "signin_link_printed", user_id: site.userId, workspace_id: site.workspaceId, subject: site.userId, detail: null }]);
    for (const never of [code, code.slice(4), "example.com", "@", String(stored[0].hash)]) expect(JSON.stringify(await deps.db.all("SELECT * FROM audit")), never).not.toContain(never);

    // It signs in once, as a mailed link does.
    const session = await redeemSignInCode(deps, code, "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0", null);
    expect(session).toMatchObject({ userId: site.userId, secret: expect.stringMatching(/^dps_[0-9a-f]{64}$/) });
    expect(await redeemSignInCode(deps, code, null, null)).toBeNull();
    // And after 15 minutes a link is worth nothing.
    const late = await signInLinkFor(deps, "you@example.com");
    if (!late.ok) throw new Error("no link");
    deps.now = () => NOW + 900_000;
    expect(await redeemSignInCode(deps, late.link.split("#c=")[1], null, null)).toBeNull();
    deps.now = () => NOW;

    // Any active account of a site with an admin can be given one; each link is its own.
    const forMember = await signInLinkFor(deps, member.email);
    if (!forMember.ok) throw new Error("no link");
    expect(forMember.userId).toBe(member.userId);
    expect(forMember.link).not.toBe(made.link);
    expect((await redeemSignInCode(deps, forMember.link.split("#c=")[1], null, null))?.userId).toBe(member.userId);
  });

  it("a stranger, a disabled account, an account that cannot sign in by link and a site without an admin get none, and nothing is written", async () => {
    const { deps } = await makeDeps(TWO_ADDRESSES);
    const site = await setUpSite(deps, "you@example.com");
    const member = await seedAccount(deps);

    // No admin yet: not for the owner either.
    let rows = await accountRows(deps);
    expect(await signInLinkFor(deps, "you@example.com")).toEqual({ ok: false });
    expect(await signInLinkFor(deps, member.email)).toEqual({ ok: false });
    expect(await accountRows(deps)).toEqual(rows);

    await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" });
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [member.userId]);
    const noMethod = await seedAccount(deps);
    await deps.db.run("DELETE FROM signin_method WHERE user_id = ?", [noMethod.userId]);
    const noWorkspace = await seedAccount(deps);
    await deps.db.run("DELETE FROM membership WHERE user_id = ?", [noWorkspace.userId]);
    rows = await accountRows(deps);
    for (const email of ["stranger@example.com", member.email, noMethod.email, noWorkspace.email, "not an address", "", "alex", 7 as unknown as string]) {
      expect(await signInLinkFor(deps, email), String(email)).toEqual({ ok: false });
    }
    expect(await accountRows(deps)).toEqual(rows);
    // The admin's own account still gets one.
    expect((await signInLinkFor(deps, "you@example.com")).ok).toBe(true);
    expect(site.userId).toMatch(/^usr_/);
  });

  it("without a configured address the link is a path, and it never comes from anything but the configuration", async () => {
    const { deps } = await makeDeps();
    await setUpSite(deps, "you@example.com");
    await claimFirstAdmin(deps, { email: "you@example.com", username: "alex" });
    const path = await signInLinkFor(deps, "you@example.com");
    expect(path).toMatchObject({ ok: true, whole: false, link: expect.stringMatching(/^\/signin\/link#c=dpl_[0-9a-f]{40}$/) });

    // One address with SITE_HOST: that host. Two addresses: the app address, whatever SITE_HOST says.
    const one = await signInLinkFor({ ...deps, config: { ...deps.config, siteHost: "tours.example.com" } }, "you@example.com");
    expect(one).toMatchObject({ ok: true, whole: true, link: expect.stringMatching(/^https:\/\/tours\.example\.com\/signin\/link#c=dpl_[0-9a-f]{40}$/) });
    const two = await signInLinkFor({ ...deps, config: { ...deps.config, ...TWO_ADDRESSES, siteHost: "other.example.com" } }, "you@example.com");
    expect(two).toMatchObject({ ok: true, whole: true, link: expect.stringMatching(/^https:\/\/app\.example\.com\/signin\/link#c=dpl_[0-9a-f]{40}$/) });
    // A path signs in like a whole link.
    if (!path.ok) throw new Error("no link");
    expect(await redeemSignInCode(deps, path.link.split("#c=")[1], null, null)).not.toBeNull();
  });
});
