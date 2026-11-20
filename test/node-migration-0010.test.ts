// Migration 0010 (shared items) on a database that already holds a site at 0.1.18, the
// version it follows: migrations 1 to 9, with workspaces, accounts, tours, a published
// snapshot and an open upload (Node only: the shared harness always applies every
// migration to an empty database, which test/schema.test.ts checks on both targets).
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { usageOf } from "../src/usage.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { createUpload, fixtures, png, send, type Json } from "./bundle.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0010_media.sql";
const NOW = 1_800_000_000_000;

/** Every row of every table, by table. */
async function everything(db: NodeDb): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_*' ORDER BY name");
  for (const t of tables) out[t.name] = await db.all(`SELECT * FROM "${t.name}" ORDER BY 1, 2`);
  return out;
}

/** A new database migrated with migrations 1 to 9, as 0.1.18 leaves it, and a folder with 1 to 10. */
async function siteAt0118(): Promise<{ db: NodeDb; deps: Deps; upTo10: string; files: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  expect(files[9]).toBe(NAME);
  // Only the first ten files are ever applied here, so a later migration cannot break what
  // this file says about this one.
  const upTo9 = join(root, "upto9");
  const upTo10 = join(root, "upto10");
  await mkdir(upTo9);
  await mkdir(upTo10);
  for (const f of files.slice(0, 9)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo9, f));
  for (const f of files.slice(0, 10)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo10, f));
  const db = new NodeDb(join(root, "db.sqlite"));
  expect(await migrate(db, upTo9)).toEqual(files.slice(0, 9));
  const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => NOW };
  return { db, deps, upTo10, files };
}

/**
 * A site as 0.1.18 holds it, written with that version's statements: two workspaces with
 * their owners and tokens; in the first a published tour with a logo (its snapshot and a
 * public picture) and an open upload that reserved room, and an allowance of its own.
 */
async function writeSite(deps: Deps): Promise<{ a: { workspaceId: string; token: string }; b: { workspaceId: string; token: string } }> {
  const { db } = deps;
  const a = await createWorkspace(deps, "Acme", "owner@example.com");
  const b = await createWorkspace(deps, "Other", "other@example.org");
  await db.run(
    "INSERT INTO tour (id, workspace_id, title, slug, status, logo_key, logo_type, logo_bytes, created_at, updated_at, published_at, draft_version) VALUES ('tour_live', ?, 'Live', 'abcdefghij', 'published', 'u/up_live/logo.png', 'png', 1234, 1, 1, 2, 1)",
    [a.workspaceId],
  );
  await db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES ('ch_live', 'tour_live', 'C', 0)");
  for (const [i, bytes] of [1000, 2000].entries()) {
    await db.run("INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, notes) VALUES (?, 'tour_live', 'ch_live', ?, ?, 'png', 10, 10, ?, '[]')", [`st_${i}`, i, `u/up_live/step-00${i + 1}.png`, bytes]);
  }
  await db.run("INSERT INTO snapshot (tour_id, data, published_at, publish_id, steps, draft_version) VALUES ('tour_live', '{}', 2, 'pub_x', 2, 1)");
  await db.run("INSERT INTO snapshot_object (tour_id, image_key) VALUES ('tour_live', 'p/0123456789abcdef0123456789abcdef.png')");
  await db.run("INSERT INTO upload (id, workspace_id, tour_id, manifest, created_at, reserved_bytes) VALUES ('up_open', ?, NULL, '{}', ?, 5000)", [a.workspaceId, NOW - 1000]);
  await db.run("UPDATE workspace SET storage_allowance_bytes = 50000 WHERE id = ?", [a.workspaceId]);
  return { a, b };
}

