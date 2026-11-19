// Two processes that start together both run the migrations (Node only). Each has its own
// connection to the one database file; the second to reach a file must find it applied and
// skip it, so both start cleanly and nothing is applied twice or half.
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("migrating from two connections at once", () => {
  it("two connections migrating at once apply each file once", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-race-"));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThanOrEqual(7);
    const one = new NodeDb(join(root, "db.sqlite"));
    const two = new NodeDb(join(root, "db.sqlite"));
    try {
      // Both read the list of applied files before either applies one.
      const [a, b] = await Promise.all([migrate(one, MIGRATIONS_DIR), migrate(two, MIGRATIONS_DIR)]);
      expect([...a, ...b].sort()).toEqual(files);
      expect((await one.all<{ name: string }>("SELECT name FROM _migrations ORDER BY name")).map((r) => r.name)).toEqual(files);
      // The schema is whole and usable from both connections.
      await one.run("INSERT INTO workspace (id, name, created_at, storage_allowance_bytes) VALUES ('ws_1', 'Acme', 1, 5)");
      expect(await two.first("SELECT storage_allowance_bytes AS n FROM workspace WHERE id = 'ws_1'")).toEqual({ n: 5 });
      expect(await migrate(one, MIGRATIONS_DIR)).toEqual([]);
      expect(await migrate(two, MIGRATIONS_DIR)).toEqual([]);
    } finally {
      one.close();
      two.close();
    }
  });

  it("a connection whose list of applied files is stale skips what another applied meanwhile", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-race-"));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const slow = new NodeDb(join(root, "db.sqlite"));
    const fast = new NodeDb(join(root, "db.sqlite"));
    try {
      // The slow one reads an empty list, then the fast one applies everything before the
      // slow one reaches its first file.
      slow.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
      const realAll = slow.all.bind(slow);
      let applied: string[] | null = null;
      slow.all = (async (sql: string, params?: never) => {
        const rows = await realAll(sql, params);
        if (applied === null && sql.includes("_migrations")) applied = await migrate(fast, MIGRATIONS_DIR);
        return rows;
      }) as typeof slow.all;
      expect(await migrate(slow, MIGRATIONS_DIR)).toEqual([]);
      expect(applied).toEqual(files);
      expect(await fast.first("SELECT count(*) AS n FROM _migrations")).toEqual({ n: files.length });
    } finally {
      slow.close();
      fast.close();
    }
  });
});
