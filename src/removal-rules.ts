// The clock of removal (0.1.61, Plan 2l items 7 and 8): when a workspace's links come down, when
// each of the three warning mails is due, and when its content may be removed. Pure: it reads the
// stored billing row and the stored warnings, never a request and never the network, so the
// dashboard (src/billing.ts), the public routes (linksUpSql) and the sweep (src/billing-sweep.ts)
// all decide from one set of rules, and every date the dashboard shows is the one the sweep acts on.
//
// Who is on the clock (clockOf), with billing on only:
// - a trial: a workspace made while billing was on (`billing_trial` 1) that never had a live
//   subscription. Its clock ends 90 days after its creation (the trial's end).
// - an ended subscription: Stripe said `canceled`, `unpaid` or `incomplete_expired`. Its clock ends
//   90 days after the stored end of the subscription.
// Never on the clock: billing off, a live subscription, an exempt workspace (made while billing
// was off: every existing account), the admin's, one with an allowance the admin set by hand
// (also after it had a subscription), the workspace the site was set up with, and one with more
// than one account. A subscription that never went live (`incomplete`, `incomplete_expired`) is
// the trial's clock, from the workspace's creation.
//
// What the clock gives, all from stored times:
// - links down: a trial's from the moment it ends; an ended subscription's 30 days after it ended.
//   From then on its published tours, shared images and clips answer visitors exactly as
//   unpublished ones (linksUpSql), with nothing changed or deleted: a live subscription again
//   makes them answer at once, since the condition is read on every request.
// - the removal day: the first full UTC day after the 90 days (removalDayOf), so the date a mail
//   names is a whole day the content is still there before, and removal never comes before the
//   stored end of the 90 days.
// - the warnings, 30, 7 and 1 days before that day (planOf), each one mail, in that order. A mail
//   sent later than its day pushes the day it names (and so the removal) to its own number of days
//   after the day it is sent: the removal never comes sooner than a mail said.
// - removal (removalDue): all three warnings recorded as accepted for THIS removal day and THIS
//   address, the first at least 29 days and the last at least 20 hours before now, the day the
//   last one named reached, and the stored end of the 90 days passed.
// A stored time ahead of the clock by more than CLOCK_SKEW_MS (the clock went back) stops both the
// mails and the removal until the clock has caught up.
import { DAY, LAPSED_STATUSES, LINKS_GRACE_MS, LIVE_STATUSES, REMOVAL_MS, TRIAL_MS, billingConfigured, standingOf, type BillingRow, type BillingSettings } from "./billing-rules.ts";

/** The three warnings, by how many days before the removal day each is due, in the order they are sent. */
export const WARNING_STAGES = [30, 7, 1] as const;
export type WarningStage = (typeof WARNING_STAGES)[number];

/** How long before now the first warning must have been accepted for a removal: 29 days. */
export const FIRST_WARNING_AT_LEAST_MS = 29 * DAY;
/** How long before now the last warning must have been accepted for a removal: 20 hours. */
export const LAST_WARNING_AT_LEAST_MS = 20 * 3_600_000;
/** How far a stored time may be ahead of the clock before the clock is taken to have gone back. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** The most workspaces one sweep starts or goes on removing. */
export const REMOVALS_PER_RUN = 5;
/** The most removals the sweeps start in any 24 hours, counted from the audit record. */
export const REMOVALS_PER_DAY = 20;
/** An export started this recently holds a removal back (the hook in src/billing-sweep.ts). */
export const EXPORT_QUIET_MS = 3_600_000;

/**
 * Whether this build has "Download all my data" (Plan 2l item 9, 0.1.60, src/export.ts): it has,
 * so the trial-ending and ended notices say where everything can be downloaded.
 */
export const DOWNLOAD_ALL_BUILT = true;

/**
 * The account id the sweep's removals are recorded under (account_removal.started_by and the
 * deletion's own audit row), where an admin's delete records the admin. No account has it: ids
 * are random, and this one is all zeros.
 */
export const SWEEP_ACTOR = "usr_000000000000000000000000";

