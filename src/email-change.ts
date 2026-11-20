// Changing an account's email address: asking for a change, which mails a link to the new
// address, and confirming it with the code in that link, which changes the address and
// mails a notice to the old one. No platform API.
//
// What holds for both routes:
// - Each takes a session and nothing else (a token is the one 401), and as a change it
//   needs the session's anti-forgery header and an Origin of this address (requireAuth).
//   Each answers on the app address only: the host gate keeps it there, and a session
//   counts nowhere else.
// - The new address arrives in a JSON body, and the code too: never in a path or a query.
//   Nothing here logs, echoes or records an address or a code; log lines are fixed text,
//   and the audit rows hold ids only.
//
// Asking for a change answers the same whether the new address is free, belongs to another
// account or is the caller's own: the same status, body and headers, after the same
// database calls in the same order. Whether a link is sent is decided in one job that runs
// after the answer, and that job runs the very same statements either way: every request
// replaces the account's earlier change, so neither the answer nor anything that happens to
// that earlier change later can be used to find out which addresses have an account. For an
// address that is taken, the new row is ended at once under a code nobody is told, and
// nothing is sent: not even a notice to its owner, which would let anyone send mail to any
// account's mailbox at will.
//
// A code is "dpe_" and 40 hex characters (160 random bits): a prefix of its own, so a
// sign-in code ("dpl_") is never taken as one, nor one of these as a sign-in code. Only its
// SHA-256 digest is stored. It works once, for EMAIL_CHANGE_MS, for the account that asked
// for it, signed in; asking again replaces it. Confirming changes the address, marks the
// code used, spends the account's open sign-in links (they went to the old address) and
// writes the audit row, in one batch that the database's own rules decide: of two confirms
// at once only one can change anything, and an address another account took in between is
// refused by the unique index on the user table, on both targets. Sessions stay signed in.
import type { Hono } from "hono";
import { parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { hashToken, newId, requireAuth } from "./auth.ts";
import { apiError, json } from "./http.ts";
import { emailChangedMail, emailChangeLink, emailChangeMail, linkOrigin } from "./mail.ts";
import { canMailLinks, deferOf, isNotNullViolation, isUniqueViolation, mailOf, type Deps } from "./ports.ts";
import { LIMITS_EMAIL_CHANGE, SITE_KEY, SITE_QUIET_KEY, accountKey, hitLimit, pairKey, recipientKey, sweepCounters } from "./rate.ts";
import { MAIL_REASONS, afterTheAnswer, ownJsonBody, withHeader } from "./signin.ts";

/** A change's link works for 15 minutes, as a sign-in link does. */
export const EMAIL_CHANGE_MS = 900_000;

/** The form of an email-change code. */
export const EMAIL_CODE_PATTERN = /^dpe_[0-9a-f]{40}$/;

/** The sentences the two routes answer with, for the account page to show as they are. */
export const EMAIL_CHANGE_SAYS = {
  rateLimited: "Too many requests. Wait a few minutes and try again.",
  mailOff: "This site cannot send mail, so an email address cannot be changed here.",
  badCode: "This link no longer works. Ask for a new one from your account page.",
} as const;

/** The fixed log lines. None holds an address, a code or a count. */
export const EMAIL_CHANGE_LINES = {
  hour: "email: the hourly limit of email-change mails was reached; no email-change link was sent",
  notMade: "email: an email-change link could not be made; none was sent",
  noticeOff: "email: mail is off, so no notice of an email change was sent",
} as const;

const NEEDS_EMAIL = 'the body must be JSON such as {"email": "name@example.com"}';
const NEEDS_CODE = 'the body must be JSON such as {"code": "…"}';

/** The 401 of `requireAuth`, for a session that resolved without its part (never, in practice). */
function unauthorized(): Response {
  return new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The 429 of both routes, with the time until the fullest count starts again. */
function tooMany(retryAfterSeconds: number): Response {
  return withHeader(apiError(429, "rate_limited", EMAIL_CHANGE_SAYS.rateLimited), "retry-after", String(retryAfterSeconds));
}

/** The one refusal of a code that is malformed, unknown, used, expired, replaced or another account's. */
function badCode(): Response {
  return apiError(400, "bad_code", EMAIL_CHANGE_SAYS.badCode);
}

function randomHex(bytes: number): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A mail client's own fixed word for a failure, or "failed": never an error's text, which could hold the address. */
function reasonOf(err: unknown): string {
  const reason = (err as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && MAIL_REASONS.includes(reason) ? reason : "failed";
}

/**
 * What the job after a change request does. `to` is the address asked for; `origin` is set
 * only when a link is to be mailed to it (the address is free and the cap allows).
 */
type ChangeJob = { userId: string; workspaceId: string; overHour: boolean; to: string; origin: string | null };

/**
 * The work of a change request that runs after the answer. Every job, whatever the address,
 * makes a code, waits for its digest and writes the same batch of the same two statements:
 * the account's one change row is replaced (so its earlier change ends, whatever was asked
 * for now) and the audit row. Only when a link is to be mailed is the new row left open;
 * otherwise it is written as used at once, under a code nobody is ever told, so it can never
 * be confirmed. Either way the earlier change is gone, so nothing later can tell which
 * addresses have an account. Only then is the link mailed. A change that cannot be written
 * is one fixed line and no mail; a mail that fails is one fixed line. Nothing is tried twice.
 */
async function changeJob(deps: Deps, job: ChangeJob): Promise<void> {
  await afterTheAnswer();
  if (job.overHour) console.error(EMAIL_CHANGE_LINES.hour);
  const { to, origin } = job;
  let link: string | null = null;
  try {
    const code = "dpe_" + randomHex(20);
    const hash = await hashToken(code);
    const now = deps.now();
    await deps.db.batch([
      {
        // One row per account: asking again replaces the earlier change and its code.
        sql: `INSERT INTO email_change (id, user_id, new_email, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id) DO UPDATE SET id = excluded.id, new_email = excluded.new_email, code_hash = excluded.code_hash, created_at = excluded.created_at, used_at = excluded.used_at`,
        params: [newId("emc"), job.userId, to, hash, now, origin === null ? now : null],
      },
      auditStatement(deps, { event: "email_change_requested", userId: job.userId, workspaceId: job.workspaceId, subject: job.userId }),
    ]);
    if (origin !== null) link = emailChangeLink(origin, code);
  } catch {
    console.error(EMAIL_CHANGE_LINES.notMade);
    return;
  }
  if (link === null) return;
  try {
    await mailOf(deps).send(emailChangeMail(to, link));
  } catch (err) {
    console.error(`mail: an email-change mail could not be sent (${reasonOf(err)})`);
  }
}

/** The notice to the old address, after the answer. Never tried twice. */
async function noticeJob(deps: Deps, notice: { to: string; username: string | null; newEmail: string }): Promise<void> {
  await afterTheAnswer();
  if (!canMailLinks(deps)) {
    console.error(EMAIL_CHANGE_LINES.noticeOff);
    return;
  }
  try {
    await mailOf(deps).send(emailChangedMail(notice.to, notice.username, notice.newEmail));
  } catch (err) {
    console.error(`mail: an email-change notice could not be sent (${reasonOf(err)})`);
  }
}

export type ConfirmedChange = { userId: string; workspaceId: string; oldEmail: string; newEmail: string; username: string | null };

/**
 * Applies the change the code names, once, for the account `userId` alone. Returns what
 * changed, or null when the code is malformed, unknown, used, expired, replaced or of
 * another account, and when the new address belongs to another account by now. A refusal
 * changes nothing of any other account; a code whose address was taken in between is spent,
 * since it can never work.
 *
 * One read, then one batch that decides:
 * 1. the account's address becomes the change's new one, read inside the statement, and
 *    only while the change is unused and unexpired; for any other change, or an account
 *    that is gone, no row is changed. An address another account has is refused by the
 *    unique index, and the whole batch is undone;
 * 2. the audit row, with ids only, which is also the batch's guard: unless statement 1
 *    changed exactly one row it fails, and the whole batch is undone, so success is never
 *    reported (nor a notice sent) for a change that was not made;
 * 3. the change is marked used;
 * 4. the account's open sign-in codes are spent: they were mailed to the old address.
 */
export async function confirmEmailChange(deps: Deps, userId: string, code: string): Promise<ConfirmedChange | null> {
  if (typeof code !== "string" || !EMAIL_CODE_PATTERN.test(code)) return null;
  const hash = await hashToken(code);
  const now = deps.now();
  const since = now - EMAIL_CHANGE_MS;
  const found = await deps.db.first<{ new_email: string; old_email: string; username: string | null; workspace_id: string }>(
    `SELECT e.new_email, u.email AS old_email, u.username, m.workspace_id
       FROM email_change e
       JOIN user u ON u.id = e.user_id
       JOIN membership m ON m.user_id = u.id
      WHERE e.code_hash = ? AND e.user_id = ? AND e.used_at IS NULL AND e.created_at > ?`,
    [hash, userId, since],
  );
  if (found === null) return null;
  try {
    const usable = "FROM email_change e WHERE e.code_hash = ? AND e.user_id = ? AND e.used_at IS NULL AND e.created_at > ?";
    await deps.db.batch([
      {
        sql: `UPDATE user SET email = (SELECT e.new_email ${usable}) WHERE id = ? AND EXISTS (SELECT 1 ${usable})`,
        params: [hash, userId, since, userId, hash, userId, since],
      },
      // Right after the change it judges: unless exactly one account row was changed, this
      // fails and the whole batch is undone.
      auditStatement(deps, { event: "email_changed", userId, workspaceId: found.workspace_id, subject: userId }, { onlyAfterOneChange: true }),
      { sql: "UPDATE email_change SET used_at = ? WHERE code_hash = ? AND user_id = ?", params: [now, hash, userId] },
      { sql: "UPDATE signin_code SET used_at = ? WHERE user_id = ? AND used_at IS NULL", params: [now, userId] },
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      await deps.db.run("UPDATE email_change SET used_at = ? WHERE code_hash = ? AND user_id = ? AND used_at IS NULL", [now, hash, userId]);
      return null;
    }
    if (isNotNullViolation(err)) return null;
    throw err;
  }
  return { userId, workspaceId: found.workspace_id, oldEmail: found.old_email, newEmail: found.new_email, username: found.username };
}

export function emailChangeRoutes(app: Hono, deps: Deps): void {
  /**
   * Asks for a change of the caller's email address. A well-formed address answers 200
   * `{"ok":true}` whether it is free, another account's or the caller's own; a link is
   * mailed to it only when it is free and email change's own mail cap allows.
   *
   * Before the answer, the same database calls for every well-formed address: the six
   * counts (two per account, two per account and address, two per address, all counted
   * whatever the first says), the one read of who has the address, email change's mail cap
   * (under the quiet key when nothing will be sent) and the counter sweep. Then one job for
   * every request, after the answer.
   */
  app.post("/api/v1/account/email", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    // Nothing is counted or stored on a site that could not mail the link.
    if (!canMailLinks(deps)) return apiError(409, "mail_off", EMAIL_CHANGE_SAYS.mailOff);
    const body = await ownJsonBody(req, deps, NEEDS_EMAIL);
    if (body instanceof Response) return body;
    const email = parseEmail(body.email);
    if (email === null) return json(400, { error: "bad_email" });

    const userId = auth.session.userId;
    const account = await accountKey(userId);
    const pair = await pairKey(userId, email);
    const recipient = await recipientKey(email);
    const counts = [
      await hitLimit(deps, LIMITS_EMAIL_CHANGE.requestAccount, account),
      await hitLimit(deps, LIMITS_EMAIL_CHANGE.requestAccountDay, account),
      await hitLimit(deps, LIMITS_EMAIL_CHANGE.requestPair, pair),
      await hitLimit(deps, LIMITS_EMAIL_CHANGE.requestPairDay, pair),
      await hitLimit(deps, LIMITS_EMAIL_CHANGE.requestRecipient, recipient),
      await hitLimit(deps, LIMITS_EMAIL_CHANGE.requestRecipientDay, recipient),
    ].filter((counted) => counted.over);
    // Whether a count is over says nothing about who has the address: every request is counted alike.
    if (counts.length > 0) return tooMany(Math.max(...counts.map((counted) => counted.retryAfterSeconds)));

    // One read says whether the address is free. Nothing of the answer depends on it.
    const holder = await deps.db.first<{ id: string }>("SELECT id FROM user WHERE email = ?", [email]);
    const free = holder === null;
    // Email change's own cap, apart from sign-in's, counts only mails about to be sent; any
    // other request makes the same call under the quiet key.
    const cap = await hitLimit(deps, LIMITS_EMAIL_CHANGE.mailSite, free ? SITE_KEY : SITE_QUIET_KEY);
    await sweepCounters(deps);

    // canMailLinks said there is an address for links; it comes from the settings alone.
    const origin = linkOrigin(deps.config) ?? "";
    deferOf(deps)(changeJob(deps, { userId, workspaceId: auth.workspaceId, overHour: free && cap.over, to: email, origin: free && !cap.over ? origin : null }));
    return json(200, { ok: true });
  });

  /**
   * Confirms a change with the code of its link: the caller's address becomes the new one,
   * once, and the old address is sent a notice. Answers the new and the old address, for
   * the page to say both. Any code that cannot be used gets the one refusal.
   */
  app.post("/api/v1/account/email/confirm", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const body = await ownJsonBody(req, deps, NEEDS_CODE);
    if (body instanceof Response) return body;
    const code = body.code;
    if (typeof code !== "string" || !EMAIL_CODE_PATTERN.test(code)) return badCode();

    const userId = auth.session.userId;
    const tries = await hitLimit(deps, LIMITS_EMAIL_CHANGE.confirmAccount, await accountKey(userId));
    if (tries.over) return tooMany(tries.retryAfterSeconds);

    const changed = await confirmEmailChange(deps, userId, code);
    if (changed === null) return badCode();
    deferOf(deps)(noticeJob(deps, { to: changed.oldEmail, username: changed.username, newEmail: changed.newEmail }));
    return json(200, { email: changed.newEmail, previous_email: changed.oldEmail });
  });
}
