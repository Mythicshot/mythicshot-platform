// When the low storage mail (src/storage-mail.ts, 0.1.66) is sent, to whom, and how it is
// recorded (migration 0026, `storage_mail`). No platform API.
//
// Two ways in, one decision (checkStorage):
// - Soon after a request that changed what a workspace uses (a finished upload or item, a
//   deleted tour or item, a change of a tour's chapters, an admin's new allowance), the route
//   asks for a check with storageMailSoon. It runs in one job handed to the target (Deps.defer)
//   after the answer has gone, so the request never waits on it, never fails because of it, and
//   never learns what it did. A site without a mailer defers nothing and makes no call at all
//   (so the Worker, which sends no mail in this version, makes none).
// - The storage sweep (storageSweep), run from outside the web app: the server's admin command
//   `storage-sweep` (Node) and the Worker's scheduled handler. It picks up whatever the requests
//   did not: a send that failed, a site whose mail was off, a change of allowance by billing, a
//   usage seen below 70% that re-arms the mails.
//
// What holds, each with a test in test/storage-mail.test.ts:
// - Two mails at most per fill-up (stageOf): 80% and 100%; straight to 100% sends only the full
//   one; neither again until the usage is seen below 70%, which re-arms both.
// - Only a workspace with an allowance, while mail is on. Never one that is read-only (billing:
//   a trial that is over, an ended subscription, an unconfirmed live one), whose account is not
//   active (disabled), or that is being removed (an account_removal row).
// - The recipient is the workspace's own account: its oldest member's address, the account the
//   removal warnings write to (src/billing-sweep.ts), read in the same statement as the numbers.
//   Nothing in a request names the workspace or the address; the job takes the id the request's
//   credential gave. One workspace's name, numbers and address are read by its own id alone.
// - Recorded only once the mail server took it, and never twice for one crossing: a claim row is
//   written first (two checks at once cannot both send), completed with `sent_at` once the mail
//   server took the mail, and taken back when the mail server refused it before the message was
//   handed over (tried again at the next check). One handed over and then failed (it may have
//   arrived) stays claimed: not sent again for this fill-up. Mail off: nothing is written.
// - The audit row `storage_mail_sent` holds the workspace's id, its account's id and the stage;
//   no address, name or size. The address is recorded only as its SHA-256. No log line holds an
//   address, a name or an id.
import { parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { BILLING_COLUMNS_SQL, billingConfigured, isReadOnly, standingOf, type BillingRow } from "./billing-rules.ts";
import { SUBREQUEST_BUDGET, metered } from "./budget.ts";
import { NO_MAIL, linkOrigin } from "./mail.ts";
import { deferOf, mailOf, type Deps } from "./ports.ts";
import { emailSha256 } from "./removal-store.ts";
import { stageOf, storageMail, type StorageStage } from "./storage-mail.ts";
import { USAGE_COLUMNS, allowanceSqlFor, usageFromRow, type UsageRow } from "./usage.ts";

/** How old a claim must be before a re-arm takes it away too: far past the longest send (about a minute). */
export const CLAIM_STALE_MS = 3_600_000;
/** The most storage mails one sweep sends (or tries); the rest wait for the next. */
export const STORAGE_MAILS_PER_RUN = 50;
/** Workspaces read per page of the sweep. */
const PAGE = 50;
/** The calls a metered sweep keeps in hand under the budget, as the billing sweep does (CALLS_AT_THE_END). */
const CALLS_KEPT = 2;

/** The fixed log lines. None holds an address, a name or an id. */
export const STORAGE_LINES = {
  failed: "storage mail: a check could not be made just now; the next check or sweep makes it",
} as const;

/** One record of a mail of the present fill-up, as read with the workspace. */
type MailRecord = { stage: StorageStage; claimed_at: number; sent_at: number | null };

type Row = BillingRow &
  UsageRow & {
    name: string;
    user_id: string | null;
    email: string | null;
    user_status: string | null;
    removing: number;
    mails: string;
  };

/**
 * Everything a check reads, in one statement, for the workspace `?` alone (the second
 * parameter; the first is the site's default allowance): its name, its billing row, what it
 * uses as the Storage page counts it, its allowance as this site has it, its oldest account
 * (the one the removal warnings write to) and whether a removal is recorded, and its records.
 */
function checkSql(deps: Pick<Deps, "config">): string {
  return (
    `SELECT ${BILLING_COLUMNS_SQL}, workspace.name AS name, ${allowanceSqlFor(deps)} AS allowance, ${USAGE_COLUMNS},` +
    " ou.id AS user_id, ou.email AS email, ou.status AS user_status," +
    " EXISTS (SELECT 1 FROM account_removal r WHERE r.workspace_id = workspace.id) AS removing," +
    " (SELECT json_group_array(json_object('stage', m.stage, 'claimed_at', m.claimed_at, 'sent_at', m.sent_at)) FROM storage_mail m WHERE m.workspace_id = workspace.id) AS mails" +
    " FROM (SELECT ? AS ws) p JOIN workspace ON workspace.id = p.ws" +
    " LEFT JOIN membership om ON om.workspace_id = workspace.id LEFT JOIN user ou ON ou.id = om.user_id" +
    " ORDER BY om.created_at, ou.id LIMIT 1"
  );
}

/** The records of checkSql's text; a row of any other shape is left out. */
function recordsOf(text: unknown): MailRecord[] {
  if (typeof text !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: MailRecord[] = [];
  for (const r of parsed as Record<string, unknown>[]) {
    if (r === null || typeof r !== "object" || (r.stage !== 80 && r.stage !== 100) || typeof r.claimed_at !== "number") continue;
    if (r.sent_at !== null && typeof r.sent_at !== "number") continue;
    out.push({ stage: r.stage, claimed_at: r.claimed_at, sent_at: r.sent_at as number | null });
  }
  return out;
}

/**
 * What a check did: `mail_off` (no mailer: nothing read or written), `gone` (no such workspace),
 * `none` (nothing to do), `rearmed` (records deleted: both mails armed again), `skipped` (a mail
 * is due but the workspace may not get it: read-only, disabled, being removed, no usable
 * address), `would_send` (a dry run, which writes and sends nothing), `sent`, `failed` (the mail
 * server refused it before the message was handed over: the claim was taken back, tried again
 * later) or `unconfirmed` (handed over, then failed: kept, not sent again for this fill-up).
 */
export type CheckOutcome = { did: "mail_off" | "gone" | "none" | "rearmed" | "skipped" | "would_send" | "failed" | "unconfirmed" } | { did: "sent"; stage: StorageStage };

/**
 * The check of one workspace: one read, then at most two writes (a claim and its completion
 * with the audit row, or a claim taken back, or a re-arm). Three calls at most, the mail aside.
 * Throws only what the database throws; a mail failure is an outcome.
 */
export async function checkStorage(deps: Deps, workspaceId: string, opts: { dryRun?: boolean } = {}): Promise<CheckOutcome> {
  if (mailOf(deps) === NO_MAIL) return { did: "mail_off" };
  const row = await deps.db.first<Row>(checkSql(deps), [deps.config.storageAllowanceBytes ?? null, workspaceId]);
  if (row === null || row.id !== workspaceId) return { did: "gone" };
  const usage = usageFromRow(row);
  const stage = stageOf(usage.used, usage.allowance);
  const records = recordsOf(row.mails);
  const now = deps.now();
  if (stage === "rearm") {
    // Under 70%: every confirmed record goes, and every claim old enough that no send can still be on its way.
    const stale = records.some((r) => r.sent_at !== null || r.claimed_at < now - CLAIM_STALE_MS);
    if (!stale) return { did: "none" };
    if (opts.dryRun === true) return { did: "rearmed" };
    const gone = await deps.db.run("DELETE FROM storage_mail WHERE workspace_id = ? AND (sent_at IS NOT NULL OR claimed_at < ?)", [workspaceId, now - CLAIM_STALE_MS]);
    return { did: gone.changes > 0 ? "rearmed" : "none" };
  }
  if (stage === null) return { did: "none" };
  // Never twice: the full mail once per fill-up; the low one only while neither went.
  if (records.some((r) => r.stage === 100) || (stage === 80 && records.some((r) => r.stage === 80))) return { did: "none" };
  const to = parseEmail(row.email);
  const readOnly = billingConfigured(deps.config) && isReadOnly(standingOf(row, now));
  if (to === null || row.user_id === null || row.user_status !== "active" || row.removing !== 0 || readOnly) return { did: "skipped" };
  const trial = billingConfigured(deps.config) && standingOf(row, now).kind === "trial";
  const mail = storageMail(to, {
    stage,
    workspaceName: row.name,
    used: usage.used,
    allowance: usage.allowance as number,
    tours: usage.pictures,
    gifs: usage.gifBytes,
    images: usage.imageBytes,
    origin: linkOrigin(deps.config),
    trial,
    footer: deps.config.mailFooter ?? null,
  });
  if (opts.dryRun === true) return { did: "would_send" };
  const claimedAt = now;
  const claimed = await deps.db.run("INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT DO NOTHING", [
    workspaceId,
    stage,
    await emailSha256(to),
    claimedAt,
  ]);
  if (claimed.changes !== 1) return { did: "none" };
  try {
    await mailOf(deps).send(mail);
  } catch (err) {
    // Handed over and then failed: it may have arrived, so it stays claimed and is not sent again.
    if ((err as { bodyWritten?: unknown } | null)?.bodyWritten === true) return { did: "unconfirmed" };
    await deps.db.run("DELETE FROM storage_mail WHERE workspace_id = ? AND stage = ? AND claimed_at = ? AND sent_at IS NULL", [workspaceId, stage, claimedAt]);
    return { did: "failed" };
  }
  await deps.db.batch([
    { sql: "UPDATE storage_mail SET sent_at = ? WHERE workspace_id = ? AND stage = ? AND claimed_at = ? AND sent_at IS NULL", params: [deps.now(), workspaceId, stage, claimedAt] },
    auditStatement(deps, { event: "storage_mail_sent", workspaceId, subject: row.user_id, detail: { stage } }, { onlyAfterOneChange: true }),
  ]);
  return { did: "sent", stage };
}

/** Lets the answer go first: the job starts on a later turn of the event loop. */
const afterTheAnswer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Asks for a check of the workspace after the answer (see the top of this file). Call it with
 * the id the request's credential gave, once what changed the usage has committed. Returns at
 * once and never throws; with no mailer it does nothing at all.
 */
export function storageMailSoon(deps: Deps, workspaceId: string): void {
  try {
    if (mailOf(deps) === NO_MAIL) return;
    deferOf(deps)(
      (async () => {
        await afterTheAnswer();
        try {
          await checkStorage(deps, workspaceId);
        } catch {
          // Fixed text only: the error could carry anything a back end put in its message.
          console.error(STORAGE_LINES.failed);
        }
      })(),
    );
  } catch {
    // Nothing of the mail may reach the answer.
  }
}

/** What a storage sweep did, in counts. */
export type StorageSweepSummary = {
  dryRun: boolean;
  mailOff: boolean;
  checked: number;
  sentLow: number;
  sentFull: number;
  failed: number;
  unconfirmed: number;
  skipped: number;
  rearmed: number;
  wouldSend: number;
  waiting: number;
  stoppedEarly: boolean;
};

/** One page of every workspace's numbers, by id after `?`: its usage, its allowance and whether it has a record. */
function pageSql(deps: Pick<Deps, "config">): string {
  return (
    `SELECT p.ws AS id, ${allowanceSqlFor(deps)} AS allowance, ${USAGE_COLUMNS},` +
    " (SELECT json_group_array(json_object('stage', m.stage, 'claimed_at', m.claimed_at, 'sent_at', m.sent_at)) FROM storage_mail m WHERE m.workspace_id = p.ws) AS mails" +
    ` FROM (SELECT w.id AS ws FROM workspace w WHERE w.id > ? ORDER BY w.id LIMIT ${PAGE}) p JOIN workspace ON workspace.id = p.ws ORDER BY p.ws`
  );
}

/**
 * One storage sweep. Without a mailer it reads nothing. Every workspace is looked at, a page at
 * a time; one whose numbers call for a mail it has no record of, or for a re-arm while it has
 * records, is checked (checkStorage), which reads it again and decides. At most `mailsPerRun`
 * mails are tried; the rest wait for the next sweep. A dry run sends and writes nothing. With
 * `calls` (a metered invocation, the Worker's scheduled handler) it stops before the call budget.
 */
export async function storageSweep(deps: Deps, opts: { dryRun?: boolean; calls?: () => number; mailsPerRun?: number } = {}): Promise<StorageSweepSummary> {
  const s: StorageSweepSummary = { dryRun: opts.dryRun === true, mailOff: false, checked: 0, sentLow: 0, sentFull: 0, failed: 0, unconfirmed: 0, skipped: 0, rearmed: 0, wouldSend: 0, waiting: 0, stoppedEarly: false };
  if (mailOf(deps) === NO_MAIL) {
    s.mailOff = true;
    return s;
  }
  const cap = opts.mailsPerRun ?? STORAGE_MAILS_PER_RUN;
  const calls = opts.calls;
  const room = (cost: number) => calls === undefined || calls() + cost + CALLS_KEPT <= SUBREQUEST_BUDGET;
  let tried = 0;
  let after = "";
  for (;;) {
    if (!room(1)) {
      s.stoppedEarly = true;
      return s;
    }
    const page = await deps.db.all<UsageRow & { id: string; mails: string }>(pageSql(deps), [deps.config.storageAllowanceBytes ?? null, after]);
    for (const row of page) {
      after = row.id;
      s.checked += 1;
      const usage = usageFromRow(row);
      const stage = stageOf(usage.used, usage.allowance);
      const records = recordsOf(row.mails);
      const due = stage === 100 ? !records.some((r) => r.stage === 100) : stage === 80 ? records.length === 0 : stage === "rearm" && records.length > 0;
      if (!due) continue;
      const mailing = stage !== "rearm";
      if (mailing && tried >= cap) {
        s.waiting += 1;
        continue;
      }
      if (!room(3)) {
        s.stoppedEarly = true;
        return s;
      }
      const out = await checkStorage(deps, row.id, { dryRun: s.dryRun });
      if (out.did === "sent" || out.did === "failed" || out.did === "unconfirmed" || out.did === "would_send") tried += 1;
      if (out.did === "sent") {
        if (out.stage === 100) s.sentFull += 1;
        else s.sentLow += 1;
      } else if (out.did === "failed") s.failed += 1;
      else if (out.did === "unconfirmed") s.unconfirmed += 1;
      else if (out.did === "skipped") s.skipped += 1;
      else if (out.did === "rearmed") s.rearmed += 1;
      else if (out.did === "would_send") s.wouldSend += 1;
    }
    if (page.length < PAGE) return s;
  }
}

/** What a storage sweep says, one line each, counts only. The admin command prints these; the Worker's scheduled handler logs them. */
export function storageSweepLines(s: StorageSweepSummary): string[] {
  if (s.mailOff) return ["Mail is off, so no storage mail was sent. Nothing was changed."];
  const lines = [s.dryRun ? "Dry run: nothing was sent or changed." : "Storage sweep done.", `Workspaces looked at: ${s.checked}.`];
  if (s.dryRun) {
    lines.push(`Storage mails that would be sent: ${s.wouldSend}.`);
  } else {
    lines.push(`Storage mails sent: ${s.sentLow + s.sentFull} (running low: ${s.sentLow}, full: ${s.sentFull}). Not sent, tried again next time: ${s.failed}.`);
    if (s.unconfirmed > 0) lines.push(`Storage mails handed to the mail server but never confirmed, not sent again until the storage drops below 70%: ${s.unconfirmed}.`);
  }
  if (s.waiting > 0) lines.push(`Storage mails over this run's cap, sent next time: ${s.waiting}.`);
  if (s.skipped > 0) lines.push(`Workspaces left out (read-only, disabled, being removed, or no usable address): ${s.skipped}.`);
  lines.push(`Workspaces whose storage mails were armed again (below 70%): ${s.rearmed}.`);
  if (s.stoppedEarly) lines.push("The sweep stopped at its call budget; the next sweep goes on.");
  return lines;
}

/**
 * One storage sweep within the call budget of one invocation (SUBREQUEST_BUDGET), as the Worker's
 * scheduled handler runs it: the deps are metered here and each summary line goes to `log`.
 * Answers the summary and the calls made.
 */
export async function storageSweepWithinBudget(deps: Deps, log: (line: string) => void = (line) => console.log(line)): Promise<{ summary: StorageSweepSummary; calls: number }> {
  const meter = metered(deps);
  const summary = await storageSweep(meter.deps, { calls: meter.calls });
  for (const line of storageSweepLines(summary)) log(line);
  return { summary, calls: meter.calls() };
}
