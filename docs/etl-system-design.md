# ETL System Refactoring - Design Document

## Executive Summary

This document outlines a comprehensive refactoring of the Connections ETL system to build a clean, extensible Extract-Transform-Load (ETL) architecture for collecting and transforming data from various API integrations.

**Goals:**
- Create a declarative, configuration-driven ETL system
- Support multiple API providers with minimal code duplication
- Enable easy addition of new integrations
- Provide robust testing infrastructure with mock APIs
- Maintain clear separation between provider config and data transformation logic

**Inspired By:** LifeScope ETL patterns (provider/map separation, template system, type-aware transformations)

## Current State Analysis

### Existing Integrations

1. **Google** (GoogleClient.ts)
   - Gmail (inbox sync)
   - Calendar (events)
   - Drive (file changes)
   - YouTube (playlists, likes, subscriptions, activities)
   - Contacts (contact groups)

2. **Microsoft** (MicrosoftClient.ts)
   - Outlook Mail
   - Outlook Calendar
   - OneDrive

3. **Facebook** (FacebookClient.ts)
   - Posts
   - Photos
   - Videos
   - Friends
   - Likes

### Current Architecture Issues

1. **Tight Coupling**: Each client hardcodes API calls, sync logic, and data transformation
2. **Code Duplication**: Similar patterns repeated across GoogleClient, MicrosoftClient, FacebookClient
3. **Limited Extensibility**: Adding new providers requires writing substantial boilerplate
4. **No Mock Infrastructure**: Testing requires real API credentials and live connections
5. **Mixed Concerns**: Authentication, data fetching, transformation, and persistence are intertwined
6. **Sync State Management**: Each provider has custom sync state structures

## Proposed Architecture

### Core Principles

1. **Configuration Over Code**: Define providers and endpoints declaratively
2. **Separation of Concerns**: 
   - Provider Config (what to sync)
   - API Spec (how to fetch)
   - Transform Maps (how to normalize)
   - Sync Engine (orchestration)
3. **Type Safety**: Strongly typed configurations and transformations
4. **Testability**: Mock providers and test API keys for CI/CD
5. **Extensibility**: Plugin architecture for custom transformations

### Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│                   ETL Controller                         │
│              (REST/GraphQL endpoints)                    │
└───────────────────┬─────────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────────┐
│                  ETL Service                             │
│         (Orchestration, Job Management)                  │
└───────────────────┬─────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
┌───────▼────┐ ┌───▼──────┐ ┌─▼────────┐
│ Provider   │ │ API      │ │Transform │
│ Registry   │ │ Client   │ │ Engine   │
│(Config)    │ │(Fetch)   │ │(Normalize│
└────────────┘ └──────────┘ └──────────┘
        │           │           │
┌───────▼───────────▼───────────▼─────────────────────────┐
│              Data Persistence Layer                      │
│         (ApiLogEntity, SyncState, Events)                │
└─────────────────────────────────────────────────────────┘
```

## Provider Configuration Schema

### Provider Definition

Providers define **what** data sources are available and their default settings.

```typescript
interface ProviderConfig {
  id: string;                    // UUID
  name: string;                  // "Google", "Facebook"
  description: string;
  logoUrl: string;
  theme: {
    backgroundColor: string;
    borderColor: string;
  };
  
  // Data sources available from this provider
  sources: ProviderSource[];
  
  // OAuth configuration
  auth: OAuthConfig;
  
  // Link to API specification
  apiSpecId: string;
}

interface ProviderSource {
  name: string;                  // "Gmail", "Drive"
  description: string;
  enabledByDefault: boolean;
  
  // Which API endpoints to call
  endpoints: string[];           // ["GmailMessages", "GmailLabels"]
  
  // OAuth scopes required
  scopes: string[];
  
  // How to transform the data
  transformMap: string;          // "gmail_messages_to_communications"
}

interface OAuthConfig {
  type: "oauth2" | "oauth1" | "api_key";
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraParams?: Record<string, string>;
}
```

### Example: Google Provider Config

```json
{
  "id": "0198779b-182c-716e-9275-b81d99a47fdb",
  "name": "Google",
  "description": "Link your Google account for quick access to Gmail, Calendar, Drive, Contacts, and YouTube.",
  "logoUrl": "/branding/google/logo.svg",
  "theme": {
    "backgroundColor": "#a78bfa",
    "borderColor": "#c4b5fd"
  },
  "sources": [
    {
      "name": "Gmail",
      "description": "Sync your email messages and history.",
      "enabledByDefault": true,
      "endpoints": ["GmailMessages", "GmailLabels"],
      "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
      "transformMap": "google_gmail_messages"
    },
    {
      "name": "Calendar",
      "description": "Sync your calendar events and scheduling.",
      "enabledByDefault": true,
      "endpoints": ["CalendarEvents", "CalendarList"],
      "scopes": ["https://www.googleapis.com/auth/calendar.readonly"],
      "transformMap": "google_calendar_events"
    }
  ],
  "auth": {
    "type": "oauth2",
    "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenUrl": "https://oauth2.googleapis.com/token",
    "scopes": [],
    "extraParams": {
      "access_type": "offline",
      "prompt": "consent"
    }
  },
  "apiSpecId": "google_v1"
}
```

## API Specification Schema

API specs define **how** to fetch data from provider APIs.

```typescript
interface ApiSpec {
  id: string;
  name: string;
  baseUrl: string;
  version: string;
  
  // Metadata for user identification
  meta: {
    uniquenessField: string;      // "id", "email"
    defaultNameField: string;     // "name", "email"
    profileEndpoint: string;      // Endpoint to get user info
  };
  
  // API endpoints
  endpoints: Record<string, EndpointSpec>;
}

interface EndpointSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;                   // "/v1/users/me/messages"
  
  // Request configuration
  scopes?: string[];
  headers?: Record<string, string>;
  queryParams?: Record<string, ParamSpec>;
  
  // Response handling
  responseType: "single" | "collection";
  dataPath?: string;              // "messages" for { messages: [...] }
  
  // Pagination
  pagination?: {
    type: "cursor" | "offset" | "token";
    nextTokenField?: string;      // "nextPageToken"
    limitParam?: string;          // "maxResults"
    defaultLimit?: number;
  };
  
  // Rate limiting
  rateLimit?: {
    requestsPerSecond: number;
    requestsPerHour: number;
  };
}

