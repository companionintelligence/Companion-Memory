# CI-Server GraphQL API Reference

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

The memory-brain GraphQL surface of CI-Server: a single Apollo/NestJS endpoint exposing the personal database (events, communications, content, inventory/things, receipts and product models, browser activity, files, notes, threads), the knowledge graph (entities, relationships, identifiers, merge candidates), intelligence (questions, answers, actions, summaries, daily metrics), planning (tasks, schedule candidates), asks & grants, cross-entity search, saved searches, connectors/providers, and the HBPE forecasts. Auth and conventions are in [auth-and-conventions.md](auth-and-conventions.md); REST surfaces in [rest.md](rest.md).

- **Schema (source of truth):** `backend/apps/api/src/domains/graphql/__generated__/schema.graphql` — **92 queries, 116 mutations, 283 named type definitions** (187 `type`, 67 `input`, 21 `enum`, 4 `interface`, 2 `union`, 2 `scalar`), code-first generated from resolver decorators (`autoSchemaFile`, `index.ts:113`). **Do not edit it by hand.** (Counts drift as resolvers are added; the SDL is authoritative — counted against the file on 2026-08-19.)

---

## 1. Endpoint & how to call it

| Property | Value | Source |
|---|---|---|
| Path (backend) | `POST /graphql` | Apollo driver mount (`index.ts:111-126`) |
| Path (browser, same-origin) | `POST /api/graphql` | `frontend/apps/web/src/api/ApolloProvider.tsx:27` |
| Method | `POST` (JSON). **There is no `GET /graphql` page** — the IDE lives at `GET /graphiql` | `GraphQLController.ts:12` |
| Content-Type | `application/json` | |
| Engine | Apollo Server via `@nestjs/apollo` `ApolloDriver` | `index.ts:111-112` |
| Introspection | **On outside production** — `process.env.NODE_ENV !== 'production'`. It used to be unconditional, which let an unauthenticated caller on the LAN enumerate the whole schema of an appliance holding one person's life (disclosure, not access: the resolvers still refuse anonymous reads) | `index.ts:124` |
| Playground / built-in GraphiQL | Both **disabled** on the driver (`playground: false`, `graphiql: false`); CI-Server serves its own themed IDE at `GET /graphiql`, deliberately kept off `/graphql` so it cannot collide with the Apollo mount | `index.ts:115,125` |
| Schema sorting | `sortSchema: true` (alphabetical SDL) | `index.ts:114` |
| Body-size limit | **10 MB** for `/graphql` (default elsewhere is 100 KB) | `common/middleware/BodyParserMiddleware.ts:19-20,76-77,91-92` |
| Query-complexity limit | **150** — exceeding returns `BAD_REQUEST`/400 | `domains/graphql/plugins/ComplexityPlugin.ts:43-55`; `config/default.json:112-114` |
| HTTP batching | Not configured. Batch by sending **list mutations** (§4), not array-of-operations POSTs | |

**Body limit:** `main.ts` boots with `bodyParser: false` (`:33`); `BodyParserMiddleware` special-cases the `/graphql` path (Apollo mounts via `app.use()`, so `@BodyLimit` metadata is undefined) and raises the limit to `10mb` — this is what lets a bulk client push thousands of items per bulk mutation.

**Complexity:** every operation is scored once (default 1/field); over `config.graphql.maxQueryComplexity` (**150**) it throws `extensions.code = 'BAD_REQUEST'`, `http.status = 400`. Deeply nested connection queries can hit this — page instead of over-nesting.

Request/response envelope is standard GraphQL-over-HTTP:
```json
{ "query": "query($first:Int){ events(first:$first){ totalCount } }", "variables": { "first": 10 } }
```
→ `{ "data": { ... }, "errors": [ ... ] }`. The web app uses Apollo Client with an `authLink` setting `Authorization: Bearer <token>`, posting to same-origin `/api/graphql` (the proxy strips `/api`).

---

## 2. Auth & context

**Nearly every resolver class is guarded** by `@UseGuards(JwtOrApiKeyAuthGuard)`; unauthenticated → 401 surfaced as a GraphQL error. Accepted credentials (any one): **JWT Bearer** (`Authorization: Bearer`), **API key** (`x-api-key` or `Authorization: Bearer <key>`), or **Portal OIDC Bearer** (`auth.portal.enabled` is now **true** by default). See [auth-and-conventions.md](auth-and-conventions.md) for the full model.

**Two resolvers deviate from that guard**, and the distinction matters:

