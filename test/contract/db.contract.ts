import { describe, expect, it } from "vitest";
import { type Db, isUniqueViolation } from "../../src/ports.ts";

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

    it("isUniqueViolation is true for a unique or primary key failure and false otherwise", async () => {
      const db = await make();
      const t = await table(db);
      await db.run(`INSERT INTO ${t} (id, name) VALUES (?, ?)`, [1, "a"]);
      const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
      const dupName = await caught(db.run(`INSERT INTO ${t} (id, name) VALUES (?, ?)`, [2, "a"]));
      const dupId = await caught(db.run(`INSERT INTO ${t} (id, name) VALUES (?, ?)`, [1, "b"]));
      const dupInBatch = await caught(db.batch([{ sql: `INSERT INTO ${t} (name) VALUES (?)`, params: ["a"] }]));
      expect(isUniqueViolation(dupName)).toBe(true);
      expect(isUniqueViolation(dupId)).toBe(true);
      expect(isUniqueViolation(dupInBatch)).toBe(true);

      await db.run(`CREATE TABLE ${t}_nn (v TEXT NOT NULL)`);
      const notNull = await caught(db.run(`INSERT INTO ${t}_nn (v) VALUES (NULL)`));
      const noTable = await caught(db.run(`SELECT * FROM no_such_table`));
      expect(notNull).not.toBeNull();
      expect(isUniqueViolation(notNull)).toBe(false);
      expect(isUniqueViolation(noTable)).toBe(false);
      expect(isUniqueViolation(null)).toBe(false);
      expect(isUniqueViolation("UNIQUE constraint failed")).toBe(false);
    });

    it("a BLOB reads back as a Uint8Array", async () => {
      const db = await make();
      const row = await db.first<{ b: unknown; e: unknown }>(`SELECT X'00ff10' AS b, X'' AS e`);
      expect(row!.b).toBeInstanceOf(Uint8Array);
      expect(Array.from(row!.b as Uint8Array)).toEqual([0, 255, 16]);
      expect(row!.e).toBeInstanceOf(Uint8Array);
      const rows = await db.all<{ b: unknown }>(`SELECT X'01' AS b`);
      expect(rows[0]!.b).toBeInstanceOf(Uint8Array);
    });

    it("a JS number reads back the same from TEXT, INTEGER and REAL columns", async () => {
      // Both back ends bind every JS number as REAL: a TEXT column stores 5 as "5.0".
      // Pass a string when the column is TEXT.
      const db = await make();
      const n = `nums_${Date.now().toString(36)}_${seq++}`;
      await db.run(`CREATE TABLE ${n} (t TEXT, i INTEGER, r REAL)`);
      await db.run(`INSERT INTO ${n} (t, i, r) VALUES (?, ?, ?)`, [5, 5, 5]);
      await db.run(`INSERT INTO ${n} (t, i, r) VALUES (?, ?, ?)`, [1.5, 1.5, 1.5]);
      await db.run(`INSERT INTO ${n} (t, i, r) VALUES (?, ?, ?)`, ["7", "7", "7"]);
      await db.run(`INSERT INTO ${n} (t, i, r) VALUES (?, ?, ?)`, [-0, 2 ** 53 - 1, -(2 ** 53 - 1)]);
      const rows = await db.all(`SELECT t, typeof(t) AS tt, i, typeof(i) AS ti, r, typeof(r) AS tr FROM ${n} ORDER BY rowid`);
      expect(rows.map((r) => ({ ...(r as object) }))).toEqual([
        { t: "5.0", tt: "text", i: 5, ti: "integer", r: 5, tr: "real" },
        { t: "1.5", tt: "text", i: 1.5, ti: "real", r: 1.5, tr: "real" },
        { t: "7", tt: "text", i: 7, ti: "integer", r: 7, tr: "real" },
        { t: "0.0", tt: "text", i: 2 ** 53 - 1, ti: "integer", r: -(2 ** 53 - 1), tr: "real" },
      ]);
    });

    it("an integer beyond 2^53 - 1 is refused on bind and on read, never rounded", async () => {
      const db = await make();
      const t = await table(db);
      for (const bad of [2 ** 53, -(2 ** 53), 2 ** 60, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(db.run(`INSERT INTO ${t} (id) VALUES (?)`, [bad])).rejects.toThrow(/out of range/);
        await expect(db.first(`SELECT ? AS n`, [bad])).rejects.toThrow(/out of range/);
        await expect(db.batch([{ sql: `INSERT INTO ${t} (id) VALUES (?)`, params: [bad] }])).rejects.toThrow(/out of range/);
      }
      expect(await count(db, t)).toBe(0);
      await expect(db.first(`SELECT 9007199254740993 AS n`)).rejects.toThrow("integer out of range");
      await expect(db.all(`SELECT 9007199254740992 AS n`)).rejects.toThrow("integer out of range");
      await expect(db.first(`SELECT 9007199254740991 * 4.0 AS n`)).rejects.toThrow("integer out of range");
      expect({ ...(await db.first<{ n: number }>(`SELECT 9007199254740991 AS n`)) }).toEqual({ n: 2 ** 53 - 1 });
      expect({ ...(await db.first<{ n: number }>(`SELECT 2.5 * 4 AS n`)) }).toEqual({ n: 10 });
    });
  });
}
