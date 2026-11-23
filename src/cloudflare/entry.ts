import { createApp } from "../app.ts";
import { billingFromSettings, type BillingSettings } from "../billing-rules.ts";
import { billingAddressProblem } from "../billing.ts";
import { stripeOverFetch } from "../stripe.ts";
import { mediaLimitsProblem } from "../limits.ts";
import { withBudget } from "../budget.ts";
import { setClientAddress } from "../client.ts";
import { downloadUrlSetting, homeUrlSetting } from "../https-address.ts";
import { DEFAULT_LIFETIMES, LIFETIME_SETTINGS, lifetimesSetting, sameLifetimes, type LifetimeSetting } from "../lifetimes.ts";
import { HOST_ROLES, hostSettingsFrom, normaliseHost, resolveHosts, settingOf, type Hosts, type HostsResult } from "../hosts.ts";
import { DEFER_FAILED, type Deps } from "../ports.ts";
import { setupCodeFromEnv } from "../setup.ts";
import { allowanceFromSetting } from "../usage.ts";
import { D1Db } from "./db.ts";
import { R2FileStore } from "./files.ts";

/**
 * SETUP_CODE is a Worker secret, so `wrangler types` does not list it. Nor does it list
 * STORAGE_ALLOWANCE_BYTES, a var only an install that wants a limit adds to its own file,
 * or SITE_HOST, a var only a one-address install that wants sign-in links adds, or
 * IMG_HOST, the optional third address an install with two addresses may add, or
 * DOWNLOAD_URL, the address of the desktop app's download page an install may add, or
 * HOME_URL, the site's home page the brand links to, which an install may add, or
 * the three sign-in lifetimes, SESSION_MAX_DAYS, CONNECTION_IDLE_DAYS and
 * CONNECTION_MAX_DAYS (src/lifetimes.ts), which an install may add to change a default, nor
 * the four billing settings (src/billing-rules.ts): STRIPE_API_KEY and STRIPE_WEBHOOK_SECRET
 * as secrets, STRIPE_PRICE_ID and STRIPE_PUBLISHABLE_KEY as vars, only on an install that bills.
 */
type WorkerEnv = Env & { SETUP_CODE?: string; STORAGE_ALLOWANCE_BYTES?: unknown; SITE_HOST?: unknown; INVITE_CONTACT?: unknown; IMG_HOST?: unknown; DOWNLOAD_URL?: unknown; HOME_URL?: unknown; STRIPE_API_KEY?: unknown; STRIPE_WEBHOOK_SECRET?: unknown; STRIPE_PRICE_ID?: unknown; STRIPE_PUBLISHABLE_KEY?: unknown } & Partial<Record<LifetimeSetting, unknown>>;

/**
 * Who to ask for an invite, from the Worker's var INVITE_CONTACT, trimmed, or null when it
 * is unset, empty or not text. It is passed on as written: the sign-in page checks it and
 * leaves out a value it cannot use, so no value closes any path.
 */
export function inviteContactFromWorkerEnv(env: { INVITE_CONTACT?: unknown }): string | null {
  if (typeof env.INVITE_CONTACT !== "string") return null;
  const text = env.INVITE_CONTACT.trim();
  return text === "" ? null : text;
}

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
 * The addresses from the Worker's vars: TOURS_HOST and APP_HOST, and beside them the
 * optional IMG_HOST (every `<ROLE>_HOST` of HOST_ROLES). All empty or unset is one-address
 * mode; addresses that cannot be used give their problem, a fixed line that names the vars
 * and never repeats a value. A var that is present but is not text (a JSON var, or a
 * binding given that name) is a value that cannot be used, never an unset one: reading it
 * as unset could quietly turn two addresses into one.
 */