- **`GraphResolver`** (`graph`) declares no `@UseGuards` at all, but *does* call `toServiceContext(context)`, which throws `UnauthorizedException` when no strategy has populated `userId`. It is scoped, not open — but it is the odd one out, not the pattern to copy. There is **no pre-auth resolver**: every root field needs a credential.
- **[Retired 2026-08-26]** `UserSnapshotResolver` (`ingestUserSnapshot`) used to be the one JWT-only mutation — it declared plain `@UseGuards(JwtAuthGuard)`, so an `x-api-key` or Portal OIDC caller was 401'd there even though both work everywhere else. That guard was also why the mutation could never have had the caller it was built for: CI-Capture presents an api key or a Portal bearer. The resolver, its `ci.user_snapshots` hypertable and the whole `user-snapshots` domain were removed in `20260826202515_retire_user_snapshots` (no reader, no reachable writer). Every remaining resolver is either `JwtOrApiKeyAuthGuard` or the unguarded-but-context-scoped `GraphResolver` below.

> **Gone:** the device-pairing surface (`startPairing`, `pairingStatus`, `PairingResolver`, `StartPairingPayload`/`PairingStatusPayload`) has been deleted — it was never reachable from the web app and no sibling repo called it. Migration `20260820001224_drop_pairings_table.sql` drops the (empty) `ci.pairings` table. Unrelated to the still-live `/device-connect` web route (native Portal cloud-connect, `frontend/apps/web/src/pages/DeviceConnectPage/`) and to the REST `/api/connect` app-authorization flow (`domains/auth/controllers/ConnectController.ts`), which both remain.

**Scope-limited API keys cannot use GraphQL at all.** No resolver declares `@RequireScopes`, and enforcement is deny-by-default, so a key carrying a non-empty `scopes` array is refused on every root field. Empty-scope (legacy full-authority) keys, sessions and Portal principals are unaffected. This is also why MCP withholds every GraphQL-derived tool from such keys.

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

**Arguments:** the four Relay cursor args `first: Int, after: String, last: Int, before: String`. Forward (`first`/`after`) and backward (`last`/`before`) are **mutually exclusive** — mixing them throws (`Paginator.ts:22-26`).

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

**Exceptions to the plain 4-arg pattern.** Eight connection queries take arguments beyond the four Relay ones, so filtering is **not** a client-side job on these:

| Query | Extra args |
|---|---|
| `items` | `query, category, brand, condition, lifecycleState, hasIdentifier, sort` |
| `tasks` | `status, parentId, scheduledFor` |
| `receipts` | `merchantName, purchasedFrom, purchasedTo, extractionState` |
| `productModels` | `query, brand, category, subcategory, productType, isDigital` |
| `mergeCandidates` | `status` |
| `connectionSyncJobs` | `connectionId, endpointName, type` |
| `people` / `places` | `query` (name substring) |

`receipts`, `productModels` and `mergeCandidates` are **forward-only** (`first`/`after` only, no `last`/`before` in the SDL); `items` declares all four but rejects `last`/`before` with a `BadRequestException` ("The things list is a forward-only keyset: use first/after, not last/before."). These lists also carry **their own cursor encodings** rather than the GlobalUID node id: `receipts` a keyset over `(purchasedAt, id)`, `productModels` an offset, and `items` a `(createdAt, id)` keyset on its unfiltered fast path but a GlobalUID on the refined path. Treat their cursors as opaque and never mix them across queries.

`search` takes `SearchInput` and returns a union-node connection with an opaque time cursor. And a large and growing set of queries return **plain lists/objects rather than connections** — `feedActions(limit)`, `eventTypes`, `eventSources`, `eventsInRange`, `graph`, `mapPins`, `activityTimeline`, `knownPlaces(kind)`, `knownPlaceCandidates`, `placesNear`, `placesContaining`, `forecast`/`weekForecast`/`dueForecast`/`placeForecast`/`metricForecast`/`forecastHistory`/`predictionCalibration`, the `dailyMetrics` family, `scheduleCandidates`, `plannedBlocks`, `taskPendingChanges`, the `ask*` family, `unresolvedObservations`, `itemDuplicates`, `personDuplicates` and `objectByIdentifier`.

### 3.2 Memory domain

