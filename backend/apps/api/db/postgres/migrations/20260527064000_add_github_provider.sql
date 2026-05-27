-- migrate:up
INSERT INTO ci.providers (id, name, description, logo_url, endpoints, auth_type)
VALUES (
  'b2cf9b7d-bd08-44c7-8b37-25fcf898d04a',
  'GitHub',
  'Connect GitHub to sync your repositories, pushes, pull requests, issues, and review activity.',
  '/branding/github/logo.svg',
  '[
    { "name": "Repository Events", "description": "Sync repository events from every GitHub repository you can access.", "iterationType": "historical,incremental", "TTL": 86400 }
  ]'::jsonb,
  'oauth2'
)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers WHERE id = 'b2cf9b7d-bd08-44c7-8b37-25fcf898d04a';
