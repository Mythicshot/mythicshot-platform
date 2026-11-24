// A fake Stripe for the billing tests: it keeps every call, answers the handful of requests the
// platform makes from objects a test puts in it, and reaches no network. Every value in here is
// an obviously fake one (rk_test_FAKE, whsec_FAKE, price_FAKE, pk_test_FAKE).
import type { BillingSettings } from "../src/billing-rules.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import type { Deps } from "../src/ports.ts";
import type { Stripe, StripeAnswer, StripeForm } from "../src/stripe.ts";
import { ORIGIN, send, type Call } from "./bundle.ts";

export const BILLING: BillingSettings = { apiKey: "rk_test_FAKE", webhookSecret: "whsec_FAKE", priceId: "price_FAKE", publishableKey: "pk_test_FAKE" };

/** The config of a site with billing switched on (the route table's tests build their app from it). */
export const BILLING_CONFIG = { publicImageBase: "", setupCode: null, siteHost: "tours.example.com", billing: BILLING };

/** Billing's nine routes, which exist only with the settings. */
export const BILLING_ROUTE_KEYS = [
  "GET /api/v1/billing",
  "POST /api/v1/billing/checkout",
  "POST /api/v1/billing/portal",
  "POST /api/v1/billing/webhook",
  "GET /billing/subscribe",
  "GET /dash/billing-subscribe.js",
  "GET /billing/return",
  "GET /dash/billing-return.js",
  "GET /dash/billing.js",
] as const;

type Json = Record<string, any>;

// ---- Values of the shapes Stripe really sends (from the owner's sandbox run, 0.1.59) ----

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** `n` letters and digits, the same for the same seed. */
function letters(seed: string, n: number): string {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ i, 16777619) >>> 0;
    out += BASE62[h % 62];
  }
  return out;
}

/** The fake's nth checkout: 66 characters, cs_test_ and letters and digits, as Stripe makes them. */
export function CS(n: number): string {
  return "cs_test_a1" + letters(`cs${n}`, 56);
}

/**
 * The client secret of the fake's nth checkout: about 468 characters, the checkout's id,
 * `_secret_`, then letters, digits, underscores and percent-encoded bytes (%2F, %2B, %3D), as
 * Stripe's embedded checkout really answers it.
 */
export function SECRET(n: number): string {
  const id = CS(n);
  let tail = "";
  for (let i = 0; tail.length < 468 - id.length - 8; i++) tail += letters(`sec${n}_${i}`, 9) + ["%2F", "%2B", "%3D", "_", "%7C"][i % 5];
  return `${id}_secret_${tail}`.slice(0, 468);
}

/** Ids of the shapes Stripe really sends, for tests that want them. */
export const REAL = {
  subscription: "sub_1Uf7540x7W4K5JLaCkq7gjtQ",
  customer: "cus_VgU3x5KqziV0vO",
  invoice: "in_1Uf7510x7W4K5JLaoJ0fhNLs",
  paymentMethod: "pm_1Uf74z0x7W4K5JLaQm3dLs8T",
  paymentIntent: "pi_3Uf7520x7W4K5JLa1n6RkC2d",
  charge: "ch_3Uf7520x7W4K5JLa1q4EwP0m",
} as const;
export type StripeCall = { method: string; path: string; form: [string, string][] | null; key: string | undefined };

export class FakeStripe implements Stripe {
  calls: StripeCall[] = [];
  subscriptions = new Map<string, Json>();
  sessions = new Map<string, Json>();
  charges = new Map<string, Json>();
  /** Every call throws, as when Stripe cannot be reached. */
  down = false;
  /** How GET /v1/prices/<id> answers: the price, no such price, or a key that may not read prices. */
  price: "ok" | "missing" | "forbidden" = "ok";
  /** Paths answered 500. */
  failing = new Set<string>();
  /**
   * Runs after an answer is made and before it is returned, so a test can make something else
   * happen in between, deterministically (another notice, Stripe changing its mind).
   */
  hook: ((call: StripeCall, answer: StripeAnswer) => Promise<void>) | null = null;
  /** The clock Stripe's Date header is written from (withBilling gives it the deps' own), and how far Stripe's clock is off it. */
  clock: () => number = () => Date.now();
  skewMs = 0;
  private byKey = new Map<string, StripeAnswer>();
  private n = 0;

