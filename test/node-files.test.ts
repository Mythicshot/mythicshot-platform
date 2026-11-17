import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore, resolveInside } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";

const tmp = (p: string) => mkdtemp(join(tmpdir(), `dp-${p}-`));

describe("node file store", () => {
  it("a key that resolves outside the root is refused even when checkKey is bypassed", async () => {
    const root = await tmp("files");
    for (const k of ["..", "../x", "a/../../x", "/etc/passwd", "C:\\Windows\\x", "a/../..", "."]) {
      expect(() => resolveInside(root, k)).toThrow("bad key");
    }
    expect(resolveInside(root, "a/b.png")).toBe(join(root, "a", "b.png"));
  });

  it("the meta file cannot be fetched as a key", async () => {
    const root = await tmp("files");
    const store = new NodeFileStore(root);
    await store.put("a.png", new Uint8Array([1, 2]), { contentType: "image/png" });
    expect(await store.get("a.png.meta.json")).toBeNull();
    await expect(store.put("a.png.meta.json", new Uint8Array([1]), { contentType: "image/png" })).rejects.toThrow("bad key");
    await expect(store.delete(["a.png.meta.json"])).rejects.toThrow("bad key");
    expect((await store.get("a.png"))!.size).toBe(2);
    expect(await store.keys()).toEqual(["a.png"]);
  });

  it("a write leaves no temporary file behind", async () => {
    const root = await tmp("files");
    const store = new NodeFileStore(root);
    await store.put("d/a.png", new Uint8Array([1]), { contentType: "image/png" });
    await store.put("d/a.png", new Uint8Array([2]), { contentType: "image/png" });
    expect((await readdir(join(root, "d"))).sort()).toEqual(["a.png", "a.png.meta.json"]);
  });
});

describe("node migrate", () => {
  it("migrate applies each file once and in order", async () => {
    const dir = await tmp("mig");
    await writeFile(join(dir, "0002_b.sql"), "INSERT INTO log (v) VALUES ('second');");
    await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE log (v TEXT NOT NULL);\nINSERT INTO log (v) VALUES ('first');");
    await writeFile(join(dir, "notes.txt"), "not a migration");
    const db = new NodeDb(join(await tmp("db"), "db.sqlite"));
    await migrate(db, dir);
    await migrate(db, dir);
    expect((await db.all<{ v: string }>("SELECT v FROM log ORDER BY rowid")).map((r) => r.v)).toEqual(["first", "second"]);
    expect((await db.all<{ name: string }>("SELECT name FROM _migrations ORDER BY name")).map((r) => r.name)).toEqual([
      "0001_a.sql",
      "0002_b.sql",
    ]);
    db.close();
  });

  it("a failing migration file changes nothing and is not recorded", async () => {
    const dir = await tmp("mig");
    await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE ok (v TEXT);");
    await writeFile(join(dir, "0002_bad.sql"), "CREATE TABLE half (v TEXT);\nINSERT INTO missing VALUES (1);");
    const db = new NodeDb(join(await tmp("db"), "db.sqlite"));
    await expect(migrate(db, dir)).rejects.toThrow();
    expect(await db.first("SELECT name FROM sqlite_master WHERE name = 'half'")).toBeNull();
    expect((await db.all<{ name: string }>("SELECT name FROM _migrations")).map((r) => r.name)).toEqual(["0001_a.sql"]);
    db.close();
  });

  it("uses write-ahead logging", async () => {
    const db = new NodeDb(join(await tmp("db"), "db.sqlite"));
    const row = await db.first<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(row!.journal_mode).toBe("wal");
    db.close();
  });
});
