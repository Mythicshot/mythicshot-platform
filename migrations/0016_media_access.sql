-- Who may view a shared item (src/media-access.ts), and how a visitor proves an address on
-- the media address (src/viewers.ts, the media scope). Everything is additive: each new
-- column has a default or may be NULL, and every new table starts empty, so rows written
-- before this migration stay valid and every existing item stays exactly as it was, public.
-- Nothing is dropped, renamed or rebuilt, and no object moves: an item's files were always in
-- the private store and served only by the app (src/media.ts), so a change of who may view an
-- item takes effect at the next request.
--
-- A build older than this one does not know the setting, and would serve a restricted item
-- to anyone who has its link. So a restricted item's link id is kept out of media.link_id,
-- the one column every older build looks an item up by: it moves to media.private_link_id,
-- which no older build reads, and link_id holds a fresh random name that nothing ever gives
-- out (this build answers an item's link from private_link_id and never serves an item by
-- link_id while it is restricted). An older build then answers the item's real link as one
-- that does not exist. Still, do not go back to an older build once an item is restricted:
-- restore the backup taken before the update (CHANGELOG.md, 0.1.47; deploy/cpanel/cpanel.sh
-- refuses).
--
-- length() and GLOB read a text only up to its first NUL character, so every CHECK here that
-- uses them also compares the length in bytes, length(CAST(x AS BLOB)), as in 0008.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

-- The addresses an item whose setting is 'people' lets in, besides its owner's: at most 200
-- per item (src/viewing.ts refuses more). email holds what parseEmail in src/accounts.ts
-- returned, with the CHECK of 0014's tour_viewer.email. The list is kept when the setting
-- changes away from 'people', and goes with the item (removeClosing in src/media.ts removes
-- it in the batch that starts removing the item's files, before the item row can go).
CREATE TABLE media_viewer (
  media_id TEXT NOT NULL REFERENCES media (id),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(CAST(email AS BLOB)) = length(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0 AND email NOT GLOB '*[^!-~]*'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, email)
) STRICT;

-- The setting, as a tour's: 'public' (anyone with the link: every item until now), 'people'
-- (the addresses of media_viewer and the owner) or 'me' (the owner alone).
ALTER TABLE media ADD COLUMN access TEXT NOT NULL DEFAULT 'public' CHECK (access IN ('public', 'people', 'me'));

-- A restricted item's real link id (its public name, in its address /i/<name> or /r/<name>);
-- NULL for a public item, whose link id is in link_id as before. Only this build and later
-- ones read it.
ALTER TABLE media ADD COLUMN private_link_id TEXT CHECK (private_link_id IS NULL OR (length(private_link_id) = 20 AND length(CAST(private_link_id AS BLOB)) = 20 AND private_link_id NOT GLOB '*[^a-z2-7]*'));
CREATE UNIQUE INDEX media_private_link ON media (private_link_id) WHERE private_link_id IS NOT NULL;

-- A restricted item has its real link id apart, and only a restricted item has one: whatever
-- any build writes, an item is never restricted with its real link id still in link_id.
CREATE TRIGGER media_restricted_link_insert BEFORE INSERT ON media
  WHEN (NEW.access <> 'public') <> (NEW.private_link_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a restricted item keeps its link id apart, and only a restricted item does');
END;
CREATE TRIGGER media_restricted_link_update BEFORE UPDATE OF access, private_link_id ON media
  WHEN (NEW.access <> 'public') <> (NEW.private_link_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a restricted item keeps its link id apart, and only a restricted item does');
END;
-- No link id is ever both one item's link_id and another's private_link_id, so a link names
-- one item at most. The message is the one a unique index gives, so a create that meets one
-- tries again with a fresh name, as it does for a link_id that is taken (src/media.ts).
CREATE TRIGGER media_link_names_one_insert BEFORE INSERT ON media
  WHEN EXISTS (SELECT 1 FROM media o WHERE o.private_link_id = NEW.link_id OR o.link_id = NEW.private_link_id)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: media.link_id');
END;
CREATE TRIGGER media_link_names_one_update BEFORE UPDATE OF link_id, private_link_id ON media
  WHEN EXISTS (SELECT 1 FROM media o WHERE o.id <> NEW.id AND (o.private_link_id = NEW.link_id OR o.link_id = NEW.private_link_id))
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: media.link_id');
END;

-- Viewers on the media address: the same two tables as 0015's on the tours address, kept
-- apart, so a session or a code made for tours is never found for an item, and the other way
-- round, whatever address both live on (src/viewers.ts). A code is "dpi_" and 40 hex
-- characters, a session's secret "dpk_" and 64; neither is stored, only its SHA-256 hex
-- digest. A code names the page it was asked from, /i/<link id> or /r/<link id>, only as where
-- the browser lands; it names no row. Both are keyed by an address, never by an account or a
-- workspace: they hold no workspace's data, and the isolation suite lists them as shared.
CREATE TABLE media_viewer_code (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 28 AND length(CAST(id AS BLOB)) = 28 AND substr(id, 1, 4) = 'vcm_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(CAST(email AS BLOB)) = length(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0 AND email NOT GLOB '*[^!-~]*'),
  path TEXT NOT NULL CHECK (length(path) = 23 AND length(CAST(path AS BLOB)) = 23 AND substr(path, 1, 1) = '/' AND substr(path, 2, 1) IN ('i', 'r') AND substr(path, 3, 1) = '/' AND substr(path, 4) NOT GLOB '*[^a-z2-7]*'),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64 AND length(CAST(code_hash AS BLOB)) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  used_at INTEGER,
  session_id TEXT CHECK (session_id IS NULL OR (length(session_id) = 28 AND length(CAST(session_id AS BLOB)) = 28 AND substr(session_id, 1, 4) = 'vsm_' AND substr(session_id, 5) NOT GLOB '*[^0-9a-f]*')),
  CHECK ((used_at IS NULL) = (session_id IS NULL))
) STRICT;
CREATE INDEX media_viewer_code_expires ON media_viewer_code (expires_at);

-- One viewer session on the media address: 30 days after its last use, never later than 180
-- days after it was made, as on the tours address.
CREATE TABLE media_viewer_session (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 28 AND length(CAST(id AS BLOB)) = 28 AND substr(id, 1, 4) = 'vsm_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  email TEXT NOT NULL CHECK (email = lower(email) AND length(CAST(email AS BLOB)) = length(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0 AND email NOT GLOB '*[^!-~]*'),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64 AND length(CAST(hash AS BLOB)) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL CHECK (last_used_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > last_used_at AND expires_at <= created_at + 15552000000)
) STRICT;
CREATE INDEX media_viewer_session_expires ON media_viewer_session (expires_at);
