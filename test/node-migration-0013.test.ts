// Migration 0013 (a delete of an account in progress) on a database that already holds a
// site at the version before it: every migration before 0013, with accounts, a tour and a
// token (Node only: the shared harness always applies every migration to an empty
// database, which test/schema.test.ts checks on both targets). The migrations are chosen by
// name, not by place, so one numbered between them that is merged later changes nothing here.
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
const NAME = "0013_account_removal.sql";
const NOW = 1_800_000_000_000;

/** A database with every migration before 0013, and a folder with those and 0013. */
async function siteBefore(): Promise<{ db: NodeDb; deps: Deps; upTo13: string }> {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  expect(files).toContain(NAME);
  const before = files.filter((f) => f < NAME);
  const upTo12 = join(root, "before");
  const upTo13 = join(root, "with");
  await mkdir(upTo12);
  await mkdir(upTo13);
  for (const f of before) await copyFile(join(MIGRATIONS_DIR, f), join(upTo12, f));
  for (const f of [...before, NAME]) await copyFile(join(MIGRATIONS_DIR, f), join(upTo13, f));
  const db = new NodeDb(join(root, "db.sqlite"));
  expect(await migrate(db, upTo12)).toEqual(before);
  const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => NOW };
  return { db, deps, upTo13 };
}

describe("migration 0013", () => {
  it("adds an empty table and changes no row: every account and token works as before", async () => {
    const { db, deps, upTo13 } = await siteBefore();
    const a = await createWorkspace(deps, "Acme", "owner@example.com");
    const dump = async () => ({ user: await db.all("SELECT * FROM user ORDER BY id"), token: await db.all("SELECT * FROM api_token ORDER BY id"), workspace: await db.all("SELECT * FROM workspace ORDER BY id") });
    const before = await dump();
    expect(await migrate(db, upTo13)).toEqual([NAME]);
    expect(await dump()).toEqual(before);
    expect(await db.all("SELECT * FROM account_removal")).toEqual([]);
    expect((await send(deps, "GET", "/api/v1/me", { token: a.token })).json.workspace).toBe("Acme");
  });

  it("a second application stops at its first statement, and the table refuses a row of the wrong shape", async () => {
    const { db, deps, upTo13 } = await siteBefore();
    expect(await migrate(db, upTo13)).toEqual([NAME]);
    const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    expect(() => db.raw.exec(sql)).toThrow(/already exists/);
    expect(await migrate(db, upTo13)).toEqual([]);
    const a = await createWorkspace(deps, "Acme", "owner@example.com");
    const user = (await db.first<{ id: string }>("SELECT id FROM user"))!.id;
    // The admin's id must have the form of an account's id, and the total must not be negative.
    await expect(db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, 'someone', 0, 1)", [user, a.workspaceId])).rejects.toThrow(/CHECK/);
    await expect(db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, -1, 1)", [user, a.workspaceId, user])).rejects.toThrow(/CHECK/);
    await db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, 0, 1)", [user, a.workspaceId, user]);
    // One per account, and one per workspace.
    await expect(db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, 0, 1)", [user, a.workspaceId, user])).rejects.toThrow(/UNIQUE/);
  });
});
