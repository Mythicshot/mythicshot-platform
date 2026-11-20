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
  "connect_key",
  "connect_request",
  "deleted_object",
  "email_change",
  "media",
  "media_object",
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
      "Sam", "sAm", "s\u00e1m", "sam\u0430", "\u017fam", "sam\u200b", "sam*", "sam]", "sam[", "sam^", "sam?", "sam%", "sam'", 'sam"', "sam/", "sam\\", "sam@x", "sam:x", "a-b", "a--", "abc-", "0ab", "ab0", "a0-", "a-0",
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

  // SQLite's length() and GLOB stop at the first NUL character of a text, so a CHECK made
  // of them alone would pass anything hidden behind one. Each such CHECK also compares the
  // length in bytes. The NUL is built inside the statement with char(0), so these cases do
  // not depend on what either target's binding does with one.

  const SECRET = "dps_" + "0123456789abcdef".repeat(4);

  /** The bytes of a hex string as text, one character per byte. */
  const bytesOf = (hex: string) => (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join("");

  it("a username cannot hide anything behind a NUL character", async () => {
    const { deps } = await makeDeps();
    const user = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    for (const tail of ["x", "Admin", " <b>", "-", "--", SECRET, "x".repeat(500)]) {
      await rejection(deps.db.run("UPDATE user SET username = 'abc' || char(0) || ? WHERE id = ?", [tail, user]));
    }
    await rejection(deps.db.run("UPDATE user SET username = 'abc' || char(0) WHERE id = ?", [user]));
    await rejection(deps.db.run("UPDATE user SET username = char(0) || 'abc' WHERE id = ?", [user]));
    await rejection(deps.db.run("UPDATE user SET username = 'ab' || char(0) || 'c' WHERE id = ?", [user]));
    // Letters outside ASCII are refused whether they are counted in characters or in bytes.
    for (const name of ["s\u00e1m", "sam\u00e9", "\u00e9".repeat(3), "\u00e9".repeat(15), "sam\u{1f600}", "\u0430bc"]) await rejection(setUsername(deps, user, name));
    expect(await deps.db.first("SELECT username FROM user WHERE id = ?", [user])).toEqual({ username: null });
    // The same through a bound value. Whatever a target's binding does with a NUL, no stored name holds one or anything after it.
    for (const name of ["abc\u0000x", "abc\u0000" + SECRET, "abc\u0000"]) {
      let outcome = "stored";
      try {
        await setUsername(deps, user, name);
      } catch {
        outcome = "refused";
      }
      const stored = (await deps.db.first<{ none: number; h: string }>("SELECT username IS NULL AS none, hex(CAST(username AS BLOB)) AS h FROM user WHERE id = ?", [user]))!;
      if (stored.none === 0) outcome += " as " + bytesOf(stored.h);
      if (stored.none === 0) expect(bytesOf(stored.h), JSON.stringify(name)).toMatch(/^[a-z][a-z0-9-]{2,29}$/);
      await setUsername(deps, user, null);
    }
  });

  it("a bound NUL character reaches the database whole on this target, so the byte-length guard is what stops it", async () => {
    const { deps } = await makeDeps();
    const a = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    // A column with no CHECK on its content: the label of a session, under its cap.
    await deps.db.run("INSERT INTO session (id, user_id, hash, label, created_at, last_used_at, expires_at) VALUES ('ses_1', ?, ?, ?, 1, 1, 2)", [a, HASH_A, "x\u0000y"]);
    expect(await deps.db.first("SELECT hex(CAST(label AS BLOB)) AS h, length(label) AS chars, length(CAST(label AS BLOB)) AS bytes FROM session")).toEqual({ h: "780079", chars: 1, bytes: 3 });
    // The same value as a username or a hash is refused by the CHECK, not cut short by the binding.
    await rejection(setUsername(deps, a, "abc\u0000x"));
    await rejection(insertSession(deps, "ses_2", a, HASH_B + "\u0000x"));
    await rejection(insertCode(deps, "sic_1", a, HASH_B + "\u0000x"));
    expect(await deps.db.first("SELECT (SELECT count(*) FROM session) AS s, (SELECT count(*) FROM signin_code) AS c, (SELECT username FROM user WHERE id = ?) AS u", [a])).toEqual({ s: 1, c: 0, u: null });
  });

  it("a session or sign-in code hash cannot hide a secret behind a NUL character, and is counted in bytes", async () => {
    const { deps } = await makeDeps();
    const a = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    const session = (hashSql: string, params: (string | number)[]) =>
      deps.db.run(`INSERT INTO session (id, user_id, hash, label, created_at, last_used_at, expires_at) VALUES ('ses_x', ?, ${hashSql}, 'Firefox on Linux', 1, 1, 2)`, [a, ...params]);
    const code = (hashSql: string, params: (string | number)[]) =>
      deps.db.run(`INSERT INTO signin_code (id, user_id, hash, created_at, expires_at) VALUES ('sic_x', ?, ${hashSql}, 1, 2)`, [a, ...params]);
    const cases: [string, string[]][] = [
      ["? || char(0) || ?", [HASH_A, SECRET]],
      ["? || char(0) || ?", [HASH_A, "x"]],
      ["? || char(0)", [HASH_A]],
      ["? || char(0) || ?", ["a".repeat(63), SECRET]],
      ["? || char(0) || ?", ["a".repeat(32), "a".repeat(31)]],
      ["char(0) || ?", [HASH_A]],
      // 64 characters, more than 64 bytes: a letter outside ASCII among the hex.
      ["?", ["a".repeat(63) + "\u00e9"]],
      ["?", ["\u00e9".repeat(32)]],
      ["?", ["\u00e9".repeat(64)]],
    ];
    for (const [sql, params] of cases) {
      await rejection(session(sql, params));
      await rejection(code(sql, params));
    }
    // A bound NUL: refused, or cut off by the binding before the database sees it. Either way no row holds one.
    for (const insert of [session, code]) {
      try {
        await insert("?", [HASH_A + "\u0000" + SECRET]);
      } catch {
        // Refused.
      }
    }
    for (const t of ["session", "signin_code"]) {
      for (const row of await deps.db.all<{ h: string }>(`SELECT hex(CAST(hash AS BLOB)) AS h FROM ${t}`)) expect(bytesOf(row.h), t).toBe(HASH_A);
    }
  });

  it("free text in the account tables is capped in bytes", async () => {
    const { deps } = await makeDeps();
    const a = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    let n = 0;
    const session = (labelSql: string, params: (string | number)[] = []) =>
      deps.db.run(`INSERT INTO session (id, user_id, hash, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ${labelSql}, 1, 1, 2)`, [`ses_${++n}`, a, n.toString(16).padStart(64, "0"), ...params]);
    // A session's label: at most 100 bytes.
    await session("?", ["x".repeat(100)]);
    await session("?", ["\u00e9".repeat(50)]);
    await session("?", [""]);
    await rejection(session("?", ["x".repeat(101)]));
    await rejection(session("?", ["\u00e9".repeat(51)]));
    await rejection(session("'x' || char(0) || ?", ["y".repeat(200)]));
    await rejection(session("? || char(0) || 'y'", ["x".repeat(99)]));
    expect(await count(deps, "session")).toBe(3);

    // A rate counter's bucket: at most 40 bytes. Its key: at most 100.
    const counter = (bucketSql: string, keySql: string, params: string[]) =>
      deps.db.run(`INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (${bucketSql}, ${keySql}, 0, 1)`, params);
    await counter("?", "?", ["b".repeat(40), "k".repeat(100)]);
    await rejection(counter("?", "?", ["b".repeat(41), "k"]));
    await rejection(counter("?", "?", ["b", "k".repeat(101)]));
    await rejection(counter("?", "?", ["\u00e9".repeat(21), "k"]));
    await rejection(counter("?", "?", ["b", "\u00e9".repeat(51)]));
    await rejection(counter("'b' || char(0) || ?", "?", ["x".repeat(60), "k"]));
    await rejection(counter("?", "'k' || char(0) || ?", ["b", "x".repeat(100)]));
    expect(await count(deps, "rate_counter")).toBe(1);

    // The audit record: event at most 40 bytes, the three ids at most 64 each, detail at most 1000.
    const audit = (column: string, valueSql: string, params: string[]) => {
      const values: Record<string, string> = { event: "'signin'", user_id: "NULL", workspace_id: "NULL", subject: "NULL", detail: "NULL" };
      values[column] = valueSql;
      return deps.db.run(`INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, 1, ${values.event}, ${values.user_id}, ${values.workspace_id}, ${values.subject}, ${values.detail})`, [`aud_${++n}`, ...params]);
    };
    const caps: [string, number][] = [["event", 40], ["user_id", 64], ["workspace_id", 64], ["subject", 64], ["detail", 1000]];
    for (const [column, most] of caps) {
      await audit(column, "?", ["x".repeat(most)]);
      await rejection(audit(column, "?", ["x".repeat(most + 1)]));
      await rejection(audit(column, "?", ["\u00e9".repeat(most / 2 + 1)]));
      await rejection(audit(column, "'x' || char(0) || ?", ["y".repeat(most)]));
    }
    expect(await count(deps, "audit")).toBe(caps.length);
  });

  it("the session a sign-in code names has the shape of an id, or is not set", async () => {
    const { deps } = await makeDeps();
    const a = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    let n = 0;
    const code = (idSql: string, params: (string | null)[]) =>
      deps.db.run(`INSERT INTO signin_code (id, user_id, hash, created_at, expires_at, used_at, session_id) VALUES (?, ?, ?, 1, 2, 1, ${idSql})`, [`sic_${++n}`, a, n.toString(16).padStart(64, "0"), ...params]);
    const HEX = "0123456789abcdef01234567";
    // A prefix of two to four lowercase letters, an underscore, 24 lowercase hex characters: the form every row id has.
    for (const id of [null, "ses_" + HEX, "se_" + HEX, "sess_" + HEX, "st_" + "f".repeat(24)]) await code("?", [id]);
    for (const id of [
      "", "ses_1", "ses_", HEX, "_" + HEX, "s_" + HEX, "sessi_" + HEX, "SES_" + HEX, "s3s_" + HEX, "ses-" + HEX, "ses_" + HEX.toUpperCase(), "ses_" + HEX.slice(1), "ses_" + HEX + "0", "ses_" + HEX.slice(1) + "g",
      "ses__" + HEX.slice(1), "s_s_" + HEX, " ses_" + HEX, "ses_" + HEX + " ", "ses_" + HEX.slice(1) + "\u00e9", "s\u00e9s_" + HEX, SECRET,
    ]) {
      await rejection(code("?", [id]));
    }
    await rejection(code("? || char(0) || ?", ["ses_" + HEX, SECRET]));
    await rejection(code("? || char(0) || ?", ["ses_" + HEX.slice(2), "x"]));
    expect(await count(deps, "signin_code")).toBe(5);
  });
  // Changing an email address (migration 0009).

  it("an email change is strict, one per account, and its code is found by its digest alone", async () => {
    const { deps } = await makeDeps();
    const a = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    const b = await ownerOf(deps, (await seedWorkspace(deps, "B")).workspaceId);
    const t = (await appTables(deps)).find((x) => x.name === "email_change");
    expect(t?.sql).toMatch(/\)\s*STRICT$/);
    expect(t?.sql).not.toMatch(/cascade|set null|set default/i);
    const indexes = await deps.db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'email_change' AND sql IS NOT NULL ORDER BY name");
    expect(indexes.map((i) => i.name)).toEqual(["email_change_code", "email_change_user"]);
    for (const i of indexes) expect(i.sql).toMatch(/^CREATE UNIQUE INDEX/);
    const change = (id: string, user: string, hash: string, email = "new@example.com") =>
      deps.db.run("INSERT INTO email_change (id, user_id, new_email, code_hash, created_at) VALUES (?, ?, ?, ?, ?)", [id, user, email, hash, NOW]);
    await change("emc_" + "0".repeat(24), a, HASH_A);
    // A second row for the same account, or the same digest for another, is refused.
    expect(isUniqueViolation(await rejection(change("emc_" + "1".repeat(24), a, HASH_B)))).toBe(true);
    expect(isUniqueViolation(await rejection(change("emc_" + "1".repeat(24), b, HASH_A)))).toBe(true);
    // An account that does not exist cannot have one.
    await rejection(change("emc_" + "2".repeat(24), "usr_nobody", HASH_B));
    await change("emc_" + "1".repeat(24), b, HASH_B);
    // Rows cannot be deleted out from under: the account stays while its change does.
    await rejection(deps.db.run("DELETE FROM user WHERE id = ?", [a]));
    expect(await count(deps, "email_change")).toBe(2);
  });

  it("an email change holds an address of the stored form, a digest and an id, and nothing can hide behind a NUL", async () => {
    const { deps } = await makeDeps();
    const user = await ownerOf(deps, (await seedWorkspace(deps, "A")).workspaceId);
    let n = 0;
    const row = (cols: { id?: string; email?: string; hash?: string }, emailSql = "?") => {
      n += 1;
      const id = cols.id ?? "emc_" + n.toString(16).padStart(24, "0");
      const hash = cols.hash ?? n.toString(16).padStart(64, "0");
      return deps.db.run(`INSERT INTO email_change (id, user_id, new_email, code_hash, created_at) VALUES (?, ?, ${emailSql}, ?, 1)`, [id, user, cols.email ?? "a@example.com", hash]);
    };
    const reset = () => deps.db.run("DELETE FROM email_change");
    for (const email of ["a@example.com", "first.last+tag@sub.example.co.uk", "x@" + "y".repeat(249) + ".zz"]) {
      await row({ email });
      await reset();
    }
    for (const email of ["", "ab", "A@example.com", "a@Example.com", "@example.com", "noatsign", "a@b@example.com", "a b@example.com", "a@example.com\n", "\u00e4@example.com", "a@ex\u00e4mple.com", "x@" + "y".repeat(250) + ".zz", "a\t@example.com"]) {
      await rejection(row({ email }));
    }
    await rejection(row({}, "'a@example.com' || char(0) || 'x'"));
    await rejection(row({}, "'a' || char(0) || '@example.com'"));
    for (const hash of ["", HASH_A.slice(1), HASH_A + "a", HASH_A.toUpperCase(), "g".repeat(64), SECRET]) await rejection(row({ hash }));
    await rejection(deps.db.run("INSERT INTO email_change (id, user_id, new_email, code_hash, created_at) VALUES ('emc_' || ?, ?, 'a@example.com', ? || char(0) || 'x', 1)", ["9".repeat(24), user, HASH_A.slice(2)]));
    for (const id of ["", "emc_1", "EMC_" + "0".repeat(24), "emc-" + "0".repeat(24), "emc_" + "0".repeat(23) + "g", "e_" + "0".repeat(24), "emcxx_" + "0".repeat(24), SECRET]) await rejection(row({ id }));
    await rejection(deps.db.run("INSERT INTO email_change (id, user_id, new_email, code_hash, created_at) VALUES (? || char(0) || 'x', ?, 'a@example.com', ?, 1)", ["emc_" + "0".repeat(24), user, HASH_B]));
    expect(await count(deps, "email_change")).toBe(0);
  });
  // Shared items (migration 0010).

  it("an item and its parts are strict, cascade nothing, and take only the shapes the routes write", async () => {
    const { deps } = await makeDeps();
    const { workspaceId } = await seedWorkspace(deps, "A");
    for (const name of ["media", "media_object"]) {
      const t = (await appTables(deps)).find((x) => x.name === name);
      expect(t?.sql, name).toMatch(/\)\s*STRICT$/);
      expect(t?.sql, name).not.toMatch(/cascade|set null|set default/i);
    }
    const indexes = await deps.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media' AND sql IS NOT NULL ORDER BY name");
    expect(indexes.map((i) => i.name)).toEqual(["media_list", "media_state"]);
    const objectIndexes = await deps.db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media_object' AND sql IS NOT NULL ORDER BY name");
    expect(objectIndexes.map((i) => i.name)).toEqual(["media_object_current"]);
    expect(objectIndexes[0].sql).toMatch(/^CREATE UNIQUE INDEX .* WHERE current = 1$/);
    let n = 0;
    type Cols = Partial<Record<"id" | "ws" | "link" | "kind" | "type" | "bytes" | "parts" | "width" | "height" | "duration" | "title" | "state", string | number | null>>;
    const item = (c: Cols = {}, titleSql = "?") => {
      n += 1;
      const v = { id: "med_" + n.toString(16).padStart(24, "0"), ws: workspaceId, link: "a".repeat(19) + "abcdefghijklmnopqrstuvwxyz234567"[n % 32], kind: "image", type: "image/png", bytes: 10, parts: 1, width: 1, height: 1, duration: null, title: null, state: "uploading", ...c };
      return deps.db.run(
        `INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${titleSql}, ?, 1)`,
        [v.id, v.ws, v.link, v.kind, v.type, v.bytes, v.parts, v.width, v.height, v.duration, v.title, v.state],
      );
    };
    const reset = () => deps.db.run("DELETE FROM media");
    const good: Cols[] = [
      {},
      { kind: "image", type: "image/jpeg" },
      { kind: "clip", type: "image/gif", duration: 1 },
      { kind: "clip", type: "video/mp4", duration: 600000, parts: 27 },
      { title: "x".repeat(120) },
      { title: "é".repeat(120) },
      { state: "online" },
      { state: "closing" },
    ];
    for (const c of good) {
      await item(c);
      await reset();
    }
    const bad: Cols[] = [
      { id: "med_1" },
      { id: "MED_" + "0".repeat(24) },
      { id: "up_" + "0".repeat(25) },
      { id: "med_" + "0".repeat(23) + "g" },
      { ws: "ws_nobody" },
      { link: "a".repeat(19) },
      { link: "a".repeat(21) },
      { link: "A".repeat(20) },
      { link: "a".repeat(19) + "1" },
      { link: "a".repeat(19) + "8" },
      { kind: "video" },
      { type: "image/gif" },
      { type: "image/svg+xml" },
      { kind: "clip", type: "image/png", duration: 1 },
      { kind: "clip", type: "video/mp4" },
      { kind: "clip", type: "video/mp4", duration: 0 },
      { duration: 5 },
      { bytes: 0 },
      { parts: 0 },
      { parts: 1000 },
      { width: 0 },
      { height: -1 },
      { title: "" },
      { title: "x".repeat(481) },
      { state: "deleted" },
    ];
    for (const c of bad) expect(await item(c).then(() => "stored", () => "refused"), JSON.stringify(c)).toBe("refused");
    await rejection(item({}, "'a' || char(0) || 'b'"));
    await rejection(deps.db.run("INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, state, created_at) VALUES (? || char(0) || 'x', ?, ?, 'image', 'image/png', 1, 1, 1, 1, 'uploading', 1)", ["med_" + "0".repeat(24), workspaceId, "b".repeat(20)]));
    expect(await count(deps, "media")).toBe(0);

    // A link id is unique. An object row needs its item and has a claim of its own; it is a
    // part (n from 0, no type) or the preview (n = -1, png or jpg); it is current only once
    // stored, and at most one claim per part and preview is current.
    await item({ id: "med_" + "1".repeat(24), link: "c".repeat(20) });
    expect(isUniqueViolation(await rejection(item({ link: "c".repeat(20) })))).toBe(true);
    let k = 0;
    const object = (cols: { media?: string; claim?: string; n?: number; ext?: string | null; bytes?: number; stored?: number | null; current?: number }) => {
      k += 1;
      return deps.db.run("INSERT INTO media_object (media_id, claim, n, ext, bytes, claimed_at, stored_at, current) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", [
        cols.media ?? "med_" + "1".repeat(24), cols.claim ?? k.toString(16).padStart(24, "0"), cols.n ?? 0, cols.ext === undefined ? null : cols.ext, cols.bytes ?? 1, cols.stored === undefined ? null : cols.stored, cols.current ?? 0,
      ]);
    };
    await object({ n: 0, bytes: 2_000_000, stored: 5, current: 1 });
    await object({ n: 0 });
    await object({ n: 0, stored: 6 });
    await object({ n: 998 });
    await object({ n: -1, ext: "png", bytes: 100_000, stored: 7, current: 1 });
    await object({ n: -1, ext: "jpg" });
    expect(isUniqueViolation(await rejection(object({ n: 0, stored: 8, current: 1 })))).toBe(true);
    expect(isUniqueViolation(await rejection(object({ n: -1, ext: "jpg", stored: 8, current: 1 })))).toBe(true);
    expect(isUniqueViolation(await rejection(object({ claim: "1".padStart(24, "0") })))).toBe(true);
    for (const c of [
      { media: "med_" + "2".repeat(24) },
      { n: -2 },
      { n: 999 },
      { n: 1, bytes: 0 },
      { n: 1, bytes: 2_000_001 },
      { n: -1, ext: "png", bytes: 100_001 },
      { n: -1 },
      { n: -1, ext: "gif" },
      { n: 1, ext: "png" },
      { n: 1, current: 1 },
      { n: 1, current: 2, stored: 1 },
      { n: 1, claim: "a".repeat(23) },
      { n: 1, claim: "A".repeat(24) },
    ]) {
      expect(await object(c).then(() => "stored", () => "refused"), JSON.stringify(c)).toBe("refused");
    }
    await rejection(deps.db.run("INSERT INTO media_object (media_id, claim, n, bytes, claimed_at) VALUES (?, ? || char(0) || 'x', 1, 1, 1)", ["med_" + "1".repeat(24), "a".repeat(22)]));
    expect(await count(deps, "media_object")).toBe(6);
    // An item with parts cannot be deleted out from under them.
    await rejection(deps.db.run("DELETE FROM media WHERE id = ?", ["med_" + "1".repeat(24)]));
  });
});
