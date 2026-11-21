-- Whether a tour has ever been published (0.1.51). A token may say who may view a tour on the
-- request that starts its FIRST publish only (src/access.ts, planFirstPublish): never for a tour
-- that has been published before, also when it was unpublished since. Nothing the schema kept
-- said so once a tour was unpublished (unpublish empties tour.published_at and removes the
-- snapshot), so this column keeps it: unpublish sets it (src/publish.ts) in the batch that
-- removes the rest of that evidence, and nothing ever clears it; while a tour is published,
-- its status and snapshot say so already. It is additive, with a default, so rows written before this migration
-- stay valid; an older build never names it, and its publish leaves it as it was.
--
-- The tours that are published now, or have a live version or a move of their pictures, are
-- marked here. A tour published and unpublished before this migration left nothing behind and
-- stays unmarked: it counts as never published.
--
-- The first statement fails on a database that already has this migration, so a second
-- application stops before it changes anything.

ALTER TABLE tour ADD COLUMN ever_published INTEGER NOT NULL DEFAULT 0 CHECK (ever_published IN (0, 1));

UPDATE tour SET ever_published = 1
 WHERE status = 'published' OR published_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM snapshot s WHERE s.tour_id = tour.id)
    OR EXISTS (SELECT 1 FROM access_switch w WHERE w.tour_id = tour.id);

-- The id of the token whose first publish set the tour's setting and list, while nothing else
-- has written them since; NULL otherwise, and for every tour at this migration. A first publish
-- that states a list compares it with the tour's only when this is the asking token's id
-- (src/access.ts, OWN_CREATION), so a token can confirm only a list it sent itself. The access
-- PUT empties it in every batch that writes the setting or the list. An id is "tok_" and 24
-- lowercase hex characters (src/auth.ts, newId).
ALTER TABLE tour ADD COLUMN access_set_by TEXT CHECK (access_set_by IS NULL OR (length(access_set_by) = 28 AND length(CAST(access_set_by AS BLOB)) = 28 AND substr(access_set_by, 1, 4) = 'tok_' AND substr(access_set_by, 5) NOT GLOB '*[^0-9a-f]*'));
