// Migration 0022 (billing's read-backs of a stale row) on a database at 0.1.57, which has 0021
// and workspaces in every billing state (Node only: the shared harness always applies every
// migration to an empty database). Three nullable columns: every row keeps what it had, the
// statements of 0.1.57 still run, the columns take only their shapes, and a second application
// stops at its first statement.
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0022_billing_checks.sql";
const NEW_COLUMNS = ["billing_checked_at", "billing_check_ok", "billing_confirmed_until"];

describe("migration 0022 on an install of 0.1.57", () => {
  it("adds three columns and changes no row", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const before = join(root, "before");
    const upTo = join(root, "upto");
    await mkdir(before);
    await mkdir(upTo);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const at = files.indexOf(NAME);
    expect(at).toBe(21);
    for (const f of files.slice(0, at)) await copyFile(join(MIGRATIONS_DIR, f), join(before, f));
    for (const f of files.slice(0, at + 1)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    try {
      expect(await migrate(db, before)).toEqual(files.slice(0, at));
      // As 0.1.57 wrote them: an exempt workspace, one on the trial, one subscribed with a checkout record.
      await db.run("INSERT INTO workspace (id, name, created_at) VALUES ('ws_1', 'Old', 1)");
      await db.run("INSERT INTO workspace (id, name, created_at, billing_trial) VALUES ('ws_2', 'Trial', 2, 1)");
      await db.run(
        "INSERT INTO workspace (id, name, created_at, billing_trial, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_period_end) VALUES ('ws_3', 'Paid', 3, 1, 'cus_A', 'sub_A', 'active', 1900000000000)",
      );
      await db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES ('cs_test_1', 'ws_3', 3, 4)");
      await db.run("INSERT INTO stripe_event (id, received_at) VALUES ('evt_1', 5)");
      const dump = async () => ({
        workspace: await db.all("SELECT * FROM workspace ORDER BY id"),
        checkout: await db.all("SELECT * FROM stripe_checkout ORDER BY id"),
        event: await db.all("SELECT * FROM stripe_event ORDER BY id"),
      });
      const old = await dump();

      expect(await migrate(db, upTo)).toEqual([NAME]);
      const after = await dump();
      const strip = (rows: unknown[]) => rows.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => !NEW_COLUMNS.includes(k))));
      expect({ ...after, workspace: strip(after.workspace) }).toEqual(old);
      expect(await db.all("SELECT billing_checked_at AS a, billing_check_ok AS b, billing_confirmed_until AS c FROM workspace ORDER BY id")).toEqual(Array(3).fill({ a: null, b: null, c: null }));

      // 0.1.57's statements still run: it names none of the new columns.
      await db.run("INSERT INTO workspace (id, name, created_at, billing_trial) VALUES ('ws_4', 'Later', 4, 1)");
      await db.run("UPDATE workspace SET subscription_status = 'canceled' WHERE id = 'ws_3' AND subscription_status IS 'active'");

      for (const sql of [
        "UPDATE workspace SET billing_checked_at = 0 WHERE id = 'ws_3'",
        "UPDATE workspace SET billing_check_ok = 2 WHERE id = 'ws_3'",
        "UPDATE workspace SET billing_confirmed_until = -1 WHERE id = 'ws_3'",
      ]) {
        await expect(db.run(sql), sql).rejects.toThrow(/constraint failed/);
      }
      await db.run("UPDATE workspace SET billing_checked_at = 10, billing_check_ok = 0, billing_confirmed_until = 20 WHERE id = 'ws_3'");

      expect(await migrate(db, upTo)).toEqual([]);
      const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
      const settled = await dump();
      expect(() => db.transaction(() => db.raw.exec(sql))).toThrow(/duplicate column name/);
      expect(await dump()).toEqual(settled);
    } finally {
      db.close();
    }
  });

  it("is plain and additive: only ADD COLUMN", async () => {
    const sql = (await readFile(join(MIGRATIONS_DIR, NAME), "utf8"))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    const statements = sql.split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s !== "");
    expect(statements.length).toBe(3);
    for (const s of statements) expect(s).toMatch(/^ALTER TABLE workspace ADD COLUMN billing_[a-z_]+ INTEGER CHECK /);
  });
});
