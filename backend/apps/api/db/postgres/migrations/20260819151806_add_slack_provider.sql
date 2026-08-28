-- migrate:up
INSERT INTO ci.providers (id, name, description, logo_url, endpoints, auth_type, app_setup_url)
VALUES (
  '019e3c66-b5d2-7f03-c9e5-1a4f6b9d0c08',
  'Slack',
  'Connect your Slack workspace to sync channels and messages.',
  '/branding/slack/logo.svg',
  '[
    { "name": "Messages", "description": "Sync messages from channels and direct messages.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Channels", "description": "Sync Slack channel metadata.", "iterationType": "historical", "TTL": 86400 }
  ]'::jsonb,
  'oauth2',
  'https://api.slack.com/apps'
)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers WHERE id = '019e3c66-b5d2-7f03-c9e5-1a4f6b9d0c08';
