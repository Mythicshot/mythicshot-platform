// Billing's routes (0.1.57, Plan 2l items 4 to 6): the workspace's billing state for the
// dashboard, Subscribe (a Stripe Checkout Session), Manage subscription (a customer portal
// session), and the listener for Stripe's signed notices. The rules (who has which allowance,
// who is read-only) are src/billing-rules.ts; the dashboard's screens are src/dash/billing.ts.
//
// None of these routes exists unless billing is configured (billingConfigured): without the
// three settings `billingRoutes` registers nothing, so each answers the app's own 404 as any
// path that never existed, on every address.
//
// Data isolation:
// - The three dashboard routes take a signed-in session alone (never a token, so never a
//   connected computer) and act on the session's own workspace; nothing in a request names one.
// - The listener is the one write that takes no credential. It reads the raw body with a bound
//   before anything else, accepts nothing without a valid Stripe-Signature, and finds a workspace
//   only through ids the platform itself stored: a completed checkout by the checkout's id stored
//   against the workspace when Subscribe was pressed (client_reference_id must match, as a
//   cross-check only), every later notice by the Stripe customer or subscription id on the
//   workspace's own record. Nothing else in the body says who paid.
// - For any notice that could change access the state is read back from Stripe (GET
//   /v1/subscriptions/<id>) and stored as Stripe says it now; neither the notice's snapshot nor
//   the order notices arrive in is trusted. A read that fails changes nothing and answers 500,
//   so Stripe sends the notice again.
// - Nothing from Stripe's body is rendered, logged or put in an answer; no key, secret or
//   signature is ever logged, answered or put in an error. The audit record holds the
//   workspace's id and short words only (src/audit.ts refuses anything else).
import type { Hono } from "hono";
import { auditStatement } from "./audit.ts";
import { constantTimeEqual, requireAuth } from "./auth.ts";
import {
  BILLING_COLUMNS_SQL,
  LINKS_GRACE_MS,
  PLAN_NAME,
  REMOVAL_MS,
  RETURN_PATH,
  STRIPE_STATUSES,
  billingConfigured,
  isLive,
  isReadOnly,
  standingOf,
  type BillingRow,
  type Standing,
} from "./billing-rules.ts";
import { apiError, json, readCapped } from "./http.ts";
import { linkOrigin } from "./mail.ts";
import { isNotNullViolation, isUniqueViolation, type Deps, type Stmt } from "./ports.ts";
import type { StripeForm } from "./stripe.ts";
import { usageOf } from "./usage.ts";

/** The paths of billing's routes. */
export const BILLING_PATHS = {
  state: "/api/v1/billing",
  checkout: "/api/v1/billing/checkout",
  portal: "/api/v1/billing/portal",
  listener: "/api/v1/billing/webhook",
} as const;

/** The most bytes the listener reads of a notice. Stripe's notices are a few kilobytes; a larger body is refused unread. */
export const LISTENER_MAX_BYTES = 262_144;
/** How far a notice's signed time may be from now, either way, in seconds (Stripe's own default). */
export const SIGNATURE_TOLERANCE_S = 300;
/** How long a stored checkout is looked at again before a new one is made: Stripe's checkouts expire after 24 hours. */
export const CHECKOUT_REUSE_MS = 23 * 60 * 60 * 1000;

/** The listener's one answer to anything it does not accept. Fixed: nothing of the request is in it. */
const LISTENER_REFUSED = '{"error":"bad_notice"}';

