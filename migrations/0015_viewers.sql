-- Viewers: two new tables. Everything is additive: nothing is dropped, renamed or rebuilt,
-- and no existing row is changed, so the version before it, which names none of this,
-- still runs on a database that has it.
--
-- A viewer is a browser that proved, on the tours address, that it can read mail at one
-- address (src/viewers.ts). It is not an account: no user, no workspace, no dashboard and no
-- API. Asking for a link on a tour that is shared with an address mails a code, "dpv_" and
-- 40 hex characters (160 random bits); pressing the button on the page the link opens turns
-- it, once and within 15 minutes, into a viewer session, whose secret, "dpw_" and 64 hex
-- characters, is the value of the viewer cookie. Neither secret is stored: code_hash and
-- hash are their SHA-256 hex digests, and each CHECK takes nothing but 64 lowercase hex
-- characters, which no code or cookie value is.
--
-- Both tables are keyed by an address, never by an account or a workspace: they hold no
-- workspace's data, and disabling or deleting an account with the same address leaves them
-- alone (the isolation suite lists them as shared). A code names the tour's slug it was asked
-- for, which is only where the browser lands; the session is for no one tour.
--
-- Rows are removed a few at a time by later requests: a session once it ended, a code a day
-- after it ran out. Signing out removes the session's row at once.
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here that
-- uses them also compares the length in bytes, length(CAST(x AS BLOB)), as in 0008. email
-- holds what parseEmail in src/accounts.ts returned, with the CHECK of 0012's invite email:
-- lowercase, at most 254 bytes, one @, no NUL, space or control character.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- One mailed code. id is "vco_" and 24 lowercase hex characters; slug has the form of every
-- tour's slug (10 characters of a to z and 2 to 7) and names no row, so a code outlives
-- nothing it points at. used_at and session_id are set together by the one request that
-- redeems the code; session_id is the id the new session got, for the record only.
CREATE TABLE viewer_code (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 28 AND length(CAST(id AS BLOB)) = 28 AND substr(id, 1, 4) = 'vco_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(CAST(email AS BLOB)) = length(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0 AND email NOT GLOB '*[^!-~]*'),
  slug TEXT NOT NULL CHECK (length(slug) = 10 AND length(CAST(slug AS BLOB)) = 10 AND slug NOT GLOB '*[^a-z2-7]*'),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64 AND length(CAST(code_hash AS BLOB)) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  used_at INTEGER,
  session_id TEXT CHECK (session_id IS NULL OR (length(session_id) = 28 AND length(CAST(session_id AS BLOB)) = 28 AND substr(session_id, 1, 4) = 'vse_' AND substr(session_id, 5) NOT GLOB '*[^0-9a-f]*')),
  -- Redeemed: both set together, or neither.
  CHECK ((used_at IS NULL) = (session_id IS NULL))
) STRICT;
-- The sweep, oldest first.
CREATE INDEX viewer_code_expires ON viewer_code (expires_at);

-- One viewer session. id is "vse_" and 24 lowercase hex characters. It ends 30 days after its
-- last use and never later than 180 days after it was made: the second CHECK holds that cap
-- (180 days are 15,552,000,000 milliseconds), whatever a writer does.
CREATE TABLE viewer_session (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 28 AND length(CAST(id AS BLOB)) = 28 AND substr(id, 1, 4) = 'vse_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(CAST(email AS BLOB)) = length(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0 AND email NOT GLOB '*[^!-~]*'),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64 AND length(CAST(hash AS BLOB)) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL CHECK (last_used_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > last_used_at AND expires_at <= created_at + 15552000000)
) STRICT;
-- The sweep, oldest first.
CREATE INDEX viewer_session_expires ON viewer_session (expires_at);
