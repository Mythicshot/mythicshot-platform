-- Deleting a tour in bounded steps, so no single request makes more than a fixed number
-- of database and storage calls (Cloudflare's free plan allows 50 per request).
--
-- The first request of a delete removes every row of the tour, the tour row included, in
-- one batch, and in that same batch records here every file the tour owned. From that
-- moment the tour is gone for every other route (it cannot be listed, published, renamed
-- or added to, and its public page and images answer 404); only its files remain, each
-- named by one row. That request and the ones after it delete the files a page at a
-- time, then their rows, and the last one drops the tour_deletion row.
--
-- A tour id is random and never reused, so tour_id names the deleted tour only. It is not
-- a foreign key to tour: the tour row no longer exists.
CREATE TABLE tour_deletion (
  tour_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  -- Files recorded by the first request, for the progress the later ones report.
  total INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tour_deletion_workspace ON tour_deletion (workspace_id);

-- One row per file still to delete: 'drafts' for the drafts store (step images, the logo,
-- the files of unfinished uploads into the tour), 'public' for the public store (the live
-- snapshot's images, and those a publish replaced or left behind). The row goes only
-- after its file has.
CREATE TABLE deleted_object (
  tour_id TEXT NOT NULL REFERENCES tour_deletion (tour_id),
  store TEXT NOT NULL CHECK (store IN ('drafts', 'public')),
  image_key TEXT NOT NULL,
  PRIMARY KEY (tour_id, store, image_key)
) STRICT;
