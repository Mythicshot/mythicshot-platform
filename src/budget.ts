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
// - Mailer.send: one. A mail handed to a mail API is one subrequest on Cloudflare, and it
//   is counted the same on the Node target, where it is one connection to a mail server.
// Reading an object's body after get is the same subrequest, not another.
// Deferring work (Deps.defer) is not a call; what the work does through these ports is
// counted like anything else, also when it happens after the answer was given.
import type { Mailer } from "./mail.ts";
import { deferOf, mailOf, type Db, type Deps, type FileStore } from "./ports.ts";

/** The real limit on Cloudflare's free plan: subrequests per request. */
export const FREE_PLAN_SUBREQUESTS = 50;
/** What every route stays at or under, leaving headroom under FREE_PLAN_SUBREQUESTS. */
export const SUBREQUEST_BUDGET = 40;
/** Keys one R2 delete call takes. */
const DELETE_KEYS_PER_CALL = 1000;

export type Meter = {
  deps: Deps;
  calls: () => number;
  /** How many pieces of work deferred through these deps are still running. */
  open: () => number;
  /** Resolves when no work deferred through these deps is running any more. Never rejects. */
  idle: () => Promise<void>;
};

/**
 * Wraps the ports of `deps` so every call through them is counted as described above.
 * Each method looks the target up at call time, so a test that swaps a method on the
 * underlying deps is still seen.
 *
 * Work deferred through the metered deps goes to the target as before, and the meter
 * knows while it runs: its calls are counted like any other, `open` and `idle` tell when
 * it has ended, and `onIdle` is called each time the last piece of it ends, before the
 * target sees that piece end (so on Cloudflare still inside what the runtime waits for).
 */
export function metered(deps: Deps, onIdle?: () => void): Meter {
  let n = 0;
  let open = 0;
  let waiting: (() => void)[] = [];
  const ended = () => {
    open -= 1;
    if (open > 0) return;
    const woken = waiting;
    waiting = [];
    for (const wake of woken) wake();
    onIdle?.();
  };
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
  const mail: Mailer = { send: (m) => (n++, mailOf(deps).send(m)) };
  return {
    deps: {
      db,
      drafts: store(() => deps.drafts),
      pub: store(() => deps.pub),
      get config() {
        return deps.config;
      },
      now: () => deps.now(),
      // Looked up at call time too. A site without a mailer has none here either, so
      // mailOf says "off" on metered deps exactly as on the deps they wrap.
      get mail() {
        return deps.mail === undefined ? undefined : mail;
      },
      defer: (work) => {
        open += 1;
        // The target gets the work with its own outcome, a failure included; the meter
        // only notes that it ended.
        deferOf(deps)(Promise.resolve(work).finally(ended));
      },
    },
    calls: () => n,
    open: () => open,
    idle: () => (open === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve))),
  };
}

/**
 * Runs one request on metered deps and logs a fixed line when it went over the budget.
 * Nothing from the request is logged but its method, so no token or id can leak.
 *
 * The count is looked at when the handler has returned, and again whenever the work the
 * request deferred has all ended, so calls made after the answer are held to the same
 * budget. A request that went over is reported once, at the first look that finds it
 * over, and never again.
 */
export async function withBudget(deps: Deps, method: string, handle: (deps: Deps) => Promise<Response>): Promise<Response> {
  let answered = false;
  let reported = false;
  const look = () => {
    if (!answered || reported || m.calls() <= SUBREQUEST_BUDGET) return;
    reported = true;
    console.error(`budget: a ${method} request made ${m.calls()} storage and database calls, over the budget of ${SUBREQUEST_BUDGET}`);
  };
  const m = metered(deps, look);
  try {
    return await handle(m.deps);
  } finally {
    answered = true;
    look();
  }
}
