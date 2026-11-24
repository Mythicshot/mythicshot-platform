// Removal after the trial or an ended subscription (0.1.61, Plan 2l items 7 and 8), on both
// targets: links come down 30 days after a subscription ends (a trial's when it ends), three
// warning mails go out 30, 7 and 1 days before the removal day, and the sweep removes a workspace
// only when every rule holds, and only with BILLING_REMOVAL on. Stripe is the fake of
// test/fake-stripe.ts and mail the fake mailer: no test reaches any network or sends real mail.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { CHECKOUTS_ASKED, billingSweep, sweepLines, sweepWithinBudget, type SweepOptions } from "../src/billing-sweep.ts";
import { DAY, REMOVAL_MS, TRIAL_MS, type BillingRow } from "../src/billing-rules.ts";
import { SUBREQUEST_BUDGET } from "../src/budget.ts";
import type { Deps } from "../src/ports.ts";
import { warningMail } from "../src/removal-mail.ts";
import { REMOVALS_PER_DAY, REMOVALS_PER_RUN, SWEEP_ACTOR, clockOf, fullDate, linksUpSql, planOf, removalSwitchedOn } from "../src/removal-rules.ts";
import { emailSha256 } from "../src/removal-store.ts";
import { clone, fixtures, png, send, uploadTour, type Json } from "./bundle.ts";
import { withBilling, type FakeStripe } from "./fake-stripe.ts";
import { OWNED, dumpOf, snapshotOf } from "./isolation-world.ts";

afterEach(() => vi.restoreAllMocks());

/** A and B are made at T0: their trials end on 10 April 2027 at 14:23 UTC, and their removal day is 11 April. */
const T0 = Date.UTC(2027, 0, 10, 14, 23);
const TRIAL_END = T0 + TRIAL_MS;
const REMOVAL_DAY = Date.UTC(2027, 3, 11);
/** 03:00 UTC on a day, when the daily sweep runs in these tests. */
const at3 = (month: number, day: number, year = 2027) => Date.UTC(year, month, day, 3, 0);
const ORIGIN = "https://tours.example.com";
const SUBSCRIBE = `${ORIGIN}/billing/subscribe`;
const ACCOUNT = `${ORIGIN}/account`;
const DOWNLOAD = `You can download everything in your account first: ${ACCOUNT}`;

type Side = { workspaceId: string; userId: string; token: string; email: string };

async function site(opts: { mail?: boolean; billing?: boolean } = {}) {
  const ctx = await makeDeps({}, { mail: opts.mail ?? true });
  let now = T0;
  ctx.deps.now = () => now;
  const stripe = opts.billing === false ? (null as unknown as FakeStripe) : withBilling(ctx.deps);
  if (opts.billing === false) ctx.deps.config = { ...ctx.deps.config, siteHost: "tours.example.com" };
  const admin = await seedAccount(ctx.deps, { username: "siteadmin", admin: true });
  const a = await seedAccount(ctx.deps, { username: "alpha" });
  const b = await seedAccount(ctx.deps, { username: "bravo" });
  return { ...ctx, stripe, admin, a, b, now: () => now, at: (ms: number) => (now = ms) };
}
type Site = Awaited<ReturnType<typeof site>>;

const sweep = (s: Site, opts: Partial<SweepOptions> = {}) => billingSweep(s.deps, { removal: true, ...opts });

/** One sweep at 03:00 UTC each day from `from` to `to`, both included. */
async function daily(s: Site, from: number, to: number, opts: Partial<SweepOptions> = {}) {
  for (let t = from; t <= to; t += DAY) {
    s.at(t);
    await sweep(s, opts);
  }
}

function manifest(title: string): Json {
  const m = clone(fixtures.v2 as Json);
  m.title = title;
  m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
  return m;
}

/** A published public tour of this side: its id, slug and one live picture's name under /p/. */
async function publishedTour(s: Site, side: Side, title = "Removal") {
  const tour = await uploadTour(s.deps, side.token, manifest(title));
  let pub = await send(s.deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token: side.token });
  while (pub.status === 202) pub = await send(s.deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token: side.token, headers: { "content-type": "application/json" }, body: JSON.stringify({ publish_id: pub.json.publish_id }) });
  expect(pub.status, pub.text).toBe(200);
  const row = await s.deps.db.first<{ slug: string; key: string }>("SELECT t.slug AS slug, o.image_key AS key FROM tour t JOIN snapshot_object o ON o.tour_id = t.id WHERE t.id = ? LIMIT 1", [tour.tour_id]);
  return { id: tour.tour_id, slug: row!.slug, picture: "/" + row!.key };
}

/** A public shared image of this side: its id and its page's path. */
async function sharedImage(s: Site, side: Side) {
  const made = await send(s.deps, "POST", "/api/v1/media", { token: side.token, headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "image", content_type: "image/png", bytes: 300, width: 8, height: 8, title: "Shot" }) });
  expect(made.status, made.text).toBe(201);
  const id = made.json.id as string;
  expect((await send(s.deps, "PUT", `/api/v1/media/${id}/parts/0`, { token: side.token, body: png(8, 8, 300, 3) as NonNullable<RequestInit["body"]> })).status).toBe(204);
  const done = await send(s.deps, "POST", `/api/v1/media/${id}/commit`, { token: side.token });
  expect(done.status, done.text).toBe(200);
  return { id, path: done.json.path as string };
}

/** What a visitor gets: status, every header and the body, byte for byte. */
async function visit(deps: Deps, path: string) {
  const r = await send(deps, "GET", path);
  return { status: r.status, headers: [...r.headers.entries()].sort(), body: [...r.bytes] };
}

const exists = async (deps: Deps, ws: string) => (await deps.db.first("SELECT 1 AS x FROM workspace WHERE id = ?", [ws])) !== null;
const userStatus = async (deps: Deps, id: string) => (await deps.db.first<{ status: string }>("SELECT status FROM user WHERE id = ?", [id]))?.status ?? null;
const warnings = (deps: Deps, ws: string) => deps.db.all<Json>("SELECT stage, removal_at, sent_at, named_at, email_sha256 FROM billing_warning WHERE workspace_id = ? ORDER BY claimed_at, stage DESC", [ws]);
const mailsTo = (s: Site, to: string) => s.mail.sent.filter((m) => m.to === to);
const audits = (deps: Deps, ws: string, event: string) => deps.db.all<Json>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE workspace_id = ? AND event = ? ORDER BY at, id", [ws, event]);

