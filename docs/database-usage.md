# Database Usage Guide

This document provides practical guidance on how to use the CI-Server database effectively, including usage patterns, best practices, and recommendations.

## Getting Started

### 1. User Setup
Start with user creation and authentication:
```typescript
// Create a new user
const user = await userService.createUser({
  name: "John Doe",
  email: "john@example.com",
  password: "hashedPassword",
  onboarded: false
});

// Create a session
const session = await sessionService.createSession({
  userId: user.id,
  token: "jwt-token",
  ip: "192.168.1.1",
  userAgent: "Mozilla/5.0...",
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
});
```

### 2. External Connections
Set up external data sources:
```typescript
// Add a provider
const provider = await providerService.createProvider({
  name: "Google Calendar"
});

// Create a connection
const connection = await connectionService.createConnection({
  userId: user.id,
  providerId: provider.id,
  name: "John's Google Calendar",
  accessToken: "oauth-access-token",
  refreshToken: "oauth-refresh-token",
  tokenExpiry: new Date(Date.now() + 3600 * 1000),
  active: true
});
```

## Core Usage Patterns

### Memory Management

#### Creating People and Contacts
```typescript
// Create a person
const person = await personService.createPerson({
  userId: user.id,
  firstName: "Jane",
  lastName: "Smith",
  email: "jane@example.com",
  type: "family"
});

// Link a contact to the person
const contact = await contactService.createContact({
  userId: user.id,
  personId: person.id,
  type: "email",
  identifier: "jane@example.com",
  handle: "jane.smith"
});
```

#### Managing Events and Content
```typescript
// Create an event
const event = await eventService.createEvent({
  userId: user.id,
  connectionId: connection.id,
  name: "Team Meeting",
  description: "Weekly team sync",
  startTime: new Date("2024-01-15T10:00:00Z"),
  endTime: new Date("2024-01-15T11:00:00Z"),
  type: "meeting"
});

// Add content to the event
const content = await contentService.createContent({
  userId: user.id,
  eventId: event.id,
  type: "document",
  title: "Meeting Notes",
  text: "Discussion points for the meeting...",
  mimetype: "text/markdown"
});
```

### Tagging System

#### Creating and Applying Tags
```typescript
// Create tags
const workTag = await tagService.createTag({
  userId: user.id,
  label: "work"
});

const importantTag = await tagService.createTag({
  userId: user.id,
  label: "important"
});

// Apply tags to entities
await tagService.tagEntity('event', event.id, [workTag.id, importantTag.id]);
await tagService.tagEntity('person', person.id, [workTag.id]);
```

### Conversations and AI Interactions

#### Creating Conversation Threads
```typescript
// Create a conversation thread
const thread = await threadService.createThread({
  userId: user.id,
  name: "Planning Discussion",
  model: "gemma3:1b",
  description: "Discussion about upcoming project planning"
});

// Add files to the thread
await threadService.addFiles(thread.id, [file1.id, file2.id]);

// Create messages
const userMessage = await messageService.createMessage({
  userId: user.id,
  threadId: thread.id,
  role: "user",
  text: "Can you help me plan the project timeline?",
  prompt: true,
  canceled: false
});

const aiResponse = await messageService.createMessage({
  userId: user.id,
  threadId: thread.id,
  role: "assistant",
  text: "I'd be happy to help with project planning...",
  promptMessageId: userMessage.id,
  prompt: false,
  canceled: false
});
```

#### Managing Actions
```typescript
// Create an action from AI conversation
const action = await actionService.createAction({
  userId: user.id,
  threadId: thread.id,
  title: "Create Project Timeline",
  text: "Based on our conversation, create a detailed project timeline",
  imageUrl: "https://example.com/timeline-image.png"
});

// Tag the action
await tagService.tagEntity('action', action.id, [workTag.id]);
```

### Intelligence System

#### Questions and Answers
```typescript
// Create a question
const question = await questionService.createQuestion({
  userId: user.id,
  category: "preferences",
  subcategory: "food",
  text: "What is your favorite cuisine?",
  exampleAnswer1: "Italian",
  exampleAnswer2: "Asian",
  exampleAnswer3: "Mexican"
});

// Provide an answer
const answer = await answerService.createAnswer({
  userId: user.id,
  questionId: question.id,
  ragAnswer1: "Based on your history, you seem to prefer Italian food",
  ragAnswer2: "Your location data suggests local Italian restaurants",
  ragAnswer3: "Your calendar shows frequent Italian restaurant visits",
  giveAnswer1: "Italian",
  giveAnswer2: "I love pasta and pizza",
  giveAnswer3: "Especially authentic Italian cuisine"
});
```

