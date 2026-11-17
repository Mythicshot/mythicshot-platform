import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { backupDatabase } from "../src/node/backup.ts";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";
import { createWorkspace } from "../src/workspaces.ts";
import type { Deps } from "../src/ports.ts";
import { NodeFileStore } from "../src/node/files.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** A migrated database in a new temporary folder, holding one workspace, still open. */
async function seeded() {
  const root = await mkdtemp(join(tmpdir(), "dp-backup-"));
  const dbPath = join(root, "db.sqlite");
  const db = new NodeDb(dbPath);
  await migrate(db, MIGRATIONS_DIR);
  const deps: Deps = {
    db,
    drafts: new NodeFileStore(join(root, "drafts")),
    pub: new NodeFileStore(join(root, "public")),
    config: { publicImageBase: "", setupCode: null },
    now: () => Date.now(),
  };
  await createWorkspace(deps, "Backup Test", "owner@example.com");
  return { root, dbPath, db };
}

describe("database backup", () => {
  it("backup writes a database copy that opens and holds the same rows", async () => {
    const { root, dbPath, db } = await seeded();
    const target = join(root, "copy.sqlite");
    // The source stays open with its WAL in use, as it is in the running container.
    backupDatabase(dbPath, target);
    const copy = new NodeDb(target);
    try {
      for (const table of ["workspace", "user", "api_token", "_migrations"]) {
        const a = await db.all(`SELECT * FROM ${table} ORDER BY rowid`);
        const b = await copy.all(`SELECT * FROM ${table} ORDER BY rowid`);
        expect(b).toEqual(a);
        expect(b.length).toBeGreaterThan(0);
      }
      expect(await copy.first("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    } finally {
      copy.close();
      db.close();
    }
  });

  it("backup refuses to overwrite an existing file", async () => {
    const { root, dbPath, db } = await seeded();
    db.close();
    for (const bytes of ["keep me", ""]) {
      const target = join(root, `existing-${bytes.length}.sqlite`);
      await writeFile(target, bytes);
      expect(() => backupDatabase(dbPath, target)).toThrow(/already exists/);
      expect(await readFile(target, "utf8")).toBe(bytes);
    }
  });

  it("backup refuses a missing source database instead of creating one", async () => {
    const root = await mkdtemp(join(tmpdir(), "dp-backup-"));
    expect(() => backupDatabase(join(root, "none.sqlite"), join(root, "copy.sqlite"))).toThrow(/no database/);
  });
});
