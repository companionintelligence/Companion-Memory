-- migrate:up
INSERT INTO ci.providers (id, name, description, logo_url, endpoints, auth_type, app_setup_url)
VALUES (
  '019e2b55-a4c1-7f02-b8d4-0c3e5a8f6b07',
  'Reddit',
  'Connect your Reddit account to sync your posts, comments, and saved items.',
  '/branding/reddit/logo.svg',
  '[
    { "name": "Posts", "description": "Sync your submitted Reddit posts.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Comments", "description": "Sync your Reddit comments.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Saved", "description": "Sync your saved Reddit posts and comments.", "iterationType": "historical,incremental", "TTL": 86400 }
  ]'::jsonb,
  'oauth2',
  'https://github.com/reddit-archive/reddit/wiki/OAuth2'
)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers WHERE id = '019e2b55-a4c1-7f02-b8d4-0c3e5a8f6b07';
