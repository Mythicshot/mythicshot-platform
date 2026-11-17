import type { Db, Stmt, Value } from "../ports.ts";

/** `Db` on D1. `batch` is D1's batch, which runs as one transaction. */
export class D1Db implements Db {
  constructor(private readonly d1: D1Database) {}

  private prep(sql: string, params: Value[] = []): D1PreparedStatement {
    const stmt = this.d1.prepare(sql);
    return params.length > 0 ? stmt.bind(...params) : stmt;
  }

  async all<T>(sql: string, params?: Value[]): Promise<T[]> {
    const res = await this.prep(sql, params).all<T>();
    return res.results;
  }

  async first<T>(sql: string, params?: Value[]): Promise<T | null> {
    return (await this.prep(sql, params).first<T>()) ?? null;
  }

  async run(sql: string, params?: Value[]): Promise<{ changes: number }> {
    const res = await this.prep(sql, params).run();
    return { changes: res.meta.changes ?? 0 };
  }

  async batch(stmts: Stmt[]): Promise<void> {
    if (stmts.length === 0) return;
    await this.d1.batch(stmts.map((s) => this.prep(s.sql, s.params)));
  }
}
