-- When each chapter was last uploaded (0.1.55), for the dashboard's Chapters box, which lists a
-- tour's chapters with the date each was uploaded. Until now nothing kept it: a chapter row has
-- no time, and the upload row that made it is removed by its commit. The commit of a new tour
-- or a new chapter sets it, and so does the commit of a replace (src/uploads.ts,
-- src/replace.ts). It is additive and nullable, so rows written before this migration stay
-- valid; an older build never names it, and its commits leave it empty (shown as no date).
--
-- Filled in here only where the time is known exactly: the chapter a tour was made with, which
-- that commit wrote at position 0 in the same batch as the tour row and its created_at, and
-- which no replace has changed since (revision is null). Until this version chapters were
-- never reordered or removed and a later chapter took the next position, so position 0 is that
-- chapter. Every other chapter stays null: its time was never kept.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

ALTER TABLE chapter ADD COLUMN uploaded_at INTEGER;

UPDATE chapter SET uploaded_at = (SELECT t.created_at FROM tour t WHERE t.id = chapter.tour_id)
 WHERE position = 0 AND revision IS NULL;
