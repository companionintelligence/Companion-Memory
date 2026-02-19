# BlueBubbles iMessage Integration

This document describes the BlueBubbles integration for syncing iMessage conversations into the CI-Server platform.

## Overview

BlueBubbles is a macOS application that provides a REST API for accessing iMessage conversations programmatically. This integration allows CI-Server to sync iMessage messages, chats, and media through the BlueBubbles REST API.

## Architecture

### Components

1. **BlueBubblesClient** (`backend/apps/api/src/domains/connections/clients/BlueBubblesClient.ts`)
   - Extends `BaseClient` to communicate with BlueBubbles REST API
   - Implements password-based authentication (not OAuth)
   - Handles message and chat synchronization

2. **Provider Configuration**
   - Provider ID: `019e8a1b-5c2d-7f3e-a1b4-c9d8e7f6a5b4`
   - Registered in `backend/apps/api/config/default.json`
   - TypeScript schema in `backend/apps/api/src/configuration.ts`

3. **Database Migration**
   - Migration file: `backend/apps/api/db/postgres/migrations/20260219194949_add_bluebubbles_provider.sql`
   - Creates provider entry with three endpoints:
     - Messages: Incremental sync with 1-hour TTL
     - Chats: Full sync with 24-hour TTL
     - Media: Incremental sync with 1-hour TTL

## Setup

### Prerequisites

1. **BlueBubbles macOS Application**
   - Install BlueBubbles on a macOS device with iMessage access
   - Configure the BlueBubbles server to expose the REST API
   - Note the server URL and password

2. **Environment Variables**
   Add the following to your `.env` file:
   ```bash
   BLUEBUBBLES_SERVER_URL=http://your-bluebubbles-server:1234
   BLUEBUBBLES_PASSWORD=your-password-here
   ```

### Installation

1. Run database migration:
   ```bash
   cd backend/apps/api
   yarn migrate
   ```

2. Restart the backend server to load the new provider

### Creating a Connection

To create a BlueBubbles connection for a user:

1. The connection should store:
   - `accessToken`: The BlueBubbles password
   - `syncState.serverUrl`: The BlueBubbles server URL (optional, falls back to env var)

2. Example connection creation:
   ```typescript
   const connection = await connectionService.create({
     userId: user.id,
     providerId: '019e8a1b-5c2d-7f3e-a1b4-c9d8e7f6a5b4', // BlueBubbles provider ID
     accessToken: 'your-bluebubbles-password',
     syncState: {
       serverUrl: 'http://your-bluebubbles-server:1234'
     },
     active: true,
     activeEndpoints: ['Messages', 'Chats']
   });
   ```

## API Details

### BlueBubbles REST API

The client communicates with the following BlueBubbles API endpoints:

- `GET /api/v1/server/info` - Server information and version
- `GET /api/v1/message/query?after={timestamp}&limit={limit}` - Query messages
- `GET /api/v1/chat` - List all chats

### Authentication

All requests include an `Authorization: Bearer {password}` header.

### Sync Process

1. **Messages Sync**
   - Fetches messages created after the last sync timestamp
   - Limits to 100 messages per sync
   - Updates `lastSync` timestamp in sync state

2. **Chats Sync**
   - Fetches all chat threads and participants
   - Provides conversation context for messages

## Data Model

### BlueBubbles Message
```typescript
interface BlueBubblesMessage {
  guid: string;                    // Unique message identifier
  text: string;                    // Message content
  dateCreated: number;             // Unix timestamp
  dateRead?: number;               // Unix timestamp
  handleId: string;                // Sender identifier
  isFromMe: boolean;               // Message direction
  chatGuid?: string;               // Associated chat
  associatedMessageGuid?: string;  // Reply/reaction reference
  threadOriginatorGuid?: string;   // Thread reference
}
```

### BlueBubbles Chat
```typescript
interface BlueBubblesChat {
  guid: string;              // Unique chat identifier
  displayName?: string;      // Chat name
  participants?: Array<{     // Chat participants
    address: string;
  }>;
}
```

### Sync State
```typescript
interface BlueBubblesSyncState {
  lastSync?: number;      // Last sync timestamp (Unix ms)
  messageCount?: number;  // Number of messages synced
  chatCount?: number;     // Number of chats synced
}
```

## Error Handling

The client implements comprehensive error handling:

1. **Configuration Errors**
   - Throws if server URL or password is missing
   - Validates configuration before making requests

2. **API Errors**
   - Logs failed requests with endpoint and status code
   - Returns failed sync responses with error messages
   - Does not throw exceptions to prevent sync interruption

3. **Network Errors**
   - Caught and logged with context
   - Returned as failed sync responses

## Differences from OAuth Clients

Unlike Google/Facebook/Microsoft clients, BlueBubbles:

1. Does not use OAuth flow
2. Does not support authorization URL generation
3. Does not support token exchange or refresh
4. Uses password-based authentication
5. Stores password in `accessToken` field
6. Throws errors for OAuth-related methods

## Future Enhancements

Potential improvements for this integration:

1. **Media Sync**: Implement attachment/media download and storage
2. **Webhooks**: Support real-time message notifications via BlueBubbles webhooks
3. **Message Actions**: Support sending messages through BlueBubbles
4. **Reactions**: Sync message reactions and tapbacks
5. **Read Receipts**: Track and sync message read status
6. **Group Management**: Support group chat operations

## References

- [BlueBubbles GitHub](https://github.com/BlueBubblesApp/bluebubbles-server)
- [BlueBubbles API Documentation](https://docs.bluebubbles.app/)
- [openclaw BlueBubbles Integration](https://github.com/openclaw/openclaw/tree/main/extensions/bluebubbles)

## Security Considerations

1. **Password Storage**: BlueBubbles password is stored as `accessToken` in the database
2. **Network Security**: Ensure BlueBubbles server uses HTTPS in production
3. **Access Control**: BlueBubbles server should be on a trusted network or secured with firewall rules
4. **Sensitive Data**: iMessage content is personal - ensure proper data handling and compliance

## Troubleshooting

### Common Issues

1. **Connection Failed**
   - Verify BlueBubbles server is running
   - Check server URL and port
   - Verify password is correct
   - Ensure network connectivity

2. **No Messages Synced**
   - Check `lastSync` timestamp in sync state
   - Verify messages exist after that timestamp
   - Check BlueBubbles server logs

3. **Authentication Errors**
   - Verify password in connection's `accessToken`
   - Check BlueBubbles server authentication settings

4. **Server Unreachable**
   - Verify server URL in sync state or environment variable
   - Check firewall and network settings
   - Ensure BlueBubbles server is accessible from backend
