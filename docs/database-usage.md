# Database Usage Guide

This document provides practical guidance on how to use the CI-Server database effectively, including usage patterns, best practices, and recommendations.

*Last updated: Generated from current codebase analysis on October 9, 2024*

## Getting Started

### 1. User Setup and Onboarding
Start with user creation and authentication flow:

```typescript
// Create a new user
const user = await userService.createUser({
  name: "John Doe",
  email: "john@example.com", 
  password: "hashedPassword",
  onboarded: false // User needs to complete onboarding
});

// Create authentication session
const session = await sessionService.createSession({
  userId: user.id,
  token: "jwt-token-here",
  ip: "192.168.1.100",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
});

// Mark user as onboarded after setup completion
await userService.updateUser(user.id, { onboarded: true });
```

### 2. External Service Integration
Set up connections to external data sources:

```typescript
// Create a provider (if not exists)
const provider = await providerService.createProvider({
  name: "Google Calendar"
});

// Establish user connection with OAuth2
const connection = await connectionService.createConnection({
  userId: user.id,
  providerId: provider.id,
  name: "John's Google Calendar",
  accessToken: "oauth2-access-token",
  refreshToken: "oauth2-refresh-token", 
  tokenExpiry: new Date(Date.now() + 3600 * 1000), // 1 hour
  active: true,
  syncState: { lastSync: null, status: "pending" }
});
```

## Core Usage Patterns

### Memory Management

#### Managing People and Personal Contacts
```typescript
// Create a person entity
const person = await personService.createPerson({
  userId: user.id,
  type: "family",
  firstName: "Jane",
  lastName: "Smith", 
  gender: "female",
  city: "San Francisco",
  region: "CA",
  country: "USA",
  avatarUrl: "https://example.com/avatar.jpg",
  externalId: "google-contact-123", // From external source
  sourceUrl: "https://contacts.google.com/person/123",
  sourceData: { /* raw contact data from Google */ }
});

// Create associated contact information
const emailContact = await contactService.createContact({
  userId: user.id,
  personId: person.id,
  type: "email",
  identifier: "jane.smith@example.com",
  handle: "jane.smith"
});

const phoneContact = await contactService.createContact({
  userId: user.id, 
  personId: person.id,
  type: "phone",
  identifier: "+1-555-123-4567",
  handle: "primary"
});
```

#### Location and Place Management
```typescript
// Create a hierarchical place structure
const country = await placeService.createPlace({
  userId: user.id,
  type: "country",
  name: "United States",
  geoFormat: "country_code",
  geolocation: { country: "US" }
});

const city = await placeService.createPlace({
  userId: user.id,
  parentId: country.id, // Hierarchical relationship
  type: "city", 
  name: "San Francisco",
  geoFormat: "lat_lng",
  geolocation: { lat: 37.7749, lng: -122.4194 },
  locationBoundary: { /* GeoJSON polygon */ }
});

// Record timestamped location data
const location = await locationService.createLocation({
  userId: user.id,
  placeId: city.id,
  identifier: "phone-gps-001",
  datetime: new Date(),
  geoFormat: "lat_lng",
  geolocation: { lat: 37.7849, lng: -122.4094, accuracy: 10 },
  estimated: false,
  tracked: true,
  uploaded: true
});
```

#### Event and Content Management
```typescript
// Create a calendar event
const event = await eventService.createEvent({
  userId: user.id,
  connectionId: connection.id, // Imported from external source
  type: "meeting",
  name: "Team Weekly Sync",
  description: "Weekly team synchronization meeting",
  startTime: new Date("2024-01-15T10:00:00Z"),
  endTime: new Date("2024-01-15T11:00:00Z"),
  externalId: "google-calendar-event-456",
  sourceUrl: "https://calendar.google.com/event/456"
});

// Associate people with the event
await eventService.addPersonToEvent(event.id, person.id);

// Add content related to the event
const meetingNotes = await contentService.createContent({
  userId: user.id,
  eventId: event.id,
  type: "document",
  title: "Weekly Sync - Meeting Notes",
  text: `
    ## Agenda
    1. Project updates
    2. Blockers discussion
    3. Next week planning
    
    ## Action Items
    - Review design proposals
    - Update project timeline
  `,
  mimetype: "text/markdown",
  url: "https://docs.example.com/meeting-notes-123"
});

// Track physical items for the event
const presentation = await thingService.createThing({
  userId: user.id,
  eventId: event.id,
  type: "document",
  name: "Q1 Presentation Slides",
  description: "Quarterly business review presentation"
});
```

### Tagging and Organization

