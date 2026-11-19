-- Accounts: three columns on user, and six new tables. Everything is additive: each new
-- column is nullable or has a default, so rows written before this migration stay valid
-- and the statements of the version before it, which name none of this, still run.
-- Nothing is dropped, renamed or rebuilt, and no existing row is changed.
--
-- The existing user table is the account table. Its workspace_id stays as the workspace
-- that was created with the account, and new code finds an account's workspace through
-- membership only.
--
-- No secret is stored here in plain text: a session and a sign-in code are kept as the
-- SHA-256 hex digest of their secret, and the audit record holds ids and numbers.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- A username is optional, and fixed once chosen. The CHECK holds the whole shape rule of
-- src/usernames.ts (3 to 30 characters of a to z, 0 to 9 and the hyphen, a letter first,
-- no hyphen last and no two hyphens in a row), so nothing can store a name of another
-- shape. The reserved names are not here and are refused by parseUsername alone.
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK in
-- this file that uses them also compares the length in bytes, length(CAST(x AS BLOB)),
-- which counts all of it. Nothing can be hidden behind a NUL, and a cap is a cap in bytes.
ALTER TABLE user ADD COLUMN username TEXT CHECK (username IS NULL OR (username = lower(username) AND length(username) BETWEEN 3 AND 30 AND length(CAST(username AS BLOB)) = length(username) AND username NOT GLOB '*[^a-z0-9-]*' AND username GLOB '[a-z]*' AND username NOT GLOB '*-' AND username NOT GLOB '*--*'));

-- A disabled account cannot sign in. Nothing is deleted when an account is disabled.
ALTER TABLE user ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'));

-- 1 for a site admin. No row is an admin until the server command makes one.
ALTER TABLE user ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1));

-- Unique among the accounts that have one. Any number of accounts may have none.
CREATE UNIQUE INDEX user_username ON user (username) WHERE username IS NOT NULL;

-- Which account belongs to which workspace. The one role is owner, and the unique index
-- on user_id keeps an account to one workspace for now.
CREATE TABLE membership (
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  user_id TEXT NOT NULL REFERENCES user (id),
  role TEXT NOT NULL CHECK (role IN ('owner')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
) STRICT;
CREATE UNIQUE INDEX membership_user ON membership (user_id);

-- Every account that exists owns the workspace its row names, since the day it was made.
INSERT INTO membership (workspace_id, user_id, role, created_at) SELECT workspace_id, id, 'owner', created_at FROM user;

-- The ways an account may sign in, one row per way. The one kind is a link sent by mail.
CREATE TABLE signin_method (
  user_id TEXT NOT NULL REFERENCES user (id),
  kind TEXT NOT NULL CHECK (kind IN ('email_link')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
) STRICT;

INSERT INTO signin_method (user_id, kind, created_at) SELECT id, 'email_link', created_at FROM user;

-- A sign-in code that was sent or printed. Only the digest of the code is stored, and the
-- CHECK takes nothing but 64 lowercase hex characters, which no code or cookie value is.
-- used_at and session_id are set by the one request that redeems the code. session_id is
-- an id for the record only and points at no row. It has the form every row id has: two
-- to four lowercase letters, an underscore and 24 lowercase hex characters.
CREATE TABLE signin_code (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user (id),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64 AND length(CAST(hash AS BLOB)) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  session_id TEXT CHECK (session_id IS NULL OR (length(CAST(session_id AS BLOB)) = length(session_id) AND length(session_id) BETWEEN 27 AND 29 AND instr(session_id, '_') = length(session_id) - 24 AND substr(session_id, 1, length(session_id) - 25) NOT GLOB '*[^a-z]*' AND substr(session_id, length(session_id) - 23) NOT GLOB '*[^0-9a-f]*'))
) STRICT;
CREATE INDEX signin_code_user ON signin_code (user_id);

-- A signed-in browser. Only the digest of the cookie's secret is stored. The label is a
-- short name for the browser, shown in the list of sessions, of at most 100 bytes.
CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user (id),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64 AND length(CAST(hash AS BLOB)) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  label TEXT NOT NULL CHECK (length(CAST(label AS BLOB)) <= 100),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX session_user ON session (user_id);

-- Counters for the rate limits: how often a key was seen in one window of one bucket.
-- A key is a digest or a fixed word, never a network address or an email. A bucket is
-- at most 40 bytes and a key at most 100.
CREATE TABLE rate_counter (
  bucket TEXT NOT NULL CHECK (length(CAST(bucket AS BLOB)) <= 40),
  key TEXT NOT NULL CHECK (length(CAST(key AS BLOB)) <= 100),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket, key, window_start)
) STRICT;
CREATE INDEX rate_counter_window ON rate_counter (window_start);

-- What was done and by which account: the time, the event, ids and, for some events, a
-- few numbers as JSON in detail. It has no foreign keys, so the record of an account
-- outlives the account. The events are listed in src/audit.ts, which is the only writer
-- and refuses an email, a token, a code, a cookie, a digest and a network address. The
-- caps here are in bytes and are a second line behind that writer: 40 for the event, 64
-- for each id (an id is at most 29) and 1000 for the detail.
CREATE TABLE audit (
  id TEXT PRIMARY KEY NOT NULL,
  at INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (length(CAST(event AS BLOB)) <= 40),
  user_id TEXT CHECK (user_id IS NULL OR length(CAST(user_id AS BLOB)) <= 64),
  workspace_id TEXT CHECK (workspace_id IS NULL OR length(CAST(workspace_id AS BLOB)) <= 64),
  subject TEXT CHECK (subject IS NULL OR length(CAST(subject AS BLOB)) <= 64),
  detail TEXT CHECK (detail IS NULL OR length(CAST(detail AS BLOB)) <= 1000)
) STRICT;
CREATE INDEX audit_at ON audit (at);
