// The billing sweep (0.1.61, Plan 2l items 7 and 8): the housekeeping that mails the three
// warnings before a workspace's content is removed, and, only with BILLING_REMOVAL=on, removes
// the content of a workspace whose warnings all went out and whose removal day has come. The
// rules of the clock are src/removal-rules.ts; the mails are src/removal-mail.ts; the removal
// itself is an account delete's own steps (src/account-removal.ts), never a second deletion path.
//
// It runs only from outside the web app: the server's admin command `billing-sweep` (Node,
// src/node/admin.ts) and the Worker's scheduled handler (src/cloudflare/entry.ts). No route of
// the app reaches it, so no HTTP request, an admin's included, can start a removal, and no request
// path sends a warning mail.
//
// A workspace's content is removed only when ALL of these hold, each read at the moment of the
// removal (the numbers are the list in the README):
// 1. billing is on, and the workspace is on the trial's or an ended subscription's clock
//    (clockOf: not exempt, not the admin's, not an existing account, no allowance set by hand,
//    not the workspace the site was set up with), with one active account that is no admin;
// 2. its removal day has come and the stored end of its 90 days has passed;
// 3. all three warnings for THIS removal day were accepted by the mail server, the first at
//    least 29 days and the last at least 20 hours before now, none left unconfirmed, and no
//    stored time is ahead of the clock;
// 4. the account's address is the one the warnings went to (they are recorded under its digest:
//    another address counts for nothing, and the warnings start over for it);
// 5. Stripe, asked right then, says the subscription on record is ended (no subscription and no
//    customer on record: a trial, nothing to ask), and every checkout this site made for the
//    workspace is expired; none is pending on the record. Any other answer, a 404 included
//    (missingAllowsRemoval), holds it back; a live subscription is stored as Stripe says it;
// 6. no export of the workspace is in progress or was started in the last hour (exportInProgress);
// 7. this run has started or continued fewer than REMOVALS_PER_RUN removals, and the sweeps fewer
//    than REMOVALS_PER_DAY in the last 24 hours (from the audit record); and the sweep is no dry run.
// The start is one guarded batch that disables the account (sessions ended, codes spent, as an
// admin's disable does) and records the removal, under the same conditions read again in SQL; if
// anything changed meanwhile nothing is written. From then on the account cannot sign in, its
// tokens are refused and nothing of the workspace is served, so a removal stopped half-way leaves
// nothing reachable; the next sweep continues it to the end. Audit rows: billing_removal_started
// (counts), billing_removal_step (files left after each pass), the deletion's own account_deleted,
// and billing_removal_finished, with the workspace's id and counts only.
import { CALLS_AT_THE_END, FILES_SQL, aloneIn, filesParams, readTarget, work } from "./account-removal.ts";
import { auditStatement } from "./audit.ts";
import { BILLING_COLUMNS_SQL, DAY, ENDED_STATUSES, LIVE_STATUSES, REMOVAL_MS, TRIAL_MS, WORKSPACE_IS_ADMIN_SQL, billingConfigured, type BillingRow } from "./billing-rules.ts";
import { checkoutBeforeRemoval, prepareDeletion, subscriptionBeforeRemoval } from "./billing.ts";
import { SUBREQUEST_BUDGET, metered } from "./budget.ts";
import { linkOrigin } from "./mail.ts";
import { canMailLinks, isNotNullViolation, mailOf, type Deps } from "./ports.ts";
import { warningMail } from "./removal-mail.ts";
import { CLOCK_SKEW_MS, REMOVALS_PER_DAY, REMOVALS_PER_RUN, SWEEP_ACTOR, clockOf, notDueReason, planOf, removalSwitchedOn, type Clock, type WarningStage } from "./removal-rules.ts";
import { WARNINGS_JSON_SQL, emailSha256, warningsOf } from "./removal-store.ts";

/**
 * INTEGRATOR HOOK (condition 6): whether an export of the workspace ("Download all my data",
 * built in parallel) is in progress or was started within EXPORT_QUIET_MS. This build has no
 * export, so nothing is ever in progress. The merge that brings the download in replaces this
 * body with a read of its own table or flag, and flips DOWNLOAD_ALL_BUILT (src/removal-rules.ts).
 */
export async function exportInProgress(_deps: Deps, _workspaceId: string): Promise<boolean> {
  return false;
}

