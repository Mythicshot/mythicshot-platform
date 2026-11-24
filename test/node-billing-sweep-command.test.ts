// The server command's billing-sweep (0.1.62, src/node/admin.ts), run in this process on a database
// file in a scratch folder, as `cpanel.sh admin billing-sweep` runs it. Node only. No mail is
// sent and Stripe is never reached: the fake mailer and the fake Stripe are handed in.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DAY, TRIAL_MS } from "../src/billing-rules.ts";
import { ADMIN_SETTINGS, REMOVAL_SETTING, runAdmin } from "../src/node/admin.ts";
import { NODE_SETTINGS } from "../src/node/config.ts";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { removalDayOf } from "../src/removal-rules.ts";
import { emailSha256 } from "../src/removal-store.ts";
import { workspaceStatements } from "../src/workspaces.ts";
import { FakeMailer } from "./fake-mail.ts";
import { FakeStripe } from "./fake-stripe.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const BILLING_ENV = { STRIPE_API_KEY: "rk_test_FAKE", STRIPE_WEBHOOK_SECRET: "whsec_FAKE", STRIPE_PRICE_ID: "price_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_test_FAKE" };
const BASE_ENV = { SETUP_CODE: "made-up-setup-code-0123456789abcdef", TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" };
const SMTP = { MAIL_MODE: "smtp", MAIL_FROM: "no-reply@example.com", SMTP_HOST: "mail.example.com", SMTP_PORT: "465", SMTP_USER: "no-reply@example.com", SMTP_PASSWORD: "made-up-password" };

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const none = { put: async () => {}, get: async () => null, delete: async () => {} };

/** A data folder whose database has every migration (or all but 0024), the site's own workspace and one more, on a trial whose removal is due with all three warnings sent. */
async function site(opts: { removalMigration?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "demo-platform-test-sweep-"));
  made.push(dir);
  let migrations = MIGRATIONS_DIR;
  if (opts.removalMigration === false) {
    const { cpSync } = await import("node:fs");
    migrations = join(dir, "migrations-before-removal");
    cpSync(MIGRATIONS_DIR, migrations, { recursive: true, filter: (from) => !from.endsWith("0024_billing_removal.sql") });
  }
  const db = new NodeDb(join(dir, "db.sqlite"));
  await migrate(db, migrations);
  const created = Date.now() - 200 * DAY;
  const deps: Deps = { db, drafts: none, pub: none, config: { publicImageBase: "", setupCode: null }, now: () => created };
  const owner = await workspaceStatements(deps, "Owner", "owner@example.com");
  await db.batch([...owner.stmts, { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, 1)", params: [owner.workspaceId] }, { sql: "UPDATE user SET is_admin = 1 WHERE id = ?", params: [owner.userId] }]);
  const trial = await workspaceStatements(deps, "Trial", "trial@example.com");
  await db.batch([...trial.stmts, { sql: "UPDATE workspace SET billing_trial = 1 WHERE id = ?", params: [trial.workspaceId] }]);
  if (opts.removalMigration !== false) {
    const day = removalDayOf(created + TRIAL_MS);
    const sha = await emailSha256("trial@example.com");
    for (const [stage, at] of [[30, day - 30 * DAY], [7, day - 7 * DAY], [1, day - DAY]]) {
      await db.run("INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [trial.workspaceId, day, stage, sha, at, at, day]);
    }
  }
  db.close();
  return { dir, env: { DATA_DIR: dir, ...BASE_ENV }, workspaceId: trial.workspaceId };
}

async function run(env: NodeJS.ProcessEnv, argv: string[]) {
  const lines: string[] = [];
  const stripe = new FakeStripe();
  const mail = new FakeMailer();
  const code = await runAdmin(argv, env, (line) => lines.push(line), { makeMailer: () => mail, makeStripe: () => stripe });
  return { code, lines, stripe, mail };
}

function rowsOf(dir: string, sql: string, params: (string | number)[] = []) {
  const db = new NodeDb(join(dir, "db.sqlite"));
  try {
    return db.raw.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

describe("billing-sweep", () => {
  it("is in the usage, takes --dry-run alone, and refuses anything else", async () => {
    const s = await site();
    const help = await run(s.env, ["--help"]);
    expect(help.lines.join("\n")).toContain("billing-sweep [--dry-run]");
    for (const argv of [["billing-sweep", "--dry-run", "--dry-run"], ["billing-sweep", "now"], ["billing-sweep", "--dry-run=yes"]]) {
      expect((await run(s.env, argv)).code, argv.join(" ")).toBe(2);
    }
  });

  it("BILLING_REMOVAL is read by this command only, and cleared from the shell like every other setting", () => {
    expect(REMOVAL_SETTING).toBe("BILLING_REMOVAL");
    expect(ADMIN_SETTINGS).toContain("BILLING_REMOVAL");
    expect(NODE_SETTINGS).not.toContain("BILLING_REMOVAL");
  });

  it("without billing it says so and changes nothing", async () => {
    const s = await site();
    const before = rowsOf(s.dir, "SELECT * FROM workspace ORDER BY id");
    const r = await run({ ...s.env, ...SMTP, BILLING_REMOVAL: "on" }, ["billing-sweep"]);
    expect(r).toMatchObject({ code: 0, lines: ["Billing is off on this site, so there is nothing to sweep. Nothing was changed."] });
    expect(rowsOf(s.dir, "SELECT * FROM workspace ORDER BY id")).toEqual(before);
  });

  it("with BILLING_REMOVAL unset nothing is removed; the dry run lists it and changes nothing; with it on it is removed; counts only, never an address", async () => {
    const s = await site();
    const env = { ...s.env, ...SMTP, ...BILLING_ENV };
    const off = await run(env, ["billing-sweep"]);
    expect(off.code).toBe(0);
    expect(off.lines).toContain("Removal is off (BILLING_REMOVAL is not on). Workspaces that would be due: 1.");
    expect(rowsOf(s.dir, "SELECT id FROM workspace WHERE id = ?", [s.workspaceId])).toHaveLength(1);
    for (const value of ["yes", "true", "1", ""]) {
      await run({ ...env, BILLING_REMOVAL: value }, ["billing-sweep"]);
      expect(rowsOf(s.dir, "SELECT id FROM workspace WHERE id = ?", [s.workspaceId]), value).toHaveLength(1);
    }
    const dump = () => rowsOf(s.dir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => [(t as { name: string }).name, rowsOf(s.dir, `SELECT * FROM "${(t as { name: string }).name}"`)]);
    const before = dump();
    const dry = await run({ ...env, BILLING_REMOVAL: "on" }, ["billing-sweep", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.lines[0]).toBe("Dry run: nothing was sent, changed or removed.");
    expect(dry.lines).toContain(`  would remove ${s.workspaceId}`);
    expect(dump()).toEqual(before);
    const on = await run({ ...env, BILLING_REMOVAL: " ON " }, ["billing-sweep"]);
    expect(on.code).toBe(0);
    expect(on.lines).toContain("Removals started: 1. Finished: 1. Still in progress: 0.");
    expect(rowsOf(s.dir, "SELECT id FROM workspace WHERE id = ?", [s.workspaceId])).toHaveLength(0);
    // The site's own workspace is untouched; Stripe was asked only for its time (0.1.62: a trial has nothing else there), and no mail went.
    expect(rowsOf(s.dir, "SELECT id FROM workspace")).toHaveLength(1);
    expect(on.stripe.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/prices/price_FAKE"]);
    for (const r of [off, dry, on]) expect(r.lines.join("\n")).not.toMatch(/@|rk_test|whsec|made-up/);
  });

  it("--clear-claim clears one workspace's unconfirmed claim, audited, and refuses anything but a workspace id", async () => {
    const s = await site();
    const db = new NodeDb(join(s.dir, "db.sqlite"));
    await db.run("UPDATE billing_warning SET sent_at = NULL WHERE workspace_id = ? AND stage = 1", [s.workspaceId]);
    db.close();
    const env = { ...s.env, ...BILLING_ENV };
    expect((await run(env, ["billing-sweep", "--clear-claim", "nobody"])).code).toBe(2);
    expect((await run(env, ["billing-sweep", "--clear-claim"])).code).toBe(2);
    const r = await run(env, ["billing-sweep", "--clear-claim", s.workspaceId]);
    expect(r).toMatchObject({ code: 0, lines: ["Cleared 1 unconfirmed warning mail; the next sweep sends it again."] });
    expect(rowsOf(s.dir, "SELECT stage FROM billing_warning WHERE workspace_id = ? ORDER BY stage", [s.workspaceId])).toEqual([{ stage: 7 }, { stage: 30 }]);
    expect(rowsOf(s.dir, "SELECT event FROM audit WHERE event = 'billing_warning_claim_cleared'")).toHaveLength(1);
    expect((await run(env, ["billing-sweep", "--clear-claim", s.workspaceId])).lines).toEqual(["That workspace has no unconfirmed warning mail. Nothing was changed."]);
  });

  it("on a database without the removal migration it says to update first", async () => {
    const s = await site({ removalMigration: false });
    const r = await run({ ...s.env, ...BILLING_ENV }, ["billing-sweep"]);
    expect(r).toMatchObject({ code: 1, lines: ["The database is from an older version. Update the site first."] });
  });
});
