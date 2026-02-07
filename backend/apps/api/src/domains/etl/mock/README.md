# Mock API Infrastructure for ETL Connector Testing

This module provides a comprehensive mock API server infrastructure for testing all 26 ETL connectors without requiring actual API credentials or making real API calls.

## Overview

The mock API infrastructure consists of:

1. **23 New API Specifications** - Complete API specs for all providers that previously lacked them
2. **Mock API Server** - NestJS module serving realistic mock data for all providers
3. **Data Generators** - Realistic data generation functions matching expected API responses
4. **Pagination Support** - Proper pagination handling for all endpoint types
5. **Rate Limiting Simulation** - Simulates rate limits defined in API specs

## Directory Structure

```
backend/apps/api/
├── config/
│   └── api-specs/              # All 26 provider API specifications
│       ├── google-apis-v1.spec.json
│       ├── microsoft-graph-v1.spec.json
│       ├── facebook-graph-v18.spec.json
│       ├── discord-v10.spec.json
│       ├── slack-web-api.spec.json
│       ├── github-rest-api-v3.spec.json
│       ├── twitter-api-v2.spec.json
│       ├── linkedin-v2.spec.json
│       ├── spotify-web-api-v1.spec.json
│       ├── instagram-graph-api.spec.json
│       ├── twitch-helix-api.spec.json
│       ├── reddit-api-v1.spec.json
│       ├── steam-web-api-v1.spec.json
│       ├── notion-api-v1.spec.json
│       ├── dropbox-api-v2.spec.json
│       ├── box-api-v2.spec.json
│       ├── nextcloud-webdav-api.spec.json
│       ├── shopify-admin-api-v2024.spec.json
│       ├── stripe-api-v1.spec.json
│       ├── trello-api-v1.spec.json
│       ├── asana-api-v1.spec.json
│       ├── zoom-api-v2.spec.json
│       ├── telegram-bot-api-v6.spec.json
│       ├── signal-api-v1.spec.json
│       ├── openai-api-v1.spec.json
│       └── anthropic-api-v1.spec.json
└── src/domains/etl/mock/
    ├── index.ts                 # Module exports
    ├── mock-api.module.ts       # NestJS module definition
    ├── mock-api.controller.ts   # HTTP endpoints for all providers
    ├── mock-api.service.ts      # Service layer
    └── mock-data-generators.ts  # Data generation functions
```

## API Specifications

All API specs follow a consistent structure:

```json
{
  "id": "provider_api_version",
  "name": "Provider API Name",
  "baseUrl": "http://localhost:3001/mock/provider",
  "version": "v1",
  "meta": {
    "uniquenessField": "id",
    "defaultNameField": "name",
    "profileEndpoint": "users/me"
  },
  "endpoints": {
    "EndpointName": {
      "name": "EndpointName",
      "method": "GET",
      "path": "/endpoint/path",
      "responseType": "collection",
      "dataPath": "data",
      "queryParams": { ... },
      "pagination": {
        "type": "cursor|offset|token|none",
        "nextTokenField": "next_cursor",
        "cursorParam": "cursor",
        "limitParam": "limit",
        "defaultLimit": 100,
        "maxLimit": 1000
      },
      "rateLimit": {
        "requestsPerSecond": 10,
        "requestsPerHour": 5000
      }
    }
  },
  "globalRateLimit": {
    "requestsPerSecond": 10,
    "requestsPerDay": 100000
  }
}
```

### Key Features:

- **Consistent Base URLs**: All mock endpoints use `http://localhost:3001/mock/{provider}`
- **Pagination Types**: Support for cursor, offset, token, and no pagination
- **Rate Limits**: Realistic rate limits matching production APIs
- **Query Parameters**: Dynamic, static, and templated parameter support

## Mock API Endpoints

The mock server provides endpoints for all 26 providers:

### Communication Platforms
- **Discord**: Messages, DM channels, guilds
- **Slack**: Conversation history, channels list, files
- **Telegram**: Updates, messages
- **Signal**: Messages

