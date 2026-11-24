// The billing sweep (0.1.61, Plan 2l items 7 and 8): the housekeeping that mails the three
// warnings before a workspace's content is removed, and, only with BILLING_REMOVAL=on, removes
// the content of a workspace whose warnings all went out and whose removal day has come. The
// rules of the clock are src/removal-rules.ts; the mails are src/removal-mail.ts; the removal
// itself is an account delete's own steps (src/account-removal.ts), never a second deletion path.
//
// It runs only from outside the web app: the server's admin command `billing-sweep` (Node,
// src/node/admin.ts) and the Worker's scheduled handler (src/cloudflare/entry.ts). No route of
// the app reaches it, so no HTTP request, an admin's included, can start a removal, and no request
// path sends a warning mail. One sweep runs at a time (a lock row in rate_counter); a second one
// started meanwhile does nothing.
//
// A workspace's content is removed only when ALL of these hold, each read at the moment of the
// removal (the numbers are the list in the README):
// 1. billing is on, and the workspace is on the trial's or an ended subscription's clock
//    (clockOf: not exempt, not the admin's, not an existing account, no allowance set by hand,
//    not the workspace the site was set up with, exactly one account), that account active and
//    no admin;
// 2. its removal day has come and the stored end of its 90 days has passed;
// 3. all three warnings for THIS removal day were accepted by the mail server, the first at
//    least 29 days and the last at least 20 hours before now, none left unconfirmed, and no
//    stored time is ahead of the clock;
// 4. the account's address is the one the warnings went to;
// 5. Stripe, asked right then, gives a definite answer: no subscription and no customer on record
//    (a trial), or a subscription of the record's customer that is not live. One Stripe never
//    leaves (`canceled`, `incomplete_expired`) is over; any other (`unpaid`, `paused`,
//    `incomplete`) is cancelled at Stripe first, and the removal goes on only once Stripe said
//    `canceled`. Every checkout this site made for the workspace is expired at Stripe, none is
//    pending on the record, and records more than 7 days past their expiry are cleared first. A
//    404, a timeout, a permission error or any unexpected answer holds it back; a live status is
//    stored as Stripe says it and holds it back;
// 6. no export of the workspace is in progress or was started in the last hour (exportInProgress);
// 7. this run has started or continued fewer than REMOVALS_PER_RUN removals, and the sweeps fewer
//    than REMOVALS_PER_DAY in the last 24 hours (from the audit record); the sweep is no dry run;
// 8. the server's clock and Stripe's (the Date of a Stripe answer of this run, or one request for
//    the configured price) are within an hour of each other.
// The start is one guarded batch that disables the account (sessions ended, codes spent, as an
// admin's disable does) and records the removal, under the same conditions read again in SQL. From
// then on the account cannot sign in, its tokens are refused and nothing of the workspace is
// served. Before EVERY pass of its steps the workspace is read again: a live subscription (stored
// or at Stripe), a checkout made after the start or not expired, or a workspace that left the
// clock STOPS the removal for good, before anything is cancelled or deleted: the account stays
// disabled with its removal record, so the admin can look at it and undo it, the audit record gets
// billing_removal_stopped (a billing problem on the Admin page), and no sweep continues it. Audit
// rows: billing_removal_started (counts), billing_removal_step (files left after each pass), the
// deletion's own account_deleted, and billing_removal_finished, with ids and counts only.
import { CALLS_AT_THE_END, FILES_SQL, aloneIn, filesParams, readTarget, work } from "./account-removal.ts";
import { auditStatement } from "./audit.ts";
import { BILLING_COLUMNS_SQL, DAY, LAPSED_STATUSES, LIVE_STATUSES, REMOVAL_MS, TRIAL_MS, WORKSPACE_IS_ADMIN_SQL, billingConfigured, isFinal, isLive, type BillingRow } from "./billing-rules.ts";
import { checkoutBeforeRemoval, prepareDeletion, subscriptionBeforeRemoval } from "./billing.ts";
import { SUBREQUEST_BUDGET, metered } from "./budget.ts";
import { linkOrigin } from "./mail.ts";
import { canMailLinks, isNotNullViolation, mailOf, type Db, type Deps } from "./ports.ts";
import { warningMail } from "./removal-mail.ts";
import { CLOCK_SKEW_MS, ONE_ACCOUNT_SQL, REMOVALS_PER_DAY, REMOVALS_PER_RUN, SWEEP_ACTOR, clockOf, notDueReason, planOf, removalSwitchedOn, type Clock, type WarningStage } from "./removal-rules.ts";
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
/** The most warning mails one sweep sends (or tries); the rest wait for the next, those due longest first. */
export const MAILS_PER_RUN = 50;
/** Checkout records more than this past their expiry are cleared by the sweep, for workspaces on the clock. */
export const CHECKOUT_KEEP_MS = 7 * DAY;
/** How far the server's clock and Stripe's may be apart before nothing is removed. */
export const CLOCK_TOLERANCE_MS = 3_600_000;
/** How long the run lock holds when a sweep stops without letting it go. */
export const LOCK_MS = 2 * 3_600_000;
/** The run lock's row in rate_counter (bucket, key): one at a time, for the whole site. */
const LOCK_BUCKET = "billing_sweep_lock";
const LOCK_KEY = "site";
/** Workspaces read per page of the sweep. */
const PAGE = 50;
/** On Node, how many passes of a removal's steps one sweep makes at most for one workspace. */
const PASSES_AT_MOST = 10_000;
const WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;

