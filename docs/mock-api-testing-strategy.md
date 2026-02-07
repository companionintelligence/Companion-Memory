# Mock API & Testing Strategy

## Overview

This document defines the comprehensive testing strategy for the ETL system, including mock API infrastructure, test data generation, and testing methodologies for all provider integrations.

## Goals

1. **Enable Offline Development**: Developers can work without real API credentials
2. **Consistent Testing**: Same test data across all environments
3. **Fast CI/CD**: Tests run in seconds, not minutes
4. **Realistic Scenarios**: Mock data reflects real API behavior
5. **Error Simulation**: Test error handling and edge cases
6. **No External Dependencies**: Tests don't rely on third-party API availability

## Architecture

### Mock API Infrastructure

```
┌─────────────────────────────────────────────────────────┐
│                  ETL Service                             │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ (detect mock mode)
                     │
         ┌───────────┴───────────┐
         │                       │
    ┌────▼─────┐          ┌─────▼────┐
    │ Real     │          │ Mock     │
    │ API      │          │ API      │
    │ Client   │          │ Client   │
    └──────────┘          └─────┬────┘
                                │
                    ┌───────────┼───────────┐
                    │           │           │
              ┌─────▼────┐ ┌───▼────┐ ┌───▼─────┐
              │ Mock     │ │ Mock   │ │  Mock   │
              │ Google   │ │ FB     │ │  MS     │
              │ Provider │ │ Prov.  │ │  Prov.  │
              └──────────┘ └────────┘ └─────────┘
```

## Mock API Implementation

### 1. Mock API Client

```typescript
/**
 * Mock API Client that intercepts requests and returns mock data
 */
export class MockApiClient extends ApiClient {
  private mockRegistry: MockProviderRegistry;
  
  constructor(mockRegistry: MockProviderRegistry) {
    super();
    this.mockRegistry = mockRegistry;
  }
  
  async fetch(
    connection: Connection,
    endpoint: EndpointSpec
  ): Promise<unknown[]> {
    const mock = this.mockRegistry.getMock(connection.providerId);
    
    if (!mock) {
      throw new Error(`No mock configured for provider: ${connection.providerId}`);
    }
    
    const mockEndpoint = mock.endpoints[endpoint.name];
    
    if (!mockEndpoint) {
      throw new Error(`No mock endpoint: ${endpoint.name}`);
    }
    
    // Simulate network delay
    await this.simulateDelay(mockEndpoint.delay);
    
    // Simulate errors
    if (this.shouldSimulateError(mockEndpoint.error)) {
      throw this.generateError(mockEndpoint.error);
    }
    
    // Return mock data
    return this.generateMockData(mockEndpoint, endpoint);
  }
  
  private async simulateDelay(delay?: { min: number; max: number }): Promise<void> {
    if (!delay) return;
    
    const ms = Math.random() * (delay.max - delay.min) + delay.min;
    await new Promise(resolve => setTimeout(resolve, ms));
  }
  
  private shouldSimulateError(error?: ErrorConfig): boolean {
    if (!error) return false;
    return Math.random() < error.probability;
  }
  
  private generateError(error: ErrorConfig): Error {
    const err = new Error(error.message);
    (err as any).statusCode = error.code;
    return err;
  }
  
  private generateMockData(
    mockEndpoint: MockEndpoint,
    endpointSpec: EndpointSpec
  ): unknown[] {
    if (mockEndpoint.staticData) {
      return mockEndpoint.staticData;
    }
    
    if (mockEndpoint.generator) {
      const params = this.extractParams(endpointSpec);
      return mockEndpoint.generator(params);
    }
    
    return [];
  }
}
```

### 2. Mock Provider Registry

```typescript
/**
 * Registry for managing mock providers
 */
export class MockProviderRegistry {
  private mocks = new Map<string, MockProvider>();
  
  registerMock(providerId: string, mock: MockProvider): void {
    this.mocks.set(providerId, mock);
  }
  
  getMock(providerId: string): MockProvider | undefined {
    return this.mocks.get(providerId);
  }
  
  clearMocks(): void {
    this.mocks.clear();
  }
}

export interface MockProvider {
  endpoints: Record<string, MockEndpoint>;
}

export interface MockEndpoint {
  // Static data to return
  staticData?: unknown[];
  
  // Or function to generate data dynamically
  generator?: (params: Record<string, unknown>) => unknown[];
  
  // Simulate errors
  error?: ErrorConfig;
  
  // Simulate network delay
  delay?: DelayConfig;
  
  // Validate request parameters
  validateParams?: (params: Record<string, unknown>) => void;
}

export interface ErrorConfig {
  code: number;              // HTTP status code
  message: string;
  probability: number;       // 0.0 to 1.0
  errorType?: string;        // "rate_limit", "auth_error", etc.
}

export interface DelayConfig {
  min: number;               // milliseconds
  max: number;
}
```

