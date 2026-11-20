-- Invites: one new table. Everything is additive: nothing is dropped, renamed or rebuilt,
-- and no existing row is changed, so the version before it, which names none of this,
-- still runs on a database that has it.
--
-- The site's admin invites a person by email address (src/invites.ts). The mailed link
-- carries a single-use code, "dpi_" and 40 hex characters (160 random bits), after the `#`;
-- the code is never stored: code_hash is its SHA-256 hex digest, and the CHECK takes
-- nothing but 64 lowercase hex characters, which no code or cookie value is.
--
-- A row is an invite that is still open, or one whose 7 days ran out. An address has at
-- most one row (the UNIQUE on email): a new invite to it, or "resend", changes the row in
-- place, with a new code, so the older code stops working at once. Accepting an invite
-- (which makes the account) and cancelling one remove the row; the audit record keeps
-- that it happened, with ids only. A row whose time ran out is listed until it is
-- cancelled or replaced, and is removed, a few at a time, 30 days after it ran out.
--
-- invited_by is the admin who sent or last resent it. It has no foreign key, so an account
-- can later be removed without meeting this table; the inviter's username is read by a
-- join and is then simply not found.
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here
-- that uses them also compares the length in bytes, length(CAST(x AS BLOB)), as in 0008.
-- email holds what parseEmail in src/accounts.ts returned, with the CHECK of 0009's
-- new_email: lowercase, at most 254 bytes, one @, no NUL, space or control character.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.
CREATE TABLE invite (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 28 AND length(CAST(id AS BLOB)) = 28 AND substr(id, 1, 4) = 'inv_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(CAST(email AS BLOB)) = length(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0 AND email NOT GLOB '*[^!-~]*'),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64 AND length(CAST(code_hash AS BLOB)) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  invited_by TEXT CHECK (invited_by IS NULL OR (length(invited_by) = 28 AND length(CAST(invited_by AS BLOB)) = 28 AND substr(invited_by, 1, 4) = 'usr_' AND substr(invited_by, 5) NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;
-- The admin's list, newest first.
CREATE INDEX invite_created ON invite (created_at);
-- The sweep, oldest first.
CREATE INDEX invite_expires ON invite (expires_at);
