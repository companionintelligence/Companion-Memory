# Companion Memory Architecture

> **Status:** Living document &nbsp;•&nbsp; **Last updated:** 2026-05-22
>
> Technical architecture reference for CI's two-layer memory system: the Companion Memory Database (personal digital twin) and the Agent Memory Provider (adapter layer). See [ci-memory-plan.md](ci-memory-plan.md) for strategy and roadmap.

---

## Section 1: The Two-Layer Model

CI's memory architecture separates two distinct concerns that most competitors conflate:

- **Layer 0** is a full personal data operating system — a user-owned knowledge graph that stores everything the user has ever connected, uploaded, or captured.
- **Layer 1** is an adapter that makes Layer 0 available to AI agents as their persistent memory. It is powered by real personal data, not a shadow copy.

```mermaid
flowchart TB
    subgraph L0["Layer 0 — Companion Memory Database (Personal Digital Twin)"]
        direction TB
        KG["Knowledge Graph\n(Person, Place, Event, Concept,\nContent, Communication, Item)"]
        FILES["Files & Documents\n(chunks + embeddings)"]
        ETL["ETL Ingestion\n(Google, Facebook, more)"]
        BROWSER["Browser Activity"]
        COMMS["Communications\n(threads, messages)"]
        SEARCH["Semantic Search Index\n(pgvector + tsvector)"]
        SUMMARIES["LLM Summaries\n(hourly / daily / weekly)"]
        HBPE["Behavioral Predictions\n(HBPE)"]
        PRIVACY["Privacy & Consent\n(per-category controls)"]
        PROV["Provenance & Audit\n(lineage on every entity)"]
        EXPORT["Data Export\n(JSON portability)"]
    end

    subgraph L1["Layer 1 — Agent Memory Provider"]
        direction TB
        ENDPOINT["POST /v1/memory/context"]
        SVC["AgentContextService\n(semantic search → K-hop → injection)"]
        LOG["AgentContextLogEntity\n(ci.agent_context_log)"]
        HERMES["hermes-companion-memory\n(Python plugin)"]
        OPENCLAW["openclaw-companion-memory\n(TypeScript plugin)"]
        ERMY["ermy-memory-setup.sh\n(API key provisioning)"]
    end

    subgraph CONSUMERS["Consumers"]
        direction LR
        HERMESAGENT["Hermes Agent"]
        OPENCLAWAGENT["OpenClaw Agent"]
        CLAUDE["Claude Code / other agents"]
        WEBSPA["Web SPA (React)"]
        XR["XR / Wearables"]
    end

    ETL --> KG
    BROWSER --> KG
    FILES --> SEARCH
    KG --> SEARCH
    KG --> SUMMARIES
    KG --> HBPE

    L0 --> ENDPOINT
    ENDPOINT --> SVC
    SVC --> LOG
    SVC --> L0

    HERMES --> ENDPOINT
    OPENCLAW --> ENDPOINT
    ERMY --> ENDPOINT

    HERMESAGENT --> HERMES
    OPENCLAWAGENT --> OPENCLAW
    CLAUDE --> ENDPOINT
    WEBSPA --> L0
    XR --> L0
```

The key structural fact: **Layer 1 calls into Layer 0** — it does not replicate data. The injection string that Hermes receives is built directly from the user's real entity graph.

---

## Section 2: Full System Architecture

The complete CI stack, extended to show the agent memory layer and plugin distribution alongside the LifeScope lineage.

