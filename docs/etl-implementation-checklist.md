# ETL System Refactoring - Implementation Checklist

This checklist tracks the implementation progress of the ETL system refactoring project. Use this to monitor progress and ensure all components are implemented systematically.

## Phase 1: Foundation (Weeks 1-2)

### Core Infrastructure
- [ ] Create TypeScript types for provider, API spec, and transform map schemas
  - [ ] `backend/apps/api/src/domains/etl/types/provider.ts`
  - [ ] `backend/apps/api/src/domains/etl/types/api-spec.ts`
  - [ ] `backend/apps/api/src/domains/etl/types/transform.ts`
  - [ ] `backend/apps/api/src/domains/etl/types/sync.ts`

### Database Schema
- [ ] Create migration for provider config storage
  - [ ] Add `provider_configs` table
  - [ ] Add indexes for fast lookups
- [ ] Create migration for API spec storage
  - [ ] Add `api_specs` table
  - [ ] Add JSONB fields for endpoint definitions
- [ ] Create migration for transform map storage
  - [ ] Add `transform_maps` table
  - [ ] Add JSONB fields for field mappings

### Core Entities
- [ ] Create `ProviderConfigEntity.ts`
- [ ] Create `ApiSpecEntity.ts`
- [ ] Create `TransformMapEntity.ts`
- [ ] Update `SyncStateEntity.ts` to support new structure

### Core Services
- [ ] Implement `ProviderRegistry.ts`
  - [ ] Load provider configs from database
  - [ ] Cache in memory for performance
  - [ ] Validate provider configurations
  - [ ] CRUD operations for provider configs
- [ ] Implement `ApiClient.ts`
  - [ ] Template parameter substitution
  - [ ] Pagination handling (cursor, offset, token)
  - [ ] Rate limiting per provider
  - [ ] Error handling and retries
  - [ ] OAuth token management
- [ ] Implement `TransformEngine.ts`
  - [ ] Direct field mapping
  - [ ] Nested path extraction
  - [ ] Computed fields
  - [ ] Template rendering
  - [ ] Type transformations (date, number, boolean)
  - [ ] Custom transformer registration
- [ ] Implement `SyncEngine.ts`
  - [ ] Orchestrate full sync workflow
  - [ ] Handle multiple sources per provider
  - [ ] Update sync state
  - [ ] Error recovery
  - [ ] Progress tracking
- [ ] Implement `RateLimiter.ts`
  - [ ] Token bucket algorithm
  - [ ] Per-provider rate limits
  - [ ] Per-endpoint rate limits
  - [ ] Exponential backoff

### Custom Transformers
- [ ] Create `backend/apps/api/src/domains/etl/transformers/email.ts`
  - [ ] `extractEmailBody` - Parse email body from parts
  - [ ] `extractEmailRecipients` - Parse To/CC/BCC headers
  - [ ] `parseEmailHeaders` - Extract structured header data
- [ ] Create `backend/apps/api/src/domains/etl/transformers/calendar.ts`
  - [ ] `parseRecurrenceRule` - Parse RRULE strings
  - [ ] `extractAttendees` - Normalize attendee data
- [ ] Create `backend/apps/api/src/domains/etl/transformers/file.ts`
  - [ ] `extractFileMetadata` - Parse file metadata
  - [ ] `generateThumbnailUrl` - Generate thumbnail URLs

## Phase 2: Mock Infrastructure (Week 3)

### Mock Framework
- [ ] Implement `MockProviderRegistry.ts`
  - [ ] Register mock providers
  - [ ] Get mock by provider ID
  - [ ] Clear mocks
- [ ] Implement `MockApiClient.ts`
  - [ ] Intercept API requests
  - [ ] Return mock data
  - [ ] Simulate network delays
  - [ ] Simulate errors
  - [ ] Validate request parameters

### Mock Data Generators
- [ ] Create `backend/apps/api/src/domains/etl/mocks/generators/google.ts`
  - [ ] Gmail messages generator
  - [ ] Calendar events generator
  - [ ] Drive files generator
  - [ ] YouTube activities generator
  - [ ] Contacts generator
- [ ] Create `backend/apps/api/src/domains/etl/mocks/generators/microsoft.ts`
  - [ ] Outlook messages generator
  - [ ] Outlook calendar generator
  - [ ] OneDrive files generator
- [ ] Create `backend/apps/api/src/domains/etl/mocks/generators/facebook.ts`
  - [ ] Posts generator
  - [ ] Photos generator
  - [ ] Videos generator
  - [ ] Friends generator
  - [ ] Likes generator

### Test Fixtures
- [ ] Create test fixtures directory structure
- [ ] Add Google Gmail thread fixture
- [ ] Add Google Calendar event fixture
- [ ] Add Microsoft Outlook message fixture
- [ ] Add Facebook post fixture

