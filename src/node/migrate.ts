import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeDb } from "./db.ts";

/**
 * Applies every `*.sql` file in `dir` not yet recorded in `_migrations`, in name
 * order, each file in its own transaction together with its record. The record is looked
 * for again inside that transaction, which holds the write lock: of two processes that
 * start together, the second to reach a file finds it applied and skips it.
 */
export async function migrate(db: NodeDb, dir: string): Promise<string[]> {
  db.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((await db.all<{ name: string }>("SELECT name FROM _migrations")).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(join(dir, name), "utf8");
    let ran = false;
    db.transaction(() => {
      if (db.raw.prepare("SELECT 1 FROM _migrations WHERE name = ?").get(name) !== undefined) return;
      db.raw.exec(sql);
      db.raw.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
      ran = true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}
