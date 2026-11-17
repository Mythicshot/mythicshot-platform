-- Bookkeeping that keeps publish and unpublish exact. Every object in the public store
-- is recorded in exactly one place at every moment: in snapshot_object while a live
-- snapshot uses it, or in public_object while it is not (yet, or any more) part of one.
-- Moving a key between the two happens inside one batch, so no failure, crash or race
-- can leave a public object that no row names.

-- 'pending': written (or about to be written) by a publish that has not committed. The
--   row is inserted before the object is written.
-- 'retired': taken out of a live snapshot by a later publish or by unpublish, waiting to
--   be deleted. No live snapshot refers to it, so any request may delete it once
--   delete_after has passed. A key a re-publish replaced keeps being served until then,
--   so a viewer still on the previous page (cached for a minute) keeps its images;
--   unpublish and a failed publish set delete_after to the moment they retire the key.
-- publish_id names the request that wrote (pending) or retired (retired) the key.
CREATE TABLE public_object (
  image_key TEXT PRIMARY KEY NOT NULL,
  tour_id TEXT NOT NULL REFERENCES tour (id),
  publish_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'retired')),
  created_at INTEGER NOT NULL,
  delete_after INTEGER,
  CHECK ((state = 'retired') = (delete_after IS NOT NULL))
) STRICT;
CREATE INDEX public_object_tour ON public_object (tour_id, state);
CREATE INDEX public_object_due ON public_object (state, delete_after);
CREATE INDEX public_object_publish ON public_object (publish_id, state);

-- The publish whose objects the live snapshot uses, so a publish whose batch answered
-- with an error can tell whether it committed after all.
ALTER TABLE snapshot ADD COLUMN publish_id TEXT;

-- A public key belongs to one snapshot only, so unpublishing one tour can never delete
-- an image another tour's snapshot uses. The public image route looks names up here.
CREATE UNIQUE INDEX snapshot_object_key ON snapshot_object (image_key);
