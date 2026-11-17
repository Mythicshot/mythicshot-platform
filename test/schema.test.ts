import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { isUniqueViolation, type Deps } from "../src/ports.ts";

const TABLES = [
  "api_token",
  "chapter",
  "setup",
  "snapshot",
  "snapshot_object",
  "step",
  "tour",
  "upload",
  "upload_step",
  "user",
  "workspace",
];

async function appTables(deps: Deps): Promise<{ name: string; sql: string }[]> {
  return deps.db.all<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_*' AND name NOT GLOB 'd1_*' ORDER BY name",
  );
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the statement to fail");
}

const NOW = 1_700_000_000_000;

async function insertTour(deps: Deps, id: string, workspaceId: string, slug: string): Promise<void> {
  await deps.db.run(
    "INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
    [id, workspaceId, "A tour", slug, NOW, NOW],
  );
}

async function insertChapter(deps: Deps, id: string, tourId: string): Promise<void> {
  await deps.db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES (?, ?, ?, ?)", [id, tourId, "Chapter", 0]);
}

/** Inserts a step; `click` is [x, y], with null for either to leave it unset. */
function insertStep(
  deps: Deps,
  id: string,
  tourId: string,
  chapterId: string | null,
  click: [number | null, number | null] = [12.5, 40],
  imageType = "png",
): Promise<{ changes: number }> {
  return deps.db.run(
    "INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, click_x, click_y, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')",
    [id, tourId, chapterId, 0, "u/step-001.png", imageType, 1280, 720, 2_000_000, click[0], click[1]],
  );
}

