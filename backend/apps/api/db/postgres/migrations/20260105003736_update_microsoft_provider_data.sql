-- migrate:up
UPDATE ci.providers
SET
  description = 'Bring your Microsoft account into the mix for email and scheduling. Keep track of what matters without extra steps.',
  logo_url = '/branding/microsoft/logo.svg',
  endpoints = '[
    { "name": "Outlook Mail", "description": "Sync your email messages and history." },
    { "name": "Calendar", "description": "Sync your calendar events and scheduling." },
    { "name": "OneDrive", "description": "Sync your stored files and file metadata." }
  ]'::jsonb,
  theme = '{
    "backgroundColor": "#38bdf8",
    "borderColor": "#7dd3fc"
  }'::jsonb
WHERE
  id = '0198779b-3c33-73da-84e5-82e0df145260';

-- migrate:down
UPDATE ci.providers
SET
  description = NULL,
  endpoints = '[]'::jsonb,
  theme = '{}'::jsonb
WHERE
  id = '0198779b-3c33-73da-84e5-82e0df145260';