#### Universal Tagging System
```typescript
// Create semantic tags
const workTag = await tagService.createTag({
  userId: user.id,
  label: "work" // Automatically normalized to lowercase
});

const urgentTag = await tagService.createTag({
  userId: user.id,
  label: "urgent"
});

const familyTag = await tagService.createTag({
  userId: user.id,
  label: "family"
});

// Apply tags across different entity types
await tagService.tagEntity('person', person.id, [workTag.id, familyTag.id]);
await tagService.tagEntity('event', event.id, [workTag.id, urgentTag.id]);
await tagService.tagEntity('content', meetingNotes.id, [workTag.id]);
await tagService.tagEntity('action', actionId, [urgentTag.id]);

// Query entities by tags
const workRelatedPeople = await tagService.getEntitiesByTag('person', workTag.id, user.id);
const urgentItems = await tagService.getEntitiesByTag('all', urgentTag.id, user.id);
```

### AI-Powered Conversations

#### Managing Conversation Threads
```typescript
// Create a conversation thread
const thread = await threadService.createThread({
  userId: user.id,
  name: "Project Planning Discussion",
  model: "gemma3:1b", // AI model identifier
  description: "Discussion about Q1 project timeline and resource planning"
});

// Attach relevant files to the conversation
const projectDoc = await fileService.createFile({
  userId: user.id,
  bucket: "user-documents",
  key: uuid(),
  originalName: "project-requirements.pdf",
  contentType: "application/pdf",
  size: 2048000
});

await threadService.addFiles(thread.id, [projectDoc.id]);

// Create conversation flow
const userPrompt = await messageService.createMessage({
  userId: user.id,
  threadId: thread.id,
  role: "user",
  text: "Based on the attached requirements document, can you help me create a realistic timeline for Q1?",
  mimetype: "text/plain",
  prompt: true,
  canceled: false
});

const aiResponse = await messageService.createMessage({
  userId: user.id,
  threadId: thread.id,
  role: "assistant", 
  text: "I'll analyze the requirements document and create a timeline. Based on the scope...",
  promptMessageId: userPrompt.id, // Link response to prompt
  toolCalls: [
    {
      function: "analyze_document",
      parameters: { documentId: projectDoc.id },
      result: "Document analysis completed"
    }
  ],
  prompt: false,
  canceled: false
});
```

#### Action Generation and Tracking
```typescript
// Generate actionable items from conversations
const action = await actionService.createAction({
  userId: user.id,
  threadId: thread.id,
  title: "Create Detailed Project Timeline",
  text: `Based on our conversation, create a week-by-week timeline including:
    - Development phases
    - Testing milestones  
    - Resource allocation
    - Risk mitigation points`,
  imageUrl: "https://generated-diagrams.example.com/timeline-123.png"
});

// Tag actions for organization
await tagService.tagEntity('action', action.id, [workTag.id, urgentTag.id]);
```

### Intelligence and Learning System

#### Question-Answer Knowledge Base
```typescript
// Define learning questions
const preferenceQuestion = await questionService.createQuestion({
  userId: user.id,
  category: "preferences",
  subcategory: "work_style",
  text: "What is your preferred method for project communication?",
  exampleAnswer1: "Daily stand-up meetings",
  exampleAnswer2: "Slack updates with weekly reviews", 
  exampleAnswer3: "Email summaries with monthly check-ins"
});

// Collect user responses with AI assistance
const answer = await answerService.createAnswer({
  userId: user.id,
  questionId: preferenceQuestion.id,
  ragAnswer1: "Based on your calendar patterns, you seem to prefer structured meetings",
  ragAnswer2: "Your message history suggests you like written communication",
  ragAnswer3: "Previous project data indicates you prefer weekly sync cycles",
  giveAnswer1: "I prefer a hybrid approach with daily Slack updates and weekly video calls",
  giveAnswer2: "This keeps everyone aligned without too many interruptions",
  giveAnswer3: "Important decisions should still be discussed in person or video"
});
```

### File Management and Attachments

```typescript
// Upload and manage files
const uploadedFile = await fileService.createFile({
  userId: user.id,
  bucket: "user-uploads",
  key: uuid(),
  originalName: "project-brainstorm.md",
  contentType: "text/markdown", 
  size: 15000
});

// Associate files with multiple entities
await threadService.addFiles(thread.id, [uploadedFile.id]);
await contentService.linkFileToContent(meetingNotes.id, uploadedFile.id);
```

### Vector Search and AI Discovery

