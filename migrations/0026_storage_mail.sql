-- The low storage mail (0.1.66): the record of each mail about a workspace's storage filling
-- up. Additive only: one new table, so rows written before this migration stay valid and the
-- statements of the versions before it, which name none of this, still run. Nothing is
-- dropped, renamed or rebuilt, and no existing row is changed.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- One row per mail of the present fill-up of a workspace (src/storage-alert.ts): `stage` 80 for
-- "running low", 100 for "full". A row is written BEFORE the mail is handed to the mail server
-- (a claim, `sent_at` NULL), so two checks at the same moment never send the same mail, and is
-- completed with `sent_at` once the mail server took it. A mail that could not be sent has its
-- claim taken back, so it is tried again later; a claim the mail server may have taken (the
-- message was handed over, then the conversation failed) stays unconfirmed and that mail is not
-- sent again for this fill-up. When the workspace's usage is seen below 70% of its allowance,
-- every confirmed row of it (and every claim older than an hour) is deleted: both mails are
-- armed again for the next fill-up.
--
-- `email_sha256` is the SHA-256 of the address the mail went to, never the address: a record of
-- whom it went to that holds no address. Nothing decides on it.
CREATE TABLE storage_mail (
  workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) = 27 AND substr(workspace_id, 1, 3) = 'ws_' AND substr(workspace_id, 4) NOT GLOB '*[^0-9a-f]*'),
  stage INTEGER NOT NULL CHECK (stage IN (80, 100)),
  email_sha256 TEXT NOT NULL CHECK (length(CAST(email_sha256 AS BLOB)) = 64 AND email_sha256 NOT GLOB '*[^0-9a-f]*'),
  claimed_at INTEGER NOT NULL CHECK (claimed_at > 0),
  sent_at INTEGER CHECK (sent_at IS NULL OR sent_at > 0),
  PRIMARY KEY (workspace_id, stage)
) STRICT;
