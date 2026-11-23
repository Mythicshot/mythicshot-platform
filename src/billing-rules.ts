// The rules of billing (0.1.57, Plan 2l items 1 to 3 and 9): the three settings that switch
// it on, the plan's and the trial's allowances, and where a workspace stands. Pure: it imports
// nothing, so src/usage.ts (which every upload loads) and the settings of both targets can use
// it whatever the order the modules load in. The routes are in src/billing.ts.
//
// Billing exists only when all four settings are present: STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_ID and STRIPE_PUBLISHABLE_KEY. With any of them missing `config.billing` is absent, and nothing in this
// file changes anything: the allowance is the one of the version before it, byte for byte, no
// route of src/billing.ts is registered, and no workspace is ever read-only.
//
// With billing on, a workspace stands in one of these places (standingOf):
// - exempt: an account of the site's admin, or a workspace that existed before migration 0021
//   (its `billing_existing` marker, set by that migration): the site's default allowance, no
//   trial, no notice, never read-only, exactly as before billing.
// - subscribed: Stripe says `active`, `trialing` or `past_due` (Stripe retries a failed renewal
//   and the account keeps working meanwhile). The allowance is PLAN_BYTES. With a cancellation
//   on record it is "ending" on the dashboard, and still subscribed until then.
// - ended: Stripe says `canceled`, `unpaid` or `incomplete_expired`. Read-only at once: view,
//   download and delete work; upload, publish and share are refused (src/billing.ts,
//   readOnlyRefusal). The allowance stays PLAN_BYTES, so the content it holds is never "over".
// - trial: no subscription that ever went live (none at all, or one Stripe still calls
//   `incomplete` or `paused`): TRIAL_BYTES for TRIAL_MS from the workspace's creation.
// - trial_over: the same, past TRIAL_MS: read-only like an ended subscription. Removing anything
//   is the next slice, and nothing here deletes, unpublishes or mails.
// An allowance an admin set by hand (workspace.storage_allowance_bytes) always wins over both the
// trial's and the plan's; without a live subscription such a workspace is also exempt (room given
// without a payment: no trial clock, never read-only).

/** The dashboard's two billing pages (src/dash/billing.ts): Subscribe, and where Stripe sends a person back. */
export const SUBSCRIBE_PATH = "/billing/subscribe";
export const RETURN_PATH = "/billing/return";

/** The plan's name, as the approved screens write it. */
export const PLAN_NAME = "Mythicshot Essentials";
/** 5 GiB: the allowance of a subscribed workspace, so "5 GB" on the dashboard is never less. */
export const PLAN_BYTES = 5_368_709_120;
/** 100 MB (1024 × 1024 × 100): the allowance of a workspace on its trial. */
export const TRIAL_BYTES = 104_857_600;

const DAY_MS = 86_400_000;
/** How long the trial lasts, from the workspace's creation. */
export const TRIAL_MS = 90 * DAY_MS;
/** How long a lapsed workspace's links stay up after its subscription ended (shown only; the next slice acts on it). */
export const LINKS_GRACE_MS = 30 * DAY_MS;
/** How long after a subscription ended its content is removed (shown only; the next slice acts on it). */
export const REMOVAL_MS = 90 * DAY_MS;
export const DAY = DAY_MS;

/** Stripe's subscription statuses in which the workspace has the plan. */
export const LIVE_STATUSES = ["active", "trialing", "past_due"] as const;
/** Stripe's subscription statuses that end it: the workspace is read-only. */
export const ENDED_STATUSES = ["canceled", "unpaid", "incomplete_expired"] as const;
/** Every status migration 0021 takes: the live and ended ones, and the two that are neither. */
export const STRIPE_STATUSES = [...LIVE_STATUSES, ...ENDED_STATUSES, "incomplete", "paused"] as const;
export type StripeStatus = (typeof STRIPE_STATUSES)[number];

/**
 * The four settings, as checked at the start. The key and the signing secret are never logged,
 * answered or put in an error; the publishable key is public by design (Stripe's page in the
 * browser needs it) and is handed to the Subscribe page by the checkout route.
 */
export type BillingSettings = { apiKey: string; webhookSecret: string; priceId: string; publishableKey: string };

