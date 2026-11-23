// Migration 0021 (billing) on a database that already holds workspaces at the version before it
// (Node only: the shared harness always applies every migration to an empty database). Every
// workspace there is off the trial clock (billing_trial 0), so billing never puts it on it;
// every row keeps what it had; the statements of the version before it still run and make
// workspaces off the trial clock too; the new columns and the checkout record take only their
// shapes; and a second application stops at its first statement.
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0021_billing.sql";
const NEW_COLUMNS = [
  "billing_trial",
  "stripe_customer_id",
  "stripe_subscription_id",
  "subscription_status",
  "subscription_period_end",
  "subscription_cancel_at",
  "subscription_cancel_at_period_end",
  "subscription_ended_at",
  "checkout_session_id",
  "checkout_created_at",
];

async function everything(db: NodeDb): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of ["workspace", "user", "membership", "api_token", "tour"]) out[t] = await db.all(`SELECT * FROM ${t} ORDER BY 1`);
  return out;
}

describe("migration 0021 on an existing install", () => {
  it("marks every workspace there is as an existing account and changes nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const before = join(root, "before");
    const upTo = join(root, "upto");
    await mkdir(before);
    await mkdir(upTo);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const at = files.indexOf(NAME);
    expect(at).toBe(20);
    for (const f of files.slice(0, at)) await copyFile(join(MIGRATIONS_DIR, f), join(before, f));
    for (const f of files.slice(0, at + 1)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    try {
      expect(await migrate(db, before)).toEqual(files.slice(0, at));
      for (const ws of ["ws_1", "ws_2"]) await db.run("INSERT INTO workspace (id, name, created_at, storage_allowance_bytes) VALUES (?, 'W', 1, NULL)", [ws]);
      await db.run("UPDATE workspace SET storage_allowance_bytes = 5 WHERE id = 'ws_2'");
      await db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES ('usr_1', 'ws_1', 'owner@example.com', 1)");
      await db.run("INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES ('ws_1', 'usr_1', 'owner', 1)");
      const old = await everything(db);

      expect(await migrate(db, upTo)).toEqual([NAME]);
      const after = await everything(db);
      const strip = (rows: unknown[]) => rows.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => !NEW_COLUMNS.includes(k))));
      expect({ ...after, workspace: strip(after.workspace) }).toEqual(old);
      expect(await db.all("SELECT id, billing_trial, stripe_customer_id, subscription_status, subscription_cancel_at_period_end, checkout_session_id FROM workspace ORDER BY id")).toEqual([
        { id: "ws_1", billing_trial: 0, stripe_customer_id: null, subscription_status: null, subscription_cancel_at_period_end: 0, checkout_session_id: null },
        { id: "ws_2", billing_trial: 0, stripe_customer_id: null, subscription_status: null, subscription_cancel_at_period_end: 0, checkout_session_id: null },
      ]);
      expect(await db.all("SELECT * FROM stripe_event")).toEqual([]);
      expect(await db.all("SELECT * FROM stripe_checkout")).toEqual([]);

      // The version before it still makes a workspace, which is off the trial clock: only a build with billing on puts one on it.
      await db.run("INSERT INTO workspace (id, name, created_at) VALUES ('ws_3', 'Later', 3)");
      expect(await db.first("SELECT billing_trial FROM workspace WHERE id = 'ws_3'")).toEqual({ billing_trial: 0 });

      // The columns take only their shapes, and a customer, subscription or checkout belongs to one workspace.
      for (const sql of [
        "UPDATE workspace SET billing_trial = 2 WHERE id = 'ws_3'",
        "INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES ('cus_1', 'ws_3', 1, 2)",
        "INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES ('cs_1', 'ws_none', 1, 2)",
        "UPDATE workspace SET stripe_customer_id = 'sub_1' WHERE id = 'ws_3'",
        "UPDATE workspace SET stripe_customer_id = 'cus_a-b' WHERE id = 'ws_3'",
        "UPDATE workspace SET stripe_customer_id = 'cus_a' || char(0) || 'b' WHERE id = 'ws_3'",
        "UPDATE workspace SET stripe_subscription_id = 'cus_1' WHERE id = 'ws_3'",
        "UPDATE workspace SET subscription_status = 'gone' WHERE id = 'ws_3'",
        "UPDATE workspace SET checkout_session_id = 'cus_1' WHERE id = 'ws_3'",
        "UPDATE workspace SET subscription_cancel_at_period_end = NULL WHERE id = 'ws_3'",
        "UPDATE workspace SET subscription_period_end = 0 WHERE id = 'ws_3'",
        "INSERT INTO stripe_event (id, received_at) VALUES ('ch_1', 1)",
      ]) {
        await expect(db.run(sql), sql).rejects.toThrow(/constraint failed/);
      }
      await db.run("UPDATE workspace SET stripe_customer_id = 'cus_A1', stripe_subscription_id = 'sub_A1', checkout_session_id = 'cs_test_A1', subscription_status = 'past_due' WHERE id = 'ws_3'");
      for (const sql of ["UPDATE workspace SET stripe_customer_id = 'cus_A1' WHERE id = 'ws_1'", "UPDATE workspace SET stripe_subscription_id = 'sub_A1' WHERE id = 'ws_1'", "UPDATE workspace SET checkout_session_id = 'cs_test_A1' WHERE id = 'ws_1'"]) {
        await expect(db.run(sql), sql).rejects.toThrow(/UNIQUE constraint failed/);
      }
      await db.run("INSERT INTO stripe_event (id, received_at) VALUES ('evt_1', 1)");
      await expect(db.run("INSERT INTO stripe_event (id, received_at) VALUES ('evt_1', 2)")).rejects.toThrow(/UNIQUE constraint failed/);

      expect(await migrate(db, upTo)).toEqual([]);
      const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
      const settled = await everything(db);
      expect(() => db.transaction(() => db.raw.exec(sql))).toThrow(/duplicate column name/);
      expect(await everything(db)).toEqual(settled);
    } finally {
      db.close();
    }
  });
});
