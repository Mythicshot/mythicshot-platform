// The removal's rework after the security review (0.1.61), on both targets: subscriptions that
// are not definitely cancelled are cancelled at Stripe before anything goes (H1), a sweep's removal
// re-checks the workspace before every pass and stops for good when it went live, took a checkout
// or left the clock (H2), an undo that lands mid-way is honoured (M1), a subscription that never
// went live is the trial (M2), the public bucket line (M3), the mail cap and unconfirmed claims
// (M4), Stripe's clock (M5), and the low items. Fake Stripe and the fake mailer only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedAccount } from "#harness";
import { MAILS_PER_RUN, billingSweep, clearClaim, sweepLines } from "../src/billing-sweep.ts";
import { BILLING_PATHS, billingProblems } from "../src/billing.ts";
import { DAY, TRIAL_MS } from "../src/billing-rules.ts";
import type { Stripe } from "../src/stripe.ts";
import { removalDayOf } from "../src/removal-rules.ts";
import { emailSha256 } from "../src/removal-store.ts";
import { send, type Json } from "./bundle.ts";
import { sessionOf } from "./fake-stripe.ts";
import { dumpOf } from "./isolation-world.ts";
import { ON_TIME, REMOVAL_DAY, T0, TRIAL_END, at3, audits, ended, exists, keysOf, mailsTo, publishedTour, site, sweep, userStatus, visit, warned, type Side, type Site } from "./removal-world.ts";

afterEach(() => vi.restoreAllMocks());

const ENDED_AT = Date.UTC(2027, 1, 12, 9, 0);
const ENDED_DAY = Date.UTC(2027, 4, 14);
const ENDED_WARNINGS: [number, number, number] = [at3(3, 14), at3(4, 7), at3(4, 13)];

/** B on an `unpaid` subscription (Stripe has it so too), its three warnings sent, at its removal day; A out of the way. */
async function unpaid(s: Site) {
  await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.a.workspaceId]);
  await ended(s, s.b, ENDED_AT, "B");
  await s.deps.db.run("UPDATE workspace SET subscription_status = 'unpaid' WHERE id = ?", [s.b.workspaceId]);
  s.stripe.subscription("sub_B", "cus_B", "unpaid", { periodEnd: Math.floor(ENDED_AT / 1000) });
  await warned(s, s.b, ENDED_DAY, ENDED_WARNINGS);
  s.at(at3(4, 14));
}

const tours = async (s: Site, side: Side) => (await s.deps.db.first<{ n: number }>("SELECT count(*) AS n FROM tour WHERE workspace_id = ?", [side.workspaceId]))!.n;
const removal = (s: Site, side: Side) => s.deps.db.first<Json>("SELECT * FROM account_removal WHERE workspace_id = ?", [side.workspaceId]);
const adminHeaders = async (s: Site) => ({ ...(await sessionOf(s.deps, s.admin.userId)).headers, "content-type": "application/json" });

/** Stripe as the fake, but its DELETE of a subscription fails as `how` says. */
function cancelFails(s: Site, how: "unreachable" | "not_cancelled") {
  const real = s.stripe;
  const wrapped: Stripe = {
    async call(method, path, form, key) {
      if (method === "DELETE" && path.startsWith("/v1/subscriptions/")) {
        real.calls.push({ method, path, form: null, key });
        if (how === "unreachable") throw new Error("stripe: unreachable");
        return { status: 200, body: { ...real.subscriptions.get(path.split("/")[3]) }, date: new Date(s.now()).toUTCString() };
      }
      return real.call(method, path, form, key);
    },
  };
  s.deps.stripe = wrapped;
  return () => (s.deps.stripe = real);
}

