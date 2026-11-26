// The account a token belongs to (migration 0025) across an upgrade, on both targets: each
// target's own runner applies what a database does not have yet, by name, so a site at 0024
// gets 0025 and one at 0022 gets 0024 and then 0025 (0023 is unused on purpose). A site whose
// database the migration has not reached yet still claims setup, makes workspaces and connects
// the app, and GET /api/v1/me answers without an account for its tokens; once migrated, a
// connection made before is given its account from the record of its collection, and nothing
// else is.
import { describe, expect, it } from "vitest";
import { makeDepsBefore, seedWorkspace } from "#harness";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, send } from "./bundle.ts";

const MINE = "0025_token_account.sql";
const CODE = "correct-horse-battery-staple";
const JSON_HEADERS = { "content-type": "application/json" };

const me = async (deps: Deps, token: string) => {
  const r = await send(deps, "GET", "/api/v1/me", { token });
  expect(r.status, r.text).toBe(200);
  return r.json as { workspace_id: string; account_id: string | null };
};

async function signIn(deps: Deps, userId: string) {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

/** Connects the app as the app and the signed-in page do it, and answers the token it collected. */
async function connect(deps: Deps, s: { cookie: string; csrf: string }): Promise<string> {
  const started = await send(deps, "POST", "/api/v1/connect/start", { body: JSON.stringify({ device_name: "Laptop" }), headers: JSON_HEADERS });
  expect(started.status, started.text).toBe(201);
  const page = { cookie: s.cookie, origin: ORIGIN, "x-csrf-token": s.csrf, "sec-fetch-site": "same-origin", ...JSON_HEADERS };
  const confirmed = await send(deps, "POST", "/api/v1/connect/confirm", { body: JSON.stringify({ user_code: started.json.user_code }), headers: page });
  expect(confirmed.status, confirmed.text).toBe(204);
  const collected = await send(deps, "POST", "/api/v1/connect/token", { body: JSON.stringify({ device_code: started.json.device_code }), headers: JSON_HEADERS });
  expect(collected.status, collected.text).toBe(200);
  return collected.json.token as string;
}

describe("the token account migration across an upgrade", () => {
  it("a database at 0024 gets 0025 alone, and one at 0022 gets 0024 and then 0025", async () => {
    const at24 = await makeDepsBefore((n) => n < "0025");
    expect((await at24.applied()).at(-1)).toBe("0024_billing_removal.sql");
    // 0026 (0.1.66, the low storage mails) follows it.
    expect(await at24.migrate()).toEqual([MINE, "0026_storage_mail.sql"]);
    expect(await at24.migrate()).toEqual([]);
    expect((await at24.applied()).at(-1)).toBe("0026_storage_mail.sql");

    const at22 = await makeDepsBefore((n) => n < "0023");
    expect((await at22.applied()).at(-1)).toBe("0022_billing_checks.sql");
    expect(await at22.migrate()).toEqual(["0024_billing_removal.sql", MINE, "0026_storage_mail.sql"]);
    expect((await at22.applied()).filter((n) => n.startsWith("0023_"))).toEqual([]);
  });

  it("before the migration a site claims setup, makes workspaces and connects the app, with no account for its tokens; after it, a connection gets its account from its record", async () => {
    const site = await makeDepsBefore((n) => n !== MINE, { setupCode: CODE });
    const { deps } = site;
    expect(await site.applied()).not.toContain(MINE);

    // The setup claim, on a database without the column.
    const claimed = await send(deps, "POST", "/setup/claim", { body: JSON.stringify({ code: CODE, workspace: "Acme", email: "owner@example.com" }), headers: { ...JSON_HEADERS, origin: ORIGIN } });
    expect(claimed.status, claimed.text).toBe(201);
    const owner = (await deps.db.first<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM user WHERE email = ?", ["owner@example.com"]))!;
    expect(await me(deps, claimed.json.token)).toMatchObject({ workspace_id: owner.workspace_id, account_id: null });

    // A session names its account whatever the tokens' table holds.
    await deps.db.run("UPDATE user SET is_admin = 1, username = 'owner' WHERE id = ?", [owner.id]);
    const session = await signIn(deps, owner.id);
    const bySession = await send(deps, "GET", "/api/v1/me", { headers: { cookie: session.cookie } });
    expect([bySession.status, bySession.json.account_id]).toEqual([200, owner.id]);

    // Connecting the app, and a new workspace.
    const connected = await connect(deps, session);
    expect(await me(deps, connected)).toMatchObject({ workspace_id: owner.workspace_id, account_id: null });
    const other = await seedWorkspace(deps, "Other");
    expect(await me(deps, other.token)).toMatchObject({ workspace_id: other.workspaceId, account_id: null });

    // The migration: the connection's record names the owner, a member of its workspace; the
    // first tokens have no record and stay without an account.
    expect(await site.migrate()).toEqual([MINE]);
    expect((await me(deps, connected)).account_id).toBe(owner.id);
    expect((await me(deps, claimed.json.token)).account_id).toBeNull();
    expect((await me(deps, other.token)).account_id).toBeNull();

    // From now on every new token names its account.
    expect((await me(deps, await connect(deps, session))).account_id).toBe(owner.id);
    const later = await seedWorkspace(deps, "Later");
    const laterOwner = (await deps.db.first<{ id: string }>("SELECT id FROM user WHERE workspace_id = ?", [later.workspaceId]))!.id;
    expect(await me(deps, later.token)).toMatchObject({ workspace_id: later.workspaceId, account_id: laterOwner });
  });
});
