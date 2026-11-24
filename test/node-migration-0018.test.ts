// Migration 0018 (the site's terms) on a database that already holds a site at the version
// before it: every migration before 0018, an admin, a member, their tokens and sessions, then
// 0018 (Node only: the shared harness always applies every migration to an empty database).
//
// - This build on the database before 0018 (as a build started before its migration ran)
//   answers every request it did, the sessions' too: no terms table is no terms.
// - 0018 adds its two tables and changes no row of any other; it cannot run twice.
// - With no terms published, every answer, token and session alike, is byte for byte the
//   answer before the migration (but the date header).
// - Terms published after the upgrade: every token answer is still byte for byte the same,
//   and a session is held until it agrees, then answers as before again.
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { parseTerms, publishTerms } from "../src/terms.ts";
import { withoutTokenAccount, workspaceStatements } from "../src/workspaces.ts";
import { ORIGIN, send } from "./bundle.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0018_terms.sql";
const NOW = 1_800_000_000_000;

describe("migration 0018", () => {
  it("leaves every answer as it was until terms are published; then tokens answer as before and sessions are held until they agree", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain(NAME);
    const before = files.filter((f) => f < NAME);
    const upTo17 = join(root, "before");
    const upTo18 = join(root, "with");
    await mkdir(upTo17);
    await mkdir(upTo18);
    for (const f of before) await copyFile(join(MIGRATIONS_DIR, f), join(upTo17, f));
    for (const f of [...before, NAME]) await copyFile(join(MIGRATIONS_DIR, f), join(upTo18, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    expect(await migrate(db, upTo17)).toEqual(before);
    const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => NOW };

    const account = async (email: string, username: string, admin: boolean) => {
      const w = await workspaceStatements(deps, username, email);
      // As a site before migration 0025 writes them: the token names no account.
      await db.batch([...withoutTokenAccount(w.stmts), { sql: "UPDATE user SET username = ?, is_admin = ? WHERE id = ?", params: [username, admin ? 1 : 0, w.userId] }]);
      const made = await redeemSignInCode(deps, await createSignInCode(deps, w.userId), null, null);
      if (made === null) throw new Error("the sign-in was refused");
      return { token: w.token, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret), userId: w.userId };
    };
    const admin = await account("owner@example.com", "owner", true);
    const member = await account("member@example.com", "member", false);

    const page = (who: { cookie: string; csrf: string }) => ({ cookie: who.cookie, "x-csrf-token": who.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin" });
    /** Everything both can ask, by token and by session, with its whole answer but the date. */
    const answers = async () => {
      const out: unknown[] = [];
      for (const who of [admin, member]) {
        for (const path of ["/api/v1/me", "/api/v1/tours", "/api/v1/usage", "/api/v1/media?kind=image"]) {
          const r = await send(deps, "GET", path, { token: who.token });
          out.push(["token", path, r.status, r.text, [...r.headers.entries()].filter(([k]) => k !== "date").sort()]);
        }
        for (const path of ["/api/v1/session", "/api/v1/sessions", "/api/v1/tokens", "/api/v1/tours"]) {
          const r = await send(deps, "GET", path, { headers: page(who) });
          out.push(["session", path, r.status, r.text, [...r.headers.entries()].filter(([k]) => k !== "date").sort()]);
        }
      }
      const r = await send(deps, "GET", "/api/v1/admin/accounts", { headers: page(admin) });
      out.push(["admin", r.status]);
      return out;
    };
    const tokenAnswers = async () => (await answers()).filter((a) => Array.isArray(a) && a[0] === "token");

    // This build on the database before 0018: the sessions resolve, and nothing is held.
    const onOld = await answers();
    for (const a of onOld) expect([200], JSON.stringify(a).slice(0, 80)).toContain((a as unknown[])[0] === "admin" ? (a as unknown[])[1] : (a as unknown[])[2]);
    const otherTables = async () => {
      const names = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT LIKE 'terms_%' ORDER BY name")).map((t) => t.name);
      const out: Record<string, unknown[]> = {};
      for (const n of names) out[n] = n === "_migrations" ? [] : await db.all(`SELECT * FROM "${n}" ORDER BY rowid`);
      return out;
    };
    const rowsBefore = await otherTables();

    expect(await migrate(db, upTo18)).toEqual([NAME]);
    expect(await otherTables()).toEqual(rowsBefore);
    expect((await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'terms_%' ORDER BY name")).map((t) => t.name)).toEqual(["terms_agreement", "terms_version", "terms_version_kept", "terms_version_never_deleted"]);
    // A second application stops at its first statement.
    expect(() => db.raw.exec(`BEGIN; ${"CREATE TABLE terms_version (id TEXT);"} ROLLBACK;`)).toThrow(/already exists/);
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");

    // No terms published: every answer as before the migration.
    expect(await answers()).toEqual(onOld);

    // Terms published after the upgrade.
    const read = await parseTerms(new TextEncoder().encode("title: Terms\nversion: 1\nmain points:\n- One.\nterms:\nThe terms.\n"));
    if (!read.ok) throw new Error(read.reason);
    const published = await publishTerms(deps, read);
    if (!published.ok) throw new Error("not published");
    expect(await tokenAnswers()).toEqual(onOld.filter((a) => Array.isArray(a) && a[0] === "token"));
    const held = await answers();
    for (const a of held.filter((x) => Array.isArray(x) && x[0] === "session")) expect((a as unknown[])[2]).toBe(403);
    expect(held.at(-1)).toEqual(["admin", 403]);
    for (const who of [admin, member]) {
      const r = await send(deps, "POST", "/api/v1/terms/agree", { headers: { ...page(who), "content-type": "application/json" }, body: JSON.stringify({ terms: published.id }) });
      expect(r.status).toBe(204);
    }
    // Agreed: the token answers as before, the sessions answer as before but for the session's
    // own answer, which now names the agreement.
    const after = await answers();
    const withoutSession = (list: unknown[]) => list.filter((a) => !(Array.isArray(a) && a[1] === "/api/v1/session"));
    expect(withoutSession(after)).toEqual(withoutSession(onOld));
    const session = await send(deps, "GET", "/api/v1/session", { headers: page(member) });
    expect(session.json.terms_agreed).toEqual({ version: "1", agreed_at: NOW });
    db.close();
  });
});
