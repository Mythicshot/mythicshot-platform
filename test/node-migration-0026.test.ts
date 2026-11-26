// Migration 0026 (the record of the low storage mails) on a database at 0.1.65, which has 0025
// and a workspace with an account (Node only: the shared harness always applies every migration
// to an empty database). One new table: every row keeps what it had, the statements of 0.1.65
// still run, the new rows take only their shapes, and a second application stops at its first
// statement.
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0026_storage_mail.sql";
const WS = "ws_" + "a".repeat(24);
const USR = "usr_" + "b".repeat(24);
const SHA = "c".repeat(64);

describe("migration 0026 on an install of 0.1.65", () => {
  it("adds the record's table and changes no row", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const before = join(root, "before");
    const upTo = join(root, "upto");
    await mkdir(before);
    await mkdir(upTo);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const at = files.indexOf(NAME);
    expect(files[at - 1]).toBe("0025_token_account.sql");
    for (const f of files.slice(0, at)) await copyFile(join(MIGRATIONS_DIR, f), join(before, f));
    for (const f of files.slice(0, at + 1)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    try {
      expect(await migrate(db, before)).toEqual(files.slice(0, at));
      await db.run("INSERT INTO workspace (id, name, created_at, storage_allowance_bytes) VALUES (?, 'Old', 1, 1000)", [WS]);
      await db.run("INSERT INTO user (id, workspace_id, email, created_at, status) VALUES (?, ?, 'a@example.com', 1, 'active')", [USR, WS]);
      await db.run("INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', 1)", [WS, USR]);
      const dump = async () => ({ workspace: await db.all("SELECT * FROM workspace"), user: await db.all("SELECT * FROM user"), membership: await db.all("SELECT * FROM membership") });
      const old = await dump();

      expect(await migrate(db, upTo)).toEqual([NAME]);
      expect(await dump()).toEqual(old);
      expect(await db.all("SELECT * FROM storage_mail")).toEqual([]);

      // 0.1.65's last batch of an account's delete names no storage_mail, and still removes a
      // workspace with a record (no reference holds it).
      await db.run("INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 80, ?, 3, 4)", [WS, SHA]);
      await db.run("DELETE FROM membership WHERE user_id = ?", [USR]);
      await db.run("DELETE FROM user WHERE id = ?", [USR]);
      await db.run("DELETE FROM workspace WHERE id = ?", [WS]);
      await db.run("DELETE FROM storage_mail");

      for (const [sql, params] of [
        ["INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES ('ws_1', 80, ?, 3, 4)", [SHA]],
        ["INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 90, ?, 3, 4)", [WS, SHA]],
        ["INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 80, 'a@example.com', 3, 4)", [WS]],
        ["INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 80, ?, 0, 4)", [WS, SHA]],
        ["INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 80, ?, 3, 'x')", [WS, SHA]],
      ] as [string, string[]][]) {
        await expect(db.run(sql, params), sql).rejects.toThrow(/constraint failed|cannot store/);
      }
      // One row per workspace and stage: never twice.
      const ok = "INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 100, ?, 3, NULL)";
      await db.run(ok, [WS, SHA]);
      await expect(db.run(ok, [WS, SHA])).rejects.toThrow(/UNIQUE constraint failed/);
      expect(await db.run("INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 100, ?, 3, NULL) ON CONFLICT DO NOTHING", [WS, SHA])).toEqual({ changes: 0 });

      expect(await migrate(db, upTo)).toEqual([]);
      const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
      const settled = await db.all("SELECT * FROM storage_mail");
      expect(() => db.transaction(() => db.raw.exec(sql))).toThrow(/already exists/);
      expect(await db.all("SELECT * FROM storage_mail")).toEqual(settled);
    } finally {
      db.close();
    }
  });

  it("is plain and additive: one CREATE TABLE and nothing else", async () => {
    const sql = (await readFile(join(MIGRATIONS_DIR, NAME), "utf8"))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\b(DROP|RENAME|DELETE|UPDATE|INSERT|ALTER)\b/i);
    expect([...sql.matchAll(/\bCREATE TABLE\b/g)]).toHaveLength(1);
    expect(sql).not.toMatch(/REFERENCES/);
  });
});
