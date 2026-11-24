// Billing against what Stripe's sandbox really sent (0.1.59): the client secret of an embedded
// checkout is long and percent-encoded, the notices of a payment come in Stripe's own order, a
// cancellation in the portal sets cancel_at and leaves the flag false, an answer the platform
// refuses for its shape leaves a trace for the admin, and the configured price is checked once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { BILLING_PATHS, checkPrice, priceCheckOf } from "../src/billing.ts";
import type { Deps } from "../src/ports.ts";
import { send, type Json } from "./bundle.ts";
import { BILLING, CS, REAL, SECRET, eventOf, notify, sessionOf, withBilling } from "./fake-stripe.ts";

const T0 = 1_800_000_000_000;
const S = (ms: number) => Math.floor(ms / 1000);

afterEach(() => vi.restoreAllMocks());

async function site() {
  const ctx = await makeDeps();
  let now = T0;
  ctx.deps.now = () => now;
  const stripe = withBilling(ctx.deps);
  const admin = await seedAccount(ctx.deps, { username: "siteadmin", admin: true });
  const a = await seedAccount(ctx.deps, { username: "alpha" });
  return { ...ctx, stripe, admin, a, advance: (ms: number) => (now += ms), now: () => now };
}
const h = async (deps: Deps, userId: string) => (await sessionOf(deps, userId)).headers;
const row = (deps: Deps, id: string) => deps.db.first<Json>("SELECT * FROM workspace WHERE id = ?", [id]);

