// Migration 0016 (who may view a shared item, and the media viewer scope) on a database that
// already holds a site at the version before it: every migration before 0016, with an account
// and online items (Node only: the shared harness always applies every migration to an empty
// database). Then what an older build sees of a restricted item: 0.1.46's own lookup, word for
// word, finds nothing by the item's link.
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
const NAME = "0016_media_access.sql";
const NOW = 1_800_000_000_000;
const LINK = "abcdefghijklmnopqrst";

/**
 * The item lookup of 0.1.46 (src/media.ts, onlineItemFiles, at commit b7cf43f), as every older
 * build since 0.1.18 makes it: by link_id, online, of no disabled account. The columns it reads
 * are left out; the conditions are its own.
 */
const LOOKUP_0146 = `SELECT m.id FROM media m WHERE m.link_id = ? AND m.state = 'online'
        AND NOT EXISTS (SELECT 1 FROM user u WHERE u.status = 'disabled'
                          AND (u.workspace_id = m.workspace_id OR u.id IN (SELECT ms.user_id FROM membership ms WHERE ms.workspace_id = m.workspace_id)))`;

async function siteBefore(): Promise<{ db: NodeDb; deps: Deps; upTo16: string }> {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  expect(files).toContain(NAME);
  const before = files.filter((f) => f < NAME);
  const upTo15 = join(root, "before");
  const upTo16 = join(root, "with");
  await mkdir(upTo15);
  await mkdir(upTo16);
  for (const f of before) await copyFile(join(MIGRATIONS_DIR, f), join(upTo15, f));
  for (const f of [...before, NAME]) await copyFile(join(MIGRATIONS_DIR, f), join(upTo16, f));
  const db = new NodeDb(join(root, "db.sqlite"));
  expect(await migrate(db, upTo15)).toEqual(before);
  const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => NOW };
  return { db, deps, upTo16 };
}

async function item(db: NodeDb, ws: string, id: string, link: string): Promise<void> {
  await db.run(
    "INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, state, created_at, online_at) VALUES (?, ?, ?, 'image', 'image/png', 10, 1, 1, 1, 'online', ?, ?)",
    [id, ws, link, NOW, NOW],
  );
}