/** The setting that lets the sweep remove anything: BILLING_REMOVAL=on (any case, spaces around it). Anything else, unset included, is off. */
export function removalSwitchedOn(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "on";
}

/** The start of the UTC day `ms` is in. */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

/** The removal day of a clock that ends at `end`: the first full UTC day after it. */
export function removalDayOf(end: number): number {
  return startOfUtcDay(end) + DAY;
}

/** A workspace on the clock: which clock, when it ends (`end`), when its links come down, and its removal day. */
export type Clock = {
  kind: "trial" | "ended";
  /** The stored time the clock counts from: the workspace's creation, or the subscription's end. */
  from: number;
  /** When the trial ends, or when the subscription ended. */
  started: number;
  /** The end of the 90 days. */
  end: number;
  linksDownAt: number;
  removalDay: number;
};

/** The stored end of an ended subscription, as standingOf reads it, or null when none is stored. */
function endedAtOf(row: BillingRow): number | null {
  return row.ended_at ?? row.cancel_at ?? row.period_end;
}

/**
 * The clock of a workspace with billing on, or null when it is not on one (see the top of this
 * file). `site` is true for the workspace the site was set up with, `shared` for one with more than
 * one account (ONE_ACCOUNT_SQL false).
 */
export function clockOf(row: BillingRow, site: boolean, now: number, shared = false): Clock | null {
  if (site || shared || row.own_allowance !== null) return null;
  const s = standingOf(row, now);
  if (s.kind === "trial" || s.kind === "trial_over") {
    const ends = row.created_at + TRIAL_MS;
    return { kind: "trial", from: row.created_at, started: ends, end: ends, linksDownAt: ends, removalDay: removalDayOf(ends) };
  }
  if (s.kind === "ended") {
    const ended = endedAtOf(row);
    if (ended === null) return null;
    const end = ended + REMOVAL_MS;
    return { kind: "ended", from: ended, started: ended, end, linksDownAt: ended + LINKS_GRACE_MS, removalDay: removalDayOf(end) };
  }
  return null;
}

/** One stored warning (migration 0024). */
export type WarningRow = { stage: number; removal_at: number; email_sha256: string; claimed_at: number; sent_at: number | null; named_at: number };

export type Plan = {
  /** The removal day the dashboard shows and the next mail names: never earlier than any mail said. */
  removalAt: number;
  /** The warning due now, with the day it names, or null. */
  due: { stage: WarningStage; namedAt: number } | null;
  /** The accepted warnings of this removal day and address, by stage. */
  sent: Partial<Record<WarningStage, WarningRow>>;
  /** A warning was claimed and never recorded as accepted: nothing more is sent, and nothing is removed. */
  unconfirmed: boolean;
  /** A stored time is ahead of the clock: nothing is sent or removed. */
  skewed: boolean;
};

/**
 * Where the warnings of a workspace on `clock` stand for the address whose SHA-256 is `email`.
 * Only rows of this removal day and this address count. The stages go in order: the first one
 * not sent is due once now reaches its day (the removal day so far, less its days), and it names
 * the later of that removal day and its own number of days after today.
 */
export function planOf(clock: Clock, rows: readonly WarningRow[], email: string, now: number): Plan {
  const mine = rows.filter((r) => r.removal_at === clock.removalDay && r.email_sha256 === email);
  const skewed = clock.from > now + CLOCK_SKEW_MS || rows.some((r) => r.claimed_at > now + CLOCK_SKEW_MS || (r.sent_at !== null && r.sent_at > now + CLOCK_SKEW_MS));
  const sent: Plan["sent"] = {};
  let removalAt = clock.removalDay;
  let due: Plan["due"] = null;
  let unconfirmed = false;
  for (const stage of WARNING_STAGES) {
    const row = mine.find((r) => r.stage === stage);
    if (row !== undefined) {
      if (row.sent_at === null) {
        unconfirmed = true;
        break;
      }
      sent[stage] = row;
      removalAt = Math.max(removalAt, row.named_at);
      continue;
    }
    if (now >= removalAt - stage * DAY) {
      const namedAt = Math.max(removalAt, startOfUtcDay(now) + stage * DAY);
      due = { stage, namedAt };
      removalAt = namedAt;
    }
    break;
  }
  return { removalAt, due: unconfirmed || skewed ? null : due, sent, unconfirmed, skewed };
}

