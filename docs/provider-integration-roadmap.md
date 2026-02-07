# Provider Integration Roadmap

## Overview

This document outlines the complete roadmap for implementing all planned API provider integrations in the CI-Server ETL system. Each provider includes configuration details, API capabilities, testing requirements, and implementation priority.

## Integration Status Legend

- 🟢 **Implemented**: Fully integrated and tested
- 🟡 **In Progress**: Currently being developed
- 🔴 **Planned**: Not yet started
- 🟣 **Migrating**: Converting from old to new system
- ⚪ **Research**: Evaluating feasibility

## Provider Matrix

| Provider | Status | Priority | OAuth | Endpoints | Mock API | Test Keys | Est. Effort |
|----------|--------|----------|-------|-----------|----------|-----------|-------------|
| Google | 🟣 | Tier 1 | OAuth2 | 5 | ✅ | ✅ | 2 weeks |
| Microsoft | 🟣 | Tier 1 | OAuth2 | 3 | ✅ | ✅ | 1 week |
| Facebook | 🟣 | Tier 1 | OAuth2 | 5 | ✅ | ✅ | 1 week |
| Spotify | 🔴 | Tier 2 | OAuth2 | 4 | ⏳ | ⏳ | 3 days |
| GitHub | 🔴 | Tier 2 | OAuth2 | 6 | ⏳ | ⏳ | 5 days |
| Slack | 🔴 | Tier 2 | OAuth2 | 4 | ⏳ | ⏳ | 5 days |
| Twitter | 🔴 | Tier 2 | OAuth2 | 5 | ⏳ | ⏳ | 5 days |
| LinkedIn | 🔴 | Tier 2 | OAuth2 | 3 | ⏳ | ⏳ | 3 days |
| Instagram | 🔴 | Tier 3 | OAuth2 | 4 | ⏳ | ⏳ | 5 days |
| Dropbox | 🔴 | Tier 3 | OAuth2 | 2 | ⏳ | ⏳ | 2 days |
| Reddit | 🔴 | Tier 3 | OAuth2 | 3 | ⏳ | ⏳ | 3 days |
| Pinterest | 🔴 | Tier 3 | OAuth2 | 2 | ⏳ | ⏳ | 2 days |
| Steam | 🔴 | Tier 4 | API Key | 3 | ⏳ | ⏳ | 2 days |
| Uber | 🔴 | Tier 4 | OAuth2 | 2 | ⏳ | ⏳ | 2 days |
| Lyft | 🔴 | Tier 4 | OAuth2 | 2 | ⏳ | ⏳ | 2 days |
| Strava | 🔴 | Tier 4 | OAuth2 | 3 | ⏳ | ⏳ | 2 days |
| Fitbit | 🔴 | Tier 4 | OAuth2 | 4 | ⏳ | ⏳ | 3 days |

---

## Tier 1: Currently Implemented (Migration Required)

### 1. Google

**Status**: 🟣 Migrating  
**Priority**: Tier 1 - Critical  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://developers.google.com/
- **API Docs**: https://developers.google.com/apis-explorer
- **OAuth Guide**: https://developers.google.com/identity/protocols/oauth2
- **Rate Limits**: 10,000 requests/day per project (quota varies by API)

#### Data Sources

1. **Gmail**
   - Messages (inbox, sent, drafts)
   - Labels and categories
   - Threads and conversations
   - Attachments metadata
   - Scopes: `gmail.readonly`

2. **Calendar**
   - Events (past and upcoming)
   - Calendars list
   - Attendees and RSVP status
   - Recurring events
   - Scopes: `calendar.readonly`

3. **Drive**
   - Files and folders
   - File metadata and permissions
   - Recent changes/activity
   - Shared files
   - Scopes: `drive.readonly`

4. **YouTube**
   - Playlists
   - Liked videos
   - Subscriptions
   - Watch history
   - Channel activities
   - Scopes: `youtube.readonly`

5. **Contacts**
   - Contact list
   - Contact groups
   - Contact details (name, email, phone)
   - Scopes: `contacts.readonly`

#### Test Credentials
```bash
GOOGLE_CLIENT_ID=your-app-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-secret
GOOGLE_TEST_ACCOUNT=ci-test@gmail.com
```