interface ParamSpec {
  type: "static" | "dynamic" | "template";
  value?: string;                 // For static
  source?: string;                // For dynamic: "syncState.lastHistoryId"
  template?: string;              // For template: "{{ connection.syncState.token }}"
  required?: boolean;
  default?: unknown;
}
```

### Example: Google API Spec

```json
{
  "id": "google_v1",
  "name": "Google APIs",
  "baseUrl": "https://www.googleapis.com",
  "version": "v1",
  "meta": {
    "uniquenessField": "id",
    "defaultNameField": "email",
    "profileEndpoint": "oauth2/v2/userinfo"
  },
  "endpoints": {
    "GmailMessages": {
      "method": "GET",
      "path": "/gmail/v1/users/me/messages",
      "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
      "responseType": "collection",
      "dataPath": "messages",
      "queryParams": {
        "maxResults": {
          "type": "static",
          "value": "100"
        },
        "pageToken": {
          "type": "template",
          "template": "{{ syncState.gmail.nextPageToken }}",
          "required": false
        },
        "labelIds": {
          "type": "static",
          "value": "INBOX"
        }
      },
      "pagination": {
        "type": "token",
        "nextTokenField": "nextPageToken",
        "limitParam": "maxResults",
        "defaultLimit": 100
      },
      "rateLimit": {
        "requestsPerSecond": 5,
        "requestsPerHour": 10000
      }
    }
  }
}
```

## Transform Map Schema

Transform maps define **how** to normalize provider data into our internal schema.

```typescript
interface TransformMap {
  id: string;
  name: string;
  description: string;
  
  // Source and target schemas
  sourceType: string;             // "google_gmail_message"
  targetType: string;             // "communication"
  
  // Field mappings
  fields: Record<string, FieldMapping>;
  
  // Custom transformers
  transformers?: string[];        // ["extractEmailBody", "parseHtml"]
}

interface FieldMapping {
  type: "direct" | "nested" | "computed" | "template";
  
  // For direct mapping
  source?: string;                // "id", "payload.headers"
  
  // For nested objects
  path?: string;                  // "payload.headers[name=From].value"
  
  // For computed fields
  compute?: {
    function: string;             // "extractEmails"
    inputs: string[];             // ["payload.headers"]
  };
  
  // For template-based
  template?: string;              // "{{ payload.subject }} - {{ sender }}"
  
