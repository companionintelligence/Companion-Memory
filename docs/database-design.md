# Database Design

This document provides detailed technical specifications for the CI-Server PostgreSQL database design, including entity definitions, data types, constraints, and UML diagrams.

## Entity Specifications

### Data Types and Constraints

#### Primary Keys
- **UUID**: Most entities use UUID primary keys for distributed scalability
- **VARCHAR**: Questions and answers use string IDs
- **BIGINT**: Join tables use auto-incrementing BIGINT IDs

#### Common Columns
Most entities include:
- `created_at` (TIMESTAMPTZ): Record creation timestamp
- `updated_at` (TIMESTAMPTZ): Last modification timestamp
- `user_id` (UUID): Owner reference to users table

#### Special Data Types
- **JSONB**: Used for flexible data storage (source_data, geolocation, tool_calls)
- **TIMESTAMPTZ**: Timezone-aware timestamps
- **TEXT**: Variable-length text fields
- **BOOLEAN**: True/false flags
- **BIGINT**: Large integer values (file sizes)

#### TimescaleDB Integration
The `api_logs` table is implemented as a TimescaleDB hypertable:
- Partitioned by `created_at` timestamp for time-series optimization
- Hash partitioned by `user_id` for parallel processing
- Optimized indexes for time-based and user-based queries

#### Soft Deletes
Some entities support soft deletion:
- `threads.deleted_at`
- `messages.deleted_at`

## Detailed Entity Definitions

### User Domain

#### users
```sql
CREATE TABLE users (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    email VARCHAR UNIQUE NOT NULL,
    password VARCHAR NOT NULL,
    onboarded BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### signup_code
```sql
CREATE TABLE signup_code (
    id VARCHAR PRIMARY KEY,
    signup_code VARCHAR UNIQUE NOT NULL,
    used BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### sessions
```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    token TEXT NOT NULL,
    ip TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
    user_id UUID REFERENCES users(id),
    connection_id UUID REFERENCES connections(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### actions
```sql
CREATE TABLE actions (
    id UUID PRIMARY KEY,
    title TEXT,
    text TEXT,
    image_url TEXT,
    thread_id TEXT REFERENCES threads(id),
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Conversations Domain

#### threads
```sql
CREATE TABLE threads (
    id UUID PRIMARY KEY,
    name TEXT,
    model TEXT,
    description TEXT,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
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
    canceled BOOLEAN NOT NULL,
    user_id UUID REFERENCES users(id),
    thread_id UUID REFERENCES threads(id),
    prompt_message_id UUID REFERENCES messages(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
```

### ETL Domain

#### api_logs (TimescaleDB Hypertable)
```sql
CREATE TABLE api_logs (
    id UUID DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    connection_id UUID REFERENCES connections(id),
    scope TEXT,
    content JSONB,
    last_processed TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at, user_id)
);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('api_logs', 'created_at', 'user_id', 4);
```

## Join Tables

All many-to-many relationships use dedicated join tables with:
- Auto-incrementing BIGINT primary key
- Foreign keys to both related entities
- `created_at` timestamp for audit trails
- Composite uniqueness constraints (implied)

### Tagging Join Tables
```sql
-- Example: person_tag table
CREATE TABLE person_tag (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_id UUID REFERENCES people(id) NOT NULL,
    tag_id UUID REFERENCES tags(id) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Similar patterns for: `contact_tag`, `event_tag`, `content_tag`, `thing_tag`, `place_tag`, `location_tag`, `action_tag`

### Other Join Tables
```sql
-- Thread files relationship
CREATE TABLE thread_file (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id UUID REFERENCES threads(id) NOT NULL,
    file_id UUID REFERENCES files(id) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Event people relationship
CREATE TABLE event_person (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID REFERENCES events(id) NOT NULL,
    person_id UUID REFERENCES people(id) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Vector Search Integration

The `embeddings` table stores vector representations of content for AI-powered similarity search:
- Links to any entity via `entity_type` and `entity_id`
- Stores the embedding model used
- Raw input and hash for deduplication
- Vector data stored as comma-separated text

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
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## External Integration Design

### OAuth2 Support
Connections table supports OAuth2 authentication:
- `access_token`, `refresh_token`, `token_expiry`
- `sync_state` for tracking synchronization status

### Data Provenance
Many entities track external sources:
- `external_id`: ID in external system
- `source_url`: URL of original data
- `source_data`: Raw JSON data from external APIs

## Index Strategy

The schema leverages several indexing approaches:
- Primary key indexes on all entities
- Foreign key indexes for relationships
- The `@Indexable` decorator indicates entities included in vector search
- Unique constraints on critical fields (user email, signup codes)
- Specialized TimescaleDB indexes for time-series queries

## Schema Evolution Support

The design supports schema evolution through:
- JSONB columns for flexible data (source_data, geolocation, tool_calls)
- External ID tracking for data synchronization
- Nullable foreign keys for optional relationships
- Migration-based schema changes