// Viewers: how a visitor proves an email address on the tours address, so that a tour shared
// with a list of addresses can be shown to them. No platform API and no web framework but
// the route table.
//
// A viewer session says one thing: "this browser proved it can read mail at this address".
// It is not an account. It has no user row, no workspace, no dashboard and no API: nothing but
// the routes here and `provedEmail`, which the tour pages call, ever reads its cookie.
//
// Two secrets are made here, both from the platform's cryptographic random source, each with
// a prefix of its own so neither is ever taken for a token ("dp_"), a sign-in code ("dpl_"),
// a session secret ("dps_") or any other code:
// - a viewer code, "dpv_" and 40 hex characters (160 random bits), mailed in the fragment of
//   `<tours origin>/view#<code>`; it works once and for VIEWER_CODE_MS, and is bound to the
//   address it was mailed to and the tour slug it was asked for (where the browser lands);
// - a viewer secret, "dpw_" and 64 hex characters (256 random bits), the value of the viewer
//   cookie. The session it names is for no one tour: each tour page asks whether its list
//   holds the proved address.
// Neither is ever stored, logged, put in an error or in the audit record: the database holds
// the SHA-256 hex digest of each (migration 0015).
//
// The viewer cookie, VIEWER_COOKIE, is a cookie of its own beside the account's session
// cookie (src/sessions.ts): another name, set and read only on the tours address (on a site
// with one address, on that address, where the two live side by side and are told apart by
// their whole name). `requireAuth` reads only the account's cookie, so a viewer cookie is
// never a credential of the API or the dashboard, and an account's cookie is never a viewer.
// A request that carries a token (an Authorization header) and the viewer cookie proves
// nothing: `provedEmail` answers null, so a restricted tour stays closed (it fails closed),
// and the viewer routes refuse any request with a token.
//
// The routes, all on the tours address (rule `tours`), JSON in and out:
// - POST /api/v1/view/request {email, slug}: always 202 {"ok":true} for a JSON object from a
//   page of this address, after the same database calls in the same order, whatever the tour
//   or the address; a link is mailed only when the gate (below) says the address may view the
//   tour, mail is on, and every limit allows. The address is never mailed more than its own
//   limits (LIMITS_VIEWER) allow, however many tours or networks ask.
// - POST /api/v1/view/check {code}: 200 {email, slug} for a live code; the one 404
//   `view_link_invalid` for a used, expired, unknown or malformed one. Changes nothing, so a
//   mail scanner that opens the link uses nothing up.
// - POST /api/v1/view/complete {code}: 200 {slug} and a viewer cookie with a new session;
//   the cookie the browser had is replaced and its session ends, never merged. The one 404
//   otherwise. Of two completions of one code exactly one wins.
// - POST /api/v1/view/signout: ends the session of the viewer cookie (its row is removed) and
//   clears the cookie; 204. Without a viewer cookie it answers 204 and sets nothing.
// - GET /api/v1/view/session: 200 {email} for a live viewer session, else 401.
// The three POSTs that carry a body, and sign-out, must come from a page of this address
// (`sameOriginChange`), and the three with a body must carry `application/json`, which no
// form of another site can send: so another site can neither complete a code into a visitor's
// browser (viewer login forgery) nor sign it out.
//
// The gate. Whether an address may view a tour is the tour's own setting, which this module
// does not hold: ViewerGate is the one question it asks, through the one registered gate
// (`useViewerGate`). Until a real one is registered every answer is no, so no viewer mail is
// ever sent.
//
// Disabling or deleting an account does not end viewer sessions or codes for the same
// address: they are not the account's. A viewer session only ever shows tours whose own list
// holds the address, which their owners decide.
//
// Two scopes. Everything above is the tours scope (TOUR_VIEWERS). Shared items (images and
// clips, src/media-access.ts) have a scope of their own, MEDIA_VIEWERS, built by the same
// code with its own names throughout:
// - its own cookie, MEDIA_VIEWER_COOKIE (`__Host-dp_media_viewer`), set and read only on the
//   media address (the img address when it is set, else the tours address; in one-address
//   mode the one address);
// - its own tables, media_viewer_code and media_viewer_session (migration 0016), and its own
//   prefixes: codes "dpi_", secrets "dpk_", ids "vcm_" and "vsm_";
// - its own routes under /api/v1/media-view/, the link page /s/view, and links
//   `<media origin>/s/view#<code>` in a mail that speaks of an image or clip;
// - a code names the page it was asked from, `/i/<link id>` or `/r/<link id>`, where the
//   browser lands, as a tour's code names a slug.
// Why two cookies and two tables, rather than one cookie or a scope column: when the tours
// and media addresses differ (three addresses), a host-only cookie cannot be shared anyway;
// when they are one host (one or two addresses), one cookie name for both would make proving
// an address for an item replace, and its sign-out end, the tour session in the same browser,
// and a session row found by its digest alone could serve either. With a cookie of its own and
// rows that the other scope's lookups never read, a session made by the tours gate can never
// open an item and one made by the media gate can never open a tour, in every address mode,
// and each kind of page still asks its own list (tour_viewer or media_viewer) on every
// request. The cost is that a person proves an address once for tours and once for images,
// which the plan accepts. The mail limits are not scoped: both gates count under the same
// buckets and keys (LIMITS_VIEWER: one address, one network, one workspace, the site), so
// the two together cannot send more viewer mail than one could.
import type { Hono } from "hono";
import { parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { hashToken, newId } from "./auth.ts";
import { mediaRole, onRole, type HostRole, type Hosts } from "./hosts.ts";
import { apiError, json, noContent } from "./http.ts";
import { NO_MAIL, mediaViewerLink, mediaViewerLinkOrigin, mediaViewerMail, viewerLink, viewerLinkOrigin, viewerMail, type Mail } from "./mail.ts";
import type { Config } from "./ports.ts";
import { deferOf, isNotNullViolation, mailOf, type Deps } from "./ports.ts";
import { LIMITS_VIEWER, SITE_KEY, SITE_QUIET_KEY, hitLimit, recipientKey, sweepCounters, viewerPairKey, viewerWorkspaceKey } from "./rate.ts";
import { SWEEP_PAGE, cookieValues, sameOriginChange } from "./sessions.ts";
import { MAIL_REASONS, afterTheAnswer, networkLimit, ownJsonBody, padStatement, withHeader } from "./signin.ts";

/** The viewer cookie's name: not the account session's. `__Host-` makes browsers take it only Secure, with the path / and no Domain, from this one host. */
export const VIEWER_COOKIE = "__Host-dp_viewer";
/** The media scope's viewer cookie: neither the account session's nor the tours scope's. */
export const MEDIA_VIEWER_COOKIE = "__Host-dp_media_viewer";

/**
 * The roles whose address takes the viewer cookie: the tours address alone, where tours are
 * shown. The app address holds accounts and the img address shared media; neither reads it,
 * nor does a role added later until it is listed here. In one-address mode the one address
 * takes it. Compare SESSION_ROLES (src/sessions.ts) and CREDENTIAL_ROLES (src/auth.ts): a
 * viewer cookie is neither of those credentials. (The media scope's cookie belongs to the
 * media address alone: mediaRole in src/hosts.ts.)
 */
export const VIEWER_ROLES: readonly HostRole[] = ["tours"];

/** A viewer code works for 15 minutes. */
export const VIEWER_CODE_MS = 900_000;
/** A viewer session ends 30 days after its last use. */
export const VIEWER_IDLE_MS = 2_592_000_000;
/** ... and never later than 180 days after it was made (migrations 0015 and 0016 hold the same cap). */
export const VIEWER_MAX_MS = 15_552_000_000;
/** A session's last use and its end are written at most once in this long: once a day. */
export const VIEWER_TOUCH_MS = 86_400_000;
/** How long a code's row is kept after it ran out, before a sweep removes it. */
export const VIEWER_CODE_KEPT_MS = 86_400_000;

/** How long a browser keeps the cookie, in seconds: the session's longest life. Its real end is in the database. */
const COOKIE_MAX_AGE_S = VIEWER_MAX_MS / 1000;

/** The form of a viewer code. */
export const VIEWER_CODE_PATTERN = /^dpv_[0-9a-f]{40}$/;
/** The form of a viewer secret, the cookie's value. */
export const VIEWER_SECRET_PATTERN = /^dpw_[0-9a-f]{64}$/;
/** The media scope's code and secret. */
export const MEDIA_VIEWER_CODE_PATTERN = /^dpi_[0-9a-f]{40}$/;
export const MEDIA_VIEWER_SECRET_PATTERN = /^dpk_[0-9a-f]{64}$/;
/** A slug as newSlug makes it; anything else is asked about as "", which no tour has. */
const SLUG = /^[a-z2-7]{10}$/;
/** An item's page, /i/<link id> or /r/<link id>; anything else is asked about as "", which no item has. */
export const ITEM_PAGE = /^\/[ir]\/[a-z2-7]{20}$/;

/** The sentences the routes answer with. Fixed text: never a code, an address or a slug. */
export const VIEWER_SAYS = {
  invalid: "this link no longer works; open the tour's own link again and ask for a new one",
  credentials: "send no token with this request",
  badOrigin: "this request must come from the site's own pages",
} as const;
/** The one sentence the media scope says otherwise (proposed). */
export const MEDIA_VIEWER_SAYS = {
  invalid: "this link no longer works; open the link you were sent for the image or clip again and ask for a new one",
} as const;

/** The fixed log lines of asking for a viewer link. None holds an address, a slug, a code or a count. */
export const VIEWER_LINES = {
  recipient: "viewer: an address asked for more viewer links than its limit; none was sent",
  hour: "viewer: an hourly limit of viewer mails was reached; none was sent",
  notMade: "viewer: a viewer link could not be made; none was sent",
  mailFailed: "mail: a viewer mail could not be sent",
} as const;

// ---- The gate ----

/**
 * The one question this module asks about a tour (in the media scope, about an item, whose
 * target is its page's path). `mayRequest` allows only when `slug` names a published tour of a
 * workspace with no disabled account, that tour is restricted to a list of addresses, and
 * `email` may view it. A yes carries `workspaceKey`, an opaque key for the tour's workspace
 * that the gate derives (a digest of the workspace id, say): this module never sees a
 * workspace id, and counts the workspace's viewer mails under it. Both scopes' gates give the
 * same key for the same workspace (workspaceKeyOf in src/restricted.ts), so its viewer mails
 * are counted once. It is asked for every request that reaches that point, with "" for a slug
 * or an address that is malformed (a yes is then never right), and must make the same database
 * calls whatever it answers, so the request's answer cannot be timed.
 */
export type ViewerGate = {
  mayRequest(deps: Deps, slug: string, email: string): Promise<{ allowed: false } | { allowed: true; workspaceKey: string }>;
};

/** The gate before any is registered: no address may ask for any tour, and it asks the database nothing. */
export const NO_VIEWER_GATE: ViewerGate = { mayRequest: async () => ({ allowed: false }) };

const gates: Record<"tour" | "media", ViewerGate> = { tour: NO_VIEWER_GATE, media: NO_VIEWER_GATE };

/** Registers the gate every later request asks; null puts back NO_VIEWER_GATE. The one place a gate is set. */
export function useViewerGate(next: ViewerGate | null): void {
  gates.tour = next ?? NO_VIEWER_GATE;
}

/** The same for the media scope's gate (src/media-access.ts registers it). */
export function useMediaViewerGate(next: ViewerGate | null): void {
  gates.media = next ?? NO_VIEWER_GATE;
}

// ---- The scopes ----

/** Everything that differs between proving an address for tours and for shared items. */
export type ViewerScope = {
  name: "tour" | "media";
  cookie: string;
  /** The roles whose address takes the cookie, for the configured addresses. */
  roles: (hosts: Hosts) => readonly HostRole[];
  sessionTable: "viewer_session" | "media_viewer_session";
  codeTable: "viewer_code" | "media_viewer_code";
  sessionId: "vse" | "vsm";
  codeId: "vco" | "vcm";
  codePrefix: "dpv_" | "dpi_";
  secretPrefix: "dpw_" | "dpk_";
  codePattern: RegExp;
  secretPattern: RegExp;
  /** Where a code lands: its column and request field (the same name), and the shape of one. */
  target: "slug" | "path";
  targetPattern: RegExp;
  /** The prefix of the scope's API routes. */
  api: string;
  needsRequest: string;
  invalid: string;
  linkOrigin: (config: Config) => string | null;
  link: (origin: string, code: string) => string;
  mail: (to: string, link: string) => Mail;
};

export const TOUR_VIEWERS: ViewerScope = {
  name: "tour",
  cookie: VIEWER_COOKIE,
  roles: () => VIEWER_ROLES,
  sessionTable: "viewer_session",
  codeTable: "viewer_code",
  sessionId: "vse",
  codeId: "vco",
  codePrefix: "dpv_",
  secretPrefix: "dpw_",
  codePattern: VIEWER_CODE_PATTERN,
  secretPattern: VIEWER_SECRET_PATTERN,
  target: "slug",
  targetPattern: SLUG,
  api: "/api/v1/view",
  needsRequest: 'the body must be JSON such as {"email": "name@example.com", "slug": "…"}',
  invalid: VIEWER_SAYS.invalid,
  linkOrigin: viewerLinkOrigin,
  link: viewerLink,
  mail: (to, link) => viewerMail(to, link),
};

export const MEDIA_VIEWERS: ViewerScope = {
  name: "media",
  cookie: MEDIA_VIEWER_COOKIE,
  roles: (hosts) => [mediaRole(hosts)],
  sessionTable: "media_viewer_session",
  codeTable: "media_viewer_code",
  sessionId: "vsm",
  codeId: "vcm",
  codePrefix: "dpi_",
  secretPrefix: "dpk_",
  codePattern: MEDIA_VIEWER_CODE_PATTERN,
  secretPattern: MEDIA_VIEWER_SECRET_PATTERN,
  target: "path",
  targetPattern: ITEM_PAGE,
  api: "/api/v1/media-view",
  needsRequest: 'the body must be JSON such as {"email": "name@example.com", "path": "/i/…"}',
  invalid: MEDIA_VIEWER_SAYS.invalid,
  linkOrigin: mediaViewerLinkOrigin,
  link: mediaViewerLink,
  mail: (to, link) => mediaViewerMail(to, link),
};

const NEEDS_CODE = 'the body must be JSON such as {"code": "…"}';

// ---- The cookie ----

/** True when the scope's cookie may be used on the address this request was sent to: always in one-address mode, else only on an address of its roles. */
function onScopeHost(scope: ViewerScope, req: Request, deps: Deps): boolean {
  const hosts = deps.config.hosts ?? null;
  return onRole(hosts, req, hosts === null ? [] : scope.roles(hosts));
}

/** True when the viewer cookie may be used on the address this request was sent to: always in one-address mode, else only on an address of VIEWER_ROLES. */
export function viewerHost(req: Request, deps: Deps): boolean {
  return onScopeHost(TOUR_VIEWERS, req, deps);
}

/** The same for the media scope's cookie: the media address. */
export function mediaViewerHost(req: Request, deps: Deps): boolean {
  return onScopeHost(MEDIA_VIEWERS, req, deps);
}

/**
 * The Set-Cookie value that gives a browser a viewer session: host-only (no Domain), for every
 * path, over HTTPS only, hidden from scripts, not sent with another site's requests except a
 * top-level navigation, and kept as long as a session can live. Throws for anything that is
 * not a viewer secret of the scope, so nothing else can reach the header.
 */
function scopeCookie(scope: ViewerScope, secret: string): string {
  if (typeof secret !== "string" || !scope.secretPattern.test(secret)) throw new Error("not a viewer secret");
  return `${scope.cookie}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
}

/** The tours scope's cookie for a secret (scopeCookie). */
export function viewerCookie(secret: string): string {
  return scopeCookie(TOUR_VIEWERS, secret);
}

/** The media scope's cookie for a secret (scopeCookie). */
export function mediaViewerCookie(secret: string): string {
  return scopeCookie(MEDIA_VIEWERS, secret);
}

/** The Set-Cookie value that removes a scope's cookie at once: the same name and attributes, no value, and an end in the past. */
function clearedScopeCookie(scope: ViewerScope): string {
  return `${scope.cookie}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function clearedViewerCookie(): string {
  return clearedScopeCookie(TOUR_VIEWERS);
}

export function clearedMediaViewerCookie(): string {
  return clearedScopeCookie(MEDIA_VIEWERS);
}

/** The viewer secret the request's cookie of the scope holds, or null unless there is exactly one cookie of that name and it is well formed. */
function readScopeCookie(scope: ViewerScope, req: Request): string | null {
  const values = cookieValues(req, scope.cookie);
  return values.length === 1 && scope.secretPattern.test(values[0]) ? values[0] : null;
}

/**
 * The address the request's viewer cookie of the scope proved, or null: for an address that
 * does not take the cookie, no viewer cookie, a request that also carries a token (two
 * credentials: neither counts, so a restricted tour stays closed), two viewer cookies, a
 * malformed one, and a session that is unknown, signed out or over. The account's session
 * cookie and the other scope's cookie play no part, and the session is looked up in the
 * scope's own table alone.
 *
 * No database call without a viewer cookie; one read with one. When the session's last use was
 * written a day ago or longer, it is written again (and its end moved to 30 days from now, never
 * past 180 days after it was made) by one more statement handed to `deps.defer`, which runs
 * after the answer: at most once a day per session, so the hottest public routes write almost
 * never.
 */
async function scopeEmail(scope: ViewerScope, req: Request, deps: Deps): Promise<string | null> {
  if (!onScopeHost(scope, req, deps)) return null;
  const values = cookieValues(req, scope.cookie);
  if (values.length === 0) return null;
  if (req.headers.get("authorization") !== null) return null;
  if (values.length !== 1 || !scope.secretPattern.test(values[0])) return null;
  const now = deps.now();
  const row = await deps.db.first<{ id: string; email: string; last_used_at: number }>(
    `SELECT id, email, last_used_at FROM ${scope.sessionTable} WHERE hash = ? AND expires_at > ?`,
    [await hashToken(values[0]), now],
  );
  if (row === null) return null;
  if (now - row.last_used_at >= VIEWER_TOUCH_MS) {
    // Started only once the current task is over, so the answer never waits for it.
    deferOf(deps)(
      afterTheAnswer().then(() =>
        deps.db.run(`UPDATE ${scope.sessionTable} SET last_used_at = ?, expires_at = min(?, created_at + ?) WHERE id = ? AND expires_at > ? AND last_used_at <= ?`, [
          now,
          now + VIEWER_IDLE_MS,
          VIEWER_MAX_MS,
          row.id,
          now,
          now - VIEWER_TOUCH_MS,
        ]),
      ),
    );
  }
  return row.email;
}

/** The address the tours viewer cookie proved (scopeEmail). The tour pages call it. */
export function provedEmail(req: Request, deps: Deps): Promise<string | null> {
  return scopeEmail(TOUR_VIEWERS, req, deps);
}

/** The address the media viewer cookie proved (scopeEmail). A restricted item's routes call it. */
export function provedMediaEmail(req: Request, deps: Deps): Promise<string | null> {
  return scopeEmail(MEDIA_VIEWERS, req, deps);
}

// ---- Housekeeping ----

/**
 * Removes rows of the scope nothing can use any more: sessions that are over, and codes that
 * ran out more than VIEWER_CODE_KEPT_MS ago. At most SWEEP_PAGE of each in one batch, so it can
 * ride on a request. Never rejects: a row left for the next sweep is no reason to fail a request.
 */
async function sweepScope(scope: ViewerScope, deps: Deps): Promise<void> {
  const now = deps.now();
  try {
    await deps.db.batch([
      { sql: `DELETE FROM ${scope.sessionTable} WHERE id IN (SELECT id FROM ${scope.sessionTable} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`, params: [now, SWEEP_PAGE] },
      { sql: `DELETE FROM ${scope.codeTable} WHERE id IN (SELECT id FROM ${scope.codeTable} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`, params: [now - VIEWER_CODE_KEPT_MS, SWEEP_PAGE] },
    ]);
  } catch {
    // Left for the next sweep.
  }
}

export function sweepViewers(deps: Deps): Promise<void> {
  return sweepScope(TOUR_VIEWERS, deps);
}

export function sweepMediaViewers(deps: Deps): Promise<void> {
  return sweepScope(MEDIA_VIEWERS, deps);
}

// ---- The routes ----

function randomHex(bytes: number): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += b.toString(16).padStart(2, "0");
  return s;
}

/** What the job after a link request does: write lines, and for an address that may get a link, make it and mail it. */
type LinkJob = { overRecipient: boolean; overHour: boolean; link: { to: string; target: string; origin: string } | null };

/**
 * The work of a link request that runs after the answer, in one job, the way sign-in's job
 * does it (src/signin.ts): one write and then one batch for every request, each changing one
 * row. With a link they store its code and the audit row and then send one mail; without one
 * they add twice to sign-in's pad counter, so a request that sends nothing costs the database
 * what one that sends does. Nothing is ever tried twice.
 */
async function linkJob(scope: ViewerScope, deps: Deps, job: LinkJob): Promise<void> {
  await afterTheAnswer();
  if (job.overRecipient) console.error(VIEWER_LINES.recipient);
  if (job.overHour) console.error(VIEWER_LINES.hour);
  if (job.link === null) {
    try {
      // Making a code waits once for its digest before the write; so does this.
      await crypto.subtle.digest("SHA-256", crypto.getRandomValues(new Uint8Array(24)));
      const pad = padStatement(deps);
      await deps.db.run(pad.sql, pad.params);
      await deps.db.batch([padStatement(deps)]);
    } catch {
      // A pad that could not be written changes nothing anyone asked for.
    }
    return;
  }
  const { to, target, origin } = job.link;
  let link: string;
  try {
    const code = scope.codePrefix + randomHex(20);
    const id = newId(scope.codeId);
    const now = deps.now();
    await deps.db.run(`INSERT INTO ${scope.codeTable} (id, email, ${scope.target}, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, to, target, await hashToken(code), now, now + VIEWER_CODE_MS]);
    await deps.db.batch([auditStatement(deps, { event: "viewer_link_sent", subject: id })]);
    link = scope.link(origin, code);
  } catch {
    console.error(VIEWER_LINES.notMade);
    return;
  }
  try {
    await mailOf(deps).send(scope.mail(to, link));
  } catch (err) {
    // Only a mail client's own fixed word is repeated: an error's text could hold the address.
    const reason = (err as { reason?: unknown } | null)?.reason;
    console.error(`${VIEWER_LINES.mailFailed} (${typeof reason === "string" && MAIL_REASONS.includes(reason) ? reason : "failed"})`);
  }
}

/** The body of a request from a page of the scope's address, and no token; or the refusal. */
async function viewerBody(scope: ViewerScope, req: Request, deps: Deps, needs: string): Promise<Record<string, unknown> | Response> {
  const body = await ownJsonBody(req, deps, needs, (r, d) => onScopeHost(scope, r, d));
  if (body instanceof Response) return body;
  if (req.headers.get("authorization") !== null) return apiError(400, "credentials_not_allowed", VIEWER_SAYS.credentials);
  return body;
}

/**
 * The routes of one scope, under its prefix (`/api/v1/view` for tours, `/api/v1/media-view`
 * for items). The media scope's request names its target as `path` (an item's page) where the
 * tours scope's names a `slug`, and its check and completion answer that `path`.
 */
function scopedViewerRoutes(app: Hono, deps: Deps, scope: ViewerScope): void {
  const invalid = () => apiError(404, "view_link_invalid", scope.invalid);
  const field = scope.target;

  /**
   * Asks for a viewer link: `{"email": "…", "slug": "…"}` (items: `"path"`). Every JSON object
   * from a page of this address answers 202 `{"ok":true}`, a malformed address or target
   * included.
   *
   * Before the answer, the same database calls for every such request, in this order: with a
   * known network its count; the address's two counts and the count for the address and the
   * target (under the address "" when it is malformed); the gate's question; the count of the
   * workspace's viewer mails and the site's backstop (each under the quiet key when nothing
   * will be sent); the two sweeps. Then one job for every request, which waits until the
   * answer is out (linkJob). Neither cap says to the requester that it was reached. Every count
   * is in the same bucket under the same key for both scopes, so they share each limit.
   */
  app.post(`${scope.api}/request`, async (c) => {
    const req = c.req.raw;
    const body = await viewerBody(scope, req, deps, scope.needsRequest);
    if (body instanceof Response) return body;
    const email = parseEmail(body.email);
    const given = body[field];
    const target = typeof given === "string" && scope.targetPattern.test(given) ? given : "";

    const limited = await networkLimit(req, deps, LIMITS_VIEWER.linkNetwork);
    if (limited !== null) return limited;

    // Every count is made for every request, whatever the one before it says.
    const recipient = await recipientKey(email ?? "");
    const quarter = await hitLimit(deps, LIMITS_VIEWER.linkRecipient, recipient);
    const day = await hitLimit(deps, LIMITS_VIEWER.linkRecipientDay, recipient);
    const pair = await hitLimit(deps, LIMITS_VIEWER.linkPair, await viewerPairKey(email ?? "", target));

    // The one question about the target, asked for every request. Nothing of the answer depends on it.
    const answer = await gates[scope.name].mayRequest(deps, target, email ?? "");
    const workspace = answer.allowed === true && typeof answer.workspaceKey === "string" && answer.workspaceKey !== "" ? answer.workspaceKey : null;
    // The digest is made for every request, so a yes costs no time a no does not.
    const workspaceCounter = await viewerWorkspaceKey(workspace ?? "none");
    // The link's address comes from the settings alone, never from this request.
    const origin = scope.linkOrigin(deps.config);
    const overRecipient = quarter.over || day.over || pair.over;
    const wanted = email !== null && target !== "" && workspace !== null && origin !== null && mailOf(deps) !== NO_MAIL && !overRecipient;

    // The caps count only a mail about to be sent; any other request makes the same calls under the quiet key.
    // The workspace's own cap first: a workspace's owner can fill no count but their own.
    const ownCap = await hitLimit(deps, LIMITS_VIEWER.mailWorkspace, wanted ? workspaceCounter : SITE_QUIET_KEY);
    const backstop = await hitLimit(deps, LIMITS_VIEWER.mailSite, wanted && !ownCap.over ? SITE_KEY : SITE_QUIET_KEY);
    const cap = { over: ownCap.over || backstop.over };

    await sweepScope(scope, deps);
    await sweepCounters(deps);

    const link = wanted && !cap.over && email !== null && origin !== null ? { to: email, target, origin } : null;
    deferOf(deps)(linkJob(scope, deps, { overRecipient, overHour: wanted && cap.over, link }));
    return json(202, { ok: true });
  });

  /**
   * What the page a viewer link opens shows before the button is pressed: the address the code
   * was mailed to and where it was asked from. Changes nothing. One read.
   */
  app.post(`${scope.api}/check`, async (c) => {
    const req = c.req.raw;
    const body = await viewerBody(scope, req, deps, NEEDS_CODE);
    if (body instanceof Response) return body;
    const limited = await networkLimit(req, deps, LIMITS_VIEWER.codeNetwork);
    if (limited !== null) return limited;
    const code = body.code;
    if (typeof code !== "string" || !scope.codePattern.test(code)) return invalid();
    const found = await deps.db.first<{ email: string; target: string }>(`SELECT email, ${field} AS target FROM ${scope.codeTable} WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`, [
      await hashToken(code),
      deps.now(),
    ]);
    if (found === null) return invalid();
    return json(200, { email: found.email, [field]: found.target });
  });

  /**
   * Turns a viewer code into a viewer session, once, and sets the scope's cookie. One read and
   * one batch, which decides and is all-or-nothing on both targets:
   * 1. the code is marked as used by the new session's id, only while it is unused and unexpired;
   * 2. the session is inserted with the address of the code that names that id: for any other
   *    request that address is NULL, the insert fails on the NOT NULL column, and the whole
   *    batch is undone, so the address always comes from the code row, never from the request;
   * 3. the session of the scope's cookie the browser had is removed (replaced, never merged);
   * 4. the audit row.
   * Of two requests with one code, the batch that runs second finds it used and makes nothing.
   * A code of the other scope is in the other table, so it is never found here.
   */
  app.post(`${scope.api}/complete`, async (c) => {
    const req = c.req.raw;
    const body = await viewerBody(scope, req, deps, NEEDS_CODE);
    if (body instanceof Response) return body;
    const limited = await networkLimit(req, deps, LIMITS_VIEWER.codeNetwork);
    if (limited !== null) return limited;
    const code = body.code;
    if (typeof code !== "string" || !scope.codePattern.test(code)) return invalid();
    const codeHash = await hashToken(code);
    const now = deps.now();
    const found = await deps.db.first<{ target: string }>(`SELECT ${field} AS target FROM ${scope.codeTable} WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`, [codeHash, now]);
    if (found === null) return invalid();

    const sessionId = newId(scope.sessionId);
    const secret = scope.secretPrefix + randomHex(32);
    const replaces = readScopeCookie(scope, req);
    try {
      await deps.db.batch([
        { sql: `UPDATE ${scope.codeTable} SET used_at = ?, session_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`, params: [now, sessionId, codeHash, now] },
        {
          sql: `INSERT INTO ${scope.sessionTable} (id, email, hash, created_at, last_used_at, expires_at) VALUES (?, (SELECT email FROM ${scope.codeTable} WHERE code_hash = ? AND session_id = ?), ?, ?, ?, ?)`,
          params: [sessionId, codeHash, sessionId, await hashToken(secret), now, now, now + VIEWER_IDLE_MS],
        },
        ...(replaces === null ? [] : [{ sql: `DELETE FROM ${scope.sessionTable} WHERE hash = ?`, params: [await hashToken(replaces)] }]),
        auditStatement(deps, { event: "viewer_signin", subject: sessionId }),
      ]);
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      return invalid();
    }
    return withHeader(json(200, { [field]: found.target }), "set-cookie", scopeCookie(scope, secret));
  });

  /**
   * Ends the scope's viewer session of this browser (its row is removed) and clears its cookie:
   * 204. A request with no such cookie at all answers 204 too, and sets and asks nothing. The
   * other scope's session stays.
   */
  app.post(`${scope.api}/signout`, async (c) => {
    const req = c.req.raw;
    if (req.headers.get("authorization") !== null) return apiError(400, "credentials_not_allowed", VIEWER_SAYS.credentials);
    if (!sameOriginChange(req)) return apiError(403, "bad_origin", VIEWER_SAYS.badOrigin);
    if (!onScopeHost(scope, req, deps) || cookieValues(req, scope.cookie).length === 0) return noContent();
    const secret = readScopeCookie(scope, req);
    if (secret !== null) await deps.db.run(`DELETE FROM ${scope.sessionTable} WHERE hash = ?`, [await hashToken(secret)]);
    return withHeader(noContent(), "set-cookie", clearedScopeCookie(scope));
  });

  /** The address this browser proved in the scope, for the pages to show "viewing as"; 401 without a live viewer session. */
  app.get(`${scope.api}/session`, async (c) => {
    const req = c.req.raw;
    if (req.headers.get("authorization") !== null) return apiError(400, "credentials_not_allowed", VIEWER_SAYS.credentials);
    const email = await scopeEmail(scope, req, deps);
    if (email === null) return json(401, { error: "unauthorized" });
    return json(200, { email });
  });
}

/** The tours scope's routes: /api/v1/view/... */
export function viewerRoutes(app: Hono, deps: Deps): void {
  scopedViewerRoutes(app, deps, TOUR_VIEWERS);
}

/** The media scope's routes: /api/v1/media-view/... */
export function mediaViewerRoutes(app: Hono, deps: Deps): void {
  scopedViewerRoutes(app, deps, MEDIA_VIEWERS);
}
