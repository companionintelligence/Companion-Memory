-- migrate:up
-- =====================================================================
-- SEARCH INDEX: remove the rows of people, places and concepts the user
-- asked Memory to forget
-- =====================================================================
-- `memory.forget` in archive mode sets `ci.entities.is_active` false on a
-- person, place or concept and deletes its search rows. Until now any later
-- write to that row (an edit, an import that touched it, a relationship upsert)
-- sent an update event, and the search listener indexed it again. The forgotten
-- row then came back in search, in chat's search tool and, through
-- `ci_search.mobile_search_documents`, on the phone. The listeners now refuse an
-- inactive row and the backfill sweep and the person pipeline stages skip it,
-- but the rows already written stay: the orphan sweep only removes rows whose
-- source row is gone, and a forgotten row is still there.
--
-- This removes them. A merge tombstone is inactive too; the merge deleted its
-- rows already, so this only catches one an update raced back in. Deleting a
-- `ci_search.vectors` row deletes its `mobile_search_documents` row with it
-- (ON DELETE CASCADE).
--
-- Idempotent: a second run finds nothing.

DELETE FROM ci_search.vectors v
 USING ci.entities e
 WHERE e.entity_id = v.entity_id
   AND e.is_active IS FALSE
   AND (   (v.entity_type = 'person'  AND e.entity_type = 'Person')
        OR (v.entity_type = 'place'   AND e.entity_type = 'Location')
        OR (v.entity_type = 'concept' AND e.entity_type = 'Concept'));

DELETE FROM ci_search.embeddings m
 USING ci.entities e
 WHERE e.entity_id = m.entity_id
   AND e.is_active IS FALSE
   AND (   (m.entity_type = 'person'  AND e.entity_type = 'Person')
        OR (m.entity_type = 'place'   AND e.entity_type = 'Location')
        OR (m.entity_type = 'concept' AND e.entity_type = 'Concept'));

-- migrate:down
-- Deliberately no-op. The rows removed above belong to entities the user asked
-- Memory to forget, and putting them back would bring those entities back into
-- search. Nothing re-creates them: the listeners and the backfill sweep leave
-- inactive rows out.
