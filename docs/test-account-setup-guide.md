# Test Account Setup Guide

## Overview

This guide provides instructions for setting up test accounts and credentials for all provider integrations in the ETL system. Test accounts enable development and testing without affecting production data.

## General Guidelines

### Security Best Practices
- ✅ **Never commit real credentials** to version control
- ✅ Use separate test apps/projects for each environment
- ✅ Store credentials in environment variables
- ✅ Use `.env` file locally (git-ignored)
- ✅ Rotate credentials regularly
- ✅ Limit scope permissions to minimum required
- ✅ Use test/sandbox accounts when available

### Environment Variables Structure
```bash
# Format: PROVIDER_PURPOSE_CREDENTIAL
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-secret
GOOGLE_TEST_ACCOUNT=test@gmail.com
```

## Provider-Specific Setup

---

## Tier 1: Currently Implemented

### 1. Google (OAuth 2.0)

#### Create Test Application
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new project: "CI-Server ETL Test"
3. Enable APIs:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - YouTube Data API v3
   - People API (Contacts)

#### Configure OAuth Consent Screen
1. Go to "OAuth consent screen"
2. Select "External" user type
3. Fill in app information:
   - App name: "CI-Server ETL Test"
   - User support email: your-email@example.com
   - Developer email: your-email@example.com
4. Add scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/youtube.readonly`
   - `https://www.googleapis.com/auth/contacts.readonly`
5. Add test users (your test Gmail account)

#### Create OAuth Credentials
1. Go to "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Application type: "Web application"
4. Name: "CI-Server ETL"
5. Authorized redirect URIs:
   - `http://localhost:3000/api/oauth/callback`
   - `https://dev.companionintelligence.com/api/oauth/callback`
6. Save and copy:
   - Client ID
   - Client Secret

#### Environment Variables
```bash
# Google OAuth
GOOGLE_CLIENT_ID=123456789.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-secret-here

# Test Account
GOOGLE_TEST_ACCOUNT=ci-etl-test@gmail.com
GOOGLE_TEST_ACCOUNT_PASSWORD=<stored-securely>
```

#### Create Test Data
1. Create Gmail account: `ci-etl-test@gmail.com`
2. Send/receive 20-30 test emails
3. Create 5-10 calendar events
4. Upload 10-15 files to Drive
5. Create 2-3 YouTube playlists
6. Add 15-20 contacts

---

### 2. Microsoft (OAuth 2.0)

#### Create Test Application
1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to "Azure Active Directory" → "App registrations"
3. Click "New registration"
4. Name: "CI-Server ETL Test"
5. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
6. Redirect URI: 
   - Web: `http://localhost:3000/api/oauth/callback`

#### Configure API Permissions
1. Go to "API permissions"
2. Add permissions:
   - Microsoft Graph:
     - `Mail.Read` (Delegated)
     - `Calendars.Read` (Delegated)
     - `Files.Read` (Delegated)
3. Grant admin consent (if required)

#### Create Client Secret
1. Go to "Certificates & secrets"
2. Click "New client secret"
3. Description: "CI-Server ETL Test"
4. Expires: 24 months
5. Copy the secret value immediately

#### Environment Variables
```bash
# Microsoft OAuth
MICROSOFT_CLIENT_ID=your-application-id
MICROSOFT_CLIENT_SECRET=your-secret-value
MICROSOFT_TENANT_ID=common

# Test Account
MICROSOFT_TEST_ACCOUNT=ci-etl-test@outlook.com
MICROSOFT_TEST_ACCOUNT_PASSWORD=<stored-securely>
```

#### Create Test Data
1. Create Outlook account: `ci-etl-test@outlook.com`
2. Send/receive 20-30 test emails
3. Create 5-10 calendar events
4. Upload 10-15 files to OneDrive

---

### 3. Facebook (OAuth 2.0)