```mermaid
flowchart LR
    subgraph CLOUD["Cloudflare Edge"]
        Portal["CI-Portal\n(Workers + D1)\nauth, remote access proxy"]
        Market["CI-Marketplace\n(R2 + D1 app catalog)"]
    end

    subgraph HUB["CI-Hub (User Homeserver)"]
        direction TB
        HubUI["Runtipi UI\n(app launcher)"]
        subgraph SERVER["CI-Server"]
            subgraph APITIER["Application Tier"]
                API["backend/apps/api\nNestJS + Apollo GraphQL + REST"]
                WEB["frontend/apps/web\nReact 19 + Vite + Apollo"]
            end
            subgraph AGENTTIER["Agent Tier"]
                HBPESVC["backend/apps/hbpe\nHierarchical Behavior Prediction\n(Torch + ONNX + Qwen3)"]
                SUMSVC["backend/apps/summary\nTemporal/Daily/Weekly summaries"]
            end
            subgraph DATATIER["Data Tier"]
                PG[("Postgres 16\n+ TimescaleDB\n+ pgvector\n+ Apache AGE\n+ PostGIS")]
                OBJ[("MinIO\nS3-compatible")]
            end
            subgraph ORCH["Orchestration"]
                TEMP["Temporal Server\n(durable workflows)"]
                PGBOSS["PGBoss\n(in-Postgres jobs)"]
            end
        end
        OtherApps["Other Marketplace Apps"]
    end

    subgraph PLUGINS["Agent Plugins (distributed)"]
        HERMES_P["hermes-companion-memory\n(Python, PyPI)"]
        OC_P["openclaw-companion-memory\n(TypeScript, npm)"]
        ERMY_P["ermy-memory-setup.sh\n(post-install provisioner)"]
    end

    subgraph AGENTS["Agent Runtimes"]
        HERMES_A["Hermes Agent"]
        OC_A["OpenClaw Agent"]
        OTHER_A["Custom Agents"]
    end

    subgraph DEVICES["User Devices"]
        Phone["Mobile / Native"]
        XR_D["Glasses, XR, IoT"]
        Browser["Browser Extension"]
    end

    subgraph THIRD["3rd-party Sources"]
        Google
        Facebook
        Microsoft
        Spotify
    end

    subgraph LOCAL["Local LLM"]
        OLLAMA["Ollama\n(embeddings + summaries)"]
    end

    Phone & XR_D & Browser --> Portal
    Portal --> HubUI
    HubUI --> WEB
    Market --> HubUI
    HubUI --> SERVER

    API <--> PG
    API <--> OBJ
    API --> TEMP
    API --> PGBOSS
    API <--> OLLAMA
    API --> Google & Facebook & Microsoft & Spotify

    TEMP --> HBPESVC & SUMSVC
    HBPESVC --> PG
    SUMSVC --> PG & OLLAMA

    HERMES_A --> HERMES_P --> API
    OC_A --> OC_P --> API
    OTHER_A --> API
    ERMY_P --> API

    OtherApps --> API
```

---

## Section 3: Data Model

The entity-relationship diagram covering the knowledge graph, file pipeline, agent context log, and ETL source mapping.

```mermaid
erDiagram
    USER {
        uuid id PK
        text email
        text display_name
        jsonb profile
    }
    ACTOR {
        uuid id PK
        uuid user_id FK
        text actor_type
        text scope_set
    }
    API_KEY {
        uuid id PK
        uuid actor_id FK
        text key_hash
        text[] scopes
        timestamptz expires_at
    }
    CONSENT_PREFERENCE {
        uuid id PK
        uuid user_id FK
        text data_category
        boolean allowed
        timestamptz updated_at
    }
    GRAPH_NODE_ENTITY {
        uuid entity_id PK
        uuid user_id FK
        text entity_type
        text name
        text description
        jsonb properties
        vector embedding
        text memory_kind
        real importance
        real decay_rate
        timestamptz occurred_at
        timestamptz created_at
        timestamptz updated_at
    }
    RELATIONSHIP_ENTITY {
        uuid id PK
        uuid from_entity_id FK
        uuid to_entity_id FK
        text relationship_type
        jsonb properties
        boolean active
        timestamptz created_at
    }
    FILE_ENTITY {
        uuid id PK
        uuid user_id FK
        uuid entity_id FK
        text filename
        text mime_type
        text storage_key
        bigint size_bytes
        timestamptz uploaded_at
    }
    DOCUMENT_CHUNK {
        uuid id PK
        uuid file_id FK
        int chunk_index
        text content
        vector embedding
        jsonb metadata
    }
    FACT {
        uuid id PK
        uuid source_chunk_id FK
        uuid entity_id FK
        text content
        vector embedding
        real confidence
        timestamptz created_at
    }
    ENTITY_PROVENANCE {
        uuid id PK
        uuid entity_id FK
        text source_type
        text source_id
        text etl_provider
        jsonb raw_data_ref
        timestamptz ingested_at
    }
    AUDIT_LOG {
        uuid id PK
        uuid user_id FK
        uuid actor_id FK
        text action
        text resource_type
        uuid resource_id
        jsonb delta
        timestamptz occurred_at
    }
    AGENT_CONTEXT_LOG {
        uuid id PK
        text session_id
        text user_id FK
        text agent_id
        int turn_index
        jsonb messages
        text memory_id
        timestamptz created_at
    }
    SUMMARY_ENTITY {
        uuid entity_id PK
        text granularity
        text narrative
        tstzrange time_range
        timestamptz created_at
    }
    PREDICTION_ENTITY {
        uuid id PK
        uuid user_id FK
        text behavior_type
        jsonb prediction
        real confidence
        timestamptz predicted_for
    }

    USER ||--o{ ACTOR : "has"
    ACTOR ||--o{ API_KEY : "owns"
    USER ||--o{ CONSENT_PREFERENCE : "sets"
    USER ||--o{ GRAPH_NODE_ENTITY : "owns"
    GRAPH_NODE_ENTITY ||--o{ RELATIONSHIP_ENTITY : "from"
    GRAPH_NODE_ENTITY ||--o{ RELATIONSHIP_ENTITY : "to"
    GRAPH_NODE_ENTITY ||--o| FILE_ENTITY : "backed by"
    GRAPH_NODE_ENTITY ||--o{ ENTITY_PROVENANCE : "has"
    GRAPH_NODE_ENTITY ||--o{ FACT : "contains"
    FILE_ENTITY ||--o{ DOCUMENT_CHUNK : "chunked into"
    DOCUMENT_CHUNK ||--o{ FACT : "extracted into"
    USER ||--o{ AGENT_CONTEXT_LOG : "logs"
    USER ||--o{ SUMMARY_ENTITY : "has"
    USER ||--o{ PREDICTION_ENTITY : "has"
    USER ||--o{ AUDIT_LOG : "generates"
```