#### Mock Data Requirements
- Generate 50 sample emails with realistic headers
- Generate 20 calendar events across multiple calendars
- Generate 30 Drive files with various MIME types
- Generate 10 YouTube playlists with videos
- Generate 25 contacts with complete information

#### Migration Notes
- Current implementation in `GoogleClient.ts`
- Extract sync logic to declarative configs
- Preserve existing sync state structure during migration
- Test incremental sync with `syncToken` and `pageToken`

---

### 2. Microsoft

**Status**: 🟣 Migrating  
**Priority**: Tier 1 - Critical  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://developer.microsoft.com/
- **API Docs**: https://docs.microsoft.com/en-us/graph/
- **OAuth Guide**: https://docs.microsoft.com/en-us/graph/auth/
- **Rate Limits**: Varies by endpoint, typically 2000 requests/app/hour

#### Data Sources

1. **Outlook Mail**
   - Messages (inbox, sent, drafts)
   - Folders
   - Categories
   - Scopes: `Mail.Read`

2. **Outlook Calendar**
   - Events
   - Calendars
   - Meeting responses
   - Scopes: `Calendars.Read`

3. **OneDrive**
   - Files and folders
   - Shared items
   - Recent activity
   - Scopes: `Files.Read`

#### Test Credentials
```bash
MICROSOFT_CLIENT_ID=your-application-id
MICROSOFT_CLIENT_SECRET=your-secret
MICROSOFT_TENANT_ID=common
MICROSOFT_TEST_ACCOUNT=ci-test@outlook.com
```

#### Mock Data Requirements
- Generate 40 Outlook emails
- Generate 15 calendar events
- Generate 25 OneDrive files/folders

#### Migration Notes
- Current implementation in `MicrosoftClient.ts`
- Microsoft Graph API uses consistent patterns across endpoints
- Delta sync support via `deltaToken`

---

### 3. Facebook

**Status**: 🟣 Migrating  
**Priority**: Tier 1 - Critical  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://developers.facebook.com/
- **API Docs**: https://developers.facebook.com/docs/graph-api/
- **OAuth Guide**: https://developers.facebook.com/docs/facebook-login/
- **Rate Limits**: 200 calls/hour per user, varies by app tier

#### Data Sources

1. **Posts**
   - Timeline posts
   - Status updates
   - Links and shares
   - Scopes: `user_posts`

2. **Photos**
   - Uploaded photos
   - Tagged photos
   - Albums
   - Scopes: `user_photos`

3. **Videos**
   - Uploaded videos
   - Video metadata
   - Scopes: `user_videos`

4. **Friends**
   - Friend list (limited to app users)
   - Scopes: `user_friends`

5. **Likes**
   - Liked pages
   - Liked content
   - Scopes: `user_likes`

#### Test Credentials
```bash
FACEBOOK_APP_ID=your-app-id
FACEBOOK_APP_SECRET=your-secret
FACEBOOK_TEST_USER_ID=test-user-id
```

#### Mock Data Requirements
- Generate 30 posts with various types (status, photo, link)
- Generate 20 photos with albums
- Generate 10 videos
- Generate 15 friends
- Generate 20 liked pages

#### Migration Notes
- Current implementation in `FacebookClient.ts`
- Graph API pagination uses cursor-based paging
- Limited data access due to privacy restrictions post-2018

---

## Tier 2: High Priority New Integrations

### 4. Spotify

**Status**: 🔴 Planned  
**Priority**: Tier 2 - High  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://developer.spotify.com/
- **API Docs**: https://developer.spotify.com/documentation/web-api/
- **OAuth Guide**: https://developer.spotify.com/documentation/web-api/tutorials/code-flow
- **Rate Limits**: Rate limiting per app and user

#### Data Sources

1. **Listening History**
   - Recently played tracks
   - Playback state
   - Scopes: `user-read-recently-played`

2. **Playlists**
   - User playlists
   - Playlist tracks
   - Collaborative playlists
   - Scopes: `playlist-read-private`, `playlist-read-collaborative`

3. **Library**
   - Saved tracks
   - Saved albums
   - Saved shows/podcasts
   - Scopes: `user-library-read`

