# Database Architecture

This document provides a high-level architectural overview of the CI-Server PostgreSQL database schema, including domain organization and key relationships.

*Last updated: Regenerated from rebased codebase analysis on October 17, 2024*

## Overview

The CI-Server database is organized into 9 main domains with 24 primary entities and several many-to-many join tables. The system supports user management, digital footprint tracking, entity relationship management, intelligent Q&A, conversations with AI, file management, external data connections, and background job processing.

**Major Schema Changes**: The database has undergone significant restructuring with the removal of legacy people/places/contacts tables and introduction of a unified entity graph system with digital footprint tracking capabilities.

## Domain Organization

### 1. User Domain
Core user management and authentication functionality.

**Entities:**
- `users` - Primary user accounts with authentication details and onboarding status
- `signup_code` - Invitation codes for user registration system  
- `sessions` - User session management for JWT authentication with device tracking

### 2. Entity Graph Domain
Unified entity relationship system for knowledge representation.

**Entities:**
- `entities` (GraphNodeEntity) - Universal entity nodes with embeddings and metadata
- `relationships` (RelationshipEntity) - Typed relationships between entities with strength scoring
- `communications` (CommunicationEntity) - Communication records with sentiment analysis and embeddings

### 3. Device & Activity Tracking Domain
Digital footprint and device management.

**Tables:**
- `devices` - User devices with capabilities and privacy settings
- `sensors` - IoT sensors and environmental monitoring devices
- `browser_activity` - Web browsing activity tracking (TimescaleDB hypertable)
- `screen_captures` - Screen capture analysis with OCR and AI insights (TimescaleDB hypertable)

### 4. Intelligence Domain
AI-powered question and answer system with action tracking.

**Entities:**
- `questions` - Pre-defined questions with multiple example answers and categorization
- `answers` - User responses to questions with both RAG-generated and user-provided answers
- `actions` - AI-generated or user-initiated actions with priority scoring linked to conversation threads

### 5. Conversations Domain
Chat and messaging system for AI interactions.

**Entities:**
- `threads` - Conversation threads with AI models supporting file attachments
- `messages` - Individual messages within threads with role-based conversation flow and tool call support

### 6. Connections Domain
External service integrations and data providers.

**Entities:**
- `providers` - External service providers (Google, Apple, Microsoft, etc.)
- `connections` - User connections to external services with OAuth2 token management and sync state

### 7. Memory Domain
Legacy content and events storage.

**Entities:**
- `events` - Calendar events and activities with time ranges and metadata  
- `content` - Documents, articles, media, and other content with MIME type support

### 8. Search Domain
Tagging and vector search capabilities.

**Entities:**
- `tags` - User-defined tags for content organization with automatic case normalization

### 9. Files Domain
File storage and management.

**Entities:**
- `files` - File metadata for uploads and attachments with S3-compatible storage support

### 10. ETL Domain
Data processing and API logging.

**Entities:**
- `api_logs` - Logs of external API calls and data processing (implemented as TimescaleDB hypertable)

### 11. Job Queue Domain
Background job processing using PGBoss.

**Schema:**
- `pgboss` - Dedicated schema for job queue tables (auto-managed by PGBoss library)

## Key Architectural Patterns

### 1. User-Centric Design
- Every entity (except join tables) belongs to a user via `user_id` foreign key
- Supports complete multi-tenant data isolation
- All queries should filter by user_id for security

### 2. Entity Graph Architecture
- **Unified Entity System**: All entities represented in `entities` table with flexible typing
- **Rich Relationships**: Typed relationships between entities with bidirectional support and strength scoring
- **Semantic Search**: Built-in embeddings for each entity enable AI-powered discovery
- **Flexible Properties**: JSONB properties allow domain-specific metadata without schema changes

### 3. Digital Footprint Tracking
- **Device Management**: Comprehensive device registration with capabilities and privacy controls
- **Activity Monitoring**: Real-time web browsing and screen capture analysis
- **TimescaleDB Optimization**: High-volume activity data stored in optimized hypertables
- **Privacy-First**: Granular privacy controls and sensitive content detection

