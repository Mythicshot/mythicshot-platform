// The test tool scripts/local-signin-link.ts: it prints a working sign-in link for a
// scratch site on this computer, and refuses everything else, each refusal before any
// code is made. And it is never shipped: the cPanel archive holds no scripts/ folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ARCHIVE_TOP_LEVEL } from "../scripts/package-cpanel.ts";
import { SAID, TOOL_LINE, runLocalSigninLink } from "../scripts/local-signin-link.ts";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";
import { redeemSignInCode } from "../src/sessions.ts";
import { workspaceStatements } from "../src/workspaces.ts";
import type { Deps } from "../src/ports.ts";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const made: string[] = [];
const opened: NodeDb[] = [];
afterEach(() => {
  // Closed first: Windows keeps an open database file from being removed.
  for (const db of opened.splice(0)) db.close();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch site in a new folder under `parent` (the temporary folder by default): migrated, with one admin, and the admin's email. */
async function scratch(opts: { admin?: boolean; parent?: string } = {}): Promise<{ dir: string; email: string; deps: Deps }> {
  const dir = mkdtempSync(join(opts.parent ?? tmpdir(), "signin-check-"));
  made.push(dir);
  const db = new NodeDb(join(dir, "db.sqlite"));
  opened.push(db);
  await migrate(db, MIGRATIONS);
  const deps: Deps = { db, drafts: null as never, pub: null as never, config: { publicImageBase: "", setupCode: null }, now: () => Date.now() };
  const email = "owner@example.com";
  const w = await workspaceStatements(deps, "Scratch", email);
  await db.batch([...w.stmts, { sql: "UPDATE user SET username = 'checker', is_admin = ? WHERE id = ?", params: [opts.admin === false ? 0 : 1, w.userId] }]);
  return { dir, email, deps };
}

async function run(argv: string[], env: Record<string, string>, opts: { tmp?: string } = {}): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runLocalSigninLink(argv, env, (l) => lines.push(l), opts);
  return { code, lines };
}

async function codes(deps: Deps): Promise<number> {
  return (await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM signin_code"))!.n;
}

describe("the local sign-in link tool", () => {
  it("prints a link that signs in once, for localhost, a .localhost name and 127.0.0.1, and names itself as a test tool", async () => {
    const site = await scratch();
    const settings: [Record<string, string>, string][] = [
      [{ SITE_HOST: "localhost:3000" }, "http://localhost:3000"],
      [{ SITE_HOST: "127.0.0.1:8080" }, "http://127.0.0.1:8080"],
      [{ TOURS_HOST: "tours.localhost:3000", APP_HOST: "app.localhost:3000" }, "http://app.localhost:3000"],
    ];
    for (const [env, origin] of settings) {
      const r = await run(["--email", site.email], { ...env, DATA_DIR: site.dir });
      expect(r.code, origin).toBe(0);
      expect(r.lines[0]).toBe(TOOL_LINE);
      expect(r.lines[0]).toMatch(/test tool/);
      expect(r.lines[1]).toBe(SAID.follows);
      expect(r.lines[2]).toMatch(new RegExp(`^${origin.replace(/\./g, "\\.")}/signin/link#c=dpl_[0-9a-f]{40}$`));
      expect(r.lines).toHaveLength(3);
      const code = r.lines[2].split("#c=")[1];
      expect(await redeemSignInCode(site.deps, code, null, null), origin).not.toBeNull();
      expect(await redeemSignInCode(site.deps, code, null, null), `${origin} twice`).toBeNull();
    }
  });

  it("refuses a site whose links do not go to this computer", async () => {
    const site = await scratch();
    for (const env of <Record<string, string>[]>[{}, { SITE_HOST: "tours.example.com" }, { SITE_HOST: "localhost.example.com" }, { TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" }, { TOURS_HOST: "tours.localhost", APP_HOST: "app.example.com" }, { SITE_HOST: "192.168.1.10:3000" }]) {
      const r = await run(["--email", site.email], { ...env, DATA_DIR: site.dir });
      expect([r.code, r.lines], JSON.stringify(env)).toEqual([1, [TOOL_LINE, SAID.host]]);
    }
    expect(await codes(site.deps)).toBe(0);
  });

  it("refuses a data folder outside the temporary folder, the temporary folder itself, and one that is not there", async () => {
    const site = await scratch();
    const env = { SITE_HOST: "localhost:3000" };
    // As if the temporary folder were elsewhere: the site's folder is then outside it.
    const otherTmp = mkdtempSync(join(tmpdir(), "not-the-site-"));
    made.push(otherTmp);
    const cases: [string, { tmp?: string }][] = [
      [site.dir, { tmp: otherTmp }],
      [tmpdir(), {}],
      [join(site.dir, "missing"), {}],
      [join(tmpdir(), "..", "outside-" + Date.now()), {}],
      [join(otherTmp, "..", "..", "..", "x"), {}],
      ["", {}],
    ];
    for (const [dir, opts] of cases) {
      const r = await run(["--email", site.email], { ...env, DATA_DIR: dir }, opts);
      expect([r.code, r.lines], dir).toEqual([1, [TOOL_LINE, SAID.dataDir]]);
    }
    expect([(await run(["--email", site.email], env)).lines[1]]).toEqual([SAID.dataDir]);
    expect(await codes(site.deps)).toBe(0);
  });

  it("refuses a folder with no database without making one, and a database without accounts", async () => {
    const empty = mkdtempSync(join(tmpdir(), "signin-check-"));
    made.push(empty);
    const r = await run(["--email", "owner@example.com"], { SITE_HOST: "localhost:3000", DATA_DIR: empty });
    expect([r.code, r.lines]).toEqual([1, [TOOL_LINE, SAID.noDatabase]]);
    expect(() => writeFileSync(join(empty, "probe"), "")).not.toThrow();
    const old = mkdtempSync(join(tmpdir(), "signin-check-"));
    made.push(old);
    const raw = new DatabaseSync(join(old, "db.sqlite"));
    raw.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)");
    raw.close();
    const r2 = await run(["--email", "owner@example.com"], { SITE_HOST: "localhost:3000", DATA_DIR: old });
    expect([r2.code, r2.lines]).toEqual([1, [TOOL_LINE, SAID.notMigrated]]);
    const none = mkdtempSync(join(tmpdir(), "signin-check-"));
    made.push(none);
    mkdirSync(join(none, "sub"));
    const r3 = await run(["--email", "owner@example.com"], { SITE_HOST: "localhost:3000", DATA_DIR: join(none, "sub") });
    expect(r3.lines[1]).toBe(SAID.noDatabase);
  });

  it("refuses bad settings, wrong arguments, a stranger and a site with no admin, and makes no code for any", async () => {
    const site = await scratch();
    const ok = { SITE_HOST: "localhost:3000", DATA_DIR: site.dir };
    expect(await run(["--email", site.email], { ...ok, STORAGE_ALLOWANCE_BYTES: "lots" })).toEqual({ code: 1, lines: [TOOL_LINE, SAID.settings] });
    expect(await run(["--email", site.email], { ...ok, TOURS_HOST: "tours.localhost" })).toEqual({ code: 1, lines: [TOOL_LINE, SAID.settings] });
    for (const argv of [[], ["--email"], ["--email", ""], ["--mail", site.email], ["--email", site.email, "--extra"]]) expect(await run(argv, ok), JSON.stringify(argv)).toEqual({ code: 2, lines: [TOOL_LINE, SAID.usage] });
    expect(await run(["--email", "stranger@example.com"], ok)).toEqual({ code: 1, lines: [TOOL_LINE, SAID.noLink] });
    expect(await codes(site.deps)).toBe(0);
    const noAdmin = await scratch({ admin: false });
    expect(await run(["--email", noAdmin.email], { SITE_HOST: "localhost:3000", DATA_DIR: noAdmin.dir })).toEqual({ code: 1, lines: [TOOL_LINE, SAID.noLink] });
    expect(await codes(noAdmin.deps)).toBe(0);
  });

  it("is never shipped: the cPanel archive takes no scripts folder", () => {
    expect(ARCHIVE_TOP_LEVEL as readonly string[]).not.toContain("scripts");
    expect((ARCHIVE_TOP_LEVEL as readonly string[]).some((name) => name.startsWith("scripts") || name.includes("local-signin-link"))).toBe(false);
  });
});
