// The rules of billing (0.1.57, Plan 2l items 1, 2, 3 and 9): the four settings that switch it
// on, the plan's and the trial's allowances, and where a workspace stands. Pure: it imports
// nothing, so src/usage.ts (which every upload loads) and the settings of both targets can use
// it whatever the order the modules load in. The routes are in src/billing.ts.
//
// Billing exists only when all four settings are present: STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_ID and STRIPE_PUBLISHABLE_KEY. With any of them missing `config.billing` is
// absent, and nothing in this file changes anything: the allowance is the one of the version
// before it, byte for byte, no route of src/billing.ts is registered, and no workspace is ever
// read-only.
//
// With billing on, a workspace stands in one of these places (standingOf), in this order:
// - subscribed: Stripe says `active`, `trialing` or `past_due` (Stripe retries a failed renewal
//   and the account keeps working meanwhile). The allowance is PLAN_BYTES. A live subscription
//   wins over everything below, the exemptions included. With a cancellation on record it is
//   "ending" on the dashboard, and still subscribed until then. A live status whose stored
//   period ended more than STALE_MS ago is `stale`: it is read back from Stripe before it is
//   trusted (src/billing.ts), and while it cannot be read the workspace is read-only for writes.
// - exempt: a workspace made while billing was off (`billing_trial` 0: every workspace before
//   migration 0021, and every one a site without billing makes) or one of the site's admin: the
//   site's default allowance, no trial, no notice, never read-only, exactly as before billing.
//   So is a workspace with an allowance the admin set by hand that has never had a subscription
//   (room given without a payment).
// - ended: Stripe says `canceled`, `unpaid` or `incomplete_expired`. Read-only at once: view,
//   download and delete work; upload, publish, rename and widening who may view are refused
//   (src/billing.ts, readOnlyRefusal). The allowance stays PLAN_BYTES (or the admin's number),
//   so the content it holds is never "over".
// - trial: no subscription that ever went live (none at all, or one Stripe still calls
//   `incomplete` or `paused`): TRIAL_BYTES for TRIAL_MS from the workspace's creation.
// - trial_over: the same, past TRIAL_MS: read-only like an ended subscription. Removing anything
//   is the next slice, and nothing here deletes, unpublishes or mails.
// An allowance an admin set by hand (workspace.storage_allowance_bytes) is always the size, in
// every place above.

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
/** How long past its stored period's end a live status is trusted without asking Stripe again. */
export const STALE_MS = 3 * DAY_MS;
/** How long a read-back's outcome stands for a stale row before Stripe is asked again. */
export const HEAL_EVERY_MS = 60_000;
/** How long Stripe's confirmation of a live status with an old period end is trusted. */
export const CONFIRMED_FOR_MS = DAY_MS;

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
 * The billing settings from the four raw values. Each is trimmed. A value that is unset,
 * empty or only spaces is missing. With all four missing billing is off (`billing` null) and
 * nothing else is said; with some but not all, it is a problem naming the missing ones. The two
 * keys must be of one mode, both test or both live. A value that is present but not of its shape (or not text at all) is a
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
  const missing = BILLING_SETTINGS.filter((name) => values[name] === undefined);
  // None at all: billing is off, exactly as before billing existed.
  if (missing.length === BILLING_SETTINGS.length) return { ok: true, billing: null };
  if (apiKey === undefined || webhookSecret === undefined || priceId === undefined || publishableKey === undefined) {
    return { ok: false, problem: `billing: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Set all four Stripe settings to switch billing on, or none of them to leave it off.` };
  }
  const apiMode = keyMode(apiKey);
  if (apiMode === null || apiMode !== keyMode(publishableKey)) {
    return { ok: false, problem: "billing: STRIPE_API_KEY and STRIPE_PUBLISHABLE_KEY must both be test keys (rk_test_ or sk_test_ with pk_test_) or both live keys (rk_live_ or sk_live_ with pk_live_)." };
  }
  return { ok: true, billing: { apiKey, webhookSecret, priceId, publishableKey } };
}

/** The mode of a Stripe key from its prefix: test, live, or null when the prefix does not say. */
export function keyMode(key: string): "test" | "live" | null {
  if (/^(?:rk|sk|pk)_test_/.test(key)) return "test";
  if (/^(?:rk|sk|pk)_live_/.test(key)) return "live";
  return null;
}

/** True when both of the site's Stripe keys are test-mode keys (a Stripe sandbox). */
export function testKeys(billing: BillingSettings): boolean {
  return keyMode(billing.apiKey) === "test" && keyMode(billing.publishableKey) === "test";
}

/**
 * The statement that makes a workspace row. Without billing it is the statement of the version
 * before billing, byte for byte, so the workspace has `billing_trial` 0 (exempt, also if billing
 * is switched on later); with billing on the workspace is put on the trial clock.
 */
