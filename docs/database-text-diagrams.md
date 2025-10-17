# CI-Server Database Entity Relationship Diagram (Text Format)

*Generated from codebase analysis on October 17, 2024*

## Entity Overview by Domain

```
USER DOMAIN
├── users (id, name, email, password, onboarded, created_at, updated_at)
├── signup_codes (id, signup_code, used, created_at)
└── sessions (id, token, ip, user_agent, expires_at, user_id→users, created_at, updated_at)

ENTITY GRAPH DOMAIN
├── entities (id, type, label, properties, visual_embedding, textual_embedding, semantic_embedding, user_id→users, created_at, updated_at)
├── relationships (id, from_entity_id→entities, to_entity_id→entities, type, properties, strength, user_id→users, created_at, updated_at)
└── communications (id, from_entity_id→entities, to_entity_id→entities, type, content, sentiment_score, importance_score, embedding, user_id→users, created_at, updated_at)

INTELLIGENCE DOMAIN
├── questions (id, category, text, example_answer_1, example_answer_2, example_answer_3, subcategory, user_id→users, created_at, updated_at)
├── answers (id, rag_answer_1, rag_answer_2, rag_answer_3, give_answer_1, give_answer_2, give_answer_3, user_id→users, question_id→questions, created_at, updated_at)
└── actions (id, title, text, image_url, priority, thread_id→threads, user_id→users, created_at, updated_at)

CONVERSATIONS DOMAIN
├── threads (id, name, model, description, user_id→users, created_at, updated_at, deleted_at)
└── messages (id, model, role, text, mimetype, tool_calls, prompt, canceled, user_id→users, thread_id→threads, prompt_message_id→messages, created_at, updated_at, deleted_at)

CONNECTIONS DOMAIN
├── providers (id, name, created_at, updated_at)
└── connections (id, name, active, schedule, access_token, refresh_token, token_expiry, sync_state, user_id→users, provider_id→providers, created_at, updated_at)

SEARCH DOMAIN
└── tags (id, label, user_id→users, created_at)

FILES DOMAIN
└── files (id, bucket, key, original_name, content_type, size, user_id→users, created_at, updated_at)

ETL DOMAIN
└── api_logs (id, user_id→users, connection_id→connections, scope, content, last_processed, created_at)
    [TimescaleDB hypertable partitioned by created_at and user_id]

DEVICE & ACTIVITY DOMAIN
├── devices (id, type, name, capabilities, privacy_settings, user_id→users, created_at, updated_at)
├── sensors (id, device_id→devices, type, location, configuration, user_id→users, created_at, updated_at)
├── browser_activity (id, device_id→devices, url, title, domain, duration, productivity_score, sentiment, user_id→users, timestamp, created_at)
    [TimescaleDB hypertable partitioned by timestamp and user_id]
├── screen_captures (id, device_id→devices, file_url, ocr_text, ai_analysis, sentiment, privacy_flags, user_id→users, timestamp, created_at)
    [TimescaleDB hypertable partitioned by timestamp and user_id]
├── location_history (id, device_id→devices, latitude, longitude, altitude, accuracy, user_id→users, timestamp, created_at)
    [TimescaleDB hypertable partitioned by timestamp and user_id]
├── keystroke_patterns (id, device_id→devices, pattern_data, analysis, privacy_level, user_id→users, timestamp, created_at)
    [TimescaleDB hypertable partitioned by timestamp and user_id]
├── app_usage (id, device_id→devices, app_name, bundle_id, usage_duration, category, productivity_score, user_id→users, timestamp, created_at)
    [TimescaleDB hypertable partitioned by timestamp and user_id]
└── social_media_activity (id, platform, activity_type, content, engagement_metrics, sentiment, privacy_settings, user_id→users, timestamp, created_at)
    [TimescaleDB hypertable partitioned by timestamp and user_id]

JOB QUEUE DOMAIN
└── pgboss schema (auto-managed job queue tables)
```

## Many-to-Many Relationships (Join Tables)

```
MESSAGE-FILE RELATIONSHIPS
└── message_files (id, message_id→messages, file_id→files, created_at)

TAGGING RELATIONSHIPS
└── action_tag (id, action_id→actions, tag_id→tags, created_at)
    [Note: Tagging system significantly simplified with entity graph approach]
```

## Key Relationships Flow

