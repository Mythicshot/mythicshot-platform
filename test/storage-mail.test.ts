// The low storage mail (0.1.66), on both targets: the rules of the two mails (80% and 100% of
// the allowance, once per fill-up, armed again below 70%), who gets it and who never does, how
// it is recorded (only once the mail server took it, never twice for one crossing), its words in
// both parts, the safety of a workspace's name in them, the isolation of two workspaces, the
// sweep, and the requests that ask for a check: they neither fail nor wait on the mail. Mail is
// the fake mailer; no test reaches a network or sends real mail.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { DAY, PLAN_BYTES, TRIAL_BYTES } from "../src/billing-rules.ts";
import { MARK_MAIL_PNG, WORDMARK_LIGHT_PNG } from "../src/brand-assets.ts";
import type { Mail, Mailer } from "../src/mail.ts";
import { DEFER_FAILED, type Db, type Deps } from "../src/ports.ts";
import { emailSha256 } from "../src/removal-store.ts";
import { CLAIM_STALE_MS, STORAGE_MAILS_PER_RUN, checkStorage, clearStorageClaim, storageMailSoon, storageSweep, storageSweepLines, storageSweepWithinBudget } from "../src/storage-alert.ts";
import { MARK_CID, STORAGE_WORDS, WORDMARK_CID, escapeHtml, mailFooterOf, percentOf, stageOf, storageMail } from "../src/storage-mail.ts";
import { formatBytes } from "../src/usage.ts";
import { clone, fixtures, png, send, sendAll, uploadTour, type Json } from "./bundle.ts";
import { FakeMailer } from "./fake-mail.ts";
import { withBilling } from "./fake-stripe.ts";
import { SIZE_TABLE } from "./sizes.ts";

const T0 = Date.UTC(2027, 0, 10, 14, 23);
const SITE = "app.example";
const ORIGIN = `https://${SITE}`;
const MB = 1024 * 1024;

/** A site with an allowance of `allowance` bytes for every workspace, links on SITE, a clock that moves only when told. */
async function world(opts: { allowance?: number | null; mail?: boolean; siteHost?: string | null; footer?: string } = {}) {
  const allowance = opts.allowance === undefined ? 100 * MB : opts.allowance;
  const ctx = await makeDeps(
    {
      ...(allowance === null ? {} : { storageAllowanceBytes: allowance }),
      ...(opts.siteHost === null ? {} : { siteHost: opts.siteHost ?? SITE }),
      ...(opts.footer === undefined ? {} : { mailFooter: opts.footer }),
    },
    { mail: opts.mail ?? true },
  );
  let now = T0;
  ctx.deps.now = () => now;
  return { ...ctx, at: (ms: number) => (now = ms), now: () => now };
}

let mediaN = 0;
/** One online shared item of `bytes` bytes in the workspace: its id. */
async function item(deps: Deps, ws: string, bytes: number, kind: "image" | "clip" = "image"): Promise<string> {
  mediaN += 1;
  const id = "med_" + mediaN.toString(16).padStart(24, "0");
  const link = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");
  await deps.db.run(
    "INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, state, created_at, online_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?, 'online', 1, 1)",
    [id, ws, link, kind, kind === "image" ? "image/png" : "image/gif", bytes, kind === "clip" ? 1000 : null],
  );
  return id;
}
const resize = (deps: Deps, id: string, bytes: number) => deps.db.run("UPDATE media SET bytes = ? WHERE id = ?", [bytes, id]);
const records = (deps: Deps, ws: string) => deps.db.all<{ stage: number; sent_at: number | null; email_sha256: string }>("SELECT stage, sent_at, email_sha256 FROM storage_mail WHERE workspace_id = ? ORDER BY stage", [ws]);
const audits = (deps: Deps, ws?: string) =>
  deps.db.all<{ workspace_id: string; subject: string; detail: string; user_id: string | null }>("SELECT workspace_id, subject, detail, user_id FROM audit WHERE event = 'storage_mail_sent'" + (ws ? " AND workspace_id = ?" : "") + " ORDER BY at, id", ws ? [ws] : []);

/** A record of a mail of the present fill-up, written as a check writes it. */
const seedRecord = (deps: Deps, ws: string, stage: 80 | 100, claimedAt: number, sentAt: number | null) =>
  deps.db.run("INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, ?, ?, ?, ?)", [ws, stage, "0".repeat(64), claimedAt, sentAt]);

/** The database with `before` run ahead of the first statement whose text starts with `prefix`. */
function interleaved(db: Db, prefix: string, before: () => Promise<unknown>): Db {
  let done = false;
  const ahead = async (sql: string) => {
    if (!done && sql.startsWith(prefix)) {
      done = true;
      await before();
    }
  };
  return {
    all: async (sql, params) => (await ahead(sql), db.all(sql, params)),
    first: async (sql, params) => (await ahead(sql), db.first(sql, params)),
    run: async (sql, params) => (await ahead(sql), db.run(sql, params)),
    batch: (stmts) => db.batch(stmts),
  };
}

/** A mailer that fails as the SMTP client does after the message was handed over: it may have arrived. */
class HandedOverThenFailed implements Mailer {
  tries = 0;
  async send(): Promise<void> {
    this.tries += 1;
    throw Object.assign(new Error("smtp: timeout"), { reason: "timeout", bodyWritten: true });
  }
}