### 3. Mock Data Generators

Each provider has a dedicated mock data generator module.

#### Google Mock Generator

```typescript
import { faker } from '@faker-js/faker';

export const googleMockProvider: MockProvider = {
  endpoints: {
    GmailMessages: {
      generator: (params) => {
        const count = Math.min(params.maxResults as number || 10, 100);
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.alphanumeric(16),
          threadId: faker.string.alphanumeric(16),
          labelIds: ['INBOX', 'UNREAD'].slice(0, Math.random() > 0.5 ? 1 : 2),
          snippet: faker.lorem.sentence(),
          payload: {
            headers: [
              { name: 'From', value: faker.internet.email() },
              { name: 'To', value: 'user@example.com' },
              { name: 'Subject', value: faker.lorem.words(5) },
              { name: 'Date', value: faker.date.recent().toISOString() }
            ],
            body: {
              data: Buffer.from(faker.lorem.paragraphs(3)).toString('base64')
            },
            mimeType: 'text/html'
          },
          internalDate: String(faker.date.recent().getTime())
        }));
      },
      delay: { min: 100, max: 500 },
      error: { 
        code: 429, 
        message: 'Rate limit exceeded',
        probability: 0.01  // 1% chance
      }
    },
    
    CalendarEvents: {
      generator: (params) => {
        const count = params.maxResults as number || 20;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.uuid(),
          summary: faker.lorem.words(3),
          description: faker.lorem.sentence(),
          start: {
            dateTime: faker.date.soon().toISOString(),
            timeZone: 'America/Los_Angeles'
          },
          end: {
            dateTime: faker.date.soon({ days: 1 }).toISOString(),
            timeZone: 'America/Los_Angeles'
          },
          attendees: Array.from(
            { length: Math.floor(Math.random() * 5) },
            () => ({
              email: faker.internet.email(),
              responseStatus: faker.helpers.arrayElement(['accepted', 'tentative', 'declined'])
            })
          ),
          creator: {
            email: 'user@example.com'
          }
        }));
      },
      delay: { min: 200, max: 600 }
    },
    
    DriveFiles: {
      generator: (params) => {
        const count = params.pageSize as number || 100;
        const mimeTypes = [
          'application/pdf',
          'application/vnd.google-apps.document',
          'application/vnd.google-apps.spreadsheet',
          'image/jpeg',
          'video/mp4'
        ];
        
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.alphanumeric(32),
          name: `${faker.system.fileName()}.${faker.system.fileExt()}`,
          mimeType: faker.helpers.arrayElement(mimeTypes),
          size: String(faker.number.int({ min: 1024, max: 10485760 })),
          createdTime: faker.date.past().toISOString(),
          modifiedTime: faker.date.recent().toISOString(),
          webViewLink: faker.internet.url(),
          owners: [{
            displayName: faker.person.fullName(),
            emailAddress: faker.internet.email()
          }]
        }));
      },
      delay: { min: 300, max: 800 }
    },
    
    YouTubeActivities: {
      generator: (params) => {
        const count = params.maxResults as number || 25;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.alphanumeric(20),
          snippet: {
            publishedAt: faker.date.recent().toISOString(),
            title: faker.lorem.words(5),
            description: faker.lorem.sentence(),
            thumbnails: {
              default: { url: faker.image.url() }
            },
            type: faker.helpers.arrayElement(['like', 'subscription', 'upload'])
          },
          contentDetails: {
            like: {
              resourceId: {
                videoId: faker.string.alphanumeric(11)
              }
            }
          }
        }));
      },
      delay: { min: 200, max: 500 }
    },
    
    Contacts: {
      generator: (params) => {
        const count = params.pageSize as number || 100;
        return Array.from({ length: count }, (_, i) => ({
          resourceName: `people/${faker.string.alphanumeric(21)}`,
          names: [{
            displayName: faker.person.fullName(),
            givenName: faker.person.firstName(),
            familyName: faker.person.lastName()
          }],
          emailAddresses: [{
            value: faker.internet.email()
          }],
          phoneNumbers: [{
            value: faker.phone.number()
          }]
        }));
      },
      delay: { min: 150, max: 400 }
    }
  }
};
```

