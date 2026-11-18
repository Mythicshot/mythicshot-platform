// The per-request call budget. Cloudflare's free plan lets one Worker request make at
// most 50 subrequests, and every call to D1 or R2 counts as one
// (https://developers.cloudflare.com/workers/platform/limits/). The local runtime does
// not enforce that, so the app counts its own calls: every route is written to stay at
// or under SUBREQUEST_BUDGET in its worst case, leaving headroom under the real limit,
// and the shared test suite checks every request it sends against it.
//
// How each kind of call is counted, and why:
// - Db.all, Db.first, Db.run: one each. Each is one D1 query, one subrequest.
// - Db.batch: one, however many statements it holds. D1 sends a batch as one call, and its
//   limits page says a batch counts as a single query against the per-invocation limit
//   (https://developers.cloudflare.com/d1/platform/limits/).
// - FileStore.get, FileStore.put: one each. Each is one R2 operation.
// - FileStore.delete: one per 1,000 keys, the most one R2 delete call takes. The app never
//   passes more than 1,000 keys at once, so in practice one.
// Reading an object's body after get is the same subrequest, not another.
import type { Db, Deps, FileStore } from "./ports.ts";

/** The real limit on Cloudflare's free plan: subrequests per request. */
export const FREE_PLAN_SUBREQUESTS = 50;
/** What every route stays at or under, leaving headroom under FREE_PLAN_SUBREQUESTS. */
export const SUBREQUEST_BUDGET = 40;
/** Keys one R2 delete call takes. */
const DELETE_KEYS_PER_CALL = 1000;

export type Meter = { deps: Deps; calls: () => number };

/**
 * Wraps the ports of `deps` so every call through them is counted as described above.
 * Each method looks the target up at call time, so a test that swaps a method on the
 * underlying deps is still seen.
 */
export function metered(deps: Deps): Meter {
  let n = 0;
  const db: Db = {
    all: (sql, params) => (n++, deps.db.all(sql, params)),
    first: (sql, params) => (n++, deps.db.first(sql, params)),
    run: (sql, params) => (n++, deps.db.run(sql, params)),
    batch: (stmts) => (n++, deps.db.batch(stmts)),
  };
  const store = (pick: () => FileStore): FileStore => ({
    put: (key, body, meta) => (n++, pick().put(key, body, meta)),
    get: (key) => (n++, pick().get(key)),
    delete: (keys) => ((n += Math.max(1, Math.ceil(keys.length / DELETE_KEYS_PER_CALL))), pick().delete(keys)),
  });
  return {
    deps: {
      db,
      drafts: store(() => deps.drafts),
      pub: store(() => deps.pub),
      get config() {
        return deps.config;
      },
      now: () => deps.now(),
    },
    calls: () => n,
  };
}

/**
 * Runs one request on metered deps and logs a fixed line when it went over the budget.
 * Nothing from the request is logged but its method, so no token or id can leak.
 */
export async function withBudget(deps: Deps, method: string, handle: (deps: Deps) => Promise<Response>): Promise<Response> {
  const m = metered(deps);
  try {
    return await handle(m.deps);
  } finally {
    if (m.calls() > SUBREQUEST_BUDGET) console.error(`budget: a ${method} request made ${m.calls()} storage and database calls, over the budget of ${SUBREQUEST_BUDGET}`);
  }
}
