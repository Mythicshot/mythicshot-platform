-- Shared items: a workspace can share a single image or a short clip. Two new tables.
-- Everything is additive: nothing is dropped, renamed or rebuilt, and no existing row is
-- changed, so the version before it, which names none of this, still runs on a database
-- that has it.
--
-- An item is sent in parts (src/media.ts): it is made `uploading`, each part is stored as
-- its own object, and commit makes it `online`. `closing` marks an item that is being
-- removed (deleted, or swept after a day unfinished): from then on it counts for nothing
-- and no request can change it, and the row only waits for its objects to go.
--
-- The objects are named from the row alone (`m/<id>/part-NNN` for n from 0 to parts - 1,
-- and `m/<id>/preview.png` or `.jpg`), so no key is stored and none can name another
-- item's object.
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
-- while it is not closing (src/usage.ts), and preview_bytes once a preview was claimed.
-- The title is at most 120 characters, so at most 480 bytes, and holds no NUL.
-- The preview picture: its type as read from its bytes, its size, the random token of the
-- request that is storing it (null when none is), and when it was stored (null until it
-- is). The type and size are set together, and the size is at most 100,000.
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
  duration_ms INTEGER CHECK ((kind = 'clip' AND duration_ms > 0) OR (kind = 'image' AND duration_ms IS NULL)),
  title TEXT CHECK (title IS NULL OR (length(CAST(title AS BLOB)) BETWEEN 1 AND 480 AND instr(CAST(title AS BLOB), X'00') = 0)),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'online', 'closing')),
  preview_type TEXT CHECK (preview_type IS NULL OR preview_type IN ('png', 'jpg')),
  preview_bytes INTEGER CHECK (preview_bytes IS NULL OR preview_bytes BETWEEN 1 AND 100000),
  preview_claim TEXT CHECK (preview_claim IS NULL OR (length(preview_claim) = 24 AND length(CAST(preview_claim AS BLOB)) = 24 AND preview_claim NOT GLOB '*[^0-9a-f]*')),
  preview_stored_at INTEGER,
  created_at INTEGER NOT NULL,
  online_at INTEGER,
  CHECK ((preview_type IS NULL) = (preview_bytes IS NULL)),
  CHECK (preview_stored_at IS NULL OR preview_type IS NOT NULL)
) STRICT;
-- The list: one workspace's online items of one kind, newest first.
CREATE INDEX media_list ON media (workspace_id, kind, state, created_at, id);
-- The sweep: one workspace's unfinished and closing items by age.
CREATE INDEX media_state ON media (workspace_id, state, created_at);

-- One stored part of an item, n counted from 0. A row is written before its object
-- (claim set, stored_at null) and marked stored once the object is written. Only the
-- request whose claim it holds may mark it. A part is at most 2,000,000 bytes.
CREATE TABLE media_part (
  media_id TEXT NOT NULL REFERENCES media (id),
  n INTEGER NOT NULL CHECK (n BETWEEN 0 AND 998),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 2000000),
  claim TEXT CHECK (claim IS NULL OR (length(claim) = 24 AND length(CAST(claim AS BLOB)) = 24 AND claim NOT GLOB '*[^0-9a-f]*')),
  stored_at INTEGER,
  PRIMARY KEY (media_id, n),
  CHECK ((claim IS NULL) <> (stored_at IS NULL))
) STRICT;