4. **Following**
   - Followed artists
   - Followed playlists
   - Scopes: `user-follow-read`

#### Implementation Plan
1. Set up Spotify Developer app
2. Create provider config with sources
3. Define API spec for Spotify Web API v1
4. Create transform maps for tracks → content
5. Implement mock data generator
6. Add OAuth flow tests

#### Estimated Effort: 3 days

---

### 5. GitHub

**Status**: 🔴 Planned  
**Priority**: Tier 2 - High  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://developer.github.com/
- **API Docs**: https://docs.github.com/en/rest
- **OAuth Guide**: https://docs.github.com/en/developers/apps/building-oauth-apps
- **Rate Limits**: 5,000 requests/hour (authenticated)

#### Data Sources

1. **Repositories**
   - Owned repositories
   - Starred repositories
   - Repository metadata
   - Scopes: `repo`

2. **Commits**
   - Commit history
   - Authored commits
   - Commit comments
   - Scopes: `repo`

3. **Issues**
   - Created issues
   - Assigned issues
   - Issue comments
   - Scopes: `repo`

4. **Pull Requests**
   - Created PRs
   - Reviewed PRs
   - PR comments
   - Scopes: `repo`

5. **Activity**
   - Events timeline
   - Notifications
   - Scopes: `user`, `notifications`

6. **Gists**
   - Public and private gists
   - Scopes: `gist`

#### Implementation Plan
1. Set up GitHub OAuth App
2. Create provider config
3. Define REST API v3 spec
4. Create transform maps (commits → events, PRs → tasks)
5. Handle GraphQL API for complex queries (optional)
6. Implement webhook support for real-time updates (future)

#### Estimated Effort: 5 days

---

### 6. Slack

**Status**: 🔴 Planned  
**Priority**: Tier 2 - High  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://api.slack.com/
- **API Docs**: https://api.slack.com/methods
- **OAuth Guide**: https://api.slack.com/authentication/oauth-v2
- **Rate Limits**: Tier-based (Tier 1: 1 req/min, higher tiers faster)

#### Data Sources

1. **Messages**
   - Channel messages
   - Direct messages
   - Thread replies
   - Scopes: `channels:history`, `groups:history`, `im:history`

2. **Channels**
   - Channel list
   - Channel members
   - Scopes: `channels:read`, `groups:read`

3. **Files**
   - Uploaded files
   - File metadata
   - Scopes: `files:read`

4. **Users**
   - User profiles
   - Presence status
   - Scopes: `users:read`

#### Implementation Plan
1. Create Slack App
2. Define scopes for bot vs user tokens
3. Create provider config
4. Handle paginated conversations API
5. Implement file download/metadata extraction
6. Consider Events API for real-time (future)

#### Estimated Effort: 5 days

---

### 7. Twitter/X

**Status**: 🔴 Planned  
**Priority**: Tier 2 - High  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://developer.twitter.com/
- **API Docs**: https://developer.twitter.com/en/docs/twitter-api
- **OAuth Guide**: https://developer.twitter.com/en/docs/authentication/oauth-2-0
- **Rate Limits**: Varies by tier (Free, Basic, Pro, Enterprise)
- **Note**: API access restricted; may require paid tier

#### Data Sources

1. **Tweets**
   - User timeline
   - Mentions
   - Likes/favorites
   - Scopes: `tweet.read`, `users.read`

2. **Followers/Following**
   - Followers list
   - Following list
   - Scopes: `follows.read`

3. **Direct Messages**
   - DM conversations
   - Scopes: `dm.read`

4. **Bookmarks** (if available)
   - Saved tweets
   - Scopes: `bookmark.read`

5. **Lists**
   - User lists
   - List members
   - Scopes: `list.read`

#### Implementation Plan
1. Apply for Twitter Developer account
2. Choose appropriate API tier
3. Create provider config for API v2
4. Handle pagination with `pagination_token`
5. Implement tweet → content transformation
6. Note API limitations in documentation

#### Estimated Effort: 5 days

---

### 8. LinkedIn

**Status**: 🔴 Planned  
**Priority**: Tier 2 - High  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://developer.linkedin.com/
- **API Docs**: https://docs.microsoft.com/en-us/linkedin/
- **OAuth Guide**: https://docs.microsoft.com/en-us/linkedin/shared/authentication/
- **Rate Limits**: Application-level throttling
- **Note**: Limited API access for personal apps

