-- migrate:up
INSERT INTO ci.providers (id, name, description, logo_url, endpoints, auth_type, openid_key_link)
VALUES (
  '019d6470-f9e1-720f-a3ce-299842abaece',
  'Steam',
  'Connect your Steam account to sync your game library and achievement history.',
  '/branding/steam/logo.svg',
  '[
    { "name": "Owned Games", "description": "Sync games that you own.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Achievements", "description": "Sync your achievements.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Friends", "description": "Sync your Steam friends.", "iterationType": "historical", "TTL": 86400 }
  ]'::jsonb,
  'openid',
        'https://steamcommunity.com/dev/apikey'
)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers WHERE id = '019d6470-f9e1-720f-a3ce-299842abaece';