/** The most checkouts of one workspace the last check asks Stripe about; more holds the removal back. */
export const CHECKOUTS_ASKED = 10;
/** Workspaces read per page of the sweep. */
const PAGE = 50;
/** On Node, how many passes of a removal's steps one sweep makes at most for one workspace. */
const PASSES_AT_MOST = 10_000;

export type SweepOptions = {
  /** Lists what would be sent and removed; sends, writes and removes nothing. */
  dryRun?: boolean;
  /** BILLING_REMOVAL is on (removalSwitchedOn). Without it nothing is ever removed. */
  removal: boolean;
  /**
   * The calls made so far on these deps, when they are metered for one invocation within
   * SUBREQUEST_BUDGET (the Worker's scheduled handler). Absent: no budget (the Node command),
   * and each pass of a removal's steps is metered on its own.
   */
  calls?: () => number;
  perRun?: number;
  perDay?: number;
  exportInProgress?: (deps: Deps, workspaceId: string) => Promise<boolean>;
};

/** What a sweep did, in counts (and, for a dry run, the ids of the workspaces it would remove). */
export type SweepSummary = {
  billing: boolean;
  removal: boolean;
  dryRun: boolean;
  checked: number;
  mailsSent: number;
  mailsFailed: number;
  mailsWouldSend: number;
  mailOff: boolean;
  unconfirmed: number;
  removalsStarted: number;
  removalsFinished: number;
  removalsInProgress: number;
  removalOff: number;
  held: number;
  capped: number;
  wouldRemove: string[];
  stoppedEarly: boolean;
};

type Candidate = BillingRow & { site: number; removing: number; alone: number; user_id: string | null; email: string | null; user_status: string | null; user_admin: number | null; warnings: string };

const quoted = (list: readonly string[]) => list.map((s) => `'${s}'`).join(", ");

/** The workspaces whose clock may have a warning or a removal due by `?` (now and 31 days), after the id `?`, by id. */
const CANDIDATES_SQL =
  "SELECT workspace.id AS id FROM workspace WHERE workspace.id > ? AND workspace.billing_trial = 1 AND workspace.storage_allowance_bytes IS NULL" +
  ` AND (workspace.subscription_status IS NULL OR workspace.subscription_status NOT IN (${quoted([...LIVE_STATUSES])}))` +
  ` AND NOT ${WORKSPACE_IS_ADMIN_SQL}` +
  " AND NOT EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = workspace.id)" +
  " AND NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.workspace_id = workspace.id)" +
  ` AND CASE WHEN workspace.subscription_status IN (${quoted([...ENDED_STATUSES])})` +
  ` THEN coalesce(workspace.subscription_ended_at, workspace.subscription_cancel_at, workspace.subscription_period_end) + ${REMOVAL_MS}` +
  ` ELSE workspace.created_at + ${TRIAL_MS} END <= ? ORDER BY workspace.id LIMIT ${PAGE}`;

/** Everything the sweep reads of one workspace, in one call: its billing row, its oldest account, and its warnings. */
const CANDIDATE_SQL =
  `SELECT ${BILLING_COLUMNS_SQL}, EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = workspace.id) AS site,` +
  " EXISTS (SELECT 1 FROM account_removal r WHERE r.workspace_id = workspace.id) AS removing," +
  ` CASE WHEN ou.id IS NOT NULL AND ${aloneIn("workspace.id", "ou.id")} THEN 1 ELSE 0 END AS alone,` +
  ` ou.id AS user_id, ou.email AS email, ou.status AS user_status, ou.is_admin AS user_admin, ${WARNINGS_JSON_SQL} AS warnings` +
  " FROM workspace LEFT JOIN membership om ON om.workspace_id = workspace.id LEFT JOIN user ou ON ou.id = om.user_id" +
  " WHERE workspace.id = ? ORDER BY om.created_at, ou.id LIMIT 1";

function emptySummary(billing: boolean, opts: SweepOptions): SweepSummary {
  return {
    billing,
    removal: opts.removal === true,
    dryRun: opts.dryRun === true,
    checked: 0,
    mailsSent: 0,
    mailsFailed: 0,
    mailsWouldSend: 0,
    mailOff: false,
    unconfirmed: 0,
    removalsStarted: 0,
    removalsFinished: 0,
    removalsInProgress: 0,
    removalOff: 0,
    held: 0,
    capped: 0,
    wouldRemove: [],
    stoppedEarly: false,
  };
}

