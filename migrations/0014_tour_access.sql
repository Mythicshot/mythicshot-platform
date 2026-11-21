-- Who may view a tour: a setting on the tour, the list of addresses it names, and the
-- record of a move of the live pictures between the two stores. Everything is additive:
-- each new column has a default and every new table starts empty, so rows written before
-- this migration stay valid and every existing tour stays exactly as it was, public.
-- Nothing is dropped, renamed or rebuilt.
--
-- A build older than this one does not know the setting. So that it serves nothing of a
-- restricted tour even so, a restricted tour's snapshot keeps its real text in
-- snapshot.private_data, which no older build reads, and holds in snapshot.data only a stub
-- that every older build's page answers as not found (RESTRICTED_STUB in src/access.ts);
-- its live pictures are under `v/` keys, which no older build's picture route serves, and
-- from the first step of a move to restricted its public pictures are no live snapshot's
-- any more. Still, do not go back to an older build once a tour is restricted: restore the
-- backup taken before the update (CHANGELOG.md, 0.1.38; deploy/cpanel/cpanel.sh refuses).
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

-- The real snapshot text of a restricted tour, or of one whose move to restricted has begun;
-- null for a public tour, whose text is in data as before. While it is set, data holds the
-- stub. Only this build and later ones read it.
ALTER TABLE snapshot ADD COLUMN private_data TEXT;

-- A move of a published tour's live pictures from one store to the other, in bounded
-- steps (src/access.ts). One per tour at most. Its new objects are public_object rows in
-- state 'pending' whose publish_id is switch_id, recorded before they are written, exactly
-- as a publish records its own. Going to private, the old public pictures are moved out of
-- snapshot_object at the first step into public_object rows in state 'pending' whose
-- publish_id is 'sws_' and the switch_id's hex (the sources): each is deleted, object then
-- row, as soon as its copy is marked. Housekeeping never takes either kind for an abandoned
-- publish; it carries on a switch to private that has stopped (src/access.ts).
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

-- Defence in depth for a build older than this one, which knows nothing of the setting:
-- whatever it is asked to do, the database refuses to make a restricted tour public. For a
-- tour whose access is not 'public', a snapshot_object row with a public key (`p/`) is
-- refused, and so is a snapshot.data other than the stub (src/access.ts, RESTRICTED_STUB),
-- on insert and on update; so an older build's publish of such a tour fails as a whole
-- (its commit is one batch) and leaves the tour as it was, and so does its rename of one.
-- A data that is NULL is left to the column's own NOT NULL. This build never writes either:
-- a move to public changes the setting first, in the same batch.
CREATE TRIGGER restricted_tour_no_public_picture BEFORE INSERT ON snapshot_object
  WHEN substr(NEW.image_key, 1, 2) = 'p/' AND EXISTS (SELECT 1 FROM tour WHERE id = NEW.tour_id AND access <> 'public')
BEGIN
  SELECT RAISE(ABORT, 'a restricted tour cannot have a public picture');
END;
CREATE TRIGGER restricted_tour_no_public_picture_update BEFORE UPDATE OF image_key, tour_id ON snapshot_object
  WHEN substr(NEW.image_key, 1, 2) = 'p/' AND EXISTS (SELECT 1 FROM tour WHERE id = NEW.tour_id AND access <> 'public')
BEGIN
  SELECT RAISE(ABORT, 'a restricted tour cannot have a public picture');
END;
CREATE TRIGGER restricted_tour_stub_insert BEFORE INSERT ON snapshot
  WHEN NEW.data IS NOT NULL AND NEW.data <> '{"restricted":true}' AND EXISTS (SELECT 1 FROM tour WHERE id = NEW.tour_id AND access <> 'public')
BEGIN
  SELECT RAISE(ABORT, 'a restricted tour''s snapshot holds the stub only');
END;
CREATE TRIGGER restricted_tour_stub_update BEFORE UPDATE OF data, tour_id ON snapshot
  WHEN NEW.data IS NOT NULL AND NEW.data <> '{"restricted":true}' AND EXISTS (SELECT 1 FROM tour WHERE id = NEW.tour_id AND access <> 'public')
BEGIN
  SELECT RAISE(ABORT, 'a restricted tour''s snapshot holds the stub only');
END;
