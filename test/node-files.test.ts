import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore, objectPath, unlinkGone } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";

const tmp = (p: string) => mkdtemp(join(tmpdir(), `dp-${p}-`));

describe("node file store", () => {
  it("a key that resolves outside the root is refused even when checkKey is bypassed", async () => {
    // With hashed names no key can name a path outside the root: every key maps to
    // <root>/<2 hex>/<64 hex>, whatever it contains.
    const root = await tmp("files");
    for (const k of ["..", "../x", "a/../../x", "/etc/passwd", "C:\\Windows\\x", "a/../..", ".", "", "con", "a\0b"]) {
      const p = objectPath(root, k);
      expect(p.startsWith(join(root, ""))).toBe(true);
      expect(p.slice(root.length + 1)).toMatch(/^[0-9a-f]{2}[\\/][0-9a-f]{64}$/);
    }
  });

  it("no file on disk is named after its key, and the sidecar of old is gone", async () => {
    const root = await tmp("files");
    const store = new NodeFileStore(root);
    await store.put("a.png", new Uint8Array([1, 2]), { contentType: "image/png" });
    const [shard] = await readdir(root);
    expect(shard).toMatch(/^[0-9a-f]{2}$/);
    const files = await readdir(join(root, shard!));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a write leaves no temporary file behind", async () => {
    const root = await tmp("files");
    const store = new NodeFileStore(root);
    await store.put("d/a.png", new Uint8Array([1]), { contentType: "image/png" });
    await store.put("d/a.png", new Uint8Array([2]), { contentType: "image/png" });
    const [shard] = await readdir(root);
    expect(await readdir(join(root, shard!))).toHaveLength(1);
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

  it("a delete that finds the file being deleted by another request waits for it and succeeds", async () => {
    // On Windows, two unlinks of one file at the same moment can fail with EPERM (the file
    // is "delete pending") instead of ENOENT. Simulated here so the rule is pinned on every OS.
    const codes = (...c: string[]) => {
      let i = 0;
      const calls: number[] = [];
      const fn = async () => {
        calls.push(i);
        const code = c[i++];
        if (code === "ok") return;
        throw Object.assign(new Error(code), { code });
      };
      return { fn, calls };
    };
    const busyThenGone = codes("EPERM", "EPERM", "ENOENT");
    await expect(unlinkGone("x", busyThenGone.fn)).resolves.toBeUndefined();
    expect(busyThenGone.calls).toHaveLength(3);
    const busyThenRemoved = codes("EBUSY", "ok");
    await expect(unlinkGone("x", busyThenRemoved.fn)).resolves.toBeUndefined();
    await expect(unlinkGone("x", codes("ENOENT").fn)).resolves.toBeUndefined();
    // A file that stays locked is a real failure, reported after a bounded wait.
    await expect(unlinkGone("x", codes(...new Array(30).fill("EACCES")).fn)).rejects.toThrow("EACCES");
    // Any other error is reported at once.
    const io = codes("EIO");
    await expect(unlinkGone("x", io.fn)).rejects.toThrow("EIO");
    expect(io.calls).toHaveLength(1);
  });

  it("many deletes of the same keys at once all succeed", async () => {
    const root = await tmp("files");
    const store = new NodeFileStore(root);
    const keys = Array.from({ length: 40 }, (_, i) => `p/${String(i).padStart(32, "0")}.png`);
    for (const k of keys) await store.put(k, new Uint8Array(1000), { contentType: "image/png" });
    const results = await Promise.allSettled([store.delete(keys), store.delete(keys), store.delete([...keys].reverse())]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(await store.keys()).toEqual([]);
  });
});
