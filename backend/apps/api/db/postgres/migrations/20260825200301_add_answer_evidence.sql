-- migrate:up

-- The database rows an inferred answer was actually read out of.
--
-- `answer_rationale` is the model's SENTENCE about its evidence; this is the
-- evidence itself, so the provenance badge on the Self page can stop being a
-- claim the owner has to take on faith and become a list of messages, events and
-- records they can open.
--
-- WHY A NEW jsonb COLUMN AND NOT `extracted_entities`
--
-- `extracted_entities text[]` already exists on this table and looks like the
-- obvious home. It is not, for three independent reasons:
--
--   1. SHAPE. A citation is {line, type, id, at, voice, snippet}. A text[] can
--      only hold that by inventing a delimiter encoding inside each element,
--      which every reader then has to parse and every writer has to escape.
--   2. IT IS INDEXED AS PROSE. 20251124000000_add_fulltext_search.sql folds
--      `immutable_array_to_string(extracted_entities, ' ')` into the answers
--      full-text vector. Writing uuids there would put hex noise into answer
--      search, where it can only produce false matches.
--   3. IT MEANS SOMETHING ELSE. Its own comment in
--      20250925145200_create_answers_table.sql is "People, places, concepts
--      mentioned" — entities extracted FROM the answer text, which is a
--      different fact from the records the answer was inferred FROM. It has no
--      writer anywhere in the codebase and 0 non-null rows on the reference
--      appliance, so it is unused rather than free.
--
-- NULLABLE WITH NO DEFAULT, deliberately. NULL means "no inference ever recorded
-- evidence for this row" — a user-typed answer, an import, or an inferred row
-- written before this column existed. It never means "cited nothing": the
-- speaker gate (enforceFirstPersonEvidence) discards an answer whose citations
-- do not resolve to the owner's own records, so a stored inferred answer always
-- has at least one. A '[]'::jsonb default would blur those two states together.
--
-- TWO ARRAYS, NOT ONE. `citations` is what the model NAMED; `uncited` is what it
-- was shown and passed over. They are stored separately because they are
-- different claims: only `citations` is what the answer rests on, and a flat
-- list with an `isCited` flag is one careless render away from presenting
-- eighteen rejected lines as though they had supported something. Storing
-- `uncited` at all is what turns `linesShown` from a number the owner has to
-- believe into a list they can read — and it is the only way to tell a
-- retrieval miss (the record never came back) from a reading miss (it came back
-- and the model skipped it).
--
-- No index: this column is only ever read alongside the row it hangs off, by
-- answer_id or question_id, both of which are already indexed.
ALTER TABLE ci.answers
  ADD COLUMN answer_evidence JSONB;

COMMENT ON COLUMN ci.answers.answer_evidence IS
  'Retrieval provenance for an inferred answer: {citations:[{line,type,id,at,voice,snippet}],uncited:[same shape],linesShown,linesOwn,model}. `citations` = rows the model named; `uncited` = rows it was shown and passed over, in block order, and ABSENT (not empty) on rows written before it was recorded. `type`+`id` resolve to a real row — EntityResolutionService''s discriminant, or ''graph-node'' (ci.entities) / ''agent-memory'' (ci.agent_memory). Both arrays are capped, so citations+uncited can be short of linesShown. NULL = no inference recorded evidence, never "cited nothing".';

-- migrate:down

ALTER TABLE ci.answers
  DROP COLUMN answer_evidence;
