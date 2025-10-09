# Database Architecture

This document provides a high-level architectural overview of the CI-Server PostgreSQL database schema, including domain organization and key relationships.

## Overview

The CI-Server database is organized into 8 main domains with 21 primary entities and several many-to-many join tables. The system supports user management, memory storage (people, places, events, content), intelligent Q&A, conversations with AI, file management, external data connections, and background job processing.

## Domain Organization

### 1. User Domain
Core user management and authentication functionality.

**Entities:**
- `users` - Primary user accounts with authentication details
- `signup_code` - Invitation codes for user registration  
- `sessions` - User session management for authentication

### 2. Memory Domain
Personal information storage including people, places, events, and content.

**Entities:**
- `people` - Personal contacts, family members, and individuals
- `contacts` - Contact information linking to people
- `places` - Geographical places and locations
- `locations` - Timestamped location data points
- `events` - Calendar events and activities
- `content` - Documents, articles, media, and other content
- `things` - Physical or digital items associated with events

### 3. Intelligence Domain
AI-powered question and answer system with action tracking.

**Entities:**
- `questions` - Pre-defined questions with example answers
- `answers` - User responses to questions (both RAG and given answers)
- `actions` - AI-generated or user-initiated actions

### 4. Conversations Domain
Chat and messaging system for AI interactions.

**Entities:**
- `threads` - Conversation threads with AI models
- `messages` - Individual messages within threads (user prompts and AI responses)

### 5. Connections Domain
External service integrations and data providers.

**Entities:**
- `providers` - External service providers (Google, Apple, etc.)
- `connections` - User connections to external services with OAuth tokens

### 6. Search Domain
Tagging and vector search capabilities.

**Entities:**
- `tags` - User-defined tags for content organization
- `embeddings` - Vector embeddings for AI-powered search

### 7. Files Domain
File storage and management.

**Entities:**
- `files` - File metadata for uploads and attachments

### 8. ETL Domain
Data processing and API logging.

**Entities:**
- `api_logs` - Logs of external API calls and data processing (TimescaleDB hypertable with time-series partitioning)

### 9. Job Queue Domain
Background job processing using PGBoss.

**Schema:**
- `pgboss` - Dedicated schema for job queue tables (auto-managed by PGBoss)

## Key Architectural Patterns

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

## Core Relationships

### User Relationships
- Each entity (except join tables) is owned by a `users` record via `user_id` foreign key
- Users can have multiple sessions, connections, threads, questions, etc.

### Memory Domain Relationships
- `contacts` → `people`: Contacts link to person records
- `places` → `places`: Self-referencing for place hierarchies (parent_id)
- `locations` → `places`: Location points reference places
- `content` → `events`: Content can be associated with events
- `things` → `events`: Things can be associated with events
- `events` ↔ `people`: Many-to-many via `event_person` join table

### Intelligence Relationships
- `answers` → `questions`: Answers reference specific questions
- `actions` → `threads`: Actions can be linked to conversation threads

### Conversation Relationships
- `messages` → `threads`: Messages belong to conversation threads
- `messages` → `messages`: Self-referencing for prompt/response pairs (prompt_message_id)
- `threads` ↔ `files`: Many-to-many via `thread_file` join table

### Connection Relationships
- `connections` → `providers`: Connections use specific providers
- `connections` → `events`: Events can be imported from connections

### Tagging System
Many entities support tagging via many-to-many relationships:
- `person_tag`, `contact_tag`, `event_tag`, `content_tag`
- `thing_tag`, `place_tag`, `location_tag`, `action_tag`

## Technology Stack Integration

- **TypeORM**: All entities use decorators for ORM mapping
- **PostgreSQL**: Native JSONB support for flexible data
- **TimescaleDB**: Time-series optimization for api_logs table
- **pgvector**: Vector extension for embeddings
- **PGBoss**: Background job processing with dedicated schema
- **UUID**: Distributed-friendly primary keys
- **TIMESTAMPTZ**: Timezone-aware timestamps

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

This architecture provides a robust foundation for a personal AI assistant system with comprehensive memory management, intelligent search, and external data integration capabilities.