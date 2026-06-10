-- migrate:up
UPDATE ci.providers SET local_only = true WHERE id IN (
    '019cbaf2-d789-7723-aada-7e3d709663f5' -- Spotify
);

UPDATE ci.providers SET app_setup_url = 'https://support.google.com/googleapi/answer/6158849' WHERE id IN (
    '0198779b-182c-716e-9275-b81d99a47fdb' -- Google
);

UPDATE ci.providers SET app_setup_url = 'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app' WHERE id IN (
    '0198779b-3c33-73da-84e5-82e0df145260' -- Microsoft
);

UPDATE ci.providers SET app_setup_url = 'https://developers.facebook.com/docs/development/create-an-app/' WHERE id IN (
    'dbb8002f-12da-4cd9-b02b-37db7791a900' -- Facebook
);

UPDATE ci.providers SET app_setup_url = 'https://developer.spotify.com/documentation/web-api/concepts/apps' WHERE id IN (
    '019cbaf2-d789-7723-aada-7e3d709663f5' -- Spotify
);

UPDATE ci.providers SET app_setup_url = 'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app' WHERE id IN (
    '019d7a32-e4b0-7f01-b5c2-8a1d3e6f9c04' -- GitHub
);

-- migrate:down

UPDATE ci.providers SET app_setup_url = null WHERE id IN (
    '0198779b-182c-716e-9275-b81d99a47fdb', -- Google
    '0198779b-3c33-73da-84e5-82e0df145260', -- Microsoft
    'dbb8002f-12da-4cd9-b02b-37db7791a900', -- Facebook
    '019cbaf2-d789-7723-aada-7e3d709663f5', -- Spotify
    '019d7a32-e4b0-7f01-b5c2-8a1d3e6f9c04' -- GitHub
);

update ci.providers SET local_only = false WHERE id IN (
    '019cbaf2-d789-7723-aada-7e3d709663f5' -- Spotify
);