describe("the rules", () => {
  it("80% and 100% exactly, in whole numbers; the percent rounded down, never 100 in the 80% mail", () => {
    const A = 1000;
    expect(stageOf(799, A)).toBeNull(); // 79.9%
    expect(stageOf(800, A)).toBe(80); // 80.0%
    expect(stageOf(999, A)).toBe(80); // 99.9%
    expect(stageOf(1000, A)).toBe(100);
    expect(stageOf(2500, A)).toBe(100); // 250%
    expect(stageOf(699, A)).toBe("rearm"); // 69.9%
    expect(stageOf(700, A)).toBeNull(); // 70.0%: held
    expect(stageOf(5, null)).toBeNull();
    expect(stageOf(5, 0)).toBeNull();
    expect(stageOf(0, 0)).toBeNull();
    // A large allowance, where floating point would tip: exact.
    const big = 5_368_709_120;
    expect(stageOf(big * 0.8 - 1, big)).toBeNull();
    expect(stageOf(big * 0.8, big)).toBe(80);
    expect([799, 800, 999, 1000, 2500].map((u) => percentOf(u, A))).toEqual([79, 80, 99, 100, 250]);
    const facts = { workspaceName: "W", tours: 0, gifs: 0, images: 0, origin: ORIGIN, trial: false, footer: null, allowance: A };
    expect(storageMail("a@example.com", { ...facts, stage: 80, used: 800 }).subject).toBe("Your Mythicshot storage is 80% full");
    expect(storageMail("a@example.com", { ...facts, stage: 80, used: 999 }).subject).toBe("Your Mythicshot storage is 99% full");
    expect(storageMail("a@example.com", { ...facts, stage: 100, used: 1000 }).subject).toBe("Your Mythicshot storage is full");
    expect(storageMail("a@example.com", { ...facts, stage: 100, used: 2500 }).subject).toBe("Your Mythicshot storage is full");
    // Even when asked with a usage past the line, the 80% mail never says 100.
    expect(storageMail("a@example.com", { ...facts, stage: 80, used: 1000 }).subject).toBe("Your Mythicshot storage is 99% full");
  });

  it("sizes are written exactly as the Storage page writes them (the one table both are held to)", () => {
    for (const [bytes, text] of SIZE_TABLE) expect(formatBytes(bytes)).toBe(text);
    const m = storageMail("a@example.com", { stage: 80, workspaceName: "W", used: 14_889_779, allowance: 1_073_741_824 / 64, tours: 200_000, gifs: 2_000_000, images: 525_000, origin: ORIGIN, trial: false, footer: null });
    expect(m.text).toContain(`has used 14.2 MB of its 16 MB of storage (88%).`);
    for (const s of ["195.3 KB", "1.9 MB", "512.7 KB", "<b style=\"color:#1d1828;\">14.2 MB</b> of 16 MB used", "1.8 MB left"]) expect(m.html).toContain(s);
  });
});

describe("one workspace filling up", () => {
  it("crosses 80% once: one mail to its own address, recorded with its digest and one audit row of ids", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const img = await item(w.deps, a.workspaceId, 70 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    await resize(w.deps, img, 81 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0].to).toBe(a.email);
    expect(w.mail.sent[0].subject).toBe("Your Mythicshot storage is 81% full");
    const rows = await records(w.deps, a.workspaceId);
    expect(rows).toEqual([{ stage: 80, sent_at: T0, email_sha256: await emailSha256(a.email) }]);
    const audit = await audits(w.deps);
    expect(audit).toEqual([{ workspace_id: a.workspaceId, subject: a.userId, detail: JSON.stringify({ stage: 80 }), user_id: null }]);
    // Ids and numbers only: no address, name or size.
    expect(JSON.stringify(audit)).not.toContain("@");
  });

  it("crosses 100% once after it; past 100% nothing more", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const img = await item(w.deps, a.workspaceId, 85 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    await resize(w.deps, img, 100 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 100 });
    await resize(w.deps, img, 180 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    expect(w.mail.sent.map((m) => m.subject)).toEqual(["Your Mythicshot storage is 85% full", "Your Mythicshot storage is full"]);
    expect((await records(w.deps, a.workspaceId)).map((r) => r.stage)).toEqual([80, 100]);
  });

  it("straight from under 80% to 100% or more: only the full mail, and the 80% one counts as done", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const img = await item(w.deps, a.workspaceId, 10 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    await resize(w.deps, img, 250 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 100 });
    // Back between 80% and 100%: still nothing, as neither repeats before 70%.
    await resize(w.deps, img, 90 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    expect(w.mail.sent.map((m) => m.subject)).toEqual(["Your Mythicshot storage is full"]);
  });

  it("no repeat while between 70% and 100%; below 70% both are armed again", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const img = await item(w.deps, a.workspaceId, 82 * MB);
    await checkStorage(w.deps, a.workspaceId);
    for (const mb of [75, 70, 95, 79, 88]) {
      await resize(w.deps, img, mb * MB);
      expect(await checkStorage(w.deps, a.workspaceId), `${mb}%`).toEqual({ did: "none" });
    }
    expect(await records(w.deps, a.workspaceId)).toHaveLength(1);
    await resize(w.deps, img, 69 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "rearmed" });
    expect(await records(w.deps, a.workspaceId)).toEqual([]);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    await resize(w.deps, img, 101 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 100 });
    expect(w.mail.sent.map((m) => m.subject)).toEqual(["Your Mythicshot storage is 82% full", "Your Mythicshot storage is full"]);
  });

  it("no allowance: never a mail, whatever is used", async () => {
    const none = await world({ allowance: null });
    const a = await seedAccount(none.deps);
    await item(none.deps, a.workspaceId, 900 * MB);
    expect(await checkStorage(none.deps, a.workspaceId)).toEqual({ did: "none" });
    expect(none.mail.sent).toEqual([]);
    // The admin's own number for one workspace is its allowance, on a site without one.
    await none.deps.db.run("UPDATE workspace SET storage_allowance_bytes = ? WHERE id = ?", [1000 * MB, a.workspaceId]);
    expect(await checkStorage(none.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
  });

  it("an allowance of 0 is no allowance for this mail", async () => {
    const zero = await world({ allowance: 0 });
    const b = await seedAccount(zero.deps);
    expect(await checkStorage(zero.deps, b.workspaceId)).toEqual({ did: "none" });
    await item(zero.deps, b.workspaceId, 1);
    expect(await checkStorage(zero.deps, b.workspaceId)).toEqual({ did: "none" });
    expect(zero.mail.sent).toEqual([]);
  });
});

