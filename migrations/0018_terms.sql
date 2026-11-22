-- The site's terms, and who agreed to which version (0.1.53): two new tables. Everything is
-- additive: nothing is dropped, renamed or rebuilt, and no existing row is changed, so the
-- version before it, which names none of this, still runs on a database that has it.
--
-- A site publishes its terms with the server command (`terms publish <file>`, src/node/admin.ts),
-- from a plain-text file (docs/terms-example.txt; the format is parseTerms in src/terms.ts).
-- Each publish adds one row to terms_version and nothing else: a version is kept exactly as it
-- was published, so there is a record of what each person agreed to. The two triggers below
-- refuse any change to a row and any delete, whoever asks; no code of this application asks.
-- The current terms are the row with the highest seq. A site with no row has no terms: nobody
-- is asked anything, and every answer is as before this migration.
--
-- terms_agreement holds who agreed to which version and when: the account's id, the version's
-- id and the time, and nothing else (no network address, no browser, no email). An account
-- agrees to a version at most once (the primary key). Deleting an account removes its rows
-- (src/account-removal.ts, in the delete's last batch); the audit record keeps `terms_agreed`
-- with ids only, as it keeps everything else.
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here that
-- uses them also compares the length in bytes, length(CAST(x AS BLOB)), as in 0008. The caps are
-- in bytes and are a second line behind parseTerms, which counts characters: a title of at most
-- 200 characters, a version label of 100 and the full terms of 200,000 bytes.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.
CREATE TABLE terms_version (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 28 AND length(CAST(id AS BLOB)) = 28 AND substr(id, 1, 4) = 'trm_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  -- 1 for the first version, one more for each after it: the order they were published in.
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND 800),
  version_label TEXT NOT NULL CHECK (length(CAST(version_label AS BLOB)) BETWEEN 1 AND 400),
  -- The main points, a JSON list of texts; the links, a JSON list of {"label","url"}.
  points TEXT NOT NULL CHECK (length(CAST(points AS BLOB)) <= 16000 AND json_valid(points)),
  links TEXT NOT NULL CHECK (length(CAST(links AS BLOB)) <= 2000 AND json_valid(links)),
  -- The full terms as the file's `terms:` part, one line per line, in the canonical form.
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 200000),
  -- The SHA-256 hex digest of the whole file in its canonical form: the same content twice is refused.
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64 AND length(CAST(sha256 AS BLOB)) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  published_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER terms_version_kept BEFORE UPDATE ON terms_version BEGIN SELECT RAISE(ABORT, 'a published version of the terms is never changed'); END;
CREATE TRIGGER terms_version_never_deleted BEFORE DELETE ON terms_version BEGIN SELECT RAISE(ABORT, 'a published version of the terms is never deleted'); END;

CREATE TABLE terms_agreement (
  user_id TEXT NOT NULL REFERENCES user (id),
  terms_id TEXT NOT NULL REFERENCES terms_version (id),
  agreed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, terms_id)
) STRICT;