| Query | Return | Notes |
|---|---|---|
| `events` / `event(id)` | `EventConnection!` / `EventType` | timeline events; media, location, participants |
| `eventTypes` | `[String!]!` | distinct `event_type` values (the "how" filter) |
| `eventSources` | `[String!]!` | distinct `source_system` connectors present |
| `communications` / `communication(id)` | `CommunicationConnection!` / `CommunicationType` | `from: PersonType`, `to: PersonConnection` |
| `contents` / `content(id)` | `ContentConnection!` / `ContentType` | rich content, optional `event` link |
| `items` / `item(id)` | `ItemConnection!` / `ItemType` | owned things (`ci.objects`); each may link a `file`. **Filterable and forward-only** — see the §3.1 table for the seven filter args. `category`/`brand`/`lifecycleState` are SQL predicates on the keyset; `query`/`condition`/`hasIdentifier`/non-default `sort` are refined over a bounded window, so `totalCount` counts matches **in that window**, not the library. The **UI** calls these "Things" (`/memory/things`), but the GraphQL type is still `ItemType` and the table is still `ci.objects` |
| `browserActivities` / `browserActivity(id)` | `BrowserActivityConnection!` / `BrowserActivityType` | page visits |
| `files` / `file(id)` | `FileConnection!` / `FileType` | `items` back-ref, `previewUrl` |
| `notes` / `note(id)` | `NoteConnection!` / `NoteType` | |
| `places` / `place(id)` | `PlaceConnection!` / `PlaceType` | Place entities. **The DB discriminator is still `'Location'`** — the Location→Place rename is in flight in the ontology only |
| `people` / `person(id)` | `PersonConnection!` / `PersonType` | Person entities |
| `eventsInRange(from, to)` | `[EventType!]!` | plain list over an explicit window (not a connection) |
| `activityTimeline(start, end, filters?)` | `[ActivityBucketType!]!` | precomputed activity counts per local calendar day (day boundaries in the profile timezone), refreshed from the source tables every 15 minutes. `filters: ActivityTimelineFiltersInput` applies the same Memory-explorer constraints as `search` |

### 3.2b Object identity — receipts, product models, observations

Shipped alongside the physical-things work; these are the read half of the instance-vs-model distinction.

| Query | Return | Notes |
|---|---|---|
| `receipts(merchantName?, purchasedFrom?, purchasedTo?, extractionState?, first?, after?)` / `receipt(id)` | `ReceiptConnection!` / `ReceiptType` | SQL-filtered forward-only keyset. **`totalCount` is this page's row count**, not the size of the matching set — no `COUNT(*)` is issued |
| `productModels(query?, brand?, category?, subcategory?, productType?, isDigital?, first?, after?)` / `productModel(id)` | `ProductModelConnection!` / `ProductModelType` | the *model*, as against the owned instance. Forward-only, but the cursor is an **offset**, not a keyset; `totalCount` is likewise this page's row count, not the catalog |
| `objectByIdentifier(namespace!, value!, brand?, sourceSystem?)` | `ObjectByIdentifierPayload!` | resolve a barcode/serial to an object |
| `itemDuplicates(limit?, offset?)` | `ItemDuplicatesPayload!` | duplicate proposals for owned things |
| `unresolvedObservations(limit?, offset?)` | `[ObjectObservationType!]!` | observations not yet resolved to an object |

### 3.3 Conversations

`threads` / `thread(id)` → `ThreadConnection!` / `ThreadType` (`messages: MessageConnection`). No top-level `messages` query; `MessageType` is reachable via `node`.

### 3.4 Graph domain

| Query | Return | Notes |
|---|---|---|
| `graph(limit: Int = 200, entityType: String)` | `GraphType!` | Nodes + edges straight off the `ci.entities` / `ci.relationships` spine, with only edges whose **both** ends are in the payload. Its own description marks it **"preferred over REST `/api/graph/*`"**. `limit` is clamped to 1–1000. |
| `relationships` / `relationship(id)` | `RelationshipConnection!` / `RelationshipType` | directed edges `(fromNode, toNode, type)` |
| `concepts` / `concept(id)` | `ConceptConnection!` / `ConceptType` | Concept entities |
| `mergeCandidates(status?, first?, after?)` | `MergeCandidateConnection!` | proposed entity merges awaiting review |
| `personDuplicates(limit?, offset?, reasons?)` | `PersonDuplicatesPayload!` | duplicate people, with the reasons that flagged them |

Entities surface as the typed `PersonType`/`PlaceType`/`ConceptType` lists (rows in `ci.entities`). Identifiers (email/phone) back people-linking. There is **no top-level identifiers query**, but they are plain read fields on the entity: `PersonType.identifiers: [PersonIdentifierType!]!` (`kind, value, rawValue, label, isPrimary, source, verifiedAt`), batched by `PersonIdentifiersLoader` over `ci.entity_identifiers`, and likewise `ItemType.identifiers` / `ProductModelType.identifiers` (`ObjectIdentifierType`). Writes go through the `addPersonIdentifier`/`removePersonIdentifier` and `addItemIdentifier`/`removeItemIdentifier` mutations (§4.1b).

### 3.5 Intelligence

