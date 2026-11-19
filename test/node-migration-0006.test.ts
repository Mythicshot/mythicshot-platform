// Migration 0006 on a database that already holds published tours (Node only: the shared
// harness always applies every migration to an empty database).
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const PUBLISHED = 2000;

describe("migration 0006 on an existing install", () => {
  it("records a snapshot's draft version only where the snapshot is known to hold the whole draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const upTo5 = join(root, "upto5");
    await mkdir(upTo5);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files[5]).toBe("0006_replace_chapter.sql");
    for (const f of files.slice(0, 5)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo5, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    try {
      expect(await migrate(db, upTo5)).toEqual(files.slice(0, 5));
      await db.run("INSERT INTO workspace (id, name, created_at) VALUES ('ws_1', 'Acme', 1)");
      /** A tour with `steps` step rows in one chapter per entry; published with a snapshot of `live` steps unless `live` is undefined. */
      const tour = async (id: string, updatedAt: number, draftVersion: number, chapters: number[], live?: number | null) => {
        await db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at, published_at, draft_version) VALUES (?, 'ws_1', 'T', ?, ?, 1, ?, ?, ?)", [
          id, id, live === undefined ? "draft" : "published", updatedAt, live === undefined ? null : PUBLISHED, draftVersion,
        ]);
        for (const [c, n] of chapters.entries()) {
          await db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES (?, ?, 'C', ?)", [`ch_${id}_${c}`, id, c]);
          for (let i = 0; i < n; i++) {
            await db.run(
              "INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, notes) VALUES (?, ?, ?, ?, ?, 'png', 10, 10, 100, '[]')",
              [`st_${id}_${c}_${i}`, id, `ch_${id}_${c}`, i, `u/up_${id}/step-${c}${i}.png`],
            );
          }
        }
        if (live !== undefined) await db.run("INSERT INTO snapshot (tour_id, data, published_at, publish_id, steps) VALUES (?, '{}', ?, 'pub_x', ?)", [id, PUBLISHED, live]);
      };
      // Published and not touched since: the snapshot holds the whole draft.
      await tour("tour_untouched", 1000, 3, [2, 1], 3);
      // Published at the very moment of its last change, with every step.
      await tour("tour_same_moment", PUBLISHED, 1, [2], 2);
      // A chapter was uploaded after the publish.
      await tour("tour_chapter_after", PUBLISHED + 1, 2, [2, 1], 2);
      // Renamed after the publish: a rename moves updated_at, not the steps, and writes its
      // title into the snapshot, so the snapshot still holds the whole draft.
      await tour("tour_renamed_after", PUBLISHED + 1, 1, [2], 2);
      // A chapter landed while a publish of several calls was running: the publish went
      // live later with the older draft, so the times say "unchanged" and only the steps tell.
      await tour("tour_chapter_during", PUBLISHED - 1, 2, [2, 1], 2);
      // Published before the snapshot recorded its step count.
      await tour("tour_no_count", 1000, 1, [2], null);
      // Unchanged, with an open upload into it that has a stored step: not part of the draft yet.
      await tour("tour_open_upload", 1000, 1, [2], 2);
      await db.run("INSERT INTO upload (id, workspace_id, tour_id, manifest, created_at) VALUES ('up_open', 'ws_1', 'tour_open_upload', '{}', 1500)");
      await db.run("INSERT INTO upload_step (upload_id, n, image_key, bytes, stored_at) VALUES ('up_open', 1, 'u/up_open/step-001.png', 100, 1500)");
      await tour("tour_draft", 500, 2, [1]);

      // 0006 and every migration after it: the folder has grown since this test was written.
      expect(await migrate(db, MIGRATIONS_DIR)).toEqual(files.slice(5));
      const versions = Object.fromEntries((await db.all<{ tour_id: string; draft_version: number | null }>("SELECT tour_id, draft_version FROM snapshot")).map((r) => [r.tour_id, r.draft_version]));
      expect(versions).toEqual({
        tour_untouched: 3,
        tour_same_moment: 1,
        tour_chapter_after: null,
        tour_renamed_after: 1,
        tour_chapter_during: null,
        tour_no_count: null,
        tour_open_upload: 1,
      });
      // Rows written before the migration stay valid, with nothing known about them.
      expect(await db.first("SELECT count(*) AS n FROM step WHERE sha256 IS NOT NULL")).toEqual({ n: 0 });
      expect(await db.first("SELECT count(*) AS n FROM chapter WHERE revision IS NOT NULL OR replaced_version IS NOT NULL OR replaced_from IS NOT NULL")).toEqual({ n: 0 });
      expect(await db.first("SELECT sha256, reused FROM upload_step WHERE upload_id = 'up_open'")).toEqual({ sha256: null, reused: 0 });
      expect(await db.first("SELECT replaces_chapter_id, base_revision FROM upload WHERE id = 'up_open'")).toEqual({ replaces_chapter_id: null, base_revision: null });
      expect(await db.first("SELECT count(*) AS n FROM replaced_object")).toEqual({ n: 0 });
      // Running it again applies nothing.
      expect(await migrate(db, MIGRATIONS_DIR)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
