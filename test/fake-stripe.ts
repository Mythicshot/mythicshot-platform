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
export const BILLING_CONFIG = { publicImageBase: "", setupCode: null, billing: BILLING };

type Json = Record<string, any>;
export type StripeCall = { method: string; path: string; form: [string, string][] | null; key: string | undefined };

export class FakeStripe implements Stripe {
  calls: StripeCall[] = [];
  subscriptions = new Map<string, Json>();
  sessions = new Map<string, Json>();
  charges = new Map<string, Json>();
  /** Every call throws, as when Stripe cannot be reached. */
  down = false;
  /** Paths answered 500. */
  failing = new Set<string>();
  private byKey = new Map<string, StripeAnswer>();
  private n = 0;

  async call(method: "GET" | "POST", path: string, form?: StripeForm, key?: string): Promise<StripeAnswer> {
    this.calls.push({ method, path, form: form === undefined ? null : form.map(([k, v]) => [k, v] as [string, string]), key });
    if (this.down) throw new Error("stripe: unreachable");
    if (this.failing.has(path)) return { status: 500, body: { error: { type: "api_error" } } };
    const parts = path.split("/");
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (key !== undefined && this.byKey.has(key)) return this.byKey.get(key)!;
      this.n += 1;
      const id = `cs_test_${this.n}`;
      const session = { id, object: "checkout.session", status: "open", client_secret: `${id}_secret_FAKE${this.n}`, url: null, form: Object.fromEntries(form ?? []) };
      this.sessions.set(id, session);
      const answer = { status: 200, body: { id, object: "checkout.session", status: "open", client_secret: session.client_secret, url: null } };
      if (key !== undefined) this.byKey.set(key, answer);
      return answer;
    }
    if (method === "GET" && parts[2] === "checkout" && parts[3] === "sessions" && parts.length === 5) {
      const s = this.sessions.get(parts[4]);
      return s === undefined ? { status: 404, body: { error: { code: "resource_missing" } } } : { status: 200, body: { id: s.id, status: s.status, client_secret: s.status === "open" ? s.client_secret : null } };
    }
    if (method === "POST" && parts[3] === "sessions" && parts[5] === "expire") {
      const s = this.sessions.get(parts[4]);
      if (s !== undefined) s.status = "expired";
      return { status: 200, body: { id: parts[4], status: "expired" } };
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") return { status: 200, body: { id: "bps_FAKE", url: "https://billing.stripe.com/p/session/test_FAKE" } };
    if (method === "GET" && parts[2] === "subscriptions") {
      const s = this.subscriptions.get(parts[3]);
      return s === undefined ? { status: 404, body: { error: { code: "resource_missing" } } } : { status: 200, body: s };
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
      ended_at: more.endedAt ?? null,
      items: { object: "list", data: [{ id: "si_FAKE", current_period_end: more.periodEnd ?? 1_900_000_000 }] },
    });
  }

  /** The calls to one path. */
  to(path: string): StripeCall[] {
    return this.calls.filter((c) => c.path === path);
  }
}

/** Deps with billing on and a fresh fake Stripe. */
export function withBilling(deps: Deps): FakeStripe {
  const stripe = new FakeStripe();
  deps.config = { ...deps.config, billing: BILLING };
  deps.stripe = stripe;
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
  return { id: id ?? `evt_test_${Date.now().toString(36)}_${eventN}`, object: "event", type, data: { object } };
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
