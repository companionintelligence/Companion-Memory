-- migrate:up

INSERT INTO ci_search.tags (id, label, user_id)
SELECT
    ci.gen_uuid_v7(),
    label,
    user_id
FROM (
    SELECT DISTINCT user_id, unnest(tags) as label
    FROM ci.communications
    WHERE tags IS NOT NULL AND id IS NOT NULL
) sub
ON CONFLICT (label, user_id) DO NOTHING;

INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id)
SELECT DISTINCT
    'communication',
    c.id,
    t.id
FROM ci.communications c
CROSS JOIN unnest(c.tags) as tag_label
JOIN ci_search.tags t ON t.label = tag_label AND t.user_id = c.user_id
WHERE c.tags IS NOT NULL AND c.id IS NOT NULL
ON CONFLICT (entity_type, entity_id, tag_id) DO NOTHING;

-- migrate:down

-- We do not delete data on rollback to avoid accidental data loss of tags that
-- might have been created or linked by other means since the migration ran.
