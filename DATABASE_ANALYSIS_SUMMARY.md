# CI-Server Database Schema Analysis - Summary

This document summarizes the complete database schema analysis for the CI-Server PostgreSQL database.

## Files Created

1. **database-schema.puml** - PlantUML source file for comprehensive UML diagram
2. **DATABASE_SCHEMA.md** - Detailed documentation of the database schema
3. **DATABASE_DIAGRAM.md** - Text-based entity relationship diagram with ASCII art
4. **DATABASE_MERMAID.md** - Mermaid ER diagram (GitHub-renderable)

## Analysis Summary

### Total Entities Discovered: 21 Main Entities + 10 Join Tables + 1 Dedicated Schema

#### Main Entities by Domain:

**User Domain (3 entities):**
- `users` - Core user accounts
- `signup_code` - Invitation system
- `sessions` - Authentication sessions

**Memory Domain (7 entities):**
- `people` - Personal contacts and individuals
- `contacts` - Contact information
- `places` - Geographical locations
- `locations` - Timestamped location data
- `events` - Calendar events and activities
- `content` - Documents and media
- `things` - Physical/digital items

**Intelligence Domain (3 entities):**
- `questions` - Pre-defined questions
- `answers` - User responses to questions
- `actions` - AI-generated actions

**Conversations Domain (2 entities):**
- `threads` - Conversation threads
- `messages` - Chat messages

**Connections Domain (2 entities):**
- `providers` - External service providers
- `connections` - OAuth connections

**Search Domain (2 entities):**
- `tags` - User-defined tags
- `embeddings` - Vector embeddings

**Files Domain (1 entity):**
- `files` - File metadata

**ETL Domain (1 entity):**
- `api_logs` - API call logs (TimescaleDB hypertable)

**Job Queue Domain (1 schema):**
- `pgboss` - Background job processing schema

#### Join Tables (10 tables):

**Tagging Relationships (8 tables):**
- `person_tag`, `contact_tag`, `event_tag`, `content_tag`
- `thing_tag`, `place_tag`, `location_tag`, `action_tag`

**Other Many-to-Many (2 tables):**
- `thread_file` - Threads can have multiple files
- `event_person` - Events can have multiple people

## Key Architecture Patterns

### 1. User-Centric Design
- Every entity (except join tables) belongs to a user via `user_id` foreign key
- Supports multi-tenant data isolation

### 2. Domain-Driven Design
- Clear separation of concerns across 8 domains
- Each domain has focused responsibilities

### 3. Flexible Tagging System
- Most content entities can be tagged for organization
- Many-to-many relationships via dedicated join tables

### 4. External Integration Support
- OAuth2 support in connections (cleaned up legacy columns)
- Data provenance tracking (external_id, source_url, source_data)
- API logging for ETL processes with TimescaleDB optimization

### 5. Vector Search Ready
- Embeddings table supports AI-powered semantic search
- Links to any entity via entity_type/entity_id pattern

### 6. Audit Trail Support
- created_at/updated_at on all entities
- Soft deletes on conversations (deleted_at)
- Join tables track creation timestamps

### 7. Background Job Processing
- Dedicated PGBoss schema for job queues
- Auto-managed by the PGBoss library
- Supports scheduling, retries, and parallel processing

### 8. Time-Series Data Management
- TimescaleDB hypertables for high-volume logging
- Optimized partitioning strategy for api_logs
- Efficient indexing for time-based queries

## Data Flow Overview

```
External APIs → connections → events/content/people
                    ↓
User creates questions → answers (RAG + manual)
                    ↓
User chats → threads → messages → actions
                    ↓
All content can be tagged and embedded for search
```

## Technology Stack Integration

- **TypeORM**: All entities use decorators for ORM mapping
- **PostgreSQL**: Native JSONB support for flexible data
- **TimescaleDB**: Time-series optimization for api_logs table
- **pgvector**: Vector extension for embeddings
- **PGBoss**: Background job processing with dedicated schema
- **UUID**: Distributed-friendly primary keys
- **TIMESTAMPTZ**: Timezone-aware timestamps

## Schema Evolution Support

The design supports schema evolution through:
- JSONB columns for flexible data (source_data, geolocation, tool_calls)
- External ID tracking for data synchronization
- Nullable foreign keys for optional relationships
- Migration-based schema changes

## Recommended Usage

1. **Start with user creation** and authentication via users/sessions
2. **Set up external connections** via providers/connections for data import
3. **Import or create memory entities** (people, places, events, content)
4. **Use tagging system** for content organization
5. **Leverage embeddings** for AI-powered search and recommendations
6. **Create conversation threads** for AI interactions
7. **Generate actions** from AI conversations

This schema provides a robust foundation for a personal AI assistant system with comprehensive memory management, intelligent search, and external data integration capabilities.