/**
 * One sweep. Without billing it reads nothing and does nothing. Each workspace gets at most one
 * thing done per sweep: one warning mail, or its removal started or continued. The removals the
 * sweep started and did not finish are continued first (only with removal on, and not in a dry
 * run), within the cap per run.
 */
export async function billingSweep(deps: Deps, opts: SweepOptions): Promise<SweepSummary> {
  const s = emptySummary(billingConfigured(deps.config), opts);
  if (!s.billing) return s;
  const calls = opts.calls;
  const room = (cost: number) => calls === undefined || calls() + cost + CALLS_AT_THE_END <= SUBREQUEST_BUDGET;
  const perRun = opts.perRun ?? REMOVALS_PER_RUN;
  const perDay = opts.perDay ?? REMOVALS_PER_DAY;
  const busy = opts.exportInProgress ?? exportInProgress;
  let touched = 0;
  let startedToday: number | null = null;

  // The sweep's own removals that are not finished: continued before anything else.
  if (!room(1)) return stop(s);
  const open = await deps.db.all<{ user_id: string; workspace_id: string }>("SELECT user_id, workspace_id FROM account_removal WHERE started_by = ? ORDER BY created_at, user_id LIMIT ?", [SWEEP_ACTOR, perRun + 1]);
  for (const r of open) {
    if (s.dryRun || !s.removal) {
      s.removalsInProgress += 1;
      continue;
    }
    if (touched >= perRun) {
      s.capped += 1;
      continue;
    }
    touched += 1;
    const outcome = await continueRemoval(deps, r.user_id, r.workspace_id, room, calls);
    if (outcome === "deleted") s.removalsFinished += 1;
    else if (outcome === "held") s.held += 1;
    else s.removalsInProgress += 1;
    if (outcome === "stopped") return stop(s);
  }

  let after = "";
  for (;;) {
    if (!room(1)) return stop(s);
    const page = await deps.db.all<{ id: string }>(CANDIDATES_SQL, [after, deps.now() + 31 * DAY]);
    for (const { id } of page) {
      after = id;
      if (!room(4)) return stop(s);
      const c = await deps.db.first<Candidate>(CANDIDATE_SQL, [id]);
      if (c === null) continue;
      s.checked += 1;
      const now = deps.now();
      const clock = clockOf(c, c.site === 1, now);
      // Condition 1: on the clock, one account of the workspace, active, no admin, no removal recorded.
      if (clock === null || c.removing === 1 || c.alone !== 1 || c.user_id === null || c.email === null || c.user_status !== "active" || c.user_admin !== 0) continue;
      const email = await emailSha256(c.email);
      const plan = planOf(clock, warningsOf(c.warnings), email, now);
      if (plan.unconfirmed) {
        s.unconfirmed += 1;
        continue;
      }
      if (plan.due !== null) {
        await sendWarning(deps, s, c, clock, email, plan.due);
        continue;
      }
      if (notDueReason(clock, plan, now) !== null) continue;
      // Due for removal. Condition 7 first: the setting, then the caps.
      if (!s.removal && !s.dryRun) {
        s.removalOff += 1;
        continue;
      }
      if (touched >= perRun) {
        s.capped += 1;
        continue;
      }
      // The count, the checkouts and the first questions to Stripe, the start, and a pass's start.
      if (!room(12)) return stop(s);
      if (startedToday === null) {
        const n = await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM audit WHERE event = 'billing_removal_started' AND at > ?", [now - DAY]);
        startedToday = n?.n ?? 0;
      }
      if (startedToday >= perDay) {
        s.capped += 1;
        continue;
      }
      // Conditions 5 and 6, asked last, right before the start.
      if (await heldBack(deps, c, busy, room, !s.dryRun)) {
        s.held += 1;
        continue;
      }
      touched += 1;
      startedToday += 1;
      if (s.dryRun) {
        s.wouldRemove.push(c.id);
        continue;
      }
      if (!(await startRemoval(deps, c, clock))) {
        s.held += 1;
        continue;
      }
      s.removalsStarted += 1;
      const outcome = await continueRemoval(deps, c.user_id, c.id, room, calls);
      if (outcome === "deleted") s.removalsFinished += 1;
      else if (outcome === "held") s.held += 1;
      else s.removalsInProgress += 1;
      if (outcome === "stopped") return stop(s);
    }
    if (page.length < PAGE) break;
  }
  return s;
}