#### Create Test Application
1. Go to [Facebook Developers](https://developers.facebook.com/)
2. Click "My Apps" → "Create App"
3. Select "Consumer" use case
4. App name: "CI-Server ETL Test"
5. Contact email: your-email@example.com

#### Configure App Settings
1. Go to "Settings" → "Basic"
2. Add "App Domains": `localhost`, `dev.companionintelligence.com`
3. Privacy Policy URL: (required for app review)
4. Terms of Service URL: (optional)

#### Add Facebook Login Product
1. Click "Add Product"
2. Select "Facebook Login"
3. Configure "Valid OAuth Redirect URIs":
   - `http://localhost:3000/api/oauth/callback`
   - `https://dev.companionintelligence.com/api/oauth/callback`

#### Request Permissions (App Review)
**Note**: Many permissions require app review by Facebook

Required permissions:
- `email` (default)
- `public_profile` (default)
- `user_posts` (requires review)
- `user_photos` (requires review)
- `user_videos` (requires review)
- `user_friends` (limited - only friends who also use app)
- `user_likes` (requires review)

For testing without review:
1. Add test users in "Roles" → "Test Users"
2. Test users have full permissions without review

#### Environment Variables
```bash
# Facebook OAuth
FACEBOOK_APP_ID=your-app-id
FACEBOOK_APP_SECRET=your-app-secret

# Test Account (Use Facebook Test User)
FACEBOOK_TEST_USER_ID=test-user-id
FACEBOOK_TEST_USER_ACCESS_TOKEN=<generated-by-facebook>
```

#### Create Test Data
1. Use Facebook Test User feature
2. Create test posts, photos, videos
3. Like test pages
4. Connect with other test users as friends

---

## Tier 2: High Priority

### 4. Spotify (OAuth 2.0)

#### Create Test Application
1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click "Create app"
3. App name: "CI-Server ETL Test"
4. App description: "Test app for ETL integration"
5. Redirect URIs: `http://localhost:3000/api/oauth/callback`
6. Check "Web API"

#### Environment Variables
```bash
SPOTIFY_CLIENT_ID=your-client-id
SPOTIFY_CLIENT_SECRET=your-client-secret
SPOTIFY_TEST_ACCOUNT=test@example.com
```

#### Scopes Needed
- `user-read-recently-played`
- `user-read-playback-state`
- `user-library-read`
- `playlist-read-private`
- `playlist-read-collaborative`
- `user-follow-read`

---

### 5. GitHub (OAuth 2.0)

#### Create Test Application
1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Application name: "CI-Server ETL Test"
4. Homepage URL: `http://localhost:3000`
5. Authorization callback URL: `http://localhost:3000/api/oauth/callback`

#### Environment Variables
```bash
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
GITHUB_TEST_ACCOUNT=ci-etl-test
```

#### Scopes Needed
- `repo` (repository access)
- `user` (user profile)
- `notifications`
- `gist`

---

### 6. Slack (OAuth 2.0)

#### Create Test Application
1. Go to [Slack API](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. App name: "CI-Server ETL Test"
4. Pick a workspace for development

#### Environment Variables
```bash
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
SLACK_TEST_WORKSPACE=test-workspace
```

#### Scopes Needed
- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `files:read`
- `users:read`

---

### 7. Twitter/X (OAuth 2.0)

#### Create Test Application
**Note**: Twitter API access requires approval and may require paid tier

1. Go to [Twitter Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Apply for developer account
3. Create project and app
4. Note: Free tier has significant limitations

#### Environment Variables
```bash
TWITTER_CLIENT_ID=your-client-id
TWITTER_CLIENT_SECRET=your-client-secret
TWITTER_API_KEY=your-api-key
TWITTER_API_SECRET=your-api-secret
TWITTER_TEST_ACCOUNT=@ci_etl_test
```

---

### 8. LinkedIn (OAuth 2.0)

#### Create Test Application
1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Click "Create app"
3. Note: May require company page

#### Environment Variables
```bash
LINKEDIN_CLIENT_ID=your-client-id
LINKEDIN_CLIENT_SECRET=your-client-secret
LINKEDIN_TEST_ACCOUNT=test@example.com
```

---

## Environment Variable Files

### `.env.default` (Template - Committed to Git)
```bash
# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_TEST_ACCOUNT=

# Microsoft
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
MICROSOFT_TEST_ACCOUNT=

# Facebook
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
FACEBOOK_TEST_USER_ID=

# Spotify
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# GitHub
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Slack
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=

# Twitter
TWITTER_CLIENT_ID=
TWITTER_CLIENT_SECRET=

# LinkedIn
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=

# ETL Configuration
ETL_MOCK_MODE=false
ETL_TEST_MODE=false
ETL_PARALLEL_SOURCES=3
ETL_BATCH_SIZE=100
ETL_RETRY_ATTEMPTS=3
ETL_RETRY_DELAY=1000
```

### `.env` (Local Development - Git Ignored)
Copy `.env.default` to `.env` and fill in actual values

### `.env.test` (CI/CD Testing - Git Ignored)
```bash
# Use mock mode for most tests
ETL_MOCK_MODE=true

# Only include real credentials for providers being tested
# Other providers will use mocks
GOOGLE_CLIENT_ID=<test-value-from-secrets>
GOOGLE_CLIENT_SECRET=<test-value-from-secrets>
```

---

## CI/CD Secret Management

### GitHub Secrets
Store credentials in GitHub repository secrets:

1. Go to repository → Settings → Secrets and variables → Actions
2. Add secrets for each provider:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `MICROSOFT_CLIENT_ID`
   - etc.

### GitHub Actions Usage
```yaml
env:
  GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
  GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
  ETL_MOCK_MODE: true
```

---

## Testing Modes

### 1. Mock Mode (Default for Tests)
```bash
ETL_MOCK_MODE=true
```
- No real API calls
- Uses mock data generators
- No credentials required
- Fast execution

### 2. Sandbox Mode (Provider Test Accounts)
```bash
ETL_MOCK_MODE=false
ETL_TEST_MODE=sandbox
```
- Real OAuth flow
- Uses test credentials
- Limited test data
- Validates actual API behavior

### 3. Production Mode (Real Accounts)
```bash
ETL_MOCK_MODE=false
ETL_TEST_MODE=false
```
- Real production APIs
- Real user credentials
- Used for manual testing only

---

## Credential Rotation

### Schedule
- Rotate test credentials every 6 months
- Rotate after any security incident
- Rotate when team members leave

### Process
1. Generate new credentials in provider dashboard
2. Update `.env` file locally
3. Update GitHub Secrets
4. Test all integrations
5. Revoke old credentials
6. Document rotation date

---

## Troubleshooting

### Common Issues

**OAuth redirect mismatch**
- Ensure redirect URI exactly matches configured value
- Check for http vs https
- Check for trailing slashes

**Insufficient permissions**
- Verify all required scopes are requested
- Check if app review is required
- Ensure user granted all permissions

**Token expiration**
- Implement proper token refresh logic
- Store refresh tokens securely
- Handle token expiration gracefully

**Rate limiting**
- Implement exponential backoff
- Respect provider rate limits
- Use appropriate request batching

---

## Security Checklist

- [ ] All credentials stored in environment variables
- [ ] `.env` file is git-ignored
- [ ] No credentials committed to repository
- [ ] Test accounts use unique passwords
- [ ] MFA enabled on test accounts where possible
- [ ] API keys have minimum required permissions
- [ ] Regular credential rotation scheduled
- [ ] Access logs monitored for unusual activity

---

**Created**: 2026-02-07  
**Status**: Ready for Use  
**Last Updated**: 2026-02-07