describe("migration 0010 on a 0.1.18 install", () => {
  it("every row stays as it was, the two new tables are empty, and the usage is unchanged", async () => {
    const { db, deps, upTo10, files } = await siteAt0118();
    try {
      const { a, b } = await writeSite(deps);
      const before = await everything(db);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);

      expect(await migrate(db, upTo10)).toEqual([NAME]);
      const after = await everything(db);
      const added = Object.keys(after).filter((t) => !(t in before)).sort();
      expect(added).toEqual(["media", "media_part"]);
      for (const t of added) expect(after[t], t).toEqual([]);
      // Every row of every table that was there is unchanged, in every column.
      expect(Object.fromEntries(Object.entries(after).filter(([t]) => !added.includes(t)))).toEqual(before);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(await db.first("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });

      // The usage is what it was: no item counts yet.
      expect(await usageOf(deps, a.workspaceId)).toEqual({ pictures: 3000, logos: 1234, uploads: 5000, media: 0, used: 9234, allowance: 50_000, over: false, tours: 1 });
      expect(await usageOf(deps, b.workspaceId)).toEqual({ pictures: 0, logos: 0, uploads: 0, media: 0, used: 0, allowance: null, over: false, tours: 0 });

      // Running the migrations again applies nothing, and a second application of the file
      // (two processes starting together) fails as a whole and changes nothing.
      expect(await migrate(db, upTo10)).toEqual([]);
      const settled = await everything(db);
      const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
      expect(() => db.transaction(() => db.raw.exec(sql))).toThrow(/already exists/);
      expect(await everything(db)).toEqual(settled);
      expect(await db.first("SELECT count(*) AS n FROM _migrations WHERE name = ?", [NAME])).toEqual({ n: 1 });
      expect(files.slice(10).every((f) => f > NAME)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("afterwards the routes work on the migrated site: an item is shared, counted with the tours, and a tour upload still starts", async () => {
    const { db, deps, upTo10 } = await siteAt0118();
    try {
      const { a } = await writeSite(deps);
      await migrate(db, upTo10);
      const json = { "content-type": "application/json" };
      const made = await send(deps, "POST", "/api/v1/media", { token: a.token, body: JSON.stringify({ kind: "image", content_type: "image/png", bytes: 3000, width: 20, height: 10 }), headers: json });
      expect(made.status, made.text).toBe(201);
      const id = made.json.id as string;
      expect((await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token: a.token, body: png(20, 10, 3000) as NonNullable<RequestInit["body"]> })).status).toBe(204);
      expect((await send(deps, "POST", `/api/v1/media/${id}/commit`, { token: a.token })).status).toBe(200);
      expect((await send(deps, "GET", "/api/v1/media?kind=image", { token: a.token })).json.items.map((i: Json) => i.id)).toEqual([id]);
      const usage = await send(deps, "GET", "/api/v1/usage", { token: a.token });
      expect(usage.json).toEqual({ used_bytes: 9234 + 3000, allowance_bytes: 50_000, over: false, tours: 1, counted: { pictures: 3000, logos: 1234, uploads_in_progress: 5000 } });
      // A tour upload sees the item's room: 37,766 bytes are left of the allowance.
      const manifest = JSON.parse(JSON.stringify(fixtures.v2)) as Json;
      manifest.steps = manifest.steps.map((s: Json) => ({ ...s, bytes: Math.floor(37_767 / manifest.steps.length) + 1 }));
      expect((await createUpload(deps, a.token, manifest)).json.error).toBe("storage_full");
      manifest.steps = manifest.steps.map((s: Json) => ({ ...s, bytes: 1000 }));
      expect((await createUpload(deps, a.token, manifest)).status).toBe(201);
      // And the tours are listed as before.
      expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).json.tours.map((t: Json) => t.id)).toEqual(["tour_live"]);
    } finally {
      db.close();
    }
  });

  it("the migration is plain and additive: two tables and their indexes, nothing dropped, renamed or changed", async () => {
    const text = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    for (const line of text.split("\n").filter((l) => l.trimStart().startsWith("--"))) expect(line).not.toContain(";");
    const statements = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter((s) => s !== "");
    expect(statements.map((s) => s.split(" (")[0])).toEqual([
      "CREATE TABLE media",
      "CREATE INDEX media_list ON media",
      "CREATE INDEX media_state ON media",
      "CREATE TABLE media_part",
    ]);
    expect(text).not.toMatch(/\b(DROP|ALTER|RENAME|UPDATE|DELETE|INSERT)\b/);
  });
});
