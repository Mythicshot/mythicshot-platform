// Billing's four settings on the Node server (configFromEnv): all four or none, and a setting
// of the wrong shape stops the start with a line that names it and never its value.
import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/node/config.ts";

const HOST = { SITE_HOST: "app.example.com" };
const FOUR = { ...HOST, STRIPE_API_KEY: "rk_test_FAKE", STRIPE_WEBHOOK_SECRET: "whsec_FAKE", STRIPE_PRICE_ID: "price_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_test_FAKE" };

describe("billing on the Node server", () => {
  it("is on with all four, off with none (the config as before, with no such key), and some but not all stop the start naming the missing ones", () => {
    expect(configFromEnv({ ...FOUR }).billing).toEqual({ apiKey: "rk_test_FAKE", webhookSecret: "whsec_FAKE", priceId: "price_FAKE", publishableKey: "pk_test_FAKE" });
    for (const name of Object.keys(FOUR).filter((k) => k !== "SITE_HOST")) expect(() => configFromEnv({ ...FOUR, [name]: "" }), name).toThrow(new RegExp(name));
    expect(() => configFromEnv({ STRIPE_PRICE_ID: "price_FAKE" })).toThrow(/STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY are missing/);
    expect("billing" in configFromEnv({ SITE_HOST: "app.example.com" })).toBe(false);
  });

  it("on localhost over http only with both keys in test mode: a live key, or a host that is not local, stops the start", () => {
    const { SITE_HOST: _, ...keys } = FOUR;
    expect(configFromEnv({ ...keys, SITE_HOST: "localhost:3000" }).billing).toBeDefined();
    expect(configFromEnv({ ...keys, SITE_HOST: "127.0.0.1:8080" }).billing).toBeDefined();
    expect(() => configFromEnv({ ...keys, STRIPE_API_KEY: "rk_live_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_live_FAKE", SITE_HOST: "localhost:3000" })).toThrow(/https/);
    // A local-looking name that is not exactly localhost is served over http too, and is no exception.
    expect(() => configFromEnv({ ...keys, SITE_HOST: "app.localhost:3000" })).toThrow(/https/);
  });

  it("with billing on, the site needs its own https address for Stripe's return address: without one the start stops, naming the settings", () => {
    const { SITE_HOST: _, ...noHost } = FOUR;
    expect(() => configFromEnv(noHost)).toThrow(/APP_HOST.*SITE_HOST|SITE_HOST.*APP_HOST/);
    expect(() => configFromEnv({ ...noHost, SITE_HOST: "localhost:3000", STRIPE_API_KEY: "rk_live_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_live_FAKE" })).toThrow(/https/);
    expect(configFromEnv({ ...noHost, TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" }).billing).toBeDefined();
  });

  it("stops the start for a setting of the wrong shape, naming it and never a value", () => {
    for (const name of Object.keys(FOUR).filter((k) => k !== "SITE_HOST")) {
      let message = "";
      try {
        configFromEnv({ ...FOUR, [name]: "wrong_FAKE_value" });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, name).toContain(name);
      for (const v of [...Object.values(FOUR).filter((x) => x !== HOST.SITE_HOST), "wrong_FAKE_value"]) expect(message, name).not.toContain(v);
    }
  });
});
