// Billing round 3 (0.1.58), before billing is switched on: the hold on unlinked subscription
// notices is narrow, a checkout always lives more than Stripe's minimum, deleting an account
// expires its open checkouts and records the removal before asking Stripe, key modes match, a
// partial set of settings stops the start, read-backs of a stale row are throttled, the
// checkout record is swept, and paid checkouts that could not be matched are shown to the admin.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { BILLING_PATHS, missingAllowsRemoval } from "../src/billing.ts";
import { billingFromSettings } from "../src/billing-rules.ts";
import type { Deps } from "../src/ports.ts";
import { clone, fixtures, send, uploadTour, type Json } from "./bundle.ts";
import { FakeStripe, eventOf, notify, sessionOf, withBilling } from "./fake-stripe.ts";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const MIN = 60_000;
const S = (ms: number) => Math.floor(ms / 1000);

afterEach(() => vi.restoreAllMocks());

async function site() {
  const ctx = await makeDeps();
  let now = T0;
  ctx.deps.now = () => now;
  const stripe = withBilling(ctx.deps);
  const admin = await seedAccount(ctx.deps, { username: "siteadmin", admin: true });
  const a = await seedAccount(ctx.deps, { username: "alpha" });
  const b = await seedAccount(ctx.deps, { username: "bravo" });
  return { ...ctx, stripe, admin, a, b, now: () => now, advance: (ms: number) => (now += ms), set: (ms: number) => (now = ms) };
}
const row = (deps: Deps, id: string) => deps.db.first<Json>("SELECT * FROM workspace WHERE id = ?", [id]);
const h = async (deps: Deps, userId: string) => (await sessionOf(deps, userId)).headers;
const checkout = async (deps: Deps, userId: string) => send(deps, "POST", BILLING_PATHS.checkout, { headers: await h(deps, userId) });

async function subscribed(s: Awaited<ReturnType<typeof site>>, ws: string, userId: string, customer: string, sub: string) {
  expect((await checkout(s.deps, userId)).status).toBe(200);
  const id = (await row(s.deps, ws))!.checkout_session_id as string;
  s.stripe.subscription(sub, customer, "active");
  s.stripe.complete(id, customer, sub);
  expect((await notify(s.deps, eventOf("checkout.session.completed", { id, client_reference_id: ws, customer, subscription: sub, payment_status: "paid" }))).status).toBe(200);
  return id;
}

async function deleteAccount(deps: Deps, adminUser: string, userId: string, username: string) {
  const hh = { ...(await h(deps, adminUser)), "content-type": "application/json" };
  await send(deps, "POST", `/api/v1/admin/accounts/${userId}/disable`, { headers: hh });
  let r = await send(deps, "DELETE", `/api/v1/admin/accounts/${userId}`, { headers: hh, body: JSON.stringify({ username }) });
  for (let i = 0; i < 20 && r.status === 202; i++) r = await send(deps, "DELETE", `/api/v1/admin/accounts/${userId}`, { headers: hh, body: JSON.stringify({ username }) });
  return r;
}

