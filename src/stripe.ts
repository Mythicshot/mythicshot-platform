// The one way the platform talks to Stripe: a small client over `fetch`, form-encoded, with
// the key as a Bearer token, a pinned API version and, where asked, an idempotency key. Both
// targets have `fetch`, so nothing here is platform-specific and no package is used. The
// client is injected as `deps.stripe` (src/ports.ts), so tests use a fake and never reach the
// network. It never logs anything and never puts the key in an error: a failure is a thrown
// Error with a fixed message, or an answer with Stripe's status.

/** The Stripe API version every request pins. One constant, easy to change. */
export const STRIPE_API_VERSION = "2026-04-22.dahlia";

/**
 * Stripe's script for the embedded checkout page, loaded by the Subscribe page only, as
 * Stripe's embedded-page guide shows it for the pinned API version. Change it with the version.
 */
export const STRIPE_JS_URL = "https://js.stripe.com/endive/stripe.js";

/** Where the API lives. */
const STRIPE_API = "https://api.stripe.com";

/**
 * Stripe's answer: its HTTP status and its parsed JSON body (null when it is not JSON), and its
 * Date header as sent (0.1.61, optional: absent or null when there was none), which the billing
 * sweep compares with the server's clock before it removes anything.
 */
export type StripeAnswer = { status: number; body: unknown; date?: string | null };

/** A form field: name and value, sent in this order. */
export type StripeForm = readonly (readonly [string, string])[];

export interface Stripe {
  /**
   * One request to Stripe. `path` is an API path such as /v1/subscriptions/sub_123: it must
   * match STRIPE_PATH, else the call throws before anything is sent. `form` is sent as the
   * form-encoded body of a POST. Throws Error("stripe: unreachable") when no answer came.
   */
  call(method: "GET" | "POST" | "DELETE", path: string, form?: StripeForm, idempotencyKey?: string): Promise<StripeAnswer>;
}

/** The paths the platform calls: /v1/ and letters, digits, underscores and slashes only. */
export const STRIPE_PATH = /^\/v1\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/;

/** A form body as Stripe reads it: each name and value percent-encoded, joined with &. */
export function formBody(form: StripeForm): string {
  return form.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** How long one request may take before it counts as unreachable. */
const TIMEOUT_MS = 10_000;

/**
 * The real client. `apiKey` is the STRIPE_API_KEY setting; `fetchFn` is the target's fetch
 * (a test that wants to see the request passes its own; no test passes the real one).
 */
export function stripeOverFetch(apiKey: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): Stripe {
  return {
    async call(method, path, form, idempotencyKey) {
      if (!STRIPE_PATH.test(path)) throw new Error("stripe: bad path");
      const headers: Record<string, string> = {
        authorization: `Bearer ${apiKey}`,
        "stripe-version": STRIPE_API_VERSION,
      };
      if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
      const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) };
      if (method === "POST") {
        headers["content-type"] = "application/x-www-form-urlencoded";
        init.body = formBody(form ?? []);
      }
      let res: Response;
      try {
        res = await fetchFn(STRIPE_API + path, init);
      } catch {
        // Fixed text: the error of a failed fetch could carry the request it was making.
        throw new Error("stripe: unreachable");
      }
      let body: unknown = null;
      try {
        body = JSON.parse(await res.text());
      } catch {
        body = null;
      }
      // The Date header only when Stripe sent one, so an answer without it is the answer of before.
      const date = res.headers.get("date");
      return date === null ? { status: res.status, body } : { status: res.status, body, date };
    },
  };
}