```typescript
// Generate embeddings for semantic search
const embedding = await embeddingService.createEmbedding({
  userId: user.id,
  model: "nomic-embed-text",
  rawInput: meetingNotes.text,
  rawInputHash: createHash('sha256').update(meetingNotes.text).digest('hex'),
  entityType: "content",
  entityId: meetingNotes.id,
  dataPath: "text",
  embeddingVector: await generateEmbedding(meetingNotes.text) // Array of floats
});

// Perform semantic search across all content
const similarContent = await embeddingService.searchSimilar({
  userId: user.id,
  query: "project timeline and resource planning",
  entityTypes: ["content", "action", "message"],
  limit: 10,
  similarityThreshold: 0.75
});

// Find related entities by embedding similarity
const relatedDiscussions = await embeddingService.findRelated({
  userId: user.id,
  entityType: "content",
  entityId: meetingNotes.id,
  limit: 5
});
```

### External Data Synchronization

```typescript
// Log API interactions for monitoring
await apiLogService.createLog({
  userId: user.id,
  connectionId: connection.id,
  scope: "calendar.readonly",
  content: {
    request: { method: "GET", url: "/calendar/events", params: {} },
    response: { status: 200, events: [/* event data */] },
    processingTime: 450
  }
});

// Update sync state after successful synchronization
await connectionService.updateSyncState(connection.id, {
  lastSync: new Date(),
  status: "completed",
  itemsProcessed: 25,
  errors: []
});

// Mark API logs as processed
await apiLogService.markProcessed(apiLogId, new Date());
```

## Best Practices

### 1. Data Organization and Relationships
- **Consistent Entity Linking**: Always link related entities (events→people, content→events, actions→threads)
- **Hierarchical Places**: Use parent-child relationships for geographical organization
- **Semantic Tagging**: Apply tags consistently across related entities for cross-domain discovery
- **Source Attribution**: Always populate external_id, source_url, and source_data for external content

### 2. Performance Optimization Strategies
- **User-Scoped Queries**: Always filter by user_id in the WHERE clause for security and performance
- **Batch Operations**: Group related database operations using transactions
- **Index-Friendly Queries**: Query by indexed fields (user_id, created_at, external_id, type)
- **Time-Range Filtering**: Use created_at and updated_at ranges for large dataset queries
- **Embedding Caching**: Cache embedding results and reuse for identical content

### 3. Search and Discovery
- **Multi-Modal Search**: Combine vector search with traditional filtering (tags, types, dates)
- **Progressive Enhancement**: Start with simple queries and add AI-powered search as needed
- **Content Preprocessing**: Clean and normalize text before generating embeddings
- **Similarity Thresholds**: Tune similarity thresholds based on content types and user feedback

### 4. Data Integrity and Consistency
- **Foreign Key Respect**: Always validate relationships before creating entities
- **Soft Delete Awareness**: Check for deleted_at when querying threads and messages
- **Timestamp Preservation**: Never manually modify created_at and updated_at fields
- **External Sync Integrity**: Keep external_id and source_data synchronized with external sources
- **Transaction Boundaries**: Use database transactions for multi-entity operations

### 5. Security and Privacy
- **User Data Isolation**: Implement strict user_id filtering in all queries and operations
- **Token Management**: Implement automatic OAuth token refresh with proper error handling
- **JSONB Sanitization**: Validate and sanitize content stored in JSONB columns
- **Access Control**: Implement authorization checks before any database operations
- **Audit Trail Maintenance**: Preserve all timestamp and relationship data for audit purposes

## Common Query Patterns

### User Activity and Engagement
```sql
-- Recent user activity across all domains
SELECT 'event' as type, name as title, created_at FROM events WHERE user_id = $1
UNION ALL
SELECT 'content' as type, title, created_at FROM content WHERE user_id = $1  
UNION ALL
SELECT 'action' as type, title, created_at FROM actions WHERE user_id = $1
ORDER BY created_at DESC LIMIT 20;

-- Conversation activity with message counts
SELECT t.name, t.model, COUNT(m.id) as message_count, 
       MAX(m.created_at) as last_activity
FROM threads t
LEFT JOIN messages m ON t.id = m.thread_id AND m.deleted_at IS NULL
WHERE t.user_id = $1 AND t.deleted_at IS NULL
GROUP BY t.id, t.name, t.model
ORDER BY last_activity DESC;
```

### Content Discovery and Organization
```sql
-- Find content by multiple tags
SELECT c.* FROM content c
JOIN content_tag ct ON c.id = ct.content_id
JOIN tags t ON ct.tag_id = t.id  
WHERE c.user_id = $1 AND t.label IN ('work', 'urgent')
GROUP BY c.id
HAVING COUNT(DISTINCT t.label) = 2; -- Must have both tags

-- Timeline view of related entities
SELECT entity_type, entity_id, entity_title, event_date
FROM (
  SELECT 'event' as entity_type, id as entity_id, name as entity_title, start_time as event_date
  FROM events WHERE user_id = $1
  UNION ALL
  SELECT 'content' as entity_type, id as entity_id, title as entity_title, created_at as event_date  
  FROM content WHERE user_id = $1
) combined
ORDER BY event_date DESC;
```

