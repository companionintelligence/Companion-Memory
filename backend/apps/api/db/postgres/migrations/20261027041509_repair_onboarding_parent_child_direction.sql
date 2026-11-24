-- migrate:up
-- Turn round the parent and child links onboarding stored backwards.
--
-- Onboarding's "Who are you usually around?" step asks for a name and what
-- that person is to you ("Parent", "Child"). `captureConnections` writes the
-- edge FROM the user TO the person, and `RELATIONSHIP_MAP` mapped "parent" to
-- PARENT_OF and "child" to CHILD_OF. PARENT_OF points from parent to child
-- (`relationshipNormalize.ts`; CHILD_OF is a write-time alias stored swapped),
-- so every one of these said the opposite of what the user entered:
--
--   * "Morgan, Parent" became `user PARENT_OF Morgan`: Morgan is the child;
--   * "Riley, Child" became `user CHILD_OF Riley`, stored as
--     `Riley PARENT_OF user`: Riley is the parent.
--
-- Self > About you now names family by role from the edge's direction (#3143),
-- so these showed a parent as "child" and a child as "parent". The writer is
-- fixed in the same change. This swaps the endpoints of the rows it already
-- wrote, which is right for both cases above and for a CHILD_OF row stored
-- before the alias was swapped at write time.
--
-- Which rows: `properties.source = 'onboarding'` with type PARENT_OF or
-- CHILD_OF. `captureConnections` is the only writer of a person-to-person edge
-- with that source, so the set is exactly what it wrote, whichever Person the
-- account points at today.
--
-- If the corrected edge already exists and is live (the same tie came in from
-- an import or a later edit), the backwards row is retired instead of swapped,
-- because the swap would collide with `relationships_unique_directed_idx`.
--
-- Not idempotent, and it can't be: a row the fixed writer stores has the same
-- shape as a backwards one with the opposite meaning. dbmate runs it once.
-- Don't run it again by hand, and don't take it down and up on data that
-- onboarding wrote after it ran.

UPDATE ci.relationships r
   SET is_active = false,
       updated_at = now()
 WHERE r.properties ->> 'source' = 'onboarding'
   AND r.relationship_type IN ('PARENT_OF', 'CHILD_OF')
   AND r.is_active
   AND EXISTS (SELECT 1
                 FROM ci.relationships o
                WHERE o.is_active
                  AND o.relationship_id <> r.relationship_id
                  AND o.from_entity_id = r.to_entity_id
                  AND o.to_entity_id = r.from_entity_id
                  AND o.relationship_type = r.relationship_type);

UPDATE ci.relationships r
   SET from_entity_id = r.to_entity_id,
       to_entity_id = r.from_entity_id,
       from_entity_type = r.to_entity_type,
       to_entity_type = r.from_entity_type,
       updated_at = now()
 WHERE r.properties ->> 'source' = 'onboarding'
   AND r.relationship_type IN ('PARENT_OF', 'CHILD_OF')
   AND r.is_active;

-- migrate:down
-- No-op: an irreversible data repair. Swapping these back would restore the
-- backwards parent and child links.
SELECT 1;
