# Database Design

This document provides detailed technical specifications for the CI-Server PostgreSQL database design, including entity definitions, data types, constraints, and implementation details.

*Last updated: Regenerated after rebase from main on October 17, 2024*

## Major Schema Changes

The database has undergone significant restructuring with the following key changes:
- **Legacy table removal**: Dropped people, contacts, places, locations, things, and embeddings tables
- **Entity graph introduction**: New unified entity system with relationships table
- **Digital footprint tracking**: New TimescaleDB hypertables for browser activity and screen captures  
- **Communication tracking**: New communications table with sentiment analysis
- **Device management**: Comprehensive device and sensor tracking system
- **Enhanced actions**: Added priority field to actions table
- **File relationships**: Restructured message-file relationships with dedicated join table

## Entity Specifications

### Data Types and Constraints

#### Primary Keys
- **UUID v7**: Most entities use time-ordered UUID v7 primary keys for distributed scalability and natural sorting
- **VARCHAR**: Questions and answers use string IDs for flexible identification
- **Composite Keys**: Time-series tables use composite primary keys (time, user_id, device_id)
- **BIGINT**: Join tables use auto-incrementing BIGINT IDs for performance

#### Common Columns
Most entities include:
- `created_at` (TIMESTAMPTZ): Record creation timestamp with timezone awareness
- `updated_at` (TIMESTAMPTZ): Last modification timestamp for change tracking
- `user_id` (UUID): Owner reference to users table for data isolation
- `owner_user_id` (UUID): Alternative ownership field for graph entities

#### Special Data Types
- **JSONB**: Flexible metadata storage (properties, capabilities, ui_elements, participants_metadata)
- **TIMESTAMPTZ**: Timezone-aware timestamps for global application support
- **TEXT**: Variable-length text fields with unlimited size
- **VECTOR**: pgvector type for embeddings (vector(768) for various embedding models)
- **GEOGRAPHY**: PostGIS geographic points for sensor locations
- **ARRAYS**: Native PostgreSQL arrays for entity lists and tags
- **DOUBLE PRECISION**: Floating point values for scores, coordinates, and measurements

#### TimescaleDB Integration
Multiple tables are implemented as TimescaleDB hypertables:
- **`api_logs`**: Partitioned by `created_at` and `user_id` for API monitoring
- **`browser_activity`**: Partitioned by `time` and `user_id` for web activity tracking
- **`screen_captures`**: Partitioned by `time` and `user_id` for screen analysis
- Automatic compression and retention policies for long-term storage

#### Vector Embeddings
Native vector support throughout the schema:
- **Content embeddings**: Text content vectorized for semantic search
- **Visual embeddings**: Screen captures and images vectorized for similarity
- **Entity embeddings**: Graph entities include semantic representations
- **Custom transformers**: TypeORM transformers for vector serialization

#### Soft Deletes
Some entities support soft deletion for data preservation:
- `threads.deleted_at` - Conversation thread soft deletion
- `messages.deleted_at` - Message soft deletion with cascade considerations
- Entity archiving through `is_archived` and `is_active` flags

## Detailed Entity Definitions

### Entity Graph Domain

#### entities (GraphNodeEntity)
```sql
CREATE TABLE entities (
    entity_id UUID PRIMARY KEY,
    entity_type TEXT NOT NULL,
    owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    description TEXT,
    properties JSONB DEFAULT '{}',
    embedding vector(768),
    search_content TEXT,
    linked_table TEXT,
    linked_id UUID,
    is_active BOOLEAN DEFAULT TRUE,
    is_archived BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_entities_owner ON entities(owner_user_id);
CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_entities_linked ON entities(linked_table, linked_id);
CREATE INDEX idx_entities_active ON entities(is_active, is_archived);
CREATE INDEX idx_entities_embedding ON entities USING ivfflat (embedding vector_cosine_ops);
```

