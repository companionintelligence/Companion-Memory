-- migrate:up

INSERT INTO ci_search.tags (id, label, user_id, created_at, updated_at)
SELECT
    id,
    label,
    user_id,
    created_at,
    created_at
FROM ci.tags
WHERE label IS NOT NULL AND user_id IS NOT NULL
ON CONFLICT (label, user_id) DO NOTHING;

INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id, created_at)
SELECT
    'action',
    at.action_id,
    st.id,
    at.created_at
FROM ci.action_tag at
JOIN ci.tags t ON at.tag_id = t.id
JOIN ci_search.tags st ON st.label = t.label AND st.user_id = t.user_id
WHERE t.label IS NOT NULL AND t.user_id IS NOT NULL;

-- migrate:down

-- Reversing this migration is difficult because we merged data. We would need
-- to identify which rows were added by this migration. For now, we will not
-- delete data to avoid accidental data loss of pre-existing tags.

