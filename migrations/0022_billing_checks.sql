-- Billing's read-backs of a stale row (0.1.58): when the site last asked Stripe about a
-- workspace's subscription because the record looked stale, what came of it, and until when an
-- old period Stripe confirmed is trusted. Three columns on the workspace, each nullable, so rows
-- written before this migration stay valid and the statements of the versions before it, which
-- name none of them, still run. Nothing is dropped, renamed or rebuilt, and no row is changed.
-- A site without the Stripe settings never reads or writes them.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- When the last read-back of this workspace's subscription was tried, in milliseconds.
ALTER TABLE workspace ADD COLUMN billing_checked_at INTEGER CHECK (billing_checked_at IS NULL OR billing_checked_at > 0);
-- 1 when Stripe answered it, 0 when it could not be read: until the next try the workspace is then read-only for writes.
ALTER TABLE workspace ADD COLUMN billing_check_ok INTEGER CHECK (billing_check_ok IS NULL OR billing_check_ok IN (0, 1));
-- Until when Stripe's confirmation of a live status whose period ended long ago is trusted, in milliseconds.
ALTER TABLE workspace ADD COLUMN billing_confirmed_until INTEGER CHECK (billing_confirmed_until IS NULL OR billing_confirmed_until > 0);
