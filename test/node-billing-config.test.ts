// Billing's four settings on the Node server (configFromEnv): all four or none, and a setting
// of the wrong shape stops the start with a line that names it and never its value.
import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/node/config.ts";

const FOUR = { STRIPE_API_KEY: "rk_test_FAKE", STRIPE_WEBHOOK_SECRET: "whsec_FAKE", STRIPE_PRICE_ID: "price_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_test_FAKE" };

describe("billing on the Node server", () => {
  it("is on with all four, and without any one the config is as before, with no such key", () => {
    expect(configFromEnv({ ...FOUR }).billing).toEqual({ apiKey: "rk_test_FAKE", webhookSecret: "whsec_FAKE", priceId: "price_FAKE", publishableKey: "pk_test_FAKE" });
    for (const name of Object.keys(FOUR)) {
      const config = configFromEnv({ ...FOUR, [name]: "" });
      expect("billing" in config, name).toBe(false);
    }
    expect(configFromEnv({})).toEqual(configFromEnv({ STRIPE_PRICE_ID: "price_FAKE" }));
  });

  it("stops the start for a setting of the wrong shape, naming it and never a value", () => {
    for (const name of Object.keys(FOUR)) {
      let message = "";
      try {
        configFromEnv({ ...FOUR, [name]: "wrong_FAKE_value" });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, name).toContain(name);
      for (const v of [...Object.values(FOUR), "wrong_FAKE_value"]) expect(message, name).not.toContain(v);
    }
  });
});