describe("H1: a subscription not definitely cancelled is cancelled at Stripe before anything goes", () => {
  it("the sweep cancels an unpaid subscription, then removes; its data is all there when Stripe is asked to cancel", async () => {
    const s = await site();
    s.at(T0 + DAY);
    await publishedTour(s, s.b);
    await unpaid(s);
    let toursAtCancel = -1;
    s.stripe.hook = async (call) => {
      if (call.method === "DELETE") toursAtCancel = await tours(s, s.b);
    };
    await sweep(s);
    expect(toursAtCancel).toBe(1);
    expect(s.stripe.subscriptions.get("sub_B")!.status).toBe("canceled");
    expect(await exists(s.deps, s.b.workspaceId)).toBe(false);
  });

  it("an admin's delete cancels an unpaid subscription before anything goes", async () => {
    const s = await site();
    await publishedTour(s, s.b);
    await unpaid(s);
    let toursAtCancel = -1;
    s.stripe.hook = async (call) => {
      if (call.method === "DELETE") toursAtCancel = await tours(s, s.b);
    };
    const h = await adminHeaders(s);
    expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/disable`, { headers: h })).status).toBe(204);
    let r = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.b.userId}`, { headers: h, body: JSON.stringify({ username: "bravo" }) });
    while (r.status === 202) r = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.b.userId}`, { headers: h, body: JSON.stringify({ username: "bravo" }) });
    expect(r.status).toBe(200);
    expect(toursAtCancel).toBe(1);
    expect(s.stripe.subscriptions.get("sub_B")!.status).toBe("canceled");
  });

  it("Stripe unreachable at the cancel, or answering without cancelling, removes nothing, by the sweep or an admin", async () => {
    for (const how of ["unreachable", "not_cancelled"] as const) {
      const s = await site();
      s.at(T0 + DAY);
      await publishedTour(s, s.b);
      await unpaid(s);
      cancelFails(s, how);
      await sweep(s);
      expect(await tours(s, s.b), how).toBe(1);
      expect(await exists(s.deps, s.b.workspaceId), how).toBe(true);
      // The admin's delete is held back the same way.
      const h = await adminHeaders(s);
      const r = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.b.userId}`, { headers: h, body: JSON.stringify({ username: "bravo" }) });
      expect([r.status, r.json.error], how).toEqual([500, "cleanup_pending"]);
      expect(await tours(s, s.b), how).toBe(1);
    }
  });
});

