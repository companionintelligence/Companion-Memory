# CI-Server Database Schema - Visual Diagrams

This document contains visual representations of the CI-Server PostgreSQL database schema using multiple diagram formats.

*Last updated: Regenerated after rebase from main on October 17, 2024*

## Major Schema Changes
- **Entity Graph System**: New unified entity and relationship tables
- **Digital Footprint Tracking**: TimescaleDB hypertables for browser activity and screen captures
- **Communication Analysis**: New communications table with sentiment scoring
- **Device Management**: Comprehensive device and sensor tracking
- **Legacy Table Removal**: Dropped people, places, contacts, locations, things, and embeddings tables

## Mermaid Entity Relationship Diagram

The following Mermaid diagram shows the complete database schema with all 21 entities and their relationships:

```mermaid
erDiagram
    %% User Domain
    users {
        string id PK
        string name
        string email UK
        string password
        boolean onboarded
        timestamptz created_at
        timestamptz updated_at
    }
    
    signup_code {
        string id PK
        string signup_code UK
        boolean used
        timestamptz created_at
    }
    
    sessions {
        uuid id PK
        text token
        text ip
        text user_agent
        timestamptz expires_at
        uuid user_id FK
        timestamptz created_at
        timestamptz updated_at
    }

    %% Entity Graph Domain
    entities {
        uuid entity_id PK
        text entity_type
        uuid owner_user_id FK
        text name
        text description
        jsonb properties
        vector embedding
        text search_content
        text linked_table
        uuid linked_id
        boolean is_active
        boolean is_archived
        timestamptz created_at
        timestamptz updated_at
        timestamptz last_accessed
    }
    
    relationships {
        uuid relationship_id PK
        uuid from_entity_id FK
        uuid to_entity_id FK
        text relationship_type
        uuid owner_user_id FK
        double strength
        jsonb properties
        boolean is_bidirectional
        boolean is_active
        date start_date
        date end_date
        timestamptz created_at
        timestamptz updated_at
    }
    
    communications {
        timestamptz time PK
        uuid user_id PK FK
        text communication_type PK
        uuid device_id FK
        text direction
        text thread_id
        uuid from_entity_id FK
        uuid[] to_entity_ids
        jsonb participants_metadata
        text subject
        text content
        jsonb attachments
        integer duration_seconds
        double sentiment_score
        double importance_score
        double urgency_score
        vector content_embedding
        text category
        text summary
        text[] tags
        text connection_id
        boolean is_encrypted
        boolean is_archived
    }

    %% Device & Activity Domain
    devices {
        uuid device_id PK
        uuid user_id FK
        uuid device_entity_id FK
        text device_name
        text device_type
        text platform
        text model
        text manufacturer
        text os_version
        text app_version
        timestamptz last_seen
        boolean is_active
        boolean is_primary
        text push_token
        jsonb capabilities
        jsonb privacy_settings
        timestamptz created_at
        timestamptz updated_at
    }
    
    sensors {
        uuid sensor_id PK
        uuid device_id FK
        uuid sensor_entity_id FK
        text sensor_name
        text sensor_type
        text semantic_location
        geography physical_location
        text location_description
        jsonb measurement_types
        jsonb measurement_units
        double sampling_rate_hz
        jsonb device_info
        jsonb calibration_data
        boolean is_active
        timestamptz last_reading_at
        double battery_level
        timestamptz created_at
        timestamptz updated_at
    }
    
    browser_activity {
        timestamptz time PK
        uuid user_id PK FK
        uuid device_id PK FK
        text url
        text domain
        text title
        text action_type
        integer duration_seconds
        double scroll_depth_percent
        text page_summary
        vector page_embedding
        text category
        double productivity_score
        boolean is_incognito
        boolean contains_sensitive
    }
    
    screen_captures {
        timestamptz time PK
        uuid user_id PK FK
        uuid device_id PK FK
        text image_path
        text thumbnail_path
        text ocr_text
        jsonb ui_elements
        jsonb applications
        text activity_summary
        vector visual_embedding
        vector text_embedding
        text primary_application
        text activity_category
        boolean contains_sensitive
        boolean contains_pii
        boolean redacted
        jsonb redaction_regions
    }

    %% Search Domain
    tags {
        uuid id PK
        text label
        uuid user_id FK
        timestamptz created_at
    }

    %% Connection Domain
    providers {
        uuid id PK
        text name
        timestamptz created_at
        timestamptz updated_at
    }
    
    connections {
        uuid id PK
        text name
        boolean active
        text schedule
        text access_token
        text refresh_token
        timestamptz token_expiry
        jsonb sync_state
        uuid user_id FK
        uuid provider_id FK
        timestamptz created_at
        timestamptz updated_at
    }

    %% Files Domain
    files {
        uuid id PK
        text bucket
        uuid key
        text original_name
        text content_type
        bigint size
        uuid user_id FK
        timestamptz created_at
        timestamptz updated_at
    }

    %% Conversation Domain
    threads {
        uuid id PK
        text name
        text model
        text description
        uuid user_id FK
        timestamptz created_at
        timestamptz updated_at
        timestamptz deleted_at
    }
    
    messages {
        uuid id PK
        text model
        text role
        text text
        text mimetype
        jsonb tool_calls
        boolean prompt
        boolean canceled
        uuid user_id FK
        uuid thread_id FK
        uuid prompt_message_id FK
        timestamptz created_at
        timestamptz updated_at
        timestamptz deleted_at
    }

    %% Intelligence Domain
    questions {
        string id PK
        string category
        string text
        string example_answer_1
        string example_answer_2
        string example_answer_3
        string subcategory
        uuid user_id FK
        timestamptz created_at
        timestamptz updated_at
    }
    
    answers {
        string id PK
        string rag_answer_1
        string rag_answer_2
        string rag_answer_3
        string give_answer_1
        string give_answer_2
        string give_answer_3
        uuid user_id FK
        string question_id FK
        timestamptz created_at
        timestamptz updated_at
    }
    
    actions {
        uuid id PK
        text title
        text text
        text image_url
        integer priority
        text thread_id FK
        uuid user_id FK
        timestamptz created_at
        timestamptz updated_at
    }

    %% Legacy Memory Domain
    events {
        uuid id PK
        text type
        text name
        text description
        timestamptz start_time
        timestamptz end_time
        text external_id
        text source_url
        jsonb source_data
        uuid user_id FK
        uuid connection_id FK
        timestamptz created_at
        timestamptz updated_at
    }
    
    content {
        uuid id PK
        text type
        text title
        text text
        text url
        text mimetype
        text external_id
        text source_url
        jsonb source_data
        uuid user_id FK
        uuid event_id FK
        timestamptz created_at
        timestamptz updated_at
    }

    %% ETL Domain
    api_logs {
        uuid id PK
        uuid user_id FK
        uuid connection_id FK
        text scope
        jsonb content
        timestamptz last_processed
        timestamptz created_at
    }

    %% Active Join Tables
    action_tag {
        bigint id PK
        uuid action_id FK
        uuid tag_id FK
        timestamptz created_at
    }
    
    content_tag {
        bigint id PK
        uuid content_id FK
        uuid tag_id FK
        timestamptz created_at
    }
    
    event_tag {
        bigint id PK
        uuid event_id FK
        uuid tag_id FK
        timestamptz created_at
    }
    
    thread_file {
        bigint id PK
        uuid thread_id FK
        uuid file_id FK
        timestamptz created_at
    }
    
    message_files {
        uuid message_id PK FK
        uuid file_id PK FK
        timestamptz created_at
    }

    %% Primary Relationships
    %% User relationships (central hub)
    users ||--o{ sessions : "has"
    users ||--o{ tags : "owns"
    users ||--o{ entities : "owns"
    users ||--o{ relationships : "owns"
    users ||--o{ communications : "has"
    users ||--o{ devices : "owns"
    users ||--o{ connections : "has"
    users ||--o{ files : "uploads"
    users ||--o{ threads : "creates"
    users ||--o{ messages : "sends"
    users ||--o{ questions : "asks"
    users ||--o{ answers : "provides"
    users ||--o{ actions : "performs"
    users ||--o{ events : "has"
    users ||--o{ content : "creates"
    users ||--o{ api_logs : "logs"
    users ||--o{ browser_activity : "tracks"
    users ||--o{ screen_captures : "captures"

    %% Entity Graph relationships
    entities ||--o{ relationships : "from_entity"
    entities ||--o{ relationships : "to_entity"
    entities ||--o{ communications : "from_entity"
    entities ||--o{ communications : "to_entities"

    %% Device relationships
    devices ||--o{ sensors : "has"
    devices ||--o{ communications : "device"
    devices ||--o{ browser_activity : "device"
    devices ||--o{ screen_captures : "device"
    devices ||--o{ entities : "linked_entity"

    %% Provider and Connection relationships
    providers ||--o{ connections : "used_by"
    connections ||--o{ events : "imports"
    connections ||--o{ api_logs : "generates"

    %% Thread and Message relationships
    threads ||--o{ messages : "contains"
    messages ||--o{ messages : "responds_to"
    threads ||--|| actions : "linked_to"
    communications ||--o{ threads : "thread"

    %% Question and Answer relationships
    questions ||--o{ answers : "answered_by"

    %% Legacy content relationships
    events ||--o{ content : "contains"

    %% Many-to-Many relationships via join tables
    actions ||--o{ action_tag : ""
    tags ||--o{ action_tag : ""
    
    content ||--o{ content_tag : ""
    tags ||--o{ content_tag : ""
    
    events ||--o{ event_tag : ""
    tags ||--o{ event_tag : ""
    
    threads ||--o{ thread_file : ""
    files ||--o{ thread_file : ""
    
    messages ||--o{ message_files : ""
    files ||--o{ message_files : ""
```