### Seed Data Generator
- [ ] Implement `SeedDataGenerator.ts`
  - [ ] Generate deterministic data with seed
  - [ ] Support all provider types
  - [ ] Reset seed for reproducibility

## Phase 3: Provider Configurations (Week 4)

### Google Provider
- [ ] Create `backend/apps/api/src/domains/etl/config/providers/google.json`
  - [ ] Define all sources (Gmail, Calendar, Drive, YouTube, Contacts)
  - [ ] OAuth configuration
  - [ ] Scope mappings
- [ ] Create `backend/apps/api/src/domains/etl/config/api-specs/google-v1.json`
  - [ ] Define all endpoints
  - [ ] Request parameters
  - [ ] Pagination config
  - [ ] Rate limits
- [ ] Create transform maps
  - [ ] `google-gmail-to-communication.json`
  - [ ] `google-calendar-to-event.json`
  - [ ] `google-drive-to-content.json`
  - [ ] `google-youtube-to-content.json`
  - [ ] `google-contacts-to-person.json`

### Microsoft Provider
- [ ] Create `backend/apps/api/src/domains/etl/config/providers/microsoft.json`
  - [ ] Define sources (Outlook Mail, Calendar, OneDrive)
  - [ ] OAuth configuration
- [ ] Create `backend/apps/api/src/domains/etl/config/api-specs/microsoft-graph-v1.json`
  - [ ] Define endpoints
  - [ ] Delta query support
- [ ] Create transform maps
  - [ ] `microsoft-outlook-to-communication.json`
  - [ ] `microsoft-calendar-to-event.json`
  - [ ] `microsoft-onedrive-to-content.json`

### Facebook Provider
- [ ] Create `backend/apps/api/src/domains/etl/config/providers/facebook.json`
  - [ ] Define sources (Posts, Photos, Videos, Friends, Likes)
  - [ ] OAuth configuration
- [ ] Create `backend/apps/api/src/domains/etl/config/api-specs/facebook-graph-v21.json`
  - [ ] Define endpoints
  - [ ] Cursor pagination
- [ ] Create transform maps
  - [ ] `facebook-posts-to-content.json`
  - [ ] `facebook-photos-to-content.json`
  - [ ] `facebook-videos-to-content.json`
  - [ ] `facebook-friends-to-person.json`

## Phase 4: Migration (Week 5)

### Migrate Google Integration
- [ ] Extract logic from `GoogleClient.ts` to configs
- [ ] Test sync with mock data
- [ ] Test sync with sandbox account
- [ ] Run parallel syncs (old + new) to validate
- [ ] Switch to new system
- [ ] Remove old `GoogleClient.ts` code

### Migrate Microsoft Integration
- [ ] Extract logic from `MicrosoftClient.ts` to configs
- [ ] Test sync with mock data
- [ ] Test sync with sandbox account
- [ ] Run parallel syncs (old + new) to validate
- [ ] Switch to new system
- [ ] Remove old `MicrosoftClient.ts` code

### Migrate Facebook Integration
- [ ] Extract logic from `FacebookClient.ts` to configs
- [ ] Test sync with mock data
- [ ] Test sync with sandbox account
- [ ] Run parallel syncs (old + new) to validate
- [ ] Switch to new system
- [ ] Remove old `FacebookClient.ts` code

### Update EtlService
- [ ] Replace old sync logic with new `SyncEngine`
- [ ] Update event handlers
- [ ] Preserve backward compatibility during transition
- [ ] Update tests

## Phase 5: New Integrations (Weeks 6-10)

### Spotify Integration
- [ ] Create Spotify Developer app
- [ ] Create provider config
- [ ] Create API spec
- [ ] Create transform maps
- [ ] Implement mock data generator
- [ ] Write tests
- [ ] Test with real API

### GitHub Integration
- [ ] Create GitHub OAuth app
- [ ] Create provider config
- [ ] Create API spec (REST v3)
- [ ] Create transform maps
- [ ] Implement mock data generator
- [ ] Write tests
- [ ] Consider GraphQL API for complex queries
- [ ] Test with real API

### Slack Integration
- [ ] Create Slack app
- [ ] Create provider config
- [ ] Create API spec
- [ ] Create transform maps
- [ ] Implement mock data generator
- [ ] Write tests
- [ ] Test with real API

### Twitter Integration
- [ ] Apply for Twitter Developer account
- [ ] Create provider config (note API tier restrictions)
- [ ] Create API spec (API v2)
- [ ] Create transform maps
- [ ] Implement mock data generator
- [ ] Write tests
- [ ] Test with real API (if tier allows)

### LinkedIn Integration
- [ ] Apply for LinkedIn Developer access
- [ ] Create provider config
- [ ] Create API spec
- [ ] Create transform maps (note limitations)
- [ ] Implement mock data generator
- [ ] Write tests
- [ ] Test with real API

