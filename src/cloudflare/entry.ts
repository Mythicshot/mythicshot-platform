import { createApp } from "../app.ts";
import { withBudget } from "../budget.ts";
import { HOST_ROLES, resolveHosts, type Hosts, type HostsResult } from "../hosts.ts";
import type { Deps } from "../ports.ts";
import { setupCodeFromEnv } from "../setup.ts";
import { allowanceFromSetting } from "../usage.ts";
import { D1Db } from "./db.ts";
import { R2FileStore } from "./files.ts";

/**
 * SETUP_CODE is a Worker secret, so `wrangler types` does not list it. Nor does it list
 * STORAGE_ALLOWANCE_BYTES, a var only an install that wants a limit adds to its own file.
 */
type WorkerEnv = Env & { SETUP_CODE?: string; STORAGE_ALLOWANCE_BYTES?: unknown };

/**
 * The two addresses from the Worker's vars, TOURS_HOST and APP_HOST. Both empty or unset
 * is one-address mode; a pair that cannot be used gives its problem, a fixed line that
 * names the vars and never repeats a value. A var that is present but is not text (a JSON
 * var, or a binding given that name) is a value that cannot be used, never an unset one:
 * reading it as unset could quietly turn two addresses into one.
 */
export function hostsFromWorkerEnv(env: { TOURS_HOST?: unknown; APP_HOST?: unknown }): HostsResult {
  const vars = { tours: env.TOURS_HOST, app: env.APP_HOST };
  for (const role of HOST_ROLES) {
    const value = vars[role];
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, problem: `${role.toUpperCase()}_HOST is not a host name. Write it like ${role}.example.com, without https:// and without a path.` };
    }
  }
  return resolveHosts(vars as { tours?: string; app?: string });
}

/**
 * The site's default storage allowance from the Worker's var STORAGE_ALLOWANCE_BYTES:
 * unset or empty is no limit, digits are the limit. A var that is present but is not text
 * (a JSON number, or a binding given that name) is a value that cannot be used, never an
 * unset one: reading it as unset would quietly lift the limit.
 */
export function allowanceFromWorkerEnv(env: { STORAGE_ALLOWANCE_BYTES?: unknown }): ReturnType<typeof allowanceFromSetting> {
  const value = env.STORAGE_ALLOWANCE_BYTES;
  // Any text that is not digits gives the one fixed line, which is all that is wanted here.
  if (value !== undefined && typeof value !== "string") return allowanceFromSetting("not text");
  return allowanceFromSetting(value);
}

/**
 * `hosts` is what hostsFromWorkerEnv gave for this env: both addresses, or null for
 * one-address mode. `storageAllowanceBytes` is what allowanceFromWorkerEnv gave: with
 * null (no limit) the config has no such key, as before the setting existed.
 */
export function depsFromEnv(env: WorkerEnv, hosts: Hosts | null, storageAllowanceBytes: number | null = null): Deps {
  return {
    db: new D1Db(env.DB),
    drafts: new R2FileStore(env.DRAFTS),
    pub: new R2FileStore(env.PUB),
    config: {
      // Empty by default: the app serves published images on /p/<name> through the PUB
      // binding. When set, the public bucket serves them itself on its own custom domain,
      // so the app cannot add headers to them, and that domain MUST carry a response-header
      // rule adding `X-Content-Type-Options: nosniff` and
      // `Content-Security-Policy: default-src 'none'; sandbox` (see wrangler.jsonc).
      publicImageBase: env.PUBLIC_IMAGE_BASE ?? "",
      setupCode: setupCodeFromEnv(env.SETUP_CODE),
      hosts,
      ...(storageAllowanceBytes === null ? {} : { storageAllowanceBytes }),
    },
    now: () => Date.now(),
  };
}

/** The answer to every request while a setting cannot be used. */
function misconfigured(): Response {
  return new Response('{"error":"misconfigured"}', { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    // A Worker cannot refuse to start, so a pair of addresses that cannot be used closes
    // every path instead, health included: serving one address quietly would put what
    // belongs on two addresses on one. No binding is used and nothing of the request or
    // of the values is logged.
    const hosts = hostsFromWorkerEnv(env);
    if (!hosts.ok) {
      console.error(`hosts: ${hosts.problem}`);
      return misconfigured();
    }
    // The same for a storage allowance that cannot be read: serving without it would
    // quietly lift the limit the install asked for.
    const allowance = allowanceFromWorkerEnv(env);
    if (!allowance.ok) {
      console.error(`storage: ${allowance.problem}`);
      return misconfigured();
    }
    // Each request gets its own metered ports, so one that goes over the call budget is logged.
    return withBudget(depsFromEnv(env, hosts.hosts, allowance.bytes), request.method, async (deps) => createApp(deps).fetch(request, env, ctx));
  },
} satisfies ExportedHandler<WorkerEnv>;
