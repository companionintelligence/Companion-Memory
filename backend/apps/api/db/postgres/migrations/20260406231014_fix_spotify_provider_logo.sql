-- migrate:up
UPDATE ci.providers
SET
    logo_url = '/branding/spotify/logo.svg'
WHERE
    id = '019cbaf2-d789-7723-aada-7e3d709663f5';

-- migrate:down
UPDATE ci.providers
SET
    logo_url = 'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png'
WHERE
    id = '019cbaf2-d789-7723-aada-7e3d709663f5';
