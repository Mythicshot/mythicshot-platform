import { checkParams, type Db, normalizeRow, type Stmt, type Value } from "../ports.ts";

/** `Db` on D1. `batch` is D1's batch, which runs as one transaction. */
export class D1Db implements Db {
  constructor(private readonly d1: D1Database) {}

  private prep(sql: string, params: Value[] = []): D1PreparedStatement {
    checkParams(params);
    const stmt = this.d1.prepare(sql);
    return params.length > 0 ? stmt.bind(...params) : stmt;
  }

  async all<T>(sql: string, params?: Value[]): Promise<T[]> {
    const res = await this.prep(sql, params).all<Record<string, unknown>>();
    return res.results.map((row) => normalizeRow<T>(row));
  }

  async first<T>(sql: string, params?: Value[]): Promise<T | null> {
    const row = await this.prep(sql, params).first<Record<string, unknown>>();
    return row === null ? null : normalizeRow<T>(row);
  }

  async run(sql: string, params?: Value[]): Promise<{ changes: number }> {
    const res = await this.prep(sql, params).run();
    return { changes: res.meta.changes ?? 0 };
  }

  async batch(stmts: Stmt[]): Promise<void> {
    if (stmts.length === 0) return;
    // prep checks every statement's parameters before anything is sent.
    const prepared = stmts.map((s) => this.prep(s.sql, s.params));
    await this.d1.batch(prepared);
  }
}
