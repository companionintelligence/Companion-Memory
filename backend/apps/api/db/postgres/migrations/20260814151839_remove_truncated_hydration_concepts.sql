-- migrate:up
-- =================================================================
-- Remove Concept nodes that are truncated sentences, not concepts
-- =================================================================
-- CrossTableHydrationService built a graph Concept out of an answer's text with
-- `name: text.slice(0, 120)` and `key: text.slice(0, 64)`, then asserted
-- `self -INTERESTED_IN-> <that>`. It was written for single-choice answers
-- ("hiking, bowling, ice skating or arcading?" -> "Hiking"), but free-text
-- answers reach the same path, so a paragraph became a node named by an
-- arbitrary 120-character cut of itself. Observed on a real appliance:
--
--   "I am most proud of my capacity to be the proactive architect who estab"
--   "I hope my legacy is the establishment of structured systems for human "
--   "Being a parent and spouse defines my life's purpose through my commitm"
--
-- Each was typed `properties.type = 'activity'` and linked as an interest, in
-- the graph that RAG, recall and insight generation read.
--
-- The extractor is fixed in the same change (shouldSkipHydrationCandidate now
-- rejects text longer than the 64-char key window or over six words, and the
-- slices are gone), so this only has to clear what already landed.
--
-- PREDICATE SAFETY: `length(name) > 64` cannot match a well-formed row. The
-- fixed extractor rejects anything past 64 characters before a node is built,
-- and the old one derived its dedupe KEY from the first 64 characters — so any
-- surviving longer name is necessarily a truncated-sentence artifact of the bug.
-- Scoped further to entity_type 'Concept' and the exact provenance stamp this
-- code writes, so nothing another writer produced is in range.
--
-- Edges are deleted FIRST and explicitly: ci.relationships has no foreign key to
-- ci.entities (only owner_user_id -> ci.users), so removing a node does NOT
-- cascade its edges — doing this in the other order would leave INTERESTED_IN
-- rows pointing at an entity_id that no longer exists.
--
-- No graph_deltas are written. The ci.entities triggers were dropped in
-- 20260811210000 and this file does not call GraphDeltaWriter, which is correct
-- here: retracting rows that should never have been nodes is not a change to
-- the user's graph worth surfacing to them as an insight.

CREATE TEMPORARY TABLE truncated_hydration_concepts AS
SELECT entity_id
FROM ci.entities
WHERE entity_type = 'Concept'
  AND properties ->> 'source' = 'hydrate_answers'
  AND length(name) > 64;

DELETE FROM ci.relationships
WHERE from_entity_id IN (SELECT entity_id FROM truncated_hydration_concepts)
   OR to_entity_id IN (SELECT entity_id FROM truncated_hydration_concepts);

DELETE FROM ci.entities
WHERE entity_id IN (SELECT entity_id FROM truncated_hydration_concepts);

DROP TABLE truncated_hydration_concepts;

-- migrate:down
-- Not reversible: these rows were malformed and are not reconstructable. The
-- answers they were derived from are untouched in ci.answers, which is where
-- that text belonged all along.
SELECT 1;
