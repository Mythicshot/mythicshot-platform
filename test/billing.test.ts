// Billing (0.1.57, Plan 2l items 1 to 6 and 9), on both targets: the settings switch, the
// allowance and the read-only rule under each state, Subscribe (an embedded Checkout Session),
// Manage subscription, the listener for Stripe's notices, and the state the dashboard reads.
// Stripe is the fake of test/fake-stripe.ts: no test reaches any network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { BILLING_PATHS, LISTENER_MAX_BYTES, SUBSCRIPTION_ENDED, verifyStripeSignature } from "../src/billing.ts";
import { PLAN_BYTES, TRIAL_BYTES, TRIAL_MS, billingFromSettings } from "../src/billing-rules.ts";
import type { Deps } from "../src/ports.ts";
import { STRIPE_API_VERSION, stripeOverFetch } from "../src/stripe.ts";
import { usageOf } from "../src/usage.ts";
import { BILLING, BILLING_CONFIG, FakeStripe, eventOf, notify, sessionOf, v1Of, withBilling } from "./fake-stripe.ts";
import { clone, fixtures, send, uploadTour, type Json } from "./bundle.ts";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

afterEach(() => vi.restoreAllMocks());

/** A site with billing on, a clock that moves only when told, and two accounts with sessions. */
async function site(opts: { billing?: boolean; config?: Record<string, unknown> } = {}) {
  const ctx = await makeDeps(opts.config ?? {});
  let now = T0;
  ctx.deps.now = () => now;
  const stripe = opts.billing === false ? null : withBilling(ctx.deps);
  // A site signs in only once it has an admin; the admin's own workspace is exempt, A's and B's are not.
  const admin = await seedAccount(ctx.deps, { username: "siteadmin", admin: true });
  const a = await seedAccount(ctx.deps, { username: "alpha" });
  const b = await seedAccount(ctx.deps, { username: "bravo" });
  const sa = await sessionOf(ctx.deps, a.userId);
  const sb = await sessionOf(ctx.deps, b.userId);
  return { ...ctx, stripe: stripe as FakeStripe, admin, a, b, sa, sb, advance: (ms: number) => (now += ms), at: (ms: number) => (now = ms) };
}

const asSession = (deps: Deps, method: string, path: string, headers: Record<string, string>) => send(deps, method, path, { headers });
const rowOf = (deps: Deps, id: string) => deps.db.first<Json>("SELECT * FROM workspace WHERE id = ?", [id]);

function manifest(title = "Billing"): Json {
  const m = clone(fixtures.v2 as Json);
  m.title = title;
  m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
  return m;
}

/** Subscribe as this session, then Stripe's completed notice for a live subscription: the workspace is subscribed. */
async function subscribe(deps: Deps, stripe: FakeStripe, workspaceId: string, headers: Record<string, string>, ids: { customer: string; subscription: string }, status = "active") {
  const r = await asSession(deps, "POST", BILLING_PATHS.checkout, headers);
  expect(r.status, r.text).toBe(200);
  const checkout = (await rowOf(deps, workspaceId))!.checkout_session_id as string;
  stripe.subscription(ids.subscription, ids.customer, status);
  const n = await notify(deps, eventOf("checkout.session.completed", { id: checkout, object: "checkout.session", client_reference_id: workspaceId, customer: ids.customer, subscription: ids.subscription, payment_status: "paid" }));
  expect(n.status, n.text).toBe(200);
  return checkout;
}