#### relationships (RelationshipEntity)
```sql
CREATE TABLE relationships (
    relationship_id UUID PRIMARY KEY,
    from_entity_id UUID NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    to_entity_id UUID NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    strength DOUBLE PRECISION DEFAULT 1.0,
    properties JSONB DEFAULT '{}',
    is_bidirectional BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    start_date DATE,
    end_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_relationships_from ON relationships(from_entity_id);
CREATE INDEX idx_relationships_to ON relationships(to_entity_id);
CREATE INDEX idx_relationships_type ON relationships(relationship_type);
CREATE INDEX idx_relationships_owner ON relationships(owner_user_id);
CREATE INDEX idx_relationships_strength ON relationships(strength);
```

#### communications (CommunicationEntity)
```sql
CREATE TABLE communications (
    time TIMESTAMPTZ NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    communication_type TEXT NOT NULL,
    device_id UUID REFERENCES devices(device_id) ON DELETE SET NULL,
    direction TEXT NOT NULL,
    thread_id TEXT,
    from_entity_id UUID REFERENCES entities(entity_id),
    to_entity_ids UUID[],
    participants_metadata JSONB DEFAULT '{}',
    subject TEXT,
    content TEXT NOT NULL,
    attachments JSONB DEFAULT '[]',
    duration_seconds INTEGER,
    sentiment_score DOUBLE PRECISION,
    importance_score DOUBLE PRECISION,
    urgency_score DOUBLE PRECISION,
    content_embedding vector(768),
    category TEXT,
    summary TEXT,
    tags TEXT[],
    connection_id TEXT,
    is_encrypted BOOLEAN DEFAULT FALSE,
    is_archived BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (time, user_id, communication_type)
);

-- Indexes
CREATE INDEX idx_communications_user ON communications(user_id, time DESC);
CREATE INDEX idx_communications_type ON communications(communication_type);
CREATE INDEX idx_communications_sentiment ON communications(sentiment_score);
CREATE INDEX idx_communications_embedding ON communications USING ivfflat (content_embedding vector_cosine_ops);
```

### Device & Activity Domain

#### devices
```sql
CREATE TABLE devices (
    device_id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_entity_id UUID REFERENCES entities(entity_id),
    device_name TEXT NOT NULL,
    device_type TEXT NOT NULL,
    platform TEXT,
    model TEXT,
    manufacturer TEXT,
    os_version TEXT,
    app_version TEXT,
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    is_primary BOOLEAN DEFAULT FALSE,
    push_token TEXT,
    capabilities JSONB DEFAULT '{}',
    privacy_settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_devices_entity ON devices(device_entity_id);
CREATE UNIQUE INDEX devices_one_primary_per_user_idx ON devices (user_id) 
    WHERE is_primary = TRUE;
```

#### browser_activity (TimescaleDB Hypertable)
```sql
CREATE TABLE browser_activity (
    time TIMESTAMPTZ NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    domain TEXT GENERATED ALWAYS AS (
        CASE
            WHEN url ~ '^https?://' THEN split_part(split_part(url, '://', 2), '/', 1)
            ELSE NULL
        END
    ) STORED,
    title TEXT,
    action_type TEXT,
    duration_seconds INTEGER CHECK (duration_seconds >= 0),
    scroll_depth_percent DOUBLE PRECISION CHECK (scroll_depth_percent >= 0 AND scroll_depth_percent <= 100),
    page_summary TEXT,
    page_embedding vector(768),
    category TEXT,
    productivity_score DOUBLE PRECISION CHECK (productivity_score >= 0 AND productivity_score <= 1),
    is_incognito BOOLEAN DEFAULT FALSE,
    contains_sensitive BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (time, user_id, device_id)
);

SELECT create_hypertable('browser_activity', 'time', 'user_id', 4);

-- Indexes
CREATE INDEX idx_browser_activity_user ON browser_activity(user_id, time DESC);
CREATE INDEX idx_browser_activity_domain ON browser_activity(domain);
CREATE INDEX idx_browser_activity_embedding ON browser_activity USING ivfflat (page_embedding vector_cosine_ops);
```

