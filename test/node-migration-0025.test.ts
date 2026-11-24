// Migration 0025 (the account a token belongs to) on a database at 0.1.62, which has 0024 and
// tokens of every kind (Node only: the shared harness always applies every migration to an
// empty database). One nullable column on api_token, filled only for a token made by
// connecting the app whose collection the audit record names, by an account of the token's
// own workspace. Every other row keeps what it had, the statements of 0.1.62 still run, the
// column takes only an existing account, and a second application stops at its first statement.
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isBeforeTokenAccount } from "../src/auth.ts";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0025_token_account.sql";

const id = (prefix: string, n: string) => `${prefix}_${n.repeat(24)}`;
const WS_A = id("ws", "a");
const WS_B = id("ws", "b");
const USR_A = id("usr", "a");
const USR_B = id("usr", "b");
const USR_C = id("usr", "c");
const USR_D = id("usr", "d");

describe("migration 0025 on an install of 0.1.62", () => {
  it("adds the column and fills it only where the record names an account of the token's workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const before = join(root, "before");
    const upTo = join(root, "upto");
    await mkdir(before);
    await mkdir(upTo);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const at = files.indexOf(NAME);
    // After media's 0024; 0023 was left unused on purpose.
    expect(files[at - 1]).toBe("0024_billing_removal.sql");
    expect(files.some((f) => f.startsWith("0023_"))).toBe(false);
    for (const f of files.slice(0, at)) await copyFile(join(MIGRATIONS_DIR, f), join(before, f));
    for (const f of files.slice(0, at + 1)) await copyFile(join(MIGRATIONS_DIR, f), join(upTo, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    try {
      expect(await migrate(db, before)).toEqual(files.slice(0, at));
      // As 0.1.62 wrote them: two workspaces, each with its owner; C a second member of A who is
      // later removed from it (membership gone, the row kept), and D a member of A whose account
      // is deleted later on.
      for (const [ws, usr, mail] of [[WS_A, USR_A, "a@example.com"], [WS_B, USR_B, "b@example.com"]]) {
        await db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, ?, 1)", [ws, `Workspace ${mail}`]);
        await db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, 1)", [usr, ws, mail]);
        await db.run("INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', 1)", [ws, usr]);
      }
      await db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, 'c@example.com', 1)", [USR_C, WS_A]);
      await db.run("INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', 1)", [WS_A, USR_C]);
      await db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, 'd@example.com', 1)", [USR_D, WS_A]);
      await db.run("INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', 1)", [WS_A, USR_D]);
      const token = (n: string, ws: string, kind: "setup" | "sign_in") =>
        db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at, kind) VALUES (?, ?, ?, ?, 2, ?)", [id("tok", n), ws, `Token ${n}`, n.repeat(64), kind]);
      const collected = (n: string, tok: string, usr: string, ws: string) =>
        db.run("INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, 3, 'connection_collected', ?, ?, ?, NULL)", [id("aud", n), usr, ws, tok]);
      // 1: the first token of A, made with its owner: nothing records whose it is.
      await token("1", WS_A, "setup");
      // 2: a connection of A, collected by A's owner: the record names them.
      await token("2", WS_A, "sign_in");
      await collected("1", id("tok", "2"), USR_A, WS_A);
      // 3: a connection of A with no record of its collection.
      await token("3", WS_A, "sign_in");
      // 4: a connection of A whose record names B's owner and B's workspace: never A's.
      await token("4", WS_A, "sign_in");
      await collected("2", id("tok", "4"), USR_B, WS_B);
      // 5: a connection of A whose record names B's owner in A's workspace: B is no member of A.
      await token("5", WS_A, "sign_in");
      await collected("3", id("tok", "5"), USR_B, WS_A);
      // 6: a setup token whose id a record of another event names: only collections count.
      await token("6", WS_A, "setup");
      await db.run("INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, 3, 'token_renamed', ?, ?, ?, NULL)", [id("aud", "4"), USR_A, WS_A, id("tok", "6")]);
      // 7: a connection of B, collected by B's owner.
      await token("7", WS_B, "sign_in");
      await collected("5", id("tok", "7"), USR_B, WS_B);
      // Any other shape of record attaches the token only to one member of its own workspace:
      // a: two records of the same collection naming A's owner: A's owner.
      await token("a", WS_A, "sign_in");
      await collected("6", id("tok", "a"), USR_A, WS_A);
      await collected("7", id("tok", "a"), USR_A, WS_A);
      // b: two records naming two members of A: which is unknown, so none.
      await token("b", WS_A, "sign_in");
      await collected("8", id("tok", "b"), USR_A, WS_A);
      await collected("9", id("tok", "b"), USR_C, WS_A);
      // c: a record with no account, and one with no workspace: none.
      await token("c", WS_A, "sign_in");
      await db.run("INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, 3, 'connection_collected', NULL, ?, ?, NULL)", [id("aud", "c"), WS_A, id("tok", "c")]);
      await db.run("INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, 3, 'connection_collected', ?, NULL, ?, NULL)", [id("aud", "e"), USR_A, id("tok", "c")]);
      // d: a record naming a member removed from A (C, membership gone, row kept): none.
      await token("d", WS_A, "sign_in");
      await collected("f", id("tok", "d"), USR_C, WS_A);
      // e: a record naming an account deleted since (D): none.
      await token("e", WS_A, "sign_in");
      await collected("0", id("tok", "e"), USR_D, WS_A);
      // f: a record naming B's owner and A's workspace for a token of B: the token is B's, the record says A: none.
      await token("f", WS_B, "sign_in");
      await collected("d", id("tok", "f"), USR_B, WS_A);
      // g: a record with no subject names no token at all.
      await token("g", WS_A, "sign_in");
      await db.run("INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, 3, 'connection_collected', ?, ?, NULL, NULL)", [id("aud", "b"), USR_A, WS_A]);
      // C leaves A; D's account is deleted, as a removal does: its rows first.
      await db.run("DELETE FROM membership WHERE user_id = ?", [USR_C]);
      await db.run("DELETE FROM membership WHERE user_id = ?", [USR_D]);
      await db.run("DELETE FROM user WHERE id = ?", [USR_D]);
      const dump = async () => ({
        token: await db.all("SELECT * FROM api_token ORDER BY id"),
        audit: await db.all("SELECT * FROM audit ORDER BY id"),
        user: await db.all("SELECT * FROM user ORDER BY id"),
      });
      const old = await dump();

      // Before the migration, a read and a write naming the column fail with the errors the
      // fallbacks of GET /api/v1/me, the setup claim, a new workspace and a collection know.
      const failure = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
      const read = await failure(db.first("SELECT (SELECT k.user_id FROM api_token k WHERE k.id = ?) AS account_id FROM workspace w WHERE w.id = ?", [id("tok", "2"), WS_A]));
      const write = await failure(db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at, user_id) VALUES (?, ?, 'X', ?, 2, ?)", [id("tok", "9"), WS_A, "9".repeat(64), USR_A]));
      expect([isBeforeTokenAccount(read), isBeforeTokenAccount(write)]).toEqual([true, true]);
      expect(isBeforeTokenAccount(new Error("no such column: kind"))).toBe(false);

      expect(await migrate(db, upTo)).toEqual([NAME]);
      const after = await dump();
      const strip = (rows: unknown[]) => rows.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => k !== "user_id")));
      expect({ ...after, token: strip(after.token) }).toEqual(old);
      expect(await db.all("SELECT id, user_id FROM api_token ORDER BY id")).toEqual([
        { id: id("tok", "1"), user_id: null },
        { id: id("tok", "2"), user_id: USR_A },
        { id: id("tok", "3"), user_id: null },
        { id: id("tok", "4"), user_id: null },
        { id: id("tok", "5"), user_id: null },
        { id: id("tok", "6"), user_id: null },
        { id: id("tok", "7"), user_id: USR_B },
        { id: id("tok", "a"), user_id: USR_A },
        { id: id("tok", "b"), user_id: null },
        { id: id("tok", "c"), user_id: null },
        { id: id("tok", "d"), user_id: null },
        { id: id("tok", "e"), user_id: null },
        { id: id("tok", "f"), user_id: null },
        { id: id("tok", "g"), user_id: null },
      ]);
      // And no token is attached to an account outside its own workspace, whatever the records say.
      expect(await db.all("SELECT k.id FROM api_token k JOIN user u ON u.id = k.user_id WHERE u.workspace_id <> k.workspace_id OR u.id NOT IN (SELECT m.user_id FROM membership m WHERE m.workspace_id = k.workspace_id)")).toEqual([]);

      // 0.1.62's statements still run: they name no user_id.
      await db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, 'Later', ?, 4)", [id("tok", "8"), WS_A, "8".repeat(64)]);
      await db.run("DELETE FROM api_token WHERE workspace_id = ?", [WS_B]);
      await db.run("DELETE FROM membership WHERE user_id = ?", [USR_B]);
      await db.run("DELETE FROM user WHERE id = ?", [USR_B]);
      // The column takes an existing account only.
      await expect(db.run("UPDATE api_token SET user_id = ? WHERE id = ?", [id("usr", "9"), id("tok", "1")])).rejects.toThrow(/FOREIGN KEY constraint failed/);
      await db.run("UPDATE api_token SET user_id = ? WHERE id = ?", [USR_A, id("tok", "1")]);

      expect(await migrate(db, upTo)).toEqual([]);
      const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
      const settled = await dump();
      expect(() => db.transaction(() => db.raw.exec(sql))).toThrow(/duplicate column name/);
      expect(await dump()).toEqual(settled);
    } finally {
      db.close();
    }
  });

  it("adds one column and changes no row but the new column of a connection", async () => {
    const sql = (await readFile(join(MIGRATIONS_DIR, NAME), "utf8"))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    const statements = sql.split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s !== "");
    expect(statements.length).toBe(2);
    expect(statements[0]).toBe("ALTER TABLE api_token ADD COLUMN user_id TEXT REFERENCES user (id)");
    expect(statements[1]).toMatch(/^UPDATE api_token SET user_id = .* WHERE kind = 'sign_in' AND user_id IS NULL$/);
  });
});
