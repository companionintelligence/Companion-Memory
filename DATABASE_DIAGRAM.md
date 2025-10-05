# CI-Server Database Entity Relationship Diagram (Text Format)

## Entity Overview by Domain

```
USER DOMAIN
├── users (id, name, email, password, onboarded, created_at, updated_at)
├── signup_code (id, signup_code, used, created_at)
└── sessions (id, token, ip, user_agent, expires_at, user_id→users, created_at, updated_at)

MEMORY DOMAIN
├── people (id, type, first_name, last_name, gender, address..., user_id→users, created_at, updated_at)
├── contacts (id, type, avatar_url, handle, identifier, user_id→users, person_id→people, created_at, updated_at)
├── places (id, type, name, geo_format, geolocation, parent_id→places, user_id→users, created_at, updated_at)
├── locations (id, identifier, datetime, geo_format, geolocation, place_id→places, user_id→users, created_at, updated_at)
├── events (id, type, name, description, start_time, end_time, user_id→users, connection_id→connections, created_at, updated_at)
├── content (id, type, title, text, url, mimetype, user_id→users, event_id→events, created_at, updated_at)
└── things (id, type, name, description, user_id→users, event_id→events, created_at, updated_at)

INTELLIGENCE DOMAIN
├── questions (id, category, text, example_answer_1, example_answer_2, example_answer_3, subcategory, user_id→users, created_at, updated_at)
├── answers (id, rag_answer_1, rag_answer_2, rag_answer_3, give_answer_1, give_answer_2, give_answer_3, user_id→users, question_id→questions, created_at, updated_at)
└── actions (id, title, text, image_url, thread_id→threads, user_id→users, created_at, updated_at)

CONVERSATIONS DOMAIN
├── threads (id, name, model, description, user_id→users, created_at, updated_at, deleted_at)
└── messages (id, model, role, text, mimetype, tool_calls, prompt, canceled, user_id→users, thread_id→threads, prompt_message_id→messages, created_at, updated_at, deleted_at)

CONNECTIONS DOMAIN
├── providers (id, name, created_at, updated_at)
└── connections (id, name, active, schedule, access_token, refresh_token, token_expiry, sync_state, user_id→users, provider_id→providers, created_at, updated_at)

SEARCH DOMAIN
├── tags (id, label, user_id→users, created_at)
└── embeddings (id, model, raw_input, raw_input_hash, entity_type, data_path, entity_id, embedding_vector, user_id→users, created_at)

FILES DOMAIN
└── files (id, bucket, key, original_name, content_type, size, user_id→users, created_at, updated_at)

ETL DOMAIN
└── api_logs (id, user_id→users, connection_id→connections, scope, content, last_processed, created_at)
```

## Many-to-Many Relationships (Join Tables)

```
TAGGING RELATIONSHIPS
├── person_tag (id, person_id→people, tag_id→tags, created_at)
├── contact_tag (id, contact_id→contacts, tag_id→tags, created_at)
├── event_tag (id, event_id→events, tag_id→tags, created_at)
├── content_tag (id, content_id→content, tag_id→tags, created_at)
├── thing_tag (id, thing_id→things, tag_id→tags, created_at)
├── place_tag (id, place_id→places, tag_id→tags, created_at)
├── location_tag (id, location_id→locations, tag_id→tags, created_at)
└── action_tag (id, action_id→actions, tag_id→tags, created_at)

OTHER RELATIONSHIPS
├── thread_file (id, thread_id→threads, file_id→files, created_at)
└── event_person (id, event_id→events, person_id→people, created_at)
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
                              │   Memory    │◄─────────────┤   events    │
                              │   Domain    │              │(Calendar)   │
                              └─────┬───────┘              └─────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
  ┌──────────┐              ┌─────────────┐              ┌─────────────┐
  │  people  │◄────────────►│   places    │              │   content   │
  │(Contacts)│              │(Locations)  │              │(Documents)  │
  └─────┬────┘              └─────┬───────┘              └─────┬───────┘
        │                         │                           │
        │ associated              │ contains                  │ relates
        ▼                         ▼                           ▼
  ┌──────────┐              ┌─────────────┐              ┌─────────────┐
  │ contacts │              │ locations   │              │   things    │
  └──────────┘              └─────────────┘              └─────────────┘

                              INTELLIGENCE DOMAIN
                        ┌─────────────┐    ┌─────────────┐
                        │ questions   │───►│   answers   │
                        └─────────────┘    └─────────────┘
                                │
                                ▼
                        ┌─────────────┐
                        │   actions   │◄──┐
                        └─────────────┘   │
                                          │ generates
                              CONVERSATIONS DOMAIN
                        ┌─────────────┐    │
                        │  threads    │────┘
                        │(AI Chat)    │
                        └─────┬───────┘
                              │ contains
                              ▼
                        ┌─────────────┐
                        │  messages   │
                        │(Chat Msgs)  │
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
├── users → people (1:N)
├── users → contacts (1:N)
├── users → places (1:N)
├── users → locations (1:N)
├── users → events (1:N)
├── users → content (1:N)
├── users → things (1:N)
├── users → files (1:N)
├── users → embeddings (1:N)
├── users → api_logs (1:N)
├── providers → connections (1:N)
├── connections → events (1:N)
├── connections → api_logs (1:N)
├── threads → messages (1:N)
├── questions → answers (1:N)
├── people → contacts (1:N)
├── places → locations (1:N)
├── places → places (1:N) [self-referencing hierarchy]
├── events → content (1:N)
├── events → things (1:N)
└── messages → messages (1:N) [self-referencing for prompt/response]

ONE-TO-ONE RELATIONSHIPS
└── threads ← actions (1:1) [action linked to specific thread]

MANY-TO-MANY RELATIONSHIPS
├── people ↔ tags (via person_tag)
├── contacts ↔ tags (via contact_tag)
├── events ↔ tags (via event_tag)
├── content ↔ tags (via content_tag)
├── things ↔ tags (via thing_tag)
├── places ↔ tags (via place_tag)
├── locations ↔ tags (via location_tag)
├── actions ↔ tags (via action_tag)
├── threads ↔ files (via thread_file)
└── events ↔ people (via event_person)
```