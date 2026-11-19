import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { D1Db } from "../src/cloudflare/db.ts";
import { R2FileStore } from "../src/cloudflare/files.ts";
import { DEFER_FAILED, deferTracker, type Config, type Deps } from "../src/ports.ts";
import { newId } from "../src/auth.ts";
import { createWorkspace, workspaceStatements } from "../src/workspaces.ts";
import { counted } from "./counting.ts";
import { FakeMailer } from "./fake-mail.ts";

type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[]; TEST_STORAGE_IS_LOCAL?: unknown };
const testEnv = env as TestEnv;

/**
 * reset() drops every table and deletes every object. Pointed at real bindings that
 * would destroy an install's data, so it runs only when vitest.cloudflare.config.ts
 * has switched remote bindings off, found no `remote` setting in wrangler.jsonc and
 * handed over this marker. Anything else, including a missing marker, refuses.
 */
function assertLocalStorage(): void {
  if (testEnv.TEST_STORAGE_IS_LOCAL !== "local-simulated-storage") {
    throw new Error("refusing to reset storage: the bindings are not known to be the local simulated ones");
  }
}

/** Every key in a test bucket. Test-only: app code never lists a bucket. */
async function listAll(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/** Empties the test database and buckets, then applies the migrations from scratch. */
async function reset(): Promise<void> {
  assertLocalStorage();
  for (const bucket of [testEnv.DRAFTS, testEnv.PUB]) {
    const keys = await listAll(bucket);
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
  }
  const tables = await testEnv.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'",
  ).all<{ name: string }>();
  if (tables.results.length > 0) {
    await testEnv.DB.batch([
      testEnv.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      ...tables.results.map((t) => testEnv.DB.prepare(`DROP TABLE "${t.name.replaceAll('"', '""')}"`)),
    ]);
  }
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
}

/** Deps on the test D1 database and R2 buckets, emptied and migrated. */
export async function makeDeps(config?: Partial<Config>) {
  await reset();
  const c = counted(new D1Db(testEnv.DB), new R2FileStore(testEnv.DRAFTS), new R2FileStore(testEnv.PUB));
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
    draftKeys: () => listAll(testEnv.DRAFTS),
    publicKeys: () => listAll(testEnv.PUB),
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
