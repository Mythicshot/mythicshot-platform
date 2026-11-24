// Migration 0024 (the warnings before a removal, and the mark on an account's removal once it
// has begun) on a database at 0.1.58, which has 0022 and an account whose delete is recorded
// (Node only: the shared harness always applies every migration to an empty database). One new
// table and one nullable column: every row keeps what it had, the statements of 0.1.58 still
// run, the new values take only their shapes, and a second application stops at its first
// statement.
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0024_billing_removal.sql";
const WS = "ws_" + "a".repeat(24);
const USR = "usr_" + "b".repeat(24);
const SHA = "c".repeat(64);

describe("migration 0024 on an install of 0.1.58", () => {
  it("adds the warnings' table and one column, and changes no row", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const before = join(root, "before");
    const upTo = join(root, "upto");
    await mkdir(before);
    await mkdir(upTo);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const at = files.indexOf(NAME);
    expect(files[at - 1]).toMatch(/^002[23]_/);
    for (const f of files.slice(0, at)) await copyFile(join(MIGRATIONS_DIR, f), join(before, f));
    for (const f of files.slice(0, at + 1)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    try {
      expect(await migrate(db, before)).toEqual(files.slice(0, at));
      await db.run("INSERT INTO workspace (id, name, created_at, billing_trial) VALUES (?, 'Trial', 1, 1)", [WS]);
      await db.run("INSERT INTO user (id, workspace_id, email, created_at, status) VALUES (?, ?, 'a@example.com', 1, 'disabled')", [USR, WS]);
      await db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, 3, 2)", [USR, WS, USR]);
      const dump = async () => ({ workspace: await db.all("SELECT * FROM workspace"), removal: await db.all("SELECT * FROM account_removal") });
      const old = await dump();

      expect(await migrate(db, upTo)).toEqual([NAME]);
      const after = await dump();
      expect(after.workspace).toEqual(old.workspace);
      expect(after.removal).toEqual(old.removal.map((r) => ({ ...(r as object), work_started_at: null, stopped_at: null })));
      expect(await db.all("SELECT * FROM billing_warning")).toEqual([]);

      // 0.1.58's statements still run: it names none of this.
      await db.run("DELETE FROM account_removal WHERE user_id = ?", [USR]);
      await db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, 3, 2)", [USR, WS, USR]);
      // And 0.1.58's last batch of a delete, which names no billing_warning, still removes the workspace with a warning on record.
      await db.run("INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, 5, 30, ?, 3, 4, 5)", [WS, SHA]);
      await db.run("DELETE FROM account_removal WHERE user_id = ?", [USR]);
      await db.run("DELETE FROM user WHERE id = ?", [USR]);
      await db.run("DELETE FROM workspace WHERE id = ?", [WS]);
      await db.run("DELETE FROM billing_warning");

      for (const [sql, params] of [
        ["INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES ('ws_1', 5, 30, ?, 3, 4, 5)", [SHA]],
        ["INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, 5, 14, ?, 3, 4, 5)", [WS, SHA]],
        ["INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, 5, 30, 'not-a-digest', 3, 4, 5)", [WS]],
        ["INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, 0, 30, ?, 3, 4, 5)", [WS, SHA]],
        ["INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, 5, 30, ?, 3, 'x', 5)", [WS, SHA]],
      ] as [string, string[]][]) {
        await expect(db.run(sql, params), sql).rejects.toThrow(/constraint failed|cannot store/);
      }
      // One row per removal day, stage and address: never twice.
      const ok = "INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, 5, 30, ?, 3, NULL, 5)";
      await db.run(ok, [WS, SHA]);
      await expect(db.run(ok, [WS, SHA])).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(db.run("UPDATE account_removal SET work_started_at = 0")).resolves.toEqual({ changes: 0 });

      expect(await migrate(db, upTo)).toEqual([]);
      const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
      const settled = await db.all("SELECT * FROM billing_warning");
      expect(() => db.transaction(() => db.raw.exec(sql))).toThrow(/already exists/);
      expect(await db.all("SELECT * FROM billing_warning")).toEqual(settled);
    } finally {
      db.close();
    }
  });

  it("is plain and additive: one CREATE TABLE and two ADD COLUMN", async () => {
    const sql = (await readFile(join(MIGRATIONS_DIR, NAME), "utf8"))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\b(DROP|RENAME|DELETE|UPDATE|INSERT)\b/i);
    expect([...sql.matchAll(/\bCREATE TABLE\b/g)]).toHaveLength(1);
    expect([...sql.matchAll(/\bADD COLUMN\b/g)]).toHaveLength(2);
    expect(sql).not.toMatch(/REFERENCES/);
  });
});
