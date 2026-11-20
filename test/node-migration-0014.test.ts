// Migration 0014 (who may view a tour) on a database that already holds a site at the
// version before it: every migration before 0014, with an account and a published tour
// (Node only: the shared harness always applies every migration to an empty database). The
// migrations are chosen by name, not by place, so one numbered between them that is merged
// later changes nothing here.
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { send } from "./bundle.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0014_tour_access.sql";
const NOW = 1_800_000_000_000;

async function siteBefore(): Promise<{ db: NodeDb; deps: Deps; upTo14: string }> {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  expect(files).toContain(NAME);
  const before = files.filter((f) => f < NAME);
  const upTo13 = join(root, "before");
  const upTo14 = join(root, "with");
  await mkdir(upTo13);
  await mkdir(upTo14);
  for (const f of before) await copyFile(join(MIGRATIONS_DIR, f), join(upTo13, f));
  for (const f of [...before, NAME]) await copyFile(join(MIGRATIONS_DIR, f), join(upTo14, f));
  const db = new NodeDb(join(root, "db.sqlite"));
  expect(await migrate(db, upTo13)).toEqual(before);
  const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => NOW };
  return { db, deps, upTo14 };
}

describe("migration 0014", () => {
  it("makes every existing tour public and changes no row; the tour and its page work as before", async () => {
    const { db, deps, upTo14 } = await siteBefore();
    const a = await createWorkspace(deps, "Acme", "owner@example.com");
    const tour = "tour_" + "1".repeat(24);
    await db.batch([
      { sql: "INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at, published_at) VALUES (?, ?, 'Old', 'abcdefghij', 'published', ?, ?, ?)", params: [tour, a.workspaceId, NOW, NOW, NOW] },
      { sql: "INSERT INTO snapshot (tour_id, data, published_at, publish_id, steps) VALUES (?, ?, ?, 'pub_x', 0)", params: [tour, JSON.stringify({ title: "Old" }), NOW] },
    ]);
    const dump = async () => ({ tour: await db.all<Record<string, unknown>>("SELECT * FROM tour ORDER BY id"), snapshot: await db.all("SELECT * FROM snapshot ORDER BY tour_id") });
    const before = await dump();
    expect(await migrate(db, upTo14)).toEqual([NAME]);
    const after = await dump();
    expect(after.tour).toEqual(before.tour.map((t) => ({ ...t, access: "public" })));
    expect(after.snapshot).toEqual(before.snapshot);
    expect(await db.all("SELECT * FROM tour_viewer UNION ALL SELECT tour_id, switch_id, target FROM access_switch")).toEqual([]);
    const list = await send(deps, "GET", "/api/v1/tours", { token: a.token });
    expect(list.json.tours).toMatchObject([{ id: tour, access: "public", viewers: 0 }]);
  });

  it("a second application stops at its first statement, and the new tables and column refuse rows of the wrong shape", async () => {
    const { db, deps, upTo14 } = await siteBefore();
    expect(await migrate(db, upTo14)).toEqual([NAME]);
    const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    expect(() => db.raw.exec(sql)).toThrow(/already exists/);
    expect(await migrate(db, upTo14)).toEqual([]);
    const a = await createWorkspace(deps, "Acme", "owner@example.com");
    const tour = "tour_" + "2".repeat(24);
    await db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'T', 'bcdefghijk', 'draft', ?, ?)", [tour, a.workspaceId, NOW, NOW]);
    await expect(db.run("UPDATE tour SET access = 'friends' WHERE id = ?", [tour])).rejects.toThrow(/CHECK/);
    await expect(db.run("UPDATE tour SET access = NULL WHERE id = ?", [tour])).rejects.toThrow(/NOT NULL/);
    for (const email of ["Ana@example.com", "ana example.com", "a", "ana@b@c", "ana\u0000@example.com", "ana@example.com\n"]) {
      await expect(db.run("INSERT INTO tour_viewer (tour_id, email, created_at) VALUES (?, ?, ?)", [tour, email, NOW]), JSON.stringify(email)).rejects.toThrow(/CHECK/);
    }
    await db.run("INSERT INTO tour_viewer (tour_id, email, created_at) VALUES (?, 'ana@example.com', ?)", [tour, NOW]);
    await expect(db.run("INSERT INTO tour_viewer (tour_id, email, created_at) VALUES (?, 'ana@example.com', ?)", [tour, NOW])).rejects.toThrow(/UNIQUE/);
    await expect(db.run("INSERT INTO tour_viewer (tour_id, email, created_at) VALUES (?, 'bo@example.com', ?)", ["tour_" + "9".repeat(24), NOW])).rejects.toThrow(/FOREIGN KEY/);
    const sw = (id: string, target = "private") => db.run("INSERT INTO access_switch (tour_id, switch_id, target, data, total, created_at, touched_at) VALUES (?, ?, ?, '{}', 0, ?, ?)", [tour, id, target, NOW, NOW]);
    await expect(sw("sw_" + "0".repeat(23))).rejects.toThrow(/CHECK/);
    await expect(sw("sx_" + "0".repeat(24))).rejects.toThrow(/CHECK/);
    await expect(sw("sw_" + "0".repeat(24), "drafts")).rejects.toThrow(/CHECK/);
    await sw("sw_" + "0".repeat(24));
    await expect(sw("sw_" + "1".repeat(24))).rejects.toThrow(/UNIQUE/);
  });
});