describe("H2: a sweep's removal is re-checked before every pass, and stops for good", () => {
  it("an unpaid invoice paid after the start: the subscription is live, nothing is cancelled or deleted, the stop is a billing problem, and it is never continued", async () => {
    const s = await site();
    s.at(T0 + DAY);
    await publishedTour(s, s.b);
    await unpaid(s);
    const restore = cancelFails(s, "unreachable");
    await sweep(s);
    expect(await userStatus(s.deps, s.b.userId)).toBe("disabled");
    restore();
    // The customer pays the open invoice from Stripe's reminder.
    s.stripe.subscription("sub_B", "cus_B", "active", { periodEnd: Math.floor(Date.UTC(2027, 5, 14) / 1000) });
    const deletes = () => s.stripe.calls.filter((c) => c.method === "DELETE").length;
    const before = deletes();
    await sweep(s);
    expect(deletes()).toBe(before);
    expect(await tours(s, s.b)).toBe(1);
    expect(await removal(s, s.b)).toMatchObject({ work_started_at: null });
    expect((await removal(s, s.b))!.stopped_at).not.toBeNull();
    expect((await audits(s.deps, s.b.workspaceId, "billing_removal_stopped")).map((r) => JSON.parse(r.detail))).toEqual([{ reason: "live" }]);
    expect((await billingProblems(s.deps)).recent.map((r) => r.event)).toContain("billing_removal_stopped");
    // Never continued: later sweeps leave it as it is, and an admin can undo it.
    s.at(at3(4, 15));
    await sweep(s);
    expect(await tours(s, s.b)).toBe(1);
    expect(await audits(s.deps, s.b.workspaceId, "billing_removal_stopped")).toHaveLength(1);
    // A stopped removal is undone with what was removed counted (second review N3): nothing had gone.
    const undone = await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/undo-removal`, { headers: await adminHeaders(s) });
    expect([undone.status, undone.json]).toEqual([200, { restored: false, files_removed: 0 }]);
  });

  it("a checkout made after the start, or one not expired, and a workspace that left the clock, stop the removal", async () => {
    const cases: [string, (s: Site) => Promise<void>][] = [
      ["checkout", async (s) => {
        const started = (await removal(s, s.b))!.created_at as number;
        await s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES ('cs_test_late', ?, ?, ?)", [s.b.workspaceId, started + 1, started - DAY]);
      }],
      ["checkout", async (s) => void (await s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES ('cs_test_open', ?, 1, ?)", [s.b.workspaceId, s.now() + DAY]))],
      ["left_clock", async (s) => void (await s.deps.db.run("UPDATE workspace SET storage_allowance_bytes = 5 WHERE id = ?", [s.b.workspaceId]))],
      ["left_clock", async (s) => void (await s.deps.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [s.b.userId]))],
    ];
    for (const [reason, make] of cases) {
      const s = await site();
      s.at(T0 + DAY);
      await publishedTour(s, s.b);
      await unpaid(s);
      const restore = cancelFails(s, "unreachable");
      await sweep(s);
      restore();
      await make(s);
      await sweep(s);
      expect(await tours(s, s.b), reason).toBe(1);
      expect(s.stripe.subscriptions.get("sub_B")!.status, reason).toBe("unpaid");
      expect((await audits(s.deps, s.b.workspaceId, "billing_removal_stopped")).map((r) => JSON.parse(r.detail)), reason).toEqual([{ reason }]);
    }
  });

  it("the checkout route refuses while a removal is recorded: before Stripe is asked, and when the removal began while Stripe was asked", async () => {
    // A removal recorded before the press: Stripe is never asked.
    const s = await site();
    const h = (await sessionOf(s.deps, s.a.userId)).headers;
    await s.deps.db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, 0, ?)", [s.a.userId, s.a.workspaceId, s.admin.userId, s.now()]);
    const r = await send(s.deps, "POST", BILLING_PATHS.checkout, { headers: h });
    expect([r.status, r.json.error]).toEqual([409, "deleting"]);
    expect(s.stripe.calls.filter((c) => c.path === "/v1/checkout/sessions")).toEqual([]);
    // A removal that began while Stripe made the checkout: no secret handed out, the checkout expired, none pending.
    const t = await site();
    const ht = (await sessionOf(t.deps, t.a.userId)).headers;
    t.stripe.hook = async (call) => {
      if (call.method === "POST" && call.path === "/v1/checkout/sessions") {
        t.stripe.hook = null;
        await t.deps.db.batch([
          { sql: "UPDATE user SET status = 'disabled' WHERE id = ?", params: [t.a.userId] },
          { sql: "INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, 0, ?)", params: [t.a.userId, t.a.workspaceId, t.admin.userId, t.now()] },
        ]);
      }
    };
    const late = await send(t.deps, "POST", BILLING_PATHS.checkout, { headers: ht });
    expect([late.status, late.json.error]).toEqual([409, "deleting"]);
    expect(late.text).not.toContain("secret");
    expect([...t.stripe.sessions.values()].map((x) => x.status)).toEqual(["expired"]);
    expect((await t.deps.db.first<Json>("SELECT checkout_session_id FROM workspace WHERE id = ?", [t.a.workspaceId]))!.checkout_session_id).toBeNull();
  });
});

describe("M1: an undo that lands while the removal is asking Stripe is honoured", () => {
  it("by the sweep: nothing is removed, and the warnings start over", async () => {
    const s = await site();
    s.at(T0 + DAY);
    await publishedTour(s, s.b);
    await unpaid(s);
    const h = await adminHeaders(s);
    s.stripe.hook = async (call) => {
      if (call.method === "DELETE") {
        s.stripe.hook = null;
        expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/undo-removal`, { headers: h })).status).toBe(204);
      }
    };
    await sweep(s);
    expect(await tours(s, s.b)).toBe(1);
    expect(await removal(s, s.b)).toBeNull();
    expect(await s.deps.db.all("SELECT * FROM billing_warning WHERE workspace_id = ?", [s.b.workspaceId])).toEqual([]);
    expect((await audits(s.deps, s.b.workspaceId, "account_removal_undone")).map((r) => JSON.parse(r.detail))).toEqual([{ by: "billing_sweep" }]);
    expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/enable`, { headers: h })).status).toBe(204);
  });

  it("by an admin's delete: nothing is removed and the delete answers that nothing is recorded", async () => {
    const s = await site();
    await publishedTour(s, s.b);
    await unpaid(s);
    const h = await adminHeaders(s);
    expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/disable`, { headers: h })).status).toBe(204);
    s.stripe.hook = async (call) => {
      if (call.method === "DELETE") {
        s.stripe.hook = null;
        expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/undo-removal`, { headers: h })).status).toBe(204);
      }
    };
    const r = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.b.userId}`, { headers: h, body: JSON.stringify({ username: "bravo" }) });
    expect([r.status, r.json.error]).toEqual([409, "not_deleting"]);
    expect(await tours(s, s.b)).toBe(1);
    expect(await removal(s, s.b)).toBeNull();
  });
});