describe("the settings switch", () => {
  it("billing is on only with all four settings, each of its shape; a missing one is off, a wrong one a problem naming the setting and never the value", () => {
    const all = { STRIPE_API_KEY: "rk_test_FAKE", STRIPE_WEBHOOK_SECRET: "whsec_FAKE", STRIPE_PRICE_ID: "price_FAKE", STRIPE_PUBLISHABLE_KEY: "pk_test_FAKE" };
    expect(billingFromSettings(all)).toEqual({ ok: true, billing: BILLING });
    expect(billingFromSettings({ ...all, STRIPE_API_KEY: " sk_test_FAKE \n" })).toEqual({ ok: true, billing: { ...BILLING, apiKey: "sk_test_FAKE" } });
    expect(billingFromSettings({})).toEqual({ ok: true, billing: null });
    for (const name of Object.keys(all) as (keyof typeof all)[]) {
      expect(billingFromSettings({ ...all, [name]: undefined }), name).toEqual({ ok: true, billing: null });
      expect(billingFromSettings({ ...all, [name]: "  " }), name).toEqual({ ok: true, billing: null });
      for (const bad of ["xx_FAKE_VALUE_123", "pk_wrong_FAKE", 42]) {
        if (name === "STRIPE_PUBLISHABLE_KEY" && bad === "pk_wrong_FAKE") continue;
        const r = billingFromSettings({ ...all, [name]: bad });
        expect(r.ok, `${name} ${bad}`).toBe(false);
        if (r.ok) continue;
        expect(r.problem).toContain(name);
        expect(r.problem).not.toContain(String(bad));
        for (const v of Object.values(all)) expect(r.problem).not.toContain(v);
      }
    }
    // Only the prefix of a key is looked at.
    expect(billingFromSettings({ ...all, STRIPE_API_KEY: "rk_" }).ok).toBe(true);
  });

  it("without the settings: no billing route exists, the session says nothing of billing, the allowance and every refusal are as before, and Stripe is never asked", async () => {
    const off = await site({ billing: false, config: { storageAllowanceBytes: 1_000_000 } });
    // A Stripe client on deps that is never used: the switch is the settings.
    const stripe = new FakeStripe();
    off.deps.stripe = stripe;
    const never = await send(off.deps, "GET", "/no/such/path");
    const paths: [string, string][] = [
      ["GET", BILLING_PATHS.state],
      ["POST", BILLING_PATHS.checkout],
      ["POST", BILLING_PATHS.portal],
      ["POST", BILLING_PATHS.listener],
      ["GET", "/billing/subscribe"],
      ["GET", "/billing/return"],
      ["GET", "/dash/billing.js"],
      ["GET", "/dash/billing-subscribe.js"],
      ["GET", "/dash/billing-return.js"],
    ];
    for (const [method, path] of paths) {
      for (const headers of [{}, off.sa.headers]) {
        const r = await send(off.deps, method, path, { headers });
        expect({ s: r.status, t: r.text, h: [...r.headers.entries()] }, `${method} ${path}`).toEqual({ s: never.status, t: never.text, h: [...never.headers.entries()] });
      }
    }
    const session = await asSession(off.deps, "GET", "/api/v1/session", off.sa.headers);
    expect(Object.keys(session.json).sort()).toEqual(["account", "csrf", "download_url", "email_change", "limits", "session", "workspace"]);
    // A workspace long past 90 days uploads, and has the site's default allowance.
    off.advance(TRIAL_MS + 10 * DAY);
    expect((await usageOf(off.deps, off.a.workspaceId)).allowance).toBe(1_000_000);
    await uploadTour(off.deps, off.a.token, manifest());
    expect(stripe.calls).toEqual([]);
  });

  it("the route table without the settings is the table with them minus billing's nine routes", () => {
    const keys = (deps: Deps) => createApp(deps).routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    const on = keys({ config: BILLING_CONFIG } as Deps);
    const offKeys = keys({ config: { publicImageBase: "", setupCode: null } } as Deps);
    const billing = on.filter((k) => !offKeys.includes(k));
    expect(billing.sort()).toEqual(
      [
        "GET /api/v1/billing",
        "POST /api/v1/billing/checkout",
        "POST /api/v1/billing/portal",
        "POST /api/v1/billing/webhook",
        "GET /billing/subscribe",
        "GET /dash/billing-subscribe.js",
        "GET /billing/return",
        "GET /dash/billing-return.js",
        "GET /dash/billing.js",
      ].sort(),
    );
    expect(offKeys.filter((k) => !on.includes(k))).toEqual([]);
  });
});

