# CI-Server GraphQL API Reference

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

The memory-brain GraphQL surface of CI-Server: a single Apollo/NestJS endpoint exposing the personal database (events, communications, content, inventory, browser activity, files, notes, threads), the knowledge graph (entities, relationships, identifiers), intelligence (questions, answers, actions, summaries), cross-entity search, saved searches, connectors/providers, and the HBPE forecast. Auth and conventions are in [auth-and-conventions.md](auth-and-conventions.md); REST surfaces in [rest.md](rest.md).

- **Schema (source of truth):** `backend/apps/api/src/domains/graphql/__generated__/schema.graphql` — **54 queries, 68 mutations, ~160 types**, code-first generated from resolver decorators (`autoSchemaFile`, `index.ts:71`). **Do not edit it by hand.** (Counts drift as resolvers are added; the SDL is authoritative.)

---

## 1. Endpoint & how to call it

| Property | Value | Source |
|---|---|---|
| Path (backend) | `POST /graphql` | Apollo driver mount (`index.ts:69-76`) |
| Path (browser, same-origin) | `POST /api/graphql` | `frontend/apps/web/src/api/ApolloProvider.tsx:23` |
| Method | `POST` (JSON). `GET /graphql` serves the playground HTML, not the API | `GraphQLController.ts:12-15` |
| Content-Type | `application/json` | |
| Engine | Apollo Server via `@nestjs/apollo` `ApolloDriver` | `index.ts:69-70` |
| Introspection | **Enabled** | `index.ts:74` |
| Playground | Apollo Playground **disabled**; a static `playground.html` is served at `GET /graphql` | `index.ts:73,75` |
| Schema sorting | `sortSchema: true` (alphabetical SDL) | `index.ts:72` |
| Body-size limit | **10 MB** for `/graphql` (default elsewhere is 100 KB) | `common/middleware/BodyParserMiddleware.ts:19,55-64` |
| Query-complexity limit | **150** — exceeding returns `BAD_REQUEST`/400 | `plugins/ComplexityPlugin.ts:43-54`; `config/default.json:95-96` |
| HTTP batching | Not configured. Batch by sending **list mutations** (§4), not array-of-operations POSTs | |

**Body limit:** `main.ts` boots with `bodyParser: false`; `BodyParserMiddleware` special-cases the `/graphql` path (Apollo mounts via `app.use()`, so `@BodyLimit` metadata is undefined) and raises the limit to `10mb` — this is what lets the importer push thousands of items per bulk mutation.

**Complexity:** every operation is scored once (default 1/field); over `config.graphql.maxQueryComplexity` (**150**) it throws `extensions.code = 'BAD_REQUEST'`, `http.status = 400`. Deeply nested connection queries can hit this — page instead of over-nesting.

Request/response envelope is standard GraphQL-over-HTTP:
```json
{ "query": "query($first:Int){ events(first:$first){ totalCount } }", "variables": { "first": 10 } }
```
→ `{ "data": { ... }, "errors": [ ... ] }`. The web app uses Apollo Client with an `authLink` setting `Authorization: Bearer <token>`, posting to same-origin `/api/graphql` (the proxy strips `/api`).

---

## 2. Auth & context

**Every resolver class is guarded** by `@UseGuards(JwtOrApiKeyAuthGuard)` — there are no unguarded resolvers; unauthenticated → 401 surfaced as a GraphQL error. Accepted credentials (any one): **JWT Bearer** (`Authorization: Bearer`), **API key** (`x-api-key`), or **Portal OIDC Bearer** (when `auth.portal.enabled`). See [auth-and-conventions.md](auth-and-conventions.md) for the full model.

`userId` reaches resolvers via an `AsyncLocalStorage` request context: each strategy calls `ContextService.set({ userId })`; resolvers read it with `@Context()` and convert with `toServiceContext(context)`, which **throws `UnauthorizedException` if `userId` is missing**. Services then scope every query to `user.id = context.userId`.

**Owner-scope nuance:** lazily-resolved sub-fields (media, location, people, tags) are scoped to the **node's owner** via `entityOwnerScope(context, parent.__source.userId)` — a no-op when owner == viewer, but it keeps shared-search result nodes resolving.

**The one non-viewer path:** `sharedSavedSearch(token)` and `search(input:{shareToken})` resolve a public saved search **as its owner** (viewer filters ignored; only paging/sort carry over), behind the auth guard **and** the `shared.search` feature flag. Unknown/revoked tokens → `null`/empty, never the owner's data leaking a token.

