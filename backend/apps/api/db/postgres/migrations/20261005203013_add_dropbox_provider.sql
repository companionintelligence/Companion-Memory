-- migrate:up
INSERT INTO ci.providers (id, name, description, logo_url, endpoints, auth_type, app_setup_url)
VALUES (
  '01a10dc2-7dc5-7d4c-b3ab-7d3caaf7ebd3',
  'Dropbox',
  'Connect your Dropbox to sync your files, documents, and any data exports saved there.',
  '/branding/dropbox/logo.svg',
  '[
    { "name": "Files", "description": "Sync your stored files and file metadata.", "iterationType": "historical,incremental", "TTL": null }
  ]'::jsonb,
  'oauth2',
  'https://www.dropbox.com/developers/apps'
)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers WHERE id = '01a10dc2-7dc5-7d4c-b3ab-7d3caaf7ebd3';
