# CI-Server Database Schema Documentation

This document provides a comprehensive overview of the CI-Server PostgreSQL database schema, including all entities, relationships, and domain organization.

## Overview

The CI-Server database is organized into 6 main domains with 21 primary entities and several many-to-many join tables. The system supports user management, memory storage (people, places, events, content), intelligent Q&A, conversations with AI, file management, and external data connections.

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
- `api_logs` - Logs of external API calls and data processing

## Key Relationships

### Core User Relationships
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

## Data Types and Constraints

### Primary Keys
- **UUID**: Most entities use UUID primary keys for distributed scalability
- **VARCHAR**: Questions and answers use string IDs
- **BIGINT**: Join tables use auto-incrementing BIGINT IDs

### Common Columns
Most entities include:
- `created_at` (TIMESTAMPTZ): Record creation timestamp
- `updated_at` (TIMESTAMPTZ): Last modification timestamp
- `user_id` (UUID): Owner reference to users table

### Special Data Types
- **JSONB**: Used for flexible data storage (source_data, geolocation, tool_calls)
- **TIMESTAMPTZ**: Timezone-aware timestamps
- **TEXT**: Variable-length text fields
- **BOOLEAN**: True/false flags
- **BIGINT**: Large integer values (file sizes)

### Soft Deletes
Some entities support soft deletion:
- `threads.deleted_at`
- `messages.deleted_at`

## Vector Search Integration

The `embeddings` table stores vector representations of content for AI-powered similarity search:
- Links to any entity via `entity_type` and `entity_id`
- Stores the embedding model used
- Raw input and hash for deduplication
- Vector data stored as comma-separated text

## External Integration

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

## Join Table Patterns

All many-to-many relationships use dedicated join tables with:
- Auto-incrementing BIGINT primary key
- Foreign keys to both related entities
- `created_at` timestamp for audit trails
- Composite uniqueness constraints (implied)

This design ensures referential integrity while supporting flexible many-to-many relationships across the domain model.