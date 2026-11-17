import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { D1Db } from "../src/cloudflare/db.ts";
import { R2FileStore } from "../src/cloudflare/files.ts";
import type { Config, Deps } from "../src/ports.ts";
import { counted } from "./counting.ts";

type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] };
const testEnv = env as TestEnv;

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
