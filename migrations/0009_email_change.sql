-- Changing an account's email address: one new table. Everything is additive: nothing is
-- dropped, renamed or rebuilt, and no existing row is changed, so the version before it,
-- which names none of this, still runs on a database that has it.
--
-- A change is asked for with the new address and takes effect only when the link mailed
-- to that address is opened, once and within 15 minutes, by the same account signed in.
-- The code in the link is never stored: code_hash is the SHA-256 hex digest of it, and the
-- CHECK takes nothing but 64 lowercase hex characters, which no code or cookie value is.
--
-- An account has at most one row here (the unique index on user_id): asking again
-- replaces the earlier row, its code with it, so an earlier link stops working. A used or
-- expired row stays until the account asks again. The table therefore never holds more
-- rows than there are accounts, and needs no sweep.
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here
-- that uses them also compares the length in bytes, length(CAST(x AS BLOB)), which counts
-- all of it, as in 0008. new_email holds what parseEmail in src/accounts.ts returned: at
-- most 254 characters of visible ASCII, lowercased, with one @. The CHECK holds the
-- lowercase rule (which the user table's UNIQUE relies on), the length in bytes and the
-- one @, and refuses a NUL, a space and every other control character; parseEmail is the
-- full rule.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.
CREATE TABLE email_change (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(id AS BLOB)) = length(id) AND length(id) BETWEEN 27 AND 29 AND instr(id, '_') = length(id) - 24 AND substr(id, 1, length(id) - 25) NOT GLOB '*[^a-z]*' AND substr(id, length(id) - 23) NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES user (id),
  new_email TEXT NOT NULL CHECK (new_email = lower(new_email) AND length(CAST(new_email AS BLOB)) = length(new_email) AND length(new_email) BETWEEN 3 AND 254 AND instr(new_email, '@') > 1 AND instr(substr(new_email, instr(new_email, '@') + 1), '@') = 0 AND new_email NOT GLOB '*[^!-~]*'),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64 AND length(CAST(code_hash AS BLOB)) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE UNIQUE INDEX email_change_user ON email_change (user_id);
CREATE UNIQUE INDEX email_change_code ON email_change (code_hash);