### 4. AI-Powered Intelligence
- **Vector Embeddings**: Multiple embedding types (content, visual, semantic) for different use cases
- **Sentiment Analysis**: Communication sentiment scoring for relationship insights
- **Content Classification**: Automatic categorization and productivity scoring
- **Action Prioritization**: AI-driven action ranking and recommendation system

### 5. External Integration Support
- **Modern OAuth2**: Automatic token refresh with comprehensive sync state management
- **Data Provenance**: Complete tracking of external data sources and synchronization
- **API Monitoring**: High-volume API logging with TimescaleDB optimization
- **Connection Health**: Real-time monitoring of external service connections

### 6. Communication Tracking
- **Multi-Modal Communications**: Support for text, voice, video, and other communication types
- **Participant Management**: Flexible participant metadata and relationship tracking
- **Content Analysis**: Automatic summarization and categorization of communications
- **Privacy Controls**: Encryption and archiving support for sensitive communications

### 7. Background Job Processing
- **Dedicated PGBoss Schema**: Scalable job queues with retry and scheduling
- **Parallel Processing**: Support for high-throughput background operations
- **Job Prioritization**: Priority-based job execution for time-sensitive tasks

### 8. Time-Series Data Management
- **Multiple Hypertables**: Optimized storage for different activity types
- **Partitioning Strategy**: Time and user-based partitioning for optimal query performance
- **Vector Storage**: Native pgvector support for similarity search operations
- **Compression**: Automatic data compression for long-term storage efficiency

### 9. Legacy Migration Support
- **Gradual Migration**: Support for migrating from old schema to new entity graph system
- **Data Preservation**: Maintained compatibility during schema evolution
- **Table Pruning**: Systematic removal of deprecated tables while preserving essential data

## Core Relationships

### User Relationships
- **Central Hub**: All entities (except join tables) owned by users via `user_id` foreign key
- **Device Association**: Users own multiple devices with capability and privacy management
- **Entity Ownership**: All graph entities linked to owners for access control
- **Complete Isolation**: User-scoped data prevents cross-user access

### Entity Graph Relationships
- **`entities` ↔ `relationships`**: Rich bidirectional relationships with typing and strength
- **`entities` → `entities`**: Self-referencing through relationship table for flexible graph structure
- **Entity Linking**: Links to legacy tables through `linked_table` and `linked_id` fields
- **Embedding Integration**: Each entity has vector embeddings for semantic similarity

### Device and Activity Relationships
- **`devices` → `users`**: Device ownership and registration
- **`sensors` → `devices`**: IoT sensors attached to parent devices
- **`browser_activity` → `devices`**: Web activity tracked per device
- **`screen_captures` → `devices`**: Screen analysis linked to specific devices
- **Activity Correlation**: Cross-device activity correlation through user_id

### Communication Relationships
- **`communications` → `entities`**: Communications reference entities as participants
- **Multi-Entity Communications**: Array of participant entity IDs for group communications
- **Thread Linking**: Optional connection to conversation threads
- **Content Embeddings**: Communications include content embeddings for similarity search

### Intelligence Relationships
- **`answers` → `questions`**: User responses reference predefined questions
- **`actions` → `threads`**: AI-generated actions link to conversation context with priority scoring
- **`actions` ↔ `tags`**: Actions can be tagged for organization via `action_tag` join table

### Conversation Relationships
- **`messages` → `threads`**: Messages belong to conversation threads
- **`messages` → `messages`**: Self-referencing for prompt/response pairs (prompt_message_id)
- **`messages` ↔ `files`**: Many-to-many via `message_files` for file attachments
- **`threads` ↔ `files`**: Many-to-many via `thread_file` for conversation-level file attachments

