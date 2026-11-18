-- Replacing a chapter of an existing tour over the same link, sending only the pictures
-- that changed. Every new column is nullable or has a default, so rows written before
-- this migration stay valid.

-- The lowercase hex SHA-256 of a stored picture, computed by the server from the bytes
-- it accepted. Null for a picture stored before this migration, and for one whose bytes
-- are not known for certain: such a picture is never offered for reuse.
ALTER TABLE step ADD COLUMN sha256 TEXT;
ALTER TABLE upload_step ADD COLUMN sha256 TEXT;
-- 1 for a step of a replace upload that points at a picture the chapter already has. Its
-- image_key is that picture's key, under another upload's id, so an abort never deletes it.
ALTER TABLE upload_step ADD COLUMN reused INTEGER NOT NULL DEFAULT 0 CHECK (reused IN (0, 1));

-- Set on an upload that replaces a chapter: the chapter, and the chapter's revision when
-- the upload was created. Its commit takes effect only while the revision is still that.
ALTER TABLE upload ADD COLUMN replaces_chapter_id TEXT;
ALTER TABLE upload ADD COLUMN base_revision TEXT;

-- The upload that last replaced the chapter (null if none has), which is how a repeated
-- commit of that upload finds its result, and the tour's draft_version that replace made.
ALTER TABLE chapter ADD COLUMN revision TEXT;
ALTER TABLE chapter ADD COLUMN replaced_version INTEGER;
-- The draft_version made by the first of the replaces of this chapter that followed one
-- another with no other change to the tour's draft in between. A snapshot built from the
-- draft just before that one lacks nothing but this chapter's replaces.
ALTER TABLE chapter ADD COLUMN replaced_from INTEGER;
CREATE INDEX chapter_revision ON chapter (revision);

-- The tour's draft_version the live snapshot was built from. For a snapshot published
-- before this migration it is filled in only when the snapshot is known to hold the whole
-- draft, which is when it has as many steps as the draft: until this migration the only
-- change to a draft's steps is a whole chapter added, never one taken away or replaced, so
-- equal counts mean the same steps. The times do not say it (a chapter uploaded while a
-- publish of several calls was running is older than that publish's last call and yet not
-- in it), and a rename is no difference (it writes its title into the snapshot too).
-- Anything else stays null (a snapshot with no step count included), which reads as "the
-- draft may hold changes that were never published".
ALTER TABLE snapshot ADD COLUMN draft_version INTEGER;
UPDATE snapshot SET draft_version = (
  SELECT t.draft_version FROM tour t
   WHERE t.id = snapshot.tour_id
     AND snapshot.steps = (SELECT count(*) FROM step s WHERE s.tour_id = t.id));

-- Draft pictures a replace took out of a chapter and no step uses any more, waiting to be
-- deleted. draft_version is the tour's draft_version that replace made: a publish built
-- from an older draft still copies from these keys, so a row goes (after its file) only
-- while no publish job of an older draft exists for its tour.
CREATE TABLE replaced_object (
  tour_id TEXT NOT NULL REFERENCES tour (id),
  image_key TEXT NOT NULL,
  draft_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tour_id, image_key)
) STRICT;
