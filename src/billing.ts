// Billing's routes (0.1.57, Plan 2l items 4 to 6): the workspace's billing state for the
// dashboard, Subscribe (an embedded Stripe Checkout Session), Manage subscription (a customer
// portal session), and the listener for Stripe's signed notices. The rules (who has which
// allowance, who is read-only) are src/billing-rules.ts; the screens are src/dash/billing.ts.
//
// None of these routes exists unless billing is configured (billingConfigured): without the
// four settings `billingRoutes` registers nothing, so each answers the app's own 404 as any
// path that never existed, on every address.
//
// Data isolation:
// - The three dashboard routes take a signed-in session alone (never a token, so never a
//   connected computer) and act on the session's own workspace; nothing in a request names one.
//   Those that ask Stripe are counted per workspace (LIMITS_BILLING, src/rate.ts).
// - The listener is the one write that takes no credential. It reads the raw body with a bound
//   before anything else, accepts nothing without a valid Stripe-Signature, and finds a workspace
//   only through ids the platform itself stored: a completed checkout by the checkout's id in
//   stripe_checkout, written for the workspace before its client secret was handed out
//   (client_reference_id must match, as a cross-check only); every later notice by the Stripe
//   customer or subscription id on the workspace's own record. Nothing else says who paid.
//
// Money:
// - For any notice that could change access the state is read back from Stripe (GET
//   /v1/subscriptions/<id>) and stored as Stripe says it now. Every such write is conditional on
//   the record still being exactly what the handler read before asking Stripe: a handler whose
//   read went stale meanwhile changes nothing, records nothing and answers 500, so Stripe's
//   retry reads again. A read that fails does the same. A subscription Stripe no longer has
//   (404 resource_missing, after a data-deletion request) is stored as ended now.
// - A subscription notice for a subscription not linked yet, while a checkout is pending, is
//   answered 500 so it comes back after the checkout's notice linked it.
// - A stored checkout is replaced only once Stripe confirms it expired; one Stripe says is paid
//   is linked instead, never replaced; any other answer makes no new checkout.
// - A live status whose stored period ended more than STALE_MS ago is read back before it is
//   trusted; while it cannot be, the workspace is read-only for writes (nothing is taken down).
//
// Nothing from Stripe's body is rendered, logged or put in an answer; no key, secret, signature
// or client secret is ever logged or put in an error or an address. The audit record holds the
// workspace's id and short words only (src/audit.ts refuses anything else).
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
  CONFIRMED_FOR_MS,
  HEAL_EVERY_MS,
  billingConfigured,
  testKeys,
  type BillingSettings,
  isEnded,
  isLive,
  isReadOnly,
  standingOf,
  type BillingRow,
  type Standing,
} from "./billing-rules.ts";
import { apiError, json, readCapped } from "./http.ts";
import { clockOf, planOf } from "./removal-rules.ts";
import { WARNINGS_JSON_SQL, emailSha256, warningsOf } from "./removal-store.ts";
import { linkOrigin } from "./mail.ts";
import { isNotNullViolation, isUniqueViolation, type Deps, type Stmt } from "./ports.ts";
import { LIMITS_BILLING, hitLimit, workspaceKey } from "./rate.ts";
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
/**
 * How long a checkout lives at Stripe (`expires_at`), in seconds, from the start of the minute it
 * is made in (so two presses in one minute send one key): at least 32 minutes from the moment it
 * is made, so Stripe's shortest, 30 minutes, holds with room for a clock that is behind.
 */
export const CHECKOUT_LIFE_S = 33 * 60;
/** A stored checkout is offered again only while at least this much of its life is left. */
export const CHECKOUT_REUSE_MARGIN_MS = 5 * 60 * 1000;
/** The most rows of billing problems the admin's summary lists. */
export const BILLING_PROBLEMS_LISTED = 20;

/** The listener's one answer to anything it does not accept. Fixed: nothing of the request is in it. */
const LISTENER_REFUSED = '{"error":"bad_notice"}';

