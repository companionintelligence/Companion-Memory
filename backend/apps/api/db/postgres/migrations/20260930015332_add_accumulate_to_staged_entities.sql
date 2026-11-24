-- migrate:up

-- The parser's `accumulate[]` list, kept on the staged row so the push can
-- honour it.
--
-- A parser declares which metadata keys are SETS that grow across sightings
-- (`Entity.accumulate` — a vCard's Emails/Phones/URLs/…, an Uber dish's
-- Orders). StagedWriter already grows those keys within one run. But the list
-- itself was never stored: the staged row kept the grown values and dropped the
-- declaration, so by the time PushStage turned the row into a graph entity
-- nothing knew which keys were sets. GraphIngestService then replaced the
-- stored `ci.entities.properties` wholesale on every re-import — so a second
-- export's orders overwrote the first's, and a Person's merged-in phone numbers
-- vanished the next time their own card was imported.
--
-- The push now reads this column and GraphIngestService set-unions these keys
-- into the existing row instead of replacing them.
--
-- NULLable, like `identity_key` and `dedupe_key` beside it: NULL means the
-- parser declared nothing (most entity types), and rows staged before this
-- migration are simply exempt rather than rewritten mid-import.
ALTER TABLE ci_import.staged_entities
    ADD COLUMN accumulate TEXT[];

COMMENT ON COLUMN ci_import.staged_entities.accumulate IS
    'Metadata keys the parser declared as accumulating sets (Entity.accumulate); unioned, not replaced, on push. NULL when none.';

-- migrate:down

ALTER TABLE ci_import.staged_entities
    DROP COLUMN IF EXISTS accumulate;