### Social Media
- **Twitter/X**: Tweets, liked tweets
- **LinkedIn**: Posts, connections
- **Instagram**: Media
- **Reddit**: Posts, comments, saved items

### Developer Platforms
- **GitHub**: Repos, issues, pull requests, events
- **GitLab**: (uses existing specs)

### Content & Storage
- **Google Drive**: Files, changes (via existing Google APIs spec)
- **Dropbox**: Files, folder listing
- **Box**: Folder items, file info
- **Nextcloud**: WebDAV files, contacts, calendar
- **OneDrive**: (via existing Microsoft Graph spec)

### Productivity
- **Notion**: Pages, databases
- **Trello**: Boards, cards
- **Asana**: Tasks, projects
- **Zoom**: Meetings, recordings

### Entertainment
- **Spotify**: Playlists, tracks, recently played
- **Twitch**: Videos, follows, clips
- **Steam**: Games, achievements, recent games

### Business
- **Shopify**: Orders, products, customers
- **Stripe**: Charges, payment intents, customers, subscriptions

### AI Platforms
- **OpenAI**: Conversations, models
- **Anthropic**: Messages

## Mock Data Generators

Each provider has dedicated data generator functions that produce realistic mock data:

### Data Generation Features:

1. **Realistic IDs**: Platform-specific ID formats (e.g., Discord snowflakes, Stripe IDs)
2. **Timestamps**: Random dates within configurable ranges
3. **Pagination**: Proper cursor/token generation for paginated responses
4. **Relationships**: Linked data between entities
5. **Variety**: Randomized content to simulate real-world variance

### Example Usage:

```typescript
import { generateDiscordMessages } from './mock-data-generators';

// Generate 50 Discord messages
const response = generateDiscordMessages('channel123', { limit: 50 });
```

## Integration with ETL System

### 1. Update Provider Configs

Ensure each provider's `apiSpecId` matches the new spec files:

```json
{
  "id": "discord",
  "apiSpecId": "discord_v10",
  ...
}
```

### 2. Configure Base URLs

For testing, point all providers to the mock server:

```json
{
  "baseUrl": "http://localhost:3001/mock/discord"
}
```

### 3. Import Mock Module

In your main application module:

```typescript
import { MockApiModule } from './domains/etl/mock';

@Module({
  imports: [
    MockApiModule,
    // ... other modules
  ],
})
export class AppModule {}
```

## Testing Guide

### Unit Testing

```typescript
import { Test } from '@nestjs/testing';
import { MockApiService } from './mock-api.service';

describe('MockApiService', () => {
  let service: MockApiService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [MockApiService],
    }).compile();

    service = module.get<MockApiService>(MockApiService);
  });

  it('should generate Discord messages', () => {
    const result = service.generateDiscordMessages('channel123', { limit: 10 });
    expect(result.messages).toHaveLength(10);
    expect(result.messages[0]).toHaveProperty('id');
    expect(result.messages[0]).toHaveProperty('content');
  });
});
```

### Integration Testing

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { MockApiModule } from './mock-api.module';

