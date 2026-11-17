import { DatabaseSync } from "node:sqlite";
import { checkParams, type Db, normalizeRow, type Stmt, type Value } from "../ports.ts";

/** node:sqlite throws ERR_OUT_OF_RANGE for an INTEGER beyond 2^53; report it the shared way. */
function readRows<R>(read: () => R): R {
  try {
    return read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_OUT_OF_RANGE") throw new Error("integer out of range");
    throw err;
  }
}

/** `Db` on one SQLite file through Node's built-in `node:sqlite`. */
export class NodeDb implements Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path, { timeout: 5000 });
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  async all<T>(sql: string, params: Value[] = []): Promise<T[]> {
    checkParams(params);
    const rows = readRows(() => this.raw.prepare(sql).all(...params));
    return rows.map((row) => normalizeRow<T>(row));
  }

  async first<T>(sql: string, params: Value[] = []): Promise<T | null> {
    checkParams(params);
    const row = readRows(() => this.raw.prepare(sql).get(...params));
    return row === undefined ? null : normalizeRow<T>(row);
  }

  async run(sql: string, params: Value[] = []): Promise<{ changes: number }> {
    checkParams(params);
    const res = this.raw.prepare(sql).run(...params);
    return { changes: Number(res.changes) };
  }

  async batch(stmts: Stmt[]): Promise<void> {
    if (stmts.length === 0) return;
    for (const s of stmts) checkParams(s.params ?? []);
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