function stop(s: SweepSummary): SweepSummary {
  s.stoppedEarly = true;
  return s;
}

/**
 * Sends the warning that is due, to the account's own address: claimed first (so it is never sent
 * twice), then handed to the mail server, then recorded as accepted with its audit row. Mail off,
 * or no address of the site's own for its links: nothing is written and nothing sent. A send the
 * mail server refused before taking the mail takes its claim back, so it is tried again at the next
 * sweep; one that failed after the mail's text was handed over (it may have been delivered) keeps
 * its claim unconfirmed and is never sent again.
 */
async function sendWarning(deps: Deps, s: SweepSummary, c: Candidate, clock: Clock, email: string, due: { stage: WarningStage; namedAt: number }): Promise<void> {
  const origin = linkOrigin(deps.config);
  if (!canMailLinks(deps) || origin === null || c.email === null) {
    s.mailOff = true;
    return;
  }
  const mail = warningMail(c.email, { kind: clock.kind, stage: due.stage, removalAt: due.namedAt, endedAt: clock.kind === "ended" ? clock.started : null }, origin);
  if (s.dryRun) {
    s.mailsWouldSend += 1;
    return;
  }
  const key = [c.id, clock.removalDay, due.stage, email];
  const claimed = await deps.db.run(
    "INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT DO NOTHING",
    [...key, deps.now(), due.namedAt],
  );
  if (claimed.changes !== 1) return;
  try {
    await mailOf(deps).send(mail);
  } catch (err) {
    s.mailsFailed += 1;
    // Handed over and then failed: it may have arrived, so it stays claimed and is never sent again.
    if ((err as { bodyWritten?: unknown } | null)?.bodyWritten === true) return;
    await deps.db.run("DELETE FROM billing_warning WHERE workspace_id = ? AND removal_at = ? AND stage = ? AND email_sha256 = ? AND sent_at IS NULL", key);
    return;
  }
  await deps.db.batch([
    { sql: "UPDATE billing_warning SET sent_at = ? WHERE workspace_id = ? AND removal_at = ? AND stage = ? AND email_sha256 = ? AND sent_at IS NULL", params: [deps.now(), ...key] },
    auditStatement(deps, { event: "billing_warning_sent", workspaceId: c.id, subject: c.user_id, detail: { stage: due.stage, kind: clock.kind } }, { onlyAfterOneChange: true }),
  ]);
  s.mailsSent += 1;
}

/**
 * Conditions 5 and 6: true when the removal must wait. An export in progress; a checkout pending
 * on the record or one of the site's checkouts for the workspace not yet expired by its own clock;
 * more checkouts than CHECKOUTS_ASKED; any checkout Stripe does not say is expired; a customer on
 * record with no subscription; and a subscription Stripe does not say is ended. `repair` stores a
 * live status Stripe answers (not in a dry run).
 */
async function heldBack(deps: Deps, c: Candidate, busy: (deps: Deps, ws: string) => Promise<boolean>, room: (cost: number) => boolean, repair: boolean): Promise<boolean> {
  if (await busy(deps, c.id)) return true;
  if (c.checkout_session !== null) return true;
  const now = deps.now();
  const checkouts = await deps.db.all<{ id: string; expires_at: number }>("SELECT id, expires_at FROM stripe_checkout WHERE workspace_id = ? ORDER BY created_at DESC, id LIMIT ?", [c.id, CHECKOUTS_ASKED + 1]);
  if (checkouts.length > CHECKOUTS_ASKED || checkouts.some((k) => k.expires_at > now - CLOCK_SKEW_MS)) return true;
  for (const k of checkouts) {
    if (!room(2)) return true;
    if ((await checkoutBeforeRemoval(deps, k.id)) !== "expired") return true;
  }
  if (c.subscription === null) return c.customer !== null;
  if (!room(3)) return true;
  return (await subscriptionBeforeRemoval(deps, c, repair)) !== "ended";
}

/**
 * Starts the removal in one batch, under the conditions read again in SQL: the account still
 * active, no admin, with the address the warnings went to, alone in its workspace; the workspace
 * still on the clock exactly as read (its subscription, customer, end and creation unchanged, no
 * allowance by hand, no pending checkout, not the site's own) with no checkout of it unexpired;
 * and no removal recorded. The account is disabled as an admin's disable does it (sessions ended,
 * codes and email change spent) and the removal recorded under SWEEP_ACTOR, with two audit rows
 * that guard the batch. False when anything changed meanwhile: nothing was written.
 */