/** Records the three warnings of a side as accepted, at these times, for this removal day (test set-up, not the sweep). */
async function warned(s: Site, side: Side, removalAt: number, sent: [number, number, number], email = side.email) {
  const sha = await emailSha256(email);
  for (const [i, stage] of ([30, 7, 1] as const).entries()) {
    await s.deps.db.run("INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [side.workspaceId, removalAt, stage, sha, sent[i], sent[i], removalAt]);
  }
}
/** The usual on-time warnings of A's and B's trial clock. */
const ON_TIME: [number, number, number] = [at3(2, 12), at3(3, 4), at3(3, 10)];

/** Puts a side on an ended subscription, ended at `endedAt`, as Stripe has it too. */
async function ended(s: Site, side: Side, endedAt: number, n: string) {
  await s.deps.db.run(
    "UPDATE workspace SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = 'canceled', subscription_period_end = ?, subscription_ended_at = ? WHERE id = ?",
    [`cus_${n}`, `sub_${n}`, endedAt, endedAt, side.workspaceId],
  );
  s.stripe.subscription(`sub_${n}`, `cus_${n}`, "canceled", { endedAt: Math.floor(endedAt / 1000), periodEnd: Math.floor(endedAt / 1000) });
}

const keysOf = (s: Site) => ({ draftKeys: s.draftKeys, publicKeys: s.publicKeys });

describe("the clock", () => {
  it("a trial's removal day is the first full UTC day after its 90 days; an ended subscription's is 90 days after it ended, its links down after 30", async () => {
    const s = await site();
    const row = (await s.deps.db.first<BillingRow>("SELECT workspace.id AS id, workspace.created_at AS created_at, workspace.billing_trial AS trial, 0 AS admin, NULL AS own_allowance, NULL AS customer, NULL AS subscription, NULL AS status, NULL AS period_end, NULL AS cancel_at, 0 AS cancel_at_period_end, NULL AS ended_at, NULL AS checkout_session, NULL AS checkout_created_at, NULL AS checkout_expires_at, NULL AS checked_at, NULL AS check_ok, NULL AS confirmed_until FROM workspace WHERE id = ?", [s.a.workspaceId]))!;
    expect(clockOf(row, false, T0)).toEqual({ kind: "trial", from: T0, started: TRIAL_END, end: TRIAL_END, linksDownAt: TRIAL_END, removalDay: REMOVAL_DAY });
    const e = Date.UTC(2027, 1, 12, 9, 0);
    expect(clockOf({ ...row, status: "canceled", subscription: "sub_X", customer: "cus_X", ended_at: e }, false, T0)).toEqual({ kind: "ended", from: e, started: e, end: e + REMOVAL_MS, linksDownAt: e + 30 * DAY, removalDay: Date.UTC(2027, 4, 14) });
    // Never on the clock: live, exempt, admin, allowance by hand (also after a subscription), the site's own workspace.
    expect(clockOf({ ...row, status: "active", subscription: "sub_X" }, false, T0)).toBeNull();
    expect(clockOf({ ...row, trial: 0 }, false, T0)).toBeNull();
    expect(clockOf({ ...row, admin: 1 }, false, T0)).toBeNull();
    expect(clockOf({ ...row, own_allowance: 1000 }, false, T0)).toBeNull();
    expect(clockOf({ ...row, own_allowance: 1000, status: "canceled", subscription: "sub_X", ended_at: e }, false, T0)).toBeNull();
    expect(clockOf(row, true, T0)).toBeNull();
    // An ended subscription with no end stored is on no clock (it would move with the clock).
    expect(clockOf({ ...row, status: "canceled", subscription: "sub_X", customer: "cus_X" }, false, T0)).toBeNull();
  });

  it("the SQL of the links and clockOf agree on every kind of row", async () => {
    const s = await site();
    const shapes: Json[] = [
      { status: null },
      { status: "incomplete" },
      { status: "active", stripe_subscription_id: "sub_L" },
      { status: "past_due", stripe_subscription_id: "sub_L" },
      { status: "canceled", stripe_subscription_id: "sub_L", subscription_ended_at: Date.UTC(2027, 1, 1) },
      { status: "unpaid", stripe_subscription_id: "sub_L", subscription_cancel_at: Date.UTC(2027, 1, 2) },
      { status: "incomplete_expired", stripe_subscription_id: "sub_L", subscription_period_end: Date.UTC(2027, 1, 3) },
      { status: "canceled", stripe_subscription_id: "sub_L" },
      { billing_trial: 0 },
      { storage_allowance_bytes: 5 },
    ];
    const times = [T0, TRIAL_END - 1, TRIAL_END, TRIAL_END + 1, Date.UTC(2027, 2, 3), Date.UTC(2027, 2, 4), Date.UTC(2028, 0, 1)];
    for (const shape of shapes) {
      await s.deps.db.run(
        "UPDATE workspace SET billing_trial = ?, storage_allowance_bytes = ?, stripe_subscription_id = ?, subscription_status = ?, subscription_ended_at = ?, subscription_cancel_at = ?, subscription_period_end = ? WHERE id = ?",
        [shape.billing_trial ?? 1, shape.storage_allowance_bytes ?? null, shape.stripe_subscription_id ?? null, shape.status ?? null, shape.subscription_ended_at ?? null, shape.subscription_cancel_at ?? null, shape.subscription_period_end ?? null, s.a.workspaceId],
      );
      const row = (await s.deps.db.first<BillingRow>(`SELECT ${(await import("../src/billing-rules.ts")).BILLING_COLUMNS_SQL} FROM workspace WHERE workspace.id = ?`, [s.a.workspaceId]))!;
      for (const now of times) {
        const clock = clockOf(row, false, now);
        const down = clock !== null && now >= clock.linksDownAt;
        const up = await s.deps.db.first(`SELECT 1 AS x FROM workspace t WHERE t.id = ?${linksUpSql(s.deps.config, "t.id", now)}`, [s.a.workspaceId]);
        expect(up === null, `${JSON.stringify(shape)} at ${new Date(now).toISOString()}`).toBe(down);
      }
    }
    // The admin's workspace and the site's own are never down.
    await s.deps.db.run("INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, ?)", [s.b.workspaceId, T0]);
    for (const ws of [s.admin.workspaceId, s.b.workspaceId]) {
      expect(await s.deps.db.first(`SELECT 1 AS x FROM workspace t WHERE t.id = ?${linksUpSql(s.deps.config, "t.id", Date.UTC(2029, 0, 1))}`, [ws])).not.toBeNull();
    }
    // Without billing the condition is nothing at all.
    expect(linksUpSql({}, "t.workspace_id", T0)).toBe("");
    expect(linksUpSql({ billing: null }, "t.workspace_id", T0)).toBe("");
  });

  it("BILLING_REMOVAL is on only for on, in any case with spaces around it", () => {
    for (const v of ["on", "ON", " On \n"]) expect(removalSwitchedOn(v)).toBe(true);
    for (const v of [undefined, null, "", "yes", "true", "1", "off", "on please", 1, true]) expect(removalSwitchedOn(v)).toBe(false);
  });

  it("the caps are 5 per run and 20 a day", () => {
    expect([REMOVALS_PER_RUN, REMOVALS_PER_DAY]).toEqual([5, 20]);
  });
});

describe("the warning mails", () => {
  it("each of the six mails, in its exact words and dates", () => {
    const removalAt = REMOVAL_DAY;
    const trial30 = warningMail("a@example.com", { kind: "trial", stage: 30, removalAt, endedAt: null }, ORIGIN);
    expect(trial30).toEqual({
      to: "a@example.com",
      subject: "Your Mythicshot trial ends in 30 days",
      text: `Your trial ends on 10 April 2027. If you haven't subscribed by then, your tours, images and clips are removed and your account is closed.\n\nTo keep them, subscribe for $7 a month: ${SUBSCRIBE}\n\n${DOWNLOAD}\n`,
    });
    const ended30 = warningMail("a@example.com", { kind: "ended", stage: 30, removalAt: Date.UTC(2027, 4, 14), endedAt: Date.UTC(2027, 1, 12, 9) }, ORIGIN);
    expect(ended30).toEqual({
      to: "a@example.com",
      subject: "Your Mythicshot content is removed in 30 days",
      text: `Your subscription ended on 12 February 2027. On 14 May 2027 your tours, images and clips are removed and your account is closed.\n\nTo keep them, subscribe for $7 a month: ${SUBSCRIBE}\n\n${DOWNLOAD}\n`,
    });
    const seven = `On 11 April 2027 your tours, images and clips are removed and the links to them stop working.\n\nTo keep them, subscribe for $7 a month: ${SUBSCRIBE}\n\nIf you'd rather leave, there's nothing you need to do.\n\n${DOWNLOAD}\n`;
    const one = `This is the last reminder. Tomorrow, 11 April 2027, your tours, images and clips are removed. This can't be undone.\n\nTo keep them, subscribe today: ${SUBSCRIBE}\n\n${DOWNLOAD}\n`;
    for (const kind of ["trial", "ended"] as const) {
      expect(warningMail("a@example.com", { kind, stage: 7, removalAt, endedAt: kind === "ended" ? Date.UTC(2027, 0, 11) : null }, ORIGIN)).toEqual({ to: "a@example.com", subject: "7 days left to keep your Mythicshot content", text: seven });
      expect(warningMail("a@example.com", { kind, stage: 1, removalAt, endedAt: kind === "ended" ? Date.UTC(2027, 0, 11) : null }, ORIGIN)).toEqual({ to: "a@example.com", subject: "Tomorrow your Mythicshot content is removed", text: one });
    }
    // Four distinct mails; no tracking, no picture, no markup.
    const all = [trial30, ended30, warningMail("x@example.com", { kind: "trial", stage: 7, removalAt, endedAt: null }, ORIGIN), warningMail("x@example.com", { kind: "trial", stage: 1, removalAt, endedAt: null }, ORIGIN)];
    expect(new Set(all.map((m) => m.subject)).size).toBe(4);
    for (const m of all) expect(m.text).not.toMatch(/<|utm_|\?/);
    expect(() => warningMail("a@example.com", { kind: "trial", stage: 1, removalAt, endedAt: null }, "javascript:alert(1)")).toThrow("bad origin");
    expect(fullDate(Date.UTC(2027, 1, 21, 23, 59))).toBe("21 February 2027");
  });

  it("a trial gets the three mails on their days, to its own address, each once, recorded when accepted, and its links come down when it ends", async () => {
    const s = await site();
    await daily(s, at3(1, 1), at3(3, 10));
    const sent = mailsTo(s, s.a.email);
    expect(sent.map((m) => m.subject)).toEqual(["Your Mythicshot trial ends in 30 days", "7 days left to keep your Mythicshot content", "Tomorrow your Mythicshot content is removed"]);
    expect(sent[0].text).toContain("Your trial ends on 10 April 2027.");
    expect(sent[1].text).toContain("On 11 April 2027 your tours");
    expect(sent[2].text).toContain("Tomorrow, 11 April 2027,");
    const rows = await warnings(s.deps, s.a.workspaceId);
    expect(rows.map((r) => [r.stage, r.sent_at, r.removal_at, r.named_at])).toEqual([
      [30, at3(2, 12), REMOVAL_DAY, REMOVAL_DAY],
      [7, at3(3, 4), REMOVAL_DAY, REMOVAL_DAY],
      [1, at3(3, 10), REMOVAL_DAY, REMOVAL_DAY],
    ]);
    // The address itself is never stored; its digest is.
    expect(rows[0].email_sha256).toBe(await emailSha256(s.a.email));
    expect(JSON.stringify(await s.deps.db.all("SELECT * FROM billing_warning"))).not.toContain(s.a.email);
    // Never twice: the same day again, and the days after, send nothing more.
    const before = s.mail.sent.length;
    await sweep(s);
    expect(s.mail.sent.length).toBe(before);
    // The admin's own workspace got nothing.
    expect(mailsTo(s, s.admin.email)).toEqual([]);
    // One audit row per mail, with the stage and no address.
    const rowsA = await audits(s.deps, s.a.workspaceId, "billing_warning_sent");
    expect(rowsA.map((r) => JSON.parse(r.detail))).toEqual([{ stage: 30, kind: "trial" }, { stage: 7, kind: "trial" }, { stage: 1, kind: "trial" }]);
  });

  it("an ended subscription's mails use its own 30-day words and the dates of its end", async () => {
    const s = await site();
    await ended(s, s.b, Date.UTC(2027, 1, 12, 9, 0), "B");
    await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.a.workspaceId]);
    await daily(s, at3(3, 10), at3(4, 13));
    const sent = mailsTo(s, s.b.email);
    expect(sent.map((m) => m.subject)).toEqual(["Your Mythicshot content is removed in 30 days", "7 days left to keep your Mythicshot content", "Tomorrow your Mythicshot content is removed"]);
    expect(sent[0].text.split("\n")[0]).toBe("Your subscription ended on 12 February 2027. On 14 May 2027 your tours, images and clips are removed and your account is closed.");
    expect(sent[2].text).toContain("Tomorrow, 14 May 2027,");
  });

  it("mail off, or a mail the server refused, records nothing and is tried again at the next sweep; one that failed after it was handed over is never sent again", async () => {
    const off = await site({ mail: false });
    off.at(at3(2, 12));
    const r = await sweep(off);
    expect(r.mailOff).toBe(true);
    expect(await off.deps.db.all("SELECT * FROM billing_warning")).toEqual([]);

    const s = await site();
    s.at(at3(2, 12));
    s.mail.failNext();
    s.mail.failNext();
    const first = await sweep(s);
    expect(first.mailsFailed).toBe(2);
    expect(await s.deps.db.all("SELECT * FROM billing_warning")).toEqual([]);
    s.at(at3(2, 13));
    expect((await sweep(s)).mailsSent).toBe(2);
    // A day late, it names the day 30 days after the day it went: 12 April, not 11.
    expect((await warnings(s.deps, s.a.workspaceId))[0].named_at).toBe(Date.UTC(2027, 3, 12));

    // A mail whose text was handed over before the failure may have arrived: claimed for good.
    const t = await site();
    t.at(at3(2, 12));
    const send0 = t.mail.send.bind(t.mail);
    let once = true;
    t.mail.send = async (m) => {
      if (once && m.to === t.a.email) {
        once = false;
        throw Object.assign(new Error("lost after the body"), { bodyWritten: true });
      }
      return send0(m);
    };
    await sweep(t);
    expect((await warnings(t.deps, t.a.workspaceId)).map((w) => [w.stage, w.sent_at])).toEqual([[30, null]]);
    await daily(t, at3(2, 13), at3(3, 12));
    expect(mailsTo(t, t.a.email)).toEqual([]);
    expect((await sweep(t)).unconfirmed).toBeGreaterThan(0);
    expect(await exists(t.deps, t.a.workspaceId)).toBe(true);
  });

  it("a sweep that comes late pushes the day each mail names, and the removal never comes before it", async () => {
    const s = await site();
    // Nothing ran until 8 April: the 30-day mail goes then and names 8 May.
    await daily(s, at3(3, 8), at3(4, 7));
    const sent = mailsTo(s, s.a.email);
    expect(sent.map((m) => m.subject)).toEqual(["Your Mythicshot trial ends in 30 days", "7 days left to keep your Mythicshot content", "Tomorrow your Mythicshot content is removed"]);
    expect(sent[0].text).toContain("Your trial ends on 7 May 2027.");
    expect(sent[1].text).toContain("On 8 May 2027");
    expect(sent[2].text).toContain("Tomorrow, 8 May 2027,");
    // Removed on 8 May, not on 11 April.
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    s.at(at3(4, 8));
    await sweep(s);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(false);
  });
});

