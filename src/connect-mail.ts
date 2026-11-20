// The mail an account gets once Mythicshot on a computer has collected the token the account
// confirmed (src/connect.ts), so that a person finds out about a connection they did not
// make. No platform API.
//
// What holds:
// - It is asked for only after the collection's batch has committed, by the collection that
//   made the token: of two collections at once, the one that loses never gets here. So there
//   is at most one mail per token, and none for a collection that fails.
// - It never changes the collection's answer, nor delays it: everything here runs in one job
//   handed to the target (Deps.defer), which starts after the answer has gone. A site without
//   a mailer defers nothing and makes no call at all.
// - It goes to the confirming account's address as it is when the job runs, read then, and
//   to no one else. The address is never logged or recorded.
// - It has caps of its own (LIMITS_CONNECT_MAIL in src/rate.ts), apart from sign-in's.
// - A notice that is not sent (over a cap, an address that cannot be used, a mailer that
//   refuses or throws) is one audit row, `connection_mail_not_sent`, with the request and a
//   fixed word for why, and is never tried again: a mail that failed after its text was sent
//   may still have arrived.
import { parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { NO_MAIL, connectedMail, linkOrigin } from "./mail.ts";
import { deferOf, mailOf, type Deps } from "./ports.ts";
import { LIMITS_CONNECT_MAIL, SITE_KEY, accountKey, hitLimit } from "./rate.ts";
import { MAIL_REASONS, afterTheAnswer } from "./signin.ts";

/** What the collection knows of the token it made: ids only. */
export type Collected = { requestId: string; userId: string; workspaceId: string; tokenId: string };

/** The fixed log line. It holds no address, name or id. */
export const CONNECTED_MAIL_LINES = {
  notRecorded: "connect: a connection mail was not sent, and that could not be recorded",
} as const;

/** A mail client's own fixed word for a failure, or "failed": never an error's text, which could hold the address. */
function reasonOf(err: unknown): string {
  const reason = (err as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && MAIL_REASONS.includes(reason) ? reason : "failed";
}

/**
 * Asks for the mail about a token just collected. Call it only once the batch that made the
 * token has committed. Returns at once and never throws; with no mailer it does nothing.
 */
export function mailConnection(deps: Deps, collected: Collected): void {
  try {
    if (mailOf(deps) === NO_MAIL) return;
    deferOf(deps)(connectionMailJob(deps, collected));
  } catch {
    // Nothing of the mail may reach the answer.
  }
}

/**
 * The job, after the answer: one read (the device's name, when it was collected, and the
 * confirming account's address now), the account's count, the site's count, the mail. At
 * most five calls, the record included. Why a notice was not sent:
 * - `no_address`: the request or the account is gone, or its address cannot be used;
 * - `limit_account`, `limit_site`: a cap of LIMITS_CONNECT_MAIL was reached;
 * - a mail client's word (`connect`, `tls`, `auth`, `refused`, `timeout`), or `failed`.
 */
async function connectionMailJob(deps: Deps, c: Collected): Promise<void> {
  await afterTheAnswer();
  let reason: string;
  try {
    const row = await deps.db.first<{ device_name: string; collected_at: number | null; email: string }>(
      `SELECT r.device_name, r.collected_at, u.email
         FROM connect_request r
         JOIN user u ON u.id = r.confirmed_by
        WHERE r.id = ? AND r.confirmed_by = ? AND r.token_id = ? AND r.collected_at IS NOT NULL`,
      [c.requestId, c.userId, c.tokenId],
    );
    const to = row === null ? null : parseEmail(row.email);
    if (row === null || to === null || typeof row.collected_at !== "number") {
      reason = "no_address";
    } else if ((await hitLimit(deps, LIMITS_CONNECT_MAIL.mailAccountDay, await accountKey(c.userId))).over) {
      reason = "limit_account";
    } else if ((await hitLimit(deps, LIMITS_CONNECT_MAIL.mailSite, SITE_KEY)).over) {
      reason = "limit_site";
    } else {
      try {
        await mailOf(deps).send(connectedMail(to, row.device_name, row.collected_at, linkOrigin(deps.config)));
        return;
      } catch (err) {
        reason = reasonOf(err);
      }
    }
  } catch {
    reason = "failed";
  }
  try {
    await deps.db.batch([auditStatement(deps, { event: "connection_mail_not_sent", userId: c.userId, workspaceId: c.workspaceId, subject: c.tokenId, detail: { request: c.requestId, reason } })]);
  } catch {
    console.error(CONNECTED_MAIL_LINES.notRecorded);
  }
}