async function startRemoval(deps: Deps, c: Candidate, clock: Clock): Promise<boolean> {
  const ws = c.id;
  const uid = c.user_id!;
  const now = deps.now();
  const counts = await deps.db.first<{ files: number; tours: number; items: number }>(
    `SELECT (${FILES_SQL}) AS files, (SELECT count(*) FROM tour WHERE workspace_id = ?) AS tours, (SELECT count(*) FROM media WHERE workspace_id = ?) AS items`,
    [...filesParams(ws), ws, ws],
  );
  try {
    await deps.db.batch([
      {
        sql:
          "UPDATE user SET status = 'disabled' WHERE id = ? AND status = 'active' AND is_admin = 0 AND email = ?" +
          " AND EXISTS (SELECT 1 FROM workspace w WHERE w.id = ? AND w.billing_trial = 1 AND w.storage_allowance_bytes IS NULL AND w.checkout_session_id IS NULL" +
          " AND w.subscription_status IS ? AND w.stripe_subscription_id IS ? AND w.stripe_customer_id IS ? AND w.subscription_ended_at IS ? AND w.created_at = ?)" +
          " AND NOT EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = ?)" +
          " AND NOT EXISTS (SELECT 1 FROM stripe_checkout k WHERE k.workspace_id = ? AND k.expires_at > ?)" +
          " AND NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.user_id = ? OR r.workspace_id = ?)" +
          ` AND ${aloneIn("?", "user.id")}`,
        params: [uid, c.email, ws, c.status, c.subscription, c.customer, c.ended_at, c.created_at, ws, ws, now - CLOCK_SKEW_MS, uid, ws, ws, ws],
      },
      auditStatement(deps, { event: "account_disabled", workspaceId: ws, subject: uid, detail: { by: "billing_sweep" } }, { onlyAfterOneChange: true }),
      { sql: "UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", params: [now, uid] },
      { sql: "UPDATE signin_code SET used_at = ? WHERE user_id = ? AND used_at IS NULL", params: [now, uid] },
      { sql: "UPDATE email_change SET used_at = ? WHERE user_id = ? AND used_at IS NULL", params: [now, uid] },
      {
        sql: `INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at) SELECT ?, ?, ?, ${FILES_SQL}, ? WHERE NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.user_id = ?)`,
        params: [uid, ws, SWEEP_ACTOR, ...filesParams(ws), now, uid],
      },
      auditStatement(
        deps,
        { event: "billing_removal_started", workspaceId: ws, subject: uid, detail: { kind: clock.kind, files: counts?.files ?? 0, tours: counts?.tours ?? 0, items: counts?.items ?? 0 } },
        { onlyAfterOneChange: true },
      ),
    ]);
  } catch (err) {
    if (isNotNullViolation(err)) return false;
    throw err;
  }
  return true;
}

/**
 * Continues a removal the sweep started (account_removal under SWEEP_ACTOR) with the account
 * delete's own steps: prepareDeletion (Stripe), then `work`, then a billing_removal_step audit row
 * with the files left; once the last batch took effect, billing_removal_finished. With `calls` (a
 * metered invocation) one pass within the budget; without, passes until it is done, each metered
 * on its own. "deleted" when finished, "more" when steps are left for the next sweep, "held" when
 * Stripe gave no definite answer or a step failed (nothing is lost: the next sweep tries again),
 * "stopped" when the invocation's budget ran out.
 */
