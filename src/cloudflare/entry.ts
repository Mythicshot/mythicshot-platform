import { createApp } from "../app.ts";
import { withBudget } from "../budget.ts";
import { setClientAddress } from "../client.ts";
import { HOST_ROLES, normaliseHost, resolveHosts, type Hosts, type HostsResult } from "../hosts.ts";
import { DEFER_FAILED, type Deps } from "../ports.ts";
import { setupCodeFromEnv } from "../setup.ts";
import { allowanceFromSetting } from "../usage.ts";
import { D1Db } from "./db.ts";
import { R2FileStore } from "./files.ts";

/**
 * SETUP_CODE is a Worker secret, so `wrangler types` does not list it. Nor does it list
 * STORAGE_ALLOWANCE_BYTES, a var only an install that wants a limit adds to its own file,
 * or SITE_HOST, a var only a one-address install that wants sign-in links adds.
 */
type WorkerEnv = Env & { SETUP_CODE?: string; STORAGE_ALLOWANCE_BYTES?: unknown; SITE_HOST?: unknown };

/**
 * The host name sign-in links use on a one-address install, from the Worker's var
 * SITE_HOST, or null. With two addresses it is ignored: links then use the app address.
 * Unset, empty, not text or not a host name is null and nothing else: it is used for
 * links only, so a value that cannot be used closes no path, and this target sends no
 * mail in this phase, so there is nothing to say about it either.
 */
export function siteHostFromWorkerEnv(env: { SITE_HOST?: unknown }, hosts: Hosts | null): string | null {
  if (hosts !== null || typeof env.SITE_HOST !== "string") return null;
  return normaliseHost(env.SITE_HOST);
}

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
 *
 * The deps carry no mailer: this target sends no mail in this phase, whatever mail
 * settings its vars hold, so mail is off. `ctx` is the request's context: with it,
 * deferred work is handed to the runtime (`waitUntil`), which keeps the Worker alive
 * until the work ends; a failure of that work is one fixed line.
 */
export function depsFromEnv(
  env: WorkerEnv,
  hosts: Hosts | null,
  storageAllowanceBytes: number | null = null,
  ctx?: { waitUntil(work: Promise<unknown>): void },
): Deps {
  const siteHost = siteHostFromWorkerEnv(env, hosts);
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
      ...(siteHost === null ? {} : { siteHost }),
    },
    now: () => Date.now(),
    ...(ctx === undefined
      ? {}
      : {
          defer: (work: Promise<unknown>) => {
            // What the runtime waits for never rejects, and nothing of a failure is written.
            ctx.waitUntil(Promise.resolve(work).catch(() => console.error(DEFER_FAILED)));
          },
        }),
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
    // The client address, for rate limits only: the connecting address as Cloudflare gives
    // it, which a visitor cannot set. No other header is read for it.
    setClientAddress(request, request.headers.get("cf-connecting-ip"));
    // Each request gets its own metered ports, so one that goes over the call budget is logged.
    const defers = typeof (ctx as { waitUntil?: unknown } | undefined)?.waitUntil === "function" ? ctx : undefined;
    return withBudget(depsFromEnv(env, hosts.hosts, allowance.bytes, defers), request.method, async (deps) => createApp(deps).fetch(request, env, ctx));
  },
} satisfies ExportedHandler<WorkerEnv>;