#### screen_captures (TimescaleDB Hypertable)
```sql
CREATE TABLE screen_captures (
    time TIMESTAMPTZ NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    image_path TEXT NOT NULL,
    thumbnail_path TEXT,
    ocr_text TEXT,
    ui_elements JSONB DEFAULT '{}',
    applications JSONB DEFAULT '{}',
    activity_summary TEXT,
    visual_embedding vector(768),
    text_embedding vector(768),
    primary_application TEXT,
    activity_category TEXT,
    contains_sensitive BOOLEAN DEFAULT FALSE,
    contains_pii BOOLEAN DEFAULT FALSE,
    redacted BOOLEAN DEFAULT FALSE,
    redaction_regions JSONB DEFAULT '[]',
    PRIMARY KEY (time, user_id, device_id)
);

SELECT create_hypertable('screen_captures', 'time', 'user_id', 4);

-- Indexes
CREATE INDEX idx_screen_captures_user ON screen_captures(user_id, time DESC);
CREATE INDEX idx_screen_captures_app ON screen_captures(primary_application);
CREATE INDEX idx_screen_captures_visual ON screen_captures USING ivfflat (visual_embedding vector_cosine_ops);
CREATE INDEX idx_screen_captures_text ON screen_captures USING ivfflat (text_embedding vector_cosine_ops);
```

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
    priority INTEGER,
    thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_actions_user_id ON actions(user_id);
CREATE INDEX idx_actions_thread_id ON actions(thread_id);
CREATE INDEX idx_actions_priority ON actions(priority);
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
- Auto-incrementing BIGINT primary key or composite primary key for performance
- Foreign keys to both related entities with CASCADE constraints
- `created_at` timestamp for audit trails
- Composite unique constraints to prevent duplicates

### Active Tagging Join Tables

#### action_tag
```sql
CREATE TABLE action_tag (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action_id UUID REFERENCES actions(id) ON DELETE CASCADE NOT NULL,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(action_id, tag_id)
);

CREATE INDEX idx_action_tag_action_id ON action_tag(action_id);
CREATE INDEX idx_action_tag_tag_id ON action_tag(tag_id);
```

#### content_tag
```sql
CREATE TABLE content_tag (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content_id UUID REFERENCES content(id) ON DELETE CASCADE NOT NULL,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(content_id, tag_id)
);

CREATE INDEX idx_content_tag_content_id ON content_tag(content_id);
CREATE INDEX idx_content_tag_tag_id ON content_tag(tag_id);
```

#### event_tag
```sql
CREATE TABLE event_tag (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID REFERENCES events(id) ON DELETE CASCADE NOT NULL,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, tag_id)
);

CREATE INDEX idx_event_tag_event_id ON event_tag(event_id);
CREATE INDEX idx_event_tag_tag_id ON event_tag(tag_id);
```

### Removed Join Tables
The following join tables have been removed as part of the schema modernization:
- `person_tag`, `contact_tag` - Related to removed people/contacts tables
- `place_tag`, `location_tag` - Related to removed places/locations tables  
- `thing_tag` - Related to removed things table
- `event_person` - Event-person relationships now handled through entity graph

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

#### message_files
```sql
CREATE TABLE message_files (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, file_id)
);

CREATE INDEX idx_message_files_message ON message_files(message_id);
CREATE INDEX idx_message_files_file ON message_files(file_id);
```

## Vector Search Integration

Vector embeddings are integrated throughout the schema using native pgvector support:

### Entity Graph Embeddings
- **`entities.embedding`**: Semantic representation of each entity for similarity search
- **HNSW indexing**: Optimized vector similarity search with `vector_cosine_ops`
- **Flexible entity types**: Support for any entity type with unified embedding approach

### Communication Embeddings
- **`communications.content_embedding`**: Text content vectorized for semantic search
- **Multi-modal search**: Combined with sentiment scores for context-aware retrieval

### Activity Embeddings
- **`browser_activity.page_embedding`**: Web page content embeddings for browsing pattern analysis
- **`screen_captures.visual_embedding`**: Visual content embeddings for screen similarity
- **`screen_captures.text_embedding`**: OCR text embeddings for content-based search

### Vector Performance Optimization
- **Native pgvector**: Vector(768) type for embedding storage
- **IVFFLAT indexing**: Optimized for high-dimensional similarity search
- **Cosine similarity**: Default distance function for semantic relationships
- **Batch processing**: Efficient embedding generation for large datasets

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