describe("sending and recording", () => {
  it("mail off: nothing read, written or sent; with mail on later, it goes once", async () => {
    const w = await world({ mail: false });
    const a = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 90 * MB);
    const before = w.calls();
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "mail_off" });
    storageMailSoon(w.deps, a.workspaceId);
    await w.settle();
    expect(w.calls()).toBe(before);
    expect(await records(w.deps, a.workspaceId)).toEqual([]);
    const on = new FakeMailer();
    const deps: Deps = { ...w.deps, mail: on };
    expect(await checkStorage(deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    expect(await checkStorage(deps, a.workspaceId)).toEqual({ did: "none" });
    expect(on.sent).toHaveLength(1);
  });

  it("refused by the mail server before the message left: nothing recorded, tried again, sent once", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 90 * MB);
    w.mail.failNext();
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "failed" });
    expect(await records(w.deps, a.workspaceId)).toEqual([]);
    expect(await audits(w.deps)).toEqual([]);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    expect(w.mail.sent).toHaveLength(1);
  });

  it("handed over and then failed: never sent again for this fill-up; an old claim goes with the next re-arm", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const img = await item(w.deps, a.workspaceId, 90 * MB);
    const flaky = new HandedOverThenFailed();
    const deps: Deps = { ...w.deps, mail: flaky };
    expect(await checkStorage(deps, a.workspaceId)).toEqual({ did: "unconfirmed" });
    expect(await checkStorage(deps, a.workspaceId)).toEqual({ did: "none" });
    expect(flaky.tries).toBe(1);
    expect(await records(w.deps, a.workspaceId)).toEqual([{ stage: 80, sent_at: null, email_sha256: await emailSha256(a.email) }]);
    // Below 70% at once: a young claim may still be on its way, so it stays.
    await resize(w.deps, img, 10 * MB);
    expect(await checkStorage(deps, a.workspaceId)).toEqual({ did: "none" });
    expect(await records(w.deps, a.workspaceId)).toHaveLength(1);
    w.at(T0 + CLAIM_STALE_MS + 1);
    expect(await checkStorage(deps, a.workspaceId)).toEqual({ did: "rearmed" });
    expect(await records(w.deps, a.workspaceId)).toEqual([]);
  });

  it("two checks at the same moment send one mail", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 90 * MB);
    const outs = await Promise.all([checkStorage(w.deps, a.workspaceId), checkStorage(w.deps, a.workspaceId), checkStorage(w.deps, a.workspaceId)]);
    expect(outs.filter((o) => o.did === "sent")).toHaveLength(1);
    expect(w.mail.sent).toHaveLength(1);
  });
});

describe("who gets it", () => {
  it("two workspaces are never mixed: each mail holds its own workspace's name, numbers and address alone", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const b = await seedAccount(w.deps);
    await w.deps.db.run("UPDATE workspace SET name = 'Alpha Demos' WHERE id = ?", [a.workspaceId]);
    await w.deps.db.run("UPDATE workspace SET name = 'Bravo Clips' WHERE id = ?", [b.workspaceId]);
    await item(w.deps, a.workspaceId, 83 * MB);
    await item(w.deps, b.workspaceId, 51 * MB, "clip");
    // B's check sends nothing (51%), and A's sends A's mail to A.
    expect(await checkStorage(w.deps, b.workspaceId)).toEqual({ did: "none" });
    storageMailSoon(w.deps, a.workspaceId);
    await w.settle();
    expect(w.mail.sent).toHaveLength(1);
    const ma = w.mail.sent[0];
    expect(ma.to).toBe(a.email);
    for (const part of [ma.subject, ma.text, ma.html ?? ""]) {
      expect(part).not.toContain(b.email);
      expect(part).not.toContain("Bravo");
      expect(part).not.toContain("51 MB");
    }
    expect(ma.text).toContain('Your workspace "Alpha Demos" has used 83 MB of its 100 MB of storage (83%).');
    // Then B fills up: B's own mail to B, with nothing of A.
    await item(w.deps, b.workspaceId, 50 * MB, "clip");
    storageMailSoon(w.deps, b.workspaceId);
    await w.settle();
    expect(w.mail.sent).toHaveLength(2);
    const mb = w.mail.sent[1];
    expect(mb.to).toBe(b.email);
    for (const part of [mb.subject, mb.text, mb.html ?? ""]) {
      expect(part).not.toContain(a.email);
      expect(part).not.toContain("Alpha");
      expect(part).not.toContain("83 MB");
    }
    expect(mb.text).toContain('Your workspace "Bravo Clips" has used all 100 MB of its storage.');
    expect(mb.html).toContain(">101 MB<"); // B's GIFs row
    // Each record and audit row is its own workspace's.
    expect((await records(w.deps, a.workspaceId)).map((r) => [r.stage, r.email_sha256])).toEqual([[80, await emailSha256(a.email)]]);
    expect((await records(w.deps, b.workspaceId)).map((r) => [r.stage, r.email_sha256])).toEqual([[100, await emailSha256(b.email)]]);
    expect((await audits(w.deps)).map((r) => [r.workspace_id, r.subject]).sort()).toEqual(
      [
        [a.workspaceId, a.userId],
        [b.workspaceId, b.userId],
      ].sort(),
    );
  });

  it("the oldest account of the workspace, as the removal warnings use; never another account", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    // A second account in A's workspace, joined later: A's own account still gets it.
    const later = "usr_" + "e".repeat(24);
    await w.deps.db.run("INSERT INTO user (id, workspace_id, email, created_at, status) VALUES (?, ?, 'later@example.com', 1, 'active')", [later, a.workspaceId]);
    await w.deps.db.run("INSERT INTO membership (user_id, workspace_id, role, created_at) SELECT ?, ?, role, created_at + 1000 FROM membership WHERE user_id = ?", [later, a.workspaceId, a.userId]);
    await item(w.deps, a.workspaceId, 90 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    expect(w.mail.sent.map((m) => m.to)).toEqual([a.email]);
  });

  it("a disabled account, or a workspace being removed: no mail", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const b = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 90 * MB);
    await item(w.deps, b.workspaceId, 90 * MB);
    await w.deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    await w.deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [b.userId]);
    await w.deps.db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, 0, ?)", [b.userId, b.workspaceId, b.userId, T0]);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "skipped" });
    expect(await checkStorage(w.deps, b.workspaceId)).toEqual({ did: "skipped" });
    // Enabled again (and not being removed): the mail goes.
    await w.deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [a.userId]);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    expect(w.mail.sent.map((m) => m.to)).toEqual([a.email]);
    expect(await records(w.deps, b.workspaceId)).toEqual([]);
  });

  it("with billing: a trial that is over or an ended subscription is read-only and gets no mail", async () => {
    const w = await world({ allowance: null });
    withBilling(w.deps);
    await seedAccount(w.deps, { admin: true });
    const over = await seedAccount(w.deps);
    const ended = await seedAccount(w.deps);
    await w.deps.db.run("UPDATE workspace SET created_at = ? WHERE id = ?", [T0 - 91 * DAY, over.workspaceId]);
    await w.deps.db.run("UPDATE workspace SET stripe_customer_id = 'cus_E', stripe_subscription_id = 'sub_E', subscription_status = 'canceled', subscription_ended_at = ? WHERE id = ?", [T0 - DAY, ended.workspaceId]);
    await w.deps.db.run("UPDATE workspace SET created_at = ? WHERE id = ?", [T0 - DAY, ended.workspaceId]);
    await item(w.deps, over.workspaceId, TRIAL_BYTES);
    await item(w.deps, ended.workspaceId, PLAN_BYTES);
    expect(await checkStorage(w.deps, over.workspaceId)).toEqual({ did: "skipped" });
    expect(await checkStorage(w.deps, ended.workspaceId)).toEqual({ did: "skipped" });
    expect(w.mail.sent).toEqual([]);
  });
});

