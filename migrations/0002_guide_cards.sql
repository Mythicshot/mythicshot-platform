-- The guide-card settings (manifest version 3) and the upload bookkeeping that keeps an
-- abort exact. Every new column is nullable or has a default, so rows written before
-- this migration stay valid. The older end_text, end_button_label and end_button_url
-- columns on tour stay and are left empty; end_card replaces them.

-- Each JSON column holds the validated object from the manifest, or null.
ALTER TABLE tour ADD COLUMN theme TEXT;
ALTER TABLE tour ADD COLUMN zoom TEXT;
ALTER TABLE tour ADD COLUMN cover TEXT;
ALTER TABLE tour ADD COLUMN cta TEXT;
ALTER TABLE tour ADD COLUMN end_card TEXT;
ALTER TABLE tour ADD COLUMN autoplay TEXT;
ALTER TABLE tour ADD COLUMN logo_key TEXT;
ALTER TABLE tour ADD COLUMN logo_type TEXT CHECK (logo_type IN ('png', 'jpg'));

ALTER TABLE step ADD COLUMN card TEXT;
ALTER TABLE step ADD COLUMN advance TEXT NOT NULL DEFAULT 'hotspot' CHECK (advance IN ('hotspot', 'anywhere'));
ALTER TABLE step ADD COLUMN zoom INTEGER CHECK (zoom IN (0, 1));

-- logo_key is recorded before the logo object is written and logo_bytes after, so a
-- logo with a key and no bytes was never finished.
ALTER TABLE upload ADD COLUMN logo_key TEXT;
ALTER TABLE upload ADD COLUMN logo_bytes INTEGER;
-- Set by an abort before it deletes anything. A commit refuses an upload that has it, so
-- an abort and a commit can never both act on the same upload.
ALTER TABLE upload ADD COLUMN closing_at INTEGER;

-- A step's row is written before its object (claiming the step number, so a second send
-- cannot replace the first) and stored_at after the object is written. Commit needs
-- stored_at on every step. claim is a random token naming the request that holds the
-- step and claimed_at when it took it: a claim left unfinished for a while (its request
-- died) may be taken over by a resend, and only the current holder may finish it.
ALTER TABLE upload_step ADD COLUMN stored_at INTEGER;
ALTER TABLE upload_step ADD COLUMN claim TEXT;
ALTER TABLE upload_step ADD COLUMN claimed_at INTEGER;
