// Invites: the site's admin invites a person by email address, and the person accepts with
// the code in the mailed link, choosing a username; that makes their account, an empty
// workspace of their own and a session, at once. No platform API.
//
// The code is "dpi_" and 40 hex characters (160 random bits), a prefix of its own, so it is
// never taken for a token ("dp_"), a sign-in code ("dpl_"), an email-change code ("dpe_") or
// a device code ("dpd_"). Only its SHA-256 digest is stored. It travels in the fragment of the
// mailed link (`<linkOrigin>/invite#<code>`, which a browser sends to no server) and in request
// bodies, never in a path or a query, and nothing here logs, echoes or records it. It works
// once and for INVITE_MS.
//
// The admin routes (POST, GET /api/v1/admin/invites, POST /api/v1/admin/invites/:id/resend,
// DELETE /api/v1/admin/invites/:id) take the session of a site admin alone, through
// `requireAuth(..., { admin: true })`: anyone else, a token included, gets the one 404 every
// admin route answers, and nothing is counted or changed. They answer on the app address.
//
// An address has at most one invite (a unique rule in migration 0012). A new invite to it,
// and "resend", give that one row a new code, so the older link stops working at once.
// Cancelling removes the row, and so does accepting. A row whose time ran out stays listed
// ("expired") until it is cancelled or replaced, and is swept INVITE_KEPT_MS after it ran out,
// a few at a time, by the admin's own list and sends. At most MAX_INVITES invites are open
// (unexpired) at once; rows that ran out do not count, so they never block a send while they
// wait for the sweep. The list stays bounded at MAX_INVITES rows, newest first: an invite's
// end is always 7 days after its start, so every open invite is newer than every expired one
// and all open invites are always on it.
//
// Sending needs mail: on a site that cannot mail a link (no mailer, or no address for links)
// it is refused with `mail_off` before anything is counted or stored. The mail is sent
// within the request, after the row is written, so the admin hears how it went: a mail that
// fails leaves the invite in place (the mail may even have arrived) and answers 502
// `mail_failed`, and "resend" tries again with a new code.
//
// The person's two requests, POST /api/v1/invite/check and POST /api/v1/invite/accept:
// - take no credential. A token (an Authorization header) is refused with 400
//   `credentials_not_allowed`, as the app's requests while it connects refuse one. A browser
//   that is signed in, to any account, is refused with 409 `signed_in`, before the code is
//   looked at: an invite never switches a browser from one account to another, and never
//   signs anyone out. A session cookie that names no live session is no session and is
//   not in the way; the accept's new cookie replaces it.
// - are changing requests from a page of the app address, so they are held to the origin
//   rule that completing a sign-in is held to (`ownJsonBody`): same origin, JSON, a small body.
// - are counted per network, and all callers whose network is not known together
//   (LIMITS_INVITE).
// - answer one fixed 404 `invite_invalid` for every code that cannot be used: unknown,
//   malformed, used, cancelled, replaced or expired, after the same database calls (one
//   read that finds nothing), so codes cannot be told apart. The accept decides this before
//   it looks at the username, so a dead code with any username, a malformed or a reserved one
//   included, gets that one answer too; then the address that has an account by now; only
//   then the username (`bad_username`, `reserved_username`, `username_taken`).
//
// Accepting is one batch that cannot half-apply, decided by the database's own rules: the
// invite row is removed only while it is still there under this code and unexpired, and the
// audit row right after it fails the whole batch unless exactly that one row went; then the
// workspace (named after the username, with no allowance of its own, so it follows the
// site's standard), the account (the invited address, the username, active, not an admin),
// its membership as owner, its sign-in method (a link by mail), the session and the sign-in's
// audit row. Of two accepts of one code only one can remove the row. A username or an
// address another account took meanwhile is refused by the user table's unique rules, the
// whole batch is undone, and the answer says which; a refused accept never uses up the invite.
import type { Hono } from "hono";
import { parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { hashToken, newId, requireAuth } from "./auth.ts";
import { clientAddressOf } from "./client.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { inviteLink, inviteMail, linkOrigin } from "./mail.ts";
import { canMailLinks, isNotNullViolation, isUniqueViolation, mailOf, type Deps } from "./ports.ts";
import { LIMITS_INVITE, SITE_KEY, accountKey, hitLimit, networkKey } from "./rate.ts";
import { firstEnd, resolveSession, sessionCookie, sessionCookiePresent, sessionLabel } from "./sessions.ts";
import { MAIL_REASONS, ownJsonBody, withHeader } from "./signin.ts";
import { parseUsername } from "./usernames.ts";

/** An invite's link works for 7 days. */
export const INVITE_MS = 7 * 86_400_000;
/** How long a row whose time ran out stays, listed as expired, before a sweep removes it. */
export const INVITE_KEPT_MS = 30 * 86_400_000;
/** The most open (unexpired) invites the site holds at once; also the most rows the admin's list shows, open ones first. */
export const MAX_INVITES = 100;
/** The most rows one sweep removes. */
export const INVITE_SWEEP_PAGE = 50;
/** How often a send is tried when another send or a cancel of the same address lands between its read and its write. */
const SEND_TRIES = 3;

/** The form of an invite code. */
export const INVITE_CODE_PATTERN = /^dpi_[0-9a-f]{40}$/;
const INVITE_ID = /^inv_[0-9a-f]{24}$/;

/** The longest body the admin's send reads: an address is at most 254 characters. */
const MAX_ADMIN_BODY_BYTES = 1024;

/** The sentences the routes answer with, for the pages to show as they are. Fixed text: never a code, an address or a name. */
export const INVITE_SAYS = {
  mailOff: "This site cannot send mail, so nobody can be invited here.",
  hasAccount: "That address already has an account.",
  tooMany: `There are ${MAX_INVITES} open invites already. Cancel one that is no longer needed, then try again.`,
  rateLimited: "Too many invites. Wait a while and try again.",
  mailFailed: "The invite is saved, but its mail could not be sent. Resend it to try again.",
  invalid: "This invite no longer works. Ask the person who invited you to send it again.",
  badUsername: "Use 3 to 30 lowercase letters, digits and hyphens, starting with a letter.",
  reservedUsername: "That username cannot be chosen. Try another.",
  usernameTaken: "That username is taken. Try another.",
  acceptHasAccount: "This address already has an account. Sign in instead.",
  signedIn: "You are signed in. Sign out first, then open the invite link again.",
  credentials: "send no token with this request",
  personRateLimited: "Too many tries. Wait a few minutes and try again.",
} as const;

/** The fixed log line of a mail that failed, but for the mail client's own word for why. */
export const INVITE_MAIL_FAILED = "mail: an invite mail could not be sent";

const NEEDS_EMAIL = 'the body must be JSON such as {"email": "name@example.com"}, with nothing else in it';
const NEEDS_CODE = 'the body must be JSON such as {"code": "…"}';
const NEEDS_ACCEPT = 'the body must be JSON such as {"code": "…", "username": "mara"}';

/** One invite as the admin's routes answer it. */
export type InviteEntry = { id: string; email: string; created_at: number; expires_at: number; state: "open" | "expired" };

/** What an admin route answers to everyone who is not a signed-in admin, and to an invite id that names no invite. */
function notFound(): Response {
  return json(404, { error: "not_found" });
}

/** The one answer for every code that cannot be used. */
function invalid(): Response {
  return apiError(404, "invite_invalid", INVITE_SAYS.invalid);
}

function tooMany(retryAfterSeconds: number, detail: string): Response {
  return withHeader(apiError(429, "rate_limited", detail), "retry-after", String(retryAfterSeconds));
}

function entryOf(row: { id: string; email: string; created_at: number; expires_at: number }, now: number): InviteEntry {
  return { id: row.id, email: row.email, created_at: row.created_at, expires_at: row.expires_at, state: row.expires_at > now ? "open" : "expired" };
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
 * Removes invites whose time ran out more than INVITE_KEPT_MS ago, the oldest first, at most
 * INVITE_SWEEP_PAGE of them: one bounded delete. Never rejects, since a row left for the next
 * sweep is no reason to fail the request this rides on.
 */
export async function sweepInvites(deps: Deps): Promise<void> {
  try {
    await deps.db.run("DELETE FROM invite WHERE id IN (SELECT id FROM invite WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)", [deps.now() - INVITE_KEPT_MS, INVITE_SWEEP_PAGE]);
  } catch {
    // Left for the next sweep.
  }
}

/** The admin's send body: a JSON object holding `email` and nothing else. The address as parseEmail stores it, or the refusal. */
async function emailBody(req: Request): Promise<string | Response> {
  const raw = await readCapped(req, MAX_ADMIN_BODY_BYTES);
  if (raw === "too_large") return apiError(400, "bad_request", NEEDS_EMAIL);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return apiError(400, "bad_request", NEEDS_EMAIL);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "email")) return apiError(400, "bad_request", NEEDS_EMAIL);
  const email = parseEmail((body as Record<string, unknown>).email);
  return email === null ? json(400, { error: "bad_email" }) : email;
}