### ETL Source to Entity Type Mapping

| ETL Source | Entity Types Created | Relationship Types |
|---|---|---|
| Google Contacts | `Person` | `KNOWS`, `HAS_EMAIL`, `HAS_PHONE` |
| Facebook Friends | `Person` | `KNOWS`, `FACEBOOK_FRIEND` |
| Facebook Profile | `Person` (self), `Place` | `LIVES_IN`, `WORKED_AT`, `STUDIED_AT` |
| Browser Activity | `Content` (URL), `Concept` (topic) | `VISITED`, `INTERESTED_IN` |
| File Upload | `Content`, `Concept` | `CONTAINS`, `ABOUT` |
| Calendar (future) | `Event`, `Person` | `ATTENDED`, `ORGANIZED_BY` |
| Spotify (future) | `Concept` (artist/genre) | `LISTENS_TO`, `LIKES` |

---

## Section 4: Agent Integration Flow

End-to-end sequence from user setup through a live agent session with personal context injection.

```mermaid
sequenceDiagram
    participant U as User
    participant ERMY as ermy-memory-setup.sh
    participant CI as CI-Server API
    participant HPLUGIN as hermes-companion-memory
    participant HERMES as Hermes Agent Runtime
    participant LLM as LLM (local/remote)

    Note over U,CI: Setup (once per install)
    U->>ERMY: run post-install script
    ERMY->>CI: POST /v1/auth/api-keys (scopes: agent_memory:write)
    CI-->>ERMY: {api_key: "ci_..."}
    ERMY->>U: write COMPANION_API_KEY to env

    Note over HERMES,HPLUGIN: Session start
    HERMES->>HPLUGIN: is_available()
    HPLUGIN-->>HERMES: true (COMPANION_API_KEY set)
    HERMES->>HPLUGIN: initialize()
    HPLUGIN->>HPLUGIN: create CompanionClient, generate session_id UUID

    Note over U,LLM: First turn
    U->>HERMES: user message
    HERMES->>HPLUGIN: prefetch(query)
    HPLUGIN->>CI: POST /v1/memory/context {session_id, messages}
    CI->>CI: semantic search (pgvector, cosine >= 0.65, max 8 seeds)
    CI->>CI: K-hop=1 expansion via GraphQueryService
    CI->>CI: format injection string (<=1200 tokens, seeds first)
    CI-->>HPLUGIN: {injection, memoryId, entitiesUsed}
    HPLUGIN-->>HERMES: injection string
    HERMES->>LLM: [system: injection + base_prompt][user: message]
    LLM-->>HERMES: response grounded in personal context
    HERMES-->>U: response

    Note over HERMES,CI: After each turn (non-blocking)
    HERMES->>HPLUGIN: sync_turn(user_content, assistant_content)
    HPLUGIN->>HPLUGIN: spawn daemon thread (join prev with 5s timeout)
    HPLUGIN-->>HERMES: returns immediately
    HPLUGIN->>CI: POST /v1/memory/context {session_id, turn_index, messages}
    CI->>CI: persist to ci.agent_context_log
    CI-->>HPLUGIN: 200 OK

    Note over HERMES,CI: Session teardown
    HERMES->>HPLUGIN: on_session_end()
    HPLUGIN->>CI: POST /v1/memory/context {messages: [{role:system, content:__session_end__}]}
```

