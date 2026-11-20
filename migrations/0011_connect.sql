-- Connecting the desktop app: two new tables and one column on api_token. Everything is
-- additive: nothing is dropped, renamed or rebuilt, and no existing row is changed but for
-- the new column's default, so the version before it, which names none of this, still runs
-- on a database that has it.
--
-- The app asks for a pair of codes (src/connect.ts): a long secret device code it keeps, and
-- a short user code it shows. A signed-in person types the short code on the dashboard and
-- confirms; the app, asking with the device code, then collects a token for that person's
-- workspace, once. A request lives 10 minutes.
--
-- Neither code is stored. device_code_hash is the SHA-256 hex digest of the device code (160
-- random bits). user_code_hash is an HMAC-SHA256 of the user code under the install's own
-- random key in connect_key, so a copy of the table cannot be read back through a table of
-- every user code made once for all installs: a search has to start after the copy is made,
-- for this install alone, and finish within the code's 10 minutes. Both CHECKs take nothing
-- but 64 lowercase hex characters, which no code is.
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here that
-- uses them also compares the length in bytes, length(CAST(x AS BLOB)), as in 0008.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- How a token was made: by the setup wizard or a new account (`setup`, which every token
-- made before this migration is), or by connecting the app while signed in (`sign_in`).
ALTER TABLE api_token ADD COLUMN kind TEXT NOT NULL DEFAULT 'setup' CHECK (kind IN ('setup', 'sign_in'));

-- The install's key for the user codes' HMAC: one row, 32 random bytes as 64 hex
-- characters, made here once. Nothing ever changes or reads it out of the database.
CREATE TABLE connect_key (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  key TEXT NOT NULL CHECK (length(key) = 64 AND length(CAST(key AS BLOB)) = 64 AND key NOT GLOB '*[^0-9a-f]*')
) STRICT;
INSERT INTO connect_key (id, key) VALUES (1, lower(hex(randomblob(32))));

-- One request to connect. id has the form of every row id ("crq_" and 24 lowercase hex
-- characters). device_name is what the app called itself: at most 60 characters, so at most
-- 240 bytes, with no NUL. network_key is the digest src/rate.ts counts the asking network
-- under (null when the network is not known); it caps the open requests of one network.
--
-- A request is settled once: confirmed (by an account, for that account's one workspace,
-- with the id the token will have) or refused. A confirmed request is collected once, which
-- is when its token is made, with that id; token_id names no row until then, and none at all
-- for a request nobody collected, so it has no foreign key. last_poll_at is when the app
-- last asked; asking again sooner than the interval is refused.
--
-- A user code is unique among the rows: a new request whose code is taken gets another. Rows
-- are removed once expired, a few at a time, by later requests.
CREATE TABLE connect_request (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 28 AND length(CAST(id AS BLOB)) = 28 AND substr(id, 1, 4) = 'crq_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  device_code_hash TEXT NOT NULL UNIQUE CHECK (length(device_code_hash) = 64 AND length(CAST(device_code_hash AS BLOB)) = 64 AND device_code_hash NOT GLOB '*[^0-9a-f]*'),
  user_code_hash TEXT NOT NULL UNIQUE CHECK (length(user_code_hash) = 64 AND length(CAST(user_code_hash AS BLOB)) = 64 AND user_code_hash NOT GLOB '*[^0-9a-f]*'),
  device_name TEXT NOT NULL CHECK (length(CAST(device_name AS BLOB)) BETWEEN 1 AND 240 AND instr(CAST(device_name AS BLOB), X'00') = 0),
  network_key TEXT CHECK (network_key IS NULL OR (length(network_key) = 64 AND length(CAST(network_key AS BLOB)) = 64 AND network_key NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  last_poll_at INTEGER,
  confirmed_at INTEGER,
  confirmed_by TEXT REFERENCES user (id),
  workspace_id TEXT REFERENCES workspace (id),
  token_id TEXT CHECK (token_id IS NULL OR (length(token_id) = 28 AND length(CAST(token_id AS BLOB)) = 28 AND substr(token_id, 1, 4) = 'tok_' AND substr(token_id, 5) NOT GLOB '*[^0-9a-f]*')),
  refused_at INTEGER,
  collected_at INTEGER,
  -- Confirmed: all four set together, or none.
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL) AND (confirmed_at IS NULL) = (workspace_id IS NULL) AND (confirmed_at IS NULL) = (token_id IS NULL)),
  -- Settled once: never both confirmed and refused.
  CHECK (confirmed_at IS NULL OR refused_at IS NULL),
  -- Collected only once confirmed.
  CHECK (collected_at IS NULL OR confirmed_at IS NOT NULL)
) STRICT;
-- The open requests of one network, for its cap.
CREATE INDEX connect_request_network ON connect_request (network_key, expires_at);
-- The sweep, oldest first.
CREATE INDEX connect_request_expires ON connect_request (expires_at);
-- The workspace's requests, for the cross-workspace checks and the record.
CREATE INDEX connect_request_workspace ON connect_request (workspace_id);
