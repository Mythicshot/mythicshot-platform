-- Shared items: a workspace can share a single image or a short clip. Two new tables.
-- Everything is additive: nothing is dropped, renamed or rebuilt, and no existing row is
-- changed, so the version before it, which names none of this, still runs on a database
-- that has it.
--
-- An item is sent in parts (src/media.ts): it is made `uploading`, each part and the
-- preview are stored as objects, and commit makes it `online`. `closing` marks an item
-- that is being removed (deleted, or swept after a day unfinished): no request can change
-- or find it any more, and the row waits for its objects to go. It still counts toward
-- the storage allowance until then (src/usage.ts).
--
-- Every object has a row in media_object, written before the object is, so every object
-- that can exist is named by a row until it has been deleted. Its key is made from the row
-- (`m/<id>/part-NNN.<claim>`, or `m/<id>/preview.<claim>.<ext>`), so no key is stored,
-- none can name another item's object, and two requests never write the same key.
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here
-- that uses them also compares the length in bytes, length(CAST(x AS BLOB)), as in 0008.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- One item. id has the form of every row id ("med_" and 24 lowercase hex characters).
-- link_id is the item's public name: 20 characters of a to z and 2 to 7, random, never
-- made from the id. bytes, width, height and duration_ms are as the client declared them:
-- part 0 is checked against them (src/sniff.ts), and for an MP4 the size and duration are
-- shown as declared. bytes is also what the item holds against the storage allowance
-- until the row is removed. The title is at most 120 characters, so at most 480 bytes,
-- and holds no NUL.
CREATE TABLE media (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 28 AND length(CAST(id AS BLOB)) = 28 AND substr(id, 1, 4) = 'med_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  link_id TEXT NOT NULL UNIQUE CHECK (length(link_id) = 20 AND length(CAST(link_id AS BLOB)) = 20 AND link_id NOT GLOB '*[^a-z2-7]*'),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'clip')),
  content_type TEXT NOT NULL CHECK ((kind = 'image' AND content_type IN ('image/png', 'image/jpeg')) OR (kind = 'clip' AND content_type IN ('image/gif', 'video/mp4'))),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  parts INTEGER NOT NULL CHECK (parts BETWEEN 1 AND 999),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  duration_ms INTEGER CHECK ((kind = 'clip' AND duration_ms IS NOT NULL AND duration_ms > 0) OR (kind = 'image' AND duration_ms IS NULL)),
  title TEXT CHECK (title IS NULL OR (length(CAST(title AS BLOB)) BETWEEN 1 AND 480 AND instr(CAST(title AS BLOB), X'00') = 0)),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'online', 'closing')),
  created_at INTEGER NOT NULL,
  online_at INTEGER
) STRICT;
-- The list: one workspace's online items of one kind, newest first.
CREATE INDEX media_list ON media (workspace_id, kind, state, created_at, id);
-- The sweep: one workspace's unfinished and closing items by age.
CREATE INDEX media_state ON media (workspace_id, state, created_at);

-- One object of an item, under one request's claim: part n (from 0), or the preview (n is
-- -1, with its type in ext). The row is written before the object, with the claim token
-- and the time, and marked stored once the object is written. current is 1 for the one
-- claim a part or the preview serves: set only together with stored_at, while the item is
-- uploading, so at most one claim per part (and one preview) is current, and once the
-- item is online none changes. A part is at most 2,000,000 bytes, a preview 100,000.
CREATE TABLE media_object (
  media_id TEXT NOT NULL REFERENCES media (id),
  claim TEXT NOT NULL CHECK (length(claim) = 24 AND length(CAST(claim AS BLOB)) = 24 AND claim NOT GLOB '*[^0-9a-f]*'),
  n INTEGER NOT NULL CHECK (n BETWEEN -1 AND 998),
  ext TEXT CHECK ((n = -1 AND ext IS NOT NULL AND ext IN ('png', 'jpg')) OR (n >= 0 AND ext IS NULL)),
  bytes INTEGER NOT NULL CHECK (bytes >= 1 AND bytes <= CASE WHEN n = -1 THEN 100000 ELSE 2000000 END),
  claimed_at INTEGER NOT NULL,
  stored_at INTEGER,
  current INTEGER NOT NULL DEFAULT 0 CHECK (current IN (0, 1) AND (current = 0 OR stored_at IS NOT NULL)),
  PRIMARY KEY (media_id, claim)
) STRICT;
-- One current claim per part and preview of an item.
CREATE UNIQUE INDEX media_object_current ON media_object (media_id, n) WHERE current = 1;