/** The names of the four settings, in the order they are checked. */
export const BILLING_SETTINGS = ["STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "STRIPE_PUBLISHABLE_KEY"] as const;

const SHAPES: Record<(typeof BILLING_SETTINGS)[number], { test: (v: string) => boolean; says: string }> = {
  STRIPE_API_KEY: { test: (v) => v.startsWith("rk_") || v.startsWith("sk_"), says: "a Stripe key, which starts with rk_ (a restricted key) or sk_" },
  STRIPE_WEBHOOK_SECRET: { test: (v) => v.startsWith("whsec_"), says: "the listener's signing secret, which starts with whsec_" },
  STRIPE_PRICE_ID: { test: (v) => v.startsWith("price_"), says: "the id of a Stripe price, which starts with price_" },
  STRIPE_PUBLISHABLE_KEY: { test: (v) => v.startsWith("pk_"), says: "a Stripe publishable key, which starts with pk_" },
};

/**
 * The billing settings from the three raw values. Each is trimmed. A value that is unset,
 * empty or only spaces is missing; with any one missing billing is off (`billing` null) and
 * nothing else is said. A value that is present but not of its shape (or not text at all) is a
 * problem: one fixed line that names the setting and never repeats its value, for the entry to
 * refuse to start with. Nothing about a key is checked but its prefix.
 */
export function billingFromSettings(raw: Partial<Record<(typeof BILLING_SETTINGS)[number], unknown>>): { ok: true; billing: BillingSettings | null } | { ok: false; problem: string } {
  const values: Partial<Record<(typeof BILLING_SETTINGS)[number], string>> = {};
  for (const name of BILLING_SETTINGS) {
    const v = raw[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { ok: false, problem: `billing: ${name} is not ${SHAPES[name].says}. Fix it, or remove all four Stripe settings to run without billing.` };
    const text = v.trim();
    if (text === "") continue;
    if (!SHAPES[name].test(text)) return { ok: false, problem: `billing: ${name} is not ${SHAPES[name].says}. Fix it, or remove all four Stripe settings to run without billing.` };
    values[name] = text;
  }
  const { STRIPE_API_KEY: apiKey, STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_PRICE_ID: priceId, STRIPE_PUBLISHABLE_KEY: publishableKey } = values;
  if (apiKey === undefined || webhookSecret === undefined || priceId === undefined || publishableKey === undefined) return { ok: true, billing: null };
  return { ok: true, billing: { apiKey, webhookSecret, priceId, publishableKey } };
}

/** True when the config has billing switched on. */
export function billingConfigured(config: { billing?: BillingSettings | null }): boolean {
  return config.billing !== undefined && config.billing !== null;
}

const quoted = (list: readonly string[]) => list.map((s) => `'${s}'`).join(", ");

/**
 * Whether the row of `workspace` in scope belongs to the site's admin: an account of it is an
 * admin. A scalar expression that takes no parameter.
 */
export const WORKSPACE_IS_ADMIN_SQL =
  "EXISTS (SELECT 1 FROM membership bm JOIN user bu ON bu.id = bm.user_id WHERE bm.workspace_id = workspace.id AND bu.is_admin = 1)";

/**
 * The allowance of the row of `workspace` in scope, taking one parameter, the site's default.
 * Without billing it is the text of the version before billing exactly. With billing: the
 * workspace's own number, else for an exempt workspace the site's default, for a subscription
 * that is live or ended the plan, else the trial's.
 */
export function allowanceSqlOf(config: { billing?: BillingSettings | null }): string {
  if (!billingConfigured(config)) return "coalesce(workspace.storage_allowance_bytes, ?)";
  return (
    "coalesce(workspace.storage_allowance_bytes, CASE" +
    ` WHEN workspace.billing_existing = 1 OR ${WORKSPACE_IS_ADMIN_SQL} THEN ?` +
    ` WHEN workspace.subscription_status IN (${quoted([...LIVE_STATUSES, ...ENDED_STATUSES])}) THEN ${PLAN_BYTES}` +
    ` ELSE ${TRIAL_BYTES} END)`
  );
}

/** The billing columns of a workspace row, as BILLING_COLUMNS_SQL reads them. */
export type BillingRow = {
  id: string;
  created_at: number;
  existing: number;
  admin: number;
  own_allowance: number | null;
  customer: string | null;
  subscription: string | null;
  status: string | null;
  period_end: number | null;
  cancel_at: number | null;
  cancel_at_period_end: number;
  ended_at: number | null;
  checkout_session: string | null;
  checkout_created_at: number | null;
};

/** The columns of BillingRow, over the row `workspace` in scope. They take no parameter. */
export const BILLING_COLUMNS_SQL =
  "workspace.id AS id, workspace.created_at AS created_at, workspace.billing_existing AS existing, " +
  `${WORKSPACE_IS_ADMIN_SQL} AS admin, workspace.storage_allowance_bytes AS own_allowance, ` +
  "workspace.stripe_customer_id AS customer, workspace.stripe_subscription_id AS subscription, workspace.subscription_status AS status, " +
  "workspace.subscription_period_end AS period_end, workspace.subscription_cancel_at AS cancel_at, " +
  "workspace.subscription_cancel_at_period_end AS cancel_at_period_end, workspace.subscription_ended_at AS ended_at, " +
  "workspace.checkout_session_id AS checkout_session, workspace.checkout_created_at AS checkout_created_at";

export type Standing =
  | { kind: "exempt" }
  | { kind: "trial"; endsAt: number }
  | { kind: "trial_over"; endedAt: number }
  | { kind: "subscribed"; pastDue: boolean; periodEnd: number | null; endsAt: number | null }
  | { kind: "ended"; endedAt: number };

export function isLive(status: string | null): boolean {
  return status !== null && (LIVE_STATUSES as readonly string[]).includes(status);
}

export function isEnded(status: string | null): boolean {
  return status !== null && (ENDED_STATUSES as readonly string[]).includes(status);
}

/** Where a workspace stands at `now` (see the top of this file). */
export function standingOf(row: BillingRow, now: number): Standing {
  if (row.existing === 1 || row.admin === 1) return { kind: "exempt" };
  if (isLive(row.status)) {
    const endsAt = row.cancel_at !== null ? row.cancel_at : row.cancel_at_period_end === 1 ? row.period_end : null;
    return { kind: "subscribed", pastDue: row.status === "past_due", periodEnd: row.period_end, endsAt };
  }
  // An allowance an admin set by hand is room given without a payment: with no live
  // subscription the workspace is treated as before billing (no trial clock, never read-only).
  if (row.own_allowance !== null) return { kind: "exempt" };
  if (isEnded(row.status)) return { kind: "ended", endedAt: row.ended_at ?? row.cancel_at ?? row.period_end ?? now };
  const endsAt = row.created_at + TRIAL_MS;
  return now < endsAt ? { kind: "trial", endsAt } : { kind: "trial_over", endedAt: endsAt };
}

/** True where upload, publish and share are refused: an ended subscription or a trial that is over. */
export function isReadOnly(s: Standing): boolean {
  return s.kind === "ended" || s.kind === "trial_over";
}
