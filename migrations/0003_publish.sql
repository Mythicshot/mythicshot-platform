-- Bookkeeping that keeps publish and unpublish exact. Every object in the public store
-- is recorded in exactly one place at every moment: in snapshot_object while a live
-- snapshot uses it, or in public_object while it is not (yet, or any more) part of one.
-- Moving a key between the two happens inside one batch, so no failure, crash or race
-- can leave a public object that no row names.

-- 'pending': written (or about to be written) by a publish that has not committed. The
--   row is inserted before the object is written.
-- 'retired': taken out of a live snapshot by a later publish or by unpublish, waiting to
--   be deleted. Nothing live refers to it, so any request may delete it.
-- publish_id names the request that wrote (pending) or retired (retired) the key.
CREATE TABLE public_object (
  image_key TEXT PRIMARY KEY NOT NULL,
  tour_id TEXT NOT NULL REFERENCES tour (id),
  publish_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'retired')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX public_object_tour ON public_object (tour_id, state);
CREATE INDEX public_object_publish ON public_object (publish_id, state);

-- The publish whose objects the live snapshot uses, so a publish whose batch answered
-- with an error can tell whether it committed after all.
ALTER TABLE snapshot ADD COLUMN publish_id TEXT;

-- The public image route checks that a name belongs to a live snapshot.
CREATE INDEX snapshot_object_key ON snapshot_object (image_key);