describe("the words", () => {
  const plain80 = (sub: string | null) =>
    [
      'Your workspace "Acme Demos" has used 81 MB of its 100 MB of storage (81%).',
      "",
      "When it is full, new uploads are refused. Everything that is already online keeps working, and nothing is deleted.",
      "",
      "See what takes the room, and delete what you no longer need:",
      "",
      `${ORIGIN}/storage`,
      "",
      ...(sub === null ? [] : ["A subscription raises the allowance to 5 GB:", "", sub, ""]),
      "You get this mail once. A second one follows only if the storage fills up completely.",
      "",
    ].join("\n");

  it("a trial on a site with billing: the approved words, with the line about a subscription and its link", async () => {
    const w = await world({ allowance: null });
    withBilling(w.deps);
    w.deps.config = { ...w.deps.config, siteHost: SITE };
    await seedAccount(w.deps, { admin: true });
    const a = await seedAccount(w.deps);
    await w.deps.db.run("UPDATE workspace SET name = 'Acme Demos' WHERE id = ?", [a.workspaceId]);
    await w.deps.db.run("UPDATE workspace SET created_at = ? WHERE id = ?", [T0 - DAY, a.workspaceId]);
    await item(w.deps, a.workspaceId, 81 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    const m = w.mail.sent[0];
    expect(m.subject).toBe("Your Mythicshot storage is 81% full");
    expect(m.text).toBe(plain80(`${ORIGIN}/billing/subscribe`));
    expect(m.html).toContain(`Need more room? <a href="${ORIGIN}/billing/subscribe"`);
    expect(m.html).toContain(">A subscription raises the allowance to 5 GB</a>.</p>");
  });

  it("subscribed, or a site without billing: no line about a subscription", async () => {
    const w = await world({ allowance: null });
    withBilling(w.deps);
    w.deps.config = { ...w.deps.config, siteHost: SITE };
    await seedAccount(w.deps, { admin: true });
    const a = await seedAccount(w.deps);
    await w.deps.db.run("UPDATE workspace SET name = 'Acme Demos', stripe_customer_id = 'cus_S', stripe_subscription_id = 'sub_S', subscription_status = 'active', subscription_period_end = ? WHERE id = ?", [T0 + 20 * DAY, a.workspaceId]);
    await item(w.deps, a.workspaceId, PLAN_BYTES);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 100 });
    const full = w.mail.sent[0];
    expect(full.subject).toBe("Your Mythicshot storage is full");
    expect(full.text).toBe(
      [
        'Your workspace "Acme Demos" has used all 5 GB of its storage.',
        "",
        "New uploads are refused until there is room again. Everything that is already online keeps working, and nothing is deleted.",
        "",
        "See what takes the room, and delete what you no longer need:",
        "",
        `${ORIGIN}/storage`,
        "",
      ].join("\n"),
    );
    expect(full.html).not.toContain("subscribe");
    expect(full.html).not.toContain(STORAGE_WORDS.once);
    expect(full.html).toContain(">Nothing left<");
    expect(full.html).toContain("background-color:#b42323;");
    expect(full.html).not.toContain("#f5b841");

    const plain = await world();
    const b = await seedAccount(plain.deps);
    await plain.deps.db.run("UPDATE workspace SET name = 'Acme Demos' WHERE id = ?", [b.workspaceId]);
    await item(plain.deps, b.workspaceId, 81 * MB);
    await checkStorage(plain.deps, b.workspaceId);
    expect(plain.mail.sent[0].text).toBe(plain80(null));
    expect(plain.mail.sent[0].html).not.toContain("subscribe");
    expect(plain.mail.sent[0].html).toContain(STORAGE_WORDS.once);
  });

  it("no address for links: words instead of a link, and no button, as the connection mail does", async () => {
    const w = await world({ siteHost: null });
    const a = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 81 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    const m = w.mail.sent[0];
    expect(m.text).toContain(STORAGE_WORDS.noLink);
    expect(m.text).not.toContain("http");
    expect(m.html).not.toContain("<a ");
    expect(m.html).not.toContain("http");
    expect(m.html).not.toContain(STORAGE_WORDS.button);
    expect(m.html).toContain(STORAGE_WORDS.noLink);
  });

  it("a hostile workspace name cannot break out of its line, its quotes, the subject or the HTML", async () => {
    const hostile = 'Evil"</b><script>alert(1)</script>\r\nBcc: x@evil.example\u2028<img src=https://evil.example/p.png> www.evil.example \'q\'';
    const m = storageMail("a@example.com", { stage: 80, workspaceName: hostile, used: 90, allowance: 100, tours: 1, gifs: 2, images: 3, origin: ORIGIN, trial: false, footer: null });
    expect(m.subject).toBe("Your Mythicshot storage is 90% full");
    const first = m.text.split("\n")[0];
    expect(m.text.split("\n")[1]).toBe("");
    expect(first.startsWith('Your workspace "')).toBe(true);
    // One pair of quotes on the line: the name's own quotes became apostrophes.
    expect(first.match(/"/g)).toHaveLength(2);
    expect(first).not.toMatch(/[\r\u2028]/);
    expect(first).not.toContain("://");
    expect(first).not.toContain("@");
    expect(first).not.toContain("www.");
    const html = m.html ?? "";
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</b><");
    expect(html).not.toContain("evil.example/p.png");
    expect(html).not.toMatch(/<img[^>]*src="(?!cid:)/);
    expect(html).toContain('>Workspace "Evil&#39;&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // Every tag in the HTML is one this file writes.
    const tags = new Set([...html.matchAll(/<\/?([a-zA-Z!]+)/g)].map((t) => t[1].toLowerCase()));
    expect([...tags].sort()).toEqual(["!doctype", "a", "b", "body", "br", "head", "html", "img", "meta", "p", "table", "td", "title", "tr"].filter((t) => tags.has(t)).sort());
    for (const t of tags) expect(["!doctype", "a", "b", "body", "br", "head", "html", "img", "meta", "p", "table", "td", "title", "tr"]).toContain(t);
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });

  it("the HTML: tables, inline styles, light colours, 520 pixels, the logo inside the mail, nothing remote", () => {
    const m = storageMail("a@example.com", { stage: 80, workspaceName: "Acme Demos", used: 81 * MB, allowance: 100 * MB, tours: 52 * MB, gifs: 21 * MB, images: 8 * MB, origin: ORIGIN, trial: true, footer: "Example Co · Sometown" });
    const html = m.html ?? "";
    expect(html).toContain("max-width:520px;");
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain("background-color:#f7f5fb;");
    expect(html).toContain("background-color:#ffffff;");
    expect(html).toContain("border:1px solid #ddd7ea;");
    expect(html).toContain("color:#1d1828;");
    expect(html).toContain("color:#5c5470;");
    expect(html.toLowerCase()).toContain("background-color:#6d4ae8;");
    expect(html.toLowerCase()).toContain("background-color:#f5b841;");
    expect(html).toContain("font-family:Manrope,system-ui,");
    // The bar: two cells of 81% and 19%.
    expect(html).toContain('<td width="81%" height="12"');
    expect(html).toContain('<td width="19%" height="12"');
    expect(html).toContain('<b style="color:#1d1828;">81 MB</b> of 100 MB used');
    expect(html).toContain(">19 MB left<");
    for (const [label, size] of [["Tours", "52 MB"], ["GIFs", "21 MB"], ["Images", "8 MB"]]) expect(html).toMatch(new RegExp(`>${label}</td><td align="right"[^>]*>${size}</td>`));
    expect(html).not.toContain("Logos");
    expect(html).toContain(`<a href="${ORIGIN}/storage"`);
    expect(html).toContain(">See what takes the room</a>");
    expect(html).toContain(`${STORAGE_WORDS.once}<br>Example Co · Sometown</td>`);
    // Pictures by Content-ID only, with alt text; nothing that reaches a server when opened.
    expect(html).toContain(`src="cid:${MARK_CID}"`);
    expect(html).toContain(`src="cid:${WORDMARK_CID}"`);
    // The mark is decoration beside the name (empty alt); the wordmark says the name.
    expect(html.match(/<img[^>]*>/g)?.map((img) => / alt="([^"]*)"/.exec(img)?.[1])).toEqual(["", "Mythicshot"]);
    const urls = [...html.matchAll(/https?:\/\/[^"'\s<)]+/g)].map((u) => u[0]);
    expect(new Set(urls)).toEqual(new Set([`${ORIGIN}/storage`, `${ORIGIN}/billing/subscribe`]));
    for (const banned of ["<script", "<link", "@import", "url(", "<style", "<div", "display:flex", "<svg"]) expect(html.toLowerCase()).not.toContain(banned);
    expect(m.inline).toEqual([
      { cid: MARK_CID, contentType: "image/png", name: "mark.png", bytes: MARK_MAIL_PNG() },
      { cid: WORDMARK_CID, contentType: "image/png", name: "wordmark.png", bytes: WORDMARK_LIGHT_PNG() },
    ]);
    // The mark is a PNG, square, 90 pixels: three times the 30 the mail shows it at.
    const png = MARK_MAIL_PNG();
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([view.getUint32(0), view.getUint32(16), view.getUint32(20)]).toEqual([0x89504e47, 90, 90]);
    expect(html).toContain('width="30" height="30" alt=""');
  });

  it("the footer line is the operator's setting, shown only when it is one usable line", () => {
    expect(mailFooterOf(undefined)).toBeNull();
    expect(mailFooterOf("   ")).toBeNull();
    expect(mailFooterOf("a\nb")).toBeNull();
    expect(mailFooterOf("x".repeat(201))).toBeNull();
    expect(mailFooterOf("  Example Co · Sometown  ")).toBe("Example Co · Sometown");
    const facts = { workspaceName: "W", used: 100, allowance: 100, tours: 0, gifs: 0, images: 0, origin: ORIGIN, trial: false } as const;
    const without = storageMail("a@example.com", { ...facts, stage: 100, footer: null });
    // The full mail without a footer line has no footer at all.
    expect(without.html).not.toContain("font-size:12px");
    const withFooter = storageMail("a@example.com", { ...facts, stage: 100, footer: "<b>Co</b>" });
    expect(withFooter.html).toContain(">&lt;b&gt;Co&lt;/b&gt;</td>");
    expect(withFooter.text).not.toContain("Co");
  });
});

describe("the sweep", () => {
  it("picks up what the requests did not send, re-arms, keeps to its cap, and a dry run changes nothing", async () => {
    const w = await world({ mail: false });
    const a = await seedAccount(w.deps);
    const b = await seedAccount(w.deps);
    const c = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 85 * MB);
    await item(w.deps, b.workspaceId, 120 * MB);
    const cImg = await item(w.deps, c.workspaceId, 20 * MB);
    await w.deps.db.run("INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 80, ?, 1, 2)", [c.workspaceId, "0".repeat(64)]);
    // Mail off: nothing read.
    const off = await storageSweep(w.deps);
    expect(off.mailOff).toBe(true);
    expect(storageSweepLines(off)).toEqual(["Mail is off, so no storage mail was sent. Nothing was changed."]);
    const on = new FakeMailer();
    const deps: Deps = { ...w.deps, mail: on };
    const dry = await storageSweep(deps, { dryRun: true });
    expect(dry).toMatchObject({ checked: 3, wouldSend: 2, rearmed: 1, sentLow: 0, sentFull: 0 });
    expect(on.sent).toEqual([]);
    expect(await records(w.deps, c.workspaceId)).toHaveLength(1);
    expect(storageSweepLines(dry)[0]).toBe("Dry run: nothing was sent or changed.");
    const capped = await storageSweep(deps, { mailsPerRun: 1 });
    expect(capped).toMatchObject({ waiting: 1, rearmed: 1 });
    expect(capped.sentLow + capped.sentFull).toBe(1);
    expect(await records(w.deps, c.workspaceId)).toEqual([]);
    const rest = await storageSweep(deps);
    expect(rest).toMatchObject({ waiting: 0 });
    expect(rest.sentLow + rest.sentFull).toBe(1);
    expect((await storageSweep(deps)).sentLow + (await storageSweep(deps)).sentFull).toBe(0);
    expect(on.sent.map((m) => [m.to, m.subject]).sort()).toEqual(
      [
        [a.email, "Your Mythicshot storage is 85% full"],
        [b.email, "Your Mythicshot storage is full"],
      ].sort(),
    );
    expect(storageSweepLines(rest)).toEqual(["Storage sweep done.", "Workspaces looked at: 3.", `Storage mails sent: 1 (running low: ${rest.sentLow}, full: ${rest.sentFull}). Not sent, tried again next time: 0.`, "Workspaces whose storage mails were armed again (below 70%): 0."]);
    expect(STORAGE_MAILS_PER_RUN).toBe(50);
    // c: drops and refills: one mail again.
    await resize(w.deps, cImg, 99 * MB);
    expect((await storageSweep(deps)).sentLow).toBe(1);
  });

  it("within one invocation's call budget: the Worker's way, which says mail is off when it has no mailer", async () => {
    const w = await world();
    for (let i = 0; i < 12; i++) {
      const s = await seedAccount(w.deps);
      await item(w.deps, s.workspaceId, 90 * MB);
    }
    const lines: string[] = [];
    const r = await storageSweepWithinBudget(w.deps, (l) => lines.push(l));
    expect(r.calls).toBeLessThanOrEqual(40);
    expect(r.summary.stoppedEarly).toBe(true);
    expect(lines).toContain("The sweep stopped at its call budget; the next sweep goes on.");
    const again = await storageSweepWithinBudget(w.deps, () => {});
    expect(again.calls).toBeLessThanOrEqual(40);
    expect(w.mail.sent.length).toBe(r.summary.sentLow + again.summary.sentLow);
    const off = await world({ mail: false });
    const said: string[] = [];
    expect((await storageSweepWithinBudget(off.deps, (l) => said.push(l))).calls).toBe(0);
    expect(said).toEqual(["Mail is off, so no storage mail was sent. Nothing was changed."]);
  });
});

describe("the requests that ask for a check", () => {
  const manifest = (title: string): Json => {
    const m = clone(fixtures.v3 as Json);
    m.title = title;
    return m;
  };

  /** The bytes the v3 fixture's tour takes, once uploaded. */
  async function tourBytes(): Promise<number> {
    const w = await world({ allowance: null });
    const a = await seedAccount(w.deps);
    await uploadTour(w.deps, a.token, manifest("Size"));
    const r = await send(w.deps, "GET", "/api/v1/usage", { token: a.token });
    return r.json.used_bytes as number;
  }

  /**
   * An allowance and a first item such that the upload's reservation (its steps and up to
   * 200,000 bytes for a logo without a stated size) fits, the item alone is under 80%, and the
   * finished tour takes the workspace past 80%.
   */
  const room = (size: number) => {
    const allowance = 10 * (size + 200_000);
    return { allowance, before: Math.floor(0.85 * allowance) - size };
  };

  it("an upload's commit that crosses 80% mails the workspace's own account after the answer", async () => {
    const size = await tourBytes();
    const { allowance, before } = room(size);
    const w = await world({ allowance });
    const a = await seedAccount(w.deps);
    const b = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, before);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    await uploadTour(w.deps, a.token, manifest("First"));
    await w.settle();
    expect(w.mail.sent.map((m) => m.to)).toEqual([a.email]);
    expect(w.mail.sent[0].subject).toMatch(/^Your Mythicshot storage is 8[0-9]% full$/);
    expect(w.mail.sent[0].html).toContain(">Tours</td>");
    expect(await records(w.deps, b.workspaceId)).toEqual([]);
  });

  it("neither fails nor waits when the mailer rejects, throws or never answers", async () => {
    const size = await tourBytes();
    const { allowance, before } = room(size);
    const w = await world({ allowance });
    const a = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, before);
    // A mailer that never answers until let go.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    w.deps.mail = { send: () => ((asked += 1), held.then(() => Promise.reject(new Error("late")))) };
    const id = await sendAll(w.deps, a.token, manifest("Held"));
    // The commit answers (not waiting for the work after its answer), while the mail never does.
    const r = await send(w.deps, "POST", `/api/v1/uploads/${id}/commit`, { token: a.token, settle: false });
    expect(r.status).toBe(201);
    expect(r.json.tour_id).toMatch(/^tour_/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(1);
    // Nothing is recorded while the mail is still on its way, beyond the claim.
    expect((await records(w.deps, a.workspaceId)).map((x) => x.sent_at)).toEqual([null]);
    release();
    await w.settle();
    expect(await records(w.deps, a.workspaceId)).toEqual([]);

    // A mailer that throws at once: the answer is the same, and the next check sends it.
    const b = await seedAccount(w.deps);
    await item(w.deps, b.workspaceId, before);
    w.deps.mail = {
      send: () => {
        throw new Error("boom");
      },
    };
    await uploadTour(w.deps, b.token, manifest("Throws"));
    await w.settle();
    expect(await records(w.deps, b.workspaceId)).toEqual([]);
    const fine = new FakeMailer();
    w.deps.mail = fine;
    expect(await checkStorage(w.deps, b.workspaceId)).toEqual({ did: "sent", stage: 80 });
    expect(fine.sent.map((m) => m.to)).toEqual([b.email]);
  });

  it("a check that fails is one fixed line, never the error, and the answer is unchanged", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 90 * MB);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      const broken: Deps = { ...w.deps, db: { ...w.deps.db, first: () => Promise.reject(new Error(`secret ${a.email}`)) } };
      storageMailSoon(broken, a.workspaceId);
      await w.settle();
    } finally {
      console.error = original;
    }
    expect(lines).toEqual(["storage mail: a check could not be made just now; the next check or sweep makes it"]);
    expect(lines.join(" ")).not.toContain(DEFER_FAILED);
  });

  it("a deleted item arms the mails again after the answer", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const img = await item(w.deps, a.workspaceId, 85 * MB);
    await checkStorage(w.deps, a.workspaceId);
    expect(await records(w.deps, a.workspaceId)).toHaveLength(1);
    const r = await send(w.deps, "DELETE", `/api/v1/media/${img}`, { token: a.token });
    expect(r.status).toBe(204);
    await w.settle();
    expect(await records(w.deps, a.workspaceId)).toEqual([]);
  });
});