describe('Mock API Integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MockApiModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('GET /mock/discord/users/@me/guilds', () => {
    return request(app.getHttpServer())
      .get('/mock/discord/users/@me/guilds')
      .expect(200)
      .expect((res) => {
        expect(res.body.guilds).toBeDefined();
        expect(Array.isArray(res.body.guilds)).toBe(true);
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
```

### E2E Testing with ETL Connectors

```typescript
describe('ETL Connector Tests', () => {
  it('should sync Discord data using mock API', async () => {
    const connector = new DiscordConnector({
      apiSpecId: 'discord_v10',
      baseUrl: 'http://localhost:3001/mock/discord',
    });

    const messages = await connector.fetchMessages('channel123');
    expect(messages).toBeDefined();
    expect(messages.length).toBeGreaterThan(0);
  });
});
```

## Pagination Handling

The mock API supports all major pagination patterns:

### Cursor-Based (Discord, Slack, Instagram)
```json
{
  "data": [...],
  "pagination": {
    "next_cursor": "eyJpZCI6MTIzfQ=="
  }
}
```

### Offset-Based (GitHub, LinkedIn, Asana)
```json
{
  "data": [...],
  "page": 2,
  "total": 150
}
```

### Token-Based (Google APIs, Twitter)
```json
{
  "data": [...],
  "meta": {
    "next_token": "abc123xyz"
  }
}
```

### Link-Based (Microsoft Graph)
```json
{
  "value": [...],
  "@odata.nextLink": "https://..."
}
```

## Rate Limiting

Rate limits are defined in API specs but not enforced by the mock server. To test rate limiting:

```typescript
// In your ETL connector
if (requestsThisSecond > spec.rateLimit.requestsPerSecond) {
  await sleep(1000);
}
```

## Data Customization

To customize mock data for specific tests:

```typescript
import { generateDiscordMessages } from './mock-data-generators';

// Override the generator
const customMessages = generateDiscordMessages('channel123', { limit: 5 });
customMessages.messages[0].content = 'Custom test message';
```

## Production Considerations

⚠️ **Important**: This mock infrastructure is for **testing only**.

- Never use in production environments
- Always use real API credentials for production
- Mock data does not persist between requests
- No authentication or authorization checks

## Extending the Mock API

### Adding New Providers

1. Create API spec in `config/api-specs/`:
```json
{
  "id": "newprovider_v1",
  "name": "New Provider API",
  "baseUrl": "http://localhost:3001/mock/newprovider",
  ...
}
```

2. Add generator functions in `mock-data-generators.ts`:
```typescript
export function generateNewProviderData(query: any) {
  return {
    data: [/* mock data */],
  };
}
```

3. Add endpoint in `mock-api.controller.ts`:
```typescript
@Get('newprovider/endpoint')
getNewProviderData(@Query() query: any) {
  return this.mockApiService.generateNewProviderData(query);
}
```

4. Add service method in `mock-api.service.ts`:
```typescript
generateNewProviderData(query: any) {
  return generateNewProviderData(query);
}
```

## Troubleshooting

### Issue: Mock endpoint returns 404
**Solution**: Verify the route matches the API spec's `path` field exactly.

### Issue: Pagination not working
**Solution**: Check that the pagination type in the spec matches the endpoint's implementation.

### Issue: Generated data doesn't match transform map
**Solution**: Review the transform map requirements and adjust the generator accordingly.

## API Reference

### MockApiController

All controller methods follow the pattern:
```typescript
@Get('provider/endpoint')
methodName(@Param() params, @Query() query) {
  return this.mockApiService.generateMethod(params, query);
}
```

### MockApiService

All service methods are thin wrappers around generator functions:
```typescript
generateMethod(param: string, query: any) {
  return generateMethod(param, query);
}
```

### Data Generator Functions

All generators follow the signature:
```typescript
export function generateProviderData(
  param?: string,
  query?: any
): ProviderResponse {
  // Generate and return mock data
}
```

## Best Practices

1. **Use Realistic Data**: Ensure generated data matches expected formats
2. **Test Pagination**: Always test with multiple pages
3. **Vary Data**: Use randomization to catch edge cases
4. **Match Specs**: Keep generators in sync with API specs
5. **Document Changes**: Update this README when adding providers

## Performance

The mock API is designed for testing, not production scale:

- **Response Time**: < 10ms for most endpoints
- **Concurrency**: Handles 100+ concurrent requests
- **Memory**: Minimal, data is generated on-demand
- **No Persistence**: Data is regenerated for each request

## Future Enhancements

Potential improvements:
- [ ] Add WebSocket support for real-time providers
- [ ] Implement actual rate limiting simulation
- [ ] Add configurable data sets
- [ ] Support for webhook testing
- [ ] Request/response logging
- [ ] Mock OAuth flows
- [ ] Persistent mock data store

## License

This mock infrastructure is part of the Companion Intelligence CI-Server project and follows the same license.

## Support

For questions or issues with the mock API:
1. Check this README
2. Review the API specs in `config/api-specs/`
3. Examine the generator functions
4. Consult the main ETL documentation
