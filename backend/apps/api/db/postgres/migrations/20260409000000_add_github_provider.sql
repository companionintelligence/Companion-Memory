-- migrate:up
INSERT INTO ci.providers (id, name, description, logo_url, endpoints, auth_type)
VALUES (
  '019d7a32-e4b0-7f01-b5c2-8a1d3e6f9c04',
  'GitHub',
  'Connect your GitHub account to sync your activity and events.',
  '/branding/github/logo.svg',
  '[
    { "name": "Events", "description": "Sync your GitHub activity events.", "iterationType": "historical,incremental", "TTL": null }
  ]'::jsonb,
  'oauth2'
)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers WHERE id = '019d7a32-e4b0-7f01-b5c2-8a1d3e6f9c04';

