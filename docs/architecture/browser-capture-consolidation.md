# Browser capture consolidation — retire `ci.browser_activity`, canonical content + per-visit events

> Status: **PROPOSED** · 2026-08-11 · Continues [schema-consolidation.md](./schema-consolidation.md) Wave D and its "drop `ci.browser_activity`" follow-up.
> Affects: CI-Server (primary), CI-Browser-Extension, CI-Import-Tools.

**Goal.** Stop using the browser table; store **deduplicated** URLs/bookmarks in `ci.content` (a video watched 500× = one content row); record **every** visit/watch in `ci.events` with as many fields populated as we can gather.

**Scope note:** no production users yet, and dev DBs are reset frequently — so **all dirty-data remediation is de-scoped**. A DB reset after Phases 0/1 ship *is* the cleanup: fresh syncs land born-canonical. Migration/backfill machinery below is kept only as compressed *conditional* recipes, to be used only if a hub's data becomes worth keeping before its phase lands. Everything else is write-path/read-path correctness going forward, which a reset does not fix.

Verified against `main` @ `19a8472b9` (includes #1937), extension v1.5.0, importer trunk, and a live dev hub (core-2, image `2026.8.10`).

---

## 1. Where we are

1. **Dual-write is live since Wave D (#1892, extended by #1937).** Every row ingested through the browser-activity lane is folded into `ci.events` (`event_type='view'`) + a `ci.entities` base row + `ci.content` (`type='web-page'`). The browser table is `COMMENT`-marked deprecated, dual-read until drop.
2. **The fold keys content per-visit — the core defect.** 500 watches of one video = 500 `web-page` content rows, and URL variants (`youtu.be/X` vs `watch?v=X`) never merge. Measured live: 2.23× duplication in one week (§3). The machinery to fix it (`canonicalizeUrl` + provider refs, `domains/identity/`) exists in-tree, fully tested, wired to nothing.
3. **Events land per visit but thin.** Base-row `description` is NULL for extension rows (mapping bug, §5-G3), downloads collapse to `'view'`, incognito/sensitive never reach `is_private`, and repeat watches are lost in three distinct ways client-side (§5-G6).
4. **The calendar stopgap misses current rows — runtime-confirmed.** `findInRange`'s `source_type IS DISTINCT FROM 'browser_activity'` excludes only triple-less legacy rows; current extension rows carry `'capture'` and importer rows `'ci-import-tools'`. On the measured hub, the current-week calendar payload was **925 events, 100% page views**. Graph-LLM enrichment samples the same rows unfiltered.
5. **Retirement blocked on ~25 read consumers + 4 write paths + invisible surfaces** (user edits, tags, portability archives — §5-G10, §6).

Plan (§7): **(0)** canonical content dedup + read-surface stopgaps; **(1)** enrich events; **(2)** extension fidelity; **(3)** move consumers + writers, stop writing, drop; **(4)** importer + content-objects convergence. Suggested PR breakdown in §10.

---

## 2. Current state — the write path, verified

### 2.1 What the extension sends, and where

The extension builds every capture as a `BrowserActivity` struct (`src/services/browserActivity.ts:34-60`) and routes it client-side (`isContentCapture()`, `:232-238`):

| Capture | Lane | Server row |
|---|---|---|
| visit, download | `POST /api/v1/browser-activity` (`{records:[…]}`) | `ci.browser_activity` **+ fold** |
| bookmark, highlight, scrape | `POST /api/v1/contents` | `ci.content` (`type: bookmark` / `highlight` / `<personal_data_type>`) |
| after each sync | `POST /api/v1/ingest/finish` `{searchIndexOnly, entityTypes:["browser-activity","content"]}` | embed backfill |

Provenance on every record: `source_type: "capture"`, `source_system: "ci-browser-extension"`, `source_id` = `visit:<ISO time>:<url>` · `bookmark:<node id>` · `download:<id>` · scrape identity (`src/lib/scrapeIdentity.ts:59-72`).

Capture details that matter below:

- `duration_seconds` from `history.getVisits` gaps; **hardcoded 30** for the newest visit (`background.ts:917`).
- The meta description goes into `properties.description`, **not** the wire field `page_summary` — consequence in §5-G3.
- `is_incognito` / `contains_sensitive` **hardcoded `false`** (`background.ts:983-984`).
- Consecutive same-URL navigation suppressed by one global `lastUrl` guard (`background.ts:533`); a replay/loop without navigation fires **no** `webNavigation` event at all — invisible regardless of the guard.
- No media/player instrumentation; a "watch" is a page visit to the video URL. YouTube history is designated to Takeout → CI-Import-Tools (which has its own dedup bug — §7 Phase 4.1b).

### 2.2 What the server does with one visit (five rows)

`BrowserActivityService.createMany`:

1. **`ci.browser_activity`** — idempotent insert on `(user_id, triple) WHERE source_id IS NOT NULL` (pre-June-2026 legacy rows have no triple and were never deduped).
2. **`ci.events` + `ci.entities`** — `dualWriteTimeline` → `buildEventAggregateFold` (`common/persistence/eventAggregateSql.ts`): one CTI aggregate per activity. Detail row: `event_type='view'` (even for downloads), `start/end_time`, per-visit triple, `metadata = {browser_activity_id, url, action_type, duration_seconds, scroll_depth_percent, category, productivity_score, is_incognito, contains_sensitive, device_id, properties}`. Base row (`entity_type='Event'`): `name` ← title→url→`'Browser activity'`, `description` ← `page_summary`, `properties` hardcoded `'{}'`. **Every page view mints a knowledge-graph entity row.**
3. **`ci.content`** — one row per activity, `type='web-page'`, `text` ← `page_summary`, `source_data={browser_activity_id}`, `event_id` by triple sub-select, **`source_id` = the same per-visit triple** → one content row per visit. Raw SQL, `ON CONFLICT … DO NOTHING` — it does **not** read `INGEST_REFRESH_COLUMNS`.
4. **`ci.capture_events`** raw log, one row per record, keyed `(user_id, destination='browser_activity', triple)`, `kind` = `` `web.${action_type ?? 'page_view'}` `` (`BulkIngestController.ts:623-630` — destination deliberately *"stays browser_activity for raw-log identity"*).

The fold is non-transactional with the primary insert, and nothing repairs a row on re-send: `INGEST_REFRESH_COLUMNS` is `[]` for event/content/browser_activity — and that contract is *global per entity kind*, consumed only by `EventService`/`ContentService.createMany`, never by the fold's raw SQL (§7 Phase 0.2 hinges on this distinction).

**All four write paths:** `createMany` (bulk `/v1` + GraphQL `createBrowserActivities`); single-row `create()` (REST `POST /browser-activity`, per-row `BrowserActivityCreatedEvent`); `update()` (GraphQL `updateBrowserActivity` — **writes only the browser row, never the fold shadows**, §5-G10); exported-but-uncalled `remove()` (would orphan fold shadows).

### 2.3 Bookmarks, highlights, scrapes

- **Bookmark** → content `{type:'bookmark'}`, keyed per *browser bookmark node* — not per URL: same URL in two folders, or remove+re-add (new node id), duplicates. Never merges/links with the page's `web-page` row; the *act* creates no event; `bookmarks.onRemoved` is not captured.
- **Highlight** → content `{type:'highlight'}`, raw URL only — will not reference the canonical page row it annotates (§7 Phase 0.3).
- **Scrape** (streaming viewing history etc.) → content with identity-keyed `source_id`. **Repeat watches are silently discarded** (same `source_id` → `DO NOTHING`, no refresh); the real watch date sits unindexed in `source_data`.

### 2.4 Live symptoms

- **#1344 "Duplicate pages imported from browser"** — per-visit content rows + a live-vs-backfill client dupe (§5-G6b).
- **Calendar flood** — stopgap #1920 filters `source_type='browser_activity'`; the fold stamps `ba.source_type ?? 'browser_activity'`, so current extension rows (`'capture'`) and importer rows (`'ci-import-tools'`) pass. Runtime-confirmed: current-week `findInRange` = 925 rows, 100% page views; `MAX_RANGE_EVENTS=2000` ascending means heavy browsing can also crowd real events out of the response.
- **Graph enrichment burns budget on noise** — `GraphEnrichmentService.sampleRecords` (`:799-810`) samples newest events with no type/source filter; on a views-dominated hub the whole LLM budget is page-view titles minting junk `Concept` entities.

---

## 3. Worked example — one YouTube video, three watches

Watched Mon, Tue (via `youtu.be/<id>?t=30`), Wed. Today, post-#1937, that lands **15 rows across 5 tables**:

| Table | Rows | Notes |
|---|---|---|
| `ci.browser_activity` | 3 | deprecated, still the primary write |
| `ci.events` + `ci.entities` | 3 + 3 | `view`; base-row description NULL; duration/scroll/device only in metadata |
| `ci.content` | **3 × `web-page`** | same video thrice; the `youtu.be` variant never merges even under URL equality |
| `ci.capture_events` | 3 | raw log, `kind='web.visit'` |

At 500 watches: 500 of each. A bookmark of the video adds one more unlinked row.

**Measured (core-2, one week of extension data):** 4,606 activity rows → 4,606 view events → 4,606 web-page content rows (1:1:1, zero collapse) over **2,069 distinct URLs** = **2.23×** duplication; worst case a webmail inbox URL at **126 copies** (+56 under a path variant). All view events carry `('capture','ci-browser-extension')` — the calendar stopgap excluded zero.

**Target:**

| Table | Rows | Shape |
|---|---|---|
| `ci.browser_activity` | 0 | retired |
| `ci.content` | **1** | canonical URL + provider ref (`youtube:video:<id>`), title/description, first/last seen; bookmark state on the same canonical identity |
| `ci.events` (+base) | 3 (→500) | one per watch: typed, real times, description, `is_private`, link to the content row |

---

## 4. Alignment with existing designs

1. **G1 event-ingest spec** ([event-ingest-spec.md](./event-ingest-spec.md)): capture clients converge on `/v1/events`; typed controllers become read views. The extension abandoned `/v1/events` because it wrote *only* `ci.events` with no fan-out — the missing piece was canonical-content derivation, not the endpoint idea. (The spec predates the raw log's `destination` column; see §7 Phase 3.5.)
2. **Unified-content-identity PRD** ([../prd/unified-content-identity-lifecycle-embeds.md](../prd/unified-content-identity-lifecycle-embeds.md)): `content_objects` + `content_acts` is the endgame; `domains/identity/` landed, the tables did not. This plan implements the same semantics on the existing tables, keying content on the identity module's **uniform url rung** (`url:<sha256hex(canonical)>`, exactly what `resolveIdentities` emits) so rows later project mechanically into `content_objects`. (Note: the *landed* `ci.object_identifiers` table is the physical-inventory index — GTIN/ISBN — not the PRD's content-identity table.)
3. **Precedent for the key trick**, twice over: CI-Import-Tools keys the Spotify content row on the track URI while events keep per-play ids (`mapping.ts:1159-1173` — *"Keying on the URI collapses them to one row per track"*); the Spotify ETL does the same shape (`TransformRecentlyPlayed.ts:60-112`).

---

## 5. Gap analysis

| # | Gap | Evidence |
|---|---|---|
| **G1** | Content is per-visit, not per-URL; no unique index on `content.url` at all. | fold content leg; `content_source_triple_uniq`; §3 |
| **G2** | No URL canonicalization wired; `domains/identity/canonicalizeUrl` + fixtures sit unused. | `domains/identity/` |
| **G3** | Events thin: base-row `description` NULL (extension sends meta description in `properties.description`, fold reads only `page_summary`); `event_type` always `'view'`; `is_private`, `created_by`, `time_source`/`time_precision` (exist since `20260809184710`) never set; base `properties` hardcoded `'{}'`. | fold mapping |
| **G4** | Re-ingest repairs nothing; fold hardcodes `DO NOTHING`; `INGEST_REFRESH_COLUMNS` is the wrong lever (global per kind, unread by the fold). | `ingestRefreshColumns.ts` |
| **G5** | Browser table still written; ~25 read consumers + 4 write paths (§6). | §6 |
| **G6** | Repeat interactions lost three ways: (a) global `lastUrl` guard drops back-to-back revisits; (b) live capture keys by `Date.now()`, backfill by `visitTime` → duplicate rows for one visit; (c) **replay/loop fires no navigation event — only media-element telemetry can see it**; (d) scrape re-watches discarded by dedup-without-refresh. | `background.ts:533,539,549,1408,2519-2520` |
| **G7** | Bookmarks keyed per browser node (not URL), unlinked to page rows, no act event, no `onRemoved`; highlights carry raw URL only. | `browserActivity.ts:104-113,333-359` |
| **G8** | No read-surface policy for browser-derived events; stopgap filters the wrong value (runtime-confirmed); graph enrichment unfiltered. | §2.4 |
| **G9** | Dirty data accumulated (per-visit content, legacy triple-less rows, client dupes — all indexed). **De-scoped per the scope note**: a post-Phase-0 reset clears it; conditional recipe in Phase 0.4. | `20260808150100` |
| **G10** | **User edits don't propagate to fold shadows.** `updateBrowserActivity` (backing the `BrowserActivityDetails` title/url editor) writes only `ci.browser_activity`; its only listener re-embeds the browser-activity search doc. Every edit diverges the shadows; the Phase 3 read flip would revert edits; the drop would 500 the editor. | `BrowserActivityService.update` (no fold call); `BrowserActivityDetails.tsx:34-41` |

---

## 6. Blast radius — everything touching `ci.browser_activity`

- **Write paths (4):** `createMany`; single-row `create()` (REST POST); `update()` (G10); `remove()`.
- **REST/GraphQL reads:** `BrowserActivityController` GETs; GraphQL `browserActivities`/`browserActivity`; `BrowserActivityType` in `SearchResultType`/`TaggableEntityType` unions; `node()`.
- **Search:** `BrowserActivitySearchIndexListener`; `entitySourceMap`; `SearchIndexBackfillService` (`expandBackfillEntityTypes`); `SearchResolver` leg; `OrphanCleanupService` (only reaps types still in the map — §7 Phase 3.3); `EmbedCoverageTelemetryService` (iterates the map, queries the table).
- **Tags (data, not just the union):** `ci_search.entity_tag` rows `entity_type='browser-activity'` — bare keys, no FK; the details panel is `taggable`. Consumers: `TagResolver.resolveEntities`, `TagService.getEntitiesForTags` (search/timeline/graph), `getTagUsageCounts`.
- **Portability (invisible to grep):** `UserDataPortabilityService` discovers tables dynamically; the NDJSON restore **throws `Unknown table in archive` and rolls back the whole restore** for unknown tables (`UserDataPortabilityService.ts:141-148`) — see Phase 3.5b.
- **Graph enrichment:** `GraphEnrichmentService.sampleRecords` newest-events sampler.
- **Agent/MCP:** `SerializerService` (`[Browser] <title>`), `EntityResolutionService`, tools catalog.
- **Analytics/status:** `ActivityTimelineService.getBrowserDailyCounts`; `IngestStatusService` + maintenance counts; `IngestResetService`.
- **Raw log:** `capture_events` rows keyed `destination='browser_activity'`; `materialized_id` → browser_activity ids (no FK).
- **Python sidecars:** HBPE ingester LISTENs `ci_browser_activity` (no NOTIFY trigger exists; safety poll covers). **HBPE FKs `hbpe.l1_event_cluster.event_id → ci.events` and `l2_content_cluster`/`content_context → ci.content` are NO ACTION** — they abort deletes of clustered rows. Summary `data_aggregator.py` + `summarizer.py`. **Coordinate with open #1927** (HBPE rewrite touching the same files).
- **Frontend:** MemoryPage views + BrowserActivity components; MemoryHub categories; search UIs; generated GraphQL artifacts. The web app is a **PWA (`autoUpdate` SW)** — stale bundles keep the old schema in play (§8.3).
- **Extension:** `ingest/finish` `entityTypes:["browser-activity", …]`.

---

## 7. Plan

Principle: each phase ships alone, is idempotent against re-ingest, and never breaks extensions already in stores (the `/v1/browser-activity` + `/v1/contents` wire contract survives until Phase 3's deprecation; the lane keeps working after the table is gone).

### Phase 0 — canonical content dedup + read-surface stopgaps (CI-Server, ~3-4 days)

1. **Canonical key for web content.** In the fold's content leg, run `canonicalizeUrl(ba.url)`. Content row becomes `source_type='identity'`, `source_system='url'`, **`source_id='url:'+sha256hex(canonical)`** — the identity module's uniform url rung (bounded width; provider refs are *not* keys — they ride in `source_data` with `{canonical, identity_spec_version}` for a later recompute leg and byte-compatible `content_objects` projection). `url`=canonical, `source_url`=raw. **Skip the content leg** when canonicalization returns null (shorteners, `search:` synthetics) **and for `action_type='download'`** (signed blob URLs, filename-as-title; downloads are events-only). Note web-page dedup becomes deliberately **cross-source** (extension + importer archives collapse into one row); provenance accretes in `source_data.sources[]` (§8.5).
2. **Revisits enrich via explicit `DO UPDATE` in the fold SQL** — *not* `INGEST_REFRESH_COLUMNS` (global per kind, would flip DO UPDATE on for every contents writer, needs a schema-version bump, and the fold never reads it). Requirements:
   - **Within-batch collapse first:** Postgres raises SQLSTATE 21000 when two VALUES rows share the arbiter key, and same-URL rows inside one 200-row chunk are guaranteed (126×one URL/week measured; history backfills worst-case). Collapse per `(user_id, canonical source_id)` picking the latest-`ba.time` record (events leg still gets every row); emit rows **sorted by arbiter key** (DO UPDATE takes row locks; stable order avoids deadlocks). Without this the failure is a rejected batch that fails identically on every retry — a wedged sync queue, not a visible 500.
   - **Recency guard + first/last seen from *visit* time:** refresh `title`/`text`/`source_url` only where incoming `ba.time` ≥ stored last_seen; maintain first/last_seen via LEAST/GREATEST on `ba.time` (in `source_data` now; real columns can ride Phase 1) — **not** `updated_at`, which is write time and lies for backfills/archives.
   - **User-edit protection is a marker, not a column subset:** `UpdateContentInput` exposes `title,text,url,sourceUrl,sourceData,type,mimetype` — every refresh candidate is user-editable. Small `ContentService.update` change: stamp `source_data.user_edited=true` on edits to refreshable columns; the fold's DO UPDATE skips marked rows.
3. **Link events → content; bookmarks + highlights join the identity.** Stamp `events.metadata.content_id` (real column in Phase 1; §8.2). Contents lane (`flushContents` pre-step — *not* the extension; shipped clients keep sending `bookmark:<node id>`): for `type='bookmark'`, canonicalize and **rekey** to `source_id='bookmark:'+sha256hex(canonical)` — *namespaced*, because `content_source_triple_uniq` ignores `type`; reusing the page rung would collapse the bookmark into the page row (or clobber it under DO UPDATE). Browser node ids accrete in `source_data.bookmark_ids[]`. Stamp `source_data.canonical_url` on `highlight` rows; highlights keep per-selection ids.
4. **Cleanup of existing rows — DE-SCOPED.** Reset the DB after this ships (`POST /api/maintenance/ingest/reset`, destructive across all users — fine in dev) and re-sync: born canonical, closes #1344. Survives de-scoping: `identity_spec_version` stamping (0.1) and the §9 deletion rule. *Conditional recipe if a hub's data must be kept:* re-runnable leg keyed on `identity_spec_version < current`; collapse web-page/bookmark rows oldest-wins; pre-delete HBPE FK referents (`l2_content_cluster`, `content_context`, `l1_event_cluster`); remove `ci_search` rows for every deleted row (raw-SQL deletes fire no `*Deleted` events); reconcile user-edited rows browser-row-wins; dry-run counters first.
5. **Read-surface stopgaps (now-bleeding):** (a) calendar — keep the legacy clause AND add `event_type NOT IN ('view','download')`; a `source_system` filter is unworkable (importer stamps the per-export data source — open-ended set). Durable form once Phase 1 stamps `metadata.kind` (post-reset all rows carry it): `COALESCE(metadata->>'kind','') NOT LIKE 'web.%'`; policy proper stays with #1783. (b) graph enrichment — same exclusion in `GraphEnrichmentService.sampleRecords`.
6. **Search-index freshness for refreshed rows:** the fold emits no events and the `ingest/finish` backfill only indexes rows with *no* embedding — enriched canonical rows would stay stale forever. Return changed ids from the fold and enqueue re-index (or re-embed where `content.updated_at > embedding.updated_at`).

**Acceptance:** same URL 3× **in one batch** (incl. a `youtu.be` variant) → exactly 1 web-page row + 3 events; bookmark→delete→re-bookmark (and second-folder bookmark) → one bookmark row sharing the page's canonical identity; fresh DB + full re-sync → zero duplicate canonical rows; calendar and enrichment sampling show no page views.

### Phase 1 — enrich the events (CI-Server, ~3-4 days)

Via the fold mapping + `buildEventAggregateFold` — **`EventAggregateFoldRow` must grow fields** (11 fixed today; base `properties` hardcoded `'{}'`):

| Target | Populate from |
|---|---|
| `event_type` | visit→`view`, download→`download`; stamp `metadata.kind='web.page_view'\|'web.download'` (G1 enum, #1783-aligned) |
| base `description` | `page_summary` **?? `properties.description`** (fixes G3) |
| base `properties` | the extension's property bag (observed_at, meta description) |
| `is_private` | `is_incognito \|\| contains_sensitive` |
| `created_by` | `'ci-browser-extension'` / source_system |
| `confidence_score` | 1.0 explicit |
| `time_source`/`time_precision` | `'source'`; flag the hardcoded-30s-derived `end_time` |
| `content_id` (new nullable uuid) | canonical content row |
| `parent_event_id` (optional) | per-tab/session grouping — 500 flat siblings → a session tree; helps G8 |

Event refresh (description/end_time repair on re-send) is likewise an explicit `DO UPDATE` in the aggregate-fold SQL, updating detail + base rows (`INGEST_REFRESH_COLUMNS.event` feeds `EventService.createMany`, not the fold). Events keep the per-visit arbiter — unique within a batch, no collapse needed.

**Cross-phase guard:** the `event_type` remap must land inside Phase 0.5's calendar exclusion in the same PR; any future fold event_type (bookmark acts, search) extends the exclusion when introduced.

**Acceptance:** synced visit has non-NULL base description, correct type, `is_private` when incognito; downloads no longer render as "viewed"; **calendar still shows no browser-derived events**.

### Phase 2 — extension fidelity (CI-Browser-Extension, ~4-6 days, independent)

1. Send the meta description as `page_summary` (server accepts it) in addition to `properties.description` for old servers.
2. Per-tab, time-windowed revisit guard replacing global `lastUrl`; key live captures by `visitTime` (already queried) instead of `Date.now()` so live+backfill dedupe against each other.
3. Real dwell time instead of the hardcoded 30s.
4. Real `is_incognito` (`tab.incognito`); sensitive-profile scrapes stamp `contains_sensitive`.
5. Bookmark acts: emit an activity record on create/remove (`action_type:'bookmark'`, `properties.event`); add the missing `onRemoved` listener, which also marks the bookmark content row (`source_data.removed_at`).
6. **Media telemetry — scoped honestly.** Replays/loops fire no navigation event (G6c): the *literal* "watched 500× without navigating" is invisible to everything above. A minimal `HTMLMediaElement` play/ended listener on media domains emitting a `web.media` record per play is what actually delivers "record every watch" — recommended here; if deferred, state the limitation in release notes.

**Acceptance (navigation-visible):** navigate away and back → two events; backfill after live capture adds 0 dupes. With telemetry: N replays → N `web.media` events.

### Phase 3 — retire `ci.browser_activity` (~2-3 weeks, the long pole)

Order: edits re-homed → reads → auxiliary data → writes → table.

1. **Re-home the edit path (before the read flip — G10):** propagate `update()` edits to the fold shadows (title → the fold event's `ci.entities.name` via the triple; url → `events.metadata.url`; never the canonical content row — shared across visits and under 0.2's edit protection) or drop the edit affordance (§8.6). Otherwise the read flip silently reverts user edits.
2. **Reads → events/content:** re-back `find*` (REST GET, GraphQL queries, MCP serializers, entity resolution) with a view over `ci.events` (`event_type IN ('view','download') AND source_system='ci-browser-extension'` ∪ importer equivalents — same predicate family as 0.5; keep them in sync) joined to canonical content. GraphQL types stay, deprecated, view-backed.
3. **Search retirement — explicit sequence** (`OrphanCleanupService` cannot do it: it only reaps types still in the map whose source row is gone; removing the entry hides the type forever, keeping it post-drop breaks its SQL): stop the listener → one-shot `DELETE FROM ci_search.{embeddings,vectors,index_skips} WHERE entity_type='browser-activity'` → remove map entry + `INDEXABLE_ENTITIES` member + telemetry coverage in the same PR.
4. **Sidecars — after #1927 lands (or rebased into it):** HBPE subscribes to events filtered by kind (its CTI guard is *lazy* — `_ensure_events_cti_schema` raises on the first labeling query, not at startup; monitor the labeling path, not liveness). Summary swaps the table config for an events-scoped query.
   **4b. Tags (*conditional* — expected no-op in dev):** verify `entity_tag` count for `'browser-activity'` is 0, delete residue. Only if real tags exist: repoint to `'event'` via `events.metadata->>'browser_activity_id'` with a dup-guard (`PersonMergeService` precedent), then delete the remainder.
   **4c. Aggregate read surface — the payoff:** content-detail view answering "how many times did I watch X": canonical row + events timeline + visit count (index on `events.content_id` — settles §8.2), first/last seen; MemoryPage groups by canonical content instead of 500 near-identical event rows.
5. **Writes:** all four paths. `createMany`/`create` go fold-only; `/v1/browser-activity` becomes an adapter emitting G1 `CaptureEvent`s — **keeping `captureAndMaterialize` with `destination='browser_activity'`** (the raw-log identity namespace existing rows were minted under; routing through the `/v1/events` capture stage would double-write `capture_events` on every post-cutover re-send and flip duplicate→ingested accounting). Extension's `ingest/finish` entityTypes swaps to `["event","content"]`; server accepts the old value silently.
   **5b. Portability archive compat (*conditional* now; mandatory before GA):** dev archives aren't worth preserving, so this doesn't gate the drop today — but the failure mode is structural (whole-restore rollback on any unknown table), so before real users exist, make the NDJSON importer count-and-skip unknown tables, surfacing counts in `ImportResult`. Future-proofs every later table drop/rename.
6. **Drop:** after one release with counts proving no readers — `DROP TABLE` + remove entity/module + status/reset entries. Decide the soft references: `metadata.browser_activity_id` / `source_data.browser_activity_id` (keep as documented historical tombstones — recommended) and `capture_events.materialized_id` on `'browser_activity'` rows (write-only today; document as historical, or repoint to events via the echoed triple).

**Acceptance:** old *and* new extensions sync green with the table gone; an edited title survives the read flip; search has no browser-activity dead links; the content-detail view shows "3 visits" across both URL variants; HBPE labeling and summaries run clean. (*Conditional:* pre-migration tags resolve on their events; pre-drop archives restore with skip counts.)

### Phase 4 — converge and extend (cross-repo)

1. **Importer routing:** flip `destinationsFor`'s `web.page_view`/`web.search` → events (+content via the canonical rule) in step with Phase 3.5, behind a server-capability check. **Size it first (§8.4)** — this is the real volume cliff.
   **1b. Importer media dedup — the designated YouTube path is broken the same way:** `youtube.ts` emits per-watch ids with no `metadata.URI`, so the Spotify collapse (`mapping.ts:1169`) never fires — 500 Takeout watches of one video = 500 `media` content rows. Stamp `metadata.URI='youtube:video:<id>'` when the URL yields one (byte-identical to the server's provider-ref format so `content_objects` can later merge browser-observed and imported rows); leave unset for removed/private entries. `letterboxd.ts` needs the same film-level URI. Acceptance: N watches → 1 content row + N events; re-import adds 0.
2. **Scrape watch-events:** derive per-watch events from scrape items carrying dates (`watchedDateTime`/`lastWatched`), `source_id=<title identity>:<date>`; add refresh for progress fields — recovers G6d.
3. **content_objects projection:** when the PRD tables land, web content rows → objects (url-rung key makes it mechanical), view events → `View`/`Watch` acts. Until then, the same video via browser and Takeout is two content rows under different triples; the shared provider-ref string is the merge key.
4. **Read-surface policy:** which kinds appear on calendar / timeline / search / enrichment sampling — #1783's `kind-distribution` report is the observability piece.

---

## 8. Decisions

1. **Bookmarks: separate row, namespaced canonical key** (`bookmark:<digest>`) — `content_source_triple_uniq` ignores `type`, so reusing the page rung would collapse rows; the canonical `url` column is the join key. Folder placement isn't captured today, so per-URL collapse loses nothing.
2. **`events.content_id`:** metadata link in Phase 0, real column in Phase 1 — Phase 3.4c's visit-count surface needs the index.
3. **No lockstep GraphQL removal.** The web app is a PWA (`autoUpdate` SW); stale bundles keep issuing the monolithic Search query, and removing `BrowserActivityType` fails validation for the whole query — killing search for every entity type on cached clients. Keep deprecated view-backed types ≥1 release after the frontend stops querying them; verify with a stale-bundle (cached Playwright context) client.
4. **Model the Phase 4 volume cliff before flipping importer routing.** Evidence so far is one week of extension data; the importer class is ~96k searches per export (`mapping.ts:544-552`) and 330k+ historical rows, doubled into `ci.entities` with tsvector maintenance post-#1937. Re-run the hypertable-audit gates for `ci.events`/`ci.entities` at import scale first.
5. **Cross-source canonical dedup is intentional.** One web-page row per `(user, canonical URL)` spans extension + importers; the triple names the identity, not a source; provenance accretes in `source_data.sources[]`. Per-source groupings will see the new pseudo-source.
6. **Browser-activity edit affordance:** keep-and-re-home (Phase 3.1) vs drop the title/url editor. Recommend keep-and-re-home; dropping is fine if edits belong on the canonical content row instead.

---

## 9. Events-CTI interactions (#1937)

- `ci.events` is a CTI detail table: `20260811061409` moved `title`/`description` to the `ci.entities` base row (`entity_type='Event'`, shared uuid, deferrable FK base→detail `ON DELETE CASCADE`). **Event deletions must go through `ci.entities`** (deleting only the detail orphans the base) *and* pre-clear the `hbpe.l1_event_cluster` FK.
- The fold's events leg is `buildEventAggregateFold` — the single owner of "how to write an Event aggregate in SQL"; Phase 1 extends its row interface. Field mappings were carried over unchanged, so the G3 description-NULL bug persists on the base row. The content leg and `findInRange`/stopgap are untouched by #1937.
- HBPE's CTI-schema guard is **lazy** (`_ensure_events_cti_schema` raises on first labeling query, not at startup); summary workers cache introspected columns per process and need a restart after schema changes.
- **New flood surface:** every page view mints a `ci.entities` row named after the page title — entity listings/search fill with per-visit `Event` entities (~4.6k/week measured) unless surfaces filter. One entity per *page*, not per *visit*, is the defensible graph projection — which is Phase 0. (Open #1936 graph-view work overlaps; coordinate.)

---

## 10. PR breakdown (minimized)

Four PRs — one per repo per milestone. The drop migration rides the retirement PR: the one-release no-readers gate is waived while there are no production users (scope note); split it back out if that changes before Phase 3 lands.

| # | Repo | Contents | Size | Depends on |
|---|---|---|---|---|
| 1 | CI-Server | **This doc + Phases 0+1 complete.** Read-surface filters (calendar `event_type NOT IN ('view','download')` keeping the legacy clause, same exclusion in `GraphEnrichmentService.sampleRecords`); canonical content leg (url-rung key, download/null skips, within-batch collapse, `DO UPDATE` + recency guard, first/last_seen + spec_version, `user_edited` marker in `ContentService.update`, re-index enqueue); contents-lane bookmark rekey + highlight `canonical_url`; event enrichment (`EventAggregateFoldRow` growth, type map + kind, description fallback, is_private/created_by/confidence/time_source/precision, event `DO UPDATE`) + the one migration (`events.content_id`). Structure the commits filters → canonical content → contents lane → enrichment so it reviews in slices. | L | — |
| 2 | CI-Server | **Phase 3 retirement, complete.** Edit-path re-home; view-backed `find*` (REST/GraphQL/MCP reads); search retirement sequence; sidecar re-point (**rebase on / land after #1927**); tags no-op check; visit-count content-detail surface; fold-only writes + `/v1/browser-activity` adapter preserving `destination='browser_activity'`; `ingest/finish` entityTypes compat; **the drop migration** + tombstone decisions (`metadata.browser_activity_id`, `capture_events.materialized_id`). | L | 1; #1927 |
| 3 | CI-Browser-Extension | **Phase 2 whole:** `page_summary`, real incognito/sensitive, visitTime keying, per-tab guard, bookmark acts + `onRemoved` (its new event_type is already inside PR 1's calendar exclusion), optional media telemetry. | M | parallel (bookmark acts render best after PR 1) |
| 4 | CI-Import-Tools | **Phase 4 importer side in one shot:** `metadata.URI` for youtube/letterboxd (fixes Takeout dedup immediately, no server dependency) + the `web.page_view`/`web.search` routing flip **gated on a server-capability check**, so it ships now and activates when PR 2's adapter is live. Do the §8.4 volume sizing inside this PR's description. | M | activation gated on 2 |

Start with PR 1; reset dev DBs after it merges and re-sync to validate born-canonical acceptance. PRs 3 and 4 can proceed in parallel with 2.

---

## 11. References

- [schema-consolidation.md](./schema-consolidation.md) (Wave D + drop follow-up) · [event-ingest-spec.md](./event-ingest-spec.md) (G1) · [hypertable-audit.md](./hypertable-audit.md)
- [../prd/unified-content-identity-lifecycle-embeds.md](../prd/unified-content-identity-lifecycle-embeds.md) (§4.2 canonicalization, §5.2 verb map)
- CI-Browser-Extension `architecture.MD` §6, `CAPTURE.md` · CI-Import-Tools `backend/src/ci-server/mapping.ts`
- Issues #1344, #1783, #1784 · PRs #1892 (Wave D), #1920 (stopgap), #1937 (CTI) · open: #1927 (HBPE rewrite), #1936 (graph view)
