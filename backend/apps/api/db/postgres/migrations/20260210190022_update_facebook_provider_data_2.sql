-- migrate:up
UPDATE ci.providers
SET
  endpoints = '[
    { "name": "Posts", "description": "Sync your timeline posts and status updates.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Photos", "description": "Sync your uploaded photos and albums.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Videos", "description": "Sync your uploaded videos.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Friends", "description": "Sync your friend list and connections.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Likes", "description": "Sync pages and content you have liked.", "iterationType": "historical,incremental", "TTL": null }
  ]'::jsonb
WHERE
  id = 'dbb8002f-12da-4cd9-b02b-37db7791a900';

-- migrate:down
UPDATE ci.providers
SET
  endpoints = '[
    { "name": "Posts", "description": "Sync your timeline posts and status updates." },
    { "name": "Photos", "description": "Sync your uploaded photos and albums." },
    { "name": "Videos", "description": "Sync your uploaded videos." },
    { "name": "Friends", "description": "Sync your friend list and connections." },
    { "name": "Likes", "description": "Sync pages and content you have liked." }
  ]'::jsonb
WHERE
  id = 'dbb8002f-12da-4cd9-b02b-37db7791a900';