describe("claims and races", () => {
  it("usage rising from 79%: a full mail claimed first makes a later 80% claim impossible, in the claim itself", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const img = await item(w.deps, a.workspaceId, 79 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    // The first commit takes it to 85% and its check reads that; before it claims, the second
    // commit takes it to 100% and its own check sends the full mail.
    await resize(w.deps, img, 85 * MB);
    const slow: Deps = {
      ...w.deps,
      db: interleaved(w.deps.db, "INSERT INTO storage_mail", async () => {
        await resize(w.deps, img, 100 * MB);
        expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 100 });
      }),
    };
    expect(await checkStorage(slow, a.workspaceId)).toEqual({ did: "none" });
    expect(w.mail.sent.map((m) => m.subject)).toEqual(["Your Mythicshot storage is full"]);
    expect((await records(w.deps, a.workspaceId)).map((r) => r.stage)).toEqual([100]);
    // An unconfirmed full claim blocks it as well.
    await w.deps.db.run("UPDATE storage_mail SET sent_at = NULL WHERE workspace_id = ?", [a.workspaceId]);
    await resize(w.deps, img, 85 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "none" });
    expect(w.mail.sent).toHaveLength(1);
  });

  it("a workspace whose removal starts, or that is gone, between the read and the claim: nothing written, nothing sent", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 90 * MB);
    const removing: Deps = {
      ...w.deps,
      db: interleaved(w.deps.db, "INSERT INTO storage_mail", () =>
        w.deps.db.run("INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) VALUES (?, ?, ?, 0, ?)", [a.userId, a.workspaceId, a.userId, T0]),
      ),
    };
    expect(await checkStorage(removing, a.workspaceId)).toEqual({ did: "none" });
    expect(await records(w.deps, a.workspaceId)).toEqual([]);
    expect(w.mail.sent).toEqual([]);

    const b = await seedAccount(w.deps);
    await item(w.deps, b.workspaceId, 90 * MB);
    const gone: Deps = {
      ...w.deps,
      db: interleaved(w.deps.db, "INSERT INTO storage_mail", () =>
        w.deps.db.batch([
          { sql: "DELETE FROM media WHERE workspace_id = ?", params: [b.workspaceId] },
          { sql: "DELETE FROM api_token WHERE workspace_id = ?", params: [b.workspaceId] },
          { sql: "DELETE FROM signin_method WHERE user_id = ?", params: [b.userId] },
          { sql: "DELETE FROM session WHERE user_id = ?", params: [b.userId] },
          { sql: "DELETE FROM signin_code WHERE user_id = ?", params: [b.userId] },
          { sql: "DELETE FROM membership WHERE workspace_id = ?", params: [b.workspaceId] },
          { sql: "DELETE FROM user WHERE id = ?", params: [b.userId] },
          { sql: "DELETE FROM workspace WHERE id = ?", params: [b.workspaceId] },
        ]),
      ),
    };
    expect(await checkStorage(gone, b.workspaceId)).toEqual({ did: "none" });
    expect(await records(w.deps, b.workspaceId)).toEqual([]);
    expect(w.mail.sent).toEqual([]);
  });

  it("a stale unconfirmed claim is said on every sweep, never resent by itself, and cleared by the admin for that workspace alone", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    const b = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 90 * MB);
    await item(w.deps, b.workspaceId, 90 * MB);
    // A's claim was left two hours ago (a process that stopped); B's was made a minute ago.
    await seedRecord(w.deps, a.workspaceId, 80, T0 - 2 * 3_600_000, null);
    await seedRecord(w.deps, b.workspaceId, 80, T0 - 60_000, null);
    for (let run = 0; run < 2; run++) {
      const s = await storageSweep(w.deps);
      expect(s).toMatchObject({ staleClaims: 1, staleClaimIds: [a.workspaceId], sentLow: 0, sentFull: 0 });
      const lines = storageSweepLines(s);
      expect(lines).toContain(`  unconfirmed ${a.workspaceId}`);
      expect(lines).toContain("Storage mails whose sending was never confirmed (not sent again for this fill-up until the claim is cleared with storage-sweep --clear-claim): 1.");
    }
    expect(w.mail.sent).toEqual([]);
    expect(await clearStorageClaim(w.deps, "ws_bad")).toBe(0);
    expect(await clearStorageClaim(w.deps, a.workspaceId)).toBe(1);
    expect(await clearStorageClaim(w.deps, a.workspaceId)).toBe(0);
    expect(await records(w.deps, a.workspaceId)).toEqual([]);
    expect(await records(w.deps, b.workspaceId)).toHaveLength(1);
    const cleared = await w.deps.db.all<{ workspace_id: string; detail: string }>("SELECT workspace_id, detail FROM audit WHERE event = 'storage_mail_claim_cleared'");
    expect(cleared).toEqual([{ workspace_id: a.workspaceId, detail: '{"count":1}' }]);
    // A confirmed row is never cleared.
    await seedRecord(w.deps, a.workspaceId, 100, T0, T0);
    expect(await clearStorageClaim(w.deps, a.workspaceId)).toBe(0);
    await w.deps.db.run("DELETE FROM storage_mail WHERE workspace_id = ?", [a.workspaceId]);
    // Cleared: the next sweep sends A's mail; B's young claim is neither sent nor stale yet.
    const after = await storageSweep(w.deps);
    expect(after).toMatchObject({ sentLow: 1, staleClaims: 0 });
    expect(w.mail.sent.map((m) => m.to)).toEqual([a.email]);
  });
});

