import { describe, expect, it } from "vitest";
import type { Db } from "../../src/ports.ts";

let seq = 0;
/** A fresh table per test, so the suite needs no schema beyond what it creates. */
async function table(db: Db): Promise<string> {
  const name = `contract_${Date.now().toString(36)}_${seq++}`;
  await db.run(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, name TEXT UNIQUE, score REAL, note TEXT)`);
  return name;
}

async function count(db: Db, t: string): Promise<number> {
  const row = await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${t}`);
  return row!.n;
}

export function dbContract(make: () => Promise<Db>): void {
  describe("Db contract", () => {
    it("run reports changes and first returns null for no row", async () => {
      const db = await make();
      const t = await table(db);
      expect(await db.first(`SELECT * FROM ${t}`)).toBeNull();
      const res = await db.run(`INSERT INTO ${t} (id, name) VALUES (?, ?)`, [1, "a"]);
      expect(res.changes).toBe(1);
      const upd = await db.run(`UPDATE ${t} SET note = 'x'`);
      expect(upd.changes).toBe(1);
      expect(await db.first(`SELECT * FROM ${t} WHERE id = ?`, [2])).toBeNull();
    });

    it("all returns rows in order with numbers, strings and nulls intact", async () => {
      const db = await make();
      const t = await table(db);
      await db.run(`INSERT INTO ${t} (id, name, score, note) VALUES (?, ?, ?, ?)`, [2, "b", 1.5, null]);
      await db.run(`INSERT INTO ${t} (id, name, score, note) VALUES (?, ?, ?, ?)`, [1, "a", 0, "it's <b>"]);
      const rows = await db.all<{ id: number; name: string; score: number; note: string | null }>(
        `SELECT id, name, score, note FROM ${t} ORDER BY id`,
      );
      expect(rows.map((r) => ({ ...r }))).toEqual([
        { id: 1, name: "a", score: 0, note: "it's <b>" },
        { id: 2, name: "b", score: 1.5, note: null },
      ]);
      const one = await db.first<{ name: string }>(`SELECT name FROM ${t} WHERE id = ?`, [2]);
      expect(one?.name).toBe("b");
    });

    it("batch commits every statement", async () => {
      const db = await make();
      const t = await table(db);
      await db.batch([
        { sql: `INSERT INTO ${t} (name) VALUES (?)`, params: ["a"] },
        { sql: `INSERT INTO ${t} (name) VALUES (?)`, params: ["b"] },
        { sql: `INSERT INTO ${t} (name) VALUES (?)`, params: ["c"] },
      ]);
      expect(await count(db, t)).toBe(3);
    });

    it("batch rolls back all statements when one fails", async () => {
      const db = await make();
      const t = await table(db);
      await expect(
        db.batch([
          { sql: `INSERT INTO ${t} (name) VALUES (?)`, params: ["a"] },
          { sql: `INSERT INTO ${t} (name) VALUES (?)`, params: ["b"] },
          { sql: `INSERT INTO ${t} (name) VALUES (?)`, params: ["a"] },
        ]),
      ).rejects.toThrow();
      expect(await count(db, t)).toBe(0);
    });

    it("an empty batch is a no-op", async () => {
      const db = await make();
      const t = await table(db);
      await expect(db.batch([])).resolves.toBeUndefined();
      expect(await count(db, t)).toBe(0);
    });

    it("a failed statement leaves the connection usable", async () => {
      const db = await make();
      const t = await table(db);
      await db.run(`INSERT INTO ${t} (name) VALUES (?)`, ["a"]);
      await expect(db.run(`INSERT INTO ${t} (name) VALUES (?)`, ["a"])).rejects.toThrow();
      await expect(db.run(`SELECT * FROM no_such_table`)).rejects.toThrow();
      const res = await db.run(`INSERT INTO ${t} (name) VALUES (?)`, ["b"]);
      expect(res.changes).toBe(1);
      await db.batch([{ sql: `INSERT INTO ${t} (name) VALUES (?)`, params: ["c"] }]);
      expect(await count(db, t)).toBe(3);
    });
  });
}
