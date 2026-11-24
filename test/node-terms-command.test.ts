// The server command's terms commands (src/node/admin.ts): publish from a file or standard input,
// list and show, run in this process on a database file in a scratch folder as `node
// dist/node/admin.js terms ...` runs beside the app. Node only. They work while every session,
// the admin's too, is held by the terms, so a site can never lock itself out; a file is refused
// with its one line; the same content twice is refused; the text is never printed raw.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requireAuth } from "../src/auth.ts";
import { runAdmin, TERMS_SAID } from "../src/node/admin.ts";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { TERMS_FILE_SAYS, lineSays } from "../src/terms.ts";
import { withoutTokenAccount, workspaceStatements } from "../src/workspaces.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const EXAMPLE = readFileSync(fileURLToPath(new URL("../docs/terms-example.txt", import.meta.url)));

const made: string[] = [];
const open: NodeDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function depsOn(db: NodeDb): Deps {
  const none = { put: async () => {}, get: async () => null, delete: async () => {} };
  return { db, drafts: none, pub: none, config: { publicImageBase: "", setupCode: null }, now: () => Date.now() };
}

/** A data folder with every migration (or every one before `before`), and an admin. */
async function site(opts: { before?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dp-terms-cmd-"));
  made.push(dir);
  let migrations = MIGRATIONS_DIR;
  if (opts.before !== undefined) {
    migrations = join(dir, "migrations-before");
    cpSync(MIGRATIONS_DIR, migrations, { recursive: true, filter: (from) => !from.endsWith(".sql") || from.slice(-30).replace(/^.*[\\/]/, "") < (opts.before as string) });
  }
  const db = new NodeDb(join(dir, "db.sqlite"));
  open.push(db);
  await migrate(db, migrations);
  const w = await workspaceStatements(depsOn(db), "Acme", "owner@example.com");
  // Before migration 0023 the token names no account, as such a site writes it.
  const stmts = opts.before !== undefined && opts.before < "0024" ? withoutTokenAccount(w.stmts) : w.stmts;
  await db.batch([...stmts, { sql: "UPDATE user SET username = 'owner', is_admin = 1 WHERE id = ?", params: [w.userId] }]);
  return { dir, db, env: { DATA_DIR: dir } as NodeJS.ProcessEnv, userId: w.userId };
}

async function run(argv: string[], env: NodeJS.ProcessEnv, stdin?: Uint8Array) {
  const lines: string[] = [];
  const code = await runAdmin(argv, env, (l) => lines.push(l), stdin === undefined ? {} : { readStdin: async () => stdin });
  return { code, lines };
}

describe("terms publish", () => {
  it("publishes the example file, says what it did, and holds every session from then on, the admin's too; publishing it again changes nothing", async () => {
    const s = await site();
    const file = join(s.dir, "terms.txt");
    writeFileSync(file, EXAMPLE);
    const signedIn = await redeemSignInCode(depsOn(s.db), await createSignInCode(depsOn(s.db), s.userId), null, null);
    const req = () => new Request("https://site.example.com/api/v1/tours", { headers: { cookie: `${SESSION_COOKIE}=${signedIn!.secret}` } });
    expect(await requireAuth(req(), depsOn(s.db))).not.toBeInstanceOf(Response);
    const r = await run(["terms", "publish", file], s.env);
    const row = await s.db.first<{ id: string; seq: number }>("SELECT id, seq FROM terms_version");
    expect(r).toEqual({ code: 0, lines: [TERMS_SAID.published(1, row!.id, "21 November 2026"), TERMS_SAID.publishedNext] });
    expect(r.lines[0]).toBe(`Published version 1 of the terms, "21 November 2026" (${row!.id}).`);
    expect(TERMS_SAID.published(2, "trm_x", "1 December 2026")).toBe('Published version 2 of the terms, "1 December 2026" (trm_x).');
    const held = await requireAuth(req(), depsOn(s.db));
    expect(held instanceof Response && (await held.json())).toEqual({ error: "terms_required", detail: "agree to the site's terms first" });
    // The same content again, also written with other line ends: refused, nothing written.
    writeFileSync(file, EXAMPLE.toString("utf8").replace(/\n/g, "\r\n"));
    expect(await run(["terms", "publish", file], s.env)).toEqual({ code: 1, lines: [`These terms are the same as version 1 (${row!.id}), already published. Nothing was changed.`] });
    expect(await s.db.all("SELECT id FROM terms_version")).toHaveLength(1);
    // The command still works while the admin is held: a new version is published.
    writeFileSync(file, EXAMPLE.toString("utf8").replace("version: 21 November 2026", "version: 1 December 2026"));
    const second = await run(["terms", "publish", file], s.env);
    expect(second.code).toBe(0);
    expect(second.lines[0]).toMatch(/^Published version 2 of the terms, "1 December 2026" \(trm_[0-9a-f]{24}\)\.$/);
  });

  it("reads standard input for -, and a relative path from the folder cpanel.sh was run in", async () => {
    const s = await site();
    expect((await run(["terms", "publish", "-"], s.env, new Uint8Array(EXAMPLE))).code).toBe(0);
    const elsewhere = join(s.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "next.txt"), EXAMPLE.toString("utf8").replace("21 November 2026", "2 December 2026"));
    expect((await run(["terms", "publish", "next.txt"], { ...s.env, DEMO_PLATFORM_ADMIN_FROM: elsewhere })).code).toBe(0);
    // A relative folder named there is not taken as one.
    expect(await run(["terms", "publish", "next.txt"], { ...s.env, DEMO_PLATFORM_ADMIN_FROM: "elsewhere" })).toEqual({ code: 1, lines: [TERMS_SAID.notRead] });
  });

  it("refuses a file with its one line, a file it cannot read, one too large, and writes nothing", async () => {
    const s = await site();
    const file = join(s.dir, "bad.txt");
    writeFileSync(file, "title: T\nversion: 1\nlink: L | http://example.com/\n");
    expect(await run(["terms", "publish", file], s.env)).toEqual({ code: 1, lines: [`The terms were not published: ${lineSays(3, TERMS_FILE_SAYS.badLinkUrl)}`] });
    expect(await run(["terms", "publish", join(s.dir, "missing.txt")], s.env)).toEqual({ code: 1, lines: [TERMS_SAID.notRead] });
    expect(await run(["terms", "publish", s.dir], s.env)).toEqual({ code: 1, lines: [TERMS_SAID.notRead] });
    writeFileSync(file, Buffer.alloc(262_145, 0x41));
    expect(await run(["terms", "publish", file], s.env)).toEqual({ code: 1, lines: [`The terms were not published: ${TERMS_FILE_SAYS.tooLarge}`] });
    expect(await run(["terms", "publish", "-"], s.env, new Uint8Array(262_145))).toEqual({ code: 1, lines: [`The terms were not published: ${TERMS_FILE_SAYS.tooLarge}`] });
    expect(await s.db.all("SELECT id FROM terms_version")).toEqual([]);
  });

  it("takes exactly its shapes, and stops on a database from before the terms", async () => {
    const s = await site();
    for (const argv of [["terms"], ["terms", "publish"], ["terms", "publish", "a", "b"], ["terms", "publish", "--file"], ["terms", "list", "x"], ["terms", "show"], ["terms", "remove", "x"]]) expect((await run(argv, s.env)).code, argv.join(" ")).toBe(2);
    const old = await site({ before: "0018_terms.sql" });
    expect(await run(["terms", "list"], old.env)).toEqual({ code: 1, lines: ["The database is from an older version. Update the site first."] });
  });
});