#### Data Sources

1. **Posts**
   - User posts
   - Shared articles
   - Scopes: `r_liteprofile`, `w_member_social`

2. **Connections**
   - Connection list (limited)
   - Scopes: `r_basicprofile`

3. **Messages**
   - Conversation history (if available)
   - Scopes: `r_messages` (restricted)

#### Implementation Plan
1. Apply for LinkedIn Developer access
2. Understand API restrictions
3. Create provider config for available endpoints
4. Focus on publicly shareable data
5. Document limitations

#### Estimated Effort: 3 days

---

## Tier 3: Medium Priority Integrations

### 9. Instagram

**Status**: 🔴 Planned  
**Priority**: Tier 3 - Medium  
**OAuth Version**: OAuth 2.0 (via Facebook)  

#### Provider Details
- **Website**: https://developers.facebook.com/docs/instagram-api
- **API Docs**: https://developers.facebook.com/docs/instagram-basic-display-api/
- **OAuth Guide**: Via Facebook OAuth
- **Rate Limits**: 200 requests/hour
- **Note**: Requires Facebook app review

#### Data Sources

1. **Posts**
   - Media (photos, videos, carousels)
   - Captions and hashtags
   - Scopes: `user_profile`, `user_media`

2. **Stories** (if available in API)
   - Story media
   - Scopes: TBD

3. **Comments** (limited)
   - Comments on user's posts
   - Scopes: Limited by API

4. **Profile**
   - Profile information
   - Follower count
   - Scopes: `user_profile`

#### Implementation Plan
1. Use existing Facebook OAuth app
2. Enable Instagram Basic Display API
3. Submit for app review
4. Create provider config
5. Transform Instagram media → content

#### Estimated Effort: 5 days

---

### 10. Dropbox

**Status**: 🔴 Planned  
**Priority**: Tier 3 - Medium  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://www.dropbox.com/developers
- **API Docs**: https://www.dropbox.com/developers/documentation/http/documentation
- **OAuth Guide**: https://www.dropbox.com/developers/reference/oauth-guide
- **Rate Limits**: Per-app rate limits

#### Data Sources

1. **Files**
   - File and folder list
   - File metadata
   - Scopes: `files.metadata.read`

2. **Sharing**
   - Shared folders
   - Shared links
   - Scopes: `sharing.read`

#### Implementation Plan
1. Create Dropbox app
2. Define provider config
3. Handle file API pagination
4. Transform files → content with cloud_file_id

#### Estimated Effort: 2 days

---

### 11. Reddit

**Status**: 🔴 Planned  
**Priority**: Tier 3 - Medium  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://www.reddit.com/dev/api/
- **API Docs**: https://www.reddit.com/dev/api/
- **OAuth Guide**: https://github.com/reddit-archive/reddit/wiki/OAuth2
- **Rate Limits**: 60 requests/minute

#### Data Sources

1. **Posts**
   - Submitted posts
   - Scopes: `history`, `identity`

2. **Comments**
   - User comments
   - Scopes: `history`

3. **Saved**
   - Saved posts and comments
   - Scopes: `history`

#### Implementation Plan
1. Create Reddit app
2. Use "script" app type for personal use
3. Create provider config
4. Handle Reddit's JSON responses

#### Estimated Effort: 3 days

---

### 12. Pinterest

**Status**: 🔴 Planned  
**Priority**: Tier 3 - Medium  
**OAuth Version**: OAuth 2.0  

#### Provider Details
- **Website**: https://developers.pinterest.com/
- **API Docs**: https://developers.pinterest.com/docs/api/v5/
- **OAuth Guide**: https://developers.pinterest.com/docs/getting-started/authentication/
- **Rate Limits**: Per-app limits

#### Data Sources

1. **Pins**
   - User pins
   - Pin metadata
   - Scopes: `boards:read`, `pins:read`

2. **Boards**
   - User boards
   - Board sections
   - Scopes: `boards:read`

#### Implementation Plan
1. Apply for Pinterest developer access
2. Create provider config
3. Transform pins → content

#### Estimated Effort: 2 days