---

## 3. Query catalog

### 3.1 The canonical paginated-list pattern (Relay-style connections)

Every plural list query returns a **`*Connection`** implementing:
```graphql
interface Connection { edges: [Edge!]!  pageInfo: PageInfo!  totalCount: Int! }
interface Edge { cursor: String!  node: Node! }
type PageInfo { hasNextPage: Boolean!  hasPreviousPage: Boolean!  startCursor: String  endCursor: String }
```

**Arguments:** the four Relay cursor args `first: Int, after: String, last: Int, before: String`. Forward (`first`/`after`) and backward (`last`/`before`) are **mutually exclusive** — mixing them throws (`Paginator.ts:25-27`).

**Cursors are node ids.** For standard entity lists `cursor == node.id`, a **`GlobalUID`**: `base64("<type>:<uuid>")` (e.g. `event:018f…` → `ZXZlbnQ6MDE4Zj…`).

> **Important — the generic lists are in-memory paginated.** `events`, `people`, `answers`, … call `service.findAll(context)` (fetching **all** the user's rows) then slice in memory (`Paginator.paginate`). So `totalCount` = full set size, and these lists are **not** server-side date/type-filtered. **For filtered/sorted retrieval use the dedicated `search` query (§3.7)**, which pushes filters to SQL with a time-ordered keyset cursor.

```graphql
query Events($first: Int, $after: String) {
  events(first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { cursor node { id title startTime location { name } } }
  }
}
```

**Exceptions to the plain 4-arg pattern:** `connectionSyncJobs` adds `connectionId/endpointName/type` filters; `search` takes `SearchInput` and returns a union-node connection with an opaque time cursor; `feedActions(limit)`, `forecast(horizon)`, `knownPlaces(kind)`, `eventTypes`, `eventSources`, `knownPlaceCandidates` return **plain lists/objects**, not connections.

### 3.2 Memory domain

| Query | Return | Notes |
|---|---|---|
| `events` / `event(id)` | `EventConnection!` / `EventType` | timeline events; media, location, participants |
| `eventTypes` | `[String!]!` | distinct `event_type` values (the "how" filter) |
| `eventSources` | `[String!]!` | distinct `source_system` connectors present |
| `communications` / `communication(id)` | `CommunicationConnection!` / `CommunicationType` | `from: PersonType`, `to: PersonConnection` |
| `contents` / `content(id)` | `ContentConnection!` / `ContentType` | rich content, optional `event` link |
| `items` / `item(id)` | `ItemConnection!` / `ItemType` | inventory; each may link a `file` |
| `browserActivities` / `browserActivity(id)` | `BrowserActivityConnection!` / `BrowserActivityType` | page visits |
| `files` / `file(id)` | `FileConnection!` / `FileType` | `items` back-ref, `previewUrl` |
| `notes` / `note(id)` | `NoteConnection!` / `NoteType` | |
| `places` / `place(id)` | `PlaceConnection!` / `PlaceType` | Location entities |
| `people` / `person(id)` | `PersonConnection!` / `PersonType` | Person entities |

### 3.3 Conversations

`threads` / `thread(id)` → `ThreadConnection!` / `ThreadType` (`messages: MessageConnection`). No top-level `messages` query; `MessageType` is reachable via `node`.

### 3.4 Graph domain

| Query | Return | Notes |
|---|---|---|
| `relationships` / `relationship(id)` | `RelationshipConnection!` / `RelationshipType` | directed edges `(fromNode, toNode, type)` |
| `concepts` / `concept(id)` | `ConceptConnection!` / `ConceptType` | Concept entities |

Entities surface as the typed `PersonType`/`PlaceType`/`ConceptType` lists (rows in `ci.entities`). Identifiers (email/phone) back people-linking but aren't directly queryable.

### 3.5 Intelligence

| Query | Return | Notes |
|---|---|---|
| `questions` / `question(id)` | `QuestionConnection!` / `QuestionType` | |
| `answers` / `answer(id)` | `AnswerConnection!` / `AnswerType` | `question: QuestionType!` (DataLoader) |
| `actions` / `action(id)` | `ActionConnection!` / `ActionType` | conversation-starter / suggestion cards |
| `feedActions(limit: Int! = 5)` | `[ActionType!]!` | feed, unseen-first — not a connection |
| `summaries` / `summary(id)` | `SummaryConnection!` / `SummaryType` | daily/period rollups |

### 3.6 Connections / providers / sync jobs

| Query | Return | Notes |
|---|---|---|
| `connections` / `connection(id)` | `ConnectionConnection!` / `ConnectionType` | connector instances |
| `providers` / `provider(id)` | `ProviderConnection!` / `ProviderType` | connector catalog |
| `connectionSyncJobs(connectionId, endpointName, type, …)` / `connectionSyncJob(id)` | `ConnectionSyncJobConnection!` / … | **filterable** sync-job history |
| `oAuthCallbackUrl` | `String!` | the server's OAuth redirect URL |

### 3.7 Search & saved searches

`search(input: SearchInput!): SearchResultConnection!` — the primary retrieval API; combinable filters, all AND-ed (LifeScope parity), candidate-set + post-filter design.

**`SearchInput`** (all optional): `query` (full-text/semantic), `semantic` (force embedding rank), `tags`, `includeTypes`/`excludeTypes`, `eventTypes` ("how"), `connectors` (source_system), `people` ("who"), `places` ("where"), `hasLocation`, `bbox` (`[minLon,minLat,maxLon,maxLat]`), `startTime`/`endTime` (ISO), `sortBy`(`relevance|time|name`)/`sortOrder`, `first`/`after` (default 30, max 100), `shareToken`.

**Candidate source:** `query` → search index (ranked); else `tags` → tag membership; else **timed** (recent events + communications + browser activity merged, with a `(time,id)` keyset cursor pushed to SQL). Remaining filters AND-ed as post-filters; who/where/connector restrict to matching events. **Cursor:** opaque `base64("<iso-time>::<globalId>")`. Node is the `SearchResultType` union (§5).

```graphql
query Search($input: SearchInput!) {
  search(input: $input) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { cursor node {
      __typename
      ... on EventType { id title startTime }
      ... on CommunicationType { id subject time from { name } }
      ... on NoteType { id title }
    } }
  }
}
# variables: { "input": { "query": "invoice", "includeTypes": ["event","communication"], "startTime": "2026-01-01T00:00:00Z", "first": 30 } }
```

**Saved searches:** `savedSearches` / `savedSearch(id)` → `SavedSearchConnection!` / `SavedSearchType`; `sharedSavedSearch(token: String!)` → owner-resolved, flag-gated, token never echoed.

### 3.8–3.11 Tags / places / forecast / user

| Query | Return | Notes |
|---|---|---|
| `tags` / `tag(id)` | `TagConnection!` / `TagType` | `tag.entities: TaggableEntityConnection` (union nodes) |
| `knownPlaces(kind: String)` | `[KnownPlaceType!]!` | |
| `knownPlaceCandidates` | `[KnownPlaceCandidateType!]!` | clustered home/work candidates |
| `forecast(horizon: String = "24h")` | `ForecastType` | 48-bucket day-ahead histogram; **`null` when the `hbpe` flag is off**; `systemStatus` ∈ {`COLD_START`,`TRAINING`,`READY`} |
| `me` | `UserType` | current user; `entity: PersonType`, `timezone`, `onboarded` |
| `node(id: ID!)` | `Node` | Relay global-object lookup: decodes the GlobalUID, dispatches to the right service |

---

## 4. Mutation catalog

Two families: **single writes** return the entity type (`createEvent: EventType!`) or a `*Payload { success, <entity> }` wrapper; **bulk list mutations** take `[CreateXInput!]!` → `[XType!]!`.

### 4.1 Memory writes
`createEvent`/`updateEvent`/`removeEvent`, `createContent`/`updateContent`/`removeContent`, `createItem`/`updateItem`/`deleteItem` (payload-wrapped), `updateBrowserActivity`, `updateCommunication`, `createNote`/`updateNote`/`deleteNote`, `createPlace`/`updatePlace`/`removePlace`, `createPerson`/`updatePerson`/`deletePerson`, `updateFile`, `updateKnownPlace`.

### 4.2 Graph writes
`createConcept`/`updateConcept`/`deleteConcept`, `createRelationship`/`updateRelationship`/`deleteRelationship`, **`bulkIngestGraph`** (§4.8), **`bulkIngestItemRelationships`** (§4.9).

### 4.3 Intelligence writes
`createQuestion`/`updateQuestion`/`removeQuestion`, `createAnswer`/`updateAnswer`/`removeAnswer`, `markActionAsSeen`/`markActionAsDismissed`, `markSummaryAsSeen`/`markSummaryAsDismissed`, `triggerHbpe` (→ `String!`, `"disabled"` if flag off).

### 4.4 Connections / providers writes
`createConnection`/`updateConnection`/`deleteConnection`, `createConnectionSyncJob`/`updateConnectionSyncJob`/`deleteConnectionSyncJob`, `createProviderKey`/`updateProviderKey`/`deleteProviderKey`.

### 4.5 Tags & saved searches
`tagEntities`/`untagEntities` (`{ ids:[ID!]!, labels:[String!]! }` → `[TaggableEntityType!]!`), `createSavedSearch`/`updateSavedSearch`/`deleteSavedSearch`, `setSavedSearchSharing` (mints/clears `shareToken`).

### 4.6 User
`updateCurrentUser` (`{ timezone }` → `UserType`).

### 4.7 Bulk ingest mutations (the importer surface) — detailed

The high-throughput paths CI-Import-Tools calls. **Shape:** `mutation(input: [CreateXInput!]!): [XType!]!` — one round-trip carries an array; the result is in **input order**. The 10 MB body limit exists for these.

**Idempotency — the provenance triple.** Each record carries `(sourceType, sourceSystem, sourceId)`; re-ingesting the same triple is a **no-op find-or-return**, enforced by set-based `INSERT … ON CONFLICT <arbiter> DO NOTHING` (or a companion dedup table for the hypertable). A row is dedupable only when it carries the triple.

**Deferred indexing (`emitCreated:false`).** The list paths **do not emit** per-row `*CreatedEvent`s (at ~1M rows the per-row PGBoss fan-out was the dominant cost). Search embedding is deferred to `POST /api/maintenance/search-index/backfill`. The single-row `createX` mutations **still** emit, so interactive creates index live.

| Mutation | Service path | Mechanism | ON CONFLICT arbiter | Scope col | Refresh on conflict |
|---|---|---|---|---|---|
| `createEvents` | `EventService.createManyBatched` | `bulkInsertIdempotent` | `(source_type, source_system, source_id) WHERE source_id IS NOT NULL` | `user_id` | none (`INGEST_REFRESH_COLUMNS.event = []`) |
| `createCommunications` | `CommunicationService.createMany` | **bespoke** 3-step tx (hypertable) | companion table `ci.communications_source_dedup` PK `(user_id, source_type, source_system, source_id)` | `user_id` | **self-heals** `direction, participants_metadata, content, preview, subject` on losers |
| `createContents` | `ContentService.createMany` | set-based `bulkInsertIdempotent` + set-based event auto-link | `content_source_triple_uniq` | `user_id` | none |
| `createInventoryItems` | `ItemService.createMany` | `bulkInsertIdempotent` | `(owner_user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL` | `owner_user_id` | none |
| `createBrowserActivities` | `BrowserActivityService.createMany` | `bulkInsertIdempotent` | `(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL` | `user_id` | none |

- **Communications is special** because `ci.communications` is a TimescaleDB hypertable — Timescale rejects any UNIQUE index lacking the partition column `time`. The invariant was moved to a non-hypertable dedup table keyed on the pure triple; an `AFTER DELETE` trigger drops the dedup row so a future re-ingest is treated as new (migration `20260628120000`). It's also the **only** path that self-heals fields on conflict.
- **`bulkInsertIdempotent`** (`common/persistence/bulkUpsert.ts`) runs one transaction, three statements: existence pre-check, multi-row `INSERT … ON CONFLICT … DO NOTHING RETURNING pk`, hydration SELECT. It **chunks** large inputs internally (bind-param-budget-sized sub-batches inside the one transaction) to avoid the 65535-parameter cliff. The centralized refresh contract is `INGEST_REFRESH_COLUMNS`; only `communication` is non-empty (`INGEST_SCHEMA_VERSION` gates changes).

**Entity batch-creates** — `createPeople`, `createPlaces`, `createNotes`, `createConcepts`, `createAnswers`, `createQuestions`: now set-based (`emitCreated:false` on the bulk path, so no per-row `*CreatedEvent`); single `create()` still emits live. Person/Concept dedup on `(entity_type, linkedTable, linkedId)`; Place/Note/Answer/Question always insert. `createNotes` may return fewer rows than input (null creates filtered).

### 4.8 `bulkIngestGraph` — knowledge-graph ingest

`bulkIngestGraph(input: BulkGraphInput!): BulkGraphPayload!` — idempotent bulk ingest of external entities + relationships into the user's graph.

```graphql
input BulkGraphInput { entities: [GraphEntityInput!]!  relationships: [GraphRelationshipInput!] }
input GraphEntityInput { key: String!  entityType: String!  sourceSystem: String!  name: String  description: String  properties: JSON }
input GraphRelationshipInput { fromKey: String!  toKey: String!  type: String!  properties: JSON }
type BulkGraphPayload {
  success: Boolean!  entitiesProcessed: Int!  relationshipsProcessed: Int!
  errors: [String!]!  entities: [BulkGraphEntityMapping!]!   # { key, entityId }
}
```

- **Entities** upsert on `(owner_user_id, entity_type, linked_table="import:<sourceSystem>", linked_id=uuidv5(key, IMPORT_NAMESPACE))` — the same importer-stable `key` always resolves to the same row. Each processed entity is echoed as `{ key, entityId }` so callers can cache `key → UUID`.
- **Relationships** reference endpoints by batch `key`, the `self` sentinel (owner's self entity), or a pre-resolved `fromEntityId`/`toEntityId`. Upsert on the directed `(fromNode, toNode, type)` unique index. Now **set-based** (batched `INSERT … ON CONFLICT`, not per-row `findOne+save`).
- **Counts:** `entitiesProcessed`/`relationshipsProcessed` = upserted counts; `errors` = per-item failure strings; `success = errors.length === 0`. Failures are **partial** — good rows commit.
- Side effect: each entity's email/phone identifiers index into `ci.entity_identifiers` (powers the communications people-linking backfill).

### 4.9 `bulkIngestItemRelationships` — item↔item edges

`bulkIngestItemRelationships(input: [ItemRelationshipInput!]!): BulkItemRelationshipResult!` — records item↔item relationships (email→attachment, photo→album) that have no other path into CI-Server. Backed by table `ci.item_relationships` (migration `20260707000001`).

```graphql
input ItemRelationshipInput {
  fromSourceType: String!  fromSourceSystem: String!  fromSourceId: String!
  toSourceType: String!    toSourceSystem: String!    toSourceId: String!
  relation: String!        metadata: JSON
}
type BulkItemRelationshipResult { inserted: Int!  skipped: Int! }
```

- **Both endpoints are referenced by their provenance triple** (`(sourceType, sourceSystem, sourceId)`), not a server id — table-agnostic, because an importer item may land in `ci.events`/`communications`/`content`/`inventory` by kind. Consumers join `ci.item_relationships` to whichever table by triple.
- **Set-based + idempotent:** one `INSERT … ON CONFLICT (user_id, from-triple, to-triple, relation) DO NOTHING RETURNING`, returning `{ inserted, skipped }`. Re-sending the same edge is a no-op.
- The importer (`graph-sync.ts`) derives both endpoints' triples using the exact same `mapping.ts` functions the push uses, so they match the pushed item rows.

---

## 5. Key types

**Interfaces:** `Node { id: ID! }` (id is always a GlobalUID); `Taggable { tags: [EntityTagType!]! }`; `Connection`/`Edge`/`PageInfo` (§3.1).

**Memory records (selected fields):**
- **`EventType`** (`Node & Taggable`): `title, description, eventType, category, startTime!, endTime, durationMinutes, isAllDay, status, confidenceScore, metadata: JSON`; location `locationName, locationCoordinates: JSON, location: PlaceType`; people `organizer: PersonType, participants: PersonConnection, organizerEntityId, participantEntityIds`; media (one DataLoader batch) `previewUrl, mediaUrl, mediaContentType, mediaWidth, mediaHeight, mediaSize`; provenance `sourceType, sourceSystem, sourceId`.
- **`CommunicationType`**: `type!, direction!, subject, content!, preview, time!, from: PersonType, to: PersonConnection`.
- **`ContentType`**: `type, mimetype, title, text, url, sourceUrl, externalId, sourceData: JSON, event: EventType`.
- **`ItemType`**: `name, brand, model, category, condition: ItemCondition, currency!, currentValue, acquiredAt, metadata: JSON, file: FileType`.
- **`BrowserActivityType`**: `url!, title, time!, duration, scrollDepth, actionType`.
- **`FileType`**: `filename, title, description, contentType!, size, previewUrl, sourceUrl, externalId, items: ItemConnection`.
- **`NoteType`**, **`PersonType`** (`name, firstName, lastName, avatarUrl` + address), **`PlaceType`** (`name, type, geolocation: JSON, properties: JSON!, entityType!`), **`ThreadType`** (`messages: MessageConnection`), **`MessageType`** (`role, content!, threadId!`).

**Intelligence:** `QuestionType`, `AnswerType` (`question: QuestionType!`), `ActionType` (`title!, text!, priority, seen!, dismissed!, thread: ThreadType`), `SummaryType` (`summaryText!, periodType!, activityCounts, insights, …`).

**Graph / connectors:** `RelationshipType` (`fromNodeId!, fromNodeType!, toNodeId!, toNodeType!, type!, isBidirectional!, strength`), `ConnectionType`, `ProviderType`, `ConnectionSyncJobType`.

**Search / saved search:** `SearchResultConnection` → `SearchResultEdge` → **union `SearchResultType`** = `ActionType | AnswerType | BrowserActivityType | CommunicationType | ConceptType | ContentType | EventType | FileType | ItemType | NoteType | PersonType | PlaceType | ThreadType` (query with inline `... on XType` fragments + `__typename`). `SavedSearchType` (`query, entityTypes, tags, filters, isPublic!, shareToken`). `TaggableEntityType` union mirrors `SearchResultType`.

**Forecast:** `ForecastType` (`horizon!, systemStatus!, buckets`), `ForecastBucketType` (`q10!, q50!, q90!, l0Probs/l1Probs/l2Probs`).

**Input shapes — the provenance triple lives on all ingest inputs:** `CreateEventInput` (`startTime!` req + `sourceType, sourceSystem, sourceId`), `CreateCommunicationInput` (`communicationType!, content!, time!` req + triple), `CreateContentInput`, `CreateInventoryInput` (`name!` req + triple), `CreateBrowserActivityInput` (`url!, time!` req + triple), `CreatePersonInput`/`CreateConceptInput` (`name!` + `linkedTable, linkedId` dedup key), `GraphEntityInput`/`GraphRelationshipInput` (§4.8), `ItemRelationshipInput` (§4.9).

**Scalars & enums:** `DateTime` (ISO-8601 UTC), `JSON` (arbitrary — `metadata`, `properties`, `sourceData`, `locationCoordinates`), `ItemCondition` (`NEW, LIKE_NEW, GOOD, FAIR, POOR, BROKEN, NA`). Note several update inputs still type the id as `String!` (e.g. `removeEvent(id: String!)`).

---

## 6. Errors

Standard GraphQL: partial `data` + top-level `errors[]`, each with `message`, `locations`, `path`, `extensions.code`.

- **Auth failures** → `extensions.code = "UNAUTHENTICATED"`/401. `toServiceContext` throws the same if a resolver runs without a `userId`.
- **Query complexity** over 150 → `extensions.code = "BAD_REQUEST"`, `http.status = 400`.
- **Body too large** (> 10 MB) → HTTP **413** from the middleware, before GraphQL runs (not a GraphQL envelope).
- **Bad GlobalUID** → `Error('Invalid global id …')` on that field.
- **Pagination misuse** (mixing forward+backward) → throws.

**Partial failure on bulk:**
- **`bulkIngestGraph`** is explicitly **partial-success** — per-item errors collected into `errors: [String!]!`; good rows commit. Inspect `errors`, don't assume all-or-nothing.
- **`createCommunications`** and the `bulkInsertIdempotent` paths run in **one transaction** — a mid-batch crash leaves no partially-visible rows behind the importer's watermark.
- **Entity batch-creates** are set-based; **idempotency softens retries** — re-sending a batch after a partial failure re-inserts nothing already committed on the provenance triple.

---

### Sources (under `backend/apps/api/src/`)
Schema `domains/graphql/__generated__/schema.graphql`; engine `domains/graphql/index.ts`; complexity `plugins/ComplexityPlugin.ts`; body limit `common/middleware/BodyParserMiddleware.ts`; auth `domains/auth/services/{JwtStrategy,ApiKeyStrategy}.ts`, `common/guards/JwtOrApiKeyAuthGuard.ts`; context `common/context/*`; pagination `domains/graphql/utils/Paginator.ts`; resolvers `domains/graphql/resolvers/*.ts`; bulk services `domains/memory/services/{Event,Communication,Content,Item}Service.ts`, `domains/graph/services/{GraphIngestService,ItemRelationshipService}.ts`; ingest helpers `common/persistence/{bulkUpsert,ingestRefreshColumns}.ts`.
