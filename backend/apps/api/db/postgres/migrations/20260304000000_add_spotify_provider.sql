-- migrate:up
INSERT INTO ci.providers (id, name, description, logo_url, endpoints)
VALUES (
  '019cbaf2-d789-7723-aada-7e3d709663f5',
  'Spotify',
  'Connect your Spotify account to sync your music listening history, playlists, and saved tracks.',
  'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png',
  '[
    { "name": "Recently Played", "description": "Sync your recently played tracks.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Playlists", "description": "Sync your playlists and their tracks.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Saved Tracks", "description": "Sync your saved (liked) tracks.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Saved Shows", "description": "Sync your saved podcast shows.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Saved Episodes", "description": "Sync your saved podcast episodes.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Saved Audiobooks", "description": "Sync your saved audiobooks.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Top Artists", "description": "Sync your top artists.", "iterationType": "historical", "TTL": 86400 }
  ]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers WHERE id = '019cbaf2-d789-7723-aada-7e3d709663f5';