describe("N1: the hold on unlinked subscription notices", () => {
  it("a stray subscription event with no recent checkout is taken; an old abandoned checkout holds nothing", async () => {
    const s = await site();
    // An abandoned checkout, made long ago and never cleared.
    expect((await checkout(s.deps, s.a.userId)).status).toBe(200);
    s.advance(3 * DAY);
    const stray = eventOf("customer.subscription.updated", { id: "sub_STRAY", customer: "cus_STRAY", created: S(s.now()) });
    expect((await notify(s.deps, stray)).status).toBe(200);
    // Old by its own clock, with a checkout made just now: not held either.
    expect((await checkout(s.deps, s.b.userId)).status).toBe(200);
    expect((await notify(s.deps, eventOf("customer.subscription.updated", { id: "sub_OLD", customer: "cus_OLD", created: S(s.now() - 3 * 60 * MIN) }))).status).toBe(200);
  });

  it("the notice of our own deletion's cancel, after the workspace is gone, is taken", async () => {
    const s = await site();
    await subscribed(s, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    expect((await deleteAccount(s.deps, s.admin.userId, s.a.userId, "alpha")).status).toBe(200);
    // B's checkout a moment ago, made before the subscription this notice is about? No: sub_A is older than it.
    expect((await checkout(s.deps, s.b.userId)).status).toBe(200);
    expect((await notify(s.deps, eventOf("customer.subscription.deleted", { id: "sub_A", customer: "cus_A", created: S(T0 - 2 * DAY) }))).status).toBe(200);
  });

  it("the real race is still held, and resolves on Stripe's retry", async () => {
    const s = await site();
    expect((await checkout(s.deps, s.a.userId)).status).toBe(200);
    const id = (await row(s.deps, s.a.workspaceId))!.checkout_session_id as string;
    s.advance(3 * MIN);
    s.stripe.subscription("sub_A", "cus_A", "canceled", { endedAt: S(s.now()) });
    s.stripe.complete(id, "cus_A", "sub_A");
    const deleted = eventOf("customer.subscription.deleted", { id: "sub_A", customer: "cus_A", created: S(s.now()) });
    expect((await notify(s.deps, deleted)).status).toBe(500);
    expect((await notify(s.deps, eventOf("checkout.session.completed", { id, client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A", payment_status: "paid" }))).status).toBe(200);
    expect((await notify(s.deps, deleted)).status).toBe(200);
    expect((await row(s.deps, s.a.workspaceId))!.subscription_status).toBe("canceled");
  });
});

describe("a local run against a Stripe sandbox", () => {
  it("with test keys and localhost, Stripe's return address is the local http address", async () => {
    const { deps } = await makeDeps({ siteHost: "localhost:3000" });
    deps.now = () => T0;
    const stripe = withBilling(deps);
    await seedAccount(deps, { username: "siteadmin", admin: true });
    const a = await seedAccount(deps, { username: "alpha" });
    expect((await checkout(deps, a.userId)).status).toBe(200);
    expect(Object.fromEntries(stripe.to("/v1/checkout/sessions")[0].form!).return_url).toBe("http://localhost:3000/billing/return?session_id={CHECKOUT_SESSION_ID}");
  });
});

describe("N2: a checkout lives more than Stripe's minimum", () => {
  it("late in a minute the checkout still expires at least 32 minutes ahead, with one key per minute", async () => {
    const s = await site();
    s.set(T0 + 59_900);
    expect((await checkout(s.deps, s.a.userId)).status).toBe(200);
    const call = s.stripe.to("/v1/checkout/sessions")[0];
    const at = Number(Object.fromEntries(call.form!).expires_at);
    expect(at * 1000 - s.now()).toBeGreaterThanOrEqual(32 * MIN);
    expect(at).toBe(T0 / 1000 + 33 * 60);
  });
});

describe("N3: deleting an account expires its open checkouts first, after recording the removal", () => {
  it("open checkouts are expired; one that turns out paid has its subscription cancelled; Stripe down deletes nothing", async () => {
    const s = await site();
    expect((await checkout(s.deps, s.a.userId)).status).toBe(200);
    s.stripe.down = true;
    const failed = await deleteAccount(s.deps, s.admin.userId, s.a.userId, "alpha");
    expect(failed.status).toBe(500);
    expect(await row(s.deps, s.a.workspaceId)).not.toBeNull();
    // The removal was recorded before Stripe was asked: the account cannot be enabled meanwhile.
    const enable = await send(s.deps, "POST", `/api/v1/admin/accounts/${s.a.userId}/enable`, { headers: await h(s.deps, s.admin.userId) });
    expect(enable.status).not.toBe(204);
    expect((await s.deps.db.first<{ status: string }>("SELECT status FROM user WHERE id = ?", [s.a.userId]))!.status).toBe("disabled");
    s.stripe.down = false;
    // Paid at Stripe after all, its notice not taken yet.
    s.stripe.subscription("sub_LATE", "cus_LATE", "active");
    s.stripe.complete("cs_test_1", "cus_LATE", "sub_LATE");
    const done = await deleteAccount(s.deps, s.admin.userId, s.a.userId, "alpha");
    expect(done.status, done.text).toBe(200);
    expect(s.stripe.subscriptions.get("sub_LATE")!.status).toBe("canceled");
    expect(await row(s.deps, s.a.workspaceId)).toBeNull();
    // B's open checkout is expired before B goes.
    expect((await checkout(s.deps, s.b.userId)).status).toBe(200);
    const bCheckout = (await row(s.deps, s.b.workspaceId))!.checkout_session_id as string;
    expect((await deleteAccount(s.deps, s.admin.userId, s.b.userId, "bravo")).status).toBe(200);
    expect(s.stripe.sessions.get(bCheckout)!.status).toBe("expired");
  });
});

describe("N3 within the call budget", () => {
  it("a workspace with many open checkouts is closed over several delete requests, each within the budget", async () => {
    const s = await site();
    for (let i = 0; i < 25; i++) {
      const id = `cs_test_many${i}`;
      s.stripe.sessions.set(id, { id, status: "open", client_secret: `${id}_secret_FAKE`, form: {} });
      await s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [id, s.a.workspaceId, T0, T0 + 30 * MIN]);
    }
    // send() fails any request over the budget; the delete answers 202 until the last checkout is closed.
    const r = await deleteAccount(s.deps, s.admin.userId, s.a.userId, "alpha");
    expect(r.status, r.text).toBe(200);
    expect([...s.stripe.sessions.values()].filter((c) => String(c.id).startsWith("cs_test_many") && c.status !== "expired")).toEqual([]);
  });
});

describe("N4, N5: the settings", () => {
  const all = { STRIPE_API_KEY: "rk_test_FAKE", STRIPE_WEBHOOK_SECRET: "whsec_FAKE", STRIPE_PRICE_ID: "price_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_test_FAKE" };
  it("the key and the publishable key must be of one mode; the line names both settings and no value", () => {
    expect(billingFromSettings({ ...all, STRIPE_API_KEY: "sk_live_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_live_FAKE" }).ok).toBe(true);
    for (const [k, p] of [["rk_live_FAKE", "pk_test_FAKE"], ["sk_test_FAKE", "pk_live_FAKE"], ["rk_FAKE", "pk_test_FAKE"]]) {
      const r = billingFromSettings({ ...all, STRIPE_API_KEY: k, STRIPE_PUBLISHABLE_KEY: p });
      expect(r.ok, `${k} ${p}`).toBe(false);
      if (r.ok) continue;
      expect(r.problem).toContain("STRIPE_API_KEY");
      expect(r.problem).toContain("STRIPE_PUBLISHABLE_KEY");
      for (const v of [k, p]) expect(r.problem).not.toContain(v);
    }
  });

  it("one, two or three of the four settings stop the start, naming the missing ones; none is off, all four on", () => {
    expect(billingFromSettings({})).toEqual({ ok: true, billing: null });
    const names = Object.keys(all) as (keyof typeof all)[];
    for (let n = 1; n <= 3; n++) {
      for (let start = 0; start < 4; start++) {
        const present = names.filter((_, i) => (i - start + 4) % 4 < n);
        const r = billingFromSettings(Object.fromEntries(present.map((k) => [k, all[k]])));
        expect(r.ok, present.join(",")).toBe(false);
        if (r.ok) continue;
        for (const k of names) expect(r.problem.includes(k), `${present.join(",")}: ${k}`).toBe(!present.includes(k));
        for (const v of Object.values(all)) expect(r.problem).not.toContain(v);
      }
    }
    // Empty counts as absent.
    expect(billingFromSettings({ STRIPE_API_KEY: " ", STRIPE_WEBHOOK_SECRET: "" })).toEqual({ ok: true, billing: null });
    // A 404 is never proof for anything that removes data.
    expect(missingAllowsRemoval()).toBe(false);
  });
});

describe("N6: read-backs of a stale row", () => {
  it("are at most one a minute per workspace, keep the last result in between, and an old active period confirmed by Stripe is trusted for a day, audited once", async () => {
    const s = await site();
    await subscribed(s, s.a.workspaceId, s.a.userId, "cus_A", "sub_A");
    await s.deps.db.run("UPDATE workspace SET subscription_period_end = ? WHERE id = ?", [T0 - 4 * DAY, s.a.workspaceId]);
    const reads = () => s.stripe.to("/v1/subscriptions/sub_A").length;
    const before = reads();
    const m = clone(fixtures.v2 as Json);
    m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
    const create = () => send(s.deps, "POST", "/api/v1/uploads", { token: s.a.token, body: JSON.stringify({ manifest: m, target: { kind: "new" } }), headers: { "content-type": "application/json" } });
    s.stripe.down = true;
    expect((await create()).status).toBe(402);
    expect((await create()).status).toBe(402);
    expect(reads()).toBe(before + 1);
    s.stripe.down = false;
    // Within the minute: still read-only, Stripe not asked.
    expect((await create()).status).toBe(402);
    expect(reads()).toBe(before + 1);
    s.advance(MIN + 1);
    // Stripe says active, but with the same old period end: trusted for a day, audited once.
    s.stripe.subscription("sub_A", "cus_A", "active", { periodEnd: S(T0 - 4 * DAY) });
    expect((await create()).status).toBe(201);
    s.advance(2 * MIN);
    expect((await create()).status).toBe(201);
    expect(reads()).toBe(before + 2);
    expect((await s.deps.db.all("SELECT 1 FROM audit WHERE event = 'billing_stale_confirmed'")).length).toBe(1);
    s.advance(DAY);
    await create();
    expect(reads()).toBe(before + 3);
  });

  it("the plain state is rate-limited per workspace, generously", async () => {
    const s = await site();
    const hh = await h(s.deps, s.a.userId);
    let last = 0;
    for (let i = 0; i < 601; i++) last = (await send(s.deps, "GET", BILLING_PATHS.state, { headers: hh })).status;
    expect(last).toBe(429);
    expect((await send(s.deps, "GET", BILLING_PATHS.state, { headers: await h(s.deps, s.b.userId) })).status).toBe(200);
  }, 120_000);
});

describe("N7: the checkout record is swept, and money taken without access is shown to the admin", () => {
  it("housekeeping removes checkouts more than 7 days past their expiry, of the workspace it runs for, and keeps the others", async () => {
    const s = await site();
    const put = (id: string, ws: string, expires: number) => s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [id, ws, expires - 33 * MIN, expires]);
    await put("cs_old_a", s.a.workspaceId, T0 - 8 * DAY);
    await put("cs_recent_a", s.a.workspaceId, T0 - 6 * DAY);
    await put("cs_open_a", s.a.workspaceId, T0 + 10 * MIN);
    await put("cs_old_b", s.b.workspaceId, T0 - 8 * DAY);
    const m = clone(fixtures.v2 as Json);
    m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
    await uploadTour(s.deps, s.a.token, m);
    expect((await s.deps.db.all<{ id: string }>("SELECT id FROM stripe_checkout ORDER BY id")).map((r) => r.id)).toEqual(["cs_old_b", "cs_open_a", "cs_recent_a"]);
  });

  it("a paid checkout that matched on its id but not on its reference or customer is a billing problem", async () => {
    const s = await site();
    expect((await checkout(s.deps, s.a.userId)).status).toBe(200);
    const id = (await row(s.deps, s.a.workspaceId))!.checkout_session_id as string;
    s.stripe.subscription("sub_X", "cus_X", "active");
    await notify(s.deps, eventOf("checkout.session.completed", { id, client_reference_id: s.b.workspaceId, customer: "cus_X", subscription: "sub_X", payment_status: "paid" }));
    // An unpaid one (a delayed payment still pending) is not money taken.
    await notify(s.deps, eventOf("checkout.session.async_payment_failed", { id, client_reference_id: s.b.workspaceId, customer: "cus_X", subscription: "sub_X", payment_status: "unpaid" }));
    const summary = await send(s.deps, "GET", "/api/v1/admin/summary", { headers: await h(s.deps, s.admin.userId) });
    expect(summary.json.billing_problems.count).toBe(1);
    expect(summary.json.billing_problems.recent).toEqual([{ event: "billing_checkout_mismatch", workspace_id: s.a.workspaceId, at: T0 }]);
  });

  it("without billing a delete asks Stripe nothing", async () => {
    const { deps } = await makeDeps();
    const stripe = new FakeStripe();
    deps.stripe = stripe;
    const admin = await seedAccount(deps, { username: "siteadmin", admin: true });
    const a = await seedAccount(deps, { username: "alpha" });
    expect((await deleteAccount(deps, admin.userId, a.userId, "alpha")).status).toBe(200);
    expect(stripe.calls).toEqual([]);
  });
});