describe("M2: a subscription that never went live is the trial", () => {
  it("incomplete_expired keeps the trial's allowance, writes, links, mails and removal day from the workspace's creation", async () => {
    const s = await site();
    const tour = await publishedTour(s, s.a);
    await s.deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_A', stripe_subscription_id = 'sub_A', subscription_status = 'incomplete_expired', subscription_ended_at = ? WHERE id = ?", [T0 + DAY, s.a.workspaceId]);
    s.stripe.subscription("sub_A", "cus_A", "incomplete_expired");
    s.at(T0 + 40 * DAY);
    const state = (await send(s.deps, "GET", "/api/v1/billing", { headers: (await sessionOf(s.deps, s.a.userId)).headers })).json;
    expect([state.state, state.allowance_bytes, state.removed_at]).toEqual(["trial", 104_857_600, REMOVAL_DAY]);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(200);
    expect((await send(s.deps, "POST", `/api/v1/tours/${tour.id}/publish`, { token: s.a.token })).status).not.toBe(402);
    s.at(at3(2, 12));
    await sweep(s);
    expect(mailsTo(s, s.a.email).map((m) => m.subject)).toEqual(["Your Mythicshot trial ends in 30 days"]);
    s.at(TRIAL_END);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(404);
  });
});

describe("M3: a public bucket address", () => {
  it("the dry run says in one fixed line that pictures stay reachable", async () => {
    const s = await site();
    expect(sweepLines(await sweep(s, { dryRun: true })).join("\n")).not.toContain("public bucket");
    s.deps.config = { ...s.deps.config, publicImageBase: "https://images.example.com" };
    expect(sweepLines(await sweep(s, { dryRun: true }))).toContain(
      "PUBLIC_IMAGE_BASE is set: links coming down hides the pages, but the pictures stay reachable at their addresses on the public bucket until removal or unpublish.",
    );
  });
});

describe("M4: the mail cap and unconfirmed claims", () => {
  it("at most MAILS_PER_RUN mails a run, oldest due first; the rest the next run", async () => {
    expect(MAILS_PER_RUN).toBe(50);
    const s = await site();
    const later = await seedAccount(s.deps, { username: "later" });
    await s.deps.db.run("UPDATE workspace SET created_at = ? WHERE id = ?", [T0 - 2 * DAY, later.workspaceId]);
    s.at(at3(2, 12));
    const first = await sweep(s, { mailsPerRun: 1 });
    expect(first.mailsSent).toBe(1);
    expect(s.mail.sent.map((m) => m.to)).toEqual([later.email]);
    await sweep(s, { mailsPerRun: 1 });
    await sweep(s, { mailsPerRun: 1 });
    expect(s.mail.sent).toHaveLength(3);
  });

  it("the summary names the workspaces with an unconfirmed claim, and clearing one lets the mail go again, audited", async () => {
    const s = await site();
    await s.deps.db.run("INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, ?, 30, ?, ?, NULL, ?)", [s.a.workspaceId, REMOVAL_DAY, await emailSha256(s.a.email), at3(2, 12) - 60_000, REMOVAL_DAY]);
    s.at(at3(2, 12));
    const r = await sweep(s);
    expect(r.unconfirmedIds).toEqual([s.a.workspaceId]);
    expect(sweepLines(r)).toContain(`  unconfirmed ${s.a.workspaceId}`);
    expect(mailsTo(s, s.a.email)).toEqual([]);
    expect(await clearClaim(s.deps, s.a.workspaceId)).toBe(1);
    expect(await clearClaim(s.deps, s.a.workspaceId)).toBe(0);
    expect(await audits(s.deps, s.a.workspaceId, "billing_warning_claim_cleared")).toHaveLength(1);
    await sweep(s);
    expect(mailsTo(s, s.a.email)).toHaveLength(1);
  });
});

