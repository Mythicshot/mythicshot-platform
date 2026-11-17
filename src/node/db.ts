import { DatabaseSync } from "node:sqlite";
import type { Db, Stmt, Value } from "../ports.ts";

/** `Db` on one SQLite file through Node's built-in `node:sqlite`. */
export class NodeDb implements Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path, { timeout: 5000 });
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  async all<T>(sql: string, params: Value[] = []): Promise<T[]> {
    return this.raw
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }) as T);
  }

  async first<T>(sql: string, params: Value[] = []): Promise<T | null> {
    const row = this.raw.prepare(sql).get(...params);
    return row === undefined ? null : ({ ...row } as T);
  }

  async run(sql: string, params: Value[] = []): Promise<{ changes: number }> {
    const res = this.raw.prepare(sql).run(...params);
    return { changes: Number(res.changes) };
  }

  async batch(stmts: Stmt[]): Promise<void> {
    if (stmts.length === 0) return;
    this.transaction(() => {
      for (const s of stmts) this.raw.prepare(s.sql).run(...(s.params ?? []));
    });
  }

  /** Runs `fn` between BEGIN IMMEDIATE and COMMIT, or rolls back and rethrows. */
  transaction(fn: () => void): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.raw.exec("COMMIT");
    } catch (err) {
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}
