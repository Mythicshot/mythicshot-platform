// The backfill of migration 0017 (tour.ever_published) on both targets: its UPDATE, read from
// the migration file itself, run by each target's own database (SQLite on Node, D1 on
// Cloudflare). Both harnesses apply every migration to an empty database before each test,
// and neither can stop before 0017 on Cloudflare (applyD1Migrations takes the whole list it is
// given in one go, on the database the harness empties), so the tours are written with the
// mark cleared, as they were before the migration, and the backfill is run again by hand. The
// ALTER of the migration is checked on Node alone, on a real database at 0016
// (test/node-migration-0017.test.ts). Unpublish's own setting of the mark is checked here too.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { send, uploadTour } from "./bundle.ts";
import { manifestOf } from "./isolation-world.ts";

const SOURCES = import.meta.glob("../migrations/0017_ever_published.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const MIGRATION = SOURCES["../migrations/0017_ever_published.sql"];
const NOW = 1_800_000_000_000;

/** The migration's statements, its comments left out. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

describe("migration 0017's backfill, on this target's database", () => {
  it("marks the tours that are published, have a live version or a move, and no other", async () => {
    expect(typeof MIGRATION).toBe("string");
    const [alter, backfill, ...rest] = statements(MIGRATION);
    expect(alter).toMatch(/^ALTER TABLE tour ADD COLUMN ever_published /);
    expect(backfill).toMatch(/^UPDATE tour SET ever_published = 1/);
    expect(rest).toEqual([]);
    const { deps } = await makeDeps();
    const owner = await seedAccount(deps);
    const id = (n: number) => "tour_" + String(n).repeat(24);
    const tour = (n: number, status: string, publishedAt: number | null) =>
      deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id(n), owner.workspaceId, `Tour ${n}`, "abcdefghi" + "abcdefgh"[n], status, NOW, NOW, publishedAt]);
    await tour(1, "published", NOW);
    await tour(2, "draft", null);
    await tour(3, "draft", NOW);
    await tour(4, "draft", null);
    await deps.db.run("INSERT INTO snapshot (tour_id, data, published_at) VALUES (?, '{}', ?)", [id(4), NOW]);
    await tour(5, "published", null);
    await deps.db.run("INSERT INTO access_switch (tour_id, switch_id, target, from_publish, data, total, created_at, touched_at) VALUES (?, ?, 'private', NULL, '{}', 0, ?, ?)", [id(5), "sw_" + "5".repeat(24), NOW, NOW]);
    await deps.db.run("UPDATE tour SET ever_published = 0");
    await deps.db.run(backfill);
    expect((await deps.db.all<{ id: string; ever_published: number }>("SELECT id, ever_published FROM tour ORDER BY id")).map((r) => [r.id, r.ever_published])).toEqual([
      [id(1), 1],
      [id(2), 0],
      [id(3), 1],
      [id(4), 1],
      [id(5), 1],
    ]);
  });

  it("unpublish sets the mark, a publish alone does not need it, and unpublishing a draft leaves it clear", async () => {
    const { deps } = await makeDeps();
    const owner = await seedAccount(deps);
    const mark = async (tourId: string) => (await deps.db.first<{ ever_published: number }>("SELECT ever_published FROM tour WHERE id = ?", [tourId]))!.ever_published;
    const t = await uploadTour(deps, owner.token, manifestOf([300], "Marked"), { kind: "new" }, 2);
    expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/unpublish`, { token: owner.token })).status).toBe(204);
    expect(await mark(t.tour_id)).toBe(0);
    expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: owner.token })).status).toBe(200);
    expect(await mark(t.tour_id)).toBe(0);
    expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/unpublish`, { token: owner.token })).status).toBe(204);
    expect(await mark(t.tour_id)).toBe(1);
    expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: owner.token })).status).toBe(200);
    expect((await send(deps, "POST", `/api/v1/tours/${t.tour_id}/unpublish`, { token: owner.token })).status).toBe(204);
    expect(await mark(t.tour_id)).toBe(1);
  });
});
