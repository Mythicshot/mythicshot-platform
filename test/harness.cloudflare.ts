import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { D1Db } from "../src/cloudflare/db.ts";
import { R2FileStore } from "../src/cloudflare/files.ts";
import type { Config, Deps } from "../src/ports.ts";
import { newId } from "../src/auth.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { counted } from "./counting.ts";

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
  const deps: Deps = {
    db: c.db,
    drafts: c.drafts,
    pub: c.pub,
    config: { publicImageBase: "", setupCode: null, ...config },
    now: () => Date.now(),
  };
  return {
    deps,
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