describe("each request that changes the usage asks for a check", () => {
  const manifestOf = (title: string): Json => {
    const m = clone(fixtures.v3 as Json);
    m.title = title;
    return m;
  };

  it("a shared item's first commit sends the mail it crosses", async () => {
    const w = await world({ allowance: 10_000 });
    const a = await seedAccount(w.deps);
    await item(w.deps, a.workspaceId, 4_000);
    const made = await send(w.deps, "POST", "/api/v1/media", { token: a.token, body: JSON.stringify({ kind: "image", content_type: "image/png", bytes: 5_000, width: 64, height: 64 }), headers: { "content-type": "application/json" } });
    expect(made.status, made.text).toBe(201);
    await w.settle();
    expect(w.mail.sent).toEqual([]);
    const part = await send(w.deps, "PUT", `/api/v1/media/${made.json.id}/parts/0`, { token: a.token, body: png(64, 64, 5_000) as NonNullable<RequestInit["body"]> });
    expect(part.status, part.text).toBe(204);
    const done = await send(w.deps, "POST", `/api/v1/media/${made.json.id}/commit`, { token: a.token });
    expect(done.status, done.text).toBe(200);
    await w.settle();
    expect(w.mail.sent.map((m) => [m.to, m.subject])).toEqual([[a.email, "Your Mythicshot storage is 90% full"]]);
  });

  it("a replace of a chapter sends the mail its workspace is due", async () => {
    const w = await world({ allowance: null });
    const a = await seedAccount(w.deps);
    const tour = await uploadTour(w.deps, a.token, manifestOf("Replace me"));
    const used = (await send(w.deps, "GET", "/api/v1/usage", { token: a.token })).json.used_bytes as number;
    // An allowance with room for the replace's logo, and the workspace past 80% without a check yet.
    const allowance = 10 * (used + 200_000);
    await w.deps.db.run("UPDATE workspace SET storage_allowance_bytes = ? WHERE id = ?", [allowance, a.workspaceId]);
    await item(w.deps, a.workspaceId, Math.floor(0.85 * allowance) - used);
    const id = await sendAll(w.deps, a.token, manifestOf("Replace me"), { kind: "replace", tour_id: tour.tour_id, chapter_id: tour.chapter_id });
    const r = await send(w.deps, "POST", `/api/v1/uploads/${id}/commit`, { token: a.token });
    expect(r.status, r.text).toBe(201);
    await w.settle();
    expect(w.mail.sent.map((m) => m.to)).toEqual([a.email]);
    expect(await records(w.deps, a.workspaceId)).toHaveLength(1);
  });

  it("removing a chapter and deleting a tour arm the mails again", async () => {
    const w = await world({ allowance: 1000 * MB });
    const a = await seedAccount(w.deps);
    const tour = await uploadTour(w.deps, a.token, manifestOf("Two chapters"));
    await uploadTour(w.deps, a.token, manifestOf("Second"), { kind: "chapter", tour_id: tour.tour_id });
    await w.settle();
    await seedRecord(w.deps, a.workspaceId, 80, T0, T0);
    const chapters = await send(w.deps, "GET", `/api/v1/tours/${tour.tour_id}/chapters`, { token: a.token });
    expect(chapters.status, chapters.text).toBe(200);
    const keep = [chapters.json.chapters[0].id];
    const put = await send(w.deps, "PUT", `/api/v1/tours/${tour.tour_id}/chapters`, { token: a.token, body: JSON.stringify({ revision: chapters.json.revision, chapters: keep }), headers: { "content-type": "application/json" } });
    expect(put.status, put.text).toBe(200);
    await w.settle();
    expect(await records(w.deps, a.workspaceId)).toEqual([]);

    await seedRecord(w.deps, a.workspaceId, 100, T0, T0);
    let gone = await send(w.deps, "DELETE", `/api/v1/tours/${tour.tour_id}`, { token: a.token });
    while (gone.status === 202) gone = await send(w.deps, "DELETE", `/api/v1/tours/${tour.tour_id}`, { token: a.token });
    expect(gone.status, gone.text).toBe(200);
    await w.settle();
    expect(await records(w.deps, a.workspaceId)).toEqual([]);
  });
});

