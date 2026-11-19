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
// status, body and headers, and the same database calls of the same kinds in the same
// order. Where the request for an account does something the other does not (store a
// code, write the audit row), the other makes a call of the same kind that writes nothing.
import type { Hono } from "hono";
import { parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { requireAuth } from "./auth.ts";
import { clientAddressOf } from "./client.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { NO_MAIL, linkOrigin, signInLink, signInMail } from "./mail.ts";
import { deferOf, mailOf, type Deps } from "./ports.ts";
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

/** The 401 of `requireAuth`, for a session that ended between being resolved and being read. */
function unauthorized(): Response {
  return new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json" } });
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

/** Hands the mail over, for after the answer. A failure is one fixed line, and a mail is never handed over twice. */
function sendLater(deps: Deps, to: string, link: string): void {
  const work = (async () => mailOf(deps).send(signInMail(to, link)))().catch((err: unknown) => {
    // Only a mail client's own fixed word is repeated: an error's text could hold
    // anything a mail server said, and the address.
    const reason = (err as { reason?: unknown } | null)?.reason;
    console.error(`mail: a sign-in mail could not be sent (${typeof reason === "string" && MAIL_REASONS.includes(reason) ? reason : "failed"})`);
  });
  deferOf(deps)(work);
}

export function signinRoutes(app: Hono, deps: Deps): void {
  /**
   * Asks for a sign-in link. A well-formed address always answers 200 `{"ok":true}`; a
   * link is mailed only to an active account that signs in by mail, on a site that has an
   * admin, a configured address for links and a mailer, and only while the limits allow.
   *
   * The database calls, the same for every well-formed address: the two counts per
   * recipient, the account lookup, the count of the site's mails, the code (or a
   * statement that stores none), the audit row (or a batch that writes none), and the
   * two sweeps. With a known network, its count comes first.
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
    if (wanted && cap.over) console.error("signin: the hourly limit of sign-in mails was reached; none was sent");

    if (wanted && !cap.over && account !== null && origin !== null) {
      const code = await createSignInCode(deps, account.id);
      await deps.db.batch([auditStatement(deps, { event: "signin_link_sent", userId: account.id, workspaceId: account.workspace_id })]);
      sendLater(deps, email, signInLink(origin, code));
    } else {
      // The same two calls, of the same kinds, storing nothing: no code is made and
      // nothing is recorded for an address that gets no link.
      await deps.db.run("INSERT INTO signin_code (id, user_id, hash, created_at, expires_at) SELECT NULL, NULL, NULL, NULL, NULL WHERE 0");
      await deps.db.batch([{ sql: "INSERT INTO audit (id, at, event) SELECT NULL, NULL, NULL WHERE 0" }]);
    }

    // Housekeeping rides on this request: sessions and codes that are over, old counters.
    // Bounded, the same for every request, and never a reason to fail it.
    await sweepSessions(deps).catch(() => {});
    await sweepCounters(deps);
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

  /** Ends one of the caller's own sessions. Another account's id answers as one that never existed. Touches no cookie. */
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