| Query | Return | Notes |
|---|---|---|
| `questions` / `question(id)` | `QuestionConnection!` / `QuestionType` | The **UI** calls this surface "Reflections" — the API vocabulary is deliberately unchanged |
| `answers` / `answer(id)` | `AnswerConnection!` / `AnswerType` | `question: QuestionType!` (DataLoader) |
| `actions` / `action(id)` | `ActionConnection!` / `ActionType` | conversation-starter / suggestion cards |
| `feedActions(limit: Int! = 5)` | `[ActionType!]!` | feed, unseen-first — not a connection |
| `summaries` / `summary(id)` | `SummaryConnection!` / `SummaryType` | daily/period rollups |

### 3.5b Daily metrics & descriptive analytics

| Query | Return | Notes |
|---|---|---|
| `dailyMetrics(from!, to!)` | `[DailyMetricsType!]!` | precomputed daily feature-store rows over an inclusive `yyyy-MM-dd` range |
| `descriptiveQuestions(analyticType?)` / `descriptiveAnswers(date?)` | `[DescriptiveQuestionType!]!` / `[DescriptiveAnswerType!]!` | the compute-then-narrate catalog and its answers |
| `catalogAnswers(analyticType!, date?)` | `[DescriptiveAnswerType!]!` | answers every catalog question from stored `daily_metrics` |
| `metricAnomalies(metric?, since?)` | `[MetricAnomalyType!]!` | |
| `metricCorrelations(windowDays?, robustOnly?)` | `[MetricCorrelationType!]!` | |
| `metricSuggestions(includeDismissed?)` | `[MetricSuggestionType!]!` | |

### 3.5c Planning & schedule

| Query | Return | Notes |
|---|---|---|
| `tasks(status?, parentId?, scheduledFor?, first?, …)` / `task(id)` | `TaskConnection!` / `TaskType` | **filterable** — the three filters go into `TaskService.findAll`, but the page itself is still sliced in memory by `Paginator` like the generic lists |
| `taskPendingChanges(taskId?)` | `[TaskPendingChangeType!]!` | pending trust-dial confirmations for mutate/complete/revise/schedule |
| `scheduleCandidates(from!, to!)` | `[ScheduleCandidateType!]!` | the Possibilities slate |
| `plannedBlocks(from!, to!)` | `[EventType!]!` | scheduled blocks as events |

### 3.5d Asks & grants (peer federation)

Gated by the **`ask` feature flag, which is now `true` by default** — the *local* ask/grant surface is live out of the box. Only the inbound peer REST route stays dark, and for a different reason (it also needs `peers.audience` configured).

| Query | Return |
|---|---|
| `askInbox` / `askOutbox` / `ask(id)` | `[AskType!]!` / `[AskType!]!` / `AskType` |
| `askAnswer(…)` | `AskAnswerType` |
| `myAskGrants` | `[AskGrantType!]!` |
| `askDisclosureHistory` | `[AskAuditType!]!` |

> **Outbound asks need a token you supply.** `SendPeerAskInput.peerAccessToken` is non-nullable: the *caller* must present a CI-Portal-issued access token whose audience is the peer box. CI-Server never mints, exchanges or caches one. And there is **no API — REST or GraphQL — that creates a `ci.peer_links` row**; both directions hard-require a pre-existing link, so today a link is inserted by hand.

### 3.6 Connections / providers / sync jobs

| Query | Return | Notes |
|---|---|---|
| `connections` / `connection(id)` | `ConnectionConnection!` / `ConnectionType` | connector instances |
| `providers` / `provider(id)` | `ProviderConnection!` / `ProviderType` | connector catalog |
| `connectionSyncJobs(connectionId, endpointName, type, …)` / `connectionSyncJob(id)` | `ConnectionSyncJobConnection!` / … | **filterable** sync-job history |
| `oAuthCallbackUrl` | `String!` | the server's OAuth redirect URL |

### 3.7 Search & saved searches

`search(input: SearchInput!): SearchResultConnection!` — the primary retrieval API; combinable filters, all AND-ed (LifeScope parity), candidate-set + post-filter design.

