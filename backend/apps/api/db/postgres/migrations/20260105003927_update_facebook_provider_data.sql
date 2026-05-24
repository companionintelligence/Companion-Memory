-- migrate:up
UPDATE ci.providers
SET
  description = 'Connect your Meta account to sync your Facebook posts, photos, videos, friends, and likes. Stay connected with your community.',
  logo_url = '/branding/meta/logo.svg',
  endpoints = '[
    { "name": "Posts", "description": "Sync your timeline posts and status updates." },
    { "name": "Photos", "description": "Sync your uploaded photos and albums." },
    { "name": "Videos", "description": "Sync your uploaded videos." },
    { "name": "Friends", "description": "Sync your friend list and connections." },
    { "name": "Likes", "description": "Sync pages and content you have liked." }
  ]'::jsonb,
  theme = '{
    "backgroundColor": "#3b82f6",
    "borderColor": "#60a5fa"
  }'::jsonb
WHERE
  id = 'dbb8002f-12da-4cd9-b02b-37db7791a900';

-- migrate:down
UPDATE ci.providers
SET
  description = NULL,
  endpoints = '[]'::jsonb,
  theme = '{}'::jsonb
WHERE
  id = 'dbb8002f-12da-4cd9-b02b-37db7791a900';