function listenerRefused(): Response {
  return new Response(LISTENER_REFUSED, { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The answer to a notice taken (or one that needs nothing done). */
function listenerTaken(): Response {
  return new Response('{"received":true}', { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The answer when the notice cannot be settled now: nothing was changed or recorded, and Stripe sends it again. */
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

/** The 429 of the routes that ask Stripe, with the time until the count starts again. */
function tooMany(retryAfterSeconds: number): Response {
  const r = apiError(429, "rate_limited", "too many requests to the payment service from this workspace; try again later");
  r.headers.set("retry-after", String(retryAfterSeconds));
  return r;
}

const BILLING_ROW_SQL = `SELECT ${BILLING_COLUMNS_SQL} FROM workspace WHERE workspace.id = ?`;

/** The billing row of one workspace, in one call. */
async function billingRowOf(deps: Deps, workspaceId: string): Promise<BillingRow | null> {
  return deps.db.first<BillingRow>(BILLING_ROW_SQL, [workspaceId]);
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
  if (Math.abs(nowMs / 1000 - Number(t)) > SIGNATURE_TOLERANCE_S) return false;
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

/**
 * True for Stripe's answer that an object does not exist (404 resource_missing).
 *
 * A 404 is never proof for anything that removes data. Stripe answers it for an object it
 * deleted, but also for one of another account or mode, a key that lost a permission, or a
 * mistyped id. It may end a subscription's access (read-only, which nothing undoes but a new
 * payment, and which removes nothing), and it may let an admin's own delete go ahead, but code
 * that deletes or unpublishes anything on its own must ask missingAllowsRemoval and get false.
 */
function isMissing(status: number, body: unknown): boolean {
  return status === 404 && isObj(body) && isObj(body.error) && body.error.code === "resource_missing";
}

/** Whether Stripe's 404 may be taken as proof for removing data: never (see isMissing). */
export function missingAllowsRemoval(): false {
  return false;
}

// ---- The billing sweep's last questions before a removal (src/billing-sweep.ts, 0.1.61) ----

/**
 * What Stripe says, right before a removal, of the subscription on the workspace's record
 * (GET /v1/subscriptions/<id>, one call): "ended" only for a definite answer that it is the
 * record's own, of the record's customer, with an ended status (`canceled`, `unpaid`,
 * `incomplete_expired`). "live" when Stripe says it is live: with `repair` the stored state is
 * then brought to what Stripe says, as a read-back does (storeSubscription, under its guard).
 * "unknown" for everything else: no answer, a timeout, a permission error, any status but 200,
 * a body not of the shape expected, another customer, and a 404, which missingAllowsRemoval says
 * is never proof. Nothing is removed on "live" or "unknown".
 */
export async function subscriptionBeforeRemoval(deps: Deps, row: BillingRow, repair: boolean): Promise<"ended" | "live" | "unknown"> {
  if (row.subscription === null || row.customer === null) return "unknown";
  const read = await readSubscription(deps, row.subscription);
  if (read === "missing") return missingAllowsRemoval() ? "ended" : "unknown";
  if (read === null || read.customer !== row.customer) return "unknown";
  if (isLive(read.status)) {
    if (repair) await storeSubscription(deps, null, row, read, null);
    return "live";
  }
  return isEnded(read.status) ? "ended" : "unknown";
}

/**
 * What Stripe says, right before a removal, of one checkout this site made for the workspace
 * (GET /v1/checkout/sessions/<id>, one call): "expired" only for that definite answer; "open"
 * or "complete" (paid) as Stripe says; "unknown" for anything else, a 404 included. Only
 * "expired" lets a removal go on.
 */
export async function checkoutBeforeRemoval(deps: Deps, id: string): Promise<"expired" | "open" | "complete" | "unknown"> {
  if (idOf(id, "checkout") === null) return "unknown";
  return (await checkoutNow(deps, id))?.status ?? "unknown";
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
 * What Stripe says of the subscription now (GET /v1/subscriptions/<id>): the subscription,
 * "missing" when Stripe answers that it does not exist (404 resource_missing), or null when it
 * could not be read: no answer, any other status, or a body not of the shape expected (its id
 * not the one asked for, an unknown status). The paid period's end is items.data[0].current_period_end.
 */
async function readSubscription(deps: Deps, id: string): Promise<Subscription | "missing" | null> {
  if (deps.stripe === undefined || idOf(id, "subscription") === null) return null;
  let answer;
  try {
    answer = await deps.stripe.call("GET", `/v1/subscriptions/${id}`);
  } catch {
    return null;
  }
  if (isMissing(answer.status, answer.body)) return "missing";
  if (answer.status !== 200 || !isObj(answer.body)) return null;
  const sub = subscriptionOf(answer.body, id);
  if (sub === null) await refused(deps, "subscription_read", fieldRefused(answer.body, id));
  return sub;
}

/** Which field of a subscription subscriptionOf refused. */
function fieldRefused(b: Obj, id: string): string {
  if (b.id !== id) return "id";
  if (idOf(b.customer, "customer") === null) return "customer";
  return "status";
}

function subscriptionOf(b: Obj, id: string): Subscription | null {
  const customer = idOf(b.customer, "customer");
  const status = b.status;
  if (b.id !== id || customer === null || typeof status !== "string" || !(STRIPE_STATUSES as readonly string[]).includes(status)) return null;
  const items = isObj(b.items) && Array.isArray(b.items.data) ? b.items.data : [];
  const first = items.length > 0 && isObj(items[0]) ? items[0] : null;
  return {
    id,
    customer,
    status: status as Subscription["status"],
    periodEnd: msOf(first?.current_period_end) ?? msOf(b.current_period_end),
    cancelAt: msOf(b.cancel_at),
    cancelAtPeriodEnd: b.cancel_at_period_end === true ? 1 : 0,
    endedAt: msOf(b.ended_at),
  };
}

/** The workspace's own subscription as ended now: what is stored when Stripe no longer has it. */
function goneSubscription(row: BillingRow, now: number): Subscription | null {
  if (row.subscription === null || row.customer === null) return null;
  return { id: row.subscription, customer: row.customer, status: "canceled", periodEnd: row.period_end, cancelAt: row.cancel_at, cancelAtPeriodEnd: row.cancel_at_period_end === 1 ? 1 : 0, endedAt: isEnded(row.status) && row.ended_at !== null ? row.ended_at : now };
}

// ---- Storing what Stripe says ----

function recordEvent(deps: Deps, eventId: string): Stmt {
  return { sql: "INSERT INTO stripe_event (id, received_at) VALUES (?, ?)", params: [eventId, deps.now()] };
}

type Stored = "stored" | "unchanged" | "conflict" | "customer_taken";

/**
 * Stores what Stripe says of the workspace's subscription now, with an audit row when anything
 * changed, `extra` and the notice's record (`eventId`, absent for a read-back of no notice), in
 * one batch. The write is conditional on the row still being exactly what `row` holds: if any of
 * its billing columns changed since it was read, nothing is written and the answer is
 * "conflict" (the caller answers 500 and Stripe's retry reads again). `link` is a checkout this
 * site made, completed: it also takes the subscription's customer and id onto the record and
 * clears the pending checkout when it is that one. An ended subscription that Stripe gives no
 * end time for keeps the time it was first seen ended.
 */
async function storeSubscription(deps: Deps, eventId: string | null, row: BillingRow, sub: Subscription, link: string | null, extra: Stmt | null = null): Promise<Stored> {
  const endedAt = sub.endedAt ?? (isEnded(sub.status) ? (isEnded(row.status) && row.ended_at !== null ? row.ended_at : deps.now()) : null);
  const tail = [...(extra === null ? [] : [extra]), ...(eventId === null ? [] : [recordEvent(deps, eventId)])];
  const changed =
    row.subscription !== sub.id ||
    row.customer !== sub.customer ||
    row.status !== sub.status ||
    row.period_end !== sub.periodEnd ||
    row.cancel_at !== sub.cancelAt ||
    row.cancel_at_period_end !== sub.cancelAtPeriodEnd ||
    row.ended_at !== endedAt ||
    (link !== null && row.checkout_session === link);
  try {
    if (!changed) {
      if (tail.length > 0) await deps.db.batch(tail);
      return "unchanged";
    }
    const update: Stmt = {
      sql:
        "UPDATE workspace SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ?, subscription_period_end = ?," +
        " subscription_cancel_at = ?, subscription_cancel_at_period_end = ?, subscription_ended_at = ?," +
        " checkout_created_at = CASE WHEN checkout_session_id IS ? THEN NULL ELSE checkout_created_at END," +
        " checkout_session_id = CASE WHEN checkout_session_id IS ? THEN NULL ELSE checkout_session_id END" +
        " WHERE id = ? AND stripe_customer_id IS ? AND stripe_subscription_id IS ? AND subscription_status IS ? AND subscription_period_end IS ?" +
        " AND subscription_cancel_at IS ? AND subscription_cancel_at_period_end = ? AND subscription_ended_at IS ? AND checkout_session_id IS ?",
      params: [
        sub.customer, sub.id, sub.status, sub.periodEnd, sub.cancelAt, sub.cancelAtPeriodEnd, endedAt,
        link, link,
        row.id, row.customer, row.subscription, row.status, row.period_end, row.cancel_at, row.cancel_at_period_end, row.ended_at, row.checkout_session,
      ],
    };
    const audit = auditStatement(
      deps,
      { event: "billing_changed", workspaceId: row.id, detail: { status: sub.status, was: row.status ?? "none", cancelling: sub.cancelAt !== null || sub.cancelAtPeriodEnd === 1 ? 1 : 0, linked: link !== null ? 1 : 0 } },
      { onlyAfterOneChange: true },
    );
    await deps.db.batch([update, audit, ...tail]);
    return "stored";
  } catch (err) {
    // The same notice, taken by a request that ran at the same moment.
    if (isUniqueViolation(err) && /stripe_event/.test(String((err as Error)?.message ?? ""))) return "unchanged";
    // The customer or subscription is another workspace's already: never moved.
    if (isUniqueViolation(err)) return "customer_taken";
    // The guard found the row changed since it was read: nothing was written.
    if (isNotNullViolation(err)) return "conflict";
    throw err;
  }
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

/** The audit row of a notice that named this workspace but did not match it. `paid`: a paid checkout's, money taken without access (a billing problem for the admin). */
function mismatch(deps: Deps, workspaceId: string, reason: string, paid = false): Stmt {
  return auditStatement(deps, { event: "billing_checkout_mismatch", workspaceId, detail: paid ? { reason, paid: 1 } : { reason } });
}

/** A notice's answer for what storeSubscription did. */
async function answerFor(deps: Deps, eventId: string, row: BillingRow, stored: Stored, paid = false): Promise<Response> {
  if (stored === "conflict") return listenerRetry();
  if (stored === "customer_taken") return recordOnly(deps, eventId, mismatch(deps, row.id, "customer_taken", paid));
  return listenerTaken();
}

/**
 * Reads the workspace's own subscription back and stores it, for no notice: the heal of a live
 * status not confirmed for too long. Returns the row as it is after, or null when Stripe could
 * not be read (or the row changed meanwhile, which a later request heals).
 */
async function heal(deps: Deps, row: BillingRow): Promise<BillingRow | null> {
  const now = deps.now();
  const unconfirmed = async () => {
    await deps.db.run("UPDATE workspace SET billing_checked_at = ?, billing_check_ok = 0 WHERE id = ?", [now, row.id]);
    return null;
  };
  if (row.subscription === null) return unconfirmed();
  const read = await readSubscription(deps, row.subscription);
  const sub = read === "missing" ? goneSubscription(row, now) : read;
  if (sub === null || (row.customer !== null && sub.customer !== row.customer)) return unconfirmed();
  const stored = await storeSubscription(deps, null, row, sub, null);
  if (stored === "conflict" || stored === "customer_taken") return unconfirmed();
  const after = await billingRowOf(deps, row.id);
  if (after === null) return null;
  const still = standingOf(after, now);
  if (still.kind === "subscribed" && still.stale) {
    // Stripe says live, with a period end still long past: trusted for a day, and said once.
    const until = now + CONFIRMED_FOR_MS;
    await deps.db.batch([
      { sql: "UPDATE workspace SET billing_checked_at = ?, billing_check_ok = 1, billing_confirmed_until = ? WHERE id = ?", params: [now, until, row.id] },
      auditStatement(deps, { event: "billing_stale_confirmed", workspaceId: row.id, detail: { status: after.status ?? "none" } }),
    ]);
    return { ...after, checked_at: now, check_ok: 1, confirmed_until: until };
  }
  await deps.db.run("UPDATE workspace SET billing_checked_at = ?, billing_check_ok = 1 WHERE id = ?", [now, row.id]);
  return { ...after, checked_at: now, check_ok: 1 };
}

/**
 * The row and where it stands, a stale live status read back first: at most once in
 * HEAL_EVERY_MS per workspace. In between, the last try's outcome stands: unconfirmed is
 * read-only for writes, confirmed is trusted.
 */
async function trusted(deps: Deps, row: BillingRow): Promise<{ row: BillingRow; standing: Standing }> {
  const now = deps.now();
  const standing = standingOf(row, now);
  if (standing.kind !== "subscribed" || !standing.stale) return { row, standing };
  if (row.checked_at !== null && row.checked_at > now - HEAL_EVERY_MS) return { row, standing: row.check_ok === 1 ? { ...standing, stale: false } : standing };
  const healed = await heal(deps, row);
  return healed === null ? { row, standing } : { row: healed, standing: standingOf(healed, now) };
}

/**
 * The refusal of a request that would upload, publish, rename or share, while the workspace is
 * read-only (an ended subscription, a trial past its 90 days, or a live status not confirmed
 * for too long that Stripe cannot confirm now), or null to go on. Without billing it is null at
 * once and makes no call, so a site without the settings is as before; with billing it makes
 * one database call, and two more (Stripe and a write) only for a stale live status. `narrows`
 * is asked only when the workspace is read-only, for a change that may still go ahead (one that
 * does not widen who may view). The answer is 402 `subscription_ended`.
 */
export async function readOnlyRefusal(deps: Deps, workspaceId: string, narrows?: () => Promise<boolean>): Promise<Response | null> {
  if (!billingConfigured(deps.config)) return null;
  const row = await billingRowOf(deps, workspaceId);
  if (row === null) return null;
  const { standing } = await trusted(deps, row);
  if (!isReadOnly(standing)) return null;
  if (narrows !== undefined && (await narrows())) return null;
  return apiError(SUBSCRIPTION_ENDED.status, SUBSCRIPTION_ENDED.error, SUBSCRIPTION_ENDED.detail);
}

const ACCESS_RANK: Record<string, number> = { me: 0, people: 1, public: 2 };

/**
 * Whether a change of who may view this tour or item (of this workspace) does not widen it:
 * to "me", from "public" to "people", or "people" with a list that adds no address. An id that
 * is not the workspace's, or a setting it cannot read, widens: the refusal is then the same for
 * every id. Asked only for a read-only workspace.
 */
export async function accessNarrows(deps: Deps, kind: "tour" | "media", workspaceId: string, id: string, wanted: { access: string; viewers: string[] | null }): Promise<boolean> {
  const table = kind === "tour" ? "tour" : "media";
  const viewers = kind === "tour" ? "tour_viewer" : "media_viewer";
  const column = kind === "tour" ? "tour_id" : "media_id";
  const found = await deps.db.first<{ access: string; list: string }>(
    `SELECT t.access AS access, (SELECT json_group_array(v.email) FROM ${viewers} v WHERE v.${column} = t.id) AS list FROM ${table} t WHERE t.id = ? AND t.workspace_id = ?`,
    [id, workspaceId],
  );
  if (found === null) return false;
  const now = ACCESS_RANK[found.access] ?? 2;
  const next = ACCESS_RANK[wanted.access] ?? 2;
  if (next < now) return true;
  if (next > now || wanted.access !== "people") return wanted.access === "me";
  if (wanted.viewers === null) return true;
  let current: string[] = [];
  try {
    current = JSON.parse(found.list) as string[];
  } catch {
    return false;
  }
  return wanted.viewers.every((v) => current.includes(v));
}

// ---- The state the dashboard shows ----

/** The dashboard's name for where a workspace stands (GET /api/v1/billing). */
export type BillingStateName = "exempt" | "trial" | "trial_over" | "subscribed" | "past_due" | "ending" | "ended";

/**
 * The dates of a workspace on the removal clock (src/removal-rules.ts) as the sweep acts on them:
 * when its links come down and its removal day, the warnings already sent counted in. Null for a
 * workspace on no clock. One call, made only for a trial or an ended subscription.
 */
async function removalShown(deps: Deps, row: BillingRow, standing: Standing, userId: string, now: number): Promise<{ linksUntil: number; removedAt: number } | null> {
  if (standing.kind !== "trial" && standing.kind !== "trial_over" && standing.kind !== "ended") return null;
  const found = await deps.db.first<{ site: number; email: string | null; warnings: string }>(
    `SELECT EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = workspace.id) AS site, (SELECT u.email FROM user u WHERE u.id = ?) AS email, ${WARNINGS_JSON_SQL} AS warnings FROM workspace WHERE workspace.id = ?`,
    [userId, row.id],
  );
  if (found === null) return null;
  const clock = clockOf(row, found.site === 1, now);
  if (clock === null) return null;
  const plan = planOf(clock, warningsOf(found.warnings), found.email === null ? "" : await emailSha256(found.email), now);
  return { linksUntil: clock.linksDownAt, removedAt: plan.removalAt };
}

function stateAnswer(s: Standing, row: BillingRow, now: number, used: number, allowance: number | null, removal: { linksUntil: number; removedAt: number } | null = null) {
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
    // A checkout's payment Stripe is still confirming: the return page keeps waiting.
    confirming: row.status === "incomplete",
  };
  const daysTo = (at: number) => Math.max(0, Math.ceil((at - now) / 86_400_000));
  switch (s.kind) {
    case "exempt":
      return { state: "exempt" as BillingStateName, ...base };
    // The removal's dates are the clock's (removalShown), the ones the sweep acts on; a workspace
    // the clock leaves out (an allowance set by hand) keeps the dates of the version before.
    case "trial":
      return { state: "trial" as BillingStateName, ...base, trial_ends_at: s.endsAt, days_left: daysTo(s.endsAt), removed_at: removal?.removedAt ?? s.endsAt };
    case "trial_over":
      return { state: "trial_over" as BillingStateName, ...base, trial_ends_at: s.endedAt, days_left: 0, removed_at: removal?.removedAt ?? s.endedAt };
    case "ended":
      return { state: "ended" as BillingStateName, ...base, ended_at: s.endedAt, links_until: removal?.linksUntil ?? s.endedAt + LINKS_GRACE_MS, removed_at: removal?.removedAt ?? s.endedAt + REMOVAL_MS };
    case "subscribed":
      if (s.endsAt !== null) {
        return { state: "ending" as BillingStateName, ...base, ends_at: s.endsAt, links_until: s.endsAt + LINKS_GRACE_MS, removed_at: s.endsAt + REMOVAL_MS };
      }
      return { state: (s.pastDue ? "past_due" : "subscribed") as BillingStateName, ...base, next_payment_at: s.periodEnd };
  }
}

// ---- Subscribe and Manage subscription ----

/**
 * The address Stripe sends a person back to: the site's own app address for links (APP_HOST, or
 * SITE_HOST on one address), https only. Never the request's Host header. Null when the site has
 * none, which the settings refuse at the start when billing is on (billingAddressProblem).
 */
function appOrigin(deps: Deps): string | null {
  const origin = linkOrigin(deps.config);
  if (origin === null) return null;
  if (origin.startsWith("https://")) return origin;
  return localDevelopment(deps.config, origin) ? origin : null;
}

/**
 * The one exception to https: a site run on this computer against a Stripe sandbox. Its own
 * address is exactly localhost or 127.0.0.1 (any port), served over http, and both keys
 * are test-mode keys. A live key never gets it.
 */
function localDevelopment(config: { billing?: BillingSettings | null }, origin: string): boolean {
  if (config.billing === undefined || config.billing === null || !testKeys(config.billing)) return false;
  return /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/.test(origin);
}

/** The line that stops the start when billing is on without an https address of the site's own, or null. Fixed text. */
export function billingAddressProblem(config: Parameters<typeof linkOrigin>[0] & { billing?: BillingSettings | null }): string | null {
  if (config.billing === undefined || config.billing === null) return null;
  const origin = linkOrigin(config);
  if (origin === null) return "billing: Stripe needs the site's own address to send people back to. Set APP_HOST and TOURS_HOST, or SITE_HOST on a site with one address.";
  if (!origin.startsWith("https://") && !localDevelopment(config, origin)) {
    return "billing: Stripe sends people back to an https address only (http only on localhost, with STRIPE_API_KEY and STRIPE_PUBLISHABLE_KEY both test keys). Set APP_HOST, or SITE_HOST, to a name that is served over https.";
  }
  return null;
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

/**
 * True for what Stripe answers as an embedded checkout's client secret. A real one is about 468
 * characters, the checkout's id, `_secret_` and letters, digits, underscores and percent-encoded
 * bytes (0.1.59, from a sandbox run), and its form is Stripe's to change. It is only ever
 * JSON-encoded to the workspace's own session and handed to Stripe's script, never put in HTML,
 * an address, a log or the database, so any printable ASCII is taken but what could break out of
 * a quoted value: no control character, space, double or single quote, angle bracket or
 * backslash. At most 2,048 characters.
 */
function clientSecret(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && v.length <= 2048 && /^[!#-&(-;=?-\[\]-~]+$/.test(v);
}

/**
 * Records that an answer of Stripe was refused for its shape: which call and which field, never
 * the value. One audit row, a billing problem for the admin, so a refused real answer is never
 * only "the payment service did not answer". A failure to record changes nothing.
 */
async function refused(deps: Deps, call: string, field: string, workspaceId: string | null = null): Promise<void> {
  try {
    await deps.db.batch([auditStatement(deps, { event: "billing_answer_refused", workspaceId, detail: { call, field } })]);
  } catch {
    // The answer stays refused either way.
  }
}

type CheckoutNow = { status: "open"; secret: string | null } | { status: "complete"; body: Obj } | { status: "expired" };

/** What Stripe says of a checkout now (GET), or null when it gave no definite answer. */
async function checkoutNow(deps: Deps, sessionId: string): Promise<CheckoutNow | null> {
  if (deps.stripe === undefined) return null;
  try {
    const a = await deps.stripe.call("GET", `/v1/checkout/sessions/${sessionId}`);
    if (a.status !== 200 || !isObj(a.body) || a.body.id !== sessionId) return null;
    if (a.body.status === "complete") return { status: "complete", body: a.body };
    if (a.body.status === "expired") return { status: "expired" };
    if (a.body.status === "open") {
      if (clientSecret(a.body.client_secret)) return { status: "open", secret: a.body.client_secret };
      // None given is Stripe's own choice; one of a shape refused is noted.
      if (a.body.client_secret !== null && a.body.client_secret !== undefined) await refused(deps, "checkout_read", "client_secret");
      return { status: "open", secret: null };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Closes a stored checkout before another is made: Stripe must say it expired. "replace" when
 * it did (now, or before); "paid" when Stripe says it is complete (its subscription is then read
 * back and linked to the workspace, as its notice would); "unknown" for any other answer, after
 * which no new checkout may be made.
 */
async function closeCheckout(deps: Deps, row: BillingRow, sessionId: string): Promise<"replace" | "paid" | "unknown"> {
  if (deps.stripe === undefined) return "unknown";
  try {
    const a = await deps.stripe.call("POST", `/v1/checkout/sessions/${sessionId}/expire`);
    if (a.status === 200 && isObj(a.body) && a.body.status === "expired") return "replace";
  } catch {
    // No answer: what Stripe holds is asked below.
  }
  const now = await checkoutNow(deps, sessionId);
  if (now?.status === "expired") return "replace";
  if (now?.status !== "complete") return "unknown";
  // Paid: link it as the completed notice would, so the payment is never left without its workspace.
  const subId = subscriptionNamedBy(now.body);
  if (subId !== null && now.body.client_reference_id === row.id && !(row.subscription !== null && row.subscription !== subId && isLive(row.status))) {
    const read = await readSubscription(deps, subId);
    if (read !== null && read !== "missing" && (row.customer === null || row.customer === read.customer)) await storeSubscription(deps, null, row, read, sessionId);
  }
  return "paid";
}

function alreadySubscribed(): Response {
  return apiError(409, "already_subscribed", "the workspace already has a subscription; manage it on Stripe's page");
}

/** Whether this checkout id is one this site made for this workspace (one call). */
async function ownCheckout(deps: Deps, workspaceId: string, id: string): Promise<boolean> {
  return (await deps.db.first("SELECT 1 AS own FROM stripe_checkout WHERE id = ? AND workspace_id = ?", [id, workspaceId])) !== null;
}

export function billingRoutes(app: Hono, deps: Deps): void {
  if (!billingConfigured(deps.config)) return;

  /**
   * GET /api/v1/billing: where the session's own workspace stands, for the dashboard's notice,
   * the Account page's Billing section and the page a person comes back to from Stripe. It
   * grants nothing. A live status not confirmed for too long is read back from Stripe first.
   * With `?session_id=<checkout>` (the return page, which Stripe sends back with the checkout's
   * id) it is counted (LIMITS_BILLING.checkoutState) and also answers `checkout`: what Stripe
   * says of that checkout now ("open", "complete", "expired", or "unknown" when it gave no
   * definite answer), only for a checkout this site made for this workspace; for any other id,
   * another workspace's included, it is null and Stripe is not asked, exactly as for an id that
   * never existed.
   */
  app.get(BILLING_PATHS.state, async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    const asked = c.req.query("session_id");
    const plain = await hitLimit(deps, LIMITS_BILLING.state, await workspaceKey(auth.workspaceId));
    if (plain.over) return tooMany(plain.retryAfterSeconds);
    if (asked !== undefined) {
      const limit = await hitLimit(deps, LIMITS_BILLING.checkoutState, await workspaceKey(auth.workspaceId));
      if (limit.over) return tooMany(limit.retryAfterSeconds);
    }
    const read = await billingRowOf(deps, auth.workspaceId);
    if (read === null) return apiError(404, "not_found", "no such workspace");
    const { row, standing } = await trusted(deps, read);
    const usage = await usageOf(deps, auth.workspaceId);
    const now = deps.now();
    let checkout: string | null = null;
    if (asked !== undefined && idOf(asked, "checkout") !== null && (await ownCheckout(deps, auth.workspaceId, asked))) {
      checkout = (await checkoutNow(deps, asked))?.status ?? "unknown";
    }
    const removal = await removalShown(deps, row, standing, auth.session?.userId ?? "", now);
    return json(200, { ...stateAnswer(standing, row, now, usage.used, usage.allowance, removal), checkout });
  });

  /**
   * POST /api/v1/billing/checkout: an embedded Stripe Checkout Session for the session's own
   * workspace, answered as { client_secret, publishable_key } for the Subscribe page to mount
   * Stripe's form with (the secret only to this session, never logged, stored or put in an
   * address; the publishable key is public). Counted per workspace (LIMITS_BILLING.checkout).
   * Refused when the workspace has a live subscription.
   *
   * The checkout stored last is offered again while Stripe holds it open with a client secret
   * and CHECKOUT_REUSE_MARGIN_MS of its life is left. Otherwise it is closed first
   * (closeCheckout): only when Stripe confirms it expired is a new one made; one Stripe says is
   * paid is linked and answered already_subscribed; anything else answers 502 and makes none.
   * Two presses at the same moment send the same Idempotency-Key and get the same checkout. A
   * new checkout is recorded in stripe_checkout for the workspace, then stored as its pending
   * one only while the record is still as it was read and has no live subscription, before the
   * answer; one that lost that race is expired at Stripe and answers 409 (its record stays, so
   * should it be paid anyway its notice still finds the workspace).
   */
  app.post(BILLING_PATHS.checkout, async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return json(401, { error: "unauthorized" });
    const settings = deps.config.billing!;
    const stripe = deps.stripe;
    const origin = appOrigin(deps);
    if (stripe === undefined || origin === null) return stripeUnavailable();
    const limit = await hitLimit(deps, LIMITS_BILLING.checkout, await workspaceKey(auth.workspaceId));
    if (limit.over) return tooMany(limit.retryAfterSeconds);
    const row = await rowWithEmail(deps, auth.workspaceId, auth.session.userId);
    if (row === null) return apiError(404, "not_found", "no such workspace");
    if (isLive(row.status)) return alreadySubscribed();

    const now = deps.now();
    if (row.checkout_session !== null) {
      if (row.checkout_expires_at !== null && now < row.checkout_expires_at - CHECKOUT_REUSE_MARGIN_MS) {
        const open = await checkoutNow(deps, row.checkout_session);
        if (open?.status === "open" && open.secret !== null) return json(200, { client_secret: open.secret, publishable_key: settings.publishableKey });
      }
      const closed = await closeCheckout(deps, row, row.checkout_session);
      if (closed === "paid") return alreadySubscribed();
      if (closed === "unknown") return stripeUnavailable();
    }

    // Stripe takes whole seconds; on a minute's boundary, so two presses in one minute send one key.
    const expiresAt = Math.floor(now / 60_000) * 60 + CHECKOUT_LIFE_S;
    const form: [string, string][] = [
      ["mode", "subscription"],
      ["line_items[0][price]", settings.priceId],
      ["line_items[0][quantity]", "1"],
      ["managed_payments[enabled]", "true"],
      ["ui_mode", "embedded_page"],
      // Stripe puts the checkout's id in place of the braces when it sends the person back.
      ["return_url", `${origin}${RETURN_PATH}?session_id={CHECKOUT_SESSION_ID}`],
      ["expires_at", String(expiresAt)],
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
    if (created.status !== 200 || !isObj(b)) return stripeUnavailable();
    if (sessionId === null || !clientSecret(b.client_secret)) {
      await refused(deps, "checkout_create", sessionId === null ? "id" : "client_secret", auth.workspaceId);
      return stripeUnavailable();
    }
    const secret = b.client_secret;

    // Recorded first, whatever happens next: this record is how its completed notice finds the workspace.
    await deps.db.run("INSERT INTO stripe_checkout (id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING", [sessionId, auth.workspaceId, now, expiresAt * 1000]);
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
      try {
        await stripe.call("POST", `/v1/checkout/sessions/${sessionId}/expire`);
      } catch {
        // Best effort: it expires by itself, and its record still finds the workspace if paid.
      }
      return apiError(409, "checkout_pending", "another checkout for this workspace was started at the same moment; reload the page");
    }
    return json(200, { client_secret: secret, publishable_key: settings.publishableKey });
  });

  /**
   * POST /api/v1/billing/portal: a Stripe customer portal session for the customer on the
   * session's own workspace's record, answered as { url }; it comes back to the Account page.
   * Counted per workspace (LIMITS_BILLING.portal).
   */
  app.post(BILLING_PATHS.portal, async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    const stripe = deps.stripe;
    const origin = appOrigin(deps);
    if (stripe === undefined || origin === null) return stripeUnavailable();
    const limit = await hitLimit(deps, LIMITS_BILLING.portal, await workspaceKey(auth.workspaceId));
    if (limit.over) return tooMany(limit.retryAfterSeconds);
    const row = await billingRowOf(deps, auth.workspaceId);
    if (row === null) return apiError(404, "not_found", "no such workspace");
    if (row.customer === null) return apiError(409, "no_subscription", "the workspace has no subscription to manage");
    let answer;
    try {
      answer = await stripe.call("POST", "/v1/billing_portal/sessions", [
        ["customer", row.customer],
        ["return_url", `${origin}/account`],
      ]);
    } catch {
      return stripeUnavailable();
    }
    if (answer.status !== 200 || !isObj(answer.body)) return stripeUnavailable();
    if (!stripePage(answer.body.url, "billing.stripe.com")) {
      await refused(deps, "portal_create", "url", auth.workspaceId);
      return stripeUnavailable();
    }
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
    if (!isObj(event) || typeof event.type !== "string" || idOf(event.id, "event") === null || !isObj(event.data) || !isObj(event.data.object)) {
      // Signed by Stripe, yet of a shape not taken: noted, so it can be looked at.
      await refused(deps, "notice", !isObj(event) ? "body" : typeof event.type !== "string" ? "type" : idOf(event.id, "event") === null ? "id" : "data");
      return listenerRefused();
    }
    return handleNotice(deps, event.id as string, event.type, event.data.object);
  });
}

// ---- The listener's work ----

/** The workspace row whose column holds this Stripe id, or null. */
async function workspaceBy(deps: Deps, column: "stripe_customer_id" | "stripe_subscription_id", id: string): Promise<BillingRow | null> {
  return deps.db.first<BillingRow>(`SELECT ${BILLING_COLUMNS_SQL} FROM workspace WHERE workspace.${column} = ?`, [id]);
}

/** The workspace a checkout this site made belongs to (stripe_checkout), or null. */
async function workspaceOfCheckout(deps: Deps, checkout: string): Promise<BillingRow | null> {
  return deps.db.first<BillingRow>(`SELECT ${BILLING_COLUMNS_SQL} FROM workspace WHERE workspace.id = (SELECT c.workspace_id FROM stripe_checkout c WHERE c.id = ?)`, [checkout]);
}

/** How recent a subscription must be, by its own `created`, for its notice to be held for a checkout's. */
export const HOLD_RECENT_MS = 2 * 60 * 60 * 1000;
/** How long after a checkout expired a subscription made then may still be its. */
const HOLD_AFTER_EXPIRY_MS = 10 * 60 * 1000;

/**
 * Whether a notice of a subscription that is not linked may be one a checkout's notice will link
 * soon, and so is held (answered 500, for Stripe to send it again). Only when the subscription
 * was made, by its own `created`, within HOLD_RECENT_MS of now, and: for a customer on a
 * workspace's record, that workspace has a pending checkout; for a customer unknown here, a
 * checkout of this site was made at or before that time and had not expired more than
 * HOLD_AFTER_EXPIRY_MS before it. Every other unlinked notice is taken at once.
 */
async function mayBeOfAPendingCheckout(deps: Deps, obj: Obj, owner: BillingRow | null): Promise<boolean> {
  const created = msOf(obj.created);
  if (created === null || Math.abs(deps.now() - created) > HOLD_RECENT_MS) return false;
  if (owner !== null) return owner.checkout_session !== null;
  const found = await deps.db.first("SELECT 1 AS near FROM stripe_checkout WHERE created_at <= ? AND expires_at > ? LIMIT 1", [created, created - HOLD_AFTER_EXPIRY_MS]);
  return found !== null;
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

/**
 * Reads back the workspace's own subscription (the one on its record) and stores it; with no
 * subscription on record, records the notice only. A subscription Stripe no longer has is
 * stored as ended now.
 */
async function readBackOwn(deps: Deps, eventId: string, row: BillingRow, audit: Stmt | null): Promise<Response> {
  if (row.subscription === null) return recordOnly(deps, eventId, audit);
  const read = await readSubscription(deps, row.subscription);
  if (read === null) return listenerRetry();
  const sub = read === "missing" ? goneSubscription(row, deps.now()) : read;
  if (sub === null) return recordOnly(deps, eventId, audit);
  // The customer Stripe names must be the one on record: anything else changes nothing.
  if (row.customer !== null && sub.customer !== row.customer) return recordOnly(deps, eventId, mismatch(deps, row.id, "customer_differs"));
  return answerFor(deps, eventId, row, await storeSubscription(deps, eventId, row, sub, null, audit));
}

const ACTED = [
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

/**
 * One verified notice. A notice already recorded answers 200 and does nothing. The notice is
 * recorded in the same batch as what it changed, so one answered 500 (a read that failed, a
 * write whose read went stale, a subscription not linked yet) is not recorded and is taken
 * again when Stripe resends it.
 */
async function handleNotice(deps: Deps, eventId: string, type: string, obj: Obj): Promise<Response> {
  if (!ACTED.includes(type)) return listenerTaken();
  if ((await deps.db.first("SELECT 1 AS seen FROM stripe_event WHERE id = ?", [eventId])) !== null) return listenerTaken();

  if (type.startsWith("checkout.session.")) {
    const checkout = idOf(obj.id, "checkout");
    if (checkout === null) return recordOnly(deps, eventId, null);
    const row = await workspaceOfCheckout(deps, checkout);
    if (row === null) {
      // No checkout of this site: nothing is granted. When its customer is on a workspace's
      // record, that workspace is told in its audit record; nothing of it changes.
      const customer = idOf(obj.customer, "customer");
      const owner = customer === null ? null : await workspaceBy(deps, "stripe_customer_id", customer);
      return recordOnly(deps, eventId, auditStatement(deps, { event: "billing_checkout_unmatched", workspaceId: owner?.id ?? null, detail: { live: owner !== null && isLive(owner.status) ? 1 : 0 } }));
    }
    const paid = type !== "checkout.session.async_payment_failed" && obj.payment_status === "paid";
    if (obj.client_reference_id !== row.id) return recordOnly(deps, eventId, mismatch(deps, row.id, "reference_differs", paid));
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
    if (sub === null || sub === "missing") return listenerRetry();
    const named = idOf(obj.customer, "customer");
    if ((named !== null && named !== sub.customer) || (row.customer !== null && row.customer !== sub.customer)) return recordOnly(deps, eventId, mismatch(deps, row.id, "customer_differs", paid));
    return answerFor(deps, eventId, row, await storeSubscription(deps, eventId, row, sub, checkout), paid);
  }

  if (type.startsWith("customer.subscription.")) {
    const subId = idOf(obj.id, "subscription");
    if (subId === null) return recordOnly(deps, eventId, null);
    const row = await workspaceBy(deps, "stripe_subscription_id", subId);
    if (row === null) {
      // Not linked (yet): a subscription is linked by its checkout alone. While a checkout is
      // pending, this may be its subscription with the checkout's notice still to come: it is
      // answered 500 so it comes back after that. Otherwise one of a customer on record is noted
      // against that workspace, and changes nothing.
      const customer = idOf(obj.customer, "customer");
      const owner = customer === null ? null : await workspaceBy(deps, "stripe_customer_id", customer);
      if (await mayBeOfAPendingCheckout(deps, obj, owner)) return listenerRetry();
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

// ---- Deleting an account ----

/** The most calls one open checkout's settling may take: its expire, its read, its subscription's cancel and read, and the record. */
const CALLS_PER_CHECKOUT = 6;

/**
 * Cancels a subscription at Stripe at once (DELETE /v1/subscriptions/<id>: no proration, no
 * refund). The subscription as Stripe has it after, "missing" when Stripe says there is none,
 * or null when there was no definite answer that it is ended.
 */
async function cancelAtStripe(deps: Deps, id: string): Promise<Subscription | "missing" | null> {
  if (deps.stripe === undefined) return null;
  try {
    const a = await deps.stripe.call("DELETE", `/v1/subscriptions/${id}`);
    if (isMissing(a.status, a.body)) return "missing";
    if (a.status === 200 && isObj(a.body)) {
      const sub = subscriptionOf(a.body, id);
      if (sub !== null && isEnded(sub.status)) return sub;
    }
  } catch {
    // No answer: asked again below.
  }
  const read = await readSubscription(deps, id);
  return read === "missing" || (read !== null && isEnded(read.status)) ? read : null;
}

/**
 * Settles one open checkout of a workspace being deleted: it must be closed at Stripe first.
 * Stripe says it expired (now or before), or has no such checkout: done. Stripe says it was
 * paid: its subscription is cancelled first (cancelAtStripe). Anything else: "failed".
 */
async function settleCheckout(deps: Deps, workspaceId: string, adminId: string, id: string, own: string | null): Promise<"ok" | "failed"> {
  if (deps.stripe === undefined) return "failed";
  let state: "expired" | "complete" | "missing" | null = null;
  let body: Obj | null = null;
  try {
    const a = await deps.stripe.call("POST", `/v1/checkout/sessions/${id}/expire`);
    if (a.status === 200 && isObj(a.body) && a.body.status === "expired") state = "expired";
    else if (isMissing(a.status, a.body)) state = "missing";
  } catch {
    // No answer: what Stripe holds is asked below.
  }
  if (state === null) {
    try {
      const a = await deps.stripe.call("GET", `/v1/checkout/sessions/${id}`);
      if (isMissing(a.status, a.body)) state = "missing";
      else if (a.status === 200 && isObj(a.body) && a.body.id === id && (a.body.status === "expired" || a.body.status === "complete")) {
        state = a.body.status;
        body = a.body;
      }
    } catch {
      // No answer: failed below.
    }
  }
  if (state === null) return "failed";
  if (state === "complete") {
    const sub = body === null ? null : subscriptionNamedBy(body);
    // The workspace's own subscription is cancelled already (prepareDeletion); any other is cancelled here.
    if (sub !== null && sub !== own) {
      const cancelled = await cancelAtStripe(deps, sub);
      if (cancelled === null) return "failed";
      await deps.db.batch([auditStatement(deps, { event: "billing_cancelled_for_deletion", userId: adminId, workspaceId, detail: { checkout: 1 } })]);
    }
  }
  // Settled: it is no longer open, so a later delete request does not ask again.
  await deps.db.run("UPDATE stripe_checkout SET expires_at = min(expires_at, ?) WHERE id = ? AND workspace_id = ?", [deps.now(), id, workspaceId]);
  return "ok";
}

/**
 * Before an account and its workspace are deleted (src/account-removal.ts, after the removal is
 * recorded, so the account can no longer be enabled meanwhile): the workspace's subscription is
 * cancelled at Stripe, at once, and stored as ended with an audit row; then every checkout of it
 * that has not expired is closed at Stripe (settleCheckout), within the calls `room` allows.
 * "ok" when all is settled (and at once, with no call, without billing); "more" when checkouts
 * are left for the next request; "failed" when Stripe gave no definite answer, and then nothing
 * may be deleted.
 */
export async function prepareDeletion(deps: Deps, workspaceId: string, adminId: string, room: (cost: number) => boolean): Promise<"ok" | "more" | "failed"> {
  if (!billingConfigured(deps.config)) return "ok";
  const row = await billingRowOf(deps, workspaceId);
  if (row === null) return "ok";
  if (row.subscription !== null && !isEnded(row.status)) {
    if (!room(4)) return "more";
    const cancelled = await cancelAtStripe(deps, row.subscription);
    if (cancelled === null) return "failed";
    if (cancelled === "missing") {
      await deps.db.run("UPDATE workspace SET subscription_status = 'canceled', subscription_ended_at = coalesce(subscription_ended_at, ?) WHERE id = ? AND stripe_subscription_id = ?", [deps.now(), workspaceId, row.subscription]);
    } else {
      await deps.db.batch([
        {
          sql: "UPDATE workspace SET subscription_status = ?, subscription_ended_at = ? WHERE id = ? AND stripe_subscription_id = ?",
          params: [cancelled.status, cancelled.endedAt ?? deps.now(), workspaceId, row.subscription],
        },
        auditStatement(deps, { event: "billing_cancelled_for_deletion", userId: adminId, workspaceId }, { onlyAfterOneChange: true }),
      ]);
    }
  }
  if (!room(1)) return "more";
  const open = await deps.db.all<{ id: string }>("SELECT id FROM stripe_checkout WHERE workspace_id = ? AND expires_at > ? ORDER BY id LIMIT 20", [workspaceId, deps.now()]);
  for (const c of open) {
    if (!room(CALLS_PER_CHECKOUT)) return "more";
    if ((await settleCheckout(deps, workspaceId, adminId, c.id, row.subscription)) === "failed") return "failed";
  }
  return open.length === 20 ? "more" : "ok";
}

/**
 * The audit rows that are billing problems: a paid checkout no workspace stored, a second paid
 * subscription of one workspace, and a paid checkout that named a workspace's checkout but not
 * its reference or its customer (customer_taken, customer_differs, reference_differs). Each is
 * money taken without access, for the admin to look at in Stripe.
 */
const PROBLEM = "(event IN ('billing_checkout_unmatched', 'billing_second_subscription', 'billing_answer_refused') OR (event = 'billing_checkout_mismatch' AND json_extract(detail, '$.paid') = 1))";

/** The billing problems the site's admin should look at: the count, and the newest rows (event, workspace, time). */
export async function billingProblems(deps: Deps): Promise<{ count: number; recent: { event: string; workspace_id: string | null; at: number }[] }> {
  const rows = await deps.db.all<{ event: string; workspace_id: string | null; at: number; n: number }>(
    `SELECT event, workspace_id, at, (SELECT count(*) FROM audit WHERE ${PROBLEM}) AS n FROM audit WHERE ${PROBLEM} ORDER BY at DESC, id LIMIT ?`,
    [BILLING_PROBLEMS_LISTED],
  );
  return { count: rows[0]?.n ?? 0, recent: rows.map((r) => ({ event: r.event, workspace_id: r.workspace_id, at: r.at })) };
}

// ---- The configured price ----

export type PriceCheck = "ok" | "could_not_check" | "missing" | "not_checked";
/** What the check found, per pair of key and price, for the life of the process (or the Worker's isolate). Held in memory only. */
const priceChecks = new Map<string, PriceCheck>();
const priceKey = (b: BillingSettings) => `${b.priceId}\u0000${b.apiKey}`;

/** What checkPrice found for these settings, or "not_checked". */
export function priceCheckOf(config: { billing?: BillingSettings | null }): PriceCheck {
  return config.billing === undefined || config.billing === null ? "not_checked" : (priceChecks.get(priceKey(config.billing)) ?? "not_checked");
}

/**
 * Asks Stripe once for the configured price with the configured key (GET /v1/prices/<id>): it
 * proves the key belongs to the account that owns the price. "ok" when Stripe answers it;
 * "missing" when Stripe says there is no such price (a start-up error, naming the two settings);
 * "could_not_check" for anything else, a key that may not read prices or no answer, which does
 * not stop the site. The Node server asks at its start, the Worker on its first request.
 */
export async function checkPrice(deps: Deps): Promise<PriceCheck> {
  const billing = deps.config.billing;
  if (billing === undefined || billing === null || deps.stripe === undefined) return "not_checked";
  let found: PriceCheck = "could_not_check";
  try {
    const a = await deps.stripe.call("GET", `/v1/prices/${billing.priceId}`);
    if (a.status === 200 && isObj(a.body) && a.body.id === billing.priceId) found = "ok";
    else if (isMissing(a.status, a.body)) found = "missing";
  } catch {
    // No answer: could not be checked.
  }
  priceChecks.set(priceKey(billing), found);
  return found;
}

/** The start-up line for a price Stripe says does not exist. Fixed text: it names the settings, never a value. */
export const PRICE_MISSING = "billing: Stripe has no price STRIPE_PRICE_ID names that STRIPE_API_KEY can see. Use the id of a price of the same Stripe account, in the same mode as the key.";
