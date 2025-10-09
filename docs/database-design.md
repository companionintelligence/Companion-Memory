# Database Design

This document provides detailed technical specifications for the CI-Server PostgreSQL database design, including entity definitions, data types, constraints, and implementation details.

*Last updated: Generated from current codebase analysis on October 9, 2024*

## Entity Specifications

### Data Types and Constraints

#### Primary Keys
- **UUID**: Most entities use UUID primary keys for distributed scalability and collision resistance
- **VARCHAR**: Questions and answers use string IDs for flexible identification
- **BIGINT**: Join tables use auto-incrementing BIGINT IDs for performance

#### Common Columns
Most entities include:
- `created_at` (TIMESTAMPTZ): Record creation timestamp with timezone awareness
- `updated_at` (TIMESTAMPTZ): Last modification timestamp for change tracking
- `user_id` (UUID): Owner reference to users table for data isolation

#### Special Data Types
- **JSONB**: Used for flexible data storage (source_data, geolocation, tool_calls, sync_state)
- **TIMESTAMPTZ**: Timezone-aware timestamps for global application support
- **TEXT**: Variable-length text fields with unlimited size
- **BOOLEAN**: True/false flags for status and configuration
- **BIGINT**: Large integer values (file sizes, counters)

#### TimescaleDB Integration
The `api_logs` table is implemented as a TimescaleDB hypertable:
- Partitioned by `created_at` timestamp for time-series optimization
- Hash partitioned by `user_id` for parallel processing and user isolation
- Composite primary key: (id, created_at, user_id) for optimal partitioning
- Specialized indexes for time-based queries and JSONB content search

#### Soft Deletes
Some entities support soft deletion for data preservation:
- `threads.deleted_at` - Conversation thread soft deletion
- `messages.deleted_at` - Message soft deletion with cascade considerations

## Detailed Entity Definitions

### User Domain

#### users
```sql
CREATE TABLE users (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    email VARCHAR UNIQUE NOT NULL,
    password VARCHAR NOT NULL,
    onboarded BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_onboarded ON users(onboarded);
```

#### signup_code
```sql
CREATE TABLE signup_code (
    id VARCHAR PRIMARY KEY,
    signup_code VARCHAR UNIQUE NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_signup_code_code ON signup_code(signup_code);
CREATE INDEX idx_signup_code_used ON signup_code(used);
```

#### sessions
```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    token TEXT NOT NULL,
    ip TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_sessions_token ON sessions(token);
```

### Memory Domain

#### people
```sql
CREATE TABLE people (
    id UUID PRIMARY KEY,
    type TEXT,
    first_name TEXT,
    last_name TEXT,
    gender TEXT,
    address TEXT,
    street_address TEXT,
    street_address_2 TEXT,
    city TEXT,
    region TEXT,
    country TEXT,
    postal_code TEXT,
    avatar_url TEXT,
    external_id TEXT,
    source_url TEXT,
    source_data JSONB,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_people_user_id ON people(user_id);
CREATE INDEX idx_people_external_id ON people(external_id);
CREATE INDEX idx_people_type ON people(type);
CREATE INDEX idx_people_name ON people(first_name, last_name);
```

