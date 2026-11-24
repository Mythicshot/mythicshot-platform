// Billing after the security review (0.1.57): stale read-backs can never overwrite newer ones,
// a paid checkout can never be orphaned, deleting an account cancels its subscription, a
// subscription Stripe deleted ends the workspace, and the rules about exempt workspaces, the
// admin-set allowance, rate limits, sharing, renaming and the return address. Stripe is the
// fake of test/fake-stripe.ts; interleavings are driven through its hook, deterministically.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { BILLING_PATHS } from "../src/billing.ts";
import { PLAN_BYTES, TRIAL_BYTES, TRIAL_MS } from "../src/billing-rules.ts";
import { BILLING_JS, RETURN_JS, TRIAL_OVER_WORDS } from "../src/dash/billing.ts";
import type { Deps } from "../src/ports.ts";
import { usageOf } from "../src/usage.ts";
import { clone, fixtures, send, uploadTour, type Json } from "./bundle.ts";
import { BILLING, FakeStripe, eventOf, notify, sessionOf, CS, SECRET, withBilling } from "./fake-stripe.ts";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

afterEach(() => vi.restoreAllMocks());

async function site(opts: { billing?: boolean } = {}) {
  const ctx = await makeDeps();
  let now = T0;
  ctx.deps.now = () => now;
  const stripe = opts.billing === false ? null : withBilling(ctx.deps);
  const admin = await seedAccount(ctx.deps, { username: "siteadmin", admin: true });
  const a = await seedAccount(ctx.deps, { username: "alpha" });
  const b = await seedAccount(ctx.deps, { username: "bravo" });
  return { ...ctx, stripe: stripe as FakeStripe, admin, a, b, advance: (ms: number) => (now += ms) };
}

const row = (deps: Deps, id: string) => deps.db.first<Json>("SELECT * FROM workspace WHERE id = ?", [id]);
const headers = async (deps: Deps, userId: string) => (await sessionOf(deps, userId)).headers;
const manifest = (): Json => {
  const m = clone(fixtures.v2 as Json);
  m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
  return m;
};
const createUpload = (deps: Deps, token: string) => send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest: manifest(), target: { kind: "new" } }), headers: { "content-type": "application/json" } });

/** A Subscribe and its completed notice: the workspace holds a live subscription. */
async function subscribed(deps: Deps, stripe: FakeStripe, ws: string, userId: string, customer: string, sub: string) {
  const r = await send(deps, "POST", BILLING_PATHS.checkout, { headers: await headers(deps, userId) });
  expect(r.status, r.text).toBe(200);
  const checkout = (await row(deps, ws))!.checkout_session_id as string;
  stripe.subscription(sub, customer, "active");
  stripe.complete(checkout, customer, sub);
  expect((await notify(deps, eventOf("checkout.session.completed", { id: checkout, client_reference_id: ws, customer, subscription: sub, payment_status: "paid" }))).status).toBe(200);
  return checkout;
}