```
                                    ┌─────────────┐
                                    │    users    │
                                    │ (Core User) │
                                    └─────┬───────┘
                                          │ owns
                ┌─────────────────────────┼─────────────────────────┐
                │                         │                         │
                ▼                         ▼                         ▼
        ┌─────────────┐           ┌─────────────┐           ┌─────────────┐
        │  sessions   │           │    tags     │           │connections  │
        │(Auth/Login) │           │(Tagging)    │           │(External)   │
        └─────────────┘           └─────┬───────┘           └─────┬───────┘
                                        │ tags                    │ syncs
                                        ▼                         ▼
                              ┌─────────────┐              ┌─────────────┐
                              │   Entity    │              │  api_logs   │
                              │    Graph    │              │(ETL Data)   │
                              └─────┬───────┘              └─────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
  ┌──────────┐              ┌─────────────┐              ┌─────────────┐
  │ entities │◄────────────►│relationships│              │communications│
  │(Universal│              │(Typed Links)│              │(Multi-modal)│
  │  Nodes)  │              └─────────────┘              └─────────────┘
  └─────┬────┘                                                 
        │ contains embeddings                                  
        │ (visual, textual, semantic)                         
        ▼                                                     
  ┌──────────┐                                               
  │  Vector  │              DEVICE & ACTIVITY DOMAIN          
  │Embeddings│        ┌─────────────┐    ┌─────────────┐      
  └──────────┘        │   devices   │───►│   sensors   │      
                      └─────┬───────┘    └─────────────┘      
                            │ tracks                          
                            ▼                                 
                   ┌────────────────────────┐                 
                   │   Activity Tracking    │                 
                   │ (TimescaleDB Hypertables)│               
                   └────────┬───────────────┘                 
                            │                                 
        ┌───────────────────┼────────────────────────┐        
        │                   │                        │        
        ▼                   ▼                        ▼        
┌──────────────┐  ┌──────────────┐          ┌──────────────┐  
│browser_      │  │screen_       │          │location_     │  
│activity      │  │captures      │    ...   │history       │  
│(Web Usage)   │  │(Visual Data) │          │(GPS Tracking)│  
└──────────────┘  └──────────────┘          └──────────────┘  

                              INTELLIGENCE DOMAIN
                        ┌─────────────┐    ┌─────────────┐
                        │ questions   │───►│   answers   │
                        └─────────────┘    └─────────────┘
                                │
                                ▼
                        ┌─────────────┐
                        │   actions   │◄──┐
                        │(w/ Priority)│   │
                        └─────────────┘   │ generates
                                          │
                              CONVERSATIONS DOMAIN
                        ┌─────────────┐    │
                        │  threads    │────┘
                        │(AI Chat)    │
                        └─────┬───────┘
                              │ contains
                              ▼
                        ┌─────────────┐    ┌─────────────┐
                        │  messages   │◄──►│message_files│
                        │(Chat Msgs + │    │(File Links) │
                        │ Tool Calls) │    └─────────────┘
                        └─────────────┘
```

## Relationship Cardinalities

```
ONE-TO-MANY RELATIONSHIPS
├── users → sessions (1:N)
├── users → tags (1:N)
├── users → connections (1:N)
├── users → threads (1:N)
├── users → messages (1:N)
├── users → questions (1:N)
├── users → answers (1:N)
├── users → actions (1:N)
├── users → entities (1:N)
├── users → relationships (1:N)
├── users → communications (1:N)
├── users → devices (1:N)
├── users → sensors (1:N)
├── users → browser_activity (1:N)
├── users → screen_captures (1:N)
├── users → location_history (1:N)
├── users → keystroke_patterns (1:N)
├── users → app_usage (1:N)
├── users → social_media_activity (1:N)
├── users → files (1:N)
├── users → api_logs (1:N)
├── providers → connections (1:N)
├── connections → api_logs (1:N)
├── threads → messages (1:N)
├── threads → actions (1:1) [one action per thread]
├── questions → answers (1:N)
├── devices → sensors (1:N)
├── devices → browser_activity (1:N)
├── devices → screen_captures (1:N)
├── devices → location_history (1:N)
├── devices → keystroke_patterns (1:N)
├── devices → app_usage (1:N)
├── entities → relationships (1:N) [as from_entity]
├── entities → relationships (1:N) [as to_entity]
├── entities → communications (1:N) [as from_entity]
├── entities → communications (1:N) [as to_entity]
└── messages → messages (1:N) [self-referencing for prompt/response chains]

MANY-TO-MANY RELATIONSHIPS
├── actions ↔ tags (via action_tag)
└── messages ↔ files (via message_files)

SPECIAL FEATURES
├── Entity Graph: Universal entity system with flexible typed relationships
├── Vector Embeddings: Multi-modal embeddings (visual, textual, semantic) in entities
├── TimescaleDB Hypertables: Time-series optimization for all activity tracking
├── Communication Intelligence: Sentiment analysis and importance scoring
├── Device Integration: Comprehensive IoT and device management with PostGIS
└── Privacy Controls: Granular privacy settings and sensitive content detection
```

## Architecture Notes

```
ENTITY GRAPH SYSTEM
├── Replaces legacy domain-specific tables (people, contacts, places, etc.)
├── Universal node-based architecture with flexible properties
├── Typed relationships with strength scoring (0.0 to 1.0)
├── Multi-modal communications with sentiment analysis
└── Embedded vector search across all entity types

DIGITAL FOOTPRINT TRACKING
├── TimescaleDB hypertables for high-volume activity data
├── Automatic time-based partitioning for performance
├── Real-time sentiment and productivity scoring
├── Privacy-first design with granular controls
└── Multi-device support with capability detection

PRIVACY & SECURITY
├── User-centric design with complete data isolation
├── Sensitive content detection and filtering
├── Granular privacy settings per device and data type
├── Audit trails for all user data access
└── GDPR-compliant data handling patterns

PERFORMANCE OPTIMIZATIONS
├── UUID v7 for time-ordered primary keys
├── HNSW indexing for vector similarity search
├── Specialized indexes for time-series queries
├── Partitioned tables for horizontal scaling
└── Vector transformers for efficient embedding storage
```