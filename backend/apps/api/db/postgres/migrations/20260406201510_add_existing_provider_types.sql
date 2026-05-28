-- migrate:up
UPDATE ci.providers SET auth_type = 'oauth2' WHERE id IN (
    '0198779b-3c33-73da-84e5-82e0df145260', -- Microsoft
    '0198779b-182c-716e-9275-b81d99a47fdb', -- Google
    'dbb8002f-12da-4cd9-b02b-37db7791a900', -- Facebook
    '019cbaf2-d789-7723-aada-7e3d709663f5' -- Spotify
);

-- migrate:down
UPDATE ci.providers SET auth_type = NULL WHERE id IN (
    '0198779b-3c33-73da-84e5-82e0df145260', -- Microsoft
    '0198779b-182c-716e-9275-b81d99a47fdb', -- Google
    'dbb8002f-12da-4cd9-b02b-37db7791a900', -- Facebook
    '019cbaf2-d789-7723-aada-7e3d709663f5' -- Spotify
);

