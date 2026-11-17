-- The whole schema, for both targets. Ids are TEXT and timestamps are integer
-- milliseconds. Tables are STRICT: both back ends bind every JS number as REAL, and a
-- STRICT INTEGER column stores an integral REAL as an integer and refuses text. A TEXT
-- column would still turn a bound number into text such as "5.0", so ids are always
-- bound as strings. Foreign keys are enforced on both targets and never cascade: a
-- delete removes only rows the caller names.

CREATE TABLE workspace (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX user_workspace ON user (workspace_id);

-- Only the SHA-256 hex digest of a token is stored, never the token.
CREATE TABLE api_token (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE INDEX api_token_workspace ON api_token (workspace_id);

CREATE TABLE tour (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  spotlight_dim INTEGER CHECK (spotlight_dim BETWEEN 10 AND 90),
  end_text TEXT,
  end_button_label TEXT,
  end_button_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
) STRICT;
CREATE INDEX tour_workspace ON tour (workspace_id);

CREATE TABLE chapter (
  id TEXT PRIMARY KEY NOT NULL,
  tour_id TEXT NOT NULL REFERENCES tour (id),
  title TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL
) STRICT;
CREATE INDEX chapter_tour ON chapter (tour_id);

CREATE TABLE step (
  id TEXT PRIMARY KEY NOT NULL,
  tour_id TEXT NOT NULL REFERENCES tour (id),
  chapter_id TEXT REFERENCES chapter (id),
  position INTEGER NOT NULL,
  image_key TEXT NOT NULL,
  image_type TEXT NOT NULL CHECK (image_type IN ('png', 'jpg')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  click_x REAL NOT NULL,
  click_y REAL NOT NULL,
  click_size REAL NOT NULL DEFAULT 4,
  caption TEXT,
  spotlight TEXT,
  notes TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX step_tour ON step (tour_id);
CREATE INDEX step_chapter ON step (chapter_id);

-- tour_id is null while an upload creates a new tour.
CREATE TABLE upload (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  tour_id TEXT REFERENCES tour (id),
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX upload_workspace ON upload (workspace_id);
CREATE INDEX upload_created ON upload (created_at);
CREATE INDEX upload_tour ON upload (tour_id);

-- The objects an upload put in the drafts store, so an abort deletes exactly these.
CREATE TABLE upload_step (
  upload_id TEXT NOT NULL REFERENCES upload (id),
  n INTEGER NOT NULL,
  image_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (upload_id, n)
) STRICT;

CREATE TABLE snapshot (
  tour_id TEXT PRIMARY KEY NOT NULL REFERENCES tour (id),
  data TEXT NOT NULL,
  published_at INTEGER NOT NULL
) STRICT;

-- The objects a published snapshot put in the public store, so unpublish deletes exactly these.
CREATE TABLE snapshot_object (
  tour_id TEXT NOT NULL REFERENCES tour (id),
  image_key TEXT NOT NULL,
  PRIMARY KEY (tour_id, image_key)
) STRICT;

-- At most one row: id can only be 1.
CREATE TABLE setup (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  completed_at INTEGER NOT NULL
) STRICT;