export function hostsFromWorkerEnv(env: { TOURS_HOST?: unknown; APP_HOST?: unknown; IMG_HOST?: unknown }): HostsResult {
  const vars = hostSettingsFrom<unknown>(env);
  for (const role of HOST_ROLES) {
    const value = vars[role];
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, problem: `${settingOf(role)} is not a host name. Write it like ${role}.example.com, without https:// and without a path.` };
    }
  }
  return resolveHosts(vars as Partial<Record<(typeof HOST_ROLES)[number], string>>);
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
  billing: BillingSettings | null = null,
): Deps {
  const siteHost = siteHostFromWorkerEnv(env, hosts);
  const inviteContact = inviteContactFromWorkerEnv(env);
  // A var that is not text, or not a usable address, is left out (downloadUrlSetting).
  const downloadUrl = downloadUrlSetting(env.DOWNLOAD_URL).url;
  // The site's home page: a var that is not text, or not a usable address, is left out (homeUrlSetting).
  const homeUrl = homeUrlSetting(env.HOME_URL).url;
  // The sign-in lifetimes: a var that cannot be used is its default (lifetimesSetting).
  const { lifetimes } = lifetimesSetting(lifetimeVars(env));
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
      ...(inviteContact === null ? {} : { inviteContact }),
      ...(downloadUrl === null ? {} : { downloadUrl }),
      ...(homeUrl === null ? {} : { homeUrl }),
      ...(sameLifetimes(lifetimes, DEFAULT_LIFETIMES) ? {} : { lifetimes }),
      ...(billing === null ? {} : { billing }),
    },
    now: () => Date.now(),
    ...(billing === null ? {} : { stripe: stripeOverFetch(billing.apiKey) }),
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

/** The billing settings from the Worker's secrets and vars (billingFromSettings): all four, or billing is off. */
export function billingFromWorkerEnv(env: { STRIPE_API_KEY?: unknown; STRIPE_WEBHOOK_SECRET?: unknown; STRIPE_PRICE_ID?: unknown; STRIPE_PUBLISHABLE_KEY?: unknown }): ReturnType<typeof billingFromSettings> {
  return billingFromSettings({ STRIPE_API_KEY: env.STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID: env.STRIPE_PRICE_ID, STRIPE_PUBLISHABLE_KEY: env.STRIPE_PUBLISHABLE_KEY });
}

/** Whether this isolate has said the line for a DOWNLOAD_URL that cannot be used. */
let downloadSaid = false;
/** Whether this isolate has said the line for a HOME_URL that cannot be used. */
let homeSaid = false;
/** Whether this isolate has said the lines for the sign-in lifetimes that cannot be used. */
let lifetimesSaid = false;

/** The three sign-in lifetime vars of the env, by name. */
function lifetimeVars(env: Partial<Record<LifetimeSetting, unknown>>): Partial<Record<LifetimeSetting, unknown>> {
  return Object.fromEntries(LIFETIME_SETTINGS.map((name) => [name, env[name]]));
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
    // The same for billing settings of the wrong shape: the line names the setting, never its value.
    const billing = billingFromWorkerEnv(env);
    if (!billing.ok) {
      console.error(billing.problem);
      return misconfigured();
    }
    // The client address, for rate limits only: the connecting address as Cloudflare gives
    // it, which a visitor cannot set. No other header is read for it, and it is kept only
    // when it is one bare IP address (setClientAddress checks); else it is unknown.
    setClientAddress(request, request.headers.get("cf-connecting-ip"));
    // A download page that cannot be used closes nothing: the link is left out, and its
    // one fixed line, which holds no value, is written once for the life of the isolate.
    if (!downloadSaid) {
      const download = downloadUrlSetting(env.DOWNLOAD_URL);
      if (download.problem !== null) {
        downloadSaid = true;
        console.error(download.problem);
      }
    }
    // Nor does a home page that cannot be used: the logo is no link, and its one fixed
    // line, which holds no value, is written once for the life of the isolate.
    if (!homeSaid) {
      const home = homeUrlSetting(env.HOME_URL);
      if (home.problem !== null) {
        homeSaid = true;
        console.error(home.problem);
      }
    }
    // Nor do sign-in lifetimes that cannot be used: each is its default, and its one fixed
    // line, which holds no value, is written once for the life of the isolate.
    if (!lifetimesSaid) {
      lifetimesSaid = true;
      for (const line of lifetimesSetting(lifetimeVars(env)).problems) console.error(line);
    }
    // Each request gets its own metered ports, so one that goes over the call budget is logged.
    const defers = typeof (ctx as { waitUntil?: unknown } | undefined)?.waitUntil === "function" ? ctx : undefined;
    const deps = depsFromEnv(env, hosts.hosts, allowance.bytes, defers, billing.billing);
    // With billing on, Stripe's return address must be the site's own https address.
    const address = billingAddressProblem(deps.config);
    if (address !== null) {
      console.error(address);
      return misconfigured();
    }
    // And limits of shared items that would need more parts than an item may have.
    const media = mediaLimitsProblem(deps.config);
    if (media !== null) {
      console.error(media);
      return misconfigured();
    }
    return withBudget(deps, request.method, async (metered) => createApp(metered).fetch(request, env, ctx));
  },
} satisfies ExportedHandler<WorkerEnv>;
