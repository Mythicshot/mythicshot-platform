-- Who may view a tour: a setting on the tour, the list of addresses it names, and the
-- record of a move of the live pictures between the two stores. Everything is additive:
-- each new column has a default and every new table starts empty, so rows written before
-- this migration stay valid and every existing tour stays exactly as it was, public.
-- Nothing is dropped, renamed or rebuilt.
--
-- A build older than this one does not know the setting: run against a database where a
-- tour has been made restricted, it would show that tour's page to anyone. Do not go back
-- to an older build once a tour is restricted (CHANGELOG.md, 0.1.36).
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here
-- that uses them also compares the length in bytes, length(CAST(x AS BLOB)), as in 0008.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- The addresses a tour whose setting is 'people' lets in, besides its owner's. At most 200
-- per tour (src/access.ts refuses more). email holds what parseEmail in src/accounts.ts
-- returned, with the CHECK of 0012's invite.email: lowercase, at most 254 bytes, one @, no
-- NUL, space or control character. The list is kept when the setting changes away from
-- 'people', and goes with the tour.
CREATE TABLE tour_viewer (
  tour_id TEXT NOT NULL REFERENCES tour (id),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(CAST(email AS BLOB)) = length(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0 AND email NOT GLOB '*[^!-~]*'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tour_id, email)
) STRICT;

-- The setting: 'public' (anyone with the link: every tour until now), 'people' (the
-- addresses of tour_viewer and the owner) or 'me' (the owner alone). The public page and
-- the public picture route serve a tour only while this is 'public'.
--
-- Where a published tour's live pictures are follows from it: a public tour's in the
-- public store under `p/<32 hex>.<ext>`, a restricted tour's in the private store under
-- `v/<32 hex>.<ext>`, never in the public store (src/access.ts). The store of an object is
-- told by the first letter of its key alone, in snapshot_object and public_object alike.
ALTER TABLE tour ADD COLUMN access TEXT NOT NULL DEFAULT 'public' CHECK (access IN ('public', 'people', 'me'));

-- A move of a published tour's live pictures from one store to the other, in bounded
-- steps (src/access.ts). One per tour at most. Its new objects are public_object rows in
-- state 'pending' whose publish_id is switch_id, recorded before they are written, exactly
-- as a publish records its own; housekeeping never takes them for an abandoned publish.
-- target is the store the pictures go to. data is the live snapshot text with every
-- picture renamed to its new key; the step that copies the last picture puts it live, in
-- one batch with the object rows, and only while the snapshot is still the publish named
-- by from_publish (null for a snapshot from before migration 0003).
CREATE TABLE access_switch (
  tour_id TEXT PRIMARY KEY NOT NULL REFERENCES tour (id),
  switch_id TEXT NOT NULL UNIQUE CHECK (length(switch_id) = 27 AND length(CAST(switch_id AS BLOB)) = 27 AND substr(switch_id, 1, 3) = 'sw_' AND substr(switch_id, 4) NOT GLOB '*[^0-9a-f]*'),
  target TEXT NOT NULL CHECK (target IN ('public', 'private')),
  from_publish TEXT,
  data TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  created_at INTEGER NOT NULL,
  touched_at INTEGER NOT NULL
) STRICT;
