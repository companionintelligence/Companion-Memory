-- migrate:up
-- Update relationship entity types based on the entity_type of related entities
-- This migration runs after add_relationship_to_from_columns has created the to_entity_type and from_entity_type columns

UPDATE ci.relationships r
SET
    from_entity_type = CASE
        WHEN e_from.entity_type = 'Concept' THEN 'concept'
        WHEN e_from.entity_type = 'Communication' THEN 'communication'
        WHEN e_from.entity_type = 'Content' THEN 'content'
        WHEN e_from.entity_type = 'Item' THEN 'item'
        WHEN e_from.entity_type = 'Location' THEN 'place'
        WHEN e_from.entity_type = 'Person' THEN 'person'
        ELSE LOWER(e_from.entity_type)
    END,
    to_entity_type = CASE
        WHEN e_from.entity_type = 'Concept' THEN 'concept'
        WHEN e_from.entity_type = 'Communication' THEN 'communication'
        WHEN e_from.entity_type = 'Content' THEN 'content'
        WHEN e_from.entity_type = 'Item' THEN 'item'
        WHEN e_from.entity_type = 'Location' THEN 'place'
        WHEN e_from.entity_type = 'Person' THEN 'person'
        ELSE LOWER(e_to.entity_type)
    END
FROM
    ci.entities e_from,
    ci.entities e_to
WHERE
    r.from_entity_id = e_from.entity_id
    AND r.to_entity_id = e_to.entity_id;

-- migrate:down
-- Reset the entity type columns to NULL
UPDATE ci.relationships
SET
    from_entity_type = NULL,
    to_entity_type = NULL;