**`SearchInput`** (all optional): `query` (full-text/semantic), `semantic` (force embedding rank), `tags`, `includeTypes`/`excludeTypes`, `includeFiles` (opt standalone files **out** of the timed browse — files are part of the default timeline like every other indexed type; pass `false` to drop them without also disturbing `excludeTypes`. This used to default the other way, which made the explorer's File type picker a no-op on every surface that did not set the flag), `eventTypes` ("how"), `connectors` (source_system), `people` ("who"), `places` ("where"), `hasLocation`, `bbox` (`[minLon,minLat,maxLon,maxLat]`), `startTime`/`endTime` (ISO), `sortBy`(`relevance|time|name`)/`sortOrder`, `first`/`after` (default 30, max 100), `shareToken`.

**`SearchResultConnection`** carries `edges`, `pageInfo`, `totalCount` **and `matchingTags: [TagType!]!`** — the tags represented in the result set, so a client can offer tag refinement without a second round-trip.

**Candidate source:** `query` → search index (ranked); else `tags` → tag membership; else **timed** (recent events + communications + browser activity merged, with a `(time,id)` keyset cursor pushed to SQL). Remaining filters AND-ed as post-filters; who/where/connector restrict to matching events. **Cursor:** opaque `base64("<iso-time>::<globalId>")`. Node is the `SearchResultType` union (§5).

**`mapPins(input: SearchInput!, limit: Int): MapPinsType!`** runs the *same* `SearchInput` and returns located events as map markers, so the map and list views cannot drift apart on what "the current query" means. Two deliberate differences: `hasLocation` is **forced on** regardless of input (an unlocated event has no pin) and the result is **events-only**; and it returns the whole matching set in one read (capped at `MAP_PIN_MAX_LIMIT` pins), not a page — with `totalCount` a real `COUNT(*)` of the matching located set, so a truncated response can say how much of the map it is showing.

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
| `placesNear(latitude!, longitude!, radiusMeters?, limit?)` | `[PlaceNearType!]!` | PostGIS proximity |
| `placesContaining(latitude!, longitude!, limit?)` | `[PlaceType!]!` | PostGIS containment (which places enclose this point) |
| `forecast(horizon: String = "24h")` | `ForecastType` | 48-bucket day-ahead histogram; **`null` when the `hbpe` flag is off**; `systemStatus` ∈ {`COLD_START`,`TRAINING`,`READY`} |
| `weekForecast(includeToday: Boolean = false)` | `WeekForecastType` | week-ahead view |
| `dueForecast` | `DueForecastType` | what is coming due |
| `placeForecast(horizonHours: Int = 4, k: Int = 5)` | `[PlaceForecastItemType!]!` | likely next places |
| `metricForecast(days: Int = 3)` | `[MetricForecastType!]!` | per-metric forecast |
| `forecastHistory(days: Int = 5)` | `[ForecastHistoryDayType!]!` | past forecasts, for eyeballing drift |
| `predictionCalibration(limit: Int = 14)` | `PredictionCalibrationType` | were the forecasts any good |
| `me` | `UserType` | current user; `entity: PersonType`, `timezone`, `onboarded` |
| `node(id: ID!)` | `Node` | Relay global-object lookup: decodes the GlobalUID, dispatches to the right service |

> The HBPE background pipeline behind these is no longer Temporal. `NightlyHBPEWorkflow` / `BootstrapHBPEWorkflow` are gone; the work runs as plain async functions (`nightly` / `bootstrap` / `ensure_bootstrap`) dispatched by pg-boss to the sidecar's `/functions/run`.

---

## 4. Mutation catalog

Two families: **single writes** return the entity type (`createEvent: EventType!`) or a `*Payload { success, <entity> }` wrapper; **bulk list mutations** take `[CreateXInput!]!` → `[XType!]!`.

Many newer writes return a `*Payload` wrapper; note also that several entities now carry **both** a legacy boolean/entity-returning mutation and a payload-wrapped one (`removeEvent` **and** `deleteEvent`, `removePlace` **and** `deletePlace`, `removeContent` **and** `deleteContent`) — the `delete*` form is the payload-wrapped one.

### 4.1 Memory writes
`createEvent`/`updateEvent`/`removeEvent`/`deleteEvent`/`restoreEvent`, `rescheduleEvent`, `returnEventToSlate`, `createContent`/`updateContent`/`removeContent`/`deleteContent`, `createItem`/`updateItem`/`deleteItem` (payload-wrapped), `updateBrowserActivity`/`deleteBrowserActivity`, `updateCommunication`/`deleteCommunication`, `createNote`/`updateNote`/`deleteNote`, `createPlace`/`updatePlace`/`removePlace`/`deletePlace`, `createPerson`/`updatePerson`/`deletePerson`, `updateFile`, `updateKnownPlace`.

### 4.1b Identity, merge & object writes
`mergePeople`, `rejectPersonDuplicates`, `addPersonIdentifier`/`removePersonIdentifier`; `mergeItems`, `addItemIdentifier`/`removeItemIdentifier`, `linkItemToProduct`; `mergeProductModels`; `confirmObservation`/`rejectObservation`; `rebuildPlaces`.

`ci.entity_merges` rows are written under `entity_type` `'ObjectInstance'` for `mergeItems` and `'ProductModel'` for `mergeProductModels`, preserving the instance-vs-model distinction.

### 4.2 Graph writes
`createConcept`/`createConcepts`/`updateConcept`/`deleteConcept`, `createRelationship`/`updateRelationship`/`deleteRelationship`, **`bulkIngestGraph`** (§4.8), **`bulkIngestItemRelationships`** (§4.9).

> **`IS` is not a writable edge type.** `normalizeRelationship` rejects it with "IS is not a relationship — enrich the self entity via `ci.entity_identifiers` + merge"; the enum member survives only so the resolver can name it. `HAPPENED_AT` / `AT_LOCATION` are write-time aliases normalized to **`LOCATED_AT`** before insert.

### 4.3 Intelligence writes
`createQuestion`/`createQuestions`/`updateQuestion`/`removeQuestion`, `createAnswer`/`createAnswers`/`updateAnswer`/`removeAnswer`, `markActionAsSeen`/`markActionAsDismissed`, `markSummaryAsSeen`/`markSummaryAsDismissed`, `refreshDailyMetrics`, `triggerHbpe` (→ `String!`, `"disabled"` if flag off).

> **Answer text.** `createAnswer`/`createAnswers`/`updateAnswer` hold the text to the same rule as `POST /api/answers` and `PATCH /api/answers/:id` — not blank, at most 5,000 characters (UTF-16 code units) — and answer a violation with a 400. An answer created without a method is recorded as `answerMethod: "user"`, the same value an edit stamps.

> **Shared-catalogue write scope.** Seed reflection rows are read-only: editing one **forks a private copy** rather than mutating the shared row. Any new user-scoped selector over `ci.questions` must carry the forked-origin exclusion or retired reflections reappear.

### 4.3b Planning & schedule writes
`createTask`/`updateTask`/`deleteTask`, `completeTask`/`reopenTask`/`deferTask`, `scheduleTask`/`unscheduleTask`, `breakDownTasks`, `acceptProposedTask`/`declineProposedTask`, `acceptTaskPendingChange`/`declineTaskPendingChange`, `acceptCandidate`/`declineCandidate`/`snoozeCandidate`, `syncScheduleSuggestions`.

### 4.3c Asks & grants writes
`createAsk`, `approveAsk`/`declineAsk`, `runAsk`, `sendPeerAsk`, `createAskGrant`/`revokeAskGrant`.

> The ask **UI components** exist under `frontend/apps/web/src/pages/AsksPage/` but nothing imports them and no route mounts them — the ask surface is backend-plus-component-library today, not reachable in the shipped web app.

### 4.4 Connections / providers writes
`createConnection`/`updateConnection`/`deleteConnection`, `createConnectionSyncJob`/`updateConnectionSyncJob`/`deleteConnectionSyncJob`, `createProviderKey`/`updateProviderKey`/`deleteProviderKey`.

### 4.5 Tags & saved searches
`tagEntities`/`untagEntities` (`{ ids:[ID!]!, labels:[String!]! }` → `[TaggableEntityType!]!`), `updateTag`/`deleteTag`, `createSavedSearch`/`updateSavedSearch`/`deleteSavedSearch`, `setSavedSearchSharing` (mints/clears `shareToken`).

### 4.6 User
`updateCurrentUser` (`{ timezone }` → `UserType`).

### 4.7 Bulk ingest mutations (the importer surface) — detailed

The high-throughput write paths. **Shape:** `mutation(input: [CreateXInput!]!): [XType!]!` — one round-trip carries an array; the result is in **input order**. The 10 MB body limit exists for these.

> **Prefer the REST `/v1/*` plane for new bulk clients.** These mutations remain fully supported (and are the fallback when `/v1` is unavailable), but the REST lanes add an append-only raw capture log, NDJSON streaming with no overall request-size cap, and per-record rejection accounting. See [rest.md — Ingest](rest.md#ingest-bulk-capture-write-path).

**Idempotency — the provenance triple.** Each record carries `(sourceType, sourceSystem, sourceId)`; re-ingesting the same triple is a **no-op find-or-return**, enforced by set-based `INSERT … ON CONFLICT <arbiter> DO NOTHING`. A row is dedupable only when it carries the triple.

**Deferred indexing (`emitCreated:false`).** The list paths **do not emit** per-row `*CreatedEvent`s (at ~1M rows the per-row PGBoss fan-out was the dominant cost). Search embedding is deferred to `POST /v1/ingest/finish` (or the older `POST /maintenance/search-index/backfill`). The single-row `createX` mutations **still** emit, so interactive creates index live.

| Mutation | Service path | Mechanism | ON CONFLICT arbiter | Scope col | Refresh on conflict |
|---|---|---|---|---|---|
| `createEvents` | `EventService.createManyBatched` | `bulkInsertIdempotent` | `(source_type, source_system, source_id) WHERE source_id IS NOT NULL` | `user_id` | none (`INGEST_REFRESH_COLUMNS.event = []`) |
| `createCommunications` | `CommunicationService.createMany` | `bulkInsertIdempotent` | `communications_source_triple_uniq` on `(user_id, source_type, source_system, source_id)` | `user_id` | **self-heals** `direction, participants_metadata, content, preview, subject` on losers |
| `createContents` | `ContentService.createMany` | set-based `bulkInsertIdempotent` + set-based event auto-link | `content_source_triple_uniq` | `user_id` | none |
| `createThings` | `ItemService.createMany` | `bulkInsertIdempotent` | `(owner_user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL` | `owner_user_id` | none |
| `createBrowserActivities` | `BrowserActivityService.createMany` | `bulkInsertIdempotent` (+ dual-write to `events`/`content`) | `(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL` | `user_id` | none |

- **Communications** is a **plain table** (de-hypertabled; see [Database.md](../architecture/Database.md)). The pure provenance triple lives on `communications_source_triple_uniq` — the old `ci.communications_source_dedup` companion was dropped with the hypertable. It remains the **only** path that self-heals fields on conflict via `INGEST_REFRESH_COLUMNS.communication`.
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

- **Both endpoints are referenced by their provenance triple** (`(sourceType, sourceSystem, sourceId)`), not a server id — table-agnostic, because an importer item may land in `ci.events`/`communications`/`content`/`inventory` by kind. A consumer would join `ci.item_relationships` to whichever table by triple.
- **Set-based + idempotent:** one `INSERT … ON CONFLICT (user_id, from-triple, to-triple, relation) DO NOTHING RETURNING`, returning `{ inserted, skipped }`. Re-sending the same edge is a no-op.
- **Nothing in this repo calls it, and nothing reads the table.** The only references to `bulkIngestItemRelationships` are its own resolver (`ItemRelationshipResolver.ts`), the generated SDL and the generated frontend types; the caller it was built for was the external CI-Import-Tools `graph-sync.ts`. The ported in-repo importer links records a different way — `PushStage` joins `ci_import.staged_relationships` to `ci_import.entity_mappings` to resolve a staged item's edges to server entity ids (`domains/import/stages/PushStage.ts:1052`) — and never emits a triple-addressed item↔item edge. `domains/import/push/` derives only the **push** triple (`SOURCE_TYPE`, `sourceSystemFor`, `sourceIdFor` in `canonical.ts`), which is what a caller would have to match. On the read side `ci.item_relationships` has no resolver or service consumer at all (`domains/pipeline/stages/promote/ObjectPromoteStage.ts:310` names it "one mutation, zero resolvers").

---

## 5. Key types

**Interfaces:** `Node { id: ID! }` (id is always a GlobalUID); `Taggable { tags: [EntityTagType!]! }`; `Connection`/`Edge`/`PageInfo` (§3.1).

**Memory records (selected fields):**
- **`EventType`** (`Node & Taggable`): `title, description, eventType, category, startTime!, endTime, durationMinutes, isAllDay, status, confidenceScore, metadata: JSON`; location `locationName, locationCoordinates: JSON, location: PlaceType`; people `organizer: PersonType, participants: PersonConnection, organizerEntityId, participantEntityIds`; media (one DataLoader batch) `previewUrl, mediaUrl, mediaContentType, mediaWidth, mediaHeight, mediaSize`; provenance `sourceType, sourceSystem, sourceId`.
- **`CommunicationType`**: `type!, direction!, subject, content!, preview, time!, from: PersonType, to: PersonConnection`.
- **`ContentType`**: `type, mimetype, title, text, url, sourceUrl, externalId, sourceData: JSON, event: EventType`.
- **`ItemType`** (much wider than it was — the physical-things work): `name, brand, model, category, condition: ItemCondition, currency!, currentValue, acquiredAt, acquiredFrom, acquisitionMethod, acquisition: ReceiptLineItemType, metadata: JSON, file: FileType`, plus the object-identity fields `identifiers: [ObjectIdentifierType!]!`, `identityConfidence: Float!` (1.0 = a human said so or a barcode was scanned; lower = minted from a receipt line or guessed from a photo), `isDigital`, physical descriptors (`colorHex`, `colors`, `composition: JSON!`, `heightMm`, …) and `expiresAt`.
- **`BrowserActivityType`**: `url!, title, time!, duration, scrollDepth, actionType`.
- **`FileType`**: `filename, title, description, contentType!, size, previewUrl, sourceUrl, externalId, items: ItemConnection`.
- **`NoteType`**, **`PersonType`** (`name, firstName, lastName, avatarUrl` + address), **`PlaceType`** (`name, type, geolocation: JSON, properties: JSON!, entityType!`), **`ThreadType`** (`messages: MessageConnection`), **`MessageType`** (`role, content!, threadId!`).

**Intelligence:** `QuestionType`, `AnswerType` (`question: QuestionType!`), `ActionType` (`title!, text!, priority, seen!, dismissed!, thread: ThreadType`), `SummaryType` (`summaryText!, periodType!, activityCounts, insights, …`).

**Graph / connectors:** `RelationshipType` (`fromNodeId!, fromNodeType!, toNodeId!, toNodeType!, type!, isBidirectional!, strength`), `ConnectionType`, `ProviderType`, `ConnectionSyncJobType`.

**Search / saved search:** `SearchResultConnection` (`edges`, `pageInfo`, `totalCount`, `matchingTags`) → `SearchResultEdge` → **union `SearchResultType`**, **16 members**:

```
ActionType | AnswerType | BrowserActivityType | CommunicationType | ConceptType | ContentType |
EventType | FileChunkType | FileType | ItemType | NoteType | PersonType | PlaceType |
ProductModelType | ReceiptType | ThreadType
```

(query with inline `... on XType` fragments + `__typename`). `SavedSearchType` (`query, entityTypes, tags, filters, isPublic!, shareToken`).

**`TaggableEntityType` no longer mirrors `SearchResultType`** — it has **14** members: the same list minus `AnswerType` and `FileChunkType`. Do not assume a fragment set is interchangeable between the two unions.

**Forecast:** `ForecastType` (`horizon!, systemStatus!, buckets`), `ForecastBucketType` (`q10!, q50!, q90!, l0Probs/l1Probs/l2Probs`).

**Input shapes — the provenance triple lives on all ingest inputs:** `CreateEventInput` (`startTime!` req + `sourceType, sourceSystem, sourceId`), `CreateCommunicationInput` (`communicationType!, content!, time!` req + triple), `CreateContentInput`, `CreateThingInput` (`name!` req + triple), `CreateBrowserActivityInput` (`url!, time!` req + triple), `CreatePersonInput`/`CreateConceptInput` (`name!` + `linkedTable, linkedId` dedup key), `GraphEntityInput`/`GraphRelationshipInput` (§4.8), `ItemRelationshipInput` (§4.9).

**Scalars & enums:** `DateTime` (ISO-8601 UTC), `JSON` (arbitrary — `metadata`, `properties`, `sourceData`, `locationCoordinates`), `ItemCondition` (`NEW, LIKE_NEW, GOOD, FAIR, POOR, BROKEN, NA`). Note several update inputs still type the id as `String!` (e.g. `removeEvent(id: String!)`).

---

## 6. Errors

Standard GraphQL: partial `data` + top-level `errors[]`, each with `message`, `locations`, `path`, `extensions.code`.

- **Auth failures** → `extensions.code = "UNAUTHENTICATED"`/401. `toServiceContext` throws the same if a resolver runs without a `userId`.
- **Scope refusal** → a `ForbiddenException` from `enforceApiKeyScopes`, not an auth error: the credential was fine, the key just is not allowed on the GraphQL plane. The message is the guard's own text — `This API key is scope-limited and cannot access this endpoint` on a route that declares no scopes (which is every GraphQL root field), or `API key is missing required scope(s): …` where a route does declare `@RequireScopes`. See §2.
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
Schema `domains/graphql/__generated__/schema.graphql`; engine `domains/graphql/index.ts`; IDE `domains/graphql/controllers/{GraphQLController,graphiql.html}.ts`; complexity `domains/graphql/plugins/ComplexityPlugin.ts`; body limit `common/middleware/BodyParserMiddleware.ts`; auth `domains/auth/services/{JwtStrategy,ApiKeyStrategy}.ts`, `common/guards/{JwtOrApiKeyAuthGuard,apiKeyScopeEnforcement}.ts`; context `common/context/*`; pagination `domains/graphql/utils/Paginator.ts`; resolvers `domains/graphql/resolvers/*.ts`; bulk services `domains/memory/services/{Event,Communication,Content,Item}Service.ts`, `domains/graph/services/{GraphIngestService,ItemRelationshipService}.ts`; ingest helpers `common/persistence/{bulkUpsert,ingestRefreshColumns}.ts`; relationship normalization `domains/graph/relationshipNormalize.ts`.

---

*Schema counts, endpoint configuration, guard model, union membership and the query/mutation catalogs re-verified against the generated SDL and `backend/apps/api/src` on **2026-08-19**.*
