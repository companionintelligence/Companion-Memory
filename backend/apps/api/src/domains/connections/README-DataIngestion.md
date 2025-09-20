# Data Ingestion Abstraction Layer

This document describes the new data ingestion abstraction layer that provides maximum visibility and error handling for syncing data into the PostgreSQL database.

## Overview

The new abstraction layer consists of:

1. **DataIngestionService** - Core service for processing sync data
2. **DataIngestionController** - API endpoint for receiving sync data
3. **Updated ConnectionService** - Now uses the new abstraction

## Architecture

```
Sync Data Flow:
ConnectionService.sync() 
  → Client.sync() (Google/Microsoft/etc.)
  → DataIngestionService.ingestSyncData()
  → PostgreSQL (api_logs, events tables)
```

## Key Features

### Maximum Visibility
- Comprehensive logging at every step
- Detailed error tracking with context
- Request ID tracking for debugging
- Success/failure metrics

### Error Handling
- Individual error tracking for each operation
- Non-blocking error handling (sync continues even if ingestion fails)
- Detailed error messages with context
- Stack trace logging for debugging

### Data Processing
- **Single API Log Entry**: Stores the entire sync response as one entry in the api_logs table
- **Complete Response Capture**: No splitting or individual processing of API results
- **Simple and Reliable**: Straightforward approach that captures everything in one place
- **Transaction Safety**: Uses TypeORM repository for proper entity management

### API Log Transformation
- **Entity to Object Transformation**: Uses `ApiLogEntity.toApiLog()` method for proper object transformation
- **Repository Integration**: Uses TypeORM repository for proper entity management
- **Full Object Visibility**: Returns complete `ApiLog` objects with user and connection details
- **Complete Response Storage**: Stores the entire sync response in a single, well-structured entry
- **Retrieval Capabilities**: Can fetch and transform existing API logs
- **Raw Data Support**: Includes utility method for transforming raw database rows

## API Endpoints

### POST /api/data-ingestion/sync

Ingests sync data into the database.

**Request Body:**
```json
{
  "connectionId": "uuid",
  "syncResponse": {
    "success": true,
    "message": "Sync completed successfully",
    "data": {
      "results": [
        {
          "api": "Google Calendar",
          "data": { /* calendar data */ },
          "error": "optional error message"
        }
      ],
      "errors": ["any sync errors"]
    }
  }
}
```

**Note:** The `syncResponse` follows the `SyncResponse` interface from the connections domain, ensuring type consistency across the application.

**Response:**
```json
{
  "success": true,
  "message": "Successfully ingested sync data: 1 API log created",
  "details": {
    "apiLogsCreated": 1,
    "errors": [],
    "createdApiLogs": [
      {
        "id": "api-log-uuid",
        "content": "{\"syncResponse\": {...}, \"timestamp\": \"2024-01-01T00:00:00.000Z\", \"metadata\": {\"type\": \"complete_sync_response\"}}",
        "user": {
          "id": "user-uuid",
          "name": "John Doe",
          "email": "john@example.com"
        },
        "connection": {
          "id": "connection-uuid",
          "name": "My Google Connection",
          "active": true,
          "provider": {...}
        },
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "requestId": "uuid",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### GET /api/data-ingestion/connections/:connectionId/api-logs

Retrieves API logs for a specific connection, transformed to ApiLog objects.

**Query Parameters:**
- `limit` (optional): Number of logs to retrieve (default: 50)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "api-log-uuid",
      "content": "{\"syncResponse\": {...}}",
      "user": {
        "id": "user-uuid",
        "name": "John Doe",
        "email": "john@example.com"
      },
      "connection": {
        "id": "connection-uuid",
        "name": "My Google Connection",
        "active": true,
        "provider": {...}
      },
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ],
  "count": 1,
  "requestId": "uuid",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### POST /api/data-ingestion/health-check

Checks the health of the data ingestion service.

**Response:**
```json
{
  "healthy": true,
  "message": "Database connection is healthy",
  "requestId": "uuid",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Usage Examples

### Direct Service Usage

```typescript
// In a service or controller
const result = await this.dataIngestionService.ingestSyncData({
  connectionId: 'connection-uuid',
  userId: 'user-uuid',
  syncResponse: {
    success: true,
    message: 'Sync completed',
    data: {
      results: [/* sync results */],
      errors: []
    }
  },
  requestContext: context
});

console.log(`Created ${result.details.apiLogsCreated} API log with complete sync response`);
console.log('Created API log:', result.details.createdApiLogs[0]);
```

### API Endpoint Usage

```typescript
// Frontend or external service
const response = await fetch('/api/data-ingestion/sync', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    connectionId: 'connection-uuid',
    syncResponse: syncData
  })
});

const result = await response.json();
if (result.success) {
  console.log('Data ingested successfully:', result.details);
  console.log('Created API log with complete sync response:', result.details.createdApiLogs[0]);
} else {
  console.error('Ingestion failed:', result.details.errors);
}
```

## Error Handling

The service provides detailed error information:

```typescript
{
  "success": false,
  "message": "Data ingestion completed with 1 error",
  "details": {
    "apiLogsCreated": 0,
    "errors": [
      {
        "type": "api_log",
        "message": "Failed to create API log: Database connection error",
        "data": {
          "connectionId": "connection-uuid",
          "userId": "user-uuid"
        }
      }
    ],
    "createdApiLogs": []
  }
}
```

## Logging

The service provides comprehensive logging:

- **Info**: Normal operations, data counts, success messages
- **Warn**: Non-critical errors, partial failures
- **Error**: Critical errors, database failures, exceptions

All logs include:
- Connection ID
- User ID
- Request ID
- Timestamp
- Relevant context data

## Migration from Old System

The old direct database insertion code has been removed from `ConnectionService`. The new system:

1. **Maintains backward compatibility** - existing sync endpoints work unchanged
2. **Provides better error handling** - errors are logged but don't break the sync
3. **Offers more visibility** - detailed logging and metrics
4. **Enables external usage** - can be called via API endpoint

## Future Enhancements

The abstraction layer is designed to be extensible:

- Additional data types (contacts, files, etc.)
- Batch processing capabilities
- Retry mechanisms
- Data validation and transformation
- Metrics and monitoring integration