/**
 * A new code for an invite and the mail that carries it, once the row holding its digest has
 * been written. Answers the entry with `status`, or 502 `mail_failed` when the mail could not
 * be handed over; the invite stays either way.
 */
async function mailInvite(deps: Deps, to: string, inviter: string | null, code: string, entry: InviteEntry, status: number): Promise<Response> {
  // canMailLinks said there is an address for links; it comes from the settings alone.
  const origin = linkOrigin(deps.config) ?? "";
  try {
    await mailOf(deps).send(inviteMail(to, inviter, inviteLink(origin, code), entry.expires_at));
  } catch (err) {
    console.error(`${INVITE_MAIL_FAILED} (${reasonOf(err)})`);
    return apiError(502, "mail_failed", INVITE_SAYS.mailFailed);
  }
  return json(status, entry);
}

/**
 * What stands in front of the person's two requests, from the request alone and then one
 * count: the origin rule and the JSON body of signing in, no token, the network's count, and
 * no live session. Answers the body, or the refusal.
 */
async function personRequest(req: Request, deps: Deps, needs: string): Promise<Record<string, unknown> | Response> {
  const body = await ownJsonBody(req, deps, needs);
  if (body instanceof Response) return body;
  if (req.headers.get("authorization") !== null) return apiError(400, "credentials_not_allowed", INVITE_SAYS.credentials);
  const key = await networkKey(clientAddressOf(req));
  const counted = key === null ? await hitLimit(deps, LIMITS_INVITE.codeUnknownNetwork, SITE_KEY) : await hitLimit(deps, LIMITS_INVITE.codeNetwork, key);
  if (counted.over) return tooMany(counted.retryAfterSeconds, INVITE_SAYS.personRateLimited);
  // Signed in to any account: refused, whatever the code. A cookie that names no live
  // session is no session.
  if (sessionCookiePresent(req) && (await resolveSession(req, deps)) !== null) return apiError(409, "signed_in", INVITE_SAYS.signedIn);
  return body;
}

