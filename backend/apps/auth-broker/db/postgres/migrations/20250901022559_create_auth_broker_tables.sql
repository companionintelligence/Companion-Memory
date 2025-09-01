-- migrate:up

-- OAuth Providers table
CREATE TABLE oauth_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    client_id VARCHAR(512) NOT NULL,
    client_secret VARCHAR(1024) NOT NULL,
    authorization_url TEXT NOT NULL,
    token_url TEXT NOT NULL,
    scopes JSON NOT NULL DEFAULT '[]'::json,
    redirect_uri TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    logo_url TEXT,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index on name for lookups
CREATE INDEX idx_oauth_providers_name ON oauth_providers(name);

-- Index on active providers
CREATE INDEX idx_oauth_providers_active ON oauth_providers(active);

-- Broker Tokens table
CREATE TABLE broker_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    provider_id UUID NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    scopes JSON NOT NULL DEFAULT '[]'::json,
    token_type VARCHAR(50) NOT NULL DEFAULT 'Bearer',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Unique constraint: one active token per user per provider
    CONSTRAINT unique_user_provider UNIQUE (user_id, provider_id) 
        DEFERRABLE INITIALLY DEFERRED
);

-- Indexes for efficient lookups
CREATE INDEX idx_broker_tokens_user_id ON broker_tokens(user_id);
CREATE INDEX idx_broker_tokens_provider_id ON broker_tokens(provider_id);
CREATE INDEX idx_broker_tokens_active ON broker_tokens(active);
CREATE INDEX idx_broker_tokens_expires_at ON broker_tokens(expires_at);

-- Insert default OAuth providers
INSERT INTO oauth_providers (name, display_name, client_id, client_secret, authorization_url, token_url, scopes, redirect_uri, logo_url, description) VALUES
('google', 'Google', 'your-google-client-id', 'your-google-client-secret', 'https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 
 '["openid", "email", "profile", "https://www.googleapis.com/auth/drive.readonly"]'::json, 
 'https://auth.companionintellience.io/auth-broker/callback', 
 'https://developers.google.com/identity/images/g-logo.png',
 'Access Google APIs including Drive, Gmail, Calendar, and more'),

('microsoft', 'Microsoft', 'your-microsoft-client-id', 'your-microsoft-client-secret', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
 '["openid", "email", "profile", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Files.Read"]'::json,
 'https://auth.companionintellience.io/auth-broker/callback',
 'https://docs.microsoft.com/en-us/azure/active-directory/develop/media/howto-add-branding-in-azure-ad-apps/ms-symbollockup_mssymbol_19.png',
 'Access Microsoft Graph APIs including OneDrive, Outlook, and Office 365'),

('facebook', 'Facebook', 'your-facebook-app-id', 'your-facebook-app-secret', 'https://www.facebook.com/v18.0/dialog/oauth', 'https://graph.facebook.com/v18.0/oauth/access_token',
 '["email", "public_profile", "pages_read_engagement"]'::json,
 'https://auth.companionintellience.io/auth-broker/callback',
 'https://upload.wikimedia.org/wikipedia/commons/5/51/Facebook_f_logo_%282019%29.svg',
 'Access Facebook APIs for social media management and analytics'),

('spotify', 'Spotify', 'your-spotify-client-id', 'your-spotify-client-secret', 'https://accounts.spotify.com/authorize', 'https://accounts.spotify.com/api/token',
 '["user-read-private", "user-read-email", "playlist-read-private", "user-library-read"]'::json,
 'https://auth.companionintellience.io/auth-broker/callback',
 'https://developer.spotify.com/images/guidelines/design/icon3@2x.png',
 'Access Spotify Web API for music streaming integration'),

('dropbox', 'Dropbox', 'your-dropbox-app-key', 'your-dropbox-app-secret', 'https://www.dropbox.com/oauth2/authorize', 'https://api.dropboxapi.com/oauth2/token',
 '["files.metadata.read", "files.content.read", "account_info.read"]'::json,
 'https://auth.companionintellience.io/auth-broker/callback',
 'https://cfl.dropboxstatic.com/static/images/logo_catalog/dropbox_logo_glyph_blue_m1.svg',
 'Access Dropbox API for cloud storage integration');

-- Update timestamps trigger for oauth_providers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_oauth_providers_updated_at 
    BEFORE UPDATE ON oauth_providers 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_broker_tokens_updated_at 
    BEFORE UPDATE ON broker_tokens 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- migrate:down

-- Drop triggers first
DROP TRIGGER IF EXISTS update_broker_tokens_updated_at ON broker_tokens;
DROP TRIGGER IF EXISTS update_oauth_providers_updated_at ON oauth_providers;

-- Drop function
DROP FUNCTION IF EXISTS update_updated_at_column();

-- Drop tables (broker_tokens first due to foreign key)
DROP TABLE IF EXISTS broker_tokens;
DROP TABLE IF EXISTS oauth_providers;

