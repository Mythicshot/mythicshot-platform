-- Publishing in bounded steps, so no single request makes more than a fixed number of
-- database and storage calls (Cloudflare's free plan allows 50 per request).
--
-- A publish is a job: its first request reads the draft once, builds the snapshot and
-- records it here together with one 'pending' public_object row per image it will copy.
-- Each later request copies the next few images and marks them copied. The request that
-- copies the last ones commits in one batch, exactly as before: the snapshot switches
-- only then, so viewers see the previous version until that moment.
--
-- One job per tour at most (the primary key): a publish started while another of the
-- same draft is in progress joins it instead of starting a second one.
CREATE TABLE publish_job (
  tour_id TEXT PRIMARY KEY NOT NULL REFERENCES tour (id),
  publish_id TEXT NOT NULL UNIQUE,
  -- The finished snapshot text. The commit copies it into snapshot inside the database,
  -- so the requests in between never read it.
  data TEXT NOT NULL,
  steps INTEGER NOT NULL,
  -- Images to copy: one per step, and the cover logo if there is one.
  total INTEGER NOT NULL,
  -- The tour's draft_version the snapshot was built from: a fresh start that finds a job
  -- of an older draft cancels it and starts again from the current one.
  draft_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Refreshed by every call that makes progress, on this row only. A job not touched for
  -- the stale period is abandoned: any later request in the workspace retires its rows
  -- and drops it.
  touched_at INTEGER NOT NULL
) STRICT;

-- Bumped by every upload commit into the tour (a new tour starts at 1), so a publish can
-- tell exactly whether the draft changed since it started.
ALTER TABLE tour ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 0;

-- Housekeeping finds a workspace's abandoned pending rows through the workspace's tours.
CREATE INDEX public_object_tour_pending ON public_object (tour_id, state, created_at);

-- For a pending row: the draft key it is copied from, its place in the copy order, and
-- whether it has been copied. Rows of other states leave source_key null or keep it.
ALTER TABLE public_object ADD COLUMN source_key TEXT;
ALTER TABLE public_object ADD COLUMN seq INTEGER;
ALTER TABLE public_object ADD COLUMN copied INTEGER NOT NULL DEFAULT 0 CHECK (copied IN (0, 1));
CREATE INDEX public_object_copy ON public_object (publish_id, state, copied, seq);

-- The step count of the live snapshot, so a repeated final call can answer without
-- reading the snapshot text.
ALTER TABLE snapshot ADD COLUMN steps INTEGER;