describe("the subscription line", () => {
  it("is absent when billing is off, even for a workspace marked for a trial", async () => {
    const w = await world();
    const a = await seedAccount(w.deps);
    await w.deps.db.run("UPDATE workspace SET billing_trial = 1, created_at = ? WHERE id = ?", [T0 - DAY, a.workspaceId]);
    await item(w.deps, a.workspaceId, 90 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 80 });
    expect(w.mail.sent[0].text).not.toContain("subscription");
    expect(w.mail.sent[0].html).not.toContain("subscribe");
  });

  it("is absent for a trial whose allowance, set by the admin, is already the plan's or more", async () => {
    const facts = { stage: 80 as const, workspaceName: "W", tours: 0, gifs: 0, images: 0, origin: ORIGIN, trial: true, footer: null };
    expect(storageMail("a@example.com", { ...facts, used: Math.floor(PLAN_BYTES * 0.9), allowance: PLAN_BYTES }).text).not.toContain("subscription");
    expect(storageMail("a@example.com", { ...facts, used: Math.floor(PLAN_BYTES * 1.8), allowance: PLAN_BYTES * 2 }).html).not.toContain("subscribe");
    expect(storageMail("a@example.com", { ...facts, used: PLAN_BYTES - 1000, allowance: PLAN_BYTES - 1 }).text).toContain("A subscription raises the allowance to 5 GB:");
    // Through the check: a trial on a site with billing whose admin set 6 GB.
    const w = await world({ allowance: null });
    withBilling(w.deps);
    w.deps.config = { ...w.deps.config, siteHost: SITE };
    await seedAccount(w.deps, { admin: true });
    const a = await seedAccount(w.deps);
    await w.deps.db.run("UPDATE workspace SET created_at = ?, storage_allowance_bytes = ? WHERE id = ?", [T0 - DAY, 6 * 1024 * MB, a.workspaceId]);
    await item(w.deps, a.workspaceId, 6 * 1024 * MB);
    expect(await checkStorage(w.deps, a.workspaceId)).toEqual({ did: "sent", stage: 100 });
    expect(w.mail.sent[0].text).not.toContain("subscription");
  });
});