describe("the allowance and the read-only rule", () => {
  it("a new workspace is on a 100 MB trial, a subscribed or ended one has 5 GiB, an existing account, an admin or an admin-set allowance has what it had", async () => {
    const s = await site({ config: { storageAllowanceBytes: 777_000 } });
    const allowance = async (id: string) => (await usageOf(s.deps, id)).allowance;
    expect(await allowance(s.a.workspaceId)).toBe(TRIAL_BYTES);
    expect(TRIAL_BYTES).toBe(104_857_600);
    expect(PLAN_BYTES).toBe(5_368_709_120);
    for (const status of ["active", "trialing", "past_due", "canceled", "unpaid", "incomplete_expired"]) {
      await s.deps.db.run("UPDATE workspace SET subscription_status = ? WHERE id = ?", [status, s.a.workspaceId]);
      expect(await allowance(s.a.workspaceId), status).toBe(PLAN_BYTES);
    }
    for (const status of ["incomplete", "paused"]) {
      await s.deps.db.run("UPDATE workspace SET subscription_status = ? WHERE id = ?", [status, s.a.workspaceId]);
      expect(await allowance(s.a.workspaceId), status).toBe(TRIAL_BYTES);
    }
    // An admin-set allowance wins over the trial's and the plan's.
    await s.deps.db.run("UPDATE workspace SET storage_allowance_bytes = 123 WHERE id = ?", [s.a.workspaceId]);
    expect(await allowance(s.a.workspaceId)).toBe(123);
    await s.deps.db.run("UPDATE workspace SET subscription_status = 'active' WHERE id = ?", [s.a.workspaceId]);
    expect(await allowance(s.a.workspaceId)).toBe(123);
    // A workspace made while billing was off (billing_trial 0) and an admin keep the site's default.
    await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.b.workspaceId]);
    expect(await allowance(s.b.workspaceId)).toBe(777_000);
    const admin = await seedAccount(s.deps, { username: "boss", admin: true });
    expect(await allowance(admin.workspaceId)).toBe(777_000);
    // The admin's list shows the same numbers.
    const adminSession = await sessionOf(s.deps, admin.userId);
    const list = await asSession(s.deps, "GET", "/api/v1/admin/accounts", adminSession.headers);
    const byWs = Object.fromEntries((list.json.accounts as Json[]).map((x) => [x.workspace_id, x.allowance_bytes]));
    expect(byWs[s.a.workspaceId]).toBe(123);
    expect(byWs[s.b.workspaceId]).toBe(777_000);
  });

  it("an upload past the trial's allowance is refused as storage_full", async () => {
    const s = await site();
    // A tour that already holds the whole trial allowance.
    await s.deps.db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'Full', 'fullfullfu', 'draft', 1, 1)", [`tour_${"f".repeat(24)}`, s.a.workspaceId]);
    await s.deps.db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES (?, ?, 'C', 0)", [`ch_${"f".repeat(24)}`, `tour_${"f".repeat(24)}`]);
    await s.deps.db.run("INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, notes) VALUES (?, ?, ?, 0, 'u/x/step-001.png', 'png', 10, 10, ?, '[]')", [`st_${"f".repeat(24)}`, `tour_${"f".repeat(24)}`, `ch_${"f".repeat(24)}`, TRIAL_BYTES]);
    const r = await send(s.deps, "POST", "/api/v1/uploads", { token: s.a.token, body: JSON.stringify({ manifest: manifest(), target: { kind: "new" } }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(413);
    expect(r.json.allowance_bytes).toBe(TRIAL_BYTES);
  });

  it("upload, publish and share are refused with 402 subscription_ended when the trial is over or the subscription ended; view, download and delete still work; trial, subscribed, existing, admin and admin-set workspaces are not refused", async () => {
    const s = await site();
    const tour = await uploadTour(s.deps, s.a.token, manifest());
    const refusal = { error: SUBSCRIPTION_ENDED.error, detail: SUBSCRIPTION_ENDED.detail };
    const tries = (token: string, headers: Record<string, string>) => [
      () => send(s.deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest: manifest("New"), target: { kind: "new" } }), headers: { "content-type": "application/json" } }),
      () => send(s.deps, "POST", "/api/v1/media", { token, body: JSON.stringify({ kind: "image", content_type: "image/png", bytes: 100, width: 8, height: 8, title: "x" }), headers: { "content-type": "application/json" } }),
      () => send(s.deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token }),
      () => send(s.deps, "PUT", `/api/v1/tours/${tour.tour_id}/access`, { headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ access: "public" }) }),
      () => send(s.deps, "PUT", `/api/v1/media/med_${"0".repeat(24)}/access`, { headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ access: "public" }) }),
    ];
    const expectRefused = async (why: string) => {
      // A session made now: the clock moved past the first session's life.
      const fresh = await sessionOf(s.deps, s.a.userId);
      for (const t of tries(s.a.token, fresh.headers)) {
        const r = await t();
        expect([r.status, r.json], why).toEqual([402, refusal]);
      }
      // View, download and delete.
      expect((await send(s.deps, "GET", "/api/v1/tours", { token: s.a.token })).status, why).toBe(200);
      expect((await send(s.deps, "GET", "/api/v1/usage", { token: s.a.token })).status, why).toBe(200);
    };
    const expectAllowed = async (why: string) => {
      const r = await tries(s.a.token, s.sa.headers)[0]();
      expect(r.status, `${why}: ${r.text}`).toBe(201);
      await send(s.deps, "DELETE", `/api/v1/uploads/${r.json.upload_id}`, { token: s.a.token });
    };
    await expectAllowed("on the trial");
    s.advance(TRIAL_MS + DAY);
    await expectRefused("the trial is over");
    for (const status of ["active", "trialing", "past_due"]) {
      await s.deps.db.run("UPDATE workspace SET subscription_status = ? WHERE id = ?", [status, s.a.workspaceId]);
      await expectAllowed(status);
    }
    for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
      await s.deps.db.run("UPDATE workspace SET subscription_status = ? WHERE id = ?", [status, s.a.workspaceId]);
      await expectRefused(status);
    }
    await s.deps.db.run("UPDATE workspace SET storage_allowance_bytes = 999999999 WHERE id = ?", [s.a.workspaceId]);
    await s.deps.db.run("UPDATE workspace SET subscription_status = NULL WHERE id = ?", [s.a.workspaceId]);
    await expectAllowed("an admin-set allowance");
    await s.deps.db.run("UPDATE workspace SET storage_allowance_bytes = NULL, billing_trial = 0 WHERE id = ?", [s.a.workspaceId]);
    await expectAllowed("an existing account");
    await s.deps.db.run("UPDATE workspace SET billing_trial = 1 WHERE id = ?", [s.a.workspaceId]);
    await s.deps.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [s.a.userId]);
    await expectAllowed("an admin");
    await s.deps.db.run("UPDATE user SET is_admin = 0 WHERE id = ?", [s.a.userId]);
    // Delete still works for a read-only workspace.
    expect((await send(s.deps, "DELETE", `/api/v1/tours/${tour.tour_id}`, { token: s.a.token })).status).toBeLessThan(300);
    // The other workspace, still on its trial... is past it too (same clock): its state is its own.
    expect((await rowOf(s.deps, s.b.workspaceId))!.subscription_status).toBeNull();
  });

  it("a workspace made with billing on is on the trial clock", async () => {
    const s = await site();
    expect((await rowOf(s.deps, s.a.workspaceId))!.billing_trial).toBe(1);
  });
});