describe("migration 0016", () => {
  it("makes every existing item public, changes no row, and the items work as before", async () => {
    const { db, deps, upTo16 } = await siteBefore();
    const a = await createWorkspace(deps, "Acme", "owner@example.com");
    const id = "med_" + "1".repeat(24);
    await item(db, a.workspaceId, id, LINK);
    const before = await db.all<Record<string, unknown>>("SELECT * FROM media ORDER BY id");
    expect(await migrate(db, upTo16)).toEqual([NAME]);
    expect(await db.all("SELECT * FROM media ORDER BY id")).toEqual(before.map((m) => ({ ...m, access: "public", private_link_id: null })));
    expect(await db.all("SELECT media_id FROM media_viewer UNION ALL SELECT id FROM media_viewer_code UNION ALL SELECT id FROM media_viewer_session")).toEqual([]);
    const list = await send(deps, "GET", "/api/v1/media?kind=image", { token: a.token });
    expect(list.json.items).toMatchObject([{ id, link_id: LINK, access: "public", viewers: 0 }]);
    expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(await db.first("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("a second application stops at its first statement; the new tables, columns and triggers refuse what no build may write", async () => {
    const { db, deps, upTo16 } = await siteBefore();
    expect(await migrate(db, upTo16)).toEqual([NAME]);
    const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    expect(() => db.raw.exec(sql)).toThrow(/already exists/);
    expect(await migrate(db, upTo16)).toEqual([]);
    const a = await createWorkspace(deps, "Acme", "owner@example.com");
    const id = "med_" + "2".repeat(24);
    await item(db, a.workspaceId, id, LINK);
    await expect(db.run("UPDATE media SET access = 'friends', private_link_id = link_id WHERE id = ?", [id])).rejects.toThrow(/CHECK/);
    // Restricted with its link still in link_id, or public with one apart: refused, whatever writes it.
    await expect(db.run("UPDATE media SET access = 'me' WHERE id = ?", [id])).rejects.toThrow(/keeps its link id apart/);
    await expect(db.run("UPDATE media SET private_link_id = ? WHERE id = ?", ["b".repeat(20), id])).rejects.toThrow(/keeps its link id apart/);
    await expect(db.run("UPDATE media SET access = 'me', private_link_id = 'short' WHERE id = ?", [id])).rejects.toThrow(/CHECK/);
    // A link id is never both one item's link_id and another's private_link_id.
    await db.run("UPDATE media SET access = 'people', private_link_id = link_id, link_id = ? WHERE id = ?", ["c".repeat(20), id]);
    await expect(item(db, a.workspaceId, "med_" + "3".repeat(24), LINK)).rejects.toThrow(/UNIQUE constraint failed: media\.link_id/);
    await item(db, a.workspaceId, "med_" + "4".repeat(24), "d".repeat(20));
    await expect(db.run("UPDATE media SET access = 'me', private_link_id = link_id, link_id = ? WHERE id = ?", ["e".repeat(20), "med_" + "4".repeat(24)])).resolves.toBeDefined();
    await expect(db.run("UPDATE media SET link_id = ? WHERE id = ?", [LINK, "med_" + "4".repeat(24)])).rejects.toThrow(/UNIQUE constraint failed: media\.link_id/);
    // The lists take only addresses as sign-in writes them, of an item that exists.
    for (const email of ["Ana@example.com", "ana example.com", "a", "ana@b@c", "ana\u0000@example.com"]) {
      await expect(db.run("INSERT INTO media_viewer (media_id, email, created_at) VALUES (?, ?, 1)", [id, email]), email).rejects.toThrow(/CHECK/);
    }
    await expect(db.run("INSERT INTO media_viewer (media_id, email, created_at) VALUES (?, 'ana@example.com', 1)", ["med_" + "9".repeat(24)])).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.run("INSERT INTO media_viewer_code (id, email, path, code_hash, created_at, expires_at) VALUES ('vcm_000000000000000000000000', 'a@example.com', '/t/abcdefghij', ?, 1, 2)", ["0".repeat(64)])).rejects.toThrow(/CHECK/);
    await expect(db.run("INSERT INTO media_viewer_session (id, email, hash, created_at, last_used_at, expires_at) VALUES ('vse_000000000000000000000000', 'a@example.com', ?, 1, 1, 2)", ["0".repeat(64)])).rejects.toThrow(/CHECK/);
  });

  it("an older build's lookup finds a restricted item by no link: its real link is out of link_id, and the name in link_id is given to nobody", async () => {
    const { db, deps, upTo16 } = await siteBefore();
    const a = await createWorkspace(deps, "Acme", "owner@example.com");
    const id = "med_" + "5".repeat(24);
    await item(db, a.workspaceId, id, LINK);
    expect(await db.all(LOOKUP_0146, [LINK])).toEqual([{ id }]);
    expect(await migrate(db, upTo16)).toEqual([NAME]);
    // Restricted as this build restricts it (src/media-access.ts, settingStatement).
    await db.run("UPDATE media SET access = 'me', private_link_id = link_id, link_id = ? WHERE id = ? AND access = 'public'", ["f".repeat(20), id]);
    expect(await db.all(LOOKUP_0146, [LINK])).toEqual([]);
    // The name now in link_id is in no answer of this build: its list and the item answer the real link.
    const list = await send(deps, "GET", "/api/v1/media?kind=image", { token: a.token });
    expect(list.json.items).toMatchObject([{ id, link_id: LINK, access: "me" }]);
    expect(list.text).not.toContain("f".repeat(20));
    // Made public, the old lookup finds it by its link again.
    await db.run("UPDATE media SET access = 'public', link_id = private_link_id, private_link_id = NULL WHERE id = ?", [id]);
    expect(await db.all(LOOKUP_0146, [LINK])).toEqual([{ id }]);
  });
});