/** Why a workspace on the clock is not removed now, or null when it is due. */
export type NotDue = "warnings" | "unconfirmed" | "clock" | "date";

/**
 * Whether the content of a workspace on `clock` may be removed now (conditions 2 to 4 of the
 * removal; the others are the sweep's): every warning recorded as accepted for this removal day
 * and address, none unconfirmed, no stored time ahead of the clock, the stored end of the 90 days
 * passed, the day the last warning named reached, the first warning at least 29 days old and the
 * last at least 20 hours old.
 */
export function notDueReason(clock: Clock, plan: Plan, now: number): NotDue | null {
  if (plan.unconfirmed) return "unconfirmed";
  if (plan.skewed) return "clock";
  const first = plan.sent[30];
  const last = plan.sent[1];
  if (first === undefined || plan.sent[7] === undefined || last === undefined || first.sent_at === null || last.sent_at === null) return "warnings";
  if (now <= clock.end || now < plan.removalAt) return "date";
  if (now - first.sent_at < FIRST_WARNING_AT_LEAST_MS || now - last.sent_at < LAST_WARNING_AT_LEAST_MS) return "warnings";
  return null;
}

const quoted = (list: readonly string[]) => list.map((s) => `'${s}'`).join(", ");

/**
 * The condition that the workspace `ws` (a column) has at most one account: its memberships and
 * the accounts whose own row names it without a membership (an older build's). A workspace with
 * more is on no clock: its links stay up, it gets no mail and nothing of it is removed (0.1.61).
 */
export const ONE_ACCOUNT_SQL = (ws: string) =>
  `(SELECT count(*) FROM membership om1 WHERE om1.workspace_id = ${ws}) + (SELECT count(*) FROM user ou1 WHERE ou1.workspace_id = ${ws} AND NOT EXISTS (SELECT 1 FROM membership om2 WHERE om2.user_id = ou1.id AND om2.workspace_id = ${ws})) <= 1`;

/**
 * The SQL condition that the links of the workspace `ws` (a column of the query, such as
 * `t.workspace_id`, never a value from a request) are up at `now`, to fold into a public route's
 * one lookup, beginning with " AND ". Without billing it is "" and the statement is the one of the
 * version before, byte for byte. With billing it is the negation of clockOf's "links down",
 * read on the workspace's own row in the same statement: no call more. `now` is written into the
 * text as a whole number, checked here; nothing else in it varies.
 */
export function linksUpSql(config: { billing?: BillingSettings | null }, ws: string, now: number): string {
  if (!billingConfigured(config)) return "";
  const at = Math.floor(now);
  if (!Number.isSafeInteger(at)) throw new Error("bad time");
  return (
    ` AND NOT EXISTS (SELECT 1 FROM workspace bw WHERE bw.id = ${ws} AND bw.billing_trial = 1 AND bw.storage_allowance_bytes IS NULL` +
    ` AND (bw.subscription_status IS NULL OR bw.subscription_status NOT IN (${quoted([...LIVE_STATUSES])}))` +
    " AND NOT EXISTS (SELECT 1 FROM membership bm JOIN user bu ON bu.id = bm.user_id WHERE bm.workspace_id = bw.id AND bu.is_admin = 1)" +
    " AND NOT EXISTS (SELECT 1 FROM setup bs WHERE bs.workspace_id = bw.id)" +
    ` AND ${ONE_ACCOUNT_SQL("bw.id")}` +
    ` AND CASE WHEN bw.subscription_status IN (${quoted([...LAPSED_STATUSES])})` +
    ` THEN coalesce(bw.subscription_ended_at, bw.subscription_cancel_at, bw.subscription_period_end) + ${LINKS_GRACE_MS}` +
    ` ELSE bw.created_at + ${TRIAL_MS} END <= ${at})`
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A day as the warning mails and the dashboard write it, in UTC: "21 February 2027". */
export function fullDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error("bad time");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
