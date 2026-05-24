-- migrate:up
UPDATE ci.providers
SET
  endpoints = '[
    { "name": "Outlook Mail", "description": "Sync your email messages and history.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Calendar", "description": "Sync your calendar events and scheduling.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "OneDrive", "description": "Sync your stored files and file metadata.", "iterationType": "historical,incremental", "TTL": null }
  ]'::jsonb
WHERE
  id = '0198779b-3c33-73da-84e5-82e0df145260';

-- migrate:down
UPDATE ci.providers
SET
    endpoints = '[
    { "name": "Outlook Mail", "description": "Sync your email messages and history." },
    { "name": "Calendar", "description": "Sync your calendar events and scheduling." },
    { "name": "OneDrive", "description": "Sync your stored files and file metadata." }
  ]'::jsonb
WHERE
  id = '0198779b-3c33-73da-84e5-82e0df145260';

