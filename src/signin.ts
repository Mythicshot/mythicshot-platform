// The sign-in and session API: asking for a sign-in link, completing a sign-in, the
// session, the list of sessions, ending one, and the two sign-outs. No platform API.
//
// What holds for every route here:
// - Each answers on the app address only (in one-address mode: on the one address). The
//   host gate keeps them there, and the two routes that sign someone in check it again.
// - A sign-in code arrives in a JSON body and nowhere else: never in a path or a query.
//   Nothing here logs, echoes, records or redirects with a code, a session secret, a
//   cookie or an email address; log lines are fixed text.
// - Only completing a sign-in, the session answer and the two sign-outs set or clear the
//   session cookie, and no refusal ever does.
//
// The two requests that have no session yet (asking for a link, completing a sign-in) are
// protected by the origin check alone: they must come from a page of this address
// (`sameOriginChange`) and carry `application/json`, which no form on another page can
// send. Without that, another site could sign a visitor in as someone else.
//
// Asking for a link answers the same whether or not the address has an account: the same
// status, body and headers, after the same database calls in the same order. Everything
// only an account gets (its code, the audit row, the mail) is one job handed to the target
// to run after the answer, so nothing an account costs can be timed from outside.
import type { Hono } from "hono";
import { parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { requireAuth } from "./auth.ts";
import { clientAddressOf } from "./client.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { NO_MAIL, linkOrigin, signInLink, signInMail } from "./mail.ts";
import { deferOf, mailOf, type Deps, type Stmt } from "./ports.ts";
import { LIMITS_SIGNIN, SITE_KEY, SITE_QUIET_KEY, hitLimit, networkKey, recipientKey, sweepCounters, type Limit } from "./rate.ts";
import { clearedCookie, createSignInCode, csrfFor, readSessionCookie, redeemSignInCode, revokeAll, revokeSession, sameOriginChange, sessionCookie, sessionHost, sweepSessions } from "./sessions.ts";

/** The longest body the two sign-in requests read: an address is at most 254 characters, a code 44. */
const MAX_BODY_BYTES = 2048;
/** The most sessions the list answers. The caller's own is always among them. */
const MAX_SESSIONS_LISTED = 100;

const CODE_PATTERN = /^dpl_[0-9a-f]{40}$/;
/** What a mail client says went wrong: the only words of a failure that reach a log line. */
const MAIL_REASONS: readonly string[] = ["connect", "tls", "auth", "refused", "timeout"];

const NEEDS_EMAIL = 'the body must be JSON such as {"email": "name@example.com"}';
const NEEDS_CODE = 'the body must be JSON such as {"code": "…"}';

/** The fixed log lines of asking for a link. None holds an address, a code or a count. */
export const SIGNIN_LINES = {
  recipient: "signin: an address asked for more sign-in links than its limit; none was sent",
  hour: "signin: the hourly limit of sign-in mails was reached; none was sent",
  notMade: "signin: a sign-in link could not be made; none was sent",
} as const;

/** The 401 of `requireAuth`, for a session that ended between being resolved and being read. */
function unauthorized(): Response {
  return new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * The counter the job of a link request adds to when it makes no link, so that it writes as
 * much as a job that does: one row of `rate_counter` per hour. No limit reads it, and the
 * counter sweep removes old rows as it removes every other counter's.
 */
export const PAD_BUCKET = "signin_pad";
export const PAD_KEY = "pad";
const PAD_WINDOW_MS = 3_600_000;

/**
 * The statement that adds one to this hour's pad counter: it always changes one row.
 *
 * It is written here, against `rate_counter` directly, and not through src/rate.ts: the
 * pad is no limit, so `hitLimit` (which pairs a count with a limit's number) does not fit
 * it, and a counter row costs no new table. No limit reads the pad bucket; it is in no
 * entry of LIMITS_SIGNIN, and `sweepCounters` removes its old rows with every other counter's.
 */
function padStatement(deps: Deps): Stmt {
  const now = deps.now();
  return {
    sql: "INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, 1) ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = count + 1",
    params: [PAD_BUCKET, PAD_KEY, now - (now % PAD_WINDOW_MS)],
  };
}

/** Resolves once the current task is over, so work started now runs only after the answer has been handed back. */
function afterTheAnswer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A copy of the answer with one more header. */
function withHeader(res: Response, name: string, value: string): Response {
  const headers = new Headers(res.headers);
  headers.set(name, value);
  return new Response(res.body, { status: res.status, headers });
}

/**
 * What stands in front of both sign-in requests, decided from the request alone before
 * anything is counted or looked up: the address takes sessions, the request comes from a
 * page of this address, and its body is labelled JSON and is a JSON object of at most
 * MAX_BODY_BYTES. Answers that object, or the refusal.
 */
async function ownJsonBody(req: Request, deps: Deps, needs: string): Promise<Record<string, unknown> | Response> {
  // The host gate answers this for the tours address already. Checked again here: no
  // link is asked for, and nobody signed in, on an address that takes no session.
  if (!sessionHost(req, deps)) return json(404, { error: "not_found" });
  if (!sameOriginChange(req)) return apiError(403, "bad_origin", "this request must come from the site's own pages");
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return apiError(400, "bad_request", needs);
  const bytes = await readCapped(req, MAX_BODY_BYTES);
  if (bytes === "too_large") return apiError(400, "bad_request", needs);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return apiError(400, "bad_request", needs);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return apiError(400, "bad_request", needs);
  return body as Record<string, unknown>;
}

/**
 * Counts one request of the caller's network against `limit`, and answers 429 with
 * `retry-after` when it is over. A caller whose network is unknown (no address, or a
 * private one that every visitor behind a proxy would share) has no count of its own and
 * is never refused here.
 */
async function networkLimit(req: Request, deps: Deps, limit: Limit): Promise<Response | null> {
  const key = await networkKey(clientAddressOf(req));
  if (key === null) return null;
  const counted = await hitLimit(deps, limit, key);
  return counted.over ? withHeader(json(429, { error: "rate_limited" }), "retry-after", String(counted.retryAfterSeconds)) : null;
}

/** What the job after a link request does: write lines, and for an account that may get a link, make it and mail it. */
type LinkJob = { overRecipient: boolean; overHour: boolean; link: { userId: string; workspaceId: string; to: string; origin: string } | null };

/**
 * The work of a link request that runs after the answer, in one job: the fixed lines, and
 * for an account that gets a link its code, the audit row and one mail. A code or audit row
 * that cannot be written is one fixed line and no mail; a mail that fails is one fixed line.
 * Nothing is ever tried twice: a mail that failed after its text was sent may have arrived.
 *
 * Every job makes the same database work: one write and then one batch, each changing one
 * row. Without a link they add twice to the pad counter. On a target whose database blocks
 * (Node), a job that wrote for an account alone would delay the next request, whatever it
 * is, and so tell who has an account.
 */
async function linkJob(deps: Deps, job: LinkJob): Promise<void> {
  await afterTheAnswer();
  if (job.overRecipient) console.error(SIGNIN_LINES.recipient);
  if (job.overHour) console.error(SIGNIN_LINES.hour);
  if (job.link === null) {
    try {
      // Making a code waits once for its digest before the write; so does this, so both
      // jobs write at the same moment after the answer.
      await crypto.subtle.digest("SHA-256", crypto.getRandomValues(new Uint8Array(24)));
      const pad = padStatement(deps);
      await deps.db.run(pad.sql, pad.params);
      await deps.db.batch([padStatement(deps)]);
    } catch {
      // A pad that could not be written changes nothing anyone asked for.
    }
    return;
  }
  const { userId, workspaceId, to, origin } = job.link;
  let link: string;
  try {
    const code = await createSignInCode(deps, userId);
    await deps.db.batch([auditStatement(deps, { event: "signin_link_sent", userId, workspaceId })]);
    link = signInLink(origin, code);
  } catch {
    console.error(SIGNIN_LINES.notMade);
    return;
  }
  try {
    await mailOf(deps).send(signInMail(to, link));
  } catch (err) {
    // Only a mail client's own fixed word is repeated: an error's text could hold
    // anything a mail server said, and the address.
    const reason = (err as { reason?: unknown } | null)?.reason;
    console.error(`mail: a sign-in mail could not be sent (${typeof reason === "string" && MAIL_REASONS.includes(reason) ? reason : "failed"})`);
  }
}

export function signinRoutes(app: Hono, deps: Deps): void {
  /**
   * Asks for a sign-in link. A well-formed address always answers 200 `{"ok":true}`; a
   * link is mailed only to an active account that signs in by mail, on a site that has an
   * admin, a configured address for links and a mailer, and only while the limits allow.
   *
   * Before the answer, the same database calls for every well-formed address: the two
   * counts per recipient, the account lookup, the count of the site's mails (under the
   * quiet key when nothing will be sent) and the two sweeps; with a known network, its
   * count comes first. Then one job is handed to the target for every request; it waits
   * until the answer is out, and only for an account that gets a link does it write the
   * code and the audit row and send the mail.
   */
  app.post("/api/v1/signin/request", async (c) => {
    const req = c.req.raw;
    const body = await ownJsonBody(req, deps, NEEDS_EMAIL);
    if (body instanceof Response) return body;
    const email = parseEmail(body.email);
    if (email === null) return json(400, { error: "bad_email" });

    const limited = await networkLimit(req, deps, LIMITS_SIGNIN.linkNetwork);
    if (limited !== null) return limited;

    // Both limits per recipient are counted for every request, whatever the first says.
    const recipient = await recipientKey(email);
    const quarter = await hitLimit(deps, LIMITS_SIGNIN.linkRecipient, recipient);
    const day = await hitLimit(deps, LIMITS_SIGNIN.linkRecipientDay, recipient);

    // One read says whether this address may be sent a link at all. Nothing of the
    // answer depends on it.
    const account = await deps.db.first<{ id: string; workspace_id: string }>(
      `SELECT u.id, m.workspace_id
         FROM user u
         JOIN membership m ON m.user_id = u.id
        WHERE u.email = ? AND u.status = 'active'
          AND EXISTS (SELECT 1 FROM signin_method s WHERE s.user_id = u.id AND s.kind = 'email_link')
          AND EXISTS (SELECT 1 FROM user a WHERE a.is_admin = 1)`,
      [email],
    );
    // The link's address comes from the settings alone, never from this request.
    const origin = linkOrigin(deps.config);
    const wanted = account !== null && origin !== null && mailOf(deps) !== NO_MAIL && !quarter.over && !day.over;

    // The site's cap counts only mails that are about to be sent. A request that sends
    // nothing makes the same call under the quiet key, and what that answers is not read.
    const cap = await hitLimit(deps, LIMITS_SIGNIN.mailSite, wanted ? SITE_KEY : SITE_QUIET_KEY);

    // Housekeeping rides on this request: sessions and codes that are over, old counters.
    // Bounded, the same for every request, and never a reason to fail it.
    await sweepSessions(deps).catch(() => {});
    await sweepCounters(deps);

    // One job for every request, whatever it holds; it starts only after the answer.
    const link = wanted && !cap.over && account !== null && origin !== null ? { userId: account.id, workspaceId: account.workspace_id, to: email, origin } : null;
    deferOf(deps)(linkJob(deps, { overRecipient: quarter.over || day.over, overHour: wanted && cap.over, link }));
    return json(200, { ok: true });
  });

  /**
   * Completes a sign-in: the code of a link, once, becomes a session and its cookie. A
   * code that is unknown, used, expired or of an account that may not sign in gets the one
   * refusal. The answer never repeats the code.
   */
  app.post("/api/v1/signin/complete", async (c) => {
    const req = c.req.raw;
    const body = await ownJsonBody(req, deps, NEEDS_CODE);
    if (body instanceof Response) return body;
    const code = body.code;
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) return json(400, { error: "bad_code" });

    const limited = await networkLimit(req, deps, LIMITS_SIGNIN.codeNetwork);
    if (limited !== null) return limited;

    // The session the browser already has, if any, ends when the new one is made.
    const made = await redeemSignInCode(deps, code, req.headers.get("user-agent"), readSessionCookie(req));
    if (made === null) return apiError(403, "link_invalid", "this sign-in link has expired or was already used");
    return withHeader(json(200, { ok: true }), "set-cookie", sessionCookie(made.secret));
  });

  /** Who the session is: the account, its workspace, this session, and the anti-forgery value a change needs. Sets the cookie again. */
  app.get("/api/v1/session", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    // The cookie requireAuth accepted: exactly one, well formed.
    const secret = readSessionCookie(req);
    if (auth.session === undefined || secret === null) return unauthorized();
    const row = await deps.db.first<{ username: string | null; email: string; is_admin: number; name: string; created_at: number; expires_at: number }>(
      `SELECT u.username, u.email, u.is_admin, w.name, s.created_at, s.expires_at
         FROM session s
         JOIN user u ON u.id = s.user_id
         JOIN membership m ON m.user_id = u.id
         JOIN workspace w ON w.id = m.workspace_id
        WHERE s.id = ? AND s.user_id = ? AND w.id = ?`,
      [auth.session.id, auth.session.userId, auth.workspaceId],
    );
    if (row === null) return unauthorized();
    const answer = json(200, {
      account: { id: auth.session.userId, username: row.username, email: row.email, admin: row.is_admin === 1 },
      workspace: { id: auth.workspaceId, name: row.name },
      session: { id: auth.session.id, created_at: row.created_at, expires_at: row.expires_at },
      csrf: await csrfFor(secret),
    });
    return withHeader(answer, "set-cookie", sessionCookie(secret));
  });

  /** The caller's own sessions that are not over, the current one first and marked. */
  app.get("/api/v1/sessions", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const current = auth.session.id;
    const rows = await deps.db.all<{ id: string; label: string; created_at: number; last_used_at: number; expires_at: number }>(
      `SELECT id, label, created_at, last_used_at, expires_at
         FROM session
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY (id = ?) DESC, last_used_at DESC, id
        LIMIT ?`,
      [auth.session.userId, deps.now(), current, MAX_SESSIONS_LISTED],
    );
    return json(200, {
      sessions: rows.map((r) => ({ id: r.id, label: r.label, created_at: r.created_at, last_used_at: r.last_used_at, expires_at: r.expires_at, current: r.id === current })),
    });
  });

  /**
   * Ends one of the caller's own sessions. Another account's id answers as one that never
   * existed. Touches no cookie: ending the caller's own current session this way leaves its
   * cookie in the browser (it then names no session), and the site's page treats a 204 for
   * its own session's id as a sign-out.
   */
  app.delete("/api/v1/sessions/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const id = c.req.param("id");
    const ended = await revokeSession(deps, auth.session.userId, id, id === auth.session.id ? "signout" : "session_revoked");
    return ended ? noContent() : apiError(404, "not_found", "no such session");
  });

  /** Ends this session and clears the cookie. */
  app.post("/api/v1/signout", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    // False when another request ended it a moment ago: signed out all the same.
    await revokeSession(deps, auth.session.userId, auth.session.id, "signout");
    return withHeader(noContent(), "set-cookie", clearedCookie());
  });

  /** Ends every session of the caller's account and clears the cookie. Tokens are untouched. */
  app.post("/api/v1/signout/everywhere", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    await revokeAll(deps, auth.session.userId);
    return withHeader(noContent(), "set-cookie", clearedCookie());
  });
}
