/// <reference types="vite/client" />
// Billing's four settings on both entries: the Worker's (billingFromWorkerEnv, depsFromEnv and
// its answer to a setting of the wrong shape) here, on both configurations; the Node server's
// (configFromEnv) in test/node-billing-config.test.ts. No test reaches Stripe.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingSettings } from "../src/billing-rules.ts";
import type { Deps } from "../src/ports.ts";

type Entry = {
  billingFromWorkerEnv(env: Record<string, unknown>): { ok: true; billing: BillingSettings | null } | { ok: false; problem: string };
  depsFromEnv(env: Record<string, unknown>, hosts: null, storageAllowanceBytes: number | null, ctx: undefined, billing: BillingSettings | null): Deps;
  default: { fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Response | Promise<Response> };
};
const ENTRY_PATH = "../src/cloudflare/entry.ts";
const load = import.meta.glob("../src/cloudflare/entry.ts");
const entry = (await load[ENTRY_PATH]()) as Entry;

const FOUR = { STRIPE_API_KEY: "rk_test_FAKE", STRIPE_WEBHOOK_SECRET: "whsec_FAKE", STRIPE_PRICE_ID: "price_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_test_FAKE" };
const untouched = (name: string) =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(`the ${name} binding was used`);
      },
    },
  );
const bindings = () => ({ DB: untouched("DB"), DRAFTS: untouched("DRAFTS"), PUB: untouched("PUB"), PUBLIC_IMAGE_BASE: "" });

afterEach(() => vi.restoreAllMocks());

describe("billing on the Worker", () => {
  it("is on with all four vars and secrets, off without any one, and a client reaches Stripe only then", () => {
    expect(entry.billingFromWorkerEnv(FOUR)).toEqual({ ok: true, billing: { apiKey: "rk_test_FAKE", webhookSecret: "whsec_FAKE", priceId: "price_FAKE", publishableKey: "pk_test_FAKE" } });
    // Some but not all of the four is a problem naming the missing ones (0.1.58); none is off.
    for (const name of Object.keys(FOUR)) {
      const partial = entry.billingFromWorkerEnv({ ...FOUR, [name]: undefined });
      expect(partial.ok, name).toBe(false);
      if (!partial.ok) expect(partial.problem, name).toContain(name);
    }
    expect(entry.billingFromWorkerEnv({})).toEqual({ ok: true, billing: null });
    const on = entry.billingFromWorkerEnv(FOUR);
    if (!on.ok) throw new Error("expected billing");
    const withBilling = entry.depsFromEnv(bindings(), null, null, undefined, on.billing);
    expect(withBilling.config.billing).toEqual(on.billing);
    expect(typeof withBilling.stripe?.call).toBe("function");
    const without = entry.depsFromEnv(bindings(), null, null, undefined, null);
    expect("billing" in without.config).toBe(false);
    expect("stripe" in without).toBe(false);
  });

  it("answers 500 misconfigured with billing on and no https address of its own for Stripe's return address", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await entry.default.fetch(new Request("https://tours.example.com/healthz"), { ...bindings(), ...FOUR }, {});
    expect([res.status, await res.text()]).toEqual([500, '{"error":"misconfigured"}']);
    expect(logged.mock.calls.map((c) => c.join(" ")).join(" ")).toMatch(/SITE_HOST/);
    // With an address it serves; its first request asks Stripe for the price, here a stand-in
    // fetch (no test reaches the network).
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return new Response('{"id":"price_FAKE","object":"price"}', { status: 200 });
    });
    const ok = await entry.default.fetch(new Request("https://tours.example.com/no/such"), { ...bindings(), ...FOUR, SITE_HOST: "tours.example.com" }, {});
    expect(ok.status).toBe(404);
    expect(asked).toEqual(["https://api.stripe.com/v1/prices/price_FAKE"]);
    // Once per isolate: the next request asks nothing.
    await entry.default.fetch(new Request("https://tours.example.com/no/such"), { ...bindings(), ...FOUR, SITE_HOST: "tours.example.com" }, {});
    expect(asked).toHaveLength(1);
  });

  it("answers 500 misconfigured to every request when Stripe says the price does not exist, naming the two settings", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"error":{"code":"resource_missing","type":"invalid_request_error"}}', { status: 404 }));
    const env = { ...bindings(), ...FOUR, STRIPE_PRICE_ID: "price_GONE", SITE_HOST: "tours.example.com" };
    for (let i = 0; i < 2; i++) {
      const res = await entry.default.fetch(new Request("https://tours.example.com/healthz"), env, {});
      expect([res.status, await res.text()]).toEqual([500, '{"error":"misconfigured"}']);
    }
    const lines = logged.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(lines).toContain("STRIPE_PRICE_ID");
    expect(lines).toContain("STRIPE_API_KEY");
    expect(lines).not.toContain("price_GONE");
  });

  it("answers 500 misconfigured to every request for a setting of the wrong shape, with a line that names it and never a value", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const name of Object.keys(FOUR)) {
      logged.mockClear();
      const res = await entry.default.fetch(new Request("https://tours.example.com/healthz"), { ...bindings(), ...FOUR, [name]: "wrong_FAKE_value" }, {});
      expect([res.status, await res.text()], name).toEqual([500, '{"error":"misconfigured"}']);
      const lines = logged.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(lines).toContain(name);
      for (const v of [...Object.values(FOUR), "wrong_FAKE_value"]) expect(lines).not.toContain(v);
    }
  });
});