describe("the shapes Stripe really sends", () => {
  it("the fake's values have the real shapes", () => {
    expect(CS(1)).toMatch(/^cs_test_[A-Za-z0-9]{58}$/);
    expect(SECRET(1).length).toBe(468);
    expect(SECRET(1)).toMatch(/^cs_test_[A-Za-z0-9_%]+$/);
    for (const seq of ["%2F", "%2B", "%3D"]) expect(SECRET(1)).toContain(seq);
    expect(REAL.subscription).toHaveLength(28);
    expect(REAL.customer).toHaveLength(18);
  });

  it("a real client secret is handed to the session, at create and on reuse", async () => {
    const s = await site();
    const first = await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await h(s.deps, s.a.userId) });
    expect([first.status, first.json.client_secret]).toEqual([200, SECRET(1)]);
    const again = await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await h(s.deps, s.a.userId) });
    expect([again.status, again.json.client_secret]).toEqual([200, SECRET(1)]);
    expect(s.stripe.sessions.size).toBe(1);
  });

  it("a secret with a quote, an angle bracket, a backslash, a space or a control character is refused, and the refusal is a billing problem with no value in it", async () => {
    for (const bad of ['cs_test_x_secret_a"b', "cs_test_x_secret_a<b", "cs_test_x_secret_a\\b", "cs_test_x_secret_a b", "cs_test_x_secret_a\u0001b", "x".repeat(2049)]) {
      const s = await site();
      s.stripe.hook = async (call, answer) => {
        if (call.path === "/v1/checkout/sessions" && call.method === "POST") (answer.body as Json).client_secret = bad;
      };
      const r = await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await h(s.deps, s.a.userId) });
      expect(r.status, JSON.stringify(bad)).toBe(502);
      const audit = await s.deps.db.all<{ detail: string }>("SELECT detail FROM audit WHERE event = 'billing_answer_refused'");
      expect(audit.map((x) => x.detail)).toEqual(['{"call":"checkout_create","field":"client_secret"}']);
      const summary = await send(s.deps, "GET", "/api/v1/admin/summary", { headers: await h(s.deps, s.admin.userId) });
      expect(summary.json.billing_problems.count).toBe(1);
      expect(summary.text).not.toContain("cs_test_x");
    }
  });

  it("the notices of a payment in Stripe's own order: invoice.paid before the checkout's notice is taken without binding anything, the subscription's created notice is held, and taken on its retry", async () => {
    const s = await site();
    expect((await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await h(s.deps, s.a.userId) })).status).toBe(200);
    s.advance(60_000);
    const sub = REAL.subscription;
    const cus = REAL.customer;
    s.stripe.subscription(sub, cus, "active");
    s.stripe.complete(CS(1), cus, sub);
    const at = S(s.now());
    const order: [string, Json][] = [
      ["invoice.finalized", { id: REAL.invoice, customer: cus }],
      ["payment_method.attached", { id: REAL.paymentMethod, customer: cus }],
      ["invoice.paid", { id: REAL.invoice, customer: cus, parent: { subscription_details: { subscription: sub } } }],
      ["checkout.session.completed", { id: CS(1), client_reference_id: s.a.workspaceId, customer: cus, subscription: sub, payment_status: "paid", ui_mode: "embedded_page" }],
      ["customer.created", { id: cus }],
      ["customer.updated", { id: cus }],
      ["customer.subscription.created", { id: sub, customer: cus, status: "active", created: at }],
      ["payment_intent.succeeded", { id: REAL.paymentIntent, customer: cus }],
      ["payment_intent.created", { id: REAL.paymentIntent, customer: cus }],
      ["invoice.created", { id: REAL.invoice, customer: cus }],
      ["invoice.payment_succeeded", { id: REAL.invoice, customer: cus }],
      ["invoice_payment.paid", { id: "inpay_1Uf7540x7W4K5JLaZr8mQv1D" }],
    ];
    const answers: Record<string, number> = {};
    const events: Json[] = [];
    for (const [type, obj] of order) {
      const e = eventOf(type, obj);
      events.push(e);
      answers[type] = (await notify(s.deps, e)).status;
    }
    // As in the sandbox: everything 200; the created notice, if it came before the link, would be held.
    for (const [type] of order) expect(answers[type], type).toBe(200);
    expect(await row(s.deps, s.a.workspaceId)).toMatchObject({ subscription_status: "active", stripe_subscription_id: sub, stripe_customer_id: cus });

    // The sandbox's actual timing: the created notice raced ahead of the checkout's and was held.
    const s2 = await site();
    expect((await send(s2.deps, "POST", BILLING_PATHS.checkout, { headers: await h(s2.deps, s2.a.userId) })).status).toBe(200);
    s2.stripe.subscription(sub, cus, "active");
    s2.stripe.complete(CS(1), cus, sub);
    const paid = eventOf("invoice.paid", { id: REAL.invoice, customer: cus });
    const created = eventOf("customer.subscription.created", { id: sub, customer: cus, status: "active", created: S(s2.now()) });
    expect((await notify(s2.deps, paid)).status).toBe(200);
    expect((await notify(s2.deps, created)).status).toBe(500);
    expect((await notify(s2.deps, eventOf("checkout.session.completed", { id: CS(1), client_reference_id: s2.a.workspaceId, customer: cus, subscription: sub, payment_status: "paid" }))).status).toBe(200);
    expect((await notify(s2.deps, created)).status).toBe(200);
    // invoice.paid for a customer not yet on record bound nothing; the checkout did.
    expect(await row(s2.deps, s2.a.workspaceId)).toMatchObject({ subscription_status: "active", stripe_customer_id: cus });
  });

  it("a cancellation in the portal (cancel_at set to the period end, the flag false) shows the Set to end card's dates", async () => {
    const s = await site();
    expect((await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await h(s.deps, s.a.userId) })).status).toBe(200);
    const sub = REAL.subscription;
    const cus = REAL.customer;
    s.stripe.subscription(sub, cus, "active", { periodEnd: 1_900_000_000 });
    s.stripe.complete(CS(1), cus, sub);
    await notify(s.deps, eventOf("checkout.session.completed", { id: CS(1), client_reference_id: s.a.workspaceId, customer: cus, subscription: sub, payment_status: "paid" }));
    s.stripe.subscription(sub, cus, "active", { periodEnd: 1_900_000_000, cancelAt: 1_900_000_000, cancelAtPeriodEnd: false });
    expect(s.stripe.subscriptions.get(sub)).toMatchObject({ cancel_at_period_end: false, cancellation_details: { reason: "cancellation_requested" }, billing_mode: { type: "flexible" }, automatic_tax: { enabled: true, liability: { type: "stripe" } } });
    await notify(s.deps, eventOf("customer.subscription.updated", { id: sub, customer: cus, status: "active", cancel_at: 1_900_000_000, cancel_at_period_end: false }));
    expect(await row(s.deps, s.a.workspaceId)).toMatchObject({ subscription_cancel_at: 1_900_000_000_000, subscription_cancel_at_period_end: 0 });
    const state = await send(s.deps, "GET", BILLING_PATHS.state, { headers: await h(s.deps, s.a.userId) });
    const DAY = 86_400_000;
    expect(state.json).toMatchObject({ state: "ending", ends_at: 1_900_000_000_000, links_until: 1_900_000_000_000 + 30 * DAY, removed_at: 1_900_000_000_000 + 90 * DAY, manage: true });
  });
});

describe("the configured price is checked once", () => {
  it("ok, could not be checked, or a definite no such price; the admin's summary says which", async () => {
    const s = await site();
    expect(await checkPrice(s.deps)).toBe("ok");
    expect(s.stripe.to(`/v1/prices/${BILLING.priceId}`)).toHaveLength(1);
    let summary = await send(s.deps, "GET", "/api/v1/admin/summary", { headers: await h(s.deps, s.admin.userId) });
    expect(summary.json.billing_price).toBe("ok");
    s.stripe.price = "forbidden";
    expect(await checkPrice(s.deps)).toBe("could_not_check");
    s.stripe.down = true;
    expect(await checkPrice(s.deps)).toBe("could_not_check");
    s.stripe.down = false;
    summary = await send(s.deps, "GET", "/api/v1/admin/summary", { headers: await h(s.deps, s.admin.userId) });
    expect(summary.json.billing_price).toBe("could_not_check");
    s.stripe.price = "missing";
    expect(await checkPrice(s.deps)).toBe("missing");
    expect(priceCheckOf(s.deps.config)).toBe("missing");
  });
});
