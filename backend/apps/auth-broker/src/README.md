# Auth Broker Module

The Auth Broker module provides a centralized OAuth token management system for CI-Server, allowing users to securely connect their external service accounts (Google, Microsoft, Facebook, Spotify, Dropbox) and access their APIs through the CI-Server platform.

## Overview

The Auth Broker acts as an intermediary between CI-Server users and external OAuth providers, managing:

- OAuth authorization flows
- Token storage and refresh
- Provider configurations
- Secure token exchange

## Architecture

### Components

- **AuthBrokerController**: REST API endpoints for OAuth operations
- **AuthBrokerService**: Core business logic for token management
- **OAuthProviderService**: Provider configuration management
- **OAuthProviderEntity**: Database entity for OAuth provider configurations
- **BrokerTokenEntity**: Database entity for user OAuth tokens

### Database Schema

The module creates two main tables:

1. `oauth_providers` - OAuth provider configurations
2. `broker_tokens` - User OAuth tokens

## API Endpoints

### Public Endpoints

- `GET /auth-broker/providers` - List available OAuth providers
- `POST /auth-broker/callback` - OAuth callback handler

### Protected Endpoints (Require JWT Auth)

- `POST /auth-broker/authorize` - Initiate OAuth authorization
- `GET /auth-broker/tokens` - Get user's OAuth tokens
- `DELETE /auth-broker/tokens/:tokenId` - Revoke an OAuth token
- `POST /auth-broker/refresh/:tokenId` - Refresh an OAuth token (TODO)

## Setup Instructions

### 1. Run Database Migration

```bash
cd backend/apps/api
yarn migrate
```

### 2. Configure OAuth Providers

Use the setup script to configure OAuth provider credentials:

```bash
# List all providers
yarn exec bin/auth-broker-setup.ts list-providers

# Configure a provider
yarn exec bin/auth-broker-setup.ts configure-provider

# Test configuration
yarn exec bin/auth-broker-setup.ts test-config
```

### 3. Provider Setup

For each OAuth provider, you'll need to:

1. Create an application in their developer console
2. Set the redirect URI to: `https://auth.companionintellience.io/auth-broker/callback`
3. Configure the client ID and secret using the setup script

#### Google Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project or select existing one
3. Enable required APIs (Drive, Gmail, etc.)
4. Create OAuth 2.0 credentials
5. Add redirect URI

#### Microsoft Setup
1. Go to [Azure Portal](https://portal.azure.com/)
2. Register an application in Azure AD
3. Configure API permissions
4. Add redirect URI

#### Facebook Setup
1. Go to [Facebook Developers](https://developers.facebook.com/)
2. Create an app
3. Configure Facebook Login product
4. Add redirect URI

#### Spotify Setup
1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/)
2. Create an app
3. Add redirect URI

#### Dropbox Setup
1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Create an app
3. Configure permissions
4. Add redirect URI

## Usage Flow

### 1. Authorization Request

```typescript
POST /auth-broker/authorize
{
  "providerId": "uuid-of-provider",
  "scopes": ["optional", "custom", "scopes"]
}
```

Returns authorization URL for user to visit.

### 2. User Authorization

User visits the authorization URL and grants permissions.

### 3. Callback Handling

OAuth provider redirects back to `/auth-broker/callback` with authorization code.

### 4. Token Storage

The service exchanges the authorization code for access/refresh tokens and stores them securely.

### 5. Token Usage

Other CI-Server modules can use the stored tokens to access external APIs on behalf of users.

## Security Features

- Secure state parameter validation
- Token encryption at rest
- Automatic token refresh (when implemented)
- Rate limiting on authorization requests
- HTTPS-only in production
- Proper CORS configuration

## Configuration

The auth broker uses the following configuration:

```json
{
  "auth": {
    "broker": {
      "baseUrl": "https://auth.companionintellience.io",
      "callbackUrl": "https://auth.companionintellience.io/auth-broker/callback"
    }
  }
}
```

## Development

### Adding New Providers

1. Add provider configuration to the migration file
2. Update the provider logos and descriptions
3. Test the OAuth flow
4. Update documentation

### Testing

```bash
# Run type checking
yarn typecheck

# Run linting
yarn lint

# Run tests (when implemented)
yarn test
```

## Production Deployment

1. Ensure all OAuth providers are properly configured
2. Set up SSL certificates for auth.companionintellience.io
3. Configure proper CORS settings
4. Set up monitoring and logging
5. Test all OAuth flows

## Troubleshooting

### Common Issues

1. **Invalid redirect URI**: Ensure the callback URL matches exactly in provider settings
2. **Token not found**: Check if user has authorized the provider
3. **Expired tokens**: Implement refresh token logic
4. **CORS errors**: Configure proper CORS settings for the auth domain

### Logging

The module logs important events:
- OAuth authorization requests
- Token exchanges
- Token revocations
- Configuration changes

Check logs for debugging OAuth issues.

## Future Enhancements

- [ ] Automatic token refresh
- [ ] Token encryption at rest
- [ ] Provider health monitoring
- [ ] Analytics and usage metrics
- [ ] Webhook support for token events
- [ ] Multi-tenant provider configurations