async function count(deps: Deps, table: string): Promise<number> {
  return (await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
}

describe("schema", () => {
  it("has exactly the platform's tables", async () => {
    const { deps } = await makeDeps();
    expect((await appTables(deps)).map((t) => t.name)).toEqual(TABLES);
  });

  it("slug and token hash are unique", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "Acme");
    await insertTour(deps, "tour_1", workspaceId, "abcdefghij");
    expect(isUniqueViolation(await rejection(insertTour(deps, "tour_2", workspaceId, "abcdefghij")))).toBe(true);

    const { hash } = (await deps.db.first<{ hash: string }>("SELECT hash FROM api_token"))!;
    const err = await rejection(
      deps.db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, ?, ?, ?)", [
        "tok_2",
        workspaceId,
        "second",
        hash,
        NOW,
      ]),
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("the setup table holds at most one row", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "Acme");
    await deps.db.run("INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, ?)", [workspaceId, NOW]);
    expect(
      isUniqueViolation(
        await rejection(deps.db.run("INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, ?)", [workspaceId, NOW])),
      ),
    ).toBe(true);
    await rejection(deps.db.run("INSERT INTO setup (id, workspace_id, completed_at) VALUES (2, ?, ?)", [workspaceId, NOW]));
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM setup")).toEqual({ n: 1 });
  });

  it("deleting is never cascaded by the schema", async () => {
    const { deps } = await makeDeps();
    for (const t of await appTables(deps)) expect(t.sql).not.toMatch(/cascade/i);
    const triggers = await deps.db.all("SELECT name FROM sqlite_master WHERE type = 'trigger'");
    expect(triggers).toEqual([]);
  });

  it("a row cannot point at a workspace or tour that does not exist", async () => {
    const { deps } = await makeDeps();
    await rejection(
      deps.db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)", [
        "usr_1",
        "ws_missing",
        "owner@example.com",
        NOW,
      ]),
    );
    await rejection(
      deps.db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES (?, ?, ?, ?)", ["ch_1", "tour_missing", "x", 0]),
    );
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM user")).toEqual({ n: 0 });
  });

  it("a workspace with rows cannot be deleted out from under them", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "Acme");
    await rejection(deps.db.run("DELETE FROM workspace WHERE id = ?", [workspaceId]));
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM api_token")).toEqual({ n: 1 });
  });

  it("refuses text in an integer column", async () => {
    const { deps } = await makeDeps();
    await rejection(deps.db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", ["ws_1", "Acme", "soon"]));
    expect(await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM workspace")).toEqual({ n: 0 });
  });

  it("stores millisecond timestamps and counters as integers", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "Acme");
    await insertTour(deps, "tour_1", workspaceId, "abcdefghij");
    await insertChapter(deps, "ch_1", "tour_1");
    await insertStep(deps, "st_1", "tour_1", "ch_1");
    const tour = await deps.db.first<{ t: string; created_at: number }>(
      "SELECT typeof(created_at) AS t, created_at FROM tour WHERE id = 'tour_1'",
    );
    expect(tour).toEqual({ t: "integer", created_at: NOW });
    const step = await deps.db.first<Record<string, unknown>>(
      "SELECT typeof(position) AS p, typeof(width) AS w, typeof(bytes) AS b, click_x, click_size FROM step WHERE id = 'st_1'",
    );
    expect(step).toEqual({ p: "integer", w: "integer", b: "integer", click_x: 12.5, click_size: 4 });
  });

  it("refuses an unknown tour status or image type and an out-of-range spotlight dim", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "Acme");
    await rejection(
      deps.db.run(
        "INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 't', 's1', 'live', ?, ?)",
        ["tour_1", workspaceId, NOW, NOW],
      ),
    );
    await rejection(
      deps.db.run(
        "INSERT INTO tour (id, workspace_id, title, slug, status, spotlight_dim, created_at, updated_at) VALUES (?, ?, 't', 's2', 'draft', ?, ?, ?)",
        ["tour_2", workspaceId, 95, NOW, NOW],
      ),
    );
    await insertTour(deps, "tour_3", workspaceId, "s3");
    await insertChapter(deps, "ch_3", "tour_3");
    await rejection(insertStep(deps, "st_1", "tour_3", "ch_3", [0, 0], "gif"));
    expect(await count(deps, "step")).toBe(0);
  });

  it("a step without a click inserts, and a step with only one click coordinate is refused", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "Acme");
    await insertTour(deps, "tour_1", workspaceId, "abcdefghij");
    await insertChapter(deps, "ch_1", "tour_1");
    await insertStep(deps, "st_last", "tour_1", "ch_1", [null, null]);
    expect(await deps.db.first("SELECT click_x, click_y FROM step WHERE id = 'st_last'")).toEqual({
      click_x: null,
      click_y: null,
    });
    await rejection(insertStep(deps, "st_x", "tour_1", "ch_1", [10, null]));
    await rejection(insertStep(deps, "st_y", "tour_1", "ch_1", [null, 10]));
    expect(await count(deps, "step")).toBe(1);
  });

  it("a step needs a chapter, and the chapter must belong to the step's tour", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "Acme");
    await insertTour(deps, "tour_1", workspaceId, "aaaaaaaaaa");
    await insertTour(deps, "tour_2", workspaceId, "bbbbbbbbbb");
    await insertChapter(deps, "ch_1", "tour_1");
    await insertChapter(deps, "ch_2", "tour_2");
    await rejection(insertStep(deps, "st_none", "tour_1", null));
    await rejection(insertStep(deps, "st_cross", "tour_1", "ch_2"));
    await rejection(insertStep(deps, "st_missing", "tour_1", "ch_missing"));
    await insertStep(deps, "st_ok", "tour_1", "ch_1");
    expect(await deps.db.all("SELECT id FROM step")).toEqual([{ id: "st_ok" }]);
    // Moving the step to a chapter of another tour is refused too.
    await rejection(deps.db.run("UPDATE step SET chapter_id = 'ch_2' WHERE id = 'st_ok'"));
    expect(await deps.db.first("SELECT chapter_id FROM step WHERE id = 'st_ok'")).toEqual({ chapter_id: "ch_1" });
  });

  it("a user's email is unique, stored lowercased", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    const b = await seedWorkspace(deps, "B");
    await deps.db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)", [
      "usr_1",
      a.workspaceId,
      "sam@example.com",
      NOW,
    ]);
    const err = await rejection(
      deps.db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)", [
        "usr_2",
        b.workspaceId,
        "sam@example.com",
        NOW,
      ]),
    );
    expect(isUniqueViolation(err)).toBe(true);
    // Mixed case is never stored, so it cannot slip past the unique index.
    await rejection(
      deps.db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)", [
        "usr_3",
        b.workspaceId,
        "Sam@example.com",
        NOW,
      ]),
    );
    expect(await deps.db.first("SELECT count(*) AS n FROM user WHERE email = 'sam@example.com'")).toEqual({ n: 1 });
  });
});
