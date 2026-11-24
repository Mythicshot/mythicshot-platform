import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Config, Deps } from "../src/ports.ts";
import { newId } from "../src/auth.ts";
import { createWorkspace, workspaceStatements } from "../src/workspaces.ts";
import { background as trackBackground, checkAtEndOfTest } from "./background.ts";
import { counted } from "./counting.ts";
import { FakeMailer } from "./fake-mail.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * `mail: false` gives deps with mail off exactly as a live site has it: no `deps.mail` at
 * all, so `mailOf` gives the mailer that is off. By default the deps carry the fake mailer.
 */
export type MakeOptions = { mail?: boolean };

/** The database under each deps makeDeps made, uncounted, for makeDepsBefore's runner. */
const rawDbOf = new WeakMap<Deps, NodeDb>();

/** A fresh database file and two empty folders in a new temporary directory. */
export async function makeDeps(config?: Partial<Config>, opts: MakeOptions = {}, keep?: (name: string) => boolean) {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-test-"));
  const db = new NodeDb(join(root, "db.sqlite"));
  if (keep === undefined) {
    await migrate(db, MIGRATIONS_DIR);
  } else {
    const some = join(root, "migrations");
    await mkdir(some);
    for (const f of await readdir(MIGRATIONS_DIR)) if (f.endsWith(".sql") && keep(f)) await copyFile(join(MIGRATIONS_DIR, f), join(some, f));
    await migrate(db, some);
  }
  const drafts = new NodeFileStore(join(root, "drafts"));
  const pub = new NodeFileStore(join(root, "public"));
  const c = counted(db, drafts, pub);
  const mail = new FakeMailer();
  const background = trackBackground();
  const deps: Deps = {
    db: c.db,
    drafts: c.drafts,
    pub: c.pub,
    config: { publicImageBase: "", setupCode: null, ...config },
    now: () => Date.now(),
    ...(opts.mail === false ? {} : { mail }),
    defer: background.defer,
  };
  rawDbOf.set(deps, db);
  // The test that made these deps fails if it ends with deferred work still running.
  checkAtEndOfTest(background);
  return {
    deps,
    /**
     * The mailer of these deps: it keeps every mail it is handed and contacts nothing. Not
     * counted in `calls`. With `mail: false` the deps carry no mailer and this one stays empty.
     */
    mail,
    /** Resolves when all work deferred so far has ended. A failure of that work is the fixed line, as on a real target. */
    settle: () => background.settle(),
    draftKeys: () => drafts.keys(),
    publicKeys: () => pub.keys(),
    calls: c.calls,
  };
}

/**
 * Deps as makeDeps gives them, on a database that has only the migrations `keep` takes, as a
 * site that has not applied the others yet. `migrate()` then applies the rest with this
 * target's own runner (src/node/migrate.ts: every file whose name is not on record, in name
 * order) and answers what it applied.
 */
export async function makeDepsBefore(keep: (name: string) => boolean, config?: Partial<Config>, opts: MakeOptions = {}) {
  const made = await makeDeps(config, opts, keep);
  const raw = rawDbOf.get(made.deps)!;
  const applied = async () => (await raw.all<{ name: string }>("SELECT name FROM _migrations ORDER BY applied_at, rowid")).map((r) => r.name);
  return { ...made, applied, migrate: () => migrate(raw, MIGRATIONS_DIR) };
}

/**
 * A workspace with its owner and one token, made through createWorkspace. Each owner
 * gets a fresh address, since an email belongs to one user only.
 */
export async function seedWorkspace(deps: Deps, name: string): Promise<{ workspaceId: string; token: string }> {
  return createWorkspace(deps, name, `owner-${newId("usr").slice(4)}@example.com`);
}

/**
 * An account with its own workspace and one token, made as a new workspace makes them,
 * with the username and the admin flag asked for in the same batch. Without options: no
 * username and no admin, which is what the owner of a new workspace is. Each account
 * gets a fresh address. The username is stored as given: the database checks its shape,
 * not whether it is reserved.
 */
export async function seedAccount(
  deps: Deps,
  opts: { username?: string; admin?: boolean } = {},
): Promise<{ workspaceId: string; userId: string; token: string; email: string }> {
  const email = `account-${newId("usr").slice(4)}@example.com`;
  const { workspaceId, userId, token, stmts } = await workspaceStatements(deps, "Account", email);
  await deps.db.batch([
    ...stmts,
    { sql: "UPDATE user SET username = ?, is_admin = ? WHERE id = ?", params: [opts.username ?? null, opts.admin === true ? 1 : 0, userId] },
  ]);
  return { workspaceId, userId, token, email };
}