---

## Section 5: User Flow — Setup and Data Ingestion

How a new user builds their personal memory database from scratch.

```mermaid
flowchart TD
    START([User installs CI-Hub]) --> SIGNUP[Create account\nonboarding domain]
    SIGNUP --> ERMY[Run ermy-memory-setup.sh\nProvision agent_memory:write API key]
    ERMY --> SOURCES{Connect data sources}

    SOURCES --> GOOGLE[Connect Google\nOAuth via connections domain]
    SOURCES --> FACEBOOK[Connect Facebook\nOAuth via connections domain]
    SOURCES --> UPLOAD[Upload files\nfiles domain]
    SOURCES --> BROWSER[Install browser extension\nbrowser-activity domain]
    SOURCES --> MANUAL[Manual entry\nnotes / memory domain]

    GOOGLE --> ETL_G[ETL: Google Contacts transform\nPerson entities + provenance records]
    FACEBOOK --> ETL_F[ETL: Facebook Friends + Profile\nPerson + Place entities + provenance]

    UPLOAD --> PARSE[DocumentParserService\ntext extraction]
    PARSE --> CHUNK[Chunking ~512 token windows]
    CHUNK --> EMBED_F[Embed chunks via Ollama]
    EMBED_F --> STORE_C[Store: document_chunks + pgvector embedding]
    STORE_C --> FACTS[Extract facts: chunk to fact entities]

    BROWSER --> BA[Browser activity ingest\nContent + Concept entities]

    ETL_G --> EMBED_E[Embed entities via Ollama]
    ETL_F --> EMBED_E
    BA --> EMBED_E
    FACTS --> EMBED_E
    MANUAL --> EMBED_E

    EMBED_E --> PGVECTOR[(pgvector embedding index)]
    EMBED_E --> AGE[(Apache AGE graph store)]
    EMBED_E --> TSVECTOR[(tsvector keyword index)]

    AGE --> SUMMARIES[summary-service\nhourly to daily to weekly\nLLM narrative generation]
    AGE --> HBPE_T[HBPE nightly training\nbehavioral prediction model]

    SUMMARIES --> AGE
    HBPE_T --> PREDICTIONS[(ci.predictions)]
```

---

## Section 6: User Flow — Query and Retrieval

How queries travel through both layers across three access patterns.

```mermaid
flowchart LR
    subgraph PATTERNS["Access Patterns"]
        direction TB
        P1["Agent prefetch\n(passive, automatic)"]
        P2["MCP tool call\n(agent-driven, explicit)"]
        P3["User search\n(UI-driven)"]
    end

    subgraph LAYER1["Layer 1: Agent Memory API"]
        EP["POST /v1/memory/context\nAgentContextController"]
        SVC["AgentContextService\nsemantic search to K-hop to injection"]
        LOG_T["ci.agent_context_log"]
    end

    subgraph LAYER0["Layer 0: Personal Database"]
        SEARCH_SVC["SearchService\npgvector + tsvector hybrid"]
        GRAPH_SVC["GraphQueryService\nK-hop expansion, Apache AGE"]
        ENTITY_IDX[("Entity index\npgvector embeddings")]
        GRAPH_DB[("Knowledge graph\nApache AGE")]
        CHUNK_IDX[("Chunk index\nDocument embeddings")]
    end

    P1 -->|prefetch| EP
    EP --> SVC
    SVC --> LOG_T
    SVC --> SEARCH_SVC
    SEARCH_SVC --> ENTITY_IDX
    SEARCH_SVC --> CHUNK_IDX
    SVC --> GRAPH_SVC
    GRAPH_SVC --> GRAPH_DB
    EP -->|injection string| P1

    P2 -->|tool: search_memory| SEARCH_SVC
    P2 -->|tool: list_relationships| GRAPH_SVC

    P3 -->|GraphQL / REST| SEARCH_SVC
    P3 -->|GraphQL graph query| GRAPH_SVC
```

---

## Section 7: Permissioning and Identity Model

CI's multi-actor identity model controls what each caller can read and write.