## Domain Organization Overview

The database is organized into 9 main functional domains:

### Core Domains
- **User Domain**: Authentication, sessions, and user management
- **Entity Graph Domain**: Unified entity system with typed relationships and communications
- **Device & Activity Domain**: Digital footprint tracking and device management
- **Intelligence Domain**: AI-powered Q&A system and prioritized action tracking
- **Conversations Domain**: Chat threads and AI interactions with file attachments

### Supporting Domains  
- **Connections Domain**: External service integrations with OAuth2
- **Search Domain**: Tagging system for content organization
- **Files Domain**: File storage and multi-entity attachment management
- **ETL Domain**: API logging and data processing monitoring
- **Legacy Memory Domain**: Transitional content and events storage

## Special Schema Features

### Entity Graph System
- **Unified Entity Storage**: All entities represented in single `entities` table with flexible typing
- **Rich Relationship Model**: Typed, bidirectional relationships with strength scoring
- **Integrated Embeddings**: Native vector embeddings in entity table for semantic search
- **Flexible Properties**: JSONB properties for domain-specific metadata without schema changes
- **Entity Linking**: Links to legacy tables via `linked_table` and `linked_id` fields

### Digital Footprint Tracking
- **Multiple TimescaleDB Hypertables**: Optimized storage for different activity types
  - `browser_activity`: Web browsing with productivity scoring
  - `screen_captures`: Visual analysis with OCR and AI insights
  - `api_logs`: API monitoring and performance tracking