describe("M5: the server's clock against Stripe's", () => {
  it("more than an hour apart: nothing is removed in the run, with one fixed line; a trial asks Stripe once for the time", async () => {
    const s = await site();
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    await warned(s, s.b, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    s.stripe.skewMs = 2 * 3_600_000;
    const r = await sweep(s);
    expect(r.removalsStarted).toBe(0);
    expect(sweepLines(r)).toContain("The server's clock and Stripe's differ by more than an hour, so nothing was removed. Check the server's time.");
    expect(s.stripe.calls.filter((c) => c.path === "/v1/prices/price_FAKE")).toHaveLength(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    s.stripe.skewMs = 30 * 60_000;
    const ok = await sweep(s);
    expect(ok.removalsFinished).toBe(2);
    expect(s.stripe.calls.filter((c) => c.path === "/v1/prices/price_FAKE")).toHaveLength(2);
  });
});

describe("the low items", () => {
  it("a second sweep while one runs exits at once", async () => {
    const s = await site();
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    let inner: Awaited<ReturnType<typeof sweep>> | null = null;
    s.stripe.hook = async () => {
      s.stripe.hook = null;
      inner = await sweep(s);
    };
    await sweep(s);
    expect(inner!.alreadyRunning).toBe(true);
    expect(sweepLines(inner!)).toEqual(["A billing sweep is already running. Nothing was done."]);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(false);
  });

  it("the start re-checks the period's end and the cancel time as read", async () => {
    const s = await site();
    await ended(s, s.b, ENDED_AT, "B");
    await warned(s, s.b, ENDED_DAY, ENDED_WARNINGS);
    await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.a.workspaceId]);
    s.at(at3(4, 14));
    s.stripe.hook = async (call) => {
      if (call.method === "GET" && call.path === "/v1/subscriptions/sub_B") {
        s.stripe.hook = null;
        await s.deps.db.run("UPDATE workspace SET subscription_cancel_at = ? WHERE id = ?", [ENDED_AT, s.b.workspaceId]);
      }
    };
    expect((await sweep(s)).held).toBe(1);
    expect(await userStatus(s.deps, s.b.userId)).toBe("active");
  });

  it("old checkout records are cleared only once Stripe confirmed each expired, at most CHECKOUTS_ASKED a run; too many hold until the next run", async () => {
    const s = await site();
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    for (let i = 0; i < 12; i++) {
      await s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [`cs_test_old${i}`, s.a.workspaceId, i + 1, s.now() - 8 * DAY]);
      s.stripe.sessions.set(`cs_test_old${i}`, { id: `cs_test_old${i}`, status: "expired" });
    }
    expect((await sweep(s)).held).toBe(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    expect((await s.deps.db.all("SELECT id FROM stripe_checkout WHERE workspace_id = ?", [s.a.workspaceId])).length).toBe(2);
    await sweep(s);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(false);
  });

  it("a workspace with more than one account is on no clock: links up, no mail, no removal", async () => {
    const s = await site();
    const tour = await publishedTour(s, s.a);
    // Another account belongs to it, by its own row (as an older build wrote them).
    await s.deps.db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, 'lodger@example.com', 1)", ["usr_" + "9".repeat(24), s.a.workspaceId]);
    s.at(TRIAL_END + DAY);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(200);
    s.at(at3(2, 12));
    await sweep(s);
    expect(mailsTo(s, s.a.email)).toEqual([]);
  });

  it("an ended workspace with an allowance set by hand shows neither the links' date nor the removal's", async () => {
    const s = await site();
    await ended(s, s.a, ENDED_AT, "A");
    await s.deps.db.run("UPDATE workspace SET storage_allowance_bytes = 1000000000 WHERE id = ?", [s.a.workspaceId]);
    const state = (await send(s.deps, "GET", "/api/v1/billing", { headers: (await sessionOf(s.deps, s.a.userId)).headers })).json;
    expect([state.state, state.ended_at, state.links_until, state.removed_at]).toEqual(["ended", ENDED_AT, null, null]);
    const { BILLING_JS } = await import("../src/dash/billing.ts");
    expect(BILLING_JS).toContain("num(s.links_until) !== null");
  });

  it("a dry run writes nothing, a refused Stripe answer's audit row included", async () => {
    const s = await site();
    await ended(s, s.b, ENDED_AT, "B");
    await warned(s, s.b, ENDED_DAY, ENDED_WARNINGS);
    s.at(at3(4, 14));
    // Stripe answers the subscription with a shape 0.1.59 refuses (and would record).
    s.stripe.subscriptions.set("sub_B", { id: "sub_B", object: "subscription", customer: 42, status: "canceled", items: { data: [] } });
    const before = await dumpOf(s.deps, keysOf(s), { files: true });
    const r = await sweep(s, { dryRun: true });
    expect(r.held).toBe(1);
    expect(await dumpOf(s.deps, keysOf(s), { files: true })).toEqual(before);
  });
});