export type SweepOptions = {
  /** Lists what would be sent and removed; sends, writes and removes nothing (every write is suppressed). */
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
  mailsPerRun?: number;
  exportInProgress?: (deps: Deps, workspaceId: string) => Promise<boolean>;
};

/** What a sweep did, in counts (and the ids of the workspaces a dry run would remove, or with an unconfirmed claim). */
export type SweepSummary = {
  billing: boolean;
  removal: boolean;
  dryRun: boolean;
  alreadyRunning: boolean;
  checked: number;
  mailsSent: number;
  mailsFailed: number;
  mailsWouldSend: number;
  mailsWaiting: number;
  mailOff: boolean;
  unconfirmed: number;
  unconfirmedIds: string[];
  removalsStarted: number;
  removalsFinished: number;
  removalsInProgress: number;
  removalsStopped: number;
  removalOff: number;
  held: number;
  capped: number;
  clock: "unchecked" | "ok" | "off" | "unread";
  publicBucket: boolean;
  wouldRemove: string[];
  stoppedEarly: boolean;
};

type Candidate = BillingRow & { site: number; removing: number; alone: number; user_id: string | null; email: string | null; user_status: string | null; user_admin: number | null; warnings: string };

const quoted = (list: readonly string[]) => list.map((s) => `'${s}'`).join(", ");

/** The stored end of the row's 90 days, for ordering: its subscription's end, or its creation. */
const END_SQL =
  `(CASE WHEN workspace.subscription_status IN (${quoted([...LAPSED_STATUSES])})` +
  ` THEN coalesce(workspace.subscription_ended_at, workspace.subscription_cancel_at, workspace.subscription_period_end) + ${REMOVAL_MS}` +
  ` ELSE workspace.created_at + ${TRIAL_MS} END)`;

/**
 * The workspaces whose clock may have a warning or a removal due by `?` (now and 31 days), after
 * (`?` end, `?` id), those whose 90 days end first first, so the mail cap sends to the longest due.
 */
const CANDIDATES_SQL =
  `SELECT workspace.id AS id, ${END_SQL} AS ends FROM workspace WHERE workspace.billing_trial = 1 AND workspace.storage_allowance_bytes IS NULL` +
  ` AND (workspace.subscription_status IS NULL OR workspace.subscription_status NOT IN (${quoted([...LIVE_STATUSES])}))` +
  ` AND NOT ${WORKSPACE_IS_ADMIN_SQL}` +
  " AND NOT EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = workspace.id)" +
  " AND NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.workspace_id = workspace.id)" +
  ` AND ${ONE_ACCOUNT_SQL("workspace.id")}` +
  ` AND ${END_SQL} <= ? AND (${END_SQL} > ? OR (${END_SQL} = ? AND workspace.id > ?)) ORDER BY ends, workspace.id LIMIT ${PAGE}`;