async function continueRemoval(deps: Deps, userId: string, ws: string, room: (cost: number) => boolean, calls: (() => number) | undefined): Promise<"deleted" | "more" | "held" | "stopped"> {
  // Its two reads, prepareDeletion's own read and the audit row of a pass fit, whatever comes after.
  if (!room(5)) return "stopped";
  const t = await readTarget(deps, userId);
  if (t === null || t.workspace_id !== ws || t.removing !== 1 || t.status !== "disabled") return "held";
  const record = await deps.db.first<{ total: number }>("SELECT total FROM account_removal WHERE user_id = ? AND workspace_id = ? AND started_by = ?", [userId, ws, SWEEP_ACTOR]);
  if (record === null) return "held";
  for (let pass = 0; pass < PASSES_AT_MOST; pass++) {
    const meter = calls === undefined ? metered(deps) : null;
    const d = meter?.deps ?? deps;
    const used = meter?.calls ?? calls!;
    const fits = (cost: number) => used() + cost + CALLS_AT_THE_END <= SUBREQUEST_BUDGET;
    let outcome: "deleted" | "more";
    try {
      const prepared = await prepareDeletion(d, ws, SWEEP_ACTOR, fits);
      if (prepared === "failed") return "held";
      outcome = prepared === "more" ? "more" : await work(d, used, t, SWEEP_ACTOR);
    } catch {
      // Fixed text only: the error could carry anything a back end put in its message.
      console.error("billing sweep: a removal could not go on just now; the next sweep continues it");
      return "held";
    }
    if (outcome === "deleted") {
      await deps.db.batch([auditStatement(deps, { event: "billing_removal_finished", workspaceId: ws, subject: userId, detail: { files: record.total } })]);
      return "deleted";
    }
    // The pass's audit row with the files left (two calls), when the invocation still has them;
    // a pass cut off at the very end of the budget is counted in the next pass's row.
    if (calls === undefined || room(0)) {
      const left = await deps.db.first<{ left: number }>(`SELECT ${FILES_SQL} AS left`, filesParams(ws));
      await deps.db.batch([auditStatement(deps, { event: "billing_removal_step", workspaceId: ws, subject: userId, detail: { left: left?.left ?? 0 } })]);
    }
    if (calls !== undefined) return room(1) ? "more" : "stopped";
  }
  return "more";
}

/**
 * What a sweep says, one line each, counts only (and the ids of the workspaces a dry run would
 * remove, which hold nothing of what is in them). The admin command prints these; the Worker's
 * scheduled handler logs them.
 */
export function sweepLines(s: SweepSummary): string[] {
  if (!s.billing) return ["Billing is off on this site, so there is nothing to sweep. Nothing was changed."];
  const lines = [
    s.dryRun ? "Dry run: nothing was sent, changed or removed." : "Billing sweep done.",
    `Workspaces looked at: ${s.checked}.`,
    s.dryRun ? `Warning mails that would be sent: ${s.mailsWouldSend}.` : `Warning mails sent: ${s.mailsSent}. Not sent, tried again next time: ${s.mailsFailed}.`,
  ];
  if (s.mailOff) lines.push("Mail is off, or the site has no address for links, so no warning mail was sent and nothing can be removed.");
  if (s.unconfirmed > 0) lines.push(`Warning mails whose sending was never confirmed (these workspaces are never removed for this date): ${s.unconfirmed}.`);
  if (!s.removal) lines.push(`Removal is off (BILLING_REMOVAL is not on). Workspaces that would be due: ${s.dryRun ? s.wouldRemove.length : s.removalOff}.`);
  if (s.dryRun) {
    lines.push(`Workspaces that would be removed: ${s.wouldRemove.length}.`);
    for (const id of s.wouldRemove) lines.push(`  would remove ${id}`);
  } else {
    lines.push(`Removals started: ${s.removalsStarted}. Finished: ${s.removalsFinished}. Still in progress: ${s.removalsInProgress}.`);
  }
  lines.push(`Held back (Stripe, a checkout, an export or a change meanwhile): ${s.held}. Over the cap of this run or day: ${s.capped}.`);
  if (s.stoppedEarly) lines.push("The sweep stopped at its call budget; the next sweep goes on.");
  return lines;
}

/**
 * One sweep within the call budget of one invocation (SUBREQUEST_BUDGET), as the Worker's
 * scheduled handler runs it: the deps are metered here, BILLING_REMOVAL's value decides removal
 * (removalSwitchedOn), and each summary line goes to `log`. A removal cut off by the budget goes
 * on at the next invocation. Answers the summary and the calls made.
 */
export async function sweepWithinBudget(deps: Deps, removalSetting: unknown, log: (line: string) => void = (line) => console.log(line)): Promise<{ summary: SweepSummary; calls: number }> {
  const meter = metered(deps);
  const summary = await billingSweep(meter.deps, { removal: removalSwitchedOn(removalSetting), calls: meter.calls });
  for (const line of sweepLines(summary)) log(line);
  return { summary, calls: meter.calls() };
}