### Connection Relationships
- **`connections` → `providers`**: Connections specify external service type
- **`connections` → `events`**: Calendar events imported from external connections
- **`connections` → `api_logs`**: API calls logged per connection for monitoring
- **Sync State Management**: JSONB sync state tracking per connection

### Legacy Content Relationships
- **`content` → `events`**: Documents and media associated with calendar events
- **`content` ↔ `tags`**: Content tagging via `content_tag` join table
- **`events` ↔ `tags`**: Event tagging via `event_tag` join table

## Technology Stack Integration

- **TypeORM**: All entities use decorators for ORM mapping with strict typing
- **PostgreSQL**: Native JSONB support for flexible schema evolution and rich queries
- **TimescaleDB**: Multiple hypertables for time-series optimization (api_logs, browser_activity, screen_captures)
- **pgvector**: Vector extension for embeddings with similarity search across multiple data types
- **PostGIS**: Geographic data support for sensor locations and spatial queries
- **PGBoss**: Background job processing with dedicated schema and monitoring
- **UUID v7**: Time-ordered UUIDs for distributed-friendly primary keys with natural sorting
- **TIMESTAMPTZ**: Timezone-aware timestamps for global application support
- **Vector Transformers**: Custom TypeORM transformers for embedding serialization
- **Hypertable Partitioning**: Automatic time and space partitioning for high-volume data

## Data Flow Overview

```
External APIs → connections → events/content (with provenance tracking)
                    ↓
User devices → browser_activity & screen_captures (real-time tracking)
                    ↓
Entity creation → entities table (unified representation)
                    ↓
Relationship mapping → relationships table (typed connections)
                    ↓
Communications → communications table (with sentiment analysis)
                    ↓
AI processing → embeddings generation → vector similarity search
                    ↓
User interactions → threads → messages → actions (prioritized workflows)
                    ↓
Background jobs → data processing → api_logs (monitoring & analytics)
                    ↓
Knowledge graph → entity relationships → intelligent recommendations
```

## Schema Evolution Journey

The database has undergone significant modernization:

1. **Legacy Schema (Pre-October 2024)**:
   - Separate tables for people, places, contacts, locations, things
   - Basic tagging system with multiple join tables
   - Simple embedding storage

2. **Current Schema (Post-Rebase)**:
   - Unified entity graph with flexible typing
   - Digital footprint tracking with TimescaleDB optimization
   - Advanced communication analysis with sentiment scoring
   - Device-centric activity monitoring
   - Vector embeddings integrated into entity system

3. **Migration Strategy**:
   - Gradual migration from legacy tables to entity graph
   - Table pruning to remove deprecated structures
   - Data preservation during schema evolution

## Security and Privacy Considerations

- **User Isolation**: All entities scoped to user_id preventing cross-user data access
- **Device Privacy**: Granular privacy controls per device with capability management
- **Sensitive Content Detection**: Automatic detection and flagging of sensitive information
- **Data Encryption**: Support for encrypted communications and content
- **Activity Controls**: Fine-grained control over what activity data is collected
- **Token Security**: OAuth tokens encrypted and automatically refreshed
- **Data Provenance**: Complete tracking of data sources and modifications
- **Audit Trails**: Comprehensive modification history via timestamps
- **Soft Deletes**: Conversation and sensitive data preserved with user control

## Performance and Scalability Features

- **TimescaleDB Hypertables**: Automatic partitioning for high-volume time-series data
- **Vector Indexing**: Optimized similarity search with pgvector HNSW indexes  
- **Composite Primary Keys**: Efficient partitioning for time-series tables
- **JSONB Indexing**: GIN indexes for flexible metadata queries
- **Spatial Indexing**: PostGIS GIST indexes for geographic sensor data
- **Connection Pooling**: Optimized for high-concurrency access patterns
- **Background Processing**: Distributed job processing for heavy AI workloads

This architecture provides a robust foundation for a next-generation personal AI assistant with comprehensive digital footprint tracking, entity relationship management, intelligent search, and scalable real-time processing capabilities.