  async call(method: "GET" | "POST" | "DELETE", path: string, form?: StripeForm, key?: string): Promise<StripeAnswer> {
    const call: StripeCall = { method, path, form: form === undefined ? null : form.map(([k, v]) => [k, v] as [string, string]), key };
    this.calls.push(call);
    if (this.down) throw new Error("stripe: unreachable");
    const answer = { ...this.answer(method, path, form, key), date: new Date(this.clock() + this.skewMs).toUTCString() };
    if (this.hook !== null) await this.hook(call, answer);
    return answer;
  }

  private answer(method: string, path: string, form?: StripeForm, key?: string): StripeAnswer {
    if (this.failing.has(path)) return { status: 500, body: { error: { type: "api_error" } } };
    const parts = path.split("/");
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (key !== undefined && this.byKey.has(key)) return this.byKey.get(key)!;
      this.n += 1;
      const id = CS(this.n);
      const session: Json = { id, object: "checkout.session", status: "open", client_secret: SECRET(this.n), url: null, form: Object.fromEntries(form ?? []), noSecret: false };
      this.sessions.set(id, session);
      // As Stripe answers an embedded checkout under Managed Payments.
      const answer = { status: 200, body: { id, object: "checkout.session", status: "open", ui_mode: "embedded_page", managed_payments: { enabled: true }, mode: "subscription", client_secret: session.client_secret, url: null, expires_at: Number(session.form.expires_at ?? 0), return_url: session.form.return_url ?? null } };
      if (key !== undefined) this.byKey.set(key, answer);
      return answer;
    }
    if (method === "GET" && parts[2] === "checkout" && parts[3] === "sessions" && parts.length === 5) {
      const s = this.sessions.get(parts[4]);
      return s === undefined
        ? { status: 404, body: { error: { code: "resource_missing" } } }
        : { status: 200, body: { id: s.id, object: "checkout.session", ui_mode: "embedded_page", managed_payments: { enabled: true }, status: s.status, client_secret: s.status === "open" && !s.noSecret ? s.client_secret : null, customer: s.customer ?? null, subscription: s.subscription ?? null, client_reference_id: s.form?.client_reference_id ?? null } };
    }
    if (method === "POST" && parts[3] === "sessions" && parts[5] === "expire") {
      const s = this.sessions.get(parts[4]);
      if (s === undefined) return { status: 404, body: { error: { code: "resource_missing" } } };
      if (s.status !== "open") return { status: 400, body: { error: { type: "invalid_request_error" } } };
      s.status = "expired";
      return { status: 200, body: { id: parts[4], status: "expired" } };
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") return { status: 200, body: { id: "bps_1Uf75j0x7W4K5JLaW1rD2Mbc", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/test_YWNjdF8xVWY3NTQweDdXNEs1SkxhLF9UZmZ0QjNjS0FQZQ0100ZJ1kW5aT" } };
    if (method === "GET" && parts[2] === "prices") {
      if (this.price === "missing" || parts[3] !== BILLING.priceId) return { status: 404, body: { error: { code: "resource_missing", type: "invalid_request_error" } } };
      if (this.price === "forbidden") return { status: 403, body: { error: { type: "invalid_request_error", code: "secret_key_required" } } };
      return { status: 200, body: { id: parts[3], object: "price", active: true, recurring: { interval: "month" } } };
    }
    if (method === "GET" && parts[2] === "subscriptions") {
      const s = this.subscriptions.get(parts[3]);
      return s === undefined ? { status: 404, body: { error: { code: "resource_missing" } } } : { status: 200, body: s };
    }
    if (method === "DELETE" && parts[2] === "subscriptions") {
      const s = this.subscriptions.get(parts[3]);
      if (s === undefined) return { status: 404, body: { error: { code: "resource_missing" } } };
      s.status = "canceled";
      s.ended_at = s.ended_at ?? 1_800_000_000;
      return { status: 200, body: s };
    }
    if (method === "GET" && parts[2] === "charges") {
      const c = this.charges.get(parts[3]);
      return c === undefined ? { status: 404, body: { error: { code: "resource_missing" } } } : { status: 200, body: c };
    }
    return { status: 404, body: { error: { code: "resource_missing" } } };
  }

  /** Puts a subscription as Stripe would answer it. Times in seconds, as Stripe gives them. */
  subscription(id: string, customer: string, status: string, more: { periodEnd?: number; cancelAt?: number | null; cancelAtPeriodEnd?: boolean; endedAt?: number | null } = {}): void {
    this.subscriptions.set(id, {
      id,
      object: "subscription",
      customer,
      status,
      cancel_at: more.cancelAt ?? null,
      cancel_at_period_end: more.cancelAtPeriodEnd ?? false,
      canceled_at: more.cancelAt != null ? 1_800_000_000 : null,
      cancellation_details: more.cancelAt != null ? { reason: "cancellation_requested" } : { reason: null },
      ended_at: more.endedAt ?? null,
      // As the sandbox's subscriptions are: Stripe collects the tax (Managed Payments), flexible billing.
      automatic_tax: { enabled: true, liability: { type: "stripe" } },
      billing_mode: { type: "flexible" },
      latest_invoice: REAL.invoice,
      items: { object: "list", data: [{ id: "si_TfftB3cKAPe0Zr", object: "subscription_item", current_period_end: more.periodEnd ?? 1_900_000_000 }] },
    });
  }

  /** Marks a checkout paid at Stripe, as a completed one is. */
  complete(id: string, customer: string, subscription: string): void {
    const s = this.sessions.get(id)!;
    Object.assign(s, { status: "complete", customer, subscription });
  }

  /** The calls to one path. */
  to(path: string): StripeCall[] {
    return this.calls.filter((c) => c.path === path);
  }
}