describe("removal", () => {
  it("removes a trial's tours, images, clips and files on its removal day, closes the account, audits every step, and touches nothing of another workspace due the same day", SLOW(), async () => {
    const s = await site();
    const tour = await publishedTour(s, s.a);
    const item = await sharedImage(s, s.a);
    const tourB = await publishedTour(s, s.b, "Bravo");
    const itemB = await sharedImage(s, s.b);
    await daily(s, at3(1, 20), at3(3, 9));
    // B's last warning was claimed and never confirmed: B is held for good on this date.
    await s.deps.db.run("INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, ?, 1, ?, ?, NULL, ?)", [s.b.workspaceId, REMOVAL_DAY, await emailSha256(s.b.email), at3(3, 10) - 3_600_000, REMOVAL_DAY]);
    s.at(at3(3, 10));
    await sweep(s);
    const bBefore = await snapshotOf(s.deps, s.b, keysOf(s));
    const aFiles = Object.keys((await snapshotOf(s.deps, s.a, keysOf(s))).files);
    expect(aFiles.length).toBeGreaterThan(2);
    s.at(at3(3, 11));
    const r = await sweep(s);
    expect(r.removalsStarted).toBe(1);
    expect(r.removalsFinished).toBe(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(false);
    expect(await userStatus(s.deps, s.a.userId)).toBeNull();
    // Every row of it, in every table, is gone; the audit record keeps its rows, ids and counts only.
    for (const [table, where] of Object.entries(OWNED)) {
      if (table === "audit") continue;
      const n = await s.deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where.replaceAll("?", `'${s.a.workspaceId}'`)}`);
      expect(n!.n, table).toBe(0);
    }
    const left = [...(await s.draftKeys()), ...(await s.publicKeys())];
    expect(aFiles.filter((k) => left.includes(k))).toEqual([]);
    expect(left).not.toContain(tour.picture.slice(1));
    void item;
    // B is exactly as it was: every row and every file.
    expect(await snapshotOf(s.deps, s.b, keysOf(s))).toEqual(bBefore);
    expect((await visit(s.deps, `/t/${tourB.slug}`)).status).toBe(404); // B's trial ended too: its links are down, not removed
    expect(await exists(s.deps, s.b.workspaceId)).toBe(true);
    void itemB;
    // The audit record: disabled by the sweep, started with counts, each step, the deletion, finished.
    const all = await s.deps.db.all<Json>("SELECT event, user_id, subject, detail FROM audit WHERE workspace_id = ? ORDER BY at, rowid", [s.a.workspaceId]);
    const events = all.map((x) => x.event).filter((e) => e.startsWith("billing_removal") || e.startsWith("account_"));
    expect(events[0]).toBe("account_disabled");
    expect(events[1]).toBe("billing_removal_started");
    expect(events.slice(-2)).toEqual(["account_deleted", "billing_removal_finished"]);
    const started = all.find((x) => x.event === "billing_removal_started")!;
    expect(JSON.parse(started.detail)).toEqual({ kind: "trial", files: expect.any(Number), tours: 1, items: 1 });
    expect(all.find((x) => x.event === "account_deleted")!.user_id).toBe(SWEEP_ACTOR);
    // Nothing of the content in any audit row.
    expect(JSON.stringify(all)).not.toMatch(/Removal|Shot|example\.com/);
  });

  it("BILLING_REMOVAL unset removes nothing, even with everything due; the dry run lists what would go and changes nothing", async () => {
    const s = await site();
    await publishedTour(s, s.a);
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    const before = await dumpOf(s.deps, keysOf(s), { files: true });
    const dry = await sweep(s, { removal: true, dryRun: true });
    expect(dry.wouldRemove).toEqual([s.a.workspaceId]);
    // B's 30-day mail is long overdue: the dry run counts it and sends nothing.
    expect(dry.mailsWouldSend).toBe(1);
    const dryOff = await sweep(s, { removal: false, dryRun: true });
    expect(dryOff.wouldRemove).toEqual([s.a.workspaceId]);
    expect(s.mail.sent).toEqual([]);
    expect(await dumpOf(s.deps, keysOf(s), { files: true })).toEqual(before);
    expect(sweepLines(dry).join("\n")).not.toContain(s.a.email);
    // Removal off: nothing removed, the due workspace counted; B's mail goes, as mails do with removal off.
    const off = await sweep(s, { removal: false });
    expect(off.removalOff).toBe(1);
    expect(off.removalsStarted).toBe(0);
    expect(mailsTo(s, s.b.email)).toHaveLength(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    expect(await userStatus(s.deps, s.a.userId)).toBe("active");
  });

  it("each of the three warnings missing in turn, or recorded for another removal day, holds the removal back", async () => {
    for (const missing of [30, 7, 1]) {
      const s = await site();
      await warned(s, s.a, REMOVAL_DAY, ON_TIME);
      await s.deps.db.run("DELETE FROM billing_warning WHERE workspace_id = ? AND stage = ?", [s.a.workspaceId, missing]);
      s.at(at3(3, 11));
      await sweep(s);
      expect(await exists(s.deps, s.a.workspaceId), `without the ${missing}-day mail`).toBe(true);
    }
    const s = await site();
    await warned(s, s.a, REMOVAL_DAY - DAY, ON_TIME);
    s.at(at3(3, 11));
    await sweep(s);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    // The first warning too recent, or the last.
    for (const sent of [[at3(2, 13) + 3_600_000, at3(3, 4), at3(3, 10)], [at3(2, 12), at3(3, 4), at3(3, 11) - 19 * 3_600_000]] as [number, number, number][]) {
      const t = await site();
      await warned(t, t.a, REMOVAL_DAY, sent);
      t.at(at3(3, 11));
      await sweep(t);
      expect(await exists(t.deps, t.a.workspaceId)).toBe(true);
    }
  });

  it("an address changed after the first warning starts the warnings over for the new address, and nothing goes on the old date", async () => {
    const s = await site();
    await daily(s, at3(2, 11), at3(2, 20));
    expect(mailsTo(s, s.a.email)).toHaveLength(1);
    await s.deps.db.run("UPDATE user SET email = ? WHERE id = ?", ["renamed@example.com", s.a.userId]);
    s.at(at3(2, 21));
    await sweep(s);
    const fresh = mailsTo(s, "renamed@example.com");
    expect(fresh.map((m) => m.subject)).toEqual(["Your Mythicshot trial ends in 30 days"]);
    expect(fresh[0].text).toContain("Your trial ends on 19 April 2027.");
    await daily(s, at3(2, 22), at3(3, 19));
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    expect(mailsTo(s, s.a.email)).toHaveLength(1);
    s.at(at3(3, 20));
    await sweep(s);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(false);
  });

  it("a workspace that subscribes on its last day is not removed, gets no more mail, and its links answer again", async () => {
    const s = await site();
    const tour = await publishedTour(s, s.a);
    await daily(s, at3(2, 12), at3(3, 10));
    s.at(at3(3, 10) + 12 * 3_600_000);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(404);
    await s.deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_A', stripe_subscription_id = 'sub_A', subscription_status = 'active', subscription_period_end = ? WHERE id = ?", [Date.UTC(2027, 4, 10), s.a.workspaceId]);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(200);
    const mails = s.mail.sent.length;
    await daily(s, at3(3, 11), at3(3, 20));
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    // B, warned the same days, is removed on the 11th; nobody gets another mail.
    expect(await exists(s.deps, s.b.workspaceId)).toBe(false);
    expect(s.mail.sent.length).toBe(mails);
    expect(mailsTo(s, s.a.email)).toHaveLength(3);
  });

  it("a stored time ahead of the clock (the clock went back) sends nothing and removes nothing; a clock that jumps ahead never skips a warning", async () => {
    const s = await site();
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    await s.deps.db.run("UPDATE billing_warning SET sent_at = ? WHERE workspace_id = ? AND stage = 1", [at3(3, 11) + 3_600_000, s.a.workspaceId]);
    await sweep(s);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    // Jumped ahead: from the first warning straight to December. The 7-day mail goes, naming a week later.
    const t = await site();
    t.at(at3(2, 12));
    await sweep(t);
    t.at(at3(11, 1));
    await sweep(t);
    expect(await exists(t.deps, t.a.workspaceId)).toBe(true);
    expect(mailsTo(t, t.a.email).map((m) => m.subject)).toEqual(["Your Mythicshot trial ends in 30 days", "7 days left to keep your Mythicshot content"]);
    expect(mailsTo(t, t.a.email)[1].text).toContain("On 8 December 2027");
    await daily(t, at3(11, 2), at3(11, 7));
    expect(await exists(t.deps, t.a.workspaceId)).toBe(true);
    t.at(at3(11, 8));
    await sweep(t);
    expect(await exists(t.deps, t.a.workspaceId)).toBe(false);
  });

  it("an interrupted removal leaves nothing reachable and is finished by the next sweep", async () => {
    const s = await site();
    const tour = await publishedTour(s, s.a);
    const item = await sharedImage(s, s.a);
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    const real = s.deps.drafts.delete.bind(s.deps.drafts);
    s.deps.drafts.delete = () => Promise.reject(new Error("store down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await sweep(s);
    expect(first.removalsStarted).toBe(1);
    expect(first.held).toBe(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    expect(await userStatus(s.deps, s.a.userId)).toBe("disabled");
    // Nothing of it answers, and its token is refused.
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(404);
    expect((await visit(s.deps, item.path)).status).toBe(404);
    expect((await send(s.deps, "GET", "/api/v1/tours", { token: s.a.token })).status).toBe(401);
    s.deps.drafts.delete = real;
    const second = await sweep(s);
    expect(second.removalsFinished).toBe(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(false);
  });

  it("within one invocation's budget, a large workspace is removed over several sweeps, each at most the budget", SLOW(), async () => {
    const s = await site();
    for (let i = 0; i < 8; i++) await uploadTour(s.deps, s.a.token, manifest(`T${i}`));
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    let runs = 0;
    while (await exists(s.deps, s.a.workspaceId)) {
      const { calls } = await sweepWithinBudget(s.deps, "on", () => {});
      expect(calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
      expect(await userStatus(s.deps, s.a.userId)).not.toBe("active");
      if (++runs > 30) throw new Error("never finished");
    }
    expect(runs).toBeGreaterThan(1);
  });

  it("Stripe at the last check: unreachable, a 404, a 500, a permission error or a live status removes nothing; only ended does; live is stored", async () => {
    const endedAt = Date.UTC(2027, 1, 12, 9, 0);
    const removalDay = Date.UTC(2027, 4, 14);
    const due: [number, number, number] = [at3(3, 14), at3(4, 7), at3(4, 13)];
    const prepare = async () => {
      const s = await site();
      await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [s.a.workspaceId]);
      await ended(s, s.b, endedAt, "B");
      await warned(s, s.b, removalDay, due);
      s.at(at3(4, 14));
      return s;
    };
    const cases: [string, (s: Site) => void][] = [
      ["unreachable", (s) => void (s.stripe.down = true)],
      ["404", (s) => void s.stripe.subscriptions.delete("sub_B")],
      ["500", (s) => void s.stripe.failing.add("/v1/subscriptions/sub_B")],
      ["403", (s) => (s.deps.stripe = { call: async () => ({ status: 403, body: { error: { type: "invalid_request_error", code: "secret_key_required" } } }) })],
      ["another customer", (s) => s.stripe.subscription("sub_B", "cus_OTHER", "canceled")],
      ["incomplete", (s) => s.stripe.subscription("sub_B", "cus_B", "incomplete")],
    ];
    for (const [why, make] of cases) {
      const s = await prepare();
      make(s);
      const r = await sweep(s);
      expect(r.held, why).toBe(1);
      expect(await exists(s.deps, s.b.workspaceId), why).toBe(true);
      expect(await userStatus(s.deps, s.b.userId), why).toBe("active");
    }
    const live = await prepare();
    live.stripe.subscription("sub_B", "cus_B", "active", { periodEnd: Math.floor(Date.UTC(2027, 5, 1) / 1000) });
    await sweep(live);
    expect(await exists(live.deps, live.b.workspaceId)).toBe(true);
    expect((await live.deps.db.first<Json>("SELECT subscription_status FROM workspace WHERE id = ?", [live.b.workspaceId]))!.subscription_status).toBe("active");
    const ok = await prepare();
    await sweep(ok);
    expect(await exists(ok.deps, ok.b.workspaceId)).toBe(false);
    // The subscription was asked right before, and nothing was cancelled or written at Stripe.
    expect(ok.stripe.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/subscriptions/sub_B"]);
  });

  it("a pending checkout, a paid one, one Stripe cannot confirm expired, or too many hold the removal back; expired ones do not", async () => {
    const prepare = async () => {
      const s = await site();
      await warned(s, s.a, REMOVAL_DAY, ON_TIME);
      s.at(at3(3, 11));
      return s;
    };
    const checkout = (s: Site, id: string, expires: number) => s.deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [id, s.a.workspaceId, expires - 33 * 60_000, expires]);
    const cases: [string, (s: Site) => Promise<void>][] = [
      ["unexpired", (s) => checkout(s, "cs_test_open", s.now() + 60_000).then(() => {})],
      ["pending on the record", async (s) => {
        await checkout(s, "cs_test_rec", s.now() - DAY);
        s.stripe.sessions.set("cs_test_rec", { id: "cs_test_rec", status: "expired" });
        await s.deps.db.run("UPDATE workspace SET checkout_session_id = 'cs_test_rec', checkout_created_at = ? WHERE id = ?", [s.now() - DAY, s.a.workspaceId]);
      }],
      ["paid at Stripe", async (s) => {
        await checkout(s, "cs_test_paid", s.now() - DAY);
        s.stripe.sessions.set("cs_test_paid", { id: "cs_test_paid", status: "complete", customer: "cus_P", subscription: "sub_P" });
      }],
      ["unknown at Stripe", (s) => checkout(s, "cs_test_gone", s.now() - DAY).then(() => {})],
      ["too many", async (s) => {
        for (let i = 0; i <= CHECKOUTS_ASKED; i++) {
          await checkout(s, `cs_test_m${i}`, s.now() - DAY - i);
          s.stripe.sessions.set(`cs_test_m${i}`, { id: `cs_test_m${i}`, status: "expired" });
        }
      }],
    ];
    for (const [why, make] of cases) {
      const s = await prepare();
      await make(s);
      const r = await sweep(s);
      expect(r.held, why).toBe(1);
      expect(await exists(s.deps, s.a.workspaceId), why).toBe(true);
    }
    const s = await prepare();
    await checkout(s, "cs_test_old", s.now() - DAY);
    s.stripe.sessions.set("cs_test_old", { id: "cs_test_old", status: "expired" });
    await sweep(s);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(false);
  });

  it("an export in progress holds the removal back (the hook)", async () => {
    const s = await site();
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    expect((await sweep(s, { exportInProgress: async (_d, ws) => ws === s.a.workspaceId })).held).toBe(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
  });

  it("caps: at most 5 a run and 20 a day, the rest the next time", SLOW(), async () => {
    const s = await site();
    const more: Side[] = [];
    for (let i = 0; i < 5; i++) more.push(await seedAccount(s.deps, { username: `extra${i}` }));
    const all = [s.a, s.b, ...more];
    for (const side of all) await warned(s, side, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    const first = await sweep(s);
    expect([first.removalsFinished, first.capped]).toEqual([5, 2]);
    const second = await sweep(s);
    expect(second.removalsFinished).toBe(2);
    // Per day, with a smaller cap to keep the test short: the count comes from the audit record.
    const t = await site();
    const others: Side[] = [];
    for (let i = 0; i < 3; i++) others.push(await seedAccount(t.deps, { username: `other${i}` }));
    for (const side of [t.a, t.b, ...others]) await warned(t, side, REMOVAL_DAY, ON_TIME);
    t.at(at3(3, 11));
    expect((await sweep(t, { perDay: 2 })).removalsFinished).toBe(2);
    t.at(at3(3, 11) + 3_600_000);
    expect((await sweep(t, { perDay: 2 })).removalsFinished).toBe(0);
    t.at(at3(3, 12) + 60_000);
    expect((await sweep(t, { perDay: 2 })).removalsFinished).toBe(2);
  });

  it("exempt, admin, existing, admin-allowance and the site's own workspaces are never warned, taken down or removed", SLOW(), async () => {
    const s = await site();
    const existing = await seedAccount(s.deps, { username: "existing" });
    const allowance = await seedAccount(s.deps, { username: "allowance" });
    const allowanceEnded = await seedAccount(s.deps, { username: "allowended" });
    const owner = await seedAccount(s.deps, { username: "owner" });
    const sides = [s.admin, existing, allowance, allowanceEnded, owner];
    const tours = [];
    for (const side of sides) tours.push(await publishedTour(s, side));
    await s.deps.db.run("UPDATE workspace SET billing_trial = 0 WHERE id = ?", [existing.workspaceId]);
    await s.deps.db.run("UPDATE workspace SET storage_allowance_bytes = 1000000000 WHERE id IN (?, ?)", [allowance.workspaceId, allowanceEnded.workspaceId]);
    await ended(s, allowanceEnded, T0 + DAY, "AE");
    await s.deps.db.run("INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, ?)", [owner.workspaceId, T0]);
    await daily(s, at3(1, 15), at3(4, 30));
    for (const [i, side] of sides.entries()) {
      expect(mailsTo(s, side.email), side.email).toEqual([]);
      expect(await exists(s.deps, side.workspaceId)).toBe(true);
      expect((await visit(s.deps, `/t/${tours[i].slug}`)).status).toBe(200);
      expect((await visit(s.deps, tours[i].picture)).status).toBe(200);
    }
  });

  it("billing off: the sweep reads nothing, sends nothing and removes nothing, and nothing is ever taken down", async () => {
    const s = await site({ billing: false });
    const tour = await publishedTour(s, s.a);
    const item = await sharedImage(s, s.a);
    const page = await visit(s.deps, `/t/${tour.slug}`);
    const picture = await visit(s.deps, tour.picture);
    const shared = await visit(s.deps, item.path);
    s.at(Date.UTC(2030, 0, 1));
    const calls = s.calls();
    const r = await sweep(s);
    expect(r.billing).toBe(false);
    expect(s.calls()).toBe(calls);
    expect(sweepLines(r)).toEqual(["Billing is off on this site, so there is nothing to sweep. Nothing was changed."]);
    expect(s.mail.sent).toEqual([]);
    expect(await visit(s.deps, `/t/${tour.slug}`)).toEqual(page);
    expect(await visit(s.deps, tour.picture)).toEqual(picture);
    expect(await visit(s.deps, item.path)).toEqual(shared);
    expect(await s.deps.db.all("SELECT * FROM billing_warning")).toEqual([]);
  });
});

describe("links down", () => {
  it("a trial's links answer exactly as unpublished ones from the moment it ends, and again at once after it subscribes; nothing is changed", async () => {
    const s = await site();
    const tour = await publishedTour(s, s.a);
    const item = await sharedImage(s, s.a);
    s.at(TRIAL_END - 1);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(200);
    expect((await visit(s.deps, tour.picture)).status).toBe(200);
    expect((await visit(s.deps, item.path)).status).toBe(200);
    const tourRow = await s.deps.db.first("SELECT * FROM tour WHERE id = ?", [tour.id]);
    s.at(TRIAL_END);
    expect(await visit(s.deps, `/t/${tour.slug}`)).toEqual(await visit(s.deps, `/t/${"a".repeat(10)}`));
    expect(await visit(s.deps, tour.picture)).toEqual(await visit(s.deps, `/p/${"0".repeat(32)}.png`));
    const letter = item.path.split("/")[1];
    expect(await visit(s.deps, item.path)).toEqual(await visit(s.deps, `/${letter}/${"a".repeat(20)}`));
    expect(await visit(s.deps, `${item.path}/download`)).toEqual(await visit(s.deps, `/${letter}/${"a".repeat(20)}/download`));
    // Exactly as a tour that was published and then unpublished.
    const other = await publishedTour(s, s.admin, "Admin's");
    expect((await send(s.deps, "POST", `/api/v1/tours/${other.id}/unpublish`, { token: s.admin.token })).status).toBeLessThan(300);
    expect(await visit(s.deps, `/t/${tour.slug}`)).toEqual(await visit(s.deps, `/t/${other.slug}`));
    expect(await visit(s.deps, tour.picture)).toEqual(await visit(s.deps, other.picture));
    // Content and publish state untouched.
    expect(await s.deps.db.first("SELECT * FROM tour WHERE id = ?", [tour.id])).toEqual(tourRow);
    // Subscribed again: answers at once.
    await s.deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_A', stripe_subscription_id = 'sub_A', subscription_status = 'active', subscription_period_end = ? WHERE id = ?", [TRIAL_END + 30 * DAY, s.a.workspaceId]);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(200);
    expect((await visit(s.deps, tour.picture)).status).toBe(200);
    expect((await visit(s.deps, item.path)).status).toBe(200);
  });

  it("an ended subscription's links stay up for 30 days, then come down; a restricted tour is down too", async () => {
    const s = await site();
    const tour = await publishedTour(s, s.a);
    const endedAt = T0 + 10 * DAY;
    s.at(endedAt);
    await s.deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_A', stripe_subscription_id = 'sub_A', subscription_status = 'canceled', subscription_ended_at = ? WHERE id = ?", [endedAt, s.a.workspaceId]);
    s.at(endedAt + 30 * DAY - 1);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(200);
    s.at(endedAt + 30 * DAY);
    expect((await visit(s.deps, `/t/${tour.slug}`)).status).toBe(404);
    // A restricted tour of B, its trial over: the page answers as an unknown one, not the gate.
    s.at(T0 + 11 * DAY);
    const restricted = await publishedTour(s, s.b, "Restricted");
    const { sessionOf } = await import("./fake-stripe.ts");
    const hb = { ...(await sessionOf(s.deps, s.b.userId)).headers, "content-type": "application/json" };
    let sw = await send(s.deps, "PUT", `/api/v1/tours/${restricted.id}/access`, { headers: hb, body: JSON.stringify({ access: "people", viewers: ["viewer@example.com"] }) });
    while (sw.status === 202) sw = await send(s.deps, "PUT", `/api/v1/tours/${restricted.id}/access`, { headers: hb, body: JSON.stringify({ access: "people", viewers: ["viewer@example.com"] }) });
    expect(sw.status, sw.text).toBe(200);
    s.at(TRIAL_END - 1);
    const gate = await visit(s.deps, `/t/${restricted.slug}`);
    expect(gate.status).toBe(403);
    s.at(TRIAL_END);
    expect(await visit(s.deps, `/t/${restricted.slug}`)).toEqual(await visit(s.deps, `/t/${"a".repeat(10)}`));
  });

  it("the dashboard shows the dates the sweep acts on, a late mail's included", async () => {
    const s = await site();
    const { sessionOf } = await import("./fake-stripe.ts");
    const state = async () => (await send(s.deps, "GET", "/api/v1/billing", { headers: (await sessionOf(s.deps, s.a.userId)).headers })).json;
    s.at(at3(1, 1));
    expect(fullDate((await state()).removed_at)).toBe("11 April 2027");
    expect((await state()).trial_ends_at).toBe(TRIAL_END);
    await daily(s, at3(3, 8), at3(3, 8));
    expect(fullDate((await state()).removed_at)).toBe("8 May 2027");
    const plan = planOf(clockOf((await s.deps.db.first<BillingRow>(`SELECT ${(await import("../src/billing-rules.ts")).BILLING_COLUMNS_SQL} FROM workspace WHERE workspace.id = ?`, [s.a.workspaceId]))!, false, s.now())!, [], "", s.now());
    expect(plan.removalAt).toBe(Date.UTC(2027, 4, 8));
    // An ended subscription: links and removal from its end.
    await ended(s, s.b, Date.UTC(2027, 1, 12, 9, 0), "B");
    const b = (await send(s.deps, "GET", "/api/v1/billing", { headers: (await sessionOf(s.deps, s.b.userId)).headers })).json;
    expect([fullDate(b.ended_at), fullDate(b.links_until), fullDate(b.removed_at)]).toEqual(["12 February 2027", "14 March 2027", "14 May 2027"]);
  });
});

describe("undoing a delete that removed nothing yet", () => {
  async function stuck() {
    const s = await site();
    const { sessionOf } = await import("./fake-stripe.ts");
    const admin = { ...(await sessionOf(s.deps, s.admin.userId)).headers, "content-type": "application/json" };
    await publishedTour(s, s.a);
    await s.deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_A', stripe_subscription_id = 'sub_A', subscription_status = 'active', subscription_period_end = ? WHERE id = ?", [T0 + 30 * DAY, s.a.workspaceId]);
    s.stripe.subscription("sub_A", "cus_A", "active");
    expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${s.a.userId}/disable`, { headers: admin })).status).toBe(204);
    s.stripe.down = true;
    const del = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.a.userId}`, { headers: admin, body: JSON.stringify({ username: "alpha" }) });
    expect(del.status).toBe(500);
    return { s, admin, undo: () => send(s.deps, "POST", `/api/v1/admin/accounts/${s.a.userId}/undo-removal`, { headers: admin }) };
  }

  it("a delete stuck on Stripe's answer is undone: the record goes, the account stays disabled and can be enabled, and it is audited", async () => {
    const { s, admin, undo } = await stuck();
    const before = await s.deps.db.first<{ n: number }>("SELECT count(*) AS n FROM tour WHERE workspace_id = ?", [s.a.workspaceId]);
    expect((await undo()).status).toBe(204);
    expect(await s.deps.db.first("SELECT 1 AS x FROM account_removal WHERE user_id = ?", [s.a.userId])).toBeNull();
    expect(await userStatus(s.deps, s.a.userId)).toBe("disabled");
    expect(await s.deps.db.first<{ n: number }>("SELECT count(*) AS n FROM tour WHERE workspace_id = ?", [s.a.workspaceId])).toEqual(before);
    const rows = await s.deps.db.all<Json>("SELECT user_id, workspace_id, subject FROM audit WHERE event = 'account_removal_undone'");
    expect(rows).toEqual([{ user_id: s.admin.userId, workspace_id: s.a.workspaceId, subject: s.a.userId }]);
    // Again: nothing to undo.
    const again = await undo();
    expect([again.status, again.json.error]).toEqual([409, "not_deleting"]);
    expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${s.a.userId}/enable`, { headers: admin })).status).toBe(204);
    expect(await userStatus(s.deps, s.a.userId)).toBe("active");
  });

  it("a delete that has begun removing cannot be undone, only finished; nobody but the admin reaches the route", async () => {
    const { s, admin, undo } = await stuck();
    s.stripe.down = false;
    // The delete goes on and its first removal fails: begun.
    const real = s.deps.drafts.delete.bind(s.deps.drafts);
    s.deps.drafts.delete = () => Promise.reject(new Error("store down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const del = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.a.userId}`, { headers: admin, body: JSON.stringify({ username: "alpha" }) });
    expect(del.status).toBe(500);
    expect((await s.deps.db.first<Json>("SELECT work_started_at FROM account_removal WHERE user_id = ?", [s.a.userId]))!.work_started_at).toBe(T0);
    const refused = await undo();
    expect([refused.status, refused.json.error]).toEqual([409, "removal_started"]);
    expect(await s.deps.db.first("SELECT 1 AS x FROM account_removal WHERE user_id = ?", [s.a.userId])).not.toBeNull();
    s.deps.drafts.delete = real;
    // The account's own session, a token and nobody: the one 404.
    const { sessionOf } = await import("./fake-stripe.ts");
    for (const opts of [{ headers: (await sessionOf(s.deps, s.b.userId)).headers }, { token: s.b.token }, {}]) {
      const r = await send(s.deps, "POST", `/api/v1/admin/accounts/${s.a.userId}/undo-removal`, opts);
      expect([r.status, r.json]).toEqual([404, { error: "not_found" }]);
    }
    const done = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${s.a.userId}`, { headers: admin, body: JSON.stringify({ username: "alpha" }) });
    expect(done.status).toBe(200);
  });
});

describe("the dashboard's notices", () => {
  it("say nothing of a download until the build has one, and write dates as the UTC day", async () => {
    const { BILLING_JS, DOWNLOAD_SENTENCE } = await import("../src/dash/billing.ts");
    const { DOWNLOAD_ALL_BUILT } = await import("../src/removal-rules.ts");
    expect(DOWNLOAD_ALL_BUILT).toBe(false);
    expect(DOWNLOAD_SENTENCE).toBe("You can download everything from your Account page.");
    expect(BILLING_JS).not.toContain(DOWNLOAD_SENTENCE);
    expect(BILLING_JS).toContain("d.getUTCDate() + \" \" + MONTHS[d.getUTCMonth()] + \" \" + d.getUTCFullYear()");
    expect(BILLING_JS).not.toMatch(/d\.getDate\(\)|d\.getMonth\(\)|d\.getFullYear\(\)/);
  });
});

describe("the sweep on Workers", () => {
  it("the scheduled handler does nothing without billing, and nothing on settings it cannot use", async () => {
    const load = import.meta.glob("../src/cloudflare/entry.ts");
    const entry = (await load["../src/cloudflare/entry.ts"]()) as { scheduledSweep(env: Record<string, unknown>): Promise<unknown>; default: { scheduled(c: unknown, env: Record<string, unknown>, ctx: unknown): Promise<void> } };
    const untouchable = new Proxy({}, { get: () => { throw new Error("the database was used"); } });
    const env = { DB: untouchable, DRAFTS: untouchable, PUB: untouchable };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await entry.scheduledSweep(env)).toEqual(expect.objectContaining({ billing: false, checked: 0 }));
    await entry.default.scheduled({}, env, {});
    expect(await entry.scheduledSweep({ ...env, TOURS_HOST: "tours.example.com" })).toBeNull();
    expect(await entry.scheduledSweep({ ...env, STRIPE_API_KEY: "rk_test_FAKE" })).toBeNull();
    for (const call of err.mock.calls) expect(String(call[0])).not.toContain("rk_test_FAKE");
  });

  it("one invocation stays within the budget and logs counts only", async () => {
    const s = await site();
    await warned(s, s.a, REMOVAL_DAY, ON_TIME);
    s.at(at3(3, 11));
    const lines: string[] = [];
    const { summary, calls } = await sweepWithinBudget(s.deps, undefined, (l) => lines.push(l));
    expect(calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    // BILLING_REMOVAL unset: due, not removed.
    expect(summary.removalOff).toBe(1);
    expect(await exists(s.deps, s.a.workspaceId)).toBe(true);
    expect(lines.join(" ")).not.toMatch(/@|ws_|usr_/);
  });
});

function SLOW() {
  return { timeout: 120_000 };
}