#### events
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
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_events_user_id ON events(user_id);
CREATE INDEX idx_events_connection_id ON events(connection_id);
CREATE INDEX idx_events_start_time ON events(start_time);
CREATE INDEX idx_events_external_id ON events(external_id);
CREATE INDEX idx_events_type ON events(type);
```

#### places
```sql
CREATE TABLE places (
    id UUID PRIMARY KEY,
    type TEXT,
    name TEXT,
    geo_format TEXT,
    geolocation JSONB,
    location_boundary JSONB,
    estimated BOOLEAN,
    tracked BOOLEAN,
    uploaded BOOLEAN,
    parent_id UUID REFERENCES places(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_places_user_id ON places(user_id);
CREATE INDEX idx_places_parent_id ON places(parent_id);
CREATE GIN INDEX idx_places_geolocation ON places USING GIN (geolocation);
```

### Intelligence Domain

#### questions
```sql
CREATE TABLE questions (
    id VARCHAR PRIMARY KEY,
    category VARCHAR NOT NULL,
    text VARCHAR NOT NULL,
    example_answer_1 VARCHAR NOT NULL,
    example_answer_2 VARCHAR NOT NULL,
    example_answer_3 VARCHAR NOT NULL,
    subcategory VARCHAR NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_questions_user_id ON questions(user_id);
CREATE INDEX idx_questions_category ON questions(category);
CREATE INDEX idx_questions_subcategory ON questions(subcategory);
```

#### actions
```sql
CREATE TABLE actions (
    id UUID PRIMARY KEY,
    title TEXT,
    text TEXT,
    image_url TEXT,
    thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_actions_user_id ON actions(user_id);
CREATE INDEX idx_actions_thread_id ON actions(thread_id);
```

### Conversations Domain

#### threads
```sql
CREATE TABLE threads (
    id UUID PRIMARY KEY,
    name TEXT,
    model TEXT,
    description TEXT,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_threads_user_id ON threads(user_id);
CREATE INDEX idx_threads_deleted_at ON threads(deleted_at);
CREATE INDEX idx_threads_model ON threads(model);
```

#### messages
```sql
CREATE TABLE messages (
    id UUID PRIMARY KEY,
    model TEXT,
    role TEXT,
    text TEXT,
    mimetype TEXT,
    tool_calls JSONB,
    prompt BOOLEAN NOT NULL,
    canceled BOOLEAN NOT NULL DEFAULT FALSE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    thread_id UUID REFERENCES threads(id) ON DELETE CASCADE,
    prompt_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_messages_prompt_message_id ON messages(prompt_message_id);
CREATE INDEX idx_messages_role ON messages(role);
CREATE INDEX idx_messages_deleted_at ON messages(deleted_at);
CREATE GIN INDEX idx_messages_tool_calls ON messages USING GIN (tool_calls);
```

### Connections Domain

#### providers
```sql
CREATE TABLE providers (
    id UUID PRIMARY KEY,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_providers_name ON providers(name);
```

#### connections
```sql
CREATE TABLE connections (
    id UUID PRIMARY KEY,
    name TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    schedule TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expiry TIMESTAMPTZ,
    sync_state JSONB,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    provider_id UUID REFERENCES providers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_connections_user_id ON connections(user_id);
CREATE INDEX idx_connections_provider_id ON connections(provider_id);
CREATE INDEX idx_connections_active ON connections(active);
CREATE INDEX idx_connections_token_expiry ON connections(token_expiry);
```

### Search Domain

#### tags
```sql
CREATE TABLE tags (
    id UUID PRIMARY KEY,
    label TEXT,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_tags_user_id ON tags(user_id);
CREATE INDEX idx_tags_label ON tags(label);
CREATE UNIQUE INDEX idx_tags_user_label ON tags(user_id, label);
```

#### embeddings
```sql
CREATE TABLE embeddings (
    id VARCHAR PRIMARY KEY,
    model VARCHAR NOT NULL,
    raw_input VARCHAR NOT NULL,
    raw_input_hash VARCHAR NOT NULL,
    entity_type VARCHAR NOT NULL,
    data_path VARCHAR NOT NULL,
    entity_id VARCHAR NOT NULL,
    embedding_vector TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_embeddings_user_id ON embeddings(user_id);
CREATE INDEX idx_embeddings_entity ON embeddings(entity_type, entity_id);
CREATE INDEX idx_embeddings_hash ON embeddings(raw_input_hash);
CREATE INDEX idx_embeddings_model ON embeddings(model);
```

### Files Domain

#### files
```sql
CREATE TABLE files (
    id UUID PRIMARY KEY,
    bucket TEXT NOT NULL,
    key UUID NOT NULL,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size BIGINT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_files_user_id ON files(user_id);
CREATE INDEX idx_files_content_type ON files(content_type);
CREATE INDEX idx_files_bucket_key ON files(bucket, key);
```

### ETL Domain

#### api_logs (TimescaleDB Hypertable)
```sql
CREATE TABLE api_logs (
    id UUID DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,
    scope TEXT,
    content JSONB,
    last_processed TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at, user_id)
);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('api_logs', 'created_at', 'user_id', 4);

-- Specialized indexes for hypertable
CREATE INDEX idx_api_logs_user_id ON api_logs(user_id, created_at DESC);
CREATE INDEX idx_api_logs_connection_id ON api_logs(connection_id, created_at DESC);
CREATE INDEX idx_api_logs_scope ON api_logs(scope);
CREATE INDEX idx_api_logs_last_processed ON api_logs(last_processed);
CREATE GIN INDEX idx_api_logs_content ON api_logs USING GIN (content);
```

## Join Tables for Many-to-Many Relationships

All many-to-many relationships use dedicated join tables with:
- Auto-incrementing BIGINT primary key for performance
- Foreign keys to both related entities with CASCADE constraints
- `created_at` timestamp for audit trails
- Composite unique constraints to prevent duplicates

### Tagging Join Tables

#### person_tag
```sql
CREATE TABLE person_tag (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_id UUID REFERENCES people(id) ON DELETE CASCADE NOT NULL,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(person_id, tag_id)
);

CREATE INDEX idx_person_tag_person_id ON person_tag(person_id);
CREATE INDEX idx_person_tag_tag_id ON person_tag(tag_id);
```

Similar patterns for: `contact_tag`, `event_tag`, `content_tag`, `thing_tag`, `place_tag`, `location_tag`, `action_tag`

### Other Join Tables

#### thread_file
```sql
CREATE TABLE thread_file (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id UUID REFERENCES threads(id) ON DELETE CASCADE NOT NULL,
    file_id UUID REFERENCES files(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(thread_id, file_id)
);

CREATE INDEX idx_thread_file_thread_id ON thread_file(thread_id);
CREATE INDEX idx_thread_file_file_id ON thread_file(file_id);
```

#### event_person
```sql
CREATE TABLE event_person (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID REFERENCES events(id) ON DELETE CASCADE NOT NULL,
    person_id UUID REFERENCES people(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, person_id)
);

CREATE INDEX idx_event_person_event_id ON event_person(event_id);
CREATE INDEX idx_event_person_person_id ON event_person(person_id);
```

## Vector Search Integration

The `embeddings` table enables AI-powered semantic search:
- Links to any entity via `entity_type` and `entity_id` flexible pattern
- Stores the embedding model used for version compatibility
- Raw input and hash for deduplication and consistency checks
- Vector data stored as comma-separated text (compatible with pgvector when needed)
- Supports multiple embedding models simultaneously

## External Integration Design

### OAuth2 Support
Modern OAuth2 implementation in connections table:
- `access_token`, `refresh_token` for secure API access
- `token_expiry` for automatic refresh scheduling
- `sync_state` JSONB for flexible synchronization status tracking
- Removed legacy OAuth2 columns for cleaner implementation

### Data Provenance
Comprehensive tracking of external data sources:
- `external_id`: Identifier in external system for synchronization
- `source_url`: Original URL or reference for data verification
- `source_data`: Raw JSON data from external APIs preserved for audit and reprocessing

## Performance Optimization

### Index Strategy
The schema leverages multiple indexing approaches:
- B-tree indexes for equality and range queries on common columns
- GIN indexes for JSONB columns supporting complex queries
- Composite indexes for multi-column query patterns
- Partial indexes on soft-deleted entities
- TimescaleDB time-space partitioning for time-series data

### Query Optimization
- Foreign key indexes for efficient JOIN operations
- User-scoped indexes for multi-tenant query patterns
- Time-based indexes for chronological data access
- Full-text search capabilities via PostgreSQL built-in features

## Schema Evolution Support

The design supports schema evolution through:
- JSONB columns for flexible data evolution (source_data, geolocation, tool_calls, sync_state)
- External ID tracking for data synchronization during schema changes
- Nullable foreign keys for optional relationships and gradual migration
- Migration-based schema changes with rollback support
- Versioned embedding models for AI feature evolution

## Security and Compliance

### Data Isolation
- All entities scoped to user_id preventing cross-user data access
- CASCADE deletion for user data cleanup
- Foreign key constraints ensuring referential integrity

### Audit Capabilities
- Complete timestamp tracking for all entity modifications
- Soft delete preservation for conversation data
- Join table creation timestamps for relationship audit trails
- API log retention for compliance and debugging

This design provides a robust, scalable foundation for a personal AI assistant with comprehensive memory management, intelligent search, and external data integration capabilities.