#### Facebook Mock Generator

```typescript
export const facebookMockProvider: MockProvider = {
  endpoints: {
    UserPosts: {
      generator: (params) => {
        const count = 25;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.numeric(15),
          message: faker.lorem.paragraph(),
          created_time: faker.date.recent({ days: 30 }).toISOString(),
          story: Math.random() > 0.7 ? faker.lorem.sentence() : undefined,
          link: Math.random() > 0.5 ? faker.internet.url() : undefined,
          type: faker.helpers.arrayElement(['status', 'photo', 'link', 'video']),
          from: {
            id: faker.string.numeric(15),
            name: faker.person.fullName()
          }
        }));
      },
      delay: { min: 200, max: 600 }
    },
    
    UserPhotos: {
      generator: (params) => {
        const count = 20;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.numeric(15),
          created_time: faker.date.recent({ days: 60 }).toISOString(),
          name: faker.lorem.words(3),
          images: [{
            height: 1080,
            width: 1920,
            source: faker.image.url()
          }],
          link: faker.internet.url()
        }));
      },
      delay: { min: 300, max: 700 }
    },
    
    UserVideos: {
      generator: (params) => {
        const count = 10;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.numeric(15),
          created_time: faker.date.recent({ days: 90 }).toISOString(),
          title: faker.lorem.words(4),
          description: faker.lorem.sentence(),
          source: faker.internet.url(),
          permalink_url: faker.internet.url()
        }));
      },
      delay: { min: 400, max: 900 }
    },
    
    UserFriends: {
      generator: (params) => {
        const count = 15;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.numeric(15),
          name: faker.person.fullName(),
          picture: {
            data: {
              url: faker.image.avatar()
            }
          }
        }));
      },
      delay: { min: 200, max: 500 }
    },
    
    UserLikes: {
      generator: (params) => {
        const count = 20;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.numeric(15),
          name: faker.company.name(),
          category: faker.helpers.arrayElement(['Entertainment', 'Technology', 'Sports', 'News']),
          link: faker.internet.url()
        }));
      },
      delay: { min: 150, max: 400 }
    }
  }
};
```

#### Microsoft Mock Generator

```typescript
export const microsoftMockProvider: MockProvider = {
  endpoints: {
    OutlookMessages: {
      generator: (params) => {
        const count = params.$top as number || 10;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.alphanumeric(128),
          subject: faker.lorem.words(5),
          bodyPreview: faker.lorem.sentence(),
          from: {
            emailAddress: {
              name: faker.person.fullName(),
              address: faker.internet.email()
            }
          },
          toRecipients: [{
            emailAddress: {
              address: 'user@example.com'
            }
          }],
          receivedDateTime: faker.date.recent().toISOString(),
          hasAttachments: Math.random() > 0.7,
          isRead: Math.random() > 0.5
        }));
      },
      delay: { min: 200, max: 500 }
    },
    
    CalendarEvents: {
      generator: (params) => {
        const count = params.$top as number || 20;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.alphanumeric(128),
          subject: faker.lorem.words(3),
          start: {
            dateTime: faker.date.soon().toISOString(),
            timeZone: 'Pacific Standard Time'
          },
          end: {
            dateTime: faker.date.soon({ days: 1 }).toISOString(),
            timeZone: 'Pacific Standard Time'
          },
          location: {
            displayName: faker.location.streetAddress()
          },
          attendees: Array.from(
            { length: Math.floor(Math.random() * 5) },
            () => ({
              emailAddress: {
                name: faker.person.fullName(),
                address: faker.internet.email()
              },
              status: {
                response: faker.helpers.arrayElement(['accepted', 'tentativelyAccepted', 'declined'])
              }
            })
          )
        }));
      },
      delay: { min: 250, max: 600 }
    },
    
    OneDriveItems: {
      generator: (params) => {
        const count = 30;
        return Array.from({ length: count }, (_, i) => ({
          id: faker.string.alphanumeric(32),
          name: faker.system.fileName(),
          size: faker.number.int({ min: 1024, max: 10485760 }),
          file: {
            mimeType: 'application/octet-stream'
          },
          createdDateTime: faker.date.past().toISOString(),
          lastModifiedDateTime: faker.date.recent().toISOString(),
          webUrl: faker.internet.url()
        }));
      },
      delay: { min: 300, max: 700 }
    }
  }
};
```

