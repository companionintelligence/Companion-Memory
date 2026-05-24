-- migrate:up
UPDATE ci.providers
SET
  description = 'Link your Google account for quick access to Gmail, Calendar, Drive, Contacts, and YouTube. Everything you need, always in sync.',
  logo_url = '/branding/google/logo.svg',
  endpoints = '[
    { "name": "Gmail", "description": "Sync your email messages and history." },
    { "name": "Calendar", "description": "Sync your calendar events and scheduling." },
    { "name": "Drive", "description": "Sync your stored files and file metadata." },
    { "name": "Contacts", "description": "Sync your contact information and connections." },
    { "name": "YouTube", "description": "Sync your playlists, likes, subscriptions, and activities." }
  ]'::jsonb,
  theme = '{
    "backgroundColor": "#a78bfa",
    "borderColor": "#c4b5fd"
  }'::jsonb
WHERE
  id = '0198779b-182c-716e-9275-b81d99a47fdb';

-- migrate:down
UPDATE ci.providers
SET
  description = '',
  endpoints = '[]'::jsonb,
  theme = '{}'::jsonb
WHERE
  id = '0198779b-182c-716e-9275-b81d99a47fdb';