/** Deps with billing on and a fresh fake Stripe. */
export function withBilling(deps: Deps): FakeStripe {
  const stripe = new FakeStripe();
  // Billing needs the app's own https address for Stripe's return address (never the request's Host).
  const own = (deps.config.hosts ?? null) !== null || typeof deps.config.siteHost === "string" ? {} : { siteHost: "tours.example.com" };
  deps.config = { ...deps.config, ...own, billing: BILLING };
  deps.stripe = stripe;
  stripe.clock = () => deps.now();
  return stripe;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The v1 signature Stripe would send for this body at time `t` (seconds). */
export async function v1Of(secret: string, t: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
}

let eventN = 0;
/** A Stripe event of this type around this object, with a fresh id unless one is given. */
export function eventOf(type: string, object: Json, id?: string): Json {
  eventN += 1;
  // 28 characters, evt_1 and letters and digits, as Stripe's event ids are.
  return { id: id ?? `evt_1Uf7${letters(`evt${Date.now()}_${eventN}`, 20)}`, object: "event", api_version: "2026-04-22.dahlia", type, data: { object } };
}

/** Sends a notice to the listener, signed with the fake secret at `deps.now()` unless told otherwise. */
export async function notify(deps: Deps, event: Json | string, opts: { header?: string; t?: number; secret?: string } = {}): Promise<Call> {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  const t = opts.t ?? Math.floor(deps.now() / 1000);
  const header = opts.header ?? `t=${t},v1=${await v1Of(opts.secret ?? BILLING.webhookSecret, t, body)}`;
  return send(deps, "POST", "/api/v1/billing/webhook", { body, headers: { "content-type": "application/json", "stripe-signature": header } });
}

/** A signed-in session of this account, as the site's own page sends a request. */
export async function sessionOf(deps: Deps, userId: string): Promise<{ headers: Record<string, string>; secret: string }> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("no session");
  return { secret: made.secret, headers: { cookie: `${SESSION_COOKIE}=${made.secret}`, "x-csrf-token": await csrfFor(made.secret), origin: ORIGIN, "sec-fetch-site": "same-origin" } };
}