/** Everything the sweep reads of one workspace, in one call: its billing row, its oldest account, and its warnings. */
const CANDIDATE_SQL =
  `SELECT ${BILLING_COLUMNS_SQL}, EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = workspace.id) AS site,` +
  " EXISTS (SELECT 1 FROM account_removal r WHERE r.workspace_id = workspace.id) AS removing," +
  ` CASE WHEN ou.id IS NOT NULL AND ${aloneIn("workspace.id", "ou.id")} THEN 1 ELSE 0 END AS alone,` +
  ` ou.id AS user_id, ou.email AS email, ou.status AS user_status, ou.is_admin AS user_admin, ${WARNINGS_JSON_SQL} AS warnings` +
  " FROM workspace LEFT JOIN membership om ON om.workspace_id = workspace.id LEFT JOIN user ou ON ou.id = om.user_id" +
  " WHERE workspace.id = ? ORDER BY om.created_at, ou.id LIMIT 1";

function emptySummary(billing: boolean, opts: SweepOptions, publicBucket: boolean): SweepSummary {
  return {
    billing,
    removal: opts.removal === true,
    dryRun: opts.dryRun === true,
    alreadyRunning: false,
    checked: 0,
    mailsSent: 0,
    mailsFailed: 0,
    mailsWouldSend: 0,
    mailsWaiting: 0,
    mailOff: false,
    unconfirmed: 0,
    unconfirmedIds: [],
    removalsStarted: 0,
    removalsFinished: 0,
    removalsInProgress: 0,
    removalsStopped: 0,
    removalOff: 0,
    held: 0,
    capped: 0,
    clock: "unchecked",
    publicBucket,
    wouldRemove: [],
    stoppedEarly: false,
  };
}

/** The database of a dry run: reads pass, every write is suppressed (an audit row of a refused Stripe answer included). */
function readOnly(db: Db): Db {
  return {
    all: (sql, params) => db.all(sql, params),
    first: (sql, params) => db.first(sql, params),
    run: async () => ({ changes: 0 }),
    batch: async () => {},
  };
}

/**
 * One sweep. Without billing it reads nothing and does nothing. A second sweep while one runs does
 * nothing (alreadyRunning). Each workspace gets at most one thing done per sweep: one warning mail,
 * or its removal started or continued. The removals the sweep started, not finished and not
 * stopped, are continued first (only with removal on, and not in a dry run), within the cap.
 */
export async function billingSweep(input: Deps, opts: SweepOptions): Promise<SweepSummary> {
  const s = emptySummary(billingConfigured(input.config), opts, input.config.publicImageBase !== "");
  if (!s.billing) return s;
  // Every Stripe answer's Date is noted, for the clock check before a removal.
  let lastDate: string | null = null;
  const stripe = input.stripe;
  const deps: Deps = {
    ...input,
    ...(s.dryRun ? { db: readOnly(input.db) } : {}),
    ...(stripe === undefined
      ? {}
      : {
          stripe: {
            async call(method, path, form, key) {
              const a = await stripe.call(method, path, form, key);
              if (typeof a.date === "string") lastDate = a.date;
              return a;
            },
          },
        }),
  };
  const calls = opts.calls;
  const room = (cost: number) => calls === undefined || calls() + cost + CALLS_AT_THE_END <= SUBREQUEST_BUDGET;
  if (!room(3)) return stop(s);
  const lock = s.dryRun ? 0 : await takeLock(deps);
  if (lock === null) {
    s.alreadyRunning = true;
    return s;
  }
  try {
    await sweepUnderLock(deps, opts, s, room, calls, () => lastDate);
  } finally {
    if (lock !== 0) await deps.db.run("DELETE FROM rate_counter WHERE bucket = ? AND key = ? AND window_start = ?", [LOCK_BUCKET, LOCK_KEY, lock]);
  }
  return s;
}