### Relationship Analysis
```sql
-- People interaction frequency
SELECT p.first_name, p.last_name, COUNT(ep.event_id) as event_count,
       MAX(e.start_time) as last_interaction
FROM people p
JOIN event_person ep ON p.id = ep.person_id
JOIN events e ON ep.event_id = e.id
WHERE p.user_id = $1
GROUP BY p.id, p.first_name, p.last_name
ORDER BY event_count DESC, last_interaction DESC;

-- Content-thread relationship analysis
SELECT f.original_name, COUNT(tf.thread_id) as thread_count,
       ARRAY_AGG(t.name) as thread_names
FROM files f
JOIN thread_file tf ON f.id = tf.file_id
JOIN threads t ON tf.thread_id = t.id
WHERE f.user_id = $1 AND t.deleted_at IS NULL
GROUP BY f.id, f.original_name
ORDER BY thread_count DESC;
```

### External Integration Monitoring
```sql
-- Connection health and sync status
SELECT c.name, c.active, p.name as provider,
       c.token_expiry, c.sync_state->>'status' as sync_status,
       COUNT(al.id) as api_call_count
FROM connections c
JOIN providers p ON c.provider_id = p.id
LEFT JOIN api_logs al ON c.id = al.connection_id 
  AND al.created_at > NOW() - INTERVAL '24 hours'
WHERE c.user_id = $1
GROUP BY c.id, c.name, c.active, p.name, c.token_expiry, c.sync_state
ORDER BY api_call_count DESC;

-- API performance monitoring
SELECT DATE_TRUNC('hour', created_at) as hour,
       scope, COUNT(*) as call_count,
       AVG((content->>'processingTime')::int) as avg_processing_time
FROM api_logs 
WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
GROUP BY hour, scope
ORDER BY hour DESC, call_count DESC;
```

## Troubleshooting and Monitoring

### Common Issues and Solutions

1. **Orphaned Relationships**: 
   - Symptom: Foreign key constraint violations
   - Solution: Verify entity existence before creating relationships
   - Prevention: Use transactions for multi-entity operations

2. **Performance Degradation**:
   - Symptom: Slow queries on large datasets  
   - Solution: Add appropriate indexes, use time-range filtering
   - Prevention: Monitor query execution plans and add indexes proactively

3. **External Sync Failures**:
   - Symptom: Stale or missing external data
   - Solution: Check API logs for errors, refresh OAuth tokens
   - Prevention: Implement robust error handling and retry logic

4. **Embedding Inconsistencies**:
   - Symptom: Poor search relevance or missing results
   - Solution: Regenerate embeddings with consistent models
   - Prevention: Version embedding models and migrate systematically

5. **Memory Usage Issues**:
   - Symptom: Large result sets causing application slowdowns
   - Solution: Implement pagination and limit result sizes
   - Prevention: Use LIMIT clauses and streaming for large datasets

### Health Check Queries

```sql
-- Database table health
SELECT schemaname, tablename, n_tup_ins, n_tup_upd, n_tup_del,
       n_tup_ins + n_tup_upd + n_tup_del as total_activity
FROM pg_stat_user_tables 
WHERE schemaname = 'public'
ORDER BY total_activity DESC;

-- User data distribution
SELECT user_id, 
       COUNT(*) FILTER (WHERE table_name = 'events') as events,
       COUNT(*) FILTER (WHERE table_name = 'content') as content,
       COUNT(*) FILTER (WHERE table_name = 'people') as people,
       COUNT(*) FILTER (WHERE table_name = 'messages') as messages
FROM (
  SELECT user_id, 'events' as table_name FROM events
  UNION ALL SELECT user_id, 'content' FROM content  
  UNION ALL SELECT user_id, 'people' FROM people
  UNION ALL SELECT user_id, 'messages' FROM messages
) combined
GROUP BY user_id
ORDER BY events + content + people + messages DESC;

-- TimescaleDB hypertable status
SELECT hypertable_name, num_chunks, compressed_chunks, 
       uncompressed_heap_size, compressed_heap_size
FROM timescaledb_information.hypertables h
LEFT JOIN timescaledb_information.chunks c ON h.hypertable_name = c.hypertable_name;
```

This comprehensive database design supports a sophisticated personal AI assistant with memory management, intelligent search, conversation tracking, external data integration, and scalable background processing capabilities.