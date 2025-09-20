# Events Table Debugging Guide

## Issues Found and Fixed

### 1. ❌ SQL ON CONFLICT Error
**Problem**: The `saveEventsToDatabase` method was using `ON CONFLICT (external_id, connection_id)` but the events table doesn't have a unique constraint on these columns.

**Fix**: Removed the `ON CONFLICT` clause and simplified to a basic `INSERT` statement.

**Location**: `ApiLogPostProcessorService.ts` line 346-365

### 2. ❌ Incorrect Import Path
**Problem**: The calendar parser import was using `@ci/domains/connections/utils/calendarParser` but should be relative after moving the service.

**Fix**: Changed to relative import `../utils/calendarParser`.

**Location**: `ApiLogPostProcessorService.ts` line 271

### 3. ❌ Google Calendar API Pagination Issues
**Problem**: Multiple issues with Google Calendar API pagination:
- Wrong time filter (only getting future events)
- Calling Gmail/Drive APIs on every pagination request
- No deduplication of events
- No pagination limits

**Fix**: 
- Fixed time filter to get events from 1 year ago to 1 year in the future
- Only call Gmail/Drive APIs on initial sync, not pagination
- Added deduplication logic to prevent duplicate events
- Added 10-page limit to prevent infinite loops
- Improved logging and error handling

**Location**: `GoogleClient.ts` and `ApiLogPostProcessorService.ts`

## Debugging Steps

### Step 1: Check API Logs
```bash
curl -X GET http://localhost:3000/api/data-ingestion/debug/latest-api-logs \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

This will show you:
- Recent API logs created
- Whether the sync response contains calendar data
- If the API log creation is working

### Step 2: Check Event Processing
```bash
curl -X POST http://localhost:3000/api/data-ingestion/process/API_LOG_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

Replace `API_LOG_ID` with an actual API log ID from step 1.

### Step 3: Check Database Directly
```sql
-- Check if API logs exist
SELECT id, created_at, user_id, connection_id 
FROM api_logs 
ORDER BY created_at DESC 
LIMIT 5;

-- Check if events exist
SELECT id, name, type, created_at, user_id, connection_id 
FROM events 
ORDER BY created_at DESC 
LIMIT 5;

-- Check for calendar events specifically
SELECT id, name, type, created_at, user_id, connection_id 
FROM events 
WHERE type = 'Calendar Event'
ORDER BY created_at DESC 
LIMIT 5;
```

### Step 4: Check Application Logs
Look for these log messages:
- `"Emitted API log created event for post-processing"`
- `"Received API log created event"`
- `"Processing calendar data from API result"`
- `"Parsed calendar events"`
- `"Saving event to database"`
- `"Successfully saved event to database"`

## Expected Flow

1. **Sync Request** → ConnectionService calls client.sync()
2. **API Log Creation** → DataIngestionService creates API log entry
3. **Event Emission** → `api-log.created` event is emitted
4. **Post-Processing** → ApiLogPostProcessorService processes the log
5. **Calendar Detection** → Checks if API result contains calendar data
6. **Event Parsing** → Parses calendar events using calendarParser
7. **Database Insert** → Saves events to events table
8. **Pagination Check** → If nextPageToken exists, triggers next page sync
9. **Next Page Sync** → CalendarPaginationService calls ConnectionService.syncWithToken()
10. **Repeat Process** → Steps 2-9 repeat until all pages are processed

## Pagination Flow Details

### Automatic Pagination
1. **First Sync** → User clicks "Sync Now"
2. **Events Processed** → Calendar events saved to database
3. **NextPageToken Detected** → System finds pagination token in API response
4. **Next Page Triggered** → `sync.next-page` event emitted
5. **Pagination Service** → CalendarPaginationService handles the event
6. **Direct Sync Call** → Calls ConnectionService.syncWithToken() with pagination token
7. **New API Log** → Creates new API log for next page
8. **Repeat** → Process continues until no more nextPageToken

### Key Log Messages for Pagination
- `"Found nextPageToken for pagination"` - Token detected in calendar data
- `"Received next page sync event"` - Pagination event received
- `"Triggering next page sync with ConnectionService"` - Starting next page sync
- `"Syncing with pagination token"` - ConnectionService processing pagination
- `"Pagination sync completed"` - Next page sync finished

## Common Issues

### No API Logs Created
- Check if sync endpoint is being called with `persistData = true`
- Verify DataIngestionService is properly injected
- Check database connection

### API Logs Created but No Events
- Check if sync response contains calendar data
- Verify `isCalendarApi()` method is detecting calendar APIs
- Check calendar parser is working correctly
- Verify database insert is not failing

### Events Created but Wrong Type
- Verify calendar parser is using "Calendar Event" type
- Check if events are being saved with correct type field

## Test Endpoints

- `GET /api/data-ingestion/debug/latest-api-logs` - Get recent API logs
- `GET /api/data-ingestion/debug/pagination-status/:connectionId` - Get pagination status for a connection
- `POST /api/data-ingestion/process/:apiLogId` - Manually process an API log
- `POST /api/data-ingestion/test` - Test data ingestion service
- `POST /api/data-ingestion/test-pagination` - Test pagination manually
- `POST /api/data-ingestion/health-check` - Health check

### Testing Pagination

To check pagination status:
```bash
curl -X GET http://localhost:3000/api/data-ingestion/debug/pagination-status/YOUR_CONNECTION_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

To test pagination manually:
```bash
curl -X POST http://localhost:3000/api/data-ingestion/test-pagination \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "connectionId": "your-connection-id",
    "nextPageToken": "your-next-page-token"
  }'
```

## Database Schema

### Events Table
```sql
CREATE TABLE events (
    id UUID PRIMARY KEY,
    type TEXT,
    name TEXT,
    description TEXT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    external_id TEXT,
    source_url TEXT,
    source_data JSONB,
    user_id UUID REFERENCES users(id),
    connection_id UUID REFERENCES connections(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### API Logs Table
```sql
CREATE TABLE api_logs (
    id UUID PRIMARY KEY,
    content TEXT NOT NULL,
    user_id UUID REFERENCES users(id),
    connection_id UUID REFERENCES connections(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
