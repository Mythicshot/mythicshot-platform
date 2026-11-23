-- A chapter's upload time always belongs to the pictures it holds now (0.1.56).
--
-- Migration 0019 added chapter.uploaded_at, which this build's commits set. A build before
-- 0.1.55 does not know the column: run on a migrated database (the way back an update keeps,
-- without a restore), its replace of a chapter writes the new steps and the chapter's revision
-- and leaves uploaded_at as it was, so the Chapters box would show the time of pictures the
-- chapter no longer has. Every replace, of every build since 0006, gives the chapter a new
-- revision (the id of its upload), and nothing else changes revision. So when revision changes,
-- the time is emptied (shown as no date: not known), in the same statement as the change; this
-- build then sets its own time in a later statement of the same batch (src/replace.ts).
--
-- The trigger writes one column of the very row being changed, never another row, so it can
-- reach nothing of another tour or workspace. Rows already written are left as they are: a
-- time an older build left stale before this migration cannot be told from a right one.
--
-- The statement fails on a database that already has this migration, so a second application
-- changes nothing.

CREATE TRIGGER chapter_uploaded_follows_revision AFTER UPDATE OF revision ON chapter WHEN NEW.revision IS NOT OLD.revision BEGIN UPDATE chapter SET uploaded_at = NULL WHERE id = NEW.id; END;
