-- migrate:up
-- The redirect_uri a connection's OAuth authorization was sent with. The code exchange that
-- completes the authorization must send the same one. On an install with no callback address
-- configured it comes from the browser's request, so it is kept rather than worked out again.
ALTER TABLE ci.connections ADD COLUMN oauth_redirect_uri TEXT;

-- migrate:down
ALTER TABLE ci.connections DROP COLUMN oauth_redirect_uri;