export function newWorkspaceStatement(deps: { config: { billing?: BillingSettings | null } }, id: string, name: string, now: number): { sql: string; params: (string | number)[] } {
  if (!billingConfigured(deps.config)) return { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", params: [id, name, now] };
  return { sql: "INSERT INTO workspace (id, name, created_at, billing_trial) VALUES (?, ?, ?, 1)", params: [id, name, now] };
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
 * workspace's own number, else the plan for a live subscription, the site's default for an
 * exempt workspace, the plan for an ended subscription, else the trial's.
 */
export function allowanceSqlOf(config: { billing?: BillingSettings | null }): string {
  if (!billingConfigured(config)) return "coalesce(workspace.storage_allowance_bytes, ?)";
  return (
    "coalesce(workspace.storage_allowance_bytes, CASE" +
    ` WHEN workspace.subscription_status IN (${quoted([...LIVE_STATUSES])}) THEN ${PLAN_BYTES}` +
    ` WHEN workspace.billing_trial = 0 OR ${WORKSPACE_IS_ADMIN_SQL} THEN ?` +
    ` WHEN workspace.subscription_status IN (${quoted([...ENDED_STATUSES])}) THEN ${PLAN_BYTES}` +
    ` ELSE ${TRIAL_BYTES} END)`
  );
}

/** The billing columns of a workspace row, as BILLING_COLUMNS_SQL reads them. */
export type BillingRow = {
  id: string;
  created_at: number;
  trial: number;
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
  checkout_expires_at: number | null;
  checked_at: number | null;
  check_ok: number | null;
  confirmed_until: number | null;
};

/** The columns of BillingRow, over the row `workspace` in scope. They take no parameter. */
export const BILLING_COLUMNS_SQL =
  "workspace.id AS id, workspace.created_at AS created_at, workspace.billing_trial AS trial, " +
  `${WORKSPACE_IS_ADMIN_SQL} AS admin, workspace.storage_allowance_bytes AS own_allowance, ` +
  "workspace.stripe_customer_id AS customer, workspace.stripe_subscription_id AS subscription, workspace.subscription_status AS status, " +
  "workspace.subscription_period_end AS period_end, workspace.subscription_cancel_at AS cancel_at, " +
  "workspace.subscription_cancel_at_period_end AS cancel_at_period_end, workspace.subscription_ended_at AS ended_at, " +
  "workspace.checkout_session_id AS checkout_session, workspace.checkout_created_at AS checkout_created_at, " +
  "(SELECT bc.expires_at FROM stripe_checkout bc WHERE bc.id = workspace.checkout_session_id AND bc.workspace_id = workspace.id) AS checkout_expires_at, " +
  "workspace.billing_checked_at AS checked_at, workspace.billing_check_ok AS check_ok, workspace.billing_confirmed_until AS confirmed_until";

export type Standing =
  | { kind: "exempt" }
  | { kind: "trial"; endsAt: number }
  | { kind: "trial_over"; endedAt: number }
  | { kind: "subscribed"; pastDue: boolean; periodEnd: number | null; endsAt: number | null; stale: boolean }
  | { kind: "ended"; endedAt: number };

export function isLive(status: string | null): boolean {
  return status !== null && (LIVE_STATUSES as readonly string[]).includes(status);
}

export function isEnded(status: string | null): boolean {
  return status !== null && (ENDED_STATUSES as readonly string[]).includes(status);
}

/** Where a workspace stands at `now` (see the top of this file). */
export function standingOf(row: BillingRow, now: number): Standing {
  if (isLive(row.status)) {
    const endsAt = row.cancel_at !== null ? row.cancel_at : row.cancel_at_period_end === 1 ? row.period_end : null;
    const stale = row.period_end !== null && row.period_end < now - STALE_MS && !(row.confirmed_until !== null && row.confirmed_until > now);
    return { kind: "subscribed", pastDue: row.status === "past_due", periodEnd: row.period_end, endsAt, stale };
  }
  if (row.trial === 0 || row.admin === 1) return { kind: "exempt" };
  // An allowance an admin set by hand is room given without a payment, for a workspace that
  // never had a subscription; once one existed, its end is read-only whatever the allowance.
  if (row.own_allowance !== null && row.subscription === null) return { kind: "exempt" };
  if (isEnded(row.status)) return { kind: "ended", endedAt: row.ended_at ?? row.cancel_at ?? row.period_end ?? now };
  const endsAt = row.created_at + TRIAL_MS;
  return now < endsAt ? { kind: "trial", endsAt } : { kind: "trial_over", endedAt: endsAt };
}

/** True where upload, publish and share are refused: an ended subscription, a trial that is over, or a live status not confirmed for too long. */
export function isReadOnly(s: Standing): boolean {
  return s.kind === "ended" || s.kind === "trial_over" || (s.kind === "subscribed" && s.stale);
}
