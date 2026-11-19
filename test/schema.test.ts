import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { isUniqueViolation, type Deps } from "../src/ports.ts";
import { parseUsername } from "../src/usernames.ts";

/** The tables migration 0008 adds. */
const ACCOUNT_TABLES = ["audit", "membership", "rate_counter", "session", "signin_code", "signin_method"];

const TABLES = [
  "api_token",
  "audit",
  "chapter",
  "deleted_object",
  "membership",
  "public_object",
  "publish_job",
  "rate_counter",
  "replaced_object",
  "session",
  "setup",
  "signin_code",
  "signin_method",
  "snapshot",
  "snapshot_object",
  "step",
  "tour",
  "tour_deletion",
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

  it("a replaced picture's row cannot point at a tour that does not exist", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "Acme");
    await insertTour(deps, "tour_1", workspaceId, "abcdefghij");
    const insert = (tourId: string, key: string) =>
      deps.db.run("INSERT INTO replaced_object (tour_id, image_key, draft_version, created_at) VALUES (?, ?, 2, ?)", [tourId, key, NOW]);
    await rejection(insert("tour_missing", "u/up_x/step-001.png"));
    await insert("tour_1", "u/up_x/step-001.png");
    // One row per picture of a tour, and the tour cannot go while a row names it.
    expect(isUniqueViolation(await rejection(insert("tour_1", "u/up_x/step-001.png")))).toBe(true);
    await rejection(deps.db.run("DELETE FROM tour WHERE id = 'tour_1'"));
    expect(await deps.db.all("SELECT tour_id, image_key, draft_version FROM replaced_object")).toEqual([
      { tour_id: "tour_1", image_key: "u/up_x/step-001.png", draft_version: 2 },
    ]);
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

  // Accounts (migration 0008).

  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);

  /** The one user row a seeded workspace has. */
  async function ownerOf(deps: Deps, workspaceId: string): Promise<string> {
    return (await deps.db.first<{ id: string }>("SELECT id FROM user WHERE workspace_id = ?", [workspaceId]))!.id;
  }

  const setUsername = (deps: Deps, userId: string, username: string | null) =>
    deps.db.run("UPDATE user SET username = ? WHERE id = ?", [username, userId]);

  const insertSession = (deps: Deps, id: string, userId: string, hash: string) =>
    deps.db.run("INSERT INTO session (id, user_id, hash, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, 'Firefox on Linux', ?, ?, ?)", [id, userId, hash, NOW, NOW, NOW + 1000]);

  const insertCode = (deps: Deps, id: string, userId: string, hash: string) =>
    deps.db.run("INSERT INTO signin_code (id, user_id, hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", [id, userId, hash, NOW, NOW + 1000]);

  it("the account tables are strict like every other table, and have no column for a secret in plain text", async () => {
    const { deps } = await makeDeps();
    const tables = await appTables(deps);
    for (const t of tables) expect(t.sql, t.name).toMatch(/\)\s*STRICT$/);
    for (const name of ACCOUNT_TABLES) {
      const columns = (await deps.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`)).map((c) => c.name);
      expect(columns.length, name).toBeGreaterThan(0);
      for (const c of columns) expect(c, name).not.toMatch(/secret|token|password|cookie|code|email|address/);
    }
  });

  it("a username is unique, lowercase and 3 to 30 long, and many accounts may have none", async () => {
    const { deps } = await makeDeps();
    const users: string[] = [];
    for (const name of ["A", "B", "C"]) users.push(await ownerOf(deps, (await seedWorkspace(deps, name)).workspaceId));
    // Three accounts, none with a username: the unique index leaves them alone.
    expect(await deps.db.all("SELECT username FROM user")).toEqual([{ username: null }, { username: null }, { username: null }]);

    await setUsername(deps, users[0], "sam");
    expect(isUniqueViolation(await rejection(setUsername(deps, users[1], "sam")))).toBe(true);
    // Capitals are never stored, so they cannot slip past the unique index.
    await rejection(setUsername(deps, users[1], "Sam"));
    await rejection(setUsername(deps, users[1], "SAM"));
    await rejection(setUsername(deps, users[1], "ab"));
    await rejection(setUsername(deps, users[1], ""));
    await rejection(setUsername(deps, users[1], "a".repeat(31)));
    await setUsername(deps, users[1], "a".repeat(30));
    await setUsername(deps, users[2], "abc");
    expect(await deps.db.all("SELECT username FROM user ORDER BY username")).toEqual([{ username: "a".repeat(30) }, { username: "abc" }, { username: "sam" }]);
    // A name can be given up again, and two accounts can then both have none.
    await setUsername(deps, users[1], null);
    await setUsername(deps, users[2], null);
    expect(await deps.db.first("SELECT count(*) AS n FROM user WHERE username IS NULL")).toEqual({ n: 2 });
  });

  it("the database refuses every username the shape rule refuses, and holds no list of reserved names", async () => {
    const { deps } = await makeDeps();
    const user = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    const names = [
      "sam", "sam-9", "a-b-c", "x1y", "a".repeat(30), "ab", "a".repeat(31), "9am", "-sam", "sam-", "sa--m", "s-a-", "sam.b", "sam_b", "sa m", " sam", "sam ", "sam\n", "s\tam",
      "Sam", "sAm", "sám", "samа", "ſam", "sam​", "sam*", "sam]", "sam[", "sam^", "sam?", "sam%", "sam'", 'sam"', "sam/", "sam\\", "sam@x", "sam:x", "a-b", "a--", "abc-", "0ab", "ab0", "a0-", "a-0",
    ];
    for (const name of names) {
      // The rule's own answer for the stored form: a name the rule would first trim or lower is not a stored form.
      const parsed = parseUsername(name);
      const shapeOk = parsed.ok ? parsed.username === name : parsed.problem === "reserved";
      let stored = true;
      try {
        await setUsername(deps, user, name);
      } catch {
        stored = false;
      }
      expect(stored, JSON.stringify(name)).toBe(shapeOk);
      await setUsername(deps, user, null);
    }
    // Reserved names are the rule's business (src/usernames.ts), not the database's.
    expect(parseUsername("admin")).toEqual({ ok: false, problem: "reserved" });
    await setUsername(deps, user, "admin");
  });

  it("status and is_admin take only their values", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "A");
    const user = await ownerOf(deps, workspaceId);
    // A row written without them, as every version before wrote it, is an active account that is no admin.
    await deps.db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES ('usr_old', ?, 'old@example.com', ?)", [workspaceId, NOW]);
    expect(await deps.db.all("SELECT username, status, is_admin FROM user ORDER BY id")).toEqual([
      { username: null, status: "active", is_admin: 0 },
      { username: null, status: "active", is_admin: 0 },
    ]);
    for (const [sql, params] of [
      ["UPDATE user SET status = ? WHERE id = ?", ["gone", user]],
      ["UPDATE user SET status = ? WHERE id = ?", ["Active", user]],
      ["UPDATE user SET status = ? WHERE id = ?", ["", user]],
      ["UPDATE user SET status = ? WHERE id = ?", [null, user]],
      ["UPDATE user SET is_admin = ? WHERE id = ?", [2, user]],
      ["UPDATE user SET is_admin = ? WHERE id = ?", [-1, user]],
      ["UPDATE user SET is_admin = ? WHERE id = ?", [null, user]],
      ["UPDATE user SET is_admin = ? WHERE id = ?", ["yes", user]],
    ] as [string, (string | number | null)[]][]) {
      await rejection(deps.db.run(sql, params));
    }
    expect(await deps.db.first("SELECT status, is_admin FROM user WHERE id = ?", [user])).toEqual({ status: "active", is_admin: 0 });
    await deps.db.run("UPDATE user SET status = 'disabled', is_admin = 1 WHERE id = ?", [user]);
    expect(await deps.db.first("SELECT status, is_admin, typeof(is_admin) AS t FROM user WHERE id = ?", [user])).toEqual({ status: "disabled", is_admin: 1, t: "integer" });
  });

  it("an account has at most one membership for now", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    const b = await seedWorkspace(deps, "B");
    const userA = await ownerOf(deps, a.workspaceId);
    const insert = (workspaceId: string, userId: string, role = "owner") =>
      deps.db.run("INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [workspaceId, userId, role, NOW]);
    // The owner of A cannot also be a member of B, nor twice of A.
    expect(isUniqueViolation(await rejection(insert(b.workspaceId, userA)))).toBe(true);
    expect(isUniqueViolation(await rejection(insert(a.workspaceId, userA)))).toBe(true);
    // A membership names a real workspace and a real account, and the one role there is.
    await deps.db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES ('usr_new', ?, 'new@example.com', ?)", [b.workspaceId, NOW]);
    await rejection(insert("ws_missing", "usr_new"));
    await rejection(insert(b.workspaceId, "usr_missing"));
    await rejection(insert(b.workspaceId, "usr_new", "member"));
    await rejection(insert(b.workspaceId, "usr_new", "Owner"));
    expect(await count(deps, "membership")).toBe(2);
    await insert(b.workspaceId, "usr_new");
    expect(await deps.db.all("SELECT workspace_id, role FROM membership WHERE user_id = 'usr_new'")).toEqual([{ workspace_id: b.workspaceId, role: "owner" }]);
  });

  it("a sign-in method is one of the known kinds, once per account", async () => {
    const { deps } = await makeDeps();
    const user = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    const insert = (userId: string, kind: string) => deps.db.run("INSERT INTO signin_method (user_id, kind, created_at) VALUES (?, ?, ?)", [userId, kind, NOW]);
    expect(isUniqueViolation(await rejection(insert(user, "email_link")))).toBe(true);
    await rejection(insert(user, "password"));
    await rejection(insert("usr_missing", "email_link"));
    expect(await deps.db.all("SELECT user_id, kind FROM signin_method")).toEqual([{ user_id: user, kind: "email_link" }]);
  });

  it("a session and a sign-in code hash are unique", async () => {
    const { deps } = await makeDeps();
    const a = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    const b = await ownerOf(deps, (await seedWorkspace(deps, "B")).workspaceId);
    await insertSession(deps, "ses_1", a, HASH_A);
    expect(isUniqueViolation(await rejection(insertSession(deps, "ses_2", b, HASH_A)))).toBe(true);
    expect(isUniqueViolation(await rejection(insertSession(deps, "ses_1", b, HASH_B)))).toBe(true);
    await insertSession(deps, "ses_2", a, HASH_B);
    await insertCode(deps, "sic_1", a, HASH_A);
    expect(isUniqueViolation(await rejection(insertCode(deps, "sic_2", b, HASH_A)))).toBe(true);
    await insertCode(deps, "sic_2", b, HASH_B);
    // Both belong to a real account.
    await rejection(insertSession(deps, "ses_3", "usr_missing", "c".repeat(64)));
    await rejection(insertCode(deps, "sic_3", "usr_missing", "c".repeat(64)));
    expect(await deps.db.all("SELECT id, user_id, revoked_at FROM session ORDER BY id")).toEqual([
      { id: "ses_1", user_id: a, revoked_at: null },
      { id: "ses_2", user_id: a, revoked_at: null },
    ]);
    expect(await deps.db.all("SELECT id, user_id, used_at, session_id FROM signin_code ORDER BY id")).toEqual([
      { id: "sic_1", user_id: a, used_at: null, session_id: null },
      { id: "sic_2", user_id: b, used_at: null, session_id: null },
    ]);
  });

  it("a session or sign-in code row holds a SHA-256 hex digest and nothing else in its hash column", async () => {
    const { deps } = await makeDeps();
    const a = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    const notHashes = ["dps_" + "a".repeat(64), "dpl_" + "a".repeat(40), "dp_" + "a".repeat(40), "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "a".repeat(63) + " ", ""];
    for (const [i, v] of notHashes.entries()) {
      await rejection(insertSession(deps, `ses_${i}`, a, v));
      await rejection(insertCode(deps, `sic_${i}`, a, v));
    }
    expect(await count(deps, "session")).toBe(0);
    expect(await count(deps, "signin_code")).toBe(0);
    await insertSession(deps, "ses_ok", a, "0123456789abcdef".repeat(4));
    await insertCode(deps, "sic_ok", a, "0123456789abcdef".repeat(4));
  });

  it("a rate counter is one row per bucket, key and window, and never counts below zero", async () => {
    const { deps } = await makeDeps();
    const insert = (bucket: string, key: string, start: number, n: number) =>
      deps.db.run("INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, ?)", [bucket, key, start, n]);
    await insert("link_recipient", HASH_A, 900_000, 1);
    expect(isUniqueViolation(await rejection(insert("link_recipient", HASH_A, 900_000, 1)))).toBe(true);
    await insert("link_recipient", HASH_A, 1_800_000, 1);
    await insert("link_recipient", HASH_B, 900_000, 1);
    await insert("link_network", HASH_A, 900_000, 1);
    await rejection(insert("mail_site", "all", 0, -1));
    // The statement a limiter needs: add one, or start at one.
    const hit = "INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, 1) ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = count + 1";
    await deps.db.run(hit, ["link_recipient", HASH_A, 900_000]);
    await deps.db.run(hit, ["code_network", HASH_A, 900_000]);
    expect(await deps.db.all("SELECT bucket, key, window_start, count FROM rate_counter ORDER BY bucket, key, window_start")).toEqual([
      { bucket: "code_network", key: HASH_A, window_start: 900_000, count: 1 },
      { bucket: "link_network", key: HASH_A, window_start: 900_000, count: 1 },
      { bucket: "link_recipient", key: HASH_A, window_start: 900_000, count: 2 },
      { bucket: "link_recipient", key: HASH_A, window_start: 1_800_000, count: 1 },
      { bucket: "link_recipient", key: HASH_B, window_start: 900_000, count: 1 },
    ]);
  });

  it("nothing new cascades", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "A");
    const user = await ownerOf(deps, workspaceId);
    await insertSession(deps, "ses_1", user, HASH_A);
    await insertCode(deps, "sic_1", user, HASH_A);
    const tables = await appTables(deps);
    for (const name of ACCOUNT_TABLES) {
      const t = tables.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.sql, name).not.toMatch(/cascade|set null|set default/i);
    }
    expect(await deps.db.all("SELECT name FROM sqlite_master WHERE type = 'trigger'")).toEqual([]);

    // An account cannot be deleted out from under any row that names it: each kind of
    // row alone holds it, and nothing of them goes with a refused delete.
    const holders: [string, string][] = [
      ["session", "DELETE FROM session WHERE user_id = ?"],
      ["signin_code", "DELETE FROM signin_code WHERE user_id = ?"],
      ["signin_method", "DELETE FROM signin_method WHERE user_id = ?"],
      ["membership", "DELETE FROM membership WHERE user_id = ?"],
    ];
    for (const [table, remove] of holders) {
      await rejection(deps.db.run("DELETE FROM user WHERE id = ?", [user]));
      expect(await count(deps, "user"), table).toBe(1);
      expect(await count(deps, table), table).toBe(1);
      await deps.db.run(remove, [user]);
    }
    // The audit record names ids without pointing at their rows, so it outlives them.
    await deps.db.run("INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES ('aud_1', ?, 'signin', ?, ?, 'ses_1', NULL)", [NOW, user, workspaceId]);
    await deps.db.run("INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES ('aud_2', ?, 'signin', 'usr_gone', 'ws_gone', NULL, NULL)", [NOW]);
    await deps.db.run("DELETE FROM user WHERE id = ?", [user]);
    expect(await count(deps, "user")).toBe(0);
    expect(await deps.db.all("SELECT id, user_id FROM audit ORDER BY id")).toEqual([
      { id: "aud_1", user_id: user },
      { id: "aud_2", user_id: "usr_gone" },
    ]);
  });
});
