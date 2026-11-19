import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import { DEFER_FAILED, deferTracker, type Config, type Deps } from "../src/ports.ts";
import { newId } from "../src/auth.ts";
import { createWorkspace, workspaceStatements } from "../src/workspaces.ts";
import { counted } from "./counting.ts";
import { FakeMailer } from "./fake-mail.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** A fresh database file and two empty folders in a new temporary directory. */
export async function makeDeps(config?: Partial<Config>) {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-test-"));
  const db = new NodeDb(join(root, "db.sqlite"));
  await migrate(db, MIGRATIONS_DIR);
  const drafts = new NodeFileStore(join(root, "drafts"));
  const pub = new NodeFileStore(join(root, "public"));
  const c = counted(db, drafts, pub);
  const mail = new FakeMailer();
  const background = deferTracker(() => console.error(DEFER_FAILED));
  const deps: Deps = {
    db: c.db,
    drafts: c.drafts,
    pub: c.pub,
    config: { publicImageBase: "", setupCode: null, ...config },
    now: () => Date.now(),
    mail,
    defer: background.defer,
  };
  return {
    deps,
    /** The mailer of these deps: it keeps every mail it is handed and contacts nothing. Not counted in `calls`. */
    mail,
    /** Resolves when all work deferred so far has ended. A failure of that work is the fixed line, as on a real target. */
    settle: () => background.settle(),
    draftKeys: () => drafts.keys(),
    publicKeys: () => pub.keys(),
    calls: c.calls,
  };
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
