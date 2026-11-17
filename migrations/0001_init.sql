-- Placeholder until the schema lands: proves migrations run on both targets.
CREATE TABLE IF NOT EXISTS platform_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