describe("the storage sweep on Workers", () => {
  it("the scheduled handler runs it with no mailer, reading nothing, and nothing on settings it cannot use", async () => {
    const load = import.meta.glob("../src/cloudflare/entry.ts");
    const entry = (await load["../src/cloudflare/entry.ts"]()) as {
      scheduledStorageSweep(env: Record<string, unknown>): Promise<unknown>;
      default: { scheduled(c: unknown, env: Record<string, unknown>, ctx: unknown): Promise<void> };
    };
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the database was used");
        },
      },
    );
    const env = { DB: untouchable, DRAFTS: untouchable, PUB: untouchable };
    const logged: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      expect(await entry.scheduledStorageSweep(env)).toEqual(expect.objectContaining({ mailOff: true, checked: 0 }));
      await entry.default.scheduled({}, env, {});
      expect(await entry.scheduledStorageSweep({ ...env, TOURS_HOST: "tours.example.com" })).toBeNull();
      expect(await entry.scheduledStorageSweep({ ...env, STORAGE_ALLOWANCE_BYTES: "lots" })).toBeNull();
      expect(await entry.scheduledStorageSweep({ ...env, STRIPE_API_KEY: "rk_test_FAKE" })).toBeNull();
    } finally {
      console.log = log;
      console.error = error;
    }
    expect(logged).toContain("Mail is off, so no storage mail was sent. Nothing was changed.");
    expect(errors).toContain("storage sweep: a setting cannot be used; nothing was swept");
    for (const line of [...logged, ...errors]) expect(line).not.toContain("rk_test_FAKE");
  });
});

describe("what a mail carries", () => {
  it("the fake mailer keeps a designed mail's parts, and a plain mail stays its three strings", async () => {
    const fake = new FakeMailer();
    const plain: Mail = { to: "a@example.com", subject: "S", text: "T\n" };
    await fake.send(plain);
    expect(fake.sent[0]).toEqual(plain);
    expect(Object.keys(fake.sent[0])).toEqual(["to", "subject", "text"]);
  });
});