describe("two publishes at once", () => {
  it("the one that loses the race on the version's number gets one clean line and writes nothing", async () => {
    const s = await site();
    // As if another publish took the next number between this one's read and its write: the
    // database refuses the row with the words SQLite uses for that.
    s.db.raw.exec("CREATE TRIGGER race BEFORE INSERT ON terms_version BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: terms_version.seq'); END;");
    const lines: string[] = [];
    expect(await runAdmin(["terms", "publish", "-"], s.env, (l) => lines.push(l), { readStdin: async () => new Uint8Array(EXAMPLE) })).toBe(1);
    expect(lines).toEqual([TERMS_SAID.busy]);
    s.db.raw.exec("DROP TRIGGER race");
    expect(await s.db.all("SELECT id FROM terms_version")).toEqual([]);
  });
});

describe("terms list and show", () => {
  it("list says when there is none, then each version oldest first with its agreements and the current one marked; show prints one exactly, made safe for a terminal", async () => {
    const s = await site();
    expect(await run(["terms", "list"], s.env)).toEqual({ code: 0, lines: [TERMS_SAID.none] });
    expect((await run(["terms", "publish", "-"], s.env, new Uint8Array(EXAMPLE))).code).toBe(0);
    expect((await run(["terms", "publish", "-"], s.env, new TextEncoder().encode("title: T\nversion: 2\nmain points:\n- P\nterms:\n<b>bold</b> & more\n"))).code).toBe(0);
    const ids = (await s.db.all<{ id: string; published_at: number }>("SELECT id, published_at FROM terms_version ORDER BY seq"));
    await s.db.run("INSERT INTO terms_agreement (user_id, terms_id, agreed_at) VALUES (?, ?, 1)", [s.userId, ids[0].id]);
    const list = await run(["terms", "list"], s.env);
    expect(list).toEqual({
      code: 0,
      lines: [TERMS_SAID.row(1, ids[0].id, ids[0].published_at, "21 November 2026", 1, false), TERMS_SAID.row(2, ids[1].id, ids[1].published_at, "2", 0, true)],
    });
    expect(list.lines[1]).toMatch(/^2  trm_[0-9a-f]{24}  \d{4}-\d\d-\d\dT[\d:.]+Z  "2"  0 accounts agreed  \(current\)$/);
    const shown = await run(["terms", "show", ids[1].id], s.env);
    expect(shown.code).toBe(0);
    expect(shown.lines.slice(2)).toEqual(["title: T", "version: 2", "main points:", "- P", "terms:", "<b>bold</b> & more"]);
    expect(await run(["terms", "show", "trm_" + "0".repeat(24)], s.env)).toEqual({ code: 1, lines: [TERMS_SAID.notFound] });
    expect(await run(["terms", "show", "nonsense"], s.env)).toEqual({ code: 1, lines: [TERMS_SAID.notFound] });
  });

  it("the sentences, as the owner is asked to approve them", () => {
    expect(TERMS_SAID.notRead).toBe("The file could not be read. Nothing was changed.");
    expect(TERMS_SAID.refused("line 4: x")).toBe("The terms were not published: line 4: x");
    expect(TERMS_SAID.same({ seq: 3, id: "trm_a" })).toBe("These terms are the same as version 3 (trm_a), already published. Nothing was changed.");
    expect(TERMS_SAID.busy).toBe("Another version of the terms was published at the same moment. Nothing was changed; run the command again.");
    expect(TERMS_SAID.same(null)).toBe("These terms are the same as a version already published. Nothing was changed.");
    expect(TERMS_SAID.publishedNext).toBe("From now on every account is asked to agree to it at its next sign-in or dashboard request. Connected computers keep working.");
    expect(TERMS_SAID.none).toBe("No terms have been published. Nobody is asked to agree to anything.");
    expect(TERMS_SAID.notFound).toBe("No version of the terms has that id.");
    expect(TERMS_SAID.shown(2, 0, "ab")).toBe("Version 2 of the terms, published 1970-01-01T00:00:00.000Z, SHA-256 ab:");
  });
});
