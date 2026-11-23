-- Billing (0.1.57, Plan 2l): the subscription state on the workspace, and the Stripe notices
-- already taken. Everything is additive: each new column is nullable or has a default, so rows
-- written before this migration stay valid and the statements of the version before it, which
-- name none of this, still run. Nothing is dropped, renamed or rebuilt.
--
-- The platform's own record is the source of truth for access (src/billing-rules.ts): it never
-- depends on Stripe still holding the data. Nothing here is a secret: Stripe's ids are not
-- credentials, and no key, signing secret, card or address is stored. A site without the three
-- Stripe settings never reads or writes any of it.
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here that
-- uses them also compares the length in bytes, length(CAST(x AS BLOB)), as in 0008.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- 1 for a workspace that existed before this migration: an account made before billing is not
-- put on the trial clock, and is treated as before (the site's default allowance, no notice,
-- never read-only). The one statement after it marks every row there is now; a workspace made
-- later gets the default, 0. A workspace an older build makes after this migration also gets 0.
ALTER TABLE workspace ADD COLUMN billing_existing INTEGER NOT NULL DEFAULT 0 CHECK (billing_existing IN (0, 1));
UPDATE workspace SET billing_existing = 1;

-- Stripe's customer for this workspace, set by the first completed checkout. Unique among the
-- workspaces that have one: a customer belongs to one workspace only.
ALTER TABLE workspace ADD COLUMN stripe_customer_id TEXT CHECK (stripe_customer_id IS NULL OR (length(CAST(stripe_customer_id AS BLOB)) = length(stripe_customer_id) AND length(stripe_customer_id) BETWEEN 5 AND 255 AND substr(stripe_customer_id, 1, 4) = 'cus_' AND substr(stripe_customer_id, 5) NOT GLOB '*[^A-Za-z0-9_]*'));

-- The subscription, and what Stripe said of it when it was last read back: its status, the end
-- of the paid period, when it is set to end (a time, or at the period's end), and when it ended.
-- Times are milliseconds, as everywhere in this schema.
ALTER TABLE workspace ADD COLUMN stripe_subscription_id TEXT CHECK (stripe_subscription_id IS NULL OR (length(CAST(stripe_subscription_id AS BLOB)) = length(stripe_subscription_id) AND length(stripe_subscription_id) BETWEEN 5 AND 255 AND substr(stripe_subscription_id, 1, 4) = 'sub_' AND substr(stripe_subscription_id, 5) NOT GLOB '*[^A-Za-z0-9_]*'));
ALTER TABLE workspace ADD COLUMN subscription_status TEXT CHECK (subscription_status IS NULL OR subscription_status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete_expired', 'incomplete', 'paused'));
ALTER TABLE workspace ADD COLUMN subscription_period_end INTEGER CHECK (subscription_period_end IS NULL OR subscription_period_end > 0);
ALTER TABLE workspace ADD COLUMN subscription_cancel_at INTEGER CHECK (subscription_cancel_at IS NULL OR subscription_cancel_at > 0);
ALTER TABLE workspace ADD COLUMN subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (subscription_cancel_at_period_end IN (0, 1));
ALTER TABLE workspace ADD COLUMN subscription_ended_at INTEGER CHECK (subscription_ended_at IS NULL OR subscription_ended_at > 0);

-- The checkout Subscribe started, stored before the person is sent to Stripe, and when. A
-- completed checkout finds its workspace by this id alone; it is cleared when it is taken.
ALTER TABLE workspace ADD COLUMN checkout_session_id TEXT CHECK (checkout_session_id IS NULL OR (length(CAST(checkout_session_id AS BLOB)) = length(checkout_session_id) AND length(checkout_session_id) BETWEEN 4 AND 255 AND substr(checkout_session_id, 1, 3) = 'cs_' AND substr(checkout_session_id, 4) NOT GLOB '*[^A-Za-z0-9_]*'));
ALTER TABLE workspace ADD COLUMN checkout_created_at INTEGER CHECK (checkout_created_at IS NULL OR checkout_created_at > 0);

CREATE UNIQUE INDEX workspace_stripe_customer ON workspace (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX workspace_stripe_subscription ON workspace (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX workspace_checkout_session ON workspace (checkout_session_id) WHERE checkout_session_id IS NOT NULL;

-- The Stripe notices taken, by their id, so a notice sent twice does its work once. A row is
-- written in the same batch as what the notice changed. It names no workspace.
CREATE TABLE stripe_event (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(id AS BLOB)) = length(id) AND length(id) BETWEEN 5 AND 255 AND substr(id, 1, 4) = 'evt_' AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_]*'),
  received_at INTEGER NOT NULL
) STRICT;