```mermaid
flowchart TB
    USER["User\n(human account)"]

    subgraph ACTORS["Actors (scoped principals)"]
        UA["user-actor\n(full access via UI)"]
        AA["agent-actor\n(scoped agent access)"]
        DA["device-actor\n(scoped device access)"]
    end

    subgraph APIKEYS["API Keys (per actor)"]
        KEY1["user API key\nscopes: *"]
        KEY2["agent API key\nscopes: agent_memory:write\n        search:read, entities:read"]
        KEY3["device API key\nscopes: measurements:write\n        position:write"]
    end

    subgraph CONSENT["Consent Preferences (per data category)"]
        C1["contacts: allowed"]
        C2["browser_history: allowed"]
        C3["location: denied"]
        C4["communications: allowed"]
    end

    subgraph GUARDS["Auth Guards (NestJS)"]
        G1["JwtOrApiKeyAuthGuard\n(resolves actor + userId)"]
        G2["ScopesGuard\n(checks key scopes)"]
        G3["ConsentGuard\n(checks data category)"]
    end

    USER --> UA & AA & DA
    UA --> KEY1
    AA --> KEY2
    DA --> KEY3
    USER --> C1 & C2 & C3 & C4

    KEY2 -->|X-CI-API-Key header| G1
    G1 -->|resolved actor| G2
    G2 -->|scope check passes| G3
    G3 -->|consent check passes| API["API endpoint"]
    C3 -->|location data blocked even with valid key| G3
```

### Scope Reference