- **Real-time Analysis**: Sentiment, productivity, and privacy scoring for activities
- **Multi-modal Embeddings**: Visual, textual, and semantic embeddings for comprehensive search

### Communication Intelligence
- **Sentiment Analysis**: Automatic sentiment scoring for all communications
- **Participant Management**: Flexible entity-based participant tracking
- **Content Embeddings**: Vector representations for semantic communication search
- **Privacy Controls**: Encryption and archiving flags for sensitive communications

### Device Management System
- **Comprehensive Device Tracking**: Full device capabilities and privacy controls
- **IoT Sensor Integration**: PostGIS geographic support for sensor locations
- **Activity Correlation**: Cross-device activity tracking and analysis
- **Privacy-First Design**: Granular controls over data collection per device

### Advanced Vector Search
- **Native pgvector Support**: VECTOR(768) type throughout schema
- **Multiple Embedding Types**: Content, visual, and semantic embeddings
- **HNSW Indexing**: Optimized similarity search with `vector_cosine_ops`
- **Cross-entity Search**: Unified similarity search across all entity types

### PGBoss Job Queue Schema
- **Dedicated Schema**: Separate `pgboss` schema for operational isolation
- **Background Processing**: Handles AI analysis, embedding generation, and data processing
- **Scalable Architecture**: Support for distributed job processing

### Legacy Migration Support
- **Gradual Migration**: Support for migrating from old schema to entity graph
- **Table Pruning**: Systematic removal of deprecated tables (people, places, contacts, etc.)
- **Data Preservation**: Essential data migrated to new entity graph system
- **Backward Compatibility**: Maintained during transition period

### Privacy and Security Features
- **Sensitive Content Detection**: Automatic flagging in browser activity and screen captures
- **PII Detection**: Advanced privacy controls for screen captures
- **Data Encryption**: Support for encrypted communications and content
- **User Isolation**: Complete data isolation via user_id scoping throughout schema

### Performance Optimizations
- **Composite Primary Keys**: Optimized partitioning for time-series tables
- **Generated Columns**: Automatic domain extraction for browser activity
- **Specialized Indexes**: GIN, GIST, and IVFFLAT indexes for different query patterns
- **Compression**: Automatic compression for long-term data storage

This modernized schema provides a foundation for next-generation personal AI with comprehensive digital footprint tracking, entity relationship management, advanced search capabilities, and privacy-first design principles.