  // Type transformations
  transform?: {
    type: "date" | "number" | "boolean" | "json" | "custom";
    format?: string;              // For dates: "iso8601", "unix"
    customFn?: string;            // Reference to custom transformer
  };
  
  // Default value if source is null/undefined
  default?: unknown;
  
  // Required field
  required?: boolean;
}
```

### Example: Gmail to Communication Transform

```json
{
  "id": "google_gmail_messages",
  "name": "Gmail Messages to Communications",
  "description": "Transforms Gmail message objects into Communication entities",
  "sourceType": "google_gmail_message",
  "targetType": "communication",
  "fields": {
    "id": {
      "type": "template",
      "template": "gmail:{{ id }}"
    },
    "type": {
      "type": "direct",
      "source": "$constant",
      "default": "email"
    },
    "title": {
      "type": "nested",
      "path": "payload.headers[name=Subject].value",
      "default": "(No Subject)"
    },
    "content": {
      "type": "computed",
      "compute": {
        "function": "extractEmailBody",
        "inputs": ["payload.parts", "payload.body.data"]
      }
    },
    "sender": {
      "type": "nested",
      "path": "payload.headers[name=From].value"
    },
    "recipients": {
      "type": "computed",
      "compute": {
        "function": "extractEmailRecipients",
        "inputs": ["payload.headers"]
      }
    },
    "timestamp": {
      "type": "direct",
      "source": "internalDate",
      "transform": {
        "type": "date",
        "format": "unix_ms"
      }
    },
    "metadata": {
      "type": "template",
      "template": "{ \"threadId\": \"{{ threadId }}\", \"labelIds\": {{ labelIds }} }"
    }
  },
  "transformers": ["extractEmailBody", "extractEmailRecipients"]
}
```

## Sync Engine Design

### Core Components

```typescript
class SyncEngine {
  async syncConnection(connection: Connection): Promise<SyncResult> {
    // 1. Get provider config
    const provider = await this.providerRegistry.getProvider(connection.providerId);
    
    // 2. Get active sources
    const sources = this.getActiveSources(provider, connection.activeEndpoints);
    
    // 3. For each source, sync all endpoints
    const results: SyncResult[] = [];
    for (const source of sources) {
      const result = await this.syncSource(connection, source);
      results.push(result);
    }
    
    // 4. Update sync state
    await this.updateSyncState(connection, results);
    
    return this.aggregateResults(results);
  }
  
  private async syncSource(
    connection: Connection,
    source: ProviderSource
  ): Promise<SyncResult> {
    const apiSpec = await this.getApiSpec(source.apiSpecId);
    const transformMap = await this.getTransformMap(source.transformMap);
    
    const results: unknown[] = [];
    
    for (const endpointName of source.endpoints) {
      const endpoint = apiSpec.endpoints[endpointName];
      
      // Fetch data (handles pagination automatically)
      const rawData = await this.apiClient.fetch(connection, endpoint);
      
      // Transform data
      const transformedData = await this.transformEngine.transform(
        rawData,
        transformMap
      );
      
      results.push(...transformedData);
    }
    
    return {
      source: source.name,
      records: results.length,
      success: true
    };
  }
}
```

### API Client

```typescript
class ApiClient {
  async fetch(
    connection: Connection,
    endpoint: EndpointSpec
  ): Promise<unknown[]> {
    const allData: unknown[] = [];
    let hasMore = true;
    let pageToken: string | null = null;
    
    while (hasMore) {
      // Build request URL with params
      const url = this.buildUrl(endpoint, connection, pageToken);
      
      // Make request with auth
      const response = await this.request(connection, url, endpoint);
      
      // Extract data from response
      const data = this.extractData(response, endpoint.dataPath);
      allData.push(...data);
      
      // Handle pagination
      if (endpoint.pagination) {
        pageToken = this.extractNextToken(response, endpoint.pagination);
        hasMore = !!pageToken;
      } else {
        hasMore = false;
      }
      
      // Respect rate limits
      await this.rateLimiter.wait(endpoint.rateLimit);
    }
    
    return allData;
  }
}
```

### Transform Engine

```typescript
class TransformEngine {
  async transform(
    rawData: unknown[],
    transformMap: TransformMap
  ): Promise<unknown[]> {
    return rawData.map(item => this.transformItem(item, transformMap));
  }
  
  private transformItem(
    item: unknown,
    transformMap: TransformMap
  ): unknown {
    const result: Record<string, unknown> = {};
    
    for (const [targetField, mapping] of Object.entries(transformMap.fields)) {
      result[targetField] = this.applyMapping(item, mapping);
    }
    
    return result;
  }
  
  private applyMapping(item: unknown, mapping: FieldMapping): unknown {
    switch (mapping.type) {
      case "direct":
        return this.getNestedValue(item, mapping.source!);
      
      case "nested":
        return this.evaluatePath(item, mapping.path!);
      
      case "computed":
        return this.executeCompute(item, mapping.compute!);
      
      case "template":
        return this.renderTemplate(item, mapping.template!);
      
      default:
        return mapping.default;
    }
  }
}
```

## Planned Provider Integrations

Based on LifeScope ETL analysis and our current needs:

### Tier 1 - Currently Implemented (Migrate to new system)
1. **Google** - Gmail, Calendar, Drive, YouTube, Contacts
2. **Microsoft** - Outlook, Calendar, OneDrive
3. **Facebook** - Posts, Photos, Videos, Friends, Likes

### Tier 2 - High Priority (Commonly used services)
4. **Spotify** - Listening history, playlists, liked songs
5. **GitHub** - Repositories, commits, issues, PRs
6. **Slack** - Messages, channels, files
7. **Twitter/X** - Tweets, likes, DMs
8. **LinkedIn** - Posts, connections, messages

### Tier 3 - Medium Priority (Useful integrations)
9. **Instagram** - Posts, stories, messages
10. **Dropbox** - Files, folders, sharing
11. **Reddit** - Posts, comments, saved items
12. **Pinterest** - Pins, boards

### Tier 4 - Low Priority (Specialized)
13. **Steam** - Games, achievements, playtime
14. **Uber** - Trips, receipts
15. **Lyft** - Trips, receipts
16. **Strava** - Activities, routes
17. **Fitbit** - Health metrics, activities

### Tier 5 - Future Consideration
18. iCloud
19. WhatsApp (via export)
20. Telegram
21. Discord
22. Notion
23. Trello
24. Asana
25. Zoom

## Mock API Infrastructure

### Goals
- Enable testing without real API credentials
- Provide deterministic test data
- Support CI/CD pipelines
- Allow offline development

### Mock Provider Registry

```typescript
class MockProviderRegistry {
  private mocks: Map<string, MockProvider> = new Map();
  
  registerMock(providerId: string, mock: MockProvider): void {
    this.mocks.set(providerId, mock);
  }
  
  getMock(providerId: string): MockProvider | null {
    return this.mocks.get(providerId) || null;
  }
}

interface MockProvider {
  endpoints: Record<string, MockEndpoint>;
}

interface MockEndpoint {
  // Return static data
  staticData?: unknown[];
  
  // Or generate data
  generator?: (params: Record<string, unknown>) => unknown[];
  
  // Simulate errors
  error?: {
    code: number;
    message: string;
    probability: number;  // 0-1
  };
  
  // Simulate delays
  delay?: {
    min: number;
    max: number;
  };
}
```

### Mock Data Generation

```typescript
// Example: Mock Gmail messages
const mockGmailMessages: MockEndpoint = {
  generator: (params) => {
    const count = params.maxResults || 10;
    return Array.from({ length: count }, (_, i) => ({
      id: `msg_${i}`,
      threadId: `thread_${Math.floor(i / 3)}`,
      labelIds: ['INBOX'],
      snippet: `This is message ${i}`,
      payload: {
        headers: [
          { name: 'From', value: `sender${i}@example.com` },
          { name: 'To', value: 'user@example.com' },
          { name: 'Subject', value: `Test Message ${i}` },
          { name: 'Date', value: new Date(Date.now() - i * 86400000).toISOString() }
        ],
        body: {
          data: Buffer.from(`Email body for message ${i}`).toString('base64')
        }
      },
      internalDate: String(Date.now() - i * 86400000)
    }));
  },
  delay: { min: 100, max: 500 }
};
```

### Test API Keys

For providers that support sandbox/test environments:

```typescript
interface TestCredentials {
  providerId: string;
  environment: "sandbox" | "test" | "development";
  credentials: {
    clientId: string;
    clientSecret: string;
    testAccountEmail?: string;
  };
  limitations: string[];  // "Max 100 requests/day", etc.
}

// Example configurations
const testCredentials: TestCredentials[] = [
  {
    providerId: "google",
    environment: "test",
    credentials: {
      clientId: process.env.GOOGLE_TEST_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_TEST_CLIENT_SECRET!,
      testAccountEmail: "ci-test@example.com"
    },
    limitations: [
      "Gmail: Test account only",
      "Drive: Limited to 1GB",
      "YouTube: Read-only access"
    ]
  }
];
```

## Testing Strategy

### Test Pyramid

```
           ┌─────────────────┐
           │  E2E Tests      │  Full sync workflows with mock APIs
           │  (10%)          │
           ├─────────────────┤
           │ Integration     │  Provider configs + API specs + transforms
           │ Tests (30%)     │
           ├─────────────────┤
           │  Unit Tests     │  Individual components (TransformEngine,
           │  (60%)          │  ApiClient, field mappings)
           └─────────────────┘
```

### Test Cases

**Unit Tests:**
- Template rendering: `"{{ user.name }}"` → `"John Doe"`
- Field mapping: Nested path extraction
- Type transformations: Unix timestamp → Date
- Custom transformers: Email body extraction

**Integration Tests:**
- Provider config loading
- API spec validation
- Transform map application
- Sync state management

**E2E Tests:**
- Complete sync flow for each provider
- OAuth flow simulation
- Pagination handling
- Error recovery
- Rate limiting

### Example Test

```typescript
describe('GoogleGmailSync', () => {
  it('should sync Gmail messages and transform to communications', async () => {
    // Arrange
    const mockConnection = createMockConnection('google');
    const mockMessages = generateMockGmailMessages(5);
    mockApiClient.setMockResponse('GmailMessages', mockMessages);
    
    // Act
    const result = await syncEngine.syncConnection(mockConnection);
    
    // Assert
    expect(result.success).toBe(true);
    expect(result.records).toBe(5);
    
    const communications = await communicationRepo.findByConnection(mockConnection.id);
    expect(communications).toHaveLength(5);
    expect(communications[0]).toMatchObject({
      type: 'email',
      title: expect.stringContaining('Test Message'),
      sender: expect.stringMatching(/sender\d+@example.com/)
    });
  });
});
```

## Migration Path

### Phase 1: Foundation (Weeks 1-2)
- [ ] Create provider config schema and database tables
- [ ] Create API spec schema and storage
- [ ] Create transform map schema and storage
- [ ] Implement basic ProviderRegistry
- [ ] Implement basic ApiClient with template support
- [ ] Implement basic TransformEngine

### Phase 2: Mock Infrastructure (Week 3)
- [ ] Create MockProviderRegistry
- [ ] Implement mock data generators for Google, Microsoft, Facebook
- [ ] Create test credentials management
- [ ] Add mock API middleware/interceptor

### Phase 3: Migration (Weeks 4-5)
- [ ] Convert Google integration to new system
- [ ] Convert Microsoft integration to new system
- [ ] Convert Facebook integration to new system
- [ ] Maintain backward compatibility during transition
- [ ] Run parallel syncs (old + new) to validate

### Phase 4: New Integrations (Weeks 6-10)
- [ ] Add Spotify integration
- [ ] Add GitHub integration
- [ ] Add Slack integration
- [ ] Add Twitter integration
- [ ] Add LinkedIn integration
- [ ] Implement rate limiting and retry logic

### Phase 5: Testing & Documentation (Weeks 11-12)
- [ ] Complete unit test coverage
- [ ] Complete integration test coverage
- [ ] Add E2E tests for all providers
- [ ] Document provider addition process
- [ ] Create admin UI for managing provider configs

## File Structure

```
backend/apps/api/src/domains/etl/
├── config/
│   ├── providers/           # Provider configurations (JSON/DB)
│   │   ├── google.json
│   │   ├── microsoft.json
│   │   ├── facebook.json
│   │   └── ...
│   ├── api-specs/           # API specifications
│   │   ├── google-v1.json
│   │   ├── microsoft-graph-v1.json
│   │   └── ...
│   └── transforms/          # Transform maps
│       ├── google-gmail-to-communication.json
│       ├── google-calendar-to-event.json
│       └── ...
├── core/
│   ├── SyncEngine.ts
│   ├── ApiClient.ts
│   ├── TransformEngine.ts
│   ├── ProviderRegistry.ts
│   └── RateLimiter.ts
├── entities/
│   ├── ProviderConfigEntity.ts
│   ├── ApiSpecEntity.ts
│   ├── TransformMapEntity.ts
│   └── SyncStateEntity.ts
├── services/
│   ├── EtlService.ts        # Main orchestration service
│   ├── ProviderService.ts
│   └── TransformService.ts
├── transformers/            # Custom field transformers
│   ├── email.ts             # Email-specific transformers
│   ├── calendar.ts          # Calendar-specific transformers
│   └── file.ts              # File-specific transformers
├── mocks/
│   ├── MockProviderRegistry.ts
│   ├── MockApiClient.ts
│   └── generators/
│       ├── google.ts
│       ├── microsoft.ts
│       └── facebook.ts
├── __tests__/
│   ├── unit/
│   │   ├── TransformEngine.spec.ts
│   │   ├── ApiClient.spec.ts
│   │   └── field-mappings.spec.ts
│   ├── integration/
│   │   ├── google-sync.spec.ts
│   │   ├── microsoft-sync.spec.ts
│   │   └── facebook-sync.spec.ts
│   └── e2e/
│       └── full-sync-workflow.spec.ts
└── types/
    ├── provider.ts
    ├── api-spec.ts
    ├── transform.ts
    └── sync.ts
```

## Environment Variables

```bash
# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_TEST_CLIENT_ID=        # For sandbox testing
GOOGLE_TEST_CLIENT_SECRET=

# Microsoft
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TEST_CLIENT_ID=
MICROSOFT_TEST_CLIENT_SECRET=

# Facebook
FACEBOOK_CLIENT_ID=
FACEBOOK_CLIENT_SECRET=
FACEBOOK_TEST_APP_ID=         # Test app for sandbox
FACEBOOK_TEST_APP_SECRET=

# Spotify
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# GitHub
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# ETL Configuration
ETL_MOCK_MODE=false           # Enable mock APIs for testing
ETL_PARALLEL_SOURCES=3        # Max parallel source syncs
ETL_BATCH_SIZE=100            # Records per batch
ETL_RETRY_ATTEMPTS=3
ETL_RETRY_DELAY=1000          # milliseconds
```

## Performance Considerations

### Batch Processing
- Process transforms in batches of 100-1000 records
- Use TypeORM's bulk insert for database writes
- Stream large result sets instead of loading all in memory

### Caching
- Cache provider configs, API specs, and transform maps in memory
- Use Redis for distributed caching in production
- Cache compiled templates for field mappings

### Rate Limiting
- Implement token bucket algorithm per provider
- Respect API-specific rate limits (Google: 5 req/s, Facebook: 200 req/hour)
- Add exponential backoff for 429 responses

### Monitoring
- Track sync success/failure rates per provider
- Monitor API response times
- Alert on rate limit approaches
- Log transform errors for debugging

## Security Considerations

1. **Credential Storage**: Encrypt access tokens and refresh tokens at rest
2. **Audit Logging**: Log all sync activities, API calls, and data access
3. **Data Minimization**: Only request necessary scopes, sync only active endpoints
4. **PII Handling**: Flag fields containing PII for special handling
5. **Test Isolation**: Use separate test accounts, never production data in tests

## Success Metrics

- **Extensibility**: Time to add new provider < 2 hours (config only)
- **Reliability**: Sync success rate > 99%
- **Performance**: Process 1000 records/second
- **Test Coverage**: > 80% code coverage
- **Developer Experience**: New engineer can add provider in < 1 day

## Open Questions

1. Should transform maps support JavaScript/TypeScript for complex logic?
2. How to handle provider API version changes?
3. Should we support bidirectional sync (write back to providers)?
4. How to handle deleted items in source APIs?
5. Real-time webhooks vs. polling for incremental syncs?

## References

- [LifeScope ETL Repository](https://github.com/LifeScopeLabs/lifescope-etl)
- [OAuth 2.0 RFC](https://tools.ietf.org/html/rfc6749)
- [JSON Schema Specification](https://json-schema.org/)
- Current CI-Server implementations:
  - `backend/apps/api/src/domains/connections/clients/GoogleClient.ts`
  - `backend/apps/api/src/domains/connections/clients/MicrosoftClient.ts`
  - `backend/apps/api/src/domains/connections/clients/FacebookClient.ts`
  - `backend/apps/api/src/domains/etl/services/EtlService.ts`

---

**Document Version**: 1.0  
**Last Updated**: 2026-02-07  
**Status**: Planning Phase - Awaiting Review