describe("Subscribe", () => {
  it("asks Stripe for an embedded checkout with exactly the allowed parameters, stores its id before answering, and answers the client secret and the publishable key", async () => {
    const s = await site();
    const r = await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ client_secret: "cs_test_1_secret_FAKE1", publishable_key: "pk_test_FAKE" });
    const [call] = s.stripe.to("/v1/checkout/sessions");
    expect(call.method).toBe("POST");
    expect(call.key).toMatch(/^checkout_ws_[0-9a-f]{24}_none_[0-9a-f]{32}$/);
    const form = Object.fromEntries(call.form!);
    expect(Object.keys(form).sort()).toEqual(["client_reference_id", "customer_email", "expires_at", "line_items[0][price]", "line_items[0][quantity]", "managed_payments[enabled]", "mode", "return_url", "ui_mode"]);
    expect(form).toEqual({
      mode: "subscription",
      "line_items[0][price]": "price_FAKE",
      "line_items[0][quantity]": "1",
      "managed_payments[enabled]": "true",
      ui_mode: "embedded_page",
      expires_at: String(T0 / 1000 + 31 * 60),
      return_url: "https://tours.example.com/billing/return?session_id={CHECKOUT_SESSION_ID}",
      client_reference_id: s.a.workspaceId,
      customer_email: s.a.email,
    });
    for (const banned of ["success_url", "cancel_url", "automatic_tax", "tax_id_collection", "payment_method_types", "payment_method_configuration", "adaptive_pricing", "customer_update", "invoice_creation", "subscription_data", "shipping"]) {
      expect(call.form!.some(([k]) => k.startsWith(banned)), banned).toBe(false);
    }
    const row = (await rowOf(s.deps, s.a.workspaceId))!;
    expect([row.checkout_session_id, row.checkout_created_at]).toEqual(["cs_test_1", T0]);
    // The secret is in no audit row and no stored column.
    const everything = JSON.stringify(await s.deps.db.all("SELECT * FROM audit")) + JSON.stringify(await s.deps.db.all("SELECT * FROM workspace"));
    expect(everything).not.toContain("secret");
    expect(await s.deps.db.all("SELECT event, workspace_id FROM audit WHERE event LIKE 'billing%'")).toEqual([{ event: "billing_checkout_started", workspace_id: s.a.workspaceId }]);
    // The other workspace's own Subscribe is its own checkout, never A's.
    const rb = await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sb.headers);
    expect(rb.json.client_secret).toBe("cs_test_2_secret_FAKE2");
    expect((await rowOf(s.deps, s.b.workspaceId))!.checkout_session_id).toBe("cs_test_2");
    expect((await rowOf(s.deps, s.a.workspaceId))!.checkout_session_id).toBe("cs_test_1");
  });

  it("takes a signed-in session alone: a token gets 401 and Stripe is not asked", async () => {
    const s = await site();
    const r = await send(s.deps, "POST", BILLING_PATHS.checkout, { token: s.a.token });
    expect([r.status, r.json]).toEqual([401, { error: "unauthorized" }]);
    expect((await send(s.deps, "GET", BILLING_PATHS.state, { token: s.a.token })).status).toBe(401);
    expect((await send(s.deps, "POST", BILLING_PATHS.portal, { token: s.a.token })).status).toBe(401);
    expect(s.stripe.calls).toEqual([]);
  });

  it("a second Subscribe while one is pending answers the same checkout; two at the same moment get one checkout; one while a subscription is live is refused", async () => {
    const s = await site();
    const [one, two] = await Promise.all([asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers), asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers)]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.json.client_secret).toBe(two.json.client_secret);
    expect(s.stripe.sessions.size).toBe(1);
    const again = await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    expect(again.json.client_secret).toBe(one.json.client_secret);
    expect(s.stripe.to("/v1/checkout/sessions/cs_test_1").length).toBe(1);
    // An expired checkout is replaced by a new one, stored in its place.
    s.stripe.sessions.get("cs_test_1")!.status = "expired";
    const fresh = await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    expect(fresh.json.client_secret).toBe("cs_test_2_secret_FAKE2");
    expect((await rowOf(s.deps, s.a.workspaceId))!.checkout_session_id).toBe("cs_test_2");
    // Paid: live, so Subscribe is refused without asking Stripe.
    s.stripe.subscription("sub_A", "cus_A", "active");
    await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_2", client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A", payment_status: "paid" }));
    const before = s.stripe.calls.length;
    const live = await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    expect([live.status, live.json.error]).toEqual([409, "already_subscribed"]);
    expect(s.stripe.calls.length).toBe(before);
  });

  it("with a customer on record the checkout names it and no email; Stripe unreachable answers 502 and stores nothing", async () => {
    const s = await site();
    await s.deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_OLD', stripe_subscription_id = 'sub_OLD', subscription_status = 'canceled' WHERE id = ?", [s.a.workspaceId]);
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    const form = Object.fromEntries(s.stripe.to("/v1/checkout/sessions")[0].form!);
    expect(form.customer).toBe("cus_OLD");
    expect(form.customer_email).toBeUndefined();
    s.stripe.down = true;
    const r = await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sb.headers);
    expect([r.status, r.json.error]).toEqual([502, "stripe_unavailable"]);
    expect((await rowOf(s.deps, s.b.workspaceId))!.checkout_session_id).toBeNull();
  });

  it("the client over fetch sends the key as a Bearer token, the pinned version, the idempotency key and a form body, and its errors carry no key", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = stripeOverFetch("rk_test_FAKE", async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return new Response('{"id":"cs_test_9"}', { status: 200 });
    });
    const a = await client.call("POST", "/v1/checkout/sessions", [["line_items[0][price]", "price_FAKE"], ["return_url", "https://x.example/r?session_id={CHECKOUT_SESSION_ID}"]], "key_1");
    expect(a).toEqual({ status: 200, body: { id: "cs_test_9" } });
    const h = seen[0].init.headers as Record<string, string>;
    expect(seen[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(h).toEqual({ authorization: "Bearer rk_test_FAKE", "stripe-version": STRIPE_API_VERSION, "idempotency-key": "key_1", "content-type": "application/x-www-form-urlencoded" });
    expect(STRIPE_API_VERSION).toBe("2026-04-22.dahlia");
    expect(seen[0].init.body).toBe("line_items%5B0%5D%5Bprice%5D=price_FAKE&return_url=https%3A%2F%2Fx.example%2Fr%3Fsession_id%3D%7BCHECKOUT_SESSION_ID%7D");
    const failing = stripeOverFetch("rk_test_FAKE", async () => {
      throw new Error("connect failed for Bearer rk_test_FAKE");
    });
    await expect(failing.call("GET", "/v1/subscriptions/sub_1")).rejects.toThrow(/^stripe: unreachable$/);
    await expect(client.call("GET", "/v1/subscriptions/../../x")).rejects.toThrow("stripe: bad path");
  });
});