| Scope | Who holds it | What it grants |
|---|---|---|
| `agent_memory:write` | Agent actor API keys | POST /v1/memory/context |
| `search:read` | Agent actor API keys (v2) | GET /v1/search endpoints |
| `entities:read` | Agent actor API keys (v2) | GET /v1/entities/* |
| `measurements:write` | Device actor API keys | POST measurements |
| `position:write` | Device actor API keys | POST position updates |
| `*` | User actor API keys | All endpoints |
| `export:read` | User actor, explicit | GET /v1/export |
| `erasure:write` | User actor, explicit | POST /v1/privacy/erasure |

---

## Section 8: Comparison Matrix — Personal Memory Database

How CI's Layer 0 compares to the personal data and digital twin landscape.

| Dimension | CI | LifeScope | Solid/Pods | Apple Intelligence | Olares | Rewind/Limitless |
|---|---|---|---|---|---|---|
| Local-first | ✅ self-hosted Hub | ❌ cloud (AWS) | ✅ pod-hosted | ✅ on-device | ✅ local appliance | ❌ cloud |
| User-owned data | ✅ | ✅ | ✅ | ⚠️ Apple ecosystem | ✅ | ❌ now Meta |
| Primary data atom | Entity (typed, tiered) | Event (datetime, type, context) | RDF triple | Unspecified | Unspecified | Capture frame |
| Database | Postgres + AGE + pgvector | MongoDB (UUID arrays as edges) | RDF store | On-device index | Kubernetes PVC | Proprietary |
| Relationship model | Graph edges (traversable) | UUID arrays (resolved via hydration) | RDF predicates | None | None | None |
| Identity resolution | Multi-actor + ML dedup planned | Manual Contact→People grouping | Manual | Apple ID only | Manual | None |
| Tag / classification | memory_kind + properties | tagMasks (source/added/removed) | RDF types | Unspecified | None | Timeline labels |
| Knowledge graph | ✅ Apache AGE | ❌ MongoDB doc store | ⚠️ RDF triples | ❌ flat index | ❌ | ❌ timeline only |
| AI/LLM built-in | ✅ Ollama + summaries | ❌ | ❌ | ✅ Apple only | ⚠️ 3rd-party | ❌ |
| Summarization | ✅ hourly/daily/weekly | ❌ | ❌ | ⚠️ limited | ❌ | ❌ |
| Multi-source ETL | ✅ Google, Facebook, more | ✅ 15+ connectors | ❌ manual | ❌ | ❌ | ❌ capture only |
| ETL deduplication | Upsert by hash + provenance | Upsert by hash only | N/A | N/A | N/A | N/A |
| Agent API / MCP | ✅ Layer 1 + MCP server | ❌ | ❌ | ❌ | ❌ | ❌ |
| Vector search | ✅ pgvector (HNSW, 1536-dim) | ❌ | ❌ | ✅ private | ❌ | ❌ |
| Graph traversal | ✅ K-hop via AGE Cypher | ❌ | ⚠️ SPARQL | ❌ | ❌ | ❌ |
| Sensor hypertables | ✅ TimescaleDB | ❌ | ❌ | ⚠️ HealthKit | ❌ | ❌ |
| Provenance tracking | ✅ entity_provenance + ingest_runs | ❌ | ❌ | ❌ | ❌ | ❌ |
| Portability | ✅ streaming JSONL (.cta) | ✅ (basic) | ✅ | ⚠️ limited | ⚠️ | ❌ |
| Privacy controls | ✅ per-category + per-agent | ❌ | ✅ | ⚠️ Apple-controlled | ⚠️ | ❌ |
| Predictive layer | ✅ HBPE (Torch + ONNX) | ❌ | ❌ | ⚠️ limited | ❌ | ❌ |
| Skills / automation | ✅ deterministic + LLM skills | ❌ | ❌ | ⚠️ Shortcuts | ❌ | ❌ |
| VR / AR views | ✅ CI-Spatial-Companion | ✅ LifeScope-XR (A-Frame) | ❌ | ❌ | ❌ | ❌ |
| Browser extension | ✅ CI-Browser-Extension | ✅ LifeScope-Browser-Extension | ❌ | ❌ | ❌ | ❌ |
| Open source | ✅ | ✅ | ✅ | ❌ | ⚠️ partial | ❌ |
| Open protocol | ✅ GraphQL + REST + MCP | ❌ | ✅ Solid spec | ❌ | ❌ | ❌ |

---

## Section 9: Comparison Matrix — Agent Memory Provider

How CI's Layer 1 compares to the agent memory market.

| Dimension | CI (Layer 1) | Mem0 | Honcho | Letta/MemGPT | Zep/Graphiti | Supermemory | Cognee |
|---|---|---|---|---|---|---|---|
| Hermes plugin | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| OpenClaw plugin | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Local-first | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cloud-first option | ⚠️ via Portal | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Graph-based | ✅ Apache AGE | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Bi-temporal | ❌ planned | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| K-hop traversal | ✅ K=1 live | ❌ | ❌ | ❌ | ✅ | ❌ | ⚠️ |
| Predictive injection | ⚠️ HBPE v3 | ❌ | ⚠️ user model | ❌ | ❌ | ❌ | ❌ |
| Backs real personal DB | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Open source | ✅ | ✅ 41K stars | ✅ | ✅ | ✅ | ✅ | ✅ |
| Funding | — | $24M / ~$150M val | $5.35M | $10M | — | $3M | $7.5M |
| Active development | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Key differentiator:** every competitor stores agent conversation summaries and extractions. CI's agent memory is backed by the user's actual contacts, documents, browser history, and relationship graph. The injection for a question about a person draws from a real contact record with typed relationship edges — not from a prior conversation where that person happened to be mentioned.

---

## Section 10: LifeScope to CI Evolution

CI is the AI-native successor to LifeScope Labs. The core thesis is identical; the implementation is rebuilt from the ground up for local-first, AI-native operation.

### 10.1 LifeScope's Data Model

LifeScope organized personal data around six core object types:

| Object | Description |
|---|---|
| **Events** | The primary atom. Every user action (sent message, listened to song, visited webpage, made purchase) becomes an Event with `datetime`, `type`, and `context` fields. All activity normalized into this single type. |
| **Content** | Digital objects attached to events: images, videos, files, web pages, emails — each with `mimetype`, `text`, `title`, `url`. |
| **Contacts** | Per-handle objects: each social-media handle or email address is a *separate* Contact record. A **People** layer let users manually group handles belonging to the same real person. |
| **Locations** | Four subtypes: (1) provider-recorded (GPS from fitness app), (2) app-tracked (in-session coords), (3) uploaded GeoJSON, (4) **estimated** — a background worker backfilling location onto events with no native geotag by nearest timestamp match. |
| **Connections** | OAuth credentials for a specific provider — one row per provider per user. |
| **Saved Searches** | Persistent, named search queries as first-class persistent objects. |

**tagMasks** were a three-way tagging model applied to Events and Content: `source` (tags the platform assigned), `added` (tags the user added), `removed` (tags the user explicitly stripped). The effective tag set was `(source ∪ added) \ removed`.

### 10.2 LifeScope's Technical Stack

| Component | Technology | Notes |
|---|---|---|
| **Backend API** | Node.js + `graphql-compose-mongoose` | Auto-generated GraphQL from Mongoose schema definitions |
| **Database** | **MongoDB** | Relationships modeled as UUID arrays inside documents, resolved via GraphQL hydration at query time — **not** traversable graph edges |
| **Frontend** | Vue.js / Nuxt.js SPA | Views: Feed, List, Map, Gallery, Timeline, VR (A-Frame / WebXR), AR |
| **ETL** | Separate Node.js service | Per-provider scripts; upsert-by-hash deduplication |
| **Hosting** | AWS (cloud) | Not local-first; user data on LifeScope's servers |
| **LifeScope-XR** | A-Frame / WebXR | VR/AR memory palace for spatial browsing of personal history |
| **LifeScope-Voice** | Conversational interface | Natural-language querying of the archive |
| **LifeScope-Browser-Extension** | Browser extension | Passive capture of visited pages and interactions |

### 10.3 The Ten LifeScope Limitations CI Addresses

| # | LifeScope Limitation | CI Response |
|---|---|---|
| 1 | **No intelligence layer** — retrieval-only; never reasoned over data | LLM summarization pipeline (hourly/daily/weekly via Ollama) |
| 2 | **Manual identity resolution** — Contact→People grouping was manual, no ML deduplication | Multi-actor model; ML cross-handle dedup planned |
| 3 | **MongoDB, not a graph DB** — relationships were UUID arrays, not traversable edges | Postgres + Apache AGE (native Cypher graph traversal) |
| 4 | **No AI / LLM integration anywhere** | Ollama local LLM; multi-provider routing (OpenAI, Anthropic) planned |
| 5 | **No agent / MCP surface** — data was for the user's eyes via SPA only | MCP server (stdio + streamable HTTP), GraphQL subscriptions, SSE |
| 6 | **No vector search / semantic embeddings** | pgvector HNSW (1536-dim nomic-embed-text); hybrid keyword + semantic retrieval |
| 7 | **No predictive layer** | HBPE (PyTorch + ONNX + Qwen3); nightly train + INT8 inference; Prediction entities |
| 8 | **No privacy / consent API** | agent_access_policies + consent receipts + PII redaction at egress (plan 09) |
| 9 | **No provenance tracking** | entity_provenance + ingest_runs + DERIVED_FROM edges (plan 08) |
| 10 | **Cloud-hosted on AWS, not local-first** | Docker Compose on CI-Hub; user owns hardware; data never leaves without consent |

### 10.4 Timeline

```mermaid
timeline
    title From LifeScope to Companion Intelligence
    section 2015 to 2018
        LifeScope founded : The Internet of You
            : 15+ OAuth connectors (Facebook, Twitter, Google, Spotify, GitHub, Instagram, Pinterest)
            : MongoDB + GraphQL cloud stack
            : Feed, Map, Timeline views
            : VR and AR exploration surfaces
    section 2019 to 2021
        LifeScope sunset : Unsustainable as a SaaS product
            : No AI layer to make data actively useful
            : Cloud-hosted — structural trust problem
            : Data rich, insight poor
    section 2022 to 2024
        Companion Intelligence conception : What LifeScope needed was AI
            : Local-first architecture (Hub model)
            : Postgres + pgvector + Apache AGE
            : LLM summarization layer
            : Behavioral prediction (HBPE)
    section 2025 to 2026
        CI-Server built : NestJS + Postgres stack fully operational
            : ETL for Google Contacts, Facebook Friends and Profile
            : DocumentParserService (chunk + embed pipeline)
            : Agent memory API Layer 1 (Hermes + OpenClaw plugins)
            : Privacy, consent, portability, provenance domains
            : MCP tool surface for agent access
```

### Feature-by-Feature Evolution

| LifeScope capability | CI equivalent | What CI adds |
|---|---|---|
| **Event** as primary atom (datetime, type, context) | Entity graph with `memory_kind=episodic` | Episodic/semantic/procedural/reflective tiers; importance + decay scoring |
| **Content** (mimetype, text, title, url) | `Content` entity + `files` domain | DocumentParserService: text extraction → chunking → embedding → fact pipeline |
| **Contacts** (per-handle) + People (manual grouping) | `Person` entity + multi-actor model | ML cross-handle dedup planned; actors model every principal (user/agent/device) |
| **Locations** 4 subtypes incl. estimated backfill | `position` TimescaleDB hypertable | Sub-second hypertable writes; XR relative coords + headpose; estimated backfill via ETL promote |
| **Connections** (OAuth credentials per provider) | `connections` domain + OAuth clients | Provenance-recording promote pipeline; `ingest_runs` with rollback |
| **Saved Searches** (first-class persistent objects) | Skill kind: deterministic query (planned) | Versioned, user-installable, invoked via MCP or GraphQL |
| **tagMasks** (source / added / removed) | Entity `properties` JSONB + memory kind | Formal memory tiering replaces manual tag bookkeeping |
| OAuth ETL connectors (15+ providers) | `domains/etl` (Google, Facebook; expanding) | Provenance recording on every transform; entity graph vs. document store |
| MongoDB document store (UUID arrays as edges) | Postgres + Apache AGE + pgvector | Real graph traversal (Cypher) + vector search in one database |
| `graphql-compose-mongoose` auto-generated GraphQL | NestJS Apollo GraphQL + REST | Scoped API keys, multi-actor system, MCP tool surface, GraphQL subscriptions |
| Feed / Map / Timeline / Gallery views | Web SPA (React 19 + 3D force-graph + Leaflet) | Graph visualization, semantic search, document search, entity timeline |
| VR / AR views (LifeScope-XR, A-Frame / WebXR) | CI-Spatial-Companion, CI-XR-Scan | `position` hypertable with relative coords and headpose for AR; PostGIS |
| LifeScope-Voice (conversational interface) | `domains/intelligence` Q&A surface | Full LLM-backed conversation with tool dispatch (voice mode in plan 16) |
| LifeScope-Browser-Extension | CI-Browser-Extension (`browser-activity` domain) | Captures to entity graph with provenance; feeds semantic search index |
| No AI | Ollama LLM integration | Hourly/daily/weekly summaries, entity embeddings (nomic-embed-text 1536-dim) |
| No predictions | HBPE (Torch + ONNX + Qwen3) | Nightly train + INT8 inference; `Prediction` entities in graph |
| No agent surface | MCP server + Layer 1 agent memory API | Hermes + OpenClaw plugins; `ci.memory.*` MCP tools; K-hop injection |
| No privacy controls | `domains/privacy`, `domains/consent` | Per-category consent, right-to-erasure, agent_access_policies, consent receipts |
| No provenance | `entity_provenance` + `ingest_runs` | Full lineage on every entity; `DERIVED_FROM` edges; rollback via `rollback_at` |
| No portability | `domains/export` (plan 11) | Streaming JSONL + Parquet CI Twin Archive (.cta) with age encryption |
| Cloud-hosted on AWS | CI-Hub (Runtipi-based homeserver) | User owns hardware; data never leaves without explicit consent; Docker Compose |

---

## Section 11: CI Differentiation Summary

```mermaid
quadrantChart
    title Personal Memory and Agent Memory Positioning
    x-axis Cloud-first --> Local-first
    y-axis Agent-specialized --> Full personal database
    quadrant-1 Local + Full DB (CI target quadrant)
    quadrant-2 Local + Agent-only
    quadrant-3 Cloud + Agent-only
    quadrant-4 Cloud + Full DB
    CI: [0.85, 0.85]
    LifeScope: [0.15, 0.70]
    Solid/Pods: [0.75, 0.65]
    Apple Intelligence: [0.65, 0.55]
    Olares: [0.80, 0.35]
    Mem0: [0.10, 0.10]
    Honcho: [0.10, 0.20]
    Letta: [0.15, 0.15]
    Zep: [0.05, 0.25]
    Supermemory: [0.08, 0.10]
    Cognee: [0.12, 0.20]
```

### The Unique Quadrant

CI occupies the **upper-right quadrant** — local-first, full personal database — which is currently empty of well-funded, AI-native competitors.

- **Cloud + agent-only** (Mem0, Honcho, Letta, Zep): large funding, fast traction, but no personal data moat; vulnerable to consolidation by foundation model providers who can add memory natively
- **Local + agent-only**: no significant player
- **Cloud + full DB** (LifeScope's original position): shuttered; the cloud trust problem is structural and worsens as privacy regulation expands
- **Local + full DB** (CI): defensible data flywheel + structural privacy advantage + agent API as a natural output of owning the data

The long-term winner in personal AI is whoever owns the personal data layer — not whoever builds the best memory summarizer on top of someone else's conversation history. The agent memory layer is table stakes for owning the personal data layer; it is not the moat itself.
