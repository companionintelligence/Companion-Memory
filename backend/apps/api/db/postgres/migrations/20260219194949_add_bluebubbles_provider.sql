-- migrate:up
INSERT INTO ci.providers (id, name, description, logo_url, endpoints, theme)
VALUES (
  '019e8a1b-5c2d-7f3e-a1b4-c9d8e7f6a5b4',
  'BlueBubbles',
  'Connect your iMessage through BlueBubbles to sync messages, chats, and media. Stay connected with your conversations.',
  '/branding/bluebubbles/logo.svg',
  '[
    { "name": "Messages", "description": "Sync your iMessage conversations and messages.", "iterationType": "incremental", "TTL": 3600 },
    { "name": "Chats", "description": "Sync your chat threads and participants.", "iterationType": "full", "TTL": 86400 },
    { "name": "Media", "description": "Sync attachments and media from your messages.", "iterationType": "incremental", "TTL": 3600 }
  ]'::jsonb,
  '{
    "backgroundColor": "#007AFF",
    "borderColor": "#0051D5"
  }'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers
WHERE id = '019e8a1b-5c2d-7f3e-a1b4-c9d8e7f6a5b4';