## Phase 6: Testing (Weeks 11-12)

### Unit Tests
- [ ] Test `TransformEngine` field mappings
  - [ ] Direct mapping
  - [ ] Nested path extraction
  - [ ] Computed fields
  - [ ] Template rendering
  - [ ] Type transformations
- [ ] Test `ApiClient`
  - [ ] Template substitution
  - [ ] Pagination handling
  - [ ] Rate limiting
  - [ ] Error handling
- [ ] Test `SyncEngine`
  - [ ] Source orchestration
  - [ ] Sync state updates
  - [ ] Error recovery
- [ ] Test custom transformers
  - [ ] Email transformers
  - [ ] Calendar transformers
  - [ ] File transformers

### Integration Tests
- [ ] Test Google sync flow
  - [ ] Each source syncs correctly
  - [ ] Pagination works
  - [ ] Transform maps produce valid data
  - [ ] Sync state updates
- [ ] Test Microsoft sync flow
  - [ ] Each source syncs correctly
  - [ ] Delta sync works
  - [ ] Transform maps produce valid data
- [ ] Test Facebook sync flow
  - [ ] Each source syncs correctly
  - [ ] Cursor pagination works
  - [ ] Transform maps produce valid data
- [ ] Test Spotify sync flow
- [ ] Test GitHub sync flow
- [ ] Test Slack sync flow

### E2E Tests
- [ ] Complete sync workflow for Google
- [ ] Complete sync workflow for Microsoft
- [ ] Complete sync workflow for Facebook
- [ ] Complete sync workflow for new providers
- [ ] OAuth flow tests
- [ ] Error recovery tests
- [ ] Concurrent sync tests

### Performance Tests
- [ ] Transform 1000 records in < 1 second
- [ ] Handle 10 concurrent syncs
- [ ] Rate limiter prevents exceeding limits
- [ ] Memory usage stays within bounds

### Mock Validation
- [ ] Validate Google mock data against schemas
- [ ] Validate Microsoft mock data against schemas
- [ ] Validate Facebook mock data against schemas
- [ ] Validate all new provider mock data

## Phase 7: Documentation (Week 12)

### Developer Documentation
- [ ] How to add a new provider guide
- [ ] Provider config schema reference
- [ ] API spec schema reference
- [ ] Transform map schema reference
- [ ] Custom transformer development guide
- [ ] Testing guide

### User Documentation
- [ ] Overview of available providers
- [ ] How to connect each provider
- [ ] What data is synced for each source
- [ ] Privacy and data retention policies
- [ ] Troubleshooting common issues

### API Documentation
- [ ] ETL endpoints documentation
- [ ] Provider management endpoints
- [ ] Sync status and history endpoints
- [ ] GraphQL schema updates

### Admin Documentation
- [ ] How to manage provider configs
- [ ] How to monitor sync health
- [ ] How to troubleshoot failed syncs
- [ ] How to update API specs
- [ ] How to rotate test credentials

## Phase 8: Deployment & Monitoring

### Infrastructure
- [ ] Set up environment variables for all providers
- [ ] Configure test credentials for CI/CD
- [ ] Set up Redis for distributed caching (if needed)
- [ ] Configure logging and monitoring

### Monitoring & Alerting
- [ ] Track sync success/failure rates per provider
- [ ] Monitor API response times
- [ ] Alert on rate limit approaches
- [ ] Alert on sync failures
- [ ] Dashboard for sync health

### Security
- [ ] Audit credential storage encryption
- [ ] Review OAuth scope requirements
- [ ] Implement data access logging
- [ ] PII handling compliance
- [ ] Security review of mock data

### Performance Optimization
- [ ] Implement batch processing
- [ ] Add caching for configs
- [ ] Optimize database queries
- [ ] Add connection pooling

## Success Metrics

- [ ] All Tier 1 providers migrated successfully
- [ ] At least 5 Tier 2 providers implemented
- [ ] > 90% test coverage on ETL core
- [ ] < 2 hours to add new provider via config
- [ ] Sync success rate > 99%
- [ ] Process 1000 records/second
- [ ] All documentation complete

## Future Enhancements (Post-Launch)

- [ ] Real-time webhook support for incremental syncs
- [ ] Bidirectional sync (write back to providers)
- [ ] GraphQL API for complex provider queries
- [ ] AI-powered data classification
- [ ] Advanced rate limiting with dynamic backoff
- [ ] Provider health dashboard
- [ ] Automated sync scheduling based on user activity
- [ ] Data deduplication across providers
- [ ] Cross-provider data linking

---

**Document Version**: 1.0  
**Last Updated**: 2026-02-07  
**Status**: Planning Complete - Ready for Implementation
