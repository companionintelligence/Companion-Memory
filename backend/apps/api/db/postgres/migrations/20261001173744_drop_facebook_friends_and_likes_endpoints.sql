-- migrate:up
-- Facebook now offers only Posts, Photos and Videos, matching the scopes
-- FacebookClient requests. Friends is gone for good. Likes is withdrawn for
-- now: user_likes will be re-requested from Meta in a later App Review
-- submission, and a later migration puts the Likes endpoint back then.
UPDATE ci.providers
SET
  description = 'Connect your Meta account to sync your Facebook posts, photos, and videos. Stay connected with your community.',
  endpoints = '[
    { "name": "Posts", "description": "Sync your timeline posts and status updates.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Photos", "description": "Sync your uploaded photos and albums.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Videos", "description": "Sync your uploaded videos.", "iterationType": "historical,incremental", "TTL": null }
  ]'::jsonb
WHERE
  id = 'dbb8002f-12da-4cd9-b02b-37db7791a900';

-- migrate:down
UPDATE ci.providers
SET
  description = 'Connect your Meta account to sync your Facebook posts, photos, videos, friends, and likes. Stay connected with your community.',
  endpoints = '[
    { "name": "Posts", "description": "Sync your timeline posts and status updates.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Photos", "description": "Sync your uploaded photos and albums.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Videos", "description": "Sync your uploaded videos.", "iterationType": "historical,incremental", "TTL": null },
    { "name": "Friends", "description": "Sync your friend list and connections.", "iterationType": "historical", "TTL": 86400 },
    { "name": "Likes", "description": "Sync pages and content you have liked.", "iterationType": "historical", "TTL": 86400 }
  ]'::jsonb
WHERE
  id = 'dbb8002f-12da-4cd9-b02b-37db7791a900';