### File Management

```typescript
// Upload and manage files
const file = await fileService.createFile({
  userId: user.id,
  bucket: "user-uploads",
  key: "unique-file-id",
  originalName: "document.pdf",
  contentType: "application/pdf",
  size: 1024000
});

// Attach files to threads
await threadService.addFiles(thread.id, [file.id]);
```

### Vector Search and Embeddings

```typescript
// Create embeddings for content
const embedding = await embeddingService.createEmbedding({
  userId: user.id,
  model: "nomic-embed-text",
  rawInput: content.text,
  rawInputHash: hash(content.text),
  entityType: "content",
  entityId: content.id,
  dataPath: "text",
  embeddingVector: [0.1, 0.2, 0.3, ...] // Vector from embedding model
});

// Search for similar content
const similarContent = await embeddingService.search({
  userId: user.id,
  query: "project planning",
  limit: 10,
  threshold: 0.8
});
```

## Best Practices

### 1. Data Organization
- **Use consistent tagging**: Apply tags systematically across related entities
- **Leverage hierarchical places**: Use parent-child relationships for location organization
- **Link related entities**: Connect events with people, content, and things appropriately

### 2. Performance Optimization
- **Batch operations**: Group related database operations together
- **Use indexes effectively**: Query by indexed fields (user_id, created_at, etc.)
- **Leverage TimescaleDB**: For time-series data, use the optimized api_logs table
- **Optimize embeddings**: Cache embedding results and reuse when possible

### 3. Data Integrity
- **Validate relationships**: Ensure foreign key constraints are respected
- **Handle soft deletes**: Check for deleted_at when querying threads and messages
- **Maintain audit trails**: Always preserve created_at and updated_at timestamps
- **Sync external data**: Keep external_id and source_data updated for data provenance

### 4. Security Considerations
- **User isolation**: Always filter by user_id in queries
- **Token management**: Properly handle OAuth token refresh cycles
- **Sensitive data**: Use JSONB source_data carefully for external API responses
- **Access control**: Implement proper authorization checks before database operations

## Common Query Patterns

### Finding User's Recent Activity
```sql
-- Recent events for a user
SELECT * FROM events 
WHERE user_id = $1 
ORDER BY created_at DESC 
LIMIT 20;

-- Recent conversations
SELECT t.*, COUNT(m.id) as message_count
FROM threads t
LEFT JOIN messages m ON t.id = m.thread_id
WHERE t.user_id = $1 AND t.deleted_at IS NULL
GROUP BY t.id
ORDER BY t.updated_at DESC;
```

### Content Discovery
```sql
-- Find tagged content
SELECT c.* FROM content c
JOIN content_tag ct ON c.id = ct.content_id
JOIN tags t ON ct.tag_id = t.id
WHERE c.user_id = $1 AND t.label = $2;

-- Find content by type
SELECT * FROM content 
WHERE user_id = $1 AND type = $2 
ORDER BY created_at DESC;
```

### Relationship Queries
```sql
-- Find people at events
SELECT p.*, e.name as event_name
FROM people p
JOIN event_person ep ON p.id = ep.person_id
JOIN events e ON ep.event_id = e.id
WHERE p.user_id = $1;

-- Find files used in conversations
SELECT f.*, t.name as thread_name
FROM files f
JOIN thread_file tf ON f.id = tf.file_id
JOIN threads t ON tf.thread_id = t.id
WHERE f.user_id = $1;
```

## Troubleshooting

### Common Issues

1. **Orphaned Records**: Always verify foreign key relationships before deletion
2. **Performance Issues**: Check query execution plans and add indexes as needed
3. **Data Sync Problems**: Monitor api_logs for failed external API synchronization
4. **Embedding Consistency**: Ensure embedding vectors match the specified model
5. **Token Expiry**: Implement proper OAuth token refresh mechanisms

### Monitoring Queries

```sql
-- Check database health
SELECT schemaname, tablename, n_tup_ins, n_tup_upd, n_tup_del 
FROM pg_stat_user_tables 
ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC;

-- Monitor api_logs volume
SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as log_count
FROM api_logs 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour 
ORDER BY hour;
```

This database design supports a sophisticated personal AI assistant with comprehensive memory management, intelligent search, conversation tracking, and external data integration capabilities.