describe("round 3", () => {
  it("N1: a trial paid at Stripe whose notice never linked it is found by its old checkout record, held, recorded and linked: never removed", async () => {
    const s = await site();
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    // Paid in January; the listener never linked it, and the record is long past its expiry.
    await s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES ('cs_test_paid', ?, ?, ?)", [s.a.workspaceId, T0 + DAY, T0 + DAY + 33 * 60_000]);
    s.stripe.sessions.set("cs_test_paid", { id: "cs_test_paid", status: "complete", customer: "cus_P", subscription: "sub_P", form: { client_reference_id: s.a.workspaceId } });
    s.stripe.subscription("sub_P", "cus_P", "active", { periodEnd: Math.floor(Date.UTC(2027, 4, 1) / 1000) });
    s.at(at3(3, 11));
    const r = await sweep(s);
    expect(r.held).toBe(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    expect(await s.deps.db.first<Json>("SELECT stripe_customer_id AS c, stripe_subscription_id AS s, subscription_status AS st FROM workspace WHERE id = ?", [s.a.workspaceId])).toEqual({ c: "cus_P", s: "sub_P", st: "active" });
    expect(await s.deps.db.first("SELECT id FROM stripe_checkout WHERE id = 'cs_test_paid'")).not.toBeNull();
    expect((await audits(s.deps, s.a.workspaceId, "billing_checkout_paid_unlinked"))).toHaveLength(1);
    expect((await billingProblems(s.deps)).recent.map((x) => x.event)).toContain("billing_checkout_paid_unlinked");
    // And the next run, now live: nothing more happens to it.
    s.at(at3(3, 12));
    await sweep(s);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    expect(s.stripe.subscriptions.get("sub_P")!.status).toBe("active");
  });

  it("N1: publishing no longer clears checkout records by age", async () => {
    const s = await site();
    await s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES ('cs_test_aged', ?, 1, 2)", [s.a.workspaceId]);
    s.at(T0 + 20 * DAY);
    await publishedTour(s, s.a);
    expect(await s.deps.db.first("SELECT id FROM stripe_checkout WHERE id = 'cs_test_aged'")).not.toBeNull();
  });

  it("N2: an incomplete subscription holds the sweep's removal: never cancelled, re-evaluated next run", async () => {
    const s = await site();
    await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.a.workspaceId]);
    await ended(s, s.b, ENDED_AT, "B");
    await warned(s, s.b, ENDED_DAY, ENDED_WARNINGS);
    s.stripe.subscription("sub_B", "cus_B", "incomplete");
    s.at(at3(4, 14));
    expect((await sweep(s)).held).toBe(1);
    expect(s.stripe.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(await userStatus(s.deps, s.b.userId)).toBe("active");
    // Stripe resolved it: expired. The next run removes.
    s.stripe.subscription("sub_B", "cus_B", "incomplete_expired");
    await sweep(s);
    expect(await exists(s.deps, s.b.workspaceId)).toBe(false);
  });

  it("N3: a stopped removal can be undone after files went: nothing restored, the count of files removed answered and audited, warnings cleared", async () => {
    const s = await site();
    s.at(T0 + DAY);
    await publishedTour(s, s.b);
    await unpaid(s);
    const restore = cancelFails(s, "unreachable");
    await sweep(s);
    restore();
    // As if the first pass had removed files before the stop.
    await s.deps.db.run("UPDATE account_removal SET work_started_at = ?, total = total + 3, stopped_at = ? WHERE workspace_id = ?", [s.now(), s.now(), s.b.workspaceId]);
    const h = await adminHeaders(s);
    const r = await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/undo-removal`, { headers: h });
    expect([r.status, r.json]).toEqual([200, { restored: false, files_removed: 3 }]);
    expect(await removal(s, s.b)).toBeNull();
    expect(await s.deps.db.all("SELECT * FROM billing_warning WHERE workspace_id = ?", [s.b.workspaceId])).toEqual([]);
    expect((await audits(s.deps, s.b.workspaceId, "account_removal_undone")).map((x) => JSON.parse(x.detail))).toEqual([{ by: "billing_sweep", files_removed: 3 }]);
    expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/enable`, { headers: h })).status).toBe(204);
  });

  it("N3: a removal that was not stopped is still refused once it began", async () => {
    const s = await site();
    s.at(T0 + DAY);
    await publishedTour(s, s.b);
    await unpaid(s);
    const restore = cancelFails(s, "unreachable");
    await sweep(s);
    restore();
    await s.deps.db.run("UPDATE account_removal SET work_started_at = ? WHERE workspace_id = ?", [s.now(), s.b.workspaceId]);
    const r = await send(s.deps, "POST", `/api/v1/admin/accounts/${s.b.userId}/undo-removal`, { headers: await adminHeaders(s) });
    expect([r.status, r.json.error]).toEqual([409, "removal_started"]);
  });

  it("N3: after a confirmed cancel the subscription's open invoices are voided; a void that fails holds the sweep and is cleanup_pending for an admin", async () => {
    const s = await site();
    s.at(T0 + DAY);
    await publishedTour(s, s.b);
    await unpaid(s);
    s.stripe.invoice("in_open1", "sub_B", "open");
    s.stripe.invoice("in_paid1", "sub_B", "paid");
    s.stripe.failing.add("/v1/invoices/in_open1/void");
    await sweep(s);
    expect(await tours(s, s.b)).toBe(1);
    expect(s.stripe.subscriptions.get("sub_B")!.status).toBe("canceled");
    s.stripe.failing.delete("/v1/invoices/in_open1/void");
    const h = await adminHeaders(s);
    // The admin's delete of the same account voids it and finishes.
    await s.deps.db.run("DELETE FROM account_removal WHERE workspace_id = ?", [s.b.workspaceId]);
    s.stripe.failing.add("/v1/invoices/in_open1/void");
    const held = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.b.userId}`, { headers: h, body: JSON.stringify({ username: "bravo" }) });
    expect([held.status, held.json.error]).toEqual([500, "cleanup_pending"]);
    s.stripe.failing.delete("/v1/invoices/in_open1/void");
    let done = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.b.userId}`, { headers: h, body: JSON.stringify({ username: "bravo" }) });
    while (done.status === 202) done = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.b.userId}`, { headers: h, body: JSON.stringify({ username: "bravo" }) });
    expect(done.status).toBe(200);
    expect(s.stripe.invoices.get("in_open1")!.status).toBe("void");
    expect(s.stripe.invoices.get("in_paid1")!.status).toBe("paid");
  });

  it("N4: a sweep that outlives its lock's first two hours keeps it", async () => {
    const s = await site();
    await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.a.workspaceId]);
    await ended(s, s.b, ENDED_AT, "B");
    await warned(s, s.b, ENDED_DAY, ENDED_WARNINGS);
    const c = await seedAccount(s.deps, { username: "charlie" });
    await ended(s, c, ENDED_AT, "C");
    await warned(s, c, ENDED_DAY, ENDED_WARNINGS);
    s.at(at3(4, 14));
    let inner: Awaited<ReturnType<typeof sweep>> | null = null;
    let advanced = false;
    s.stripe.hook = async (call) => {
      // The first removal takes three hours (past the lock's two); then the other's first question to Stripe starts another sweep.
      if (call.method === "GET" && call.path === "/v1/invoices" && !advanced) {
        advanced = true;
        s.at(s.now() + 3 * 3_600_000);
      } else if (advanced && inner === null && call.method === "GET" && call.path.startsWith("/v1/subscriptions/")) {
        inner = await sweep(s);
      }
    };
    await sweep(s);
    expect(inner!.alreadyRunning).toBe(true);
  });
});

void removalDayOf;
