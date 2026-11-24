-- Removal after the trial or an ended subscription (0.1.61, Plan 2l items 7 and 8): the record
-- of each warning mail, and a mark on an account's removal once anything of it is removed.
-- Everything is additive: one new table and one nullable column, so rows written before this
-- migration stay valid and the statements of the versions before it, which name none of this,
-- still run. Nothing is dropped, renamed or rebuilt, and no existing row is changed. A site
-- without the Stripe settings never reads or writes the table.
--
-- 0023 is left free on purpose: another slice built at the same time may take it.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- One row per warning mail before a workspace's removal (src/billing-sweep.ts), written BEFORE
-- the mail is handed to the mail server (a claim, `sent_at` NULL) so two sweeps never send the
-- same mail, and completed with `sent_at` once the mail server accepted it. A mail that could
-- not be sent has its claim taken back, so nothing of it stays. A claim that was never completed
-- (the process stopped between the mail server's yes and the write) is never sent again and
-- holds the removal back for good: the sweep counts it for the admin.
--
-- `removal_at` is the removal date the clock gave when the mail was due (the first full UTC day
-- after the 90 days, src/removal-rules.ts): the key that makes "never twice for the same date".
-- When the date moves (the workspace subscribed and its subscription ended again), the rows of
-- the old date count for nothing and the warnings start over. `email_sha256` is the SHA-256 of
-- the address the mail went to, never the address: a changed address counts the rows of the old
-- one for nothing, so the warnings start over for the new one. `named_at` is the day the mail
-- named for the removal, which the removal never comes before.
--
-- No foreign key, so a build before this one can still delete the workspace (its last batch
-- names no such table); this build deletes the rows with the workspace (src/account-removal.ts).
CREATE TABLE billing_warning (
  workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) = 27 AND substr(workspace_id, 1, 3) = 'ws_' AND substr(workspace_id, 4) NOT GLOB '*[^0-9a-f]*'),
  removal_at INTEGER NOT NULL CHECK (removal_at > 0),
  stage INTEGER NOT NULL CHECK (stage IN (30, 7, 1)),
  email_sha256 TEXT NOT NULL CHECK (length(CAST(email_sha256 AS BLOB)) = 64 AND email_sha256 NOT GLOB '*[^0-9a-f]*'),
  claimed_at INTEGER NOT NULL CHECK (claimed_at > 0),
  sent_at INTEGER CHECK (sent_at IS NULL OR sent_at > 0),
  named_at INTEGER NOT NULL CHECK (named_at > 0),
  PRIMARY KEY (workspace_id, removal_at, stage, email_sha256)
) STRICT;

-- When a removal of the account (an admin's delete, or the billing sweep's) first went past its
-- preparation and began removing files and rows (src/account-removal.ts, `work`). NULL while
-- nothing of the workspace has been removed: only then can the admin undo the removal record.
ALTER TABLE account_removal ADD COLUMN work_started_at INTEGER CHECK (work_started_at IS NULL OR work_started_at > 0);

-- When the billing sweep stopped its own removal for good (src/billing-sweep.ts): the workspace
-- went live, took a checkout or left the clock after the removal started. NULL otherwise. No sweep
-- continues a stopped removal; the account stays disabled with its record for the admin to undo.
ALTER TABLE account_removal ADD COLUMN stopped_at INTEGER CHECK (stopped_at IS NULL OR stopped_at > 0);
