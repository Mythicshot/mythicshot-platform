// Migration 0011 (connecting the app) on a database that already holds a site at 0.1.25, the
// version it follows: migrations 1 to 10, with workspaces, their tokens (one revoked) and a
// session (Node only: the shared harness always applies every migration to an empty
// database, which test/schema.test.ts checks on both targets).
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashToken, newToken } from "../src/auth.ts";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { send } from "./bundle.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0011_connect.sql";
const NOW = 1_800_000_000_000;

/** A database at 0.1.25 (migrations 1 to 10), and a folder with 1 to 11. */
async function siteAt0125(): Promise<{ db: NodeDb; deps: Deps; upTo11: string; files: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  expect(files[10]).toBe(NAME);
  const upTo10 = join(root, "upto10");
  const upTo11 = join(root, "upto11");
  await mkdir(upTo10);
  await mkdir(upTo11);
  for (const f of files.slice(0, 10)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo10, f));
  for (const f of files.slice(0, 11)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo11, f));
  const db = new NodeDb(join(root, "db.sqlite"));
  expect(await migrate(db, upTo10)).toEqual(files.slice(0, 10));
  const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => NOW };
  return { db, deps, upTo11, files };
}

describe("migration 0011", () => {
  it("keeps every token as it was, as made by setup, and every token keeps working", async () => {
    const { db, deps, upTo11 } = await siteAt0125();
    const a = await createWorkspace(deps, "Acme", "owner@example.com");
    const revoked = newToken();
    await db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at, last_used_at, revoked_at) VALUES ('tok_000000000000000000000001', ?, 'Old', ?, 1, 2, 3)", [a.workspaceId, await hashToken(revoked)]);
    const before = await db.all<Record<string, unknown>>("SELECT * FROM api_token ORDER BY id");

    expect(await migrate(db, upTo11)).toEqual([NAME]);
    const after = await db.all<Record<string, unknown>>("SELECT * FROM api_token ORDER BY id");
    expect(after).toEqual(before.map((row) => ({ ...row, kind: "setup" })));
    expect((await send(deps, "GET", "/api/v1/me", { token: a.token })).json.workspace).toBe("Acme");
    expect((await send(deps, "GET", "/api/v1/me", { token: revoked })).status).toBe(401);
    // The key: one row of 64 hex characters, made once.
    expect(await db.all("SELECT id, length(key) AS n, key NOT GLOB '*[^0-9a-f]*' AS hex FROM connect_key")).toEqual([{ id: 1, n: 64, hex: 1 }]);
    expect(await db.all("SELECT * FROM connect_request")).toEqual([]);
  });

  it("the version before still writes its tokens on a database that has it, and a second application changes nothing", async () => {
    const { db, deps, upTo11 } = await siteAt0125();
    expect(await migrate(db, upTo11)).toEqual([NAME]);
    const key = await db.first("SELECT key FROM connect_key");
    // 0.1.25's own statement for a workspace's first token names no kind.
    const b = await createWorkspace(deps, "Other", "other@example.org");
    expect(await db.first("SELECT kind FROM api_token WHERE workspace_id = ?", [b.workspaceId])).toEqual({ kind: "setup" });
    // Its first statement fails on a database that has it, so nothing of it runs twice.
    const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    expect(() => db.raw.exec(sql)).toThrow(/duplicate column/);
    expect(await db.first("SELECT key FROM connect_key")).toEqual(key);
    expect(await migrate(db, upTo11)).toEqual([]);
    // A kind other than the two is refused.
    await expect(db.run("UPDATE api_token SET kind = 'other' WHERE workspace_id = ?", [b.workspaceId])).rejects.toThrow(/CHECK/);
  });
});
