-- A storage allowance per workspace: three columns, each nullable or with a default, so
-- rows written before this migration stay valid and the statements of the version before
-- it, which name none of them, still run. Nothing is dropped, renamed or rebuilt.

-- The most bytes the workspace may use, counted as src/usage.ts counts them. Null means
-- the site's default (the STORAGE_ALLOWANCE_BYTES setting, or no limit without it); 0 is
-- a limit of its own.
ALTER TABLE workspace ADD COLUMN storage_allowance_bytes INTEGER CHECK (storage_allowance_bytes IS NULL OR storage_allowance_bytes >= 0);

-- What an open upload holds against the allowance: the declared bytes of its steps, plus
-- room for a logo it takes. 0 for an upload created before this migration. Never negative.
ALTER TABLE upload ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0);

-- The size of the tour's logo, carried over from the upload at commit. Null for a logo
-- stored before this migration, which counts as nothing. Never negative.
ALTER TABLE tour ADD COLUMN logo_bytes INTEGER CHECK (logo_bytes IS NULL OR logo_bytes >= 0);
