// Migration 0007 on a database that already holds a workspace, tours and an open upload
// (Node only: the shared harness always applies every migration to an empty database).
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { usageOf } from "../src/usage.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0007_storage_allowance.sql";
const NOW = 1_800_000_000_000;

/** Every row of the tables the migration touches, and of the ones that hold a site's tours and tokens. */
async function everything(db: NodeDb): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of ["workspace", "user", "api_token", "tour", "chapter", "step", "upload", "upload_step", "snapshot", "snapshot_object"]) out[t] = await db.all(`SELECT * FROM ${t} ORDER BY 1, 2`);
  return out;
}

/** The same rows without the three columns the migration adds. */
function withoutNewColumns(rows: Record<string, unknown[]>): Record<string, unknown[]> {
  const drop: Record<string, string> = { workspace: "storage_allowance_bytes", upload: "reserved_bytes", tour: "logo_bytes" };
  return Object.fromEntries(Object.entries(rows).map(([t, list]) => [t, list.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => k !== drop[t])))]));
}

describe("migration 0007 on an existing install", () => {
  it("rows written before migration 0007 stay valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const upTo6 = join(root, "upto6");
    await mkdir(upTo6);
    // Only the first seven files are ever applied here, so a later migration that changes
    // other tables cannot break what this test says about this one.
    const upTo7 = join(root, "upto7");
    await mkdir(upTo7);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files[6]).toBe(NAME);
    for (const f of files.slice(0, 6)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo6, f));
    for (const f of files.slice(0, 7)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo7, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    try {
      expect(await migrate(db, upTo6)).toEqual(files.slice(0, 6));
      // A site as 0.1.7 wrote it: an owner, a token, a published tour with a logo, a draft
      // tour, and an open upload with one stored step and its logo.
      await db.run("INSERT INTO workspace (id, name, created_at) VALUES ('ws_1', 'Acme', 1)");
      await db.run("INSERT INTO workspace (id, name, created_at) VALUES ('ws_2', 'Other', 1)");
      await db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES ('usr_1', 'ws_1', 'owner@example.com', 1)");
      await db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES ('tok_1', 'ws_1', 'First token', ?, 1)", ["a".repeat(64)]);
      const tour = async (id: string, ws: string, status: string, logo: string | null, bytes: number[]) => {
        await db.run(
          "INSERT INTO tour (id, workspace_id, title, slug, status, logo_key, logo_type, created_at, updated_at, published_at, draft_version) VALUES (?, ?, 'T', ?, ?, ?, ?, 1, 1, ?, 1)",
          [id, ws, id, status, logo, logo === null ? null : "png", status === "published" ? 2 : null],
        );
        await db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES (?, ?, 'C', 0)", [`ch_${id}`, id]);
        for (const [i, n] of bytes.entries()) {
          await db.run(
            "INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, notes) VALUES (?, ?, ?, ?, ?, 'png', 10, 10, ?, '[]')",
            [`st_${id}_${i}`, id, `ch_${id}`, i, `u/up_${id}/step-00${i + 1}.png`, n],
          );
        }
      };
      await tour("tour_live", "ws_1", "published", "u/up_tour_live/logo.png", [1000, 2000]);
      await tour("tour_draft", "ws_1", "draft", null, [300]);
      await tour("tour_other", "ws_2", "draft", null, [77_000]);
      await db.run("INSERT INTO snapshot (tour_id, data, published_at, publish_id, steps, draft_version) VALUES ('tour_live', '{}', 2, 'pub_x', 2, 1)");
      await db.run("INSERT INTO snapshot_object (tour_id, image_key) VALUES ('tour_live', '0123456789abcdef0123456789abcdef.png')");
      await db.run("INSERT INTO upload (id, workspace_id, tour_id, manifest, created_at, logo_key, logo_bytes) VALUES ('up_open', 'ws_1', NULL, '{}', ?, 'u/up_open/logo.png', 1234)", [NOW - 1000]);
      await db.run("INSERT INTO upload_step (upload_id, n, image_key, bytes, stored_at) VALUES ('up_open', 1, 'u/up_open/step-001.png', 5000, ?)", [NOW - 500]);
      const before = await everything(db);

      expect(await migrate(db, upTo7)).toEqual([NAME]);
      const after = await everything(db);
      // Every row is still there, unchanged in every column it had.
      expect(withoutNewColumns(after)).toEqual(before);
      // The new columns say "nothing known": the site's default allowance, nothing
      // reserved, and a logo that counts as nothing.
      expect(await db.all("SELECT id, storage_allowance_bytes FROM workspace ORDER BY id")).toEqual([
        { id: "ws_1", storage_allowance_bytes: null },
        { id: "ws_2", storage_allowance_bytes: null },
      ]);
      expect(await db.first("SELECT reserved_bytes FROM upload WHERE id = 'up_open'")).toEqual({ reserved_bytes: 0 });
      expect(await db.all("SELECT id, logo_bytes FROM tour ORDER BY id")).toEqual([
        { id: "tour_draft", logo_bytes: null },
        { id: "tour_live", logo_bytes: null },
        { id: "tour_other", logo_bytes: null },
      ]);

      // Usage of what was there before: the steps, and nothing for the old logo or the old upload.
      const deps: Deps = { db, drafts: null as never, pub: null as never, config: { publicImageBase: "", setupCode: null }, now: () => NOW };
      expect(await usageOf(deps, "ws_1")).toEqual({ pictures: 3300, logos: 0, uploads: 0, used: 3300, allowance: null, over: false, tours: 2 });
      expect(await usageOf(deps, "ws_2")).toEqual({ pictures: 77_000, logos: 0, uploads: 0, used: 77_000, allowance: null, over: false, tours: 1 });

      // The statements 0.1.7 runs still work on the migrated database: it names none of the new columns.
      await db.run("INSERT INTO workspace (id, name, created_at) VALUES ('ws_3', 'Later', 3)");
      await db.run("INSERT INTO upload (id, workspace_id, tour_id, manifest, created_at, replaces_chapter_id, base_revision) SELECT 'up_later', 'ws_3', NULL, '{}', ?, NULL, NULL WHERE (SELECT count(*) FROM upload WHERE workspace_id = 'ws_3' AND closing_at IS NULL AND created_at >= 0) < 5", [NOW]);
      await db.run(
        "INSERT INTO tour (id, workspace_id, title, slug, status, spotlight_dim, theme, zoom, cover, cta, end_card, autoplay, logo_key, logo_type, created_at, updated_at, draft_version) VALUES ('tour_later', 'ws_3', 'T', 'later', 'draft', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 3, 3, 1)",
      );
      expect(await db.first("SELECT storage_allowance_bytes AS a, (SELECT reserved_bytes FROM upload WHERE id = 'up_later') AS r, (SELECT logo_bytes FROM tour WHERE id = 'tour_later') AS l FROM workspace WHERE id = 'ws_3'")).toEqual({ a: null, r: 0, l: null });

      // The database refuses a negative size in either new column, for old rows and new.
      for (const sql of ["UPDATE upload SET reserved_bytes = -1 WHERE id = 'up_open'", "UPDATE tour SET logo_bytes = -1 WHERE id = 'tour_live'", "UPDATE upload SET reserved_bytes = NULL WHERE id = 'up_later'"]) {
        await expect(db.run(sql), sql).rejects.toThrow(/constraint failed/);
      }
      await db.run("UPDATE tour SET logo_bytes = 0 WHERE id = 'tour_later'");
      await db.run("UPDATE tour SET logo_bytes = NULL WHERE id = 'tour_later'");

      // Running the migrations again applies nothing.
      expect(await migrate(db, upTo7)).toEqual([]);
      // And a process that meets the file a second time (two starting together) fails as a
      // whole and leaves the database exactly as it was: nothing is half applied.
      const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
      const settled = await everything(db);
      expect(() => db.transaction(() => db.raw.exec(sql))).toThrow(/duplicate column name/);
      expect(await everything(db)).toEqual(settled);
      expect(await db.first("SELECT count(*) AS n FROM _migrations WHERE name = ?", [NAME])).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("the migration is plain and additive: only ADD COLUMN, nothing dropped, renamed or rebuilt", async () => {
    const sql = (await readFile(join(MIGRATIONS_DIR, NAME), "utf8"))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    const statements = sql.split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s !== "");
    expect(statements).toEqual([
      "ALTER TABLE workspace ADD COLUMN storage_allowance_bytes INTEGER CHECK (storage_allowance_bytes IS NULL OR storage_allowance_bytes >= 0)",
      "ALTER TABLE upload ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)",
      "ALTER TABLE tour ADD COLUMN logo_bytes INTEGER CHECK (logo_bytes IS NULL OR logo_bytes >= 0)",
    ]);
  });
});
