# API Keys & End-to-End Testing Guide

**Complete guide for obtaining API credentials and testing all ETL connectors**

---

## Table of Contents

1. [Overview](#overview)
2. [General Setup](#general-setup)
3. [Provider API Keys](#provider-api-keys)
4. [End-to-End Testing](#end-to-end-testing)
5. [Troubleshooting](#troubleshooting)

---

## Overview

This guide covers how to obtain API credentials for all 26 supported providers and how to run end-to-end tests for each connector.

### Prerequisites

- Node.js 18+ installed
- PostgreSQL database running
- Ollama running (for local development)
- Valid email accounts for each service you want to test

### Environment Variables

Add these to your `.env` file:

```bash
# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Microsoft
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=

# Facebook
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=

# Discord
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=

# Slack
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=

# GitHub
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Twitter/X
TWITTER_CLIENT_ID=
TWITTER_CLIENT_SECRET=

# LinkedIn
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=

# Spotify
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# Notion
NOTION_CLIENT_ID=
NOTION_CLIENT_SECRET=

# Dropbox
DROPBOX_APP_KEY=
DROPBOX_APP_SECRET=

# Instagram
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=

# Reddit
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=

# Twitch
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=

# Steam
STEAM_API_KEY=

# Shopify
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=

# Box
BOX_CLIENT_ID=
BOX_CLIENT_SECRET=

# Telegram
TELEGRAM_BOT_TOKEN=

# Signal
SIGNAL_PHONE_NUMBER=

# OpenAI
OPENAI_API_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# iCloud
ICLOUD_CLIENT_ID=
ICLOUD_CLIENT_SECRET=

# Nextcloud
NEXTCLOUD_CLIENT_ID=
NEXTCLOUD_CLIENT_SECRET=

# Stripe
STRIPE_CLIENT_ID=
STRIPE_SECRET_KEY=

# Zoom
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=

# Trello
TRELLO_API_KEY=
TRELLO_API_SECRET=

# Asana
ASANA_CLIENT_ID=
ASANA_CLIENT_SECRET=
```

---

## General Setup

### 1. Install Dependencies

```bash
cd backend
yarn install
```

### 2. Database Setup

```bash
# Run migrations
yarn migrate

# Seed with provider configurations
yarn seed:providers
```

### 3. Start Development Server

```bash
yarn dev
```

---

## Provider API Keys

### Google

**Obtain Credentials:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable APIs:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - YouTube Data API v3
   - People API (for Contacts)
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Configure OAuth consent screen
6. Add authorized redirect URI: `http://dev.companionintelligence.com/auth/callback/google`
7. Copy **Client ID** and **Client Secret**

**Scopes Needed:**
```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/youtube.readonly
https://www.googleapis.com/auth/contacts.readonly
```

**Test Account:**
- Use a personal Gmail account
- Enable all APIs in Google Cloud Console
- Verify OAuth consent screen is configured

---

### Microsoft

**Obtain Credentials:**

1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to **Azure Active Directory** → **App registrations**
3. Click **New registration**
4. Name: "CI-Server Development"
5. Redirect URI: `http://dev.companionintelligence.com/auth/callback/microsoft`
6. After creation, go to **Certificates & secrets** → **New client secret**
7. Copy **Application (client) ID** and **Client secret value**
8. Go to **API permissions** → **Add permission**
9. Select **Microsoft Graph**:
   - Mail.Read
   - Calendars.Read
   - Files.Read

**Scopes Needed:**
```
https://graph.microsoft.com/Mail.Read
https://graph.microsoft.com/Calendars.Read
https://graph.microsoft.com/Files.Read
https://graph.microsoft.com/User.Read
```

**Test Account:**
- Use a Microsoft 365 account or personal Outlook.com account
- Ensure APIs are enabled

---

### Facebook

**Obtain Credentials:**

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Click **My Apps** → **Create App**
3. Choose **Consumer** as app type
4. Fill in app details
5. Add **Facebook Login** product
6. Configure OAuth redirect URI: `http://dev.companionintelligence.com/auth/callback/facebook`
7. Go to **Settings** → **Basic**
8. Copy **App ID** and **App Secret**
9. Add permissions in **App Review**:
   - user_posts
   - user_photos
   - user_videos

**Scopes Needed:**
```
email
public_profile
user_posts
user_photos
user_videos
user_friends
```

**Test Account:**
- Use a personal Facebook account
- App must be in Development mode for testing

---

### Discord

**Obtain Credentials:**

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Name your application
4. Go to **OAuth2** → **General**
5. Add redirect: `http://dev.companionintelligence.com/auth/callback/discord`
6. Copy **Client ID** and **Client Secret**
7. Under **OAuth2** → **URL Generator**, select scopes:
   - identify
   - email
   - guilds
   - messages.read

**Scopes Needed:**
```
identify
email
guilds
messages.read
```

**Test Account:**
- Use a personal Discord account
- Join test servers for full testing

---

### Slack

**Obtain Credentials:**

1. Go to [Slack API](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Choose workspace for development
4. Go to **OAuth & Permissions**
5. Add redirect URL: `http://dev.companionintelligence.com/auth/callback/slack`
6. Add Bot Token Scopes:
   - channels:history
   - groups:history
   - im:history
   - files:read
   - users:read
   - users:read.email
7. Go to **Basic Information**
8. Copy **Client ID** and **Client Secret**

**Scopes Needed:**
```
channels:history
groups:history
im:history
mpim:history
files:read
users:read
users:read.email
```

**Test Account:**
- Create a test Slack workspace
- Install app to workspace

---

### GitHub

**Obtain Credentials:**

1. Go to [GitHub Settings](https://github.com/settings/developers)
2. Click **OAuth Apps** → **New OAuth App**
3. Fill in details:
   - Application name: "CI-Server Dev"
   - Homepage URL: `http://dev.companionintelligence.com`
   - Authorization callback URL: `http://dev.companionintelligence.com/auth/callback/github`
4. Click **Register application**
5. Copy **Client ID**
6. Click **Generate a new client secret**
7. Copy **Client Secret**

**Scopes Needed:**
```
user
repo
read:user
```

**Test Account:**
- Use your personal GitHub account
- Ensure you have repositories, issues, etc. for testing

---

### Twitter/X

**Obtain Credentials:**

1. Go to [Twitter Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Create a new **Project** and **App**
3. Go to app settings → **User authentication settings**
4. Enable **OAuth 2.0**
5. Type of App: **Web App**
6. Callback URI: `http://dev.companionintelligence.com/auth/callback/twitter`
7. Copy **Client ID** and **Client Secret**
8. In **Keys and tokens**, ensure you have access to API v2

**Scopes Needed:**
```
tweet.read
users.read
like.read
```

**Test Account:**
- Use a personal Twitter/X account
- Must have tweets and activity

---

### LinkedIn

**Obtain Credentials:**

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Click **Create app**
3. Fill in app details
4. Go to **Auth** tab
5. Add redirect URL: `http://dev.companionintelligence.com/auth/callback/linkedin`
6. Request access to **Sign In with LinkedIn** product
7. Copy **Client ID** and **Client Secret**

**Scopes Needed:**
```
r_liteprofile
r_emailaddress
w_member_social
```

**Test Account:**
- Use a personal LinkedIn account
- Have some posts and connections

---

### Spotify

**Obtain Credentials:**

1. Go to [Spotify for Developers](https://developer.spotify.com/dashboard)
2. Click **Create app**
3. Fill in app details
4. Add redirect URI: `http://dev.companionintelligence.com/auth/callback/spotify`
5. Copy **Client ID** and **Client Secret**

**Scopes Needed:**
```
user-read-email
user-read-private
playlist-read-private
playlist-read-collaborative
user-library-read
user-read-recently-played
```

**Test Account:**
- Use a Spotify account (free or premium)
- Have playlists and saved tracks

---

### Notion

**Obtain Credentials:**

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Click **New integration**
3. Fill in basic information
4. Select capabilities (Read content)
5. Copy **Internal Integration Token**
6. For OAuth: Go to **Distribution** → **Public integration**
7. Add redirect URI: `http://dev.companionintelligence.com/auth/callback/notion`
8. Copy **OAuth client ID** and **OAuth client secret**

**Test Account:**
- Use a personal Notion workspace
- Share pages with your integration

---

### Dropbox

**Obtain Credentials:**

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Click **Create app**
3. Choose **Scoped access**
4. Choose **Full Dropbox** access
5. Name your app
6. Go to **Settings**
7. Add redirect URI: `http://dev.companionintelligence.com/auth/callback/dropbox`
8. Copy **App key** and **App secret**
9. Go to **Permissions** tab
10. Enable:
    - files.metadata.read
    - files.content.read

**Test Account:**
- Use a personal Dropbox account
- Have files and folders

---

### Instagram

**Obtain Credentials:**

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Use the same Facebook app or create new
3. Add **Instagram Basic Display** product
4. Configure OAuth redirect: `http://dev.companionintelligence.com/auth/callback/instagram`
5. Add Instagram test users
6. Copy **Instagram App ID** and **Instagram App Secret**

**Scopes Needed:**
```
instagram_basic
user_profile
user_media
```

**Test Account:**
- Use Instagram test account
- Link to Facebook app

---

### Reddit

**Obtain Credentials:**

1. Go to [Reddit Apps](https://www.reddit.com/prefs/apps)
2. Scroll down to **Developed Applications**
3. Click **Create App** or **Create Another App**
4. Choose **web app**
5. Name: "CI-Server Dev"
6. Redirect URI: `http://dev.companionintelligence.com/auth/callback/reddit`
7. Copy **Client ID** (under app name) and **Client Secret**

**Scopes Needed:**
```
identity
read
history
```

**Test Account:**
- Use a personal Reddit account
- Have posts and comments

---

### Twitch

**Obtain Credentials:**

1. Go to [Twitch Dev Console](https://dev.twitch.tv/console/apps)
2. Click **Register Your Application**
3. Name: "CI-Server Dev"
4. OAuth Redirect URL: `http://dev.companionintelligence.com/auth/callback/twitch`
5. Category: **Application Integration**
6. Click **Create**
7. Click **Manage** on your app
8. Copy **Client ID**
9. Click **New Secret** to generate **Client Secret**

**Scopes Needed:**
```
user:read:email
user:read:follows
clips:edit
```

**Test Account:**
- Use a Twitch account
- Have some activity (follows, clips)

---

### Steam

**Obtain Credentials:**

1. Go to [Steam Web API](https://steamcommunity.com/dev/apikey)
2. Fill in domain name: `dev.companionintelligence.com`
3. Agree to terms
4. Copy your **Steam Web API Key**

**Note:** Steam uses API Key authentication, not OAuth

**Test Account:**
- Use a Steam account with games
- Profile must be public

---

### Shopify

**Obtain Credentials:**

1. Create a [Shopify Partner account](https://www.shopify.com/partners)
2. Go to **Apps** → **Create app**
3. Choose **Public app**
4. Fill in app details
5. App URL: `http://dev.companionintelligence.com`
6. Redirect URL: `http://dev.companionintelligence.com/auth/callback/shopify`
7. Copy **API key** and **API secret key**

**Scopes Needed:**
```
read_orders
read_products
read_customers
```

**Test Account:**
- Create a development store in Shopify Partners
- Add test products and orders

---

### Box

**Obtain Credentials:**

1. Go to [Box Developers](https://app.box.com/developers/console)
2. Click **Create New App**
3. Choose **Custom App**
4. Choose **Standard OAuth 2.0 (User Authentication)**
5. Name your app
6. Go to **Configuration**
7. Add redirect URI: `http://dev.companionintelligence.com/auth/callback/box`
8. Copy **Client ID** and **Client Secret**
9. Set OAuth 2.0 scopes

**Test Account:**
- Use a personal Box account
- Have files and folders

---

### Telegram

**Obtain Credentials:**

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` command
3. Follow prompts to name your bot
4. Copy the **Bot Token** provided
5. Use this token for API access

**Note:** Telegram uses Bot API, not OAuth

**Test Account:**
- Use your personal Telegram account
- Send messages to your bot

---

### Signal

**Obtain Credentials:**

**Note:** Signal doesn't have an official public API. Options:
1. Use **signal-cli** (command-line interface)
2. Link with Signal Desktop
3. Currently marked as `enabled: false` in config

**Test Account:**
- Requires Signal account linked to phone number
- Not recommended for production use

---

### OpenAI

**Obtain Credentials:**

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Sign up or log in
3. Go to **API Keys** section
4. Click **Create new secret key**
5. Copy the API key (only shown once!)

**Note:** Uses API Key authentication

**Test Account:**
- Personal or organization OpenAI account
- Requires billing setup for API access

---

### Anthropic (Claude)

**Obtain Credentials:**

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Sign up for API access
3. Go to **Settings** → **API Keys**
4. Click **Create Key**
5. Copy the API key

**Note:** Uses API Key authentication

**Test Account:**
- Requires approved Anthropic API access
- May have waitlist

---

### iCloud

**Obtain Credentials:**

1. Go to [Apple Developer](https://developer.apple.com/)
2. Create an App ID
3. Enable **Sign in with Apple**
4. Go to **Certificates, Identifiers & Profiles**
5. Create **Services ID** for web authentication
6. Configure redirect URL: `http://dev.companionintelligence.com/auth/callback/icloud`
7. Download private key for authentication

**Note:** Complex setup, currently marked as `enabled: false`

**Test Account:**
- Personal Apple ID
- Limited API access

---

### Nextcloud

**Obtain Credentials:**

1. Install Nextcloud instance or use existing
2. Go to **Settings** → **Security**
3. Under **OAuth 2.0 clients**, click **Add client**
4. Name: "CI-Server"
5. Redirect URI: `http://dev.companionintelligence.com/auth/callback/nextcloud`
6. Copy **Client ID** and **Secret**

**Test Account:**
- Self-hosted or cloud Nextcloud instance
- Have files and calendars

---

### Stripe

**Obtain Credentials:**

1. Go to [Stripe Dashboard](https://dashboard.stripe.com/)
2. Go to **Developers** → **API keys**
3. Copy **Publishable key** and **Secret key** (test mode)
4. For OAuth:
   - Go to **Settings** → **Connect**
   - Get **client_id**
5. Add redirect URI in Connect settings

**Test Account:**
- Stripe account in test mode
- Create test customers and charges

---

### Zoom

**Obtain Credentials:**

1. Go to [Zoom App Marketplace](https://marketplace.zoom.us/)
2. Click **Develop** → **Build App**
3. Choose **OAuth** app type
4. Fill in app details
5. Add redirect URL: `http://dev.companionintelligence.com/auth/callback/zoom`
6. Copy **Client ID** and **Client Secret**
7. Add scopes:
   - user:read
   - meeting:read
   - recording:read

**Test Account:**
- Zoom account (free or paid)
- Have meeting history

---

### Trello

**Obtain Credentials:**

1. Go to [Trello Power-Ups](https://trello.com/power-ups/admin)
2. Click **New** → **Create new Power-Up**
3. Fill in details
4. Get **API Key** from your account settings
5. Generate **API Token** for testing

**Note:** Uses OAuth 1.0

**Test Account:**
- Personal Trello account
- Have boards and cards

---

### Asana

**Obtain Credentials:**

1. Go to [Asana Developers](https://app.asana.com/0/developer-console)
2. Click **Create new app**
3. Fill in app details
4. Add redirect URL: `http://dev.companionintelligence.com/auth/callback/asana`
5. Copy **Client ID** and **Client Secret**

**Test Account:**
- Personal Asana account
- Have projects and tasks

---

## End-to-End Testing

### Testing Framework

We use a comprehensive testing approach:
1. **Mock API Tests** - Fast, no credentials needed
2. **Sandbox Tests** - With test credentials
3. **Production Tests** - With real accounts (manual)

### Running Tests

#### 1. Setup Test Environment

```bash
# Copy test environment template
cp .env.test.template .env.test

# Add your test credentials to .env.test
```

#### 2. Run Mock API Tests

```bash
# Test all connectors with mock data
yarn test:etl:mock

# Test specific provider
yarn test:etl:mock --provider=google
```

#### 3. Run Integration Tests

```bash
# Test with real API credentials (requires .env.test setup)
yarn test:etl:integration

# Test specific provider
yarn test:etl:integration --provider=google
```

#### 4. Run End-to-End Tests

```bash
# Full E2E test suite
yarn test:e2e:etl

# Test specific provider E2E
yarn test:e2e:etl --provider=google
```

### Test Scenarios

Each connector tests:

1. **OAuth Flow**
   - Authorization URL generation
   - Token exchange
   - Token refresh

2. **Data Fetching**
   - API endpoint calls
   - Pagination
   - Rate limiting
   - Error handling

3. **Data Transformation**
   - Field mapping
   - Type conversions
   - Custom transformers

4. **Data Persistence**
   - Database insertion
   - Sync state updates
   - Deduplication

### Provider-Specific Test Instructions

#### Google

```bash
# Test Gmail sync
curl -X POST http://localhost:3000/api/etl/sync \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"providerId": "google", "sources": ["Gmail"]}'

# Verify in database
psql -d ci_server -c "SELECT * FROM ci.communications WHERE platform = 'gmail' ORDER BY timestamp DESC LIMIT 10;"
```

#### Microsoft

```bash
# Test Outlook sync
curl -X POST http://localhost:3000/api/etl/sync \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"providerId": "microsoft", "sources": ["Outlook Mail"]}'

# Verify
psql -d ci_server -c "SELECT * FROM ci.communications WHERE platform = 'outlook' ORDER BY timestamp DESC LIMIT 10;"
```

#### Facebook

```bash
# Test Posts sync
curl -X POST http://localhost:3000/api/etl/sync \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"providerId": "facebook", "sources": ["Posts"]}'

# Verify
psql -d ci_server -c "SELECT * FROM ci.contents WHERE platform = 'facebook' ORDER BY created_at DESC LIMIT 10;"
```

#### Discord

```bash
# Test Messages sync
curl -X POST http://localhost:3000/api/etl/sync \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"providerId": "discord", "sources": ["Messages"]}'
```

#### Slack

```bash
# Test Messages sync
curl -X POST http://localhost:3000/api/etl/sync \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"providerId": "slack", "sources": ["Messages"]}'
```

#### GitHub

```bash
# Test Repositories sync
curl -X POST http://localhost:3000/api/etl/sync \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"providerId": "github", "sources": ["Repositories"]}'
```

#### Spotify

```bash
# Test Playlists sync
curl -X POST http://localhost:3000/api/etl/sync \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"providerId": "spotify", "sources": ["Playlists"]}'
```

### Automated Test Suite

Create test file: `backend/apps/api/src/domains/etl/__tests__/e2e-all-providers.test.ts`

```typescript
import { Test } from '@nestjs/testing';
import { SyncEngine } from '../services/SyncEngine';
import { ProviderRegistry } from '../services/ProviderRegistry';

describe('ETL End-to-End Tests', () => {
  let syncEngine: SyncEngine;
  let providerRegistry: ProviderRegistry;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      // ... module setup
    }).compile();

    syncEngine = module.get(SyncEngine);
    providerRegistry = module.get(ProviderRegistry);
  });

  const providers = [
    'google',
    'microsoft',
    'facebook',
    'discord',
    'slack',
    'github',
    'twitter',
    'linkedin',
    'spotify',
    'notion',
    'dropbox',
    'instagram',
    'reddit',
    'twitch',
    'steam',
    'shopify',
    'box',
    'telegram',
    'openai',
    'anthropic',
    'nextcloud',
    'stripe',
    'zoom',
    'trello',
    'asana'
  ];

  providers.forEach(providerId => {
    describe(`${providerId} Provider`, () => {
      it('should load provider configuration', async () => {
        const config = await providerRegistry.getProvider({}, providerId);
        expect(config).toBeDefined();
        expect(config.id).toBe(providerId);
      });

      it('should sync data successfully', async () => {
        // Test with mock or real connection
        const result = await syncEngine.syncConnection(
          context,
          testConnection,
          { mockMode: true }
        );
        expect(result.success).toBe(true);
      });
    });
  });
});
```

### Performance Testing

```bash
# Test sync performance
yarn test:perf:etl

# Test with concurrent connections
yarn test:load:etl --connections=10
```

### Validation Checklist

For each provider, verify:

- [ ] OAuth flow works
- [ ] API endpoints are accessible
- [ ] Data is fetched correctly
- [ ] Pagination works
- [ ] Rate limiting is respected
- [ ] Data transforms correctly
- [ ] Database records are created
- [ ] Sync state is updated
- [ ] Error handling works
- [ ] Token refresh works

---

## Troubleshooting

### Common Issues

#### OAuth Redirect URI Mismatch

**Problem:** "redirect_uri_mismatch" error

**Solution:**
- Ensure redirect URI in provider portal matches exactly
- Check for http vs https
- Verify domain matches (dev.companionintelligence.com)

#### Rate Limiting

**Problem:** 429 Too Many Requests

**Solution:**
- Check rate limit config in API spec
- Verify RateLimiter is working
- Increase delays between requests
- Use test/sandbox environments

#### Invalid Token

**Problem:** 401 Unauthorized

**Solution:**
- Check token expiration
- Verify token refresh logic
- Ensure scopes are correct
- Re-authorize connection

#### Missing Scopes

**Problem:** 403 Forbidden

**Solution:**
- Verify all required scopes in provider config
- Re-request authorization with new scopes
- Check scope names match provider documentation

#### API Changes

**Problem:** Unexpected response format

**Solution:**
- Check provider's API changelog
- Update API spec version
- Update transform maps
- Add error handling for new fields

### Debug Mode

Enable debug logging:

```bash
# In .env
ETL_DEBUG=true
LOG_LEVEL=debug

# Run sync with verbose logging
yarn dev --log-level=debug
```

### Monitoring

Check sync status:

```sql
-- Recent syncs
SELECT * FROM ci.sync_logs 
ORDER BY created_at DESC 
LIMIT 20;

-- Failed syncs
SELECT * FROM ci.sync_logs 
WHERE success = false 
ORDER BY created_at DESC;

-- Sync statistics by provider
SELECT 
  provider_id,
  COUNT(*) as total_syncs,
  SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful,
  AVG(duration) as avg_duration_ms
FROM ci.sync_logs
GROUP BY provider_id;
```

---

## Next Steps

1. **Obtain API Keys:** Follow guides above for each provider
2. **Configure Environment:** Add credentials to `.env`
3. **Run Tests:** Start with mock tests, then integration
4. **Verify Data:** Check database for synced records
5. **Production Deployment:** Use production credentials

---

**Last Updated:** 2026-02-07  
**Maintainers:** CI-Server ETL Team  
**Support:** See [ETL System Documentation](./etl-system-design.md)