describe("H1: a stale read-back never overwrites a newer one", () => {
  it("a failed renewal read before a deletion, written after it, is refused and retried: the subscription stays canceled", async () => {
    const s = await site();
    await subscribed(s.deps, s.stripe, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    s.stripe.subscription("sub_A", "cus_A", "past_due");
    const failed = eventOf("invoice.payment_failed", { id: "in_1", customer: "cus_A" });
    let inner: number | null = null;
    s.stripe.hook = async (call) => {
      if (call.path !== "/v1/subscriptions/sub_A" || inner !== null) return;
      // Between A's read (past_due) and its write, Stripe cancels and B's notice is taken in full.
      s.stripe.hook = null;
      s.stripe.subscription("sub_A", "cus_A", "canceled", { endedAt: 1_800_000_100 });
      inner = (await notify(s.deps, eventOf("customer.subscription.deleted", { id: "sub_A", customer: "cus_A" }))).status;
    };
    const first = await notify(s.deps, failed);
    expect(inner).toBe(200);
    expect(first.status).toBe(500);
    expect((await row(s.deps, s.a.workspaceId))!.subscription_status).toBe("canceled");
    expect(await s.deps.db.first("SELECT id FROM stripe_event WHERE id = ?", [failed.id])).toBeNull();
    // Stripe's retry reads again and leaves it canceled.
    expect((await notify(s.deps, failed)).status).toBe(200);
    expect((await row(s.deps, s.a.workspaceId))!.subscription_status).toBe("canceled");
  });

  it("a deletion of a subscription not linked yet, while a checkout is pending, is answered 500 so it is retried after the link", async () => {
    const s = await site();
    expect((await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await headers(s.deps, s.a.userId) })).status).toBe(200);
    const checkout = (await row(s.deps, s.a.workspaceId))!.checkout_session_id as string;
    s.stripe.subscription("sub_A", "cus_A", "active");
    s.stripe.complete(checkout, "cus_A", "sub_A");
    const deleted = eventOf("customer.subscription.deleted", { id: "sub_A", customer: "cus_A", created: Math.floor(T0 / 1000) });
    let inner: number | null = null;
    s.stripe.hook = async (call) => {
      if (call.path !== "/v1/subscriptions/sub_A") return;
      s.stripe.hook = null;
      s.stripe.subscription("sub_A", "cus_A", "canceled", { endedAt: 1_800_000_100 });
      inner = (await notify(s.deps, deleted)).status;
    };
    const completed = await notify(s.deps, eventOf("checkout.session.completed", { id: checkout, client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A", payment_status: "paid" }));
    expect(inner).toBe(500);
    expect(completed.status).toBe(200);
    expect((await row(s.deps, s.a.workspaceId))!.subscription_status).toBe("active");
    // The retry, now that the subscription is linked, ends it.
    expect((await notify(s.deps, deleted)).status).toBe(200);
    expect((await row(s.deps, s.a.workspaceId))!.subscription_status).toBe("canceled");
  });

  it("a live status whose period ended more than 3 days ago is read back before it is trusted; with Stripe down the workspace is read-only for writes", async () => {
    const s = await site();
    await subscribed(s.deps, s.stripe, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    // Fresh: no read-back on the hot path.
    const before = s.stripe.calls.length;
    expect((await createUpload(s.deps, s.a.token)).status).toBe(201);
    expect(s.stripe.calls.length).toBe(before);
    // The stored period ended 4 days ago; Stripe has been down for every notice since.
    await s.deps.db.run("UPDATE workspace SET subscription_period_end = ? WHERE id = ?", [T0 - 4 * DAY, s.a.workspaceId]);
    s.stripe.down = true;
    const refused = await createUpload(s.deps, s.a.token);
    expect([refused.status, refused.json.error]).toEqual([402, "subscription_ended"]);
    expect((await row(s.deps, s.a.workspaceId))!.subscription_status).toBe("active");
    // Stripe back: it says canceled, which is stored, and the state says so (a minute later:
    // within the minute the last try's outcome stands, 0.1.58).
    s.stripe.down = false;
    s.advance(60_001);
    s.stripe.subscription("sub_A", "cus_A", "canceled", { endedAt: 1_799_700_000 });
    const state = await send(s.deps, "GET", BILLING_PATHS.state, { headers: await headers(s.deps, s.a.userId) });
    expect(state.json.state).toBe("ended");
    expect((await row(s.deps, s.a.workspaceId))!.subscription_status).toBe("canceled");
    // And a renewal Stripe made heals it the other way.
    await s.deps.db.run("UPDATE workspace SET subscription_status = 'active', subscription_period_end = ? WHERE id = ?", [T0 - 4 * DAY, s.a.workspaceId]);
    s.stripe.subscription("sub_A", "cus_A", "active", { periodEnd: 1_802_000_000 });
    s.advance(60_001);
    expect((await createUpload(s.deps, s.a.token)).status).toBe(201);
    expect((await row(s.deps, s.a.workspaceId))!.subscription_period_end).toBe(1_802_000_000_000);
  });
});

describe("H2: a paid checkout is never orphaned", () => {
  it("a stored checkout is replaced only after Stripe confirms it expired; an open one without a client secret is expired first", async () => {
    const s = await site();
    const h = await headers(s.deps, s.a.userId);
    await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    s.stripe.sessions.get(CS(1))!.noSecret = true;
    const r = await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    expect(r.status).toBe(200);
    expect(s.stripe.to(`/v1/checkout/sessions/${CS(1)}/expire`).length).toBe(1);
    expect(s.stripe.sessions.get(CS(1))!.status).toBe("expired");
    expect((await row(s.deps, s.a.workspaceId))!.checkout_session_id).toBe(CS(2));
  });

  it("a stored checkout that turns out paid is never replaced: the subscription is read back and Subscribe answers already_subscribed", async () => {
    const s = await site();
    const h = await headers(s.deps, s.a.userId);
    await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    s.stripe.subscription("sub_A", "cus_A", "active");
    s.stripe.complete(CS(1), "cus_A", "sub_A");
    // Past its expiry here, so it is not offered again, and the GET would not be enough.
    s.advance(2 * 60 * 60 * 1000);
    const r = await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await headers(s.deps, s.a.userId) });
    expect([r.status, r.json.error]).toEqual([409, "already_subscribed"]);
    expect(s.stripe.sessions.size).toBe(1);
    expect(await row(s.deps, s.a.workspaceId)).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_A", stripe_customer_id: "cus_A" });
  });

  it("when Stripe gives no definite answer about the stored checkout, no new checkout is made", async () => {
    const s = await site();
    const h = await headers(s.deps, s.a.userId);
    await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    s.stripe.failing.add(`/v1/checkout/sessions/${CS(1)}`);
    s.stripe.failing.add(`/v1/checkout/sessions/${CS(1)}/expire`);
    const r = await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    expect([r.status, r.json.error]).toEqual([502, "stripe_unavailable"]);
    expect(s.stripe.sessions.size).toBe(1);
  });

  it("the checkout expires after the shortest time Stripe allows, at least 30 minutes, and is not offered again past it", async () => {
    const s = await site();
    const h = await headers(s.deps, s.a.userId);
    await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    const form = Object.fromEntries(s.stripe.to("/v1/checkout/sessions")[0].form!);
    const at = Number(form.expires_at);
    // 0.1.58: the start of the minute plus 33 minutes, so always at least 32 minutes ahead.
    expect(at - T0 / 1000).toBeGreaterThanOrEqual(32 * 60);
    expect(at - T0 / 1000).toBeLessThanOrEqual(33 * 60);
    s.advance(31 * 60 * 1000);
    s.stripe.sessions.get(CS(1))!.status = "expired";
    const r = await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    expect(r.json.client_secret).toBe(SECRET(2));
  });

  it("a completed checkout this site made still finds its workspace after the pending checkout moved on, and a second one is audited and shown to the admin", async () => {
    const s = await site();
    const h = await headers(s.deps, s.a.userId);
    await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    s.stripe.sessions.get(CS(1))!.noSecret = true;
    await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    expect((await row(s.deps, s.a.workspaceId))!.checkout_session_id).toBe(CS(2));
    // The first was paid after all (Stripe's expire raced the payment).
    s.stripe.subscription("sub_A", "cus_A", "active");
    expect((await notify(s.deps, eventOf("checkout.session.completed", { id: CS(1), client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A", payment_status: "paid" }))).status).toBe(200);
    expect(await row(s.deps, s.a.workspaceId)).toMatchObject({ subscription_status: "active", stripe_subscription_id: "sub_A" });
    // The second completes too: kept apart, audited, and counted for the admin.
    s.stripe.subscription("sub_A2", "cus_A", "active");
    await notify(s.deps, eventOf("checkout.session.completed", { id: CS(2), client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A2", payment_status: "paid" }));
    expect((await row(s.deps, s.a.workspaceId))!.stripe_subscription_id).toBe("sub_A");
    await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_nobody", client_reference_id: s.a.workspaceId, customer: "cus_Z", subscription: "sub_Z" }));
    const summary = await send(s.deps, "GET", "/api/v1/admin/summary", { headers: await headers(s.deps, s.admin.userId) });
    expect(summary.json.billing_problems.count).toBe(2);
    expect((summary.json.billing_problems.recent as Json[]).map((p) => p.event).sort()).toEqual(["billing_checkout_unmatched", "billing_second_subscription"]);
  });
});

describe("H3: deleting a subscribed account cancels its subscription first", () => {
  async function deleteAccount(deps: Deps, adminUser: string, target: { userId: string; username?: string; email: string }, username: string) {
    const h = await headers(deps, adminUser);
    await send(deps, "POST", `/api/v1/admin/accounts/${target.userId}/disable`, { headers: h });
    let r = await send(deps, "DELETE", `/api/v1/admin/accounts/${target.userId}`, { headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ username }) });
    for (let i = 0; i < 20 && r.status === 202; i++) r = await send(deps, "DELETE", `/api/v1/admin/accounts/${target.userId}`, { headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ username }) });
    return r;
  }

  it("cancels at Stripe, then deletes; with Stripe down nothing is deleted; a subscription already gone does not hold it up", async () => {
    const s = await site();
    await subscribed(s.deps, s.stripe, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    s.stripe.down = true;
    const failed = await deleteAccount(s.deps, s.admin.userId, s.a, "alpha");
    expect([failed.status, failed.json.error]).toEqual([500, "cleanup_pending"]);
    expect(await row(s.deps, s.a.workspaceId)).not.toBeNull();
    s.stripe.down = false;
    const done = await deleteAccount(s.deps, s.admin.userId, s.a, "alpha");
    expect(done.status, done.text).toBe(200);
    expect(s.stripe.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/subscriptions/sub_A", "/v1/subscriptions/sub_A"]);
    expect(s.stripe.subscriptions.get("sub_A")!.status).toBe("canceled");
    expect(await row(s.deps, s.a.workspaceId)).toBeNull();
    expect((await s.deps.db.all("SELECT workspace_id FROM audit WHERE event = 'billing_cancelled_for_deletion'"))).toEqual([{ workspace_id: s.a.workspaceId }]);
    // B's subscription is gone at Stripe already: B is deleted all the same.
    await subscribed(s.deps, s.stripe, s.b.workspaceId, s.b.userId, "cus_B", "sub_B");
    s.stripe.subscriptions.delete("sub_B");
    expect((await deleteAccount(s.deps, s.admin.userId, s.b, "bravo")).status).toBe(200);
    expect(await row(s.deps, s.b.workspaceId)).toBeNull();
  });

  it("without billing a delete asks Stripe nothing", async () => {
    const s = await site({ billing: false });
    const stripe = new FakeStripe();
    s.deps.stripe = stripe;
    expect((await deleteAccount(s.deps, s.admin.userId, s.a, "alpha")).status).toBe(200);
    expect(stripe.calls).toEqual([]);
  });
});

describe("H4: a subscription Stripe deleted ends the workspace", () => {
  it("a 404 resource_missing for the subscription on record stores canceled, ended now, and records the notice; another failure stays a 500", async () => {
    const s = await site();
    await subscribed(s.deps, s.stripe, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    s.stripe.failing.add("/v1/subscriptions/sub_A");
    expect((await notify(s.deps, eventOf("customer.subscription.updated", { id: "sub_A", customer: "cus_A" }))).status).toBe(500);
    s.stripe.failing.clear();
    s.stripe.subscriptions.delete("sub_A");
    const e = eventOf("customer.subscription.deleted", { id: "sub_A", customer: "cus_A" });
    expect((await notify(s.deps, e)).status).toBe(200);
    expect(await row(s.deps, s.a.workspaceId)).toMatchObject({ subscription_status: "canceled", subscription_ended_at: T0 });
    expect(await s.deps.db.first("SELECT id FROM stripe_event WHERE id = ?", [e.id])).toEqual({ id: e.id });
  });
});

describe("M1, M2, M3: exempt workspaces and the admin-set allowance", () => {
  it("an exempt workspace that subscribes has the plan and the Subscribed state", async () => {
    const s = await site();
    await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.a.workspaceId]);
    expect((await send(s.deps, "GET", BILLING_PATHS.state, { headers: await headers(s.deps, s.a.userId) })).json.state).toBe("exempt");
    await subscribed(s.deps, s.stripe, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    expect((await usageOf(s.deps, s.a.workspaceId)).allowance).toBe(PLAN_BYTES);
    expect((await send(s.deps, "GET", BILLING_PATHS.state, { headers: await headers(s.deps, s.a.userId) })).json).toMatchObject({ state: "subscribed", manage: true });
  });

  it("a workspace made while billing is off stays exempt when billing is switched on; one made with billing on is on the trial", async () => {
    const { deps } = await makeDeps();
    deps.now = () => T0;
    const before = await seedAccount(deps, { username: "early" });
    expect((await row(deps, before.workspaceId))!.billing_trial).toBe(0);
    withBilling(deps);
    const after = await seedAccount(deps, { username: "later" });
    expect((await row(deps, after.workspaceId))!.billing_trial).toBe(1);
    deps.now = () => T0 + TRIAL_MS + DAY;
    expect((await usageOf(deps, before.workspaceId)).allowance).toBeNull();
    expect((await usageOf(deps, after.workspaceId)).allowance).toBe(TRIAL_BYTES);
    expect((await createUpload(deps, before.token)).status).toBe(201);
    expect((await createUpload(deps, after.token)).status).toBe(402);
  });

  it("an admin-set allowance exempts only a workspace that never had a subscription; once one ended it is read-only, and the number still sizes it", async () => {
    const s = await site();
    await s.deps.db.run("UPDATE workspace SET storage_allowance_bytes = 1000000 WHERE id IN (?, ?)", [s.a.workspaceId, s.b.workspaceId]);
    await subscribed(s.deps, s.stripe, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    s.stripe.subscription("sub_A", "cus_A", "canceled", { endedAt: 1_800_000_000 });
    await notify(s.deps, eventOf("customer.subscription.deleted", { id: "sub_A", customer: "cus_A" }));
    s.advance(TRIAL_MS + DAY);
    expect((await createUpload(s.deps, s.a.token)).status).toBe(402);
    expect((await usageOf(s.deps, s.a.workspaceId)).allowance).toBe(1_000_000);
    expect((await createUpload(s.deps, s.b.token)).status).toBe(201);
  });
});

describe("M5: rate limits on the routes that ask Stripe", () => {
  it("checkout, the portal and the checkout's state are counted per workspace; the plain state is not", async () => {
    const s = await site();
    const h = await headers(s.deps, s.a.userId);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h })).status;
    expect(last).toBe(429);
    for (let i = 0; i < 35; i++) last = (await send(s.deps, "POST", BILLING_PATHS.portal, { headers: h })).status;
    expect(last).toBe(429);
    for (let i = 0; i < 65; i++) last = (await send(s.deps, "GET", `${BILLING_PATHS.state}?session_id=${CS(1)}`, { headers: h })).status;
    expect(last).toBe(429);
    expect((await send(s.deps, "GET", BILLING_PATHS.state, { headers: h })).status).toBe(200);
    // B has counts of its own.
    expect((await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await headers(s.deps, s.b.userId) })).status).toBe(200);
    // The return page asks about the checkout only a few times and backs off.
    expect(RETURN_JS).toMatch(/CHECKOUT_ASKS = [1-5];/);
    expect(RETURN_JS).toContain("Math.min(");
  });
});

describe("the small items", () => {
  it("a read-only workspace may narrow who views a tour but not widen it, and may not rename it", async () => {
    const s = await site();
    const tour = await uploadTour(s.deps, s.a.token, manifest());
    s.advance(TRIAL_MS + DAY);
    const h = { ...(await headers(s.deps, s.a.userId)), "content-type": "application/json" };
    expect((await send(s.deps, "PUT", `/api/v1/tours/${tour.tour_id}/access`, { headers: h, body: JSON.stringify({ access: "me" }) })).status).toBe(200);
    expect((await send(s.deps, "PUT", `/api/v1/tours/${tour.tour_id}/access`, { headers: h, body: JSON.stringify({ access: "public" }) })).status).toBe(402);
    expect((await send(s.deps, "PATCH", `/api/v1/tours/${tour.tour_id}`, { token: s.a.token, headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "New" }) })).status).toBe(402);
  });

  it("Stripe's return address is the configured app address, never the request's host", async () => {
    const s = await site();
    await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: { ...(await headers(s.deps, s.a.userId)), origin: "https://evil.example.net" }, origin: "https://evil.example.net" });
    const form = Object.fromEntries(s.stripe.to("/v1/checkout/sessions")[0].form!);
    expect(form.return_url).toBe("https://tours.example.com/billing/return?session_id={CHECKOUT_SESSION_ID}");
  });

  it("an ended subscription with no end time from Stripe keeps the time it was first seen ended", async () => {
    const s = await site();
    await subscribed(s.deps, s.stripe, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    s.stripe.subscription("sub_A", "cus_A", "unpaid");
    await notify(s.deps, eventOf("customer.subscription.updated", { id: "sub_A", customer: "cus_A" }));
    expect((await row(s.deps, s.a.workspaceId))!.subscription_ended_at).toBe(T0);
    s.advance(5 * DAY);
    s.stripe.subscription("sub_A", "cus_A", "unpaid", { cancelAtPeriodEnd: true });
    await notify(s.deps, eventOf("customer.subscription.updated", { id: "sub_A", customer: "cus_A" }));
    expect((await row(s.deps, s.a.workspaceId))!.subscription_ended_at).toBe(T0);
    expect((await send(s.deps, "GET", BILLING_PATHS.state, { headers: await headers(s.deps, s.a.userId) })).json.ended_at).toBe(T0);
  });

  it("a checkout whose payment is still being confirmed keeps the return page on Confirming; a run-out trial has its own approved words", async () => {
    const s = await site();
    await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: await headers(s.deps, s.a.userId) });
    s.stripe.subscription("sub_A", "cus_A", "incomplete");
    s.stripe.complete(CS(1), "cus_A", "sub_A");
    await notify(s.deps, eventOf("checkout.session.completed", { id: CS(1), client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A", payment_status: "unpaid" }));
    const state = await send(s.deps, "GET", `${BILLING_PATHS.state}?session_id=${CS(1)}`, { headers: await headers(s.deps, s.a.userId) });
    expect(state.json.confirming).toBe(true);
    expect(RETURN_JS).toContain("s.confirming === true");
    expect(TRIAL_OVER_WORDS).toEqual({ strip: "Your trial has ended. You can view, download and delete, but not publish. Subscribe to keep your tours, images and clips.", row: "Trial ended" });
    expect(BILLING_JS).toContain(JSON.stringify(TRIAL_OVER_WORDS.strip).slice(1, -1));
    expect(BILLING_JS).toContain("Trial ended");
    expect(BILLING.publishableKey).toBe("pk_test_FAKE");
  });
});