function listenerRefused(): Response {
  return new Response(LISTENER_REFUSED, { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The answer to a notice taken (or one that needs nothing done). */
function listenerTaken(): Response {
  return new Response('{"received":true}', { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The answer when Stripe could not be read: nothing was changed, and Stripe sends the notice again. */
function listenerRetry(): Response {
  return new Response('{"error":"retry"}', { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The refusal of upload, publish and share while a workspace is read-only (readOnlyRefusal). */
export const SUBSCRIPTION_ENDED = {
  status: 402,
  error: "subscription_ended",
  detail: "the workspace's subscription has ended or its trial is over: it can view, download and delete, but not upload, publish or share",
} as const;

/** What a dashboard route answers when Stripe did not answer as it should. Nothing was changed. */
function stripeUnavailable(): Response {
  return apiError(502, "stripe_unavailable", "the payment service did not answer; nothing was changed, try again in a moment");
}

const BILLING_ROW_SQL = `SELECT ${BILLING_COLUMNS_SQL} FROM workspace WHERE workspace.id = ?`;

/** The billing row of one workspace, in one call. */
async function billingRowOf(deps: Deps, workspaceId: string): Promise<BillingRow | null> {
  return deps.db.first<BillingRow>(BILLING_ROW_SQL, [workspaceId]);
}

/**
 * The refusal of a request that would upload, publish or share, while the workspace is
 * read-only (an ended subscription or a trial past its 90 days), or null to go on. Without
 * billing it is null at once and makes no call, so a site without the settings is as before;
 * with billing it makes one database call. The answer is 402 `subscription_ended`.
 */
export async function readOnlyRefusal(deps: Deps, workspaceId: string): Promise<Response | null> {
  if (!billingConfigured(deps.config)) return null;
  const row = await billingRowOf(deps, workspaceId);
  if (row === null) return null;
  if (!isReadOnly(standingOf(row, deps.now()))) return null;
  return apiError(SUBSCRIPTION_ENDED.status, SUBSCRIPTION_ENDED.error, SUBSCRIPTION_ENDED.detail);
}

// ---- Stripe-Signature ----

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * True when `header` (Stripe-Signature) signs `body` with `secret` within the tolerance of
 * `nowMs`: an HMAC-SHA256, keyed with the whole secret (whsec_ included) as UTF-8, over the
 * header's `t`, a dot and the raw body bytes, equal to ANY of its `v1` values (compared in
 * constant time, every one of them). `v0` and unknown entries are ignored, in any order. A
 * header without exactly one `t`, or without a `v1`, or a `t` more than
 * SIGNATURE_TOLERANCE_S seconds from now either way, is refused.
 */
export async function verifyStripeSignature(header: string | null, body: Uint8Array, secret: string, nowMs: number): Promise<boolean> {
  if (header === null || header.length > 4096) return false;
  let t: string | null = null;
  let ts = 0;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (t !== null) return false;
      t = value;
    } else if (key === "v1") {
      v1.push(value);
    }
  }
  if (t === null || !/^[0-9]{1,12}$/.test(t) || v1.length === 0 || v1.length > 16) return false;
  ts = Number(t);
  if (Math.abs(nowMs / 1000 - ts) > SIGNATURE_TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = encoder.encode(`${t}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix, 0);
  signed.set(body, prefix.byteLength);
  const expected = hex(await crypto.subtle.sign("HMAC", key, signed));
  let ok = false;
  // Every value is compared, whichever matches, so the time taken says nothing of which did.
  for (const v of v1) ok = constantTimeEqual(v.toLowerCase(), expected) || ok;
  return ok;
}

// ---- Reading Stripe's objects ----

const ID_SHAPE: Record<string, RegExp> = {
  customer: /^cus_[A-Za-z0-9_]{1,250}$/,
  subscription: /^sub_[A-Za-z0-9_]{1,250}$/,
  checkout: /^cs_[A-Za-z0-9_]{1,250}$/,
  event: /^evt_[A-Za-z0-9_]{1,250}$/,
  charge: /^(?:ch|py)_[A-Za-z0-9_]{1,250}$/,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** A Stripe id of the given kind, given as the id itself or as the expanded object holding it; else null. */
function idOf(v: unknown, kind: keyof typeof ID_SHAPE): string | null {
  const id = isObj(v) ? v.id : v;
  return typeof id === "string" && ID_SHAPE[kind].test(id) ? id : null;
}

/** Stripe's seconds as the platform's milliseconds; null for anything but a whole positive number. */
function msOf(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 1e11 ? v * 1000 : null;
}

/** A subscription as read back from Stripe. */
export type Subscription = {
  id: string;
  customer: string;
  status: (typeof STRIPE_STATUSES)[number];
  periodEnd: number | null;
  cancelAt: number | null;
  cancelAtPeriodEnd: 0 | 1;
  endedAt: number | null;
};

/**
 * What Stripe says of the subscription now (GET /v1/subscriptions/<id>), or null when it could
 * not be read: no answer, any status but 200, or a body not of the shape expected (its id not
 * the one asked for, an unknown status). The end of the paid period is items.data[0].current_period_end.
 */
async function readSubscription(deps: Deps, id: string): Promise<Subscription | null> {
  if (deps.stripe === undefined || idOf(id, "subscription") === null) return null;
  let answer;
  try {
    answer = await deps.stripe.call("GET", `/v1/subscriptions/${id}`);
  } catch {
    return null;
  }
  if (answer.status !== 200 || !isObj(answer.body)) return null;
  const b = answer.body;
  const customer = idOf(b.customer, "customer");
  const status = b.status;
  if (b.id !== id || customer === null || typeof status !== "string" || !(STRIPE_STATUSES as readonly string[]).includes(status)) return null;
  const items = isObj(b.items) && Array.isArray(b.items.data) ? b.items.data : [];
  const first = items.length > 0 && isObj(items[0]) ? items[0] : null;
  const periodEnd = msOf(first?.current_period_end) ?? msOf(b.current_period_end);
  return {
    id,
    customer,
    status: status as Subscription["status"],
    periodEnd,
    cancelAt: msOf(b.cancel_at),
    cancelAtPeriodEnd: b.cancel_at_period_end === true ? 1 : 0,
    endedAt: msOf(b.ended_at),
  };
}

// ---- The state the dashboard shows ----

/** The dashboard's name for where a workspace stands (GET /api/v1/billing). */
export type BillingStateName = "exempt" | "trial" | "trial_over" | "subscribed" | "past_due" | "ending" | "ended";

function stateAnswer(s: Standing, row: BillingRow, now: number, used: number, allowance: number | null) {
  const base = {
    plan: PLAN_NAME,
    used_bytes: used,
    allowance_bytes: allowance,
    trial_ends_at: null as number | null,
    days_left: null as number | null,
    next_payment_at: null as number | null,
    ends_at: null as number | null,
    ended_at: null as number | null,
    links_until: null as number | null,
    removed_at: null as number | null,
    // Manage subscription opens Stripe's page for the customer on record; without one there is nothing to manage.
    manage: row.customer !== null,
  };
  const daysTo = (at: number) => Math.max(0, Math.ceil((at - now) / 86_400_000));
  switch (s.kind) {
    case "exempt":
      return { state: "exempt" as BillingStateName, ...base };
    case "trial":
      return { state: "trial" as BillingStateName, ...base, trial_ends_at: s.endsAt, days_left: daysTo(s.endsAt), removed_at: s.endsAt };
    case "trial_over":
      return { state: "trial_over" as BillingStateName, ...base, trial_ends_at: s.endedAt, days_left: 0, removed_at: s.endedAt };
    case "ended":
      return { state: "ended" as BillingStateName, ...base, ended_at: s.endedAt, links_until: s.endedAt + LINKS_GRACE_MS, removed_at: s.endedAt + REMOVAL_MS };
    case "subscribed":
      if (s.endsAt !== null) {
        return { state: "ending" as BillingStateName, ...base, ends_at: s.endsAt, links_until: s.endsAt + LINKS_GRACE_MS, removed_at: s.endsAt + REMOVAL_MS };
      }
      return { state: (s.pastDue ? "past_due" : "subscribed") as BillingStateName, ...base, next_payment_at: s.periodEnd };
  }
}

// ---- Subscribe and Manage subscription ----

/** The address Stripe sends a person back to: the app's address for links, else the one the request came to. */
function appOrigin(deps: Deps, req: Request): string {
  return linkOrigin(deps.config) ?? new URL(req.url).origin;
}

/** True for an https address on exactly this host: what Stripe answers as a page to send a person to. */
function stripePage(url: unknown, host: string): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === host && u.username === "" && u.password === "" && u.port === "";
  } catch {
    return false;
  }
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** The session's own workspace's billing row with the account's email, in one call. */
async function rowWithEmail(deps: Deps, workspaceId: string, userId: string): Promise<(BillingRow & { email: string | null }) | null> {
  return deps.db.first<BillingRow & { email: string | null }>(
    `SELECT ${BILLING_COLUMNS_SQL}, (SELECT u.email FROM user u WHERE u.id = ?) AS email FROM workspace WHERE workspace.id = ?`,
    [userId, workspaceId],
  );
}

/** True for what Stripe answers as an embedded checkout's client secret: letters, digits and underscores. */
function clientSecret(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && v.length <= 512 && /^[A-Za-z0-9_]+$/.test(v);
}

/**
 * What Stripe says of a stored checkout now: open (with its client secret, to mount again),
 * complete, expired, or null when it could not be read.
 */
async function checkoutNow(deps: Deps, sessionId: string): Promise<{ status: "open"; secret: string | null } | { status: "complete" | "expired" } | null> {
  if (deps.stripe === undefined) return null;
  try {
    const a = await deps.stripe.call("GET", `/v1/checkout/sessions/${sessionId}`);
    if (a.status !== 200 || !isObj(a.body) || a.body.id !== sessionId) return null;
    if (a.body.status === "complete") return { status: "complete" };
    if (a.body.status === "expired") return { status: "expired" };
    if (a.body.status === "open") return { status: "open", secret: clientSecret(a.body.client_secret) ? a.body.client_secret : null };
    return null;
  } catch {
    return null;
  }
}

function alreadySubscribed(): Response {
  return apiError(409, "already_subscribed", "the workspace already has a subscription; manage it on Stripe's page");
}

export function billingRoutes(app: Hono, deps: Deps): void {
  if (!billingConfigured(deps.config)) return;

  /**
   * GET /api/v1/billing: where the session's own workspace stands, for the dashboard's notice,
   * the Account page's Billing section and the page a person comes back to from Stripe. Two
   * database calls after the session: the billing row and the usage. It only reads and grants
   * nothing. With `?session_id=<checkout>` (the return page, which Stripe sends back with the
   * checkout's id) it also answers `checkout`: what Stripe says of that checkout now ("open",
   * "complete", "expired", or "unknown" when it could not be read), only when it is the
   * checkout stored against this workspace; for any other id, another workspace's included, it
   * is null and Stripe is not asked, exactly as for an id that never existed.
   */
  app.get(BILLING_PATHS.state, async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    const row = await billingRowOf(deps, auth.workspaceId);
    if (row === null) return apiError(404, "not_found", "no such workspace");
    const usage = await usageOf(deps, auth.workspaceId);
    const now = deps.now();
    const asked = c.req.query("session_id");
    let checkout: string | null = null;
    if (typeof asked === "string" && row.checkout_session !== null && idOf(asked, "checkout") !== null && constantTimeEqual(asked, row.checkout_session)) {
      checkout = (await checkoutNow(deps, row.checkout_session))?.status ?? "unknown";
    }
    return json(200, { ...stateAnswer(standingOf(row, now), row, now, usage.used, usage.allowance), checkout });
  });

  /**
   * POST /api/v1/billing/checkout: an embedded Stripe Checkout Session for the session's own
   * workspace, answered as { client_secret, publishable_key } for the Subscribe page to mount
   * Stripe's form with (the secret only to this session, never logged, stored or put in an
   * address; the publishable key is public). Refused when the workspace already
   * has a live subscription. A checkout stored in the last CHECKOUT_REUSE_MS that Stripe still
   * holds open is answered again, so two people pressing Subscribe get one checkout; two presses
   * at the same moment send the same Idempotency-Key (made from the workspace, the stored
   * checkout and the request's own fields) and so get the same checkout from Stripe. The new
   * checkout's id is stored against the workspace before the answer, only where the workspace's
   * record is still as it was read and has no live subscription; a checkout that lost that race
   * is expired at Stripe and the request answers 409.
   */
  app.post(BILLING_PATHS.checkout, async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return json(401, { error: "unauthorized" });
    const settings = deps.config.billing!;
    const stripe = deps.stripe;
    if (stripe === undefined) return stripeUnavailable();
    const row = await rowWithEmail(deps, auth.workspaceId, auth.session.userId);
    if (row === null) return apiError(404, "not_found", "no such workspace");
    if (isLive(row.status)) return alreadySubscribed();

    const now = deps.now();
    if (row.checkout_session !== null && row.checkout_created_at !== null && now - row.checkout_created_at < CHECKOUT_REUSE_MS) {
      const open = await checkoutNow(deps, row.checkout_session);
      if (open?.status === "open" && open.secret !== null) return json(200, { client_secret: open.secret, publishable_key: settings.publishableKey });
      // Paid already: the notice will switch the workspace on.
      if (open?.status === "complete") return alreadySubscribed();
    }

    const origin = appOrigin(deps, req);
    const form: [string, string][] = [
      ["mode", "subscription"],
      ["line_items[0][price]", settings.priceId],
      ["line_items[0][quantity]", "1"],
      ["managed_payments[enabled]", "true"],
      ["ui_mode", "embedded_page"],
      // Stripe puts the checkout's id in place of the braces when it sends the person back.
      ["return_url", `${origin}${RETURN_PATH}?session_id={CHECKOUT_SESSION_ID}`],
      ["client_reference_id", auth.workspaceId],
    ];
    if (row.customer !== null) form.push(["customer", row.customer]);
    else if (typeof row.email === "string" && row.email !== "") form.push(["customer_email", row.email]);
    const key = `checkout_${auth.workspaceId}_${row.checkout_session ?? "none"}_${(await sha256Hex(JSON.stringify(form))).slice(0, 32)}`;

    let created;
    try {
      created = await stripe.call("POST", "/v1/checkout/sessions", form as StripeForm, key);
    } catch {
      return stripeUnavailable();
    }
    const b = created.body;
    const sessionId = isObj(b) ? idOf(b.id, "checkout") : null;
    if (created.status !== 200 || !isObj(b) || sessionId === null || !clientSecret(b.client_secret)) return stripeUnavailable();
    const secret = b.client_secret;

    // Stored before the answer: this id is the only way a completed checkout finds the workspace.
    try {
      await deps.db.batch([
        {
          sql:
            "UPDATE workspace SET checkout_session_id = ?, checkout_created_at = ? WHERE id = ? AND (checkout_session_id IS ? OR checkout_session_id = ?)" +
            " AND (subscription_status IS NULL OR subscription_status NOT IN ('active', 'trialing', 'past_due'))",
          params: [sessionId, now, auth.workspaceId, row.checkout_session, sessionId],
        },
        auditStatement(deps, { event: "billing_checkout_started", userId: auth.session.userId, workspaceId: auth.workspaceId }, { onlyAfterOneChange: true }),
      ]);
    } catch (err) {
      if (!isUniqueViolation(err) && !isNotNullViolation(err)) throw err;
      // Another Subscribe stored a different checkout first (or a subscription went live): this
      // one is never used, so it is closed at Stripe, and the request says so.
      try {
        await stripe.call("POST", `/v1/checkout/sessions/${sessionId}/expire`);
      } catch {
        // Best effort: a checkout nobody is sent to expires by itself after 24 hours.
      }
      return apiError(409, "checkout_pending", "another checkout for this workspace was started at the same moment; reload the page");
    }
    return json(200, { client_secret: secret, publishable_key: settings.publishableKey });
  });

  /**
   * POST /api/v1/billing/portal: a Stripe customer portal session for the customer on the
   * session's own workspace's record, answered as { url }; it comes back to the Account page.
   */
  app.post(BILLING_PATHS.portal, async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    const stripe = deps.stripe;
    if (stripe === undefined) return stripeUnavailable();
    const row = await billingRowOf(deps, auth.workspaceId);
    if (row === null) return apiError(404, "not_found", "no such workspace");
    if (row.customer === null) return apiError(409, "no_subscription", "the workspace has no subscription to manage");
    let answer;
    try {
      answer = await stripe.call("POST", "/v1/billing_portal/sessions", [
        ["customer", row.customer],
        ["return_url", `${appOrigin(deps, req)}/account`],
      ]);
    } catch {
      return stripeUnavailable();
    }
    if (answer.status !== 200 || !isObj(answer.body) || !stripePage(answer.body.url, "billing.stripe.com")) return stripeUnavailable();
    return json(200, { url: answer.body.url });
  });

  /**
   * POST /api/v1/billing/webhook: Stripe's notices. No credential: the signature is the
   * credential. See the top of this file and handleNotice.
   */
  app.post(BILLING_PATHS.listener, async (c) => {
    const raw = await readCapped(c.req.raw, LISTENER_MAX_BYTES);
    if (raw === "too_large") return listenerRefused();
    if (!(await verifyStripeSignature(c.req.raw.headers.get("stripe-signature"), raw, deps.config.billing!.webhookSecret, deps.now()))) return listenerRefused();
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    } catch {
      return listenerRefused();
    }
    if (!isObj(event) || typeof event.type !== "string" || idOf(event.id, "event") === null || !isObj(event.data) || !isObj(event.data.object)) return listenerRefused();
    return handleNotice(deps, event.id as string, event.type, event.data.object);
  });
}

// ---- The listener's work ----

/** The workspace row whose column holds this Stripe id, or null. */
async function workspaceBy(deps: Deps, column: "checkout_session_id" | "stripe_customer_id" | "stripe_subscription_id", id: string): Promise<BillingRow | null> {
  return deps.db.first<BillingRow>(`SELECT ${BILLING_COLUMNS_SQL} FROM workspace WHERE workspace.${column} = ?`, [id]);
}

function recordEvent(deps: Deps, eventId: string): Stmt {
  return { sql: "INSERT INTO stripe_event (id, received_at) VALUES (?, ?)", params: [eventId, deps.now()] };
}

/** Records the notice with an audit row for a workspace (or none), and nothing else. A repeat of the notice that raced this one is no failure. */
async function recordOnly(deps: Deps, eventId: string, audit: Stmt | null): Promise<Response> {
  try {
    await deps.db.batch(audit === null ? [recordEvent(deps, eventId)] : [audit, recordEvent(deps, eventId)]);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  return listenerTaken();
}

/**
 * Stores what Stripe says of the workspace's subscription now, with an audit row when anything
 * of it changed, and records the notice, in one batch. `link` is a completed checkout: it also
 * takes the subscription's customer and id onto the record and clears the stored checkout,
 * only while the record still holds that checkout and no other live subscription (the batch is
 * undone otherwise, and the notice answered 500 so it is looked at again). Without `link` the
 * row is written only while it still holds this subscription and customer.
 */
async function storeSubscription(deps: Deps, eventId: string, row: BillingRow, sub: Subscription, link: { checkout: string } | null, extra: Stmt | null = null): Promise<Response> {
  const changed =
    row.subscription !== sub.id ||
    row.customer !== sub.customer ||
    row.status !== sub.status ||
    row.period_end !== sub.periodEnd ||
    row.cancel_at !== sub.cancelAt ||
    row.cancel_at_period_end !== sub.cancelAtPeriodEnd ||
    row.ended_at !== sub.endedAt ||
    link !== null;
  if (!changed) return recordOnly(deps, eventId, extra);
  const set =
    "UPDATE workspace SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ?, subscription_period_end = ?," +
    " subscription_cancel_at = ?, subscription_cancel_at_period_end = ?, subscription_ended_at = ?";
  const values = [sub.customer, sub.id, sub.status, sub.periodEnd, sub.cancelAt, sub.cancelAtPeriodEnd, sub.endedAt];
  const update: Stmt =
    link !== null
      ? {
          sql:
            set +
            ", checkout_session_id = NULL, checkout_created_at = NULL WHERE id = ? AND checkout_session_id = ? AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)" +
            " AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ? OR subscription_status IS NULL OR subscription_status NOT IN ('active', 'trialing', 'past_due'))",
          params: [...values, row.id, link.checkout, sub.customer, sub.id],
        }
      : { sql: set + " WHERE id = ? AND stripe_subscription_id = ? AND stripe_customer_id = ?", params: [...values, row.id, sub.id, sub.customer] };
  const audit = auditStatement(
    deps,
    { event: "billing_changed", workspaceId: row.id, detail: { status: sub.status, was: row.status ?? "none", cancelling: sub.cancelAt !== null || sub.cancelAtPeriodEnd === 1 ? 1 : 0, linked: link !== null ? 1 : 0 } },
    { onlyAfterOneChange: true },
  );
  try {
    await deps.db.batch([update, audit, ...(extra === null ? [] : [extra]), recordEvent(deps, eventId)]);
  } catch (err) {
    // The same notice, taken by a request that ran at the same moment: it stored the same state.
    if (isUniqueViolation(err) && /stripe_event/.test(String((err as Error)?.message ?? ""))) return listenerTaken();
    // The customer is another workspace's already: never moved, only recorded.
    if (isUniqueViolation(err)) return recordOnly(deps, eventId, auditStatement(deps, { event: "billing_checkout_mismatch", workspaceId: row.id, detail: { reason: "customer_taken" } }));
    // The record changed under this notice (the guard found no row): nothing was written, and
    // Stripe sends the notice again, which is then judged against the record as it is.
    if (isNotNullViolation(err)) return listenerRetry();
    throw err;
  }
  return listenerTaken();
}

/** The subscription a checkout or invoice object names: its `subscription`, or (newer API versions) its parent's. */
function subscriptionNamedBy(obj: Obj): string | null {
  const direct = idOf(obj.subscription, "subscription");
  if (direct !== null) return direct;
  const parent = isObj(obj.parent) && isObj(obj.parent.subscription_details) ? obj.parent.subscription_details.subscription : null;
  return idOf(parent, "subscription");
}

/** The workspace a charge-related object belongs to, through the customer on the charge (read from Stripe when the object names only the charge). */
async function workspaceOfCharge(deps: Deps, obj: Obj, type: string): Promise<BillingRow | null | "unreadable"> {
  let customer = type === "charge.refunded" ? idOf(obj.customer, "customer") : null;
  if (customer === null) {
    const charge = idOf(obj.charge, "charge");
    if (charge === null || deps.stripe === undefined) return null;
    try {
      const a = await deps.stripe.call("GET", `/v1/charges/${charge}`);
      if (a.status !== 200 || !isObj(a.body)) return "unreadable";
      customer = idOf(a.body.customer, "customer");
    } catch {
      return "unreadable";
    }
  }
  return customer === null ? null : workspaceBy(deps, "stripe_customer_id", customer);
}

const RISK_KINDS: Record<string, string> = {
  "charge.refunded": "refund",
  "charge.dispute.created": "dispute",
  "radar.early_fraud_warning.created": "fraud_warning",
};

/** Reads back the workspace's own subscription (the one on its record) and stores it; with no subscription on record, records the notice only. */
async function readBackOwn(deps: Deps, eventId: string, row: BillingRow, audit: Stmt | null): Promise<Response> {
  if (row.subscription === null) return recordOnly(deps, eventId, audit);
  const sub = await readSubscription(deps, row.subscription);
  if (sub === null) return listenerRetry();
  // The customer Stripe names must be the one on record: anything else changes nothing.
  if (row.customer !== null && sub.customer !== row.customer) {
    return recordOnly(deps, eventId, auditStatement(deps, { event: "billing_checkout_mismatch", workspaceId: row.id, detail: { reason: "customer_differs" } }));
  }
  return storeSubscription(deps, eventId, row, sub, null, audit);
}

/**
 * One verified notice. A notice already recorded answers 200 and does nothing. The notice is
 * recorded in the same batch as what it changed, so one whose read-back failed (500) is not
 * recorded and is taken again when Stripe resends it.
 */
async function handleNotice(deps: Deps, eventId: string, type: string, obj: Obj): Promise<Response> {
  const acted = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
    ...Object.keys(RISK_KINDS),
  ];
  if (!acted.includes(type)) return listenerTaken();
  if ((await deps.db.first("SELECT 1 AS seen FROM stripe_event WHERE id = ?", [eventId])) !== null) return listenerTaken();

  if (type.startsWith("checkout.session.")) {
    const checkout = idOf(obj.id, "checkout");
    if (checkout === null) return recordOnly(deps, eventId, null);
    const row = await workspaceBy(deps, "checkout_session_id", checkout);
    if (row === null) {
      // No workspace stored this checkout: nothing is granted. When its customer is on a
      // workspace's record (a second checkout of a workspace that pays already), that workspace
      // is told in its audit record; nothing of it changes.
      const customer = idOf(obj.customer, "customer");
      const owner = customer === null ? null : await workspaceBy(deps, "stripe_customer_id", customer);
      return recordOnly(deps, eventId, auditStatement(deps, { event: "billing_checkout_unmatched", workspaceId: owner?.id ?? null, detail: { live: owner !== null && isLive(owner.status) ? 1 : 0 } }));
    }
    if (obj.client_reference_id !== row.id) {
      return recordOnly(deps, eventId, auditStatement(deps, { event: "billing_checkout_mismatch", workspaceId: row.id, detail: { reason: "reference_differs" } }));
    }
    if (type === "checkout.session.async_payment_failed") {
      return recordOnly(deps, eventId, auditStatement(deps, { event: "billing_payment_failed", workspaceId: row.id, detail: { stage: "checkout" } }));
    }
    if (type === "checkout.session.async_payment_succeeded" && obj.payment_status !== "paid") return recordOnly(deps, eventId, null);
    const subId = subscriptionNamedBy(obj);
    if (subId === null) return recordOnly(deps, eventId, null);
    // Another subscription is live on this workspace already: never replaced, only recorded.
    if (row.subscription !== null && row.subscription !== subId && isLive(row.status)) {
      return recordOnly(deps, eventId, auditStatement(deps, { event: "billing_second_subscription", workspaceId: row.id }));
    }
    const sub = await readSubscription(deps, subId);
    if (sub === null) return listenerRetry();
    const named = idOf(obj.customer, "customer");
    if ((named !== null && named !== sub.customer) || (row.customer !== null && row.customer !== sub.customer)) {
      return recordOnly(deps, eventId, auditStatement(deps, { event: "billing_checkout_mismatch", workspaceId: row.id, detail: { reason: "customer_differs" } }));
    }
    return storeSubscription(deps, eventId, row, sub, { checkout });
  }

  if (type.startsWith("customer.subscription.")) {
    const subId = idOf(obj.id, "subscription");
    if (subId === null) return recordOnly(deps, eventId, null);
    const row = await workspaceBy(deps, "stripe_subscription_id", subId);
    if (row === null) {
      // Not this workspace's subscription (yet): a subscription is linked by its checkout alone.
      // One of a customer on record is noted against that workspace, and changes nothing.
      const customer = idOf(obj.customer, "customer");
      const owner = customer === null ? null : await workspaceBy(deps, "stripe_customer_id", customer);
      return recordOnly(deps, eventId, owner === null ? null : auditStatement(deps, { event: "billing_unlinked_subscription", workspaceId: owner.id }));
    }
    return readBackOwn(deps, eventId, row, null);
  }

  if (type.startsWith("invoice.")) {
    const customer = idOf(obj.customer, "customer");
    if (customer === null) return recordOnly(deps, eventId, null);
    const row = await workspaceBy(deps, "stripe_customer_id", customer);
    if (row === null) return recordOnly(deps, eventId, null);
    const audit = type === "invoice.payment_failed" ? auditStatement(deps, { event: "billing_payment_failed", workspaceId: row.id, detail: { stage: "renewal" } }) : null;
    return readBackOwn(deps, eventId, row, audit);
  }

  // The three risk notices: noted against the workspace, then the same read-back.
  const row = await workspaceOfCharge(deps, obj, type);
  if (row === "unreadable") return listenerRetry();
  if (row === null) return recordOnly(deps, eventId, null);
  return readBackOwn(deps, eventId, row, auditStatement(deps, { event: "billing_risk", workspaceId: row.id, detail: { kind: RISK_KINDS[type] } }));
}