describe("Manage subscription", () => {
  it("opens Stripe's page for the customer on the workspace's own record, and nothing without one", async () => {
    const s = await site();
    const none = await asSession(s.deps, "POST", BILLING_PATHS.portal, s.sa.headers);
    expect([none.status, none.json.error]).toEqual([409, "no_subscription"]);
    await subscribe(s.deps, s.stripe, s.a.workspaceId, s.sa.headers, { customer: "cus_A", subscription: "sub_A" });
    const r = await asSession(s.deps, "POST", BILLING_PATHS.portal, s.sa.headers);
    expect(r.json).toEqual({ url: "https://billing.stripe.com/p/session/test_FAKE" });
    expect(Object.fromEntries(s.stripe.to("/v1/billing_portal/sessions")[0].form!)).toEqual({ customer: "cus_A", return_url: "https://tours.example.com/account" });
    // B has no customer: B's portal is refused, never A's customer.
    expect((await asSession(s.deps, "POST", BILLING_PATHS.portal, s.sb.headers)).status).toBe(409);
    expect(s.stripe.to("/v1/billing_portal/sessions").length).toBe(1);
  });
});

describe("the listener's signature", () => {
  const body = '{"id":"evt_x","type":"ping","data":{"object":{}}}';
  const now = 1_800_000_000_000;
  const t = now / 1000;
  const enc = (x: string) => new TextEncoder().encode(x);

  it("accepts any matching v1 in any order, and refuses a forged, stale, future, altered or missing one", async () => {
    const good = await v1Of("whsec_FAKE", t, body);
    const bad = await v1Of("whsec_OTHER", t, body);
    const ok = (h: string | null, b = body, at = now) => verifyStripeSignature(h, enc(b), "whsec_FAKE", at);
    expect(await ok(`t=${t},v1=${good}`)).toBe(true);
    expect(await ok(`t=${t},v1=${bad},v1=${good}`)).toBe(true);
    expect(await ok(`v0=abc,v1=${good},t=${t},x=1`)).toBe(true);
    expect(await ok(`t=${t},v1=${bad}`)).toBe(false);
    expect(await ok(`t=${t},v0=${good}`)).toBe(false);
    expect(await ok(`t=${t}`)).toBe(false);
    expect(await ok(`v1=${good}`)).toBe(false);
    expect(await ok(`t=${t},t=${t},v1=${good}`)).toBe(false);
    expect(await ok(null)).toBe(false);
    expect(await ok(`t=${t},v1=${good}`, body.replace("ping", "pinh"))).toBe(false);
    expect(await ok(`t=${t},v1=${good}`, body, now + 301_000)).toBe(false);
    expect(await ok(`t=${t},v1=${good}`, body, now - 301_000)).toBe(false);
    expect(await ok(`t=${t},v1=${good}`, body, now + 299_000)).toBe(true);
    expect(await ok(`t=${t},v1=${good}`, body, now - 299_000)).toBe(true);
  });

  it("a refused notice answers 400 with one fixed body, writes nothing and asks Stripe nothing", async () => {
    const s = await site();
    const e = eventOf("customer.subscription.updated", { id: "sub_A", customer: "cus_A" });
    const text = JSON.stringify(e);
    const tNow = Math.floor(s.deps.now() / 1000);
    const cases: [string, Promise<Awaited<ReturnType<typeof notify>>>][] = [
      ["forged", notify(s.deps, e, { secret: "whsec_OTHER" })],
      ["stale", notify(s.deps, e, { t: tNow - 301 })],
      ["future", notify(s.deps, e, { t: tNow + 301 })],
      ["no header", notify(s.deps, e, { header: "" })],
      ["altered by one byte", (async () => notify(s.deps, text.replace("sub_A", "sub_B"), { header: `t=${tNow},v1=${await v1Of("whsec_FAKE", tNow, text)}` }))()],
      ["oversized", notify(s.deps, JSON.stringify({ ...e, pad: "x".repeat(LISTENER_MAX_BYTES) }))],
      ["not JSON", notify(s.deps, "not json")],
      ["no id", notify(s.deps, { type: "invoice.paid", data: { object: {} } })],
    ];
    for (const [what, p] of cases) {
      const r = await p;
      expect([r.status, r.text], what).toEqual([400, '{"error":"bad_notice"}']);
    }
    expect(await s.deps.db.all("SELECT * FROM stripe_event")).toEqual([]);
    expect(s.stripe.calls).toEqual([]);
  });
});