/** Takes the run lock: its expiry, or null when another sweep holds it. Two calls. */
async function takeLock(deps: Deps): Promise<number | null> {
  const now = deps.now();
  await deps.db.run("DELETE FROM rate_counter WHERE bucket = ? AND key = ? AND window_start <= ?", [LOCK_BUCKET, LOCK_KEY, now]);
  const until = now + LOCK_MS;
  const took = await deps.db.run(
    "INSERT INTO rate_counter (bucket, key, window_start, count) SELECT ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM rate_counter WHERE bucket = ? AND key = ?)",
    [LOCK_BUCKET, LOCK_KEY, until, LOCK_BUCKET, LOCK_KEY],
  );
  return took.changes === 1 ? until : null;
}

async function sweepUnderLock(deps: Deps, opts: SweepOptions, s: SweepSummary, room: (cost: number) => boolean, calls: (() => number) | undefined, lastDate: () => string | null): Promise<void> {
  const perRun = opts.perRun ?? REMOVALS_PER_RUN;
  const perDay = opts.perDay ?? REMOVALS_PER_DAY;
  const mailCap = opts.mailsPerRun ?? MAILS_PER_RUN;
  const busy = opts.exportInProgress ?? exportInProgress;
  let touched = 0;
  let mailsTried = 0;
  let startedToday: number | null = null;

  // Condition 8, once per run, before the first removal: the server's clock against Stripe's.
  const clockOk = async (): Promise<boolean> => {
    if (s.clock === "unchecked") {
      let date = lastDate();
      if (date === null && deps.stripe !== undefined && deps.config.billing) {
        try {
          date = (await deps.stripe.call("GET", `/v1/prices/${deps.config.billing.priceId}`)).date ?? null;
        } catch {
          date = null;
        }
      }
      const at = date === null ? Number.NaN : Date.parse(date);
      s.clock = Number.isNaN(at) ? "unread" : Math.abs(deps.now() - at) > CLOCK_TOLERANCE_MS ? "off" : "ok";
    }
    return s.clock === "ok";
  };

  // The sweep's own removals that are not finished nor stopped: continued before anything else.
  if (!room(1)) return void stop(s);
  const open = await deps.db.all<{ user_id: string; workspace_id: string }>(
    "SELECT user_id, workspace_id FROM account_removal WHERE started_by = ? AND stopped_at IS NULL ORDER BY created_at, user_id LIMIT ?",
    [SWEEP_ACTOR, perRun + 1],
  );
  for (const r of open) {
    if (s.dryRun || !s.removal) {
      s.removalsInProgress += 1;
      continue;
    }
    if (touched >= perRun) {
      s.capped += 1;
      continue;
    }
    if (!room(3)) return void stop(s);
    if (!(await clockOk())) {
      s.held += 1;
      continue;
    }
    touched += 1;
    const outcome = await continueRemoval(deps, r.user_id, r.workspace_id, room, calls);
    count(s, outcome);
    if (outcome === "out_of_budget") return void stop(s);
  }

  let afterEnd = Number.MIN_SAFE_INTEGER;
  let afterId = "";
  for (;;) {
    if (!room(1)) return void stop(s);
    const page = await deps.db.all<{ id: string; ends: number }>(CANDIDATES_SQL, [deps.now() + 31 * DAY, afterEnd, afterEnd, afterId]);
    for (const { id, ends } of page) {
      afterEnd = ends;
      afterId = id;
      if (!room(4)) return void stop(s);
      const c = await deps.db.first<Candidate>(CANDIDATE_SQL, [id]);
      if (c === null) continue;
      s.checked += 1;
      const now = deps.now();
      const clock = clockOf(c, c.site === 1, now, c.alone !== 1);
      // Condition 1: on the clock, one account of the workspace, active, no admin, no removal recorded.
      if (clock === null || c.removing === 1 || c.alone !== 1 || c.user_id === null || c.email === null || c.user_status !== "active" || c.user_admin !== 0) continue;
      const email = await emailSha256(c.email);
      const plan = planOf(clock, warningsOf(c.warnings), email, now);
      if (plan.unconfirmed) {
        s.unconfirmed += 1;
        s.unconfirmedIds.push(c.id);
        continue;
      }
      if (plan.due !== null) {
        if (mailsTried >= mailCap) {
          s.mailsWaiting += 1;
          continue;
        }
        if (await sendWarning(deps, s, c, clock, email, plan.due)) mailsTried += 1;
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
      // The count, the checkouts and the questions to Stripe, the clock, the start, and a pass's start.
      if (!room(16)) return void stop(s);
      if (startedToday === null) {
        const n = await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM audit WHERE event = 'billing_removal_started' AND at > ?", [now - DAY]);
        startedToday = n?.n ?? 0;
      }
      if (startedToday >= perDay) {
        s.capped += 1;
        continue;
      }
      // Conditions 5 and 6, asked last, right before the start; then the clock (8).
      if (await heldBack(deps, c, busy, room, !s.dryRun)) {
        s.held += 1;
        continue;
      }
      if (!(await clockOk())) {
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
      count(s, outcome);
      if (outcome === "out_of_budget") return void stop(s);
    }
    if (page.length < PAGE) break;
  }
}

type Outcome = "deleted" | "more" | "held" | "stopped" | "out_of_budget";

function count(s: SweepSummary, outcome: Outcome): void {
  if (outcome === "deleted") s.removalsFinished += 1;
  else if (outcome === "held") s.held += 1;
  else if (outcome === "stopped") s.removalsStopped += 1;
  else s.removalsInProgress += 1;
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
 * its claim unconfirmed and is never sent again until the admin clears it (clearClaim). True when
 * a send was tried (or, in a dry run, would be): it counts against the mail cap.
 */
async function sendWarning(deps: Deps, s: SweepSummary, c: Candidate, clock: Clock, email: string, due: { stage: WarningStage; namedAt: number }): Promise<boolean> {
  const origin = linkOrigin(deps.config);
  if (!canMailLinks(deps) || origin === null || c.email === null) {
    s.mailOff = true;
    return false;
  }
  const mail = warningMail(c.email, { kind: clock.kind, stage: due.stage, removalAt: due.namedAt, endedAt: clock.kind === "ended" ? clock.started : null }, origin);
  if (s.dryRun) {
    s.mailsWouldSend += 1;
    return true;
  }
  const key = [c.id, clock.removalDay, due.stage, email];
  const claimed = await deps.db.run(
    "INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT DO NOTHING",
    [...key, deps.now(), due.namedAt],
  );
  if (claimed.changes !== 1) return false;
  try {
    await mailOf(deps).send(mail);
  } catch (err) {
    s.mailsFailed += 1;
    // Handed over and then failed: it may have arrived, so it stays claimed and is never sent again.
    if ((err as { bodyWritten?: unknown } | null)?.bodyWritten === true) return true;
    await deps.db.run("DELETE FROM billing_warning WHERE workspace_id = ? AND removal_at = ? AND stage = ? AND email_sha256 = ? AND sent_at IS NULL", key);
    return true;
  }
  await deps.db.batch([
    { sql: "UPDATE billing_warning SET sent_at = ? WHERE workspace_id = ? AND removal_at = ? AND stage = ? AND email_sha256 = ? AND sent_at IS NULL", params: [deps.now(), ...key] },
    auditStatement(deps, { event: "billing_warning_sent", workspaceId: c.id, subject: c.user_id, detail: { stage: due.stage, kind: clock.kind } }, { onlyAfterOneChange: true }),
  ]);
  s.mailsSent += 1;
  return true;
}

/**
 * Conditions 5 and 6: true when the removal must wait. An export in progress; a checkout pending
 * on the record; the site's checkout records for the workspace more than CHECKOUT_KEEP_MS past
 * their expiry cleared (a read-only trial runs no housekeeping of its own), then any left not yet
 * expired by its own clock, more than CHECKOUTS_ASKED, or any Stripe does not say is expired; a
 * customer on record with no subscription; and a subscription Stripe says is live (stored as Stripe
 * says it with `repair`, never in a dry run) or gives no definite answer about. `unpaid`, `paused`
 * and `incomplete` let it go on: prepareDeletion cancels them at Stripe first.
 */
async function heldBack(deps: Deps, c: Candidate, busy: (deps: Deps, ws: string) => Promise<boolean>, room: (cost: number) => boolean, repair: boolean): Promise<boolean> {
  if (await busy(deps, c.id)) return true;
  if (c.checkout_session !== null) return true;
  const now = deps.now();
  await deps.db.run("DELETE FROM stripe_checkout WHERE workspace_id = ? AND expires_at < ?", [c.id, now - CHECKOUT_KEEP_MS]);
  const checkouts = await deps.db.all<{ id: string; expires_at: number }>(
    "SELECT id, expires_at FROM stripe_checkout WHERE workspace_id = ? AND expires_at >= ? ORDER BY created_at DESC, id LIMIT ?",
    [c.id, now - CHECKOUT_KEEP_MS, CHECKOUTS_ASKED + 1],
  );
  if (checkouts.length > CHECKOUTS_ASKED || checkouts.some((k) => k.expires_at > now - CLOCK_SKEW_MS)) return true;
  for (const k of checkouts) {
    if (!room(2)) return true;
    if ((await checkoutBeforeRemoval(deps, k.id)) !== "expired") return true;
  }
  if (c.subscription === null) return c.customer !== null;
  if (!room(3)) return true;
  const answer = await subscriptionBeforeRemoval(deps, c, repair);
  return answer !== "ended" && answer !== "cancel";
}

/**
 * Starts the removal in one batch, under the conditions read again in SQL: the account still
 * active, no admin, with the address the warnings went to, alone in its workspace; the workspace
 * still on the clock exactly as read (its subscription, customer, status, period's end, cancel
 * time, end and creation unchanged, no allowance by hand, no pending checkout, not the site's own)
 * with no checkout of it unexpired; and no removal recorded. The account is disabled as an admin's
 * disable does it (sessions ended, codes and email change spent) and the removal recorded under
 * SWEEP_ACTOR, with two audit rows that guard the batch. False when anything changed meanwhile:
 * nothing was written.
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
          " AND w.subscription_status IS ? AND w.stripe_subscription_id IS ? AND w.stripe_customer_id IS ? AND w.subscription_ended_at IS ? AND w.created_at = ?" +
          " AND w.subscription_period_end IS ? AND w.subscription_cancel_at IS ?)" +
          " AND NOT EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = ?)" +
          " AND NOT EXISTS (SELECT 1 FROM stripe_checkout k WHERE k.workspace_id = ? AND k.expires_at > ?)" +
          " AND NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.user_id = ? OR r.workspace_id = ?)" +
          ` AND ${aloneIn("?", "user.id")}`,
        params: [uid, c.email, ws, c.status, c.subscription, c.customer, c.ended_at, c.created_at, c.period_end, c.cancel_at, ws, ws, now - CLOCK_SKEW_MS, uid, ws, ws, ws],
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

/** What a removal in progress needs re-read before each pass: its billing row and what the start's guard held. */
type Recheck = BillingRow & { site: number; shared: number; user_admin: number | null; late_checkouts: number };

/**
 * The re-check before a pass (0.1.61): "go", "hold" (Stripe gave no definite answer: try at the
 * next sweep), or the fixed word of why the removal stops for good: "live" (a live subscription,
 * stored or at Stripe, which is then stored), "checkout" (a checkout of the workspace made after
 * the removal started, or not expired, or pending on the record), "left_clock" (the workspace is on
 * no clock any more: an allowance set by hand, billing off for it, an admin's, more accounts).
 */
async function recheck(deps: Deps, ws: string, userId: string, startedAt: number): Promise<"go" | "hold" | "live" | "checkout" | "left_clock"> {
  const now = deps.now();
  const row = await deps.db.first<Recheck>(
    `SELECT ${BILLING_COLUMNS_SQL}, EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = workspace.id) AS site,` +
      ` CASE WHEN ${ONE_ACCOUNT_SQL("workspace.id")} THEN 0 ELSE 1 END AS shared, (SELECT u.is_admin FROM user u WHERE u.id = ?) AS user_admin,` +
      " (SELECT count(*) FROM stripe_checkout k WHERE k.workspace_id = workspace.id AND (k.created_at > ? OR k.expires_at > ?)) AS late_checkouts" +
      " FROM workspace WHERE workspace.id = ?",
    [userId, startedAt, now, ws],
  );
  if (row === null) return "hold";
  if (isLive(row.status)) return "live";
  if (row.late_checkouts > 0 || row.checkout_session !== null) return "checkout";
  if (row.user_admin !== 0 || clockOf(row, row.site === 1, now, row.shared === 1) === null) return "left_clock";
  // Stripe is asked whatever the record says: what Stripe says is not over is stored, and so cancelled.
  if (row.subscription !== null) {
    const answer = await subscriptionBeforeRemoval(deps, row, "all");
    if (answer === "live") return "live";
    if (answer === "unknown") return "hold";
  }
  return "go";
}

/**
 * Continues a removal the sweep started (account_removal under SWEEP_ACTOR, not stopped) with the
 * account delete's own steps. Before every pass the workspace is re-checked (recheck): a reason to
 * stop stops it for good, before anything is cancelled or deleted (stopRemoval). Then
 * prepareDeletion (which cancels at Stripe any subscription not definitely over, and takes no 404
 * as proof), then `work`, then a billing_removal_step audit row with the files left; once the last
 * batch took effect, billing_removal_finished. With `calls` (a metered invocation) one pass within
 * the budget; without, passes until it is done, each metered on its own. "deleted" when finished,
 * "more" when steps are left for the next sweep, "held" when Stripe gave no definite answer, a step
 * failed or an undo took the record away (nothing is lost), "stopped" when it stopped for good,
 * "out_of_budget" when the invocation's budget ran out.
 */
async function continueRemoval(deps: Deps, userId: string, ws: string, room: (cost: number) => boolean, calls: (() => number) | undefined): Promise<Outcome> {
  // Its reads, the re-check (a read and Stripe), prepareDeletion's own read and a pass's audit row fit.
  if (!room(8)) return "out_of_budget";
  const t = await readTarget(deps, userId);
  if (t === null || t.workspace_id !== ws || t.removing !== 1 || t.status !== "disabled") return "held";
  const record = await deps.db.first<{ total: number; created_at: number; stopped_at: number | null }>(
    "SELECT total, created_at, stopped_at FROM account_removal WHERE user_id = ? AND workspace_id = ? AND started_by = ?",
    [userId, ws, SWEEP_ACTOR],
  );
  if (record === null || record.stopped_at !== null) return "held";
  for (let pass = 0; pass < PASSES_AT_MOST; pass++) {
    if (calls !== undefined && !room(6)) return "out_of_budget";
    const check = await recheck(deps, ws, userId, record.created_at);
    if (check === "hold") return "held";
    if (check !== "go") {
      await stopRemoval(deps, ws, userId, check);
      return "stopped";
    }
    const meter = calls === undefined ? metered(deps) : null;
    const d = meter?.deps ?? deps;
    const used = meter?.calls ?? calls!;
    const fits = (cost: number) => used() + cost + CALLS_AT_THE_END <= SUBREQUEST_BUDGET;
    let outcome: "deleted" | "more" | "undone";
    try {
      const prepared = await prepareDeletion(d, ws, SWEEP_ACTOR, fits, false);
      if (prepared === "failed") return "held";
      outcome = prepared === "more" ? "more" : await work(d, used, t, SWEEP_ACTOR);
    } catch {
      // Fixed text only: the error could carry anything a back end put in its message.
      console.error("billing sweep: a removal could not go on just now; the next sweep continues it");
      return "held";
    }
    // An undo took the record away while Stripe was asked: nothing was removed.
    if (outcome === "undone") return "held";
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
    if (calls !== undefined) return room(1) ? "more" : "out_of_budget";
  }
  return "more";
}

/** Stops a removal for good: marked stopped (no sweep continues it), with the audit row `billing_removal_stopped` and the reason, a billing problem for the admin. */
async function stopRemoval(deps: Deps, ws: string, userId: string, reason: "live" | "checkout" | "left_clock"): Promise<void> {
  try {
    await deps.db.batch([
      { sql: "UPDATE account_removal SET stopped_at = ? WHERE user_id = ? AND workspace_id = ? AND stopped_at IS NULL", params: [deps.now(), userId, ws] },
      auditStatement(deps, { event: "billing_removal_stopped", workspaceId: ws, subject: userId, detail: { reason } }, { onlyAfterOneChange: true }),
    ]);
  } catch (err) {
    // Stopped by another sweep a moment before, or undone meanwhile: nothing more to do.
    if (!isNotNullViolation(err)) throw err;
  }
}

/**
 * Clears one workspace's unconfirmed warning claims (a mail handed over and then failed, never
 * recorded as accepted), so the next sweep sends that mail again: the admin's decision, never the
 * sweep's (`billing-sweep --clear-claim <workspace id>`). The count cleared; with one or more, the
 * audit row `billing_warning_claim_cleared`. A malformed id clears nothing.
 */
export async function clearClaim(deps: Deps, workspaceId: string): Promise<number> {
  if (!WORKSPACE_ID.test(workspaceId)) return 0;
  const found = await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM billing_warning WHERE workspace_id = ? AND sent_at IS NULL", [workspaceId]);
  const n = found?.n ?? 0;
  if (n === 0) return 0;
  await deps.db.batch([
    { sql: "DELETE FROM billing_warning WHERE workspace_id = ? AND sent_at IS NULL", params: [workspaceId] },
    auditStatement(deps, { event: "billing_warning_claim_cleared", workspaceId, detail: { count: n } }),
  ]);
  return n;
}

/** The dry run's line on a site whose published pictures come straight from a public bucket. Fixed text. */
export const PUBLIC_BUCKET_LINE =
  "PUBLIC_IMAGE_BASE is set: links coming down hides the pages, but the pictures stay reachable at their addresses on the public bucket until removal or unpublish.";

/**
 * What a sweep says, one line each, counts only (and the ids of the workspaces a dry run would
 * remove or that hold an unconfirmed claim, which hold nothing of what is in them). The admin
 * command prints these; the Worker's scheduled handler logs them.
 */
export function sweepLines(s: SweepSummary): string[] {
  if (!s.billing) return ["Billing is off on this site, so there is nothing to sweep. Nothing was changed."];
  if (s.alreadyRunning) return ["A billing sweep is already running. Nothing was done."];
  const lines = [
    s.dryRun ? "Dry run: nothing was sent, changed or removed." : "Billing sweep done.",
    `Workspaces looked at: ${s.checked}.`,
    s.dryRun ? `Warning mails that would be sent: ${s.mailsWouldSend}.` : `Warning mails sent: ${s.mailsSent}. Not sent, tried again next time: ${s.mailsFailed}.`,
  ];
  if (s.mailsWaiting > 0) lines.push(`Warning mails over this run's cap, sent next time: ${s.mailsWaiting}.`);
  if (s.mailOff) lines.push("Mail is off, or the site has no address for links, so no warning mail was sent and nothing can be removed.");
  if (s.unconfirmed > 0) {
    lines.push(`Warning mails whose sending was never confirmed (these workspaces are not removed for this date until the claim is cleared with --clear-claim): ${s.unconfirmed}.`);
    for (const id of s.unconfirmedIds) lines.push(`  unconfirmed ${id}`);
  }
  if (!s.removal) lines.push(`Removal is off (BILLING_REMOVAL is not on). Workspaces that would be due: ${s.dryRun ? s.wouldRemove.length : s.removalOff}.`);
  if (s.clock === "off") lines.push("The server's clock and Stripe's differ by more than an hour, so nothing was removed. Check the server's time.");
  if (s.clock === "unread") lines.push("Stripe's time could not be read, so nothing was removed.");
  if (s.dryRun) {
    lines.push(`Workspaces that would be removed: ${s.wouldRemove.length}.`);
    for (const id of s.wouldRemove) lines.push(`  would remove ${id}`);
    if (s.publicBucket) lines.push(PUBLIC_BUCKET_LINE);
  } else {
    lines.push(`Removals started: ${s.removalsStarted}. Finished: ${s.removalsFinished}. Still in progress: ${s.removalsInProgress}.`);
  }
  if (s.removalsStopped > 0) lines.push(`Removals stopped for good, for the admin to look at (billing_removal_stopped): ${s.removalsStopped}.`);
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