export function inviteRoutes(app: Hono, deps: Deps): void {
  /**
   * Invites an address: `{"email": "…"}`. Answers 201 the invite. An address that has an open
   * or expired invite gets a new code in that same invite, so the older link stops working.
   * Refused: mail off (409 `mail_off`, nothing counted), a malformed address (400 `bad_email`),
   * the admin's count (429), an address with an account (409 `has_account`), the site's
   * MAX_INVITES (409 `too_many_invites`), and the site's invite mail cap (429). None of them
   * stores anything.
   */
  app.post("/api/v1/admin/invites", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { admin: true });
    if (auth instanceof Response) return auth;
    // requireAuth with admin passes only a session; without one there is nobody to record.
    if (auth.session === undefined) return notFound();
    const adminId = auth.session.userId;
    if (!canMailLinks(deps)) return apiError(409, "mail_off", INVITE_SAYS.mailOff);
    const email = await emailBody(req);
    if (email instanceof Response) return email;

    const sends = await hitLimit(deps, LIMITS_INVITE.sendAdmin, await accountKey(adminId));
    if (sends.over) return tooMany(sends.retryAfterSeconds, INVITE_SAYS.rateLimited);
    await sweepInvites(deps);

    let capCounted = false;
    for (let attempt = 1; ; attempt++) {
      const site = await deps.db.first<{ account: string | null; invite: string | null; still_open: number | null; n: number; me: string | null }>(
        `SELECT (SELECT id FROM user WHERE email = ?) AS account,
                (SELECT id FROM invite WHERE email = ?) AS invite,
                (SELECT expires_at > ? FROM invite WHERE email = ?) AS still_open,
                (SELECT count(*) FROM invite WHERE expires_at > ?) AS n,
                (SELECT username FROM user WHERE id = ?) AS me`,
        [email, email, deps.now(), email, deps.now(), adminId],
      );
      if (site === null) throw new Error("invites: the site could not be read");
      if (site.account !== null) return apiError(409, "has_account", INVITE_SAYS.hasAccount);
      // A send that would add an open invite (a new one, or one that ran out made new) must fit.
      if (site.still_open !== 1 && site.n >= MAX_INVITES) return apiError(409, "too_many_invites", INVITE_SAYS.tooMany);
      if (!capCounted) {
        // The site's invite mail cap counts only a mail that is about to be sent.
        const cap = await hitLimit(deps, LIMITS_INVITE.mailSite, SITE_KEY);
        if (cap.over) return tooMany(cap.retryAfterSeconds, INVITE_SAYS.rateLimited);
        capCounted = true;
      }

      const id = site.invite ?? newId("inv");
      const code = "dpi_" + randomHex(20);
      const hash = await hashToken(code);
      const now = deps.now();
      const expiresAt = now + INVITE_MS;
      try {
        await deps.db.batch([
          {
            // Replaces the address's invite only while it is still the one just read (and, when
            // it ran out, only while the site is under its cap of open invites), and adds one
            // only while the address has none and the site is under that cap. Anything else
            // changes no row, and the audit row after it then undoes the batch.
            sql: `INSERT INTO invite (id, email, code_hash, invited_by, created_at, expires_at)
                  SELECT ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (SELECT 1 FROM invite WHERE email = ? AND id = ? AND (expires_at > ? OR (SELECT count(*) FROM invite WHERE expires_at > ?) < ?))
                      OR (NOT EXISTS (SELECT 1 FROM invite WHERE email = ?) AND (SELECT count(*) FROM invite WHERE expires_at > ?) < ?)
                  ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, invited_by = excluded.invited_by, created_at = excluded.created_at, expires_at = excluded.expires_at
                   WHERE invite.id = excluded.id`,
            params: [id, email, hash, adminId, now, expiresAt, email, id, now, now, MAX_INVITES, email, now, MAX_INVITES],
          },
          auditStatement(deps, { event: "invite_sent", userId: adminId, workspaceId: auth.workspaceId, subject: id, detail: { replaced: site.invite === null ? 0 : 1 } }, { onlyAfterOneChange: true }),
        ]);
      } catch (err) {
        // Another send or a cancel of this address, or another new invite that filled the
        // cap, landed since the read: read again and decide anew.
        if (!isNotNullViolation(err) || attempt >= SEND_TRIES) throw err;
        continue;
      }
      return mailInvite(deps, email, site.me, code, entryOf({ id, email, created_at: now, expires_at: expiresAt }, now), 201);
    }
  });

  /**
   * The site's invites that are open or ran out, newest first, at most MAX_INVITES: every open
   * one (there are at most that many, and each is newer than any that ran out), then as many
   * that ran out as fit. Accepted and cancelled invites are gone. Sweeps first. It needs no mail.
   */
  app.get("/api/v1/admin/invites", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    await sweepInvites(deps);
    const now = deps.now();
    const rows = await deps.db.all<{ id: string; email: string; created_at: number; expires_at: number }>(
      "SELECT id, email, created_at, expires_at FROM invite ORDER BY created_at DESC, id DESC LIMIT ?",
      [MAX_INVITES],
    );
    return json(200, { invites: rows.map((r) => entryOf(r, now)) });
  });

  /**
   * Sends the invite again with a new code, for 7 days from now, from the admin who asks; the
   * older link stops working at once. Answers 200 the refreshed invite. Refused as a send is,
   * and an id that names no invite is the admin routes' one 404.
   */
  app.post("/api/v1/admin/invites/:id/resend", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { admin: true });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return notFound();
    const adminId = auth.session.userId;
    const id = c.req.param("id");
    if (!INVITE_ID.test(id)) return notFound();
    if (!canMailLinks(deps)) return apiError(409, "mail_off", INVITE_SAYS.mailOff);

    const sends = await hitLimit(deps, LIMITS_INVITE.sendAdmin, await accountKey(adminId));
    if (sends.over) return tooMany(sends.retryAfterSeconds, INVITE_SAYS.rateLimited);
    const found = await deps.db.first<{ email: string; account: string | null; me: string | null; still_open: number; n: number }>(
      `SELECT i.email, (SELECT u.id FROM user u WHERE u.email = i.email) AS account, (SELECT username FROM user WHERE id = ?) AS me,
              i.expires_at > ? AS still_open, (SELECT count(*) FROM invite WHERE expires_at > ?) AS n
         FROM invite i WHERE i.id = ?`,
      [adminId, deps.now(), deps.now(), id],
    );
    if (found === null) return notFound();
    if (found.account !== null) return apiError(409, "has_account", INVITE_SAYS.hasAccount);
    // Resending one that ran out opens it again, so it must fit under the cap of open invites.
    if (found.still_open !== 1 && found.n >= MAX_INVITES) return apiError(409, "too_many_invites", INVITE_SAYS.tooMany);
    const cap = await hitLimit(deps, LIMITS_INVITE.mailSite, SITE_KEY);
    if (cap.over) return tooMany(cap.retryAfterSeconds, INVITE_SAYS.rateLimited);

    const code = "dpi_" + randomHex(20);
    const hash = await hashToken(code);
    const now = deps.now();
    const expiresAt = now + INVITE_MS;
    try {
      await deps.db.batch([
        {
          sql: "UPDATE invite SET code_hash = ?, invited_by = ?, created_at = ?, expires_at = ? WHERE id = ? AND (expires_at > ? OR (SELECT count(*) FROM invite WHERE expires_at > ?) < ?)",
          params: [hash, adminId, now, expiresAt, id, now, now, MAX_INVITES],
        },
        // Unless that changed the one row (it was cancelled or accepted since the read, or the
        // cap filled up meanwhile), this fails and the whole batch is undone.
        auditStatement(deps, { event: "invite_resent", userId: adminId, workspaceId: auth.workspaceId, subject: id }, { onlyAfterOneChange: true }),
      ]);
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      const still = await deps.db.first("SELECT 1 AS x FROM invite WHERE id = ?", [id]);
      return still === null ? notFound() : apiError(409, "too_many_invites", INVITE_SAYS.tooMany);
    }
    return mailInvite(deps, found.email, found.me, code, entryOf({ id, email: found.email, created_at: now, expires_at: expiresAt }, now), 200);
  });

  /** Cancels an invite: its link stops working at once. 204; an id that names no invite is the one 404. It needs no mail. */
  app.delete("/api/v1/admin/invites/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return notFound();
    const id = c.req.param("id");
    if (!INVITE_ID.test(id)) return notFound();
    try {
      await deps.db.batch([
        { sql: "DELETE FROM invite WHERE id = ?", params: [id] },
        auditStatement(deps, { event: "invite_cancelled", userId: auth.session.userId, workspaceId: auth.workspaceId, subject: id }, { onlyAfterOneChange: true }),
      ]);
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      return notFound();
    }
    return noContent();
  });

  /**
   * What the person's page shows before the account is made: the invited address, the
   * inviter's username (null when the inviter has none or is gone) and when the link stops
   * working. Changes nothing, so a mail scanner that opens the link uses nothing up.
   */
  app.post("/api/v1/invite/check", async (c) => {
    const req = c.req.raw;
    const body = await personRequest(req, deps, NEEDS_CODE);
    if (body instanceof Response) return body;
    const code = body.code;
    if (typeof code !== "string" || !INVITE_CODE_PATTERN.test(code)) return invalid();
    const found = await deps.db.first<{ email: string; expires_at: number; invited_by: string | null }>(
      "SELECT i.email, i.expires_at, u.username AS invited_by FROM invite i LEFT JOIN user u ON u.id = i.invited_by WHERE i.code_hash = ? AND i.expires_at > ?",
      [await hashToken(code), deps.now()],
    );
    if (found === null) return invalid();
    return json(200, { email: found.email, invited_by: found.invited_by, expires_at: found.expires_at });
  });

  /**
   * Accepts an invite with the username the person chose: makes the account, its workspace
   * and a session, and sets the session cookie, as completing a sign-in does, so the page can
   * go straight on. See the top of this file for the batch.
   */
  app.post("/api/v1/invite/accept", async (c) => {
    const req = c.req.raw;
    const body = await personRequest(req, deps, NEEDS_ACCEPT);
    if (body instanceof Response) return body;
    // A dead code first, whatever the username: the one invite_invalid.
    const code = body.code;
    if (typeof code !== "string" || !INVITE_CODE_PATTERN.test(code)) return invalid();
    const name = parseUsername(body.username);

    const hash = await hashToken(code);
    const now = deps.now();
    // The same one read for any username; a name that cannot be stored is looked up as null, which no account has.
    const found = await deps.db.first<{ id: string; email: string; account: number | null; taken: number | null }>(
      `SELECT i.id, i.email, (SELECT 1 FROM user u WHERE u.email = i.email) AS account, (SELECT 1 FROM user t WHERE t.username = ?) AS taken
         FROM invite i WHERE i.code_hash = ? AND i.expires_at > ?`,
      [name.ok ? name.username : null, hash, now],
    );
    if (found === null) return invalid();
    if (found.account !== null) return apiError(409, "has_account", INVITE_SAYS.acceptHasAccount);
    if (!name.ok) return name.problem === "reserved" ? apiError(400, "reserved_username", INVITE_SAYS.reservedUsername) : apiError(400, "bad_username", INVITE_SAYS.badUsername);
    const username = name.username;
    if (found.taken !== null) return apiError(409, "username_taken", INVITE_SAYS.usernameTaken);

    const workspaceId = newId("ws");
    const userId = newId("usr");
    const sessionId = newId("ses");
    const secret = "dps_" + randomHex(32);
    try {
      await deps.db.batch([
        // The invite is used only while it is still there under this code and unexpired.
        { sql: "DELETE FROM invite WHERE code_hash = ? AND expires_at > ?", params: [hash, now] },
        // Right after it: unless exactly that one row went, this fails and undoes the batch.
        auditStatement(deps, { event: "invite_accepted", userId, workspaceId, subject: found.id }, { onlyAfterOneChange: true }),
        // No allowance of its own (null): the workspace follows the site's standard.
        { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", params: [workspaceId, username, now] },
        {
          sql: "INSERT INTO user (id, workspace_id, email, created_at, username, status, is_admin) VALUES (?, ?, ?, ?, ?, 'active', 0)",
          params: [userId, workspaceId, found.email, now, username],
        },
        { sql: "INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", params: [workspaceId, userId, now] },
        { sql: "INSERT INTO signin_method (user_id, kind, created_at) VALUES (?, 'email_link', ?)", params: [userId, now] },
        {
          sql: "INSERT INTO session (id, user_id, hash, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          params: [sessionId, userId, await hashToken(secret), sessionLabel(req.headers.get("user-agent")), now, now, firstEnd(deps, now)],
        },
        auditStatement(deps, { event: "signin", userId, workspaceId, subject: sessionId }),
      ]);
    } catch (err) {
      // The invite was used, cancelled, replaced or ran out since the read.
      if (isNotNullViolation(err)) return invalid();
      if (!isUniqueViolation(err)) throw err;
      // The address or the username was taken since the read: read again to say which.
      const now2 = await deps.db.first<{ account: number | null; taken: number | null }>(
        "SELECT (SELECT 1 FROM user WHERE email = ?) AS account, (SELECT 1 FROM user WHERE username = ?) AS taken",
        [found.email, username],
      );
      if (now2?.account != null) return apiError(409, "has_account", INVITE_SAYS.acceptHasAccount);
      if (now2?.taken != null) return apiError(409, "username_taken", INVITE_SAYS.usernameTaken);
      throw err;
    }
    return withHeader(json(200, { ok: true }), "set-cookie", sessionCookie(secret));
  });
}
