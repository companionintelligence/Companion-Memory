-- migrate:up
UPDATE ci.providers
SET
  endpoints = '[
    { "name": "Gmail", "description": "Sync your email messages and history.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Calendar", "description": "Sync your calendar events and scheduling.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Drive", "description": "Sync your stored files and file metadata.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Contacts", "description": "Sync your contact information and connections.", "iterationType": "historical", "TTL": 86400 },
    { "name": "YouTube", "description": "Sync your playlists, likes, subscriptions, and activities.", "iterationType": "historical,incremental", "TTL": null }
  ]'::jsonb
WHERE
  id = '0198779b-182c-716e-9275-b81d99a47fdb';

-- migrate:down
UPDATE ci.providers
SET
  endpoints = '[
    { "name": "Gmail", "description": "Sync your email messages and history." },
    { "name": "Calendar", "description": "Sync your calendar events and scheduling." },
    { "name": "Drive", "description": "Sync your stored files and file metadata." },
    { "name": "Contacts", "description": "Sync your contact information and connections." },
    { "name": "YouTube", "description": "Sync your playlists, likes, subscriptions, and activities." }
  ]'::jsonb
WHERE
  id = '0198779b-182c-716e-9275-b81d99a47fdb';
