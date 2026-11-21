// Migration 0017 (tour.ever_published) on a database that already holds tours at the version
// before it: every migration before 0017, then 0017 (Node only: the shared harness always
// applies every migration to an empty database). It marks every tour that is published, or has
// a live version or a move of its pictures, and no other; it changes no other column of any
// row; and a second application stops at its first statement.
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

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0017_ever_published.sql";
const NOW = 1_800_000_000_000;

const tourId = (n: number) => "tour_" + String(n).repeat(24);

describe("migration 0017", () => {
  it("marks the tours that are published, have a live version or a move, and no other; changes nothing else; cannot run twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.at(-1)).toBe(NAME);
    const before = files.filter((f) => f < NAME);
    const upTo16 = join(root, "before");
    const upTo17 = join(root, "with");
    await mkdir(upTo16);
    await mkdir(upTo17);
    for (const f of before) await copyFile(join(MIGRATIONS_DIR, f), join(upTo16, f));
    for (const f of [...before, NAME]) await copyFile(join(MIGRATIONS_DIR, f), join(upTo17, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    expect(await migrate(db, upTo16)).toEqual(before);
    const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => NOW };
    const ws = (await createWorkspace(deps, "Acme", "owner@example.com")).workspaceId;
    const tour = (n: number, status: string, publishedAt: number | null) =>
      db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [tourId(n), ws, `Tour ${n}`, `${"abcdefghij".slice(0, 9)}${"abcdefgh"[n]}`, status, NOW, NOW, publishedAt]);
    await tour(1, "published", NOW); // published
    await tour(2, "draft", null); // never published (or unpublished before 0.1.51: nothing tells)
    await tour(3, "draft", NOW); // a draft with a publish time, as an older build could leave it
    await tour(4, "draft", null); // a live version without the status
    await db.run("INSERT INTO snapshot (tour_id, data, published_at) VALUES (?, '{}', ?)", [tourId(4), NOW]);
    await tour(5, "published", null); // a move of its pictures under way
    await db.run("INSERT INTO access_switch (tour_id, switch_id, target, from_publish, data, total, created_at, touched_at) VALUES (?, ?, 'private', NULL, '{}', 0, ?, ?)", [tourId(5), "sw_" + "5".repeat(24), NOW, NOW]);
    const rows = async () => db.all<Record<string, unknown>>("SELECT id, workspace_id, title, slug, status, created_at, updated_at, published_at, access, draft_version FROM tour ORDER BY id");
    const was = await rows();
    expect(await migrate(db, upTo17)).toEqual([NAME]);
    expect(await rows()).toEqual(was);
    expect((await db.all<{ id: string; ever_published: number }>("SELECT id, ever_published FROM tour ORDER BY id")).map((r) => [r.id, r.ever_published])).toEqual([
      [tourId(1), 1],
      [tourId(2), 0],
      [tourId(3), 1],
      [tourId(4), 1],
      [tourId(5), 1],
    ]);
    // A new tour starts unmarked; the mark takes 0 or 1 only.
    await tour(6, "draft", null);
    expect(await db.first("SELECT ever_published FROM tour WHERE id = ?", [tourId(6)])).toEqual({ ever_published: 0 });
    await expect(db.run("UPDATE tour SET ever_published = 2 WHERE id = ?", [tourId(6)])).rejects.toThrow(/CHECK/);
    // Applied again by hand, its first statement fails and nothing changes.
    const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    expect(() => db.raw.exec(sql)).toThrow(/duplicate column/);
    expect((await db.all<{ n: number }>("SELECT sum(ever_published) AS n FROM tour"))[0].n).toBe(4);
  });
});
