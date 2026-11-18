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

describe("migration 0006 on an existing install", () => {
  it("records a snapshot's draft version only for a tour that has not changed since it was published", async () => {
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
      const tour = (id: string, status: string, updatedAt: number, draftVersion: number) =>
        db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at, published_at, draft_version) VALUES (?, 'ws_1', 'T', ?, ?, 1, ?, ?, ?)", [
          id, id, status, updatedAt, status === "published" ? 2000 : null, draftVersion,
        ]);
      const snapshot = (tourId: string) => db.run("INSERT INTO snapshot (tour_id, data, published_at, publish_id, steps) VALUES (?, '{}', 2000, 'pub_x', 1)", [tourId]);
      // Published and not touched since; published at the very moment of its last change;
      // changed after it was published (a chapter upload or a rename); and a draft.
      await tour("tour_unchanged", "published", 1000, 3);
      await snapshot("tour_unchanged");
      await tour("tour_same_moment", "published", 2000, 1);
      await snapshot("tour_same_moment");
      await tour("tour_changed", "published", 2001, 5);
      await snapshot("tour_changed");
      await tour("tour_draft", "draft", 500, 2);
      await db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES ('ch_1', 'tour_unchanged', 'C', 0)");
      await db.run(
        "INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, notes) VALUES ('st_1', 'tour_unchanged', 'ch_1', 0, 'u/up_x/step-001.png', 'png', 10, 10, 100, '[]')",
      );

      expect(await migrate(db, MIGRATIONS_DIR)).toEqual(["0006_replace_chapter.sql"]);
      expect(await db.all("SELECT tour_id, draft_version FROM snapshot ORDER BY tour_id")).toEqual([
        { tour_id: "tour_changed", draft_version: null },
        { tour_id: "tour_same_moment", draft_version: 1 },
        { tour_id: "tour_unchanged", draft_version: 3 },
      ]);
      // Rows written before the migration stay valid, with nothing known about them.
      expect(await db.first("SELECT sha256 FROM step WHERE id = 'st_1'")).toEqual({ sha256: null });
      expect(await db.first("SELECT revision, replaced_version FROM chapter WHERE id = 'ch_1'")).toEqual({ revision: null, replaced_version: null });
      expect(await db.first("SELECT count(*) AS n FROM replaced_object")).toEqual({ n: 0 });
      // Running it again applies nothing.
      expect(await migrate(db, MIGRATIONS_DIR)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