describe("the listener", () => {
  it("a completed checkout found by its stored id switches its workspace on from what Stripe says now, and nothing of another", async () => {
    const s = await site();
    const bBefore = await rowOf(s.deps, s.b.workspaceId);
    await subscribe(s.deps, s.stripe, s.a.workspaceId, s.sa.headers, { customer: "cus_A", subscription: "sub_A" });
    const row = (await rowOf(s.deps, s.a.workspaceId))!;
    expect(row).toMatchObject({ stripe_customer_id: "cus_A", stripe_subscription_id: "sub_A", subscription_status: "active", subscription_period_end: 1_900_000_000_000, checkout_session_id: null, checkout_created_at: null });
    expect(await rowOf(s.deps, s.b.workspaceId)).toEqual(bBefore);
    expect((await usageOf(s.deps, s.a.workspaceId)).allowance).toBe(PLAN_BYTES);
    expect(await s.deps.db.all("SELECT event, workspace_id, detail FROM audit WHERE event = 'billing_changed'")).toEqual([{ event: "billing_changed", workspace_id: s.a.workspaceId, detail: '{"status":"active","was":"none","cancelling":0,"linked":1}' }]);
    expect(s.stripe.to("/v1/subscriptions/sub_A").length).toBe(1);
  });

  it("a notice sent twice does its work once", async () => {
    const s = await site();
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    s.stripe.subscription("sub_A", "cus_A", "active");
    const e = eventOf("checkout.session.completed", { id: "cs_test_1", client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A" });
    expect((await notify(s.deps, e)).status).toBe(200);
    expect((await notify(s.deps, e)).status).toBe(200);
    expect(s.stripe.to("/v1/subscriptions/sub_A").length).toBe(1);
    expect(await s.deps.db.all("SELECT id FROM stripe_event")).toEqual([{ id: e.id }]);
  });

  it("when the read-back fails nothing changes, the notice is not recorded and the answer is 500; Stripe's retry then works", async () => {
    const s = await site();
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    s.stripe.subscription("sub_A", "cus_A", "active");
    const before = await rowOf(s.deps, s.a.workspaceId);
    const e = eventOf("checkout.session.completed", { id: "cs_test_1", client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A" });
    s.stripe.failing.add("/v1/subscriptions/sub_A");
    const r = await notify(s.deps, e);
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(/sub_A|cus_A|whsec|rk_/);
    expect(await rowOf(s.deps, s.a.workspaceId)).toEqual(before);
    expect(await s.deps.db.all("SELECT * FROM stripe_event")).toEqual([]);
    s.stripe.down = true;
    expect((await notify(s.deps, e)).status).toBe(500);
    s.stripe.down = false;
    s.stripe.failing.clear();
    expect((await notify(s.deps, e)).status).toBe(200);
    expect((await rowOf(s.deps, s.a.workspaceId))!.subscription_status).toBe("active");
  });

  it("a completed checkout whose id no workspace stored changes nothing; one whose reference or customer is another workspace's is audited and ignored", async () => {
    const s = await site();
    const dump = async () => JSON.stringify(await s.deps.db.all("SELECT * FROM workspace ORDER BY id"));
    s.stripe.subscription("sub_X", "cus_X", "active");
    const before = await dump();
    expect((await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_unknown", client_reference_id: s.a.workspaceId, customer: "cus_X", subscription: "sub_X" }))).status).toBe(200);
    expect(await dump()).toEqual(before);
    // A's stored checkout, but the reference names B.
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    const mid = await dump();
    expect((await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_1", client_reference_id: s.b.workspaceId, customer: "cus_X", subscription: "sub_X" }))).status).toBe(200);
    expect(await dump()).toEqual(mid);
    // B pays first and holds cus_B; A's checkout then completes for B's customer.
    await subscribe(s.deps, s.stripe, s.b.workspaceId, s.sb.headers, { customer: "cus_B", subscription: "sub_B" });
    s.stripe.subscription("sub_Y", "cus_B", "active");
    const aBefore = await rowOf(s.deps, s.a.workspaceId);
    const bBefore = await rowOf(s.deps, s.b.workspaceId);
    expect((await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_1", client_reference_id: s.a.workspaceId, customer: "cus_B", subscription: "sub_Y" }))).status).toBe(200);
    expect(await rowOf(s.deps, s.a.workspaceId)).toEqual(aBefore);
    expect(await rowOf(s.deps, s.b.workspaceId)).toEqual(bBefore);
    const events = (await s.deps.db.all<{ event: string }>("SELECT event FROM audit WHERE event LIKE 'billing_checkout_%' ORDER BY at, rowid")).map((x) => x.event);
    expect(events).toContain("billing_checkout_unmatched");
    expect(events.filter((x) => x === "billing_checkout_mismatch").length).toBe(2);
  });

  it("notices out of order: deleted before completed, and updated after deleted, end as Stripe says now", async () => {
    const s = await site();
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    s.stripe.subscription("sub_A", "cus_A", "canceled", { endedAt: 1_800_000_100 });
    // Deleted first: no workspace holds sub_A yet, and a checkout is pending: answered 500, to come back after the link.
    expect((await notify(s.deps, eventOf("customer.subscription.deleted", { id: "sub_A", customer: "cus_A", status: "canceled" }))).status).toBe(500);
    expect((await rowOf(s.deps, s.a.workspaceId))!.subscription_status).toBeNull();
    // Then the completed checkout: Stripe says canceled now, so canceled is stored.
    await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_1", client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A", payment_status: "paid" }));
    expect(await rowOf(s.deps, s.a.workspaceId)).toMatchObject({ subscription_status: "canceled", subscription_ended_at: 1_800_000_100_000 });
    // A late "updated" whose snapshot says active changes nothing: Stripe still says canceled.
    expect((await notify(s.deps, eventOf("customer.subscription.updated", { id: "sub_A", customer: "cus_A", status: "active" }))).status).toBe(200);
    expect((await rowOf(s.deps, s.a.workspaceId))!.subscription_status).toBe("canceled");
    const r = await send(s.deps, "POST", "/api/v1/uploads", { token: s.a.token, body: JSON.stringify({ manifest: manifest(), target: { kind: "new" } }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(402);
  });

  it("the delayed-payment pair: succeeded acts only when paid, failed is audited only", async () => {
    const s = await site();
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    s.stripe.subscription("sub_A", "cus_A", "active");
    const obj = { id: "cs_test_1", client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A" };
    await notify(s.deps, eventOf("checkout.session.async_payment_failed", obj));
    await notify(s.deps, eventOf("checkout.session.async_payment_succeeded", { ...obj, payment_status: "unpaid" }));
    expect((await rowOf(s.deps, s.a.workspaceId))!.subscription_status).toBeNull();
    expect(s.stripe.to("/v1/subscriptions/sub_A")).toEqual([]);
    await notify(s.deps, eventOf("checkout.session.async_payment_succeeded", { ...obj, payment_status: "paid" }));
    expect((await rowOf(s.deps, s.a.workspaceId))!.subscription_status).toBe("active");
    expect((await s.deps.db.all("SELECT event FROM audit WHERE event = 'billing_payment_failed'")).length).toBe(1);
  });

  it("later notices find the workspace by its own customer or subscription: a failed renewal is past due, a cancellation is set to end, and a notice of another customer touches nobody", async () => {
    const s = await site();
    await subscribe(s.deps, s.stripe, s.a.workspaceId, s.sa.headers, { customer: "cus_A", subscription: "sub_A" });
    s.stripe.subscription("sub_A", "cus_A", "past_due");
    await notify(s.deps, eventOf("invoice.payment_failed", { id: "in_1", customer: "cus_A", parent: { subscription_details: { subscription: "sub_A" } } }));
    expect((await rowOf(s.deps, s.a.workspaceId))!.subscription_status).toBe("past_due");
    expect((await usageOf(s.deps, s.a.workspaceId)).allowance).toBe(PLAN_BYTES);
    s.stripe.subscription("sub_A", "cus_A", "active", { cancelAtPeriodEnd: true });
    await notify(s.deps, eventOf("customer.subscription.updated", { id: "sub_A", customer: "cus_A" }));
    expect(await rowOf(s.deps, s.a.workspaceId)).toMatchObject({ subscription_status: "active", subscription_cancel_at_period_end: 1 });
    const state = await asSession(s.deps, "GET", BILLING_PATHS.state, s.sa.headers);
    expect(state.json).toMatchObject({ state: "ending", ends_at: 1_900_000_000_000, links_until: 1_900_000_000_000 + 30 * DAY, removed_at: 1_900_000_000_000 + 90 * DAY, manage: true });
    // Stripe's invoice for a customer nobody holds.
    const bBefore = await rowOf(s.deps, s.b.workspaceId);
    expect((await notify(s.deps, eventOf("invoice.paid", { id: "in_2", customer: "cus_NOBODY" }))).status).toBe(200);
    expect(await rowOf(s.deps, s.b.workspaceId)).toEqual(bBefore);
    // A subscription of A's customer that A never checked out is noted, never linked.
    s.stripe.subscription("sub_Z", "cus_A", "active");
    await notify(s.deps, eventOf("customer.subscription.created", { id: "sub_Z", customer: "cus_A" }));
    expect((await rowOf(s.deps, s.a.workspaceId))!.stripe_subscription_id).toBe("sub_A");
    expect((await s.deps.db.all("SELECT event FROM audit WHERE event = 'billing_unlinked_subscription'")).length).toBe(1);
    // Other types answer 200 and do nothing.
    const calls = s.stripe.calls.length;
    expect((await notify(s.deps, eventOf("customer.created", { id: "cus_A" }))).status).toBe(200);
    expect(s.stripe.calls.length).toBe(calls);
  });

  it("a second paid checkout never replaces a live subscription, and is audited", async () => {
    const s = await site();
    await subscribe(s.deps, s.stripe, s.a.workspaceId, s.sa.headers, { customer: "cus_A", subscription: "sub_A" });
    // A checkout stored by a request that raced the first one (stored after it went live).
    await s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES ('cs_test_race', ?, ?, ?)", [s.a.workspaceId, T0, T0 + 1_860_000]);
    await s.deps.db.run("UPDATE workspace SET checkout_session_id = 'cs_test_race', checkout_created_at = ? WHERE id = ?", [T0, s.a.workspaceId]);
    s.stripe.subscription("sub_A2", "cus_A", "active");
    await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_race", client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A2", payment_status: "paid" }));
    expect((await rowOf(s.deps, s.a.workspaceId))!.stripe_subscription_id).toBe("sub_A");
    expect((await s.deps.db.all("SELECT workspace_id FROM audit WHERE event = 'billing_second_subscription'"))).toEqual([{ workspace_id: s.a.workspaceId }]);
    // And a completed checkout of the same customer that no workspace stored is audited against A.
    await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_ghost", client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A3" }));
    expect(await s.deps.db.all("SELECT workspace_id, detail FROM audit WHERE event = 'billing_checkout_unmatched'")).toEqual([{ workspace_id: s.a.workspaceId, detail: '{"live":1}' }]);
  });

  it("refund, dispute and early fraud warning are audited against the workspace of the charge's customer, then read back: a refund Stripe followed by cancelling ends it", async () => {
    const s = await site();
    await subscribe(s.deps, s.stripe, s.a.workspaceId, s.sa.headers, { customer: "cus_A", subscription: "sub_A" });
    s.stripe.charges.set("ch_1", { id: "ch_1", customer: "cus_A" });
    s.stripe.subscription("sub_A", "cus_A", "canceled", { endedAt: 1_800_000_500 });
    await notify(s.deps, eventOf("charge.refunded", { id: "ch_1", customer: "cus_A" }));
    expect((await rowOf(s.deps, s.a.workspaceId))!.subscription_status).toBe("canceled");
    await notify(s.deps, eventOf("charge.dispute.created", { id: "dp_1", charge: "ch_1" }));
    await notify(s.deps, eventOf("radar.early_fraud_warning.created", { id: "issfr_1", charge: "ch_1" }));
    expect((await s.deps.db.all<{ detail: string }>("SELECT detail FROM audit WHERE event = 'billing_risk' ORDER BY rowid")).map((x) => x.detail)).toEqual(['{"kind":"refund"}', '{"kind":"dispute"}', '{"kind":"fraud_warning"}']);
    expect((await s.deps.db.all("SELECT workspace_id FROM audit WHERE event = 'billing_risk' AND workspace_id <> ?", [s.a.workspaceId]))).toEqual([]);
    // A charge that cannot be read: nothing recorded, 500.
    s.stripe.failing.add("/v1/charges/ch_2");
    expect((await notify(s.deps, eventOf("charge.dispute.created", { id: "dp_2", charge: "ch_2" }))).status).toBe(500);
  });

  it("logs nothing of a key, the secret, a signature, a client secret or Stripe's body", async () => {
    const s = await site();
    const lines: string[] = [];
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    s.stripe.subscription("sub_A", "cus_A", "active");
    s.stripe.failing.add("/v1/subscriptions/sub_A");
    await notify(s.deps, eventOf("checkout.session.completed", { id: "cs_test_1", client_reference_id: s.a.workspaceId, customer: "cus_A", subscription: "sub_A" }));
    await notify(s.deps, eventOf("invoice.paid", { id: "in_1" }), { secret: "whsec_OTHER" });
    const all = lines.join("\n");
    for (const needle of ["rk_test_FAKE", "whsec_FAKE", "pk_test_FAKE", "_secret_", "v1=", "cus_A", "sub_A"]) expect(all).not.toContain(needle);
  });
});

describe("the state the dashboard reads", () => {
  it("answers the trial's days and dates, and a checkout's state only for the workspace's own checkout, byte for byte as for one that never existed otherwise", async () => {
    const s = await site();
    const r = await asSession(s.deps, "GET", BILLING_PATHS.state, s.sa.headers);
    expect(r.json).toEqual({
      state: "trial",
      plan: "Mythicshot Essentials",
      used_bytes: 0,
      allowance_bytes: TRIAL_BYTES,
      trial_ends_at: T0 + TRIAL_MS,
      days_left: 90,
      next_payment_at: null,
      ends_at: null,
      ended_at: null,
      links_until: null,
      removed_at: T0 + TRIAL_MS,
      manage: false,
      confirming: false,
      checkout: null,
    });
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sa.headers);
    await asSession(s.deps, "POST", BILLING_PATHS.checkout, s.sb.headers);
    const own = await asSession(s.deps, "GET", `${BILLING_PATHS.state}?session_id=cs_test_1`, s.sa.headers);
    expect(own.json.checkout).toBe("open");
    const calls = s.stripe.calls.length;
    const theirs = await asSession(s.deps, "GET", `${BILLING_PATHS.state}?session_id=cs_test_2`, s.sa.headers);
    const invented = await asSession(s.deps, "GET", `${BILLING_PATHS.state}?session_id=cs_test_999`, s.sa.headers);
    expect(theirs.text).toBe(invented.text);
    expect(theirs.json.checkout).toBeNull();
    expect(s.stripe.calls.length).toBe(calls);
    s.stripe.sessions.get("cs_test_1")!.status = "expired";
    expect((await asSession(s.deps, "GET", `${BILLING_PATHS.state}?session_id=cs_test_1`, s.sa.headers)).json.checkout).toBe("expired");
    // The day before the trial ends: one day left. After it: trial_over.
    s.advance(TRIAL_MS - DAY + 1);
    expect((await asSession(s.deps, "GET", BILLING_PATHS.state, (await sessionOf(s.deps, s.a.userId)).headers)).json.days_left).toBe(1);
    s.advance(DAY);
    expect((await asSession(s.deps, "GET", BILLING_PATHS.state, (await sessionOf(s.deps, s.a.userId)).headers)).json.state).toBe("trial_over");
  });

  it("an ended subscription shows when it ended, when links stop and when content is removed; an existing account is exempt", async () => {
    const s = await site();
    const ended = 1_800_000_000_000 + 5 * DAY;
    await s.deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_A', stripe_subscription_id = 'sub_A', subscription_status = 'canceled', subscription_ended_at = ? WHERE id = ?", [ended, s.a.workspaceId]);
    expect((await asSession(s.deps, "GET", BILLING_PATHS.state, s.sa.headers)).json).toMatchObject({ state: "ended", ended_at: ended, links_until: ended + 30 * DAY, removed_at: ended + 90 * DAY, manage: true });
    await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.b.workspaceId]);
    expect((await asSession(s.deps, "GET", BILLING_PATHS.state, s.sb.headers)).json.state).toBe("exempt");
    // The session says billing is on.
    expect((await asSession(s.deps, "GET", "/api/v1/session", s.sa.headers)).json.billing).toBe(true);
  });
});
