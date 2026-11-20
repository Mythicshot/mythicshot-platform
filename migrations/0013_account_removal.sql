-- Deleting an account in bounded steps: one new table. Everything is additive: nothing is
-- dropped, renamed or rebuilt, and no existing row is changed, so the version before it,
-- which names none of this, still runs on a database that has it.
--
-- An account is deleted only once it is disabled, by the site's admin, over several
-- requests (src/account-removal.ts), so that no single request makes more than a fixed
-- number of database and storage calls however large the workspace. The first request
-- records the delete here; each request then removes the next few tours, files, unfinished
-- uploads and shared items, objects before the rows that name them, and the request that
-- finds nothing left removes, in ONE batch, this row, the account's tokens, sessions,
-- codes, connections, sign-in methods and membership, the account and its workspace, and
-- writes the audit row. Until that batch the account is still there, still disabled and
-- still listed, and a delete stopped at any point is finished by asking again.
--
-- While this row exists the account cannot be enabled again: a workspace that is half
-- removed is never served.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.
CREATE TABLE account_removal (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user (id),
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  -- The admin who started it: an id for the record only, with no foreign key, so the
  -- delete can finish whatever happens to that account meanwhile.
  started_by TEXT NOT NULL CHECK (length(started_by) = 28 AND length(CAST(started_by AS BLOB)) = 28 AND substr(started_by, 1, 4) = 'usr_' AND substr(started_by, 5) NOT GLOB '*[^0-9a-f]*'),
  -- The files the workspace held when the delete started, for the progress the later
  -- requests report.
  total INTEGER NOT NULL CHECK (total >= 0),
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX account_removal_workspace ON account_removal (workspace_id);