---

## Tier 4: Low Priority Specialized Integrations

### 13. Steam

**Status**: 🔴 Planned  
**Priority**: Tier 4 - Low  
**Auth Method**: API Key  

#### Provider Details
- **Website**: https://steamcommunity.com/dev
- **API Docs**: https://developer.valvesoftware.com/wiki/Steam_Web_API
- **Auth**: API Key (no OAuth)
- **Rate Limits**: 100,000 calls/day

#### Data Sources

1. **Games Library**
   - Owned games
   - Playtime
   - API: `IPlayerService/GetOwnedGames`

2. **Achievements**
   - Game achievements
   - API: `ISteamUserStats/GetPlayerAchievements`

3. **Friends**
   - Steam friends list
   - API: `ISteamUser/GetFriendList`

#### Implementation Plan
1. Support API key authentication (not OAuth)
2. Create provider config with API key auth type
3. Transform games → content, achievements → events

#### Estimated Effort: 2 days

---

### 14-17. Uber, Lyft, Strava, Fitbit

Similar patterns:
- **OAuth 2.0** authentication
- **Trip/Activity** data
- **Health metrics** (Fitbit, Strava)
- **Location history**

Each estimated at **2-3 days** implementation.

---

## Tier 5: Future Consideration

### Additional Providers to Research

1. **iCloud** - Requires Apple Developer account, limited API
2. **WhatsApp Business API** - Requires business verification
3. **Telegram** - Bot API available, personal data limited
4. **Discord** - Bot API, webhook support
5. **Notion** - API available, workspace integration
6. **Trello** - Boards, cards, activities
7. **Asana** - Tasks, projects, team collaboration
8. **Zoom** - Meeting history, recordings (with admin)

---

## Implementation Timeline

### Quarter 1 (Weeks 1-12)
- **Weeks 1-2**: Build ETL framework foundation
- **Weeks 3**: Mock infrastructure
- **Weeks 4-5**: Migrate Tier 1 providers (Google, Microsoft, Facebook)
- **Weeks 6-12**: Add Tier 2 providers (Spotify, GitHub, Slack, Twitter, LinkedIn)

### Quarter 2 (Weeks 13-24)
- Add Tier 3 providers (Instagram, Dropbox, Reddit, Pinterest)
- Add Tier 4 providers (Steam, Uber, Lyft, Strava, Fitbit)
- Comprehensive testing and documentation

### Quarter 3+
- Evaluate Tier 5 providers based on user demand
- Implement real-time webhook support
- Add bidirectional sync capabilities

---

## Testing Requirements

### Per Provider Checklist

- [ ] OAuth flow test (authorization + token exchange)
- [ ] Access token refresh test
- [ ] Each endpoint fetches data successfully
- [ ] Pagination works correctly
- [ ] Rate limiting is respected
- [ ] Error handling (401, 403, 429, 500)
- [ ] Transform maps produce valid data
- [ ] Sync state updates correctly
- [ ] Mock API returns realistic data
- [ ] Integration test with real API (manual)
- [ ] E2E test with full sync workflow

### Cross-Provider Tests

- [ ] OAuth flow works for all OAuth2 providers
- [ ] Template system handles all provider patterns
- [ ] Transform engine handles all field types
- [ ] Sync engine orchestrates multiple providers
- [ ] Rate limiter prevents exceeding limits
- [ ] Error recovery works across providers

---

## Documentation Requirements

### Per Provider

- Provider overview and capabilities
- Required OAuth scopes explanation
- Data retention and privacy notes
- Known limitations
- Example sync configurations
- Troubleshooting guide

### General

- How to add a new provider
- Provider config schema reference
- API spec schema reference
- Transform map schema reference
- Testing guide for new providers

---

## Success Criteria

- ✅ All Tier 1 providers migrated successfully
- ✅ At least 5 Tier 2 providers implemented
- ✅ Mock APIs available for all implemented providers
- ✅ > 90% test coverage on ETL core
- ✅ < 2 hours to add new provider via config
- ✅ Documentation complete and reviewed
- ✅ Performance benchmarks met (1000 records/sec)

---

**Document Version**: 1.0  
**Last Updated**: 2026-02-07  
**Status**: Planning Phase
