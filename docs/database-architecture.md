# Database Architecture

This document provides a high-level architectural overview of the CI-Server PostgreSQL database schema, including domain organization and key relationships.

*Last updated: Generated from current codebase analysis on October 9, 2024*

## Overview

The CI-Server database is organized into 8 main domains with 21 primary entities and several many-to-many join tables. The system supports user management, memory storage (people, places, events, content), intelligent Q&A, conversations with AI, file management, external data connections, and background job processing.

## Domain Organization

### 1. User Domain
Core user management and authentication functionality.

**Entities:**
- `users` - Primary user accounts with authentication details and onboarding status
- `signup_code` - Invitation codes for user registration system
- `sessions` - User session management for JWT authentication with device tracking

### 2. Memory Domain
Personal information storage including people, places, events, and content.

**Entities:**
- `people` - Personal contacts, family members, and individuals with detailed demographics
- `contacts` - Contact information linking to people with multiple contact methods
- `places` - Geographical places and locations with hierarchical organization
- `locations` - Timestamped location data points with GPS coordinates
- `events` - Calendar events and activities with time ranges and metadata
- `content` - Documents, articles, media, and other content with MIME type support
- `things` - Physical or digital items associated with events and activities

### 3. Intelligence Domain
AI-powered question and answer system with action tracking.

**Entities:**
- `questions` - Pre-defined questions with multiple example answers and categorization
- `answers` - User responses to questions with both RAG-generated and user-provided answers
- `actions` - AI-generated or user-initiated actions linked to conversation threads

### 4. Conversations Domain
Chat and messaging system for AI interactions.

**Entities:**
- `threads` - Conversation threads with AI models supporting file attachments
- `messages` - Individual messages within threads with role-based conversation flow and tool call support

### 5. Connections Domain
External service integrations and data providers.

**Entities:**
- `providers` - External service providers (Google, Apple, Microsoft, etc.)
- `connections` - User connections to external services with OAuth2 token management and sync state

### 6. Search Domain
Tagging and vector search capabilities.

**Entities:**
- `tags` - User-defined tags for content organization with automatic case normalization
- `embeddings` - Vector embeddings for AI-powered semantic search across all content types

### 7. Files Domain
File storage and management.

**Entities:**
- `files` - File metadata for uploads and attachments with S3-compatible storage support

### 8. ETL Domain
Data processing and API logging.

**Entities:**
- `api_logs` - Logs of external API calls and data processing (implemented as TimescaleDB hypertable)

### 9. Job Queue Domain
Background job processing using PGBoss.

**Schema:**
- `pgboss` - Dedicated schema for job queue tables (auto-managed by PGBoss library)

## Key Architectural Patterns

### 1. User-Centric Design
- Every entity (except join tables) belongs to a user via `user_id` foreign key
- Supports complete multi-tenant data isolation
- All queries should filter by user_id for security

### 2. Domain-Driven Design
- Clear separation of concerns across 8 functional domains
- Each domain has focused responsibilities and minimal cross-domain dependencies
- Domain boundaries align with business capabilities

### 3. Flexible Tagging System
- Universal tagging system supports all major content entities
- Many-to-many relationships via dedicated join tables with audit trails
- Case-insensitive tag labels with automatic normalization

### 4. External Integration Support
- Modern OAuth2 implementation with automatic token refresh
- Comprehensive data provenance tracking (external_id, source_url, source_data)
- API logging optimized for high-volume time-series data with TimescaleDB

### 5. Vector Search Ready
- Embeddings table supports AI-powered semantic search across any entity type
- Flexible entity linking via entity_type/entity_id pattern
- Support for multiple embedding models with versioning

### 6. Audit Trail Support
- Comprehensive timestamp tracking (created_at/updated_at) on all entities
- Soft delete support for conversations (deleted_at columns)
- Join tables include creation timestamps for complete audit trails

### 7. Background Job Processing
- Dedicated PGBoss schema for scalable job queues
- Auto-managed by PGBoss library with retry and scheduling support
- Supports parallel processing and job prioritization

### 8. Time-Series Data Management
- TimescaleDB hypertables for high-volume logging and analytics
- Optimized partitioning strategy by time and user for query performance
- Specialized indexing for time-based and JSONB content queries

## Core Relationships

### User Relationships
- Central hub: All entities (except join tables) owned by users via `user_id` foreign key
- Users can have multiple sessions, connections, threads, questions, and all content entities
- Enables complete data isolation and privacy per user

### Memory Domain Relationships
- `contacts` → `people`: Contact information links to person records
- `places` → `places`: Self-referencing hierarchy for location organization (parent_id)
- `locations` → `places`: Timestamped location points reference place definitions
- `content` → `events`: Documents and media can be associated with calendar events
- `things` → `events`: Physical/digital items can be linked to specific events
- `events` ↔ `people`: Many-to-many relationship via `event_person` join table

### Intelligence Relationships
- `answers` → `questions`: User responses reference specific predefined questions
- `actions` → `threads`: AI-generated actions link to conversation context
- Actions can be tagged and searched alongside other content

### Conversation Relationships
- `messages` → `threads`: Messages belong to conversation threads
- `messages` → `messages`: Self-referencing for prompt/response pairs (prompt_message_id)
- `threads` ↔ `files`: Many-to-many via `thread_file` for file attachments in conversations

### Connection Relationships
- `connections` → `providers`: Connections specify which external service is used
- `connections` → `events`: Calendar events can be imported from external connections
- `connections` → `api_logs`: API calls are logged per connection for monitoring

### Universal Tagging System
Many entities support tagging via standardized many-to-many relationships:
- Core entities: `person_tag`, `contact_tag`, `event_tag`, `content_tag`
- Additional entities: `thing_tag`, `place_tag`, `location_tag`, `action_tag`
- Enables cross-domain content discovery and organization

## Technology Stack Integration

- **TypeORM**: All entities use decorators for ORM mapping with strict typing
- **PostgreSQL**: Native JSONB support for flexible schema evolution
- **TimescaleDB**: Time-series optimization for api_logs table with automatic partitioning
- **pgvector**: Vector extension for embeddings with similarity search
- **PGBoss**: Background job processing with dedicated schema and monitoring
- **UUID**: Distributed-friendly primary keys with collision resistance
- **TIMESTAMPTZ**: Timezone-aware timestamps for global application support

## Data Flow Overview

```
External APIs → connections → events/content/people (with provenance tracking)
                    ↓
User creates questions → answers (RAG-generated + manual responses)
                    ↓
User interactions → threads → messages → actions (AI-powered workflows)
                    ↓
All content → tags + embeddings → searchable knowledge base
                    ↓
Background jobs → data processing → api_logs (monitoring & analytics)
```

## Security and Privacy Considerations

- **User Isolation**: All entities scoped to user_id preventing cross-user data access
- **Token Security**: OAuth tokens encrypted and automatically refreshed
- **Data Provenance**: External data sources tracked for transparency
- **Audit Trails**: Complete modification history via timestamps
- **Soft Deletes**: Conversation data preserved for user control

This architecture provides a robust foundation for a personal AI assistant system with comprehensive memory management, intelligent search, external data integration, and scalable background processing capabilities.