## Test Data Management

### Data Fixtures

Store reusable test fixtures for complex scenarios:

```typescript
// backend/apps/api/src/domains/etl/__tests__/fixtures/google-gmail-thread.json
{
  "messages": [
    {
      "id": "msg001",
      "threadId": "thread001",
      "labelIds": ["INBOX"],
      "snippet": "This is a test email",
      "payload": {
        "headers": [
          { "name": "From", "value": "sender@example.com" },
          { "name": "To", "value": "recipient@example.com" },
          { "name": "Subject", "value": "Test Email Thread" },
          { "name": "Date", "value": "2026-02-01T10:00:00Z" }
        ],
        "body": {
          "data": "VGhpcyBpcyBhIHRlc3QgZW1haWw="
        }
      },
      "internalDate": "1706781600000"
    }
  ]
}
```

### Seed Data Generator

```typescript
/**
 * Generates consistent seed data for testing
 */
export class SeedDataGenerator {
  private seed: number;
  
  constructor(seed: number = 12345) {
    this.seed = seed;
    faker.seed(seed);
  }
  
  generateGoogleData(): GoogleSeedData {
    return {
      emails: this.generateEmails(50),
      calendarEvents: this.generateCalendarEvents(20),
      driveFiles: this.generateDriveFiles(30),
      contacts: this.generateContacts(25),
      youtubeActivities: this.generateYouTubeActivities(15)
    };
  }
  
  generateFacebookData(): FacebookSeedData {
    return {
      posts: this.generatePosts(30),
      photos: this.generatePhotos(20),
      videos: this.generateVideos(10),
      friends: this.generateFriends(15),
      likes: this.generateLikes(20)
    };
  }
  
  generateMicrosoftData(): MicrosoftSeedData {
    return {
      emails: this.generateOutlookEmails(40),
      calendarEvents: this.generateOutlookEvents(15),
      files: this.generateOneDriveFiles(25)
    };
  }
  
  // Reset seed for reproducible tests
  reset(): void {
    faker.seed(this.seed);
  }
}
```

## Testing Modes

### 1. Mock Mode (Default for Tests)

```bash
# Enable mock mode
ETL_MOCK_MODE=true

# All API calls return mock data
# No external network requests
# Fast execution
```

### 2. Sandbox Mode (Provider Test Accounts)

```bash
# Use provider sandbox/test environments
ETL_TEST_MODE=sandbox

# Real OAuth flow with test accounts
# Limited data, controlled environment
# Requires test credentials
```

### 3. Production Mode (Real APIs)

```bash
# Use real provider APIs
ETL_MOCK_MODE=false
ETL_TEST_MODE=false

# Full production behavior
# Real user data
# Rate limits apply
```

## Test Suites

### Unit Tests

Test individual components in isolation:

```typescript
describe('TransformEngine', () => {
  describe('field mapping', () => {
    it('should extract nested field value', () => {
      const data = {
        payload: {
          headers: [
            { name: 'From', value: 'test@example.com' }
          ]
        }
      };
      
      const mapping: FieldMapping = {
        type: 'nested',
        path: 'payload.headers[name=From].value'
      };
      
      const result = transformEngine.applyMapping(data, mapping);
      
      expect(result).toBe('test@example.com');
    });
    
    it('should transform unix timestamp to Date', () => {
      const data = { timestamp: '1706781600000' };
      
      const mapping: FieldMapping = {
        type: 'direct',
        source: 'timestamp',
        transform: {
          type: 'date',
          format: 'unix_ms'
        }
      };
      
      const result = transformEngine.applyMapping(data, mapping);
      
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-02-01T10:00:00.000Z');
    });
    
    it('should render template with variables', () => {
      const data = {
        user: { name: 'John' },
        action: 'liked'
      };
      
      const mapping: FieldMapping = {
        type: 'template',
        template: '{{ user.name }} {{ action }} this'
      };
      
      const result = transformEngine.applyMapping(data, mapping);
      
      expect(result).toBe('John liked this');
    });
  });
});
```

### Integration Tests

Test multiple components together:

```typescript
describe('Google Gmail Sync', () => {
  let mockRegistry: MockProviderRegistry;
  let syncEngine: SyncEngine;
  let connection: Connection;
  
  beforeEach(() => {
    mockRegistry = new MockProviderRegistry();
    mockRegistry.registerMock('google', googleMockProvider);
    
    const mockApiClient = new MockApiClient(mockRegistry);
    syncEngine = new SyncEngine(mockApiClient, /* ... */);
    
    connection = createTestConnection('google', {
      activeEndpoints: ['Gmail']
    });
  });
  
  it('should sync Gmail messages and create communications', async () => {
    // Act
    const result = await syncEngine.syncConnection(connection);
    
    // Assert
    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].name).toBe('Gmail');
    expect(result.sources[0].records).toBeGreaterThan(0);
    
    // Verify database records
    const communications = await communicationRepo.findByConnection(connection.id);
    expect(communications.length).toBe(result.sources[0].records);
    
    // Verify transformation
    const firstComm = communications[0];
    expect(firstComm.type).toBe('email');
    expect(firstComm.title).toBeTruthy();
    expect(firstComm.sender).toMatch(/@/);
  });
  
  it('should handle pagination correctly', async () => {
    // Setup mock with pagination
    const mockEndpoint = googleMockProvider.endpoints.GmailMessages;
    mockEndpoint.generator = (params) => {
      const pageToken = params.pageToken as string;
      
      if (!pageToken) {
        // First page
        return {
          messages: Array(50).fill(null).map((_, i) => ({ id: `msg${i}` })),
          nextPageToken: 'page2'
        };
      } else if (pageToken === 'page2') {
        // Second page
        return {
          messages: Array(30).fill(null).map((_, i) => ({ id: `msg${i + 50}` }))
        };
      }
      
      return { messages: [] };
    };
    
    // Act
    const result = await syncEngine.syncConnection(connection);
    
    // Assert
    expect(result.sources[0].records).toBe(80);  // 50 + 30
  });
  
  it('should handle API errors gracefully', async () => {
    // Setup mock to return error
    googleMockProvider.endpoints.GmailMessages.error = {
      code: 429,
      message: 'Rate limit exceeded',
      probability: 1.0  // Always error
    };
    
    // Act
    const result = await syncEngine.syncConnection(connection);
    
    // Assert
    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit exceeded');
    
    // Verify retry logic was attempted
    // Verify sync state was not updated
  });
});
```

### E2E Tests

Test complete workflows:

```typescript
describe('Complete Sync Workflow', () => {
  it('should sync all active sources for a connection', async () => {
    // Arrange
    const user = await createTestUser();
    const connection = await createTestConnection('google', {
      userId: user.id,
      activeEndpoints: ['Gmail', 'Calendar', 'Drive']
    });
    
    // Act
    const result = await etlService.handleConnectionSync(
      { userId: user.id },
      connection.id
    );
    
    // Assert
    expect(result).toBeDefined();
    
    // Verify all sources were synced
    const syncState = await connectionService.findById({ userId: user.id }, connection.id);
    expect(syncState?.syncState).toHaveProperty('gmail');
    expect(syncState?.syncState).toHaveProperty('calendar');
    expect(syncState?.syncState).toHaveProperty('drive');
    
    // Verify data was created
    const communications = await communicationRepo.findByUser(user.id);
    const events = await eventRepo.findByUser(user.id);
    const files = await contentRepo.findByUser(user.id, { type: 'File' });
    
    expect(communications.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);
  });
});
```

## CI/CD Integration

### GitHub Actions Workflow

```yaml
name: ETL Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: yarn install
      
      - name: Run database migrations
        run: yarn migrate
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/ci_test
      
      - name: Run unit tests
        run: yarn test:unit
        env:
          ETL_MOCK_MODE: true
      
      - name: Run integration tests
        run: yarn test:integration
        env:
          ETL_MOCK_MODE: true
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/ci_test
      
      - name: Run E2E tests
        run: yarn test:e2e
        env:
          ETL_MOCK_MODE: true
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/ci_test
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

## Performance Testing

### Load Tests

```typescript
describe('Performance Tests', () => {
  it('should process 1000 records in < 1 second', async () => {
    const records = Array(1000).fill(null).map(() => generateMockEmail());
    
    const start = Date.now();
    const result = await transformEngine.transform(records, gmailTransformMap);
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(1000);
    expect(result).toHaveLength(1000);
  });
  
  it('should handle 10 concurrent syncs', async () => {
    const connections = Array(10).fill(null).map(() => createTestConnection('google'));
    
    const start = Date.now();
    const results = await Promise.all(
      connections.map(conn => syncEngine.syncConnection(conn))
    );
    const duration = Date.now() - start;
    
    expect(results.every(r => r.success)).toBe(true);
    expect(duration).toBeLessThan(5000);  // 5 seconds for 10 concurrent syncs
  });
});
```

## Mock Data Validation

### Schema Validation

Ensure mock data matches real API schemas:

```typescript
import { validateSchema } from 'ajv';
import googleGmailSchema from './schemas/google-gmail-message.json';

describe('Mock Data Validation', () => {
  it('should generate valid Gmail messages', () => {
    const mockMessages = googleMockProvider.endpoints.GmailMessages.generator!({});
    
    mockMessages.forEach(msg => {
      const isValid = validateSchema(googleGmailSchema, msg);
      expect(isValid).toBe(true);
    });
  });
});
```

## Test Utilities

### Test Helpers

```typescript
/**
 * Utility functions for tests
 */
export const testHelpers = {
  createTestUser: async (): Promise<User> => {
    return userRepo.create({
      id: uuid7(),
      email: faker.internet.email(),
      name: faker.person.fullName()
    });
  },
  
  createTestConnection: async (
    providerId: string,
    overrides?: Partial<Connection>
  ): Promise<Connection> => {
    return connectionRepo.create({
      id: uuid7(),
      providerId,
      userId: testUser.id,
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      tokenExpiry: new Date(Date.now() + 3600000),
      active: true,
      activeEndpoints: [],
      ...overrides
    });
  },
  
  resetDatabase: async (): Promise<void> => {
    await connectionRepo.delete({});
    await communicationRepo.delete({});
    await eventRepo.delete({});
    await contentRepo.delete({});
  },
  
  waitForSync: async (connectionId: string, timeout = 5000): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const connection = await connectionRepo.findById(connectionId);
      if (connection?.syncState?.lastSyncedAt) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Sync timeout');
  }
};
```

## Documentation

### Test Documentation Template

For each provider, document:

```markdown
# Google Provider Tests

## Mock Data
- Gmail: 50 messages with realistic headers, body, and metadata
- Calendar: 20 events with attendees and recurrence
- Drive: 30 files with various MIME types

## Test Coverage
- ✅ OAuth flow
- ✅ Token refresh
- ✅ Pagination (Gmail uses pageToken, Calendar uses syncToken)
- ✅ Rate limiting (respects 5 req/sec limit)
- ✅ Error handling (401, 403, 429, 500)
- ✅ Transform maps (email → communication, event → event, file → content)
- ✅ Sync state updates (pageToken, syncToken, lastHistoryId)

## Known Issues
- Gmail API mock doesn't support history API yet
- Calendar recurring events not fully tested
```

---

## Summary

This mock API and testing infrastructure provides:

1. ✅ **Fast, reliable tests** that don't depend on external APIs
2. ✅ **Realistic mock data** using Faker.js for consistency
3. ✅ **Error simulation** to test edge cases
4. ✅ **Multiple testing modes** (mock, sandbox, production)
5. ✅ **CI/CD ready** with GitHub Actions integration
6. ✅ **Performance benchmarks** to maintain speed
7. ✅ **Comprehensive coverage** (unit, integration, E2E)
8. ✅ **Developer-friendly** utilities and helpers

**Next Steps:**
1. Implement `MockApiClient` and `MockProviderRegistry`
2. Create mock generators for Google, Microsoft, Facebook
3. Write test fixtures for common scenarios
4. Set up CI/CD pipeline
5. Document testing procedures for new providers

---

**Document Version**: 1.0  
**Last Updated**: 2026-02-07  
**Status**: Planning Phase
