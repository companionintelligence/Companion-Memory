# Life Graph under CTI

Canonical ontology for the user-visible life graph. Implements the intent of
GitHub [#1945](https://github.com/companionintelligence/CI-Server/issues/1945),
[#1946](https://github.com/companionintelligence/CI-Server/issues/1946), and
[#1947](https://github.com/companionintelligence/CI-Server/issues/1947).

**Spine:** CTI entities + job-managed relationships + GraphQL shapes.
UI (dots LOD overview, focus expansion, What-bar Events filter) is a demo of
this architecture, not the source of truth.

**This is the clear home in the repo for the life-graph work.** There is no
separate top-level feature folder — code lands in the existing Nest/React
domains listed under [Where the code lives](#where-the-code-lives). The
delivery branch / PR that exercised the full stack is
[#1943](https://github.com/companionintelligence/CI-Server/pull/1943)
(`feat/graph-focus-communications`).

## Who / What / Where / When / Why

| Dimension | CTI types | Role |
| --- | --- | --- |
| **Who** | Person, Pet, Group | Actors and collectives |
| **What** | Item, Content, File, Concept | Things, media, documents, topics |
| **Where** | Place | Locations (DB discriminator may still be `Location` during rename) |
| **When** | Event, Communication | Timed occurrences and social atoms |
| **Why / about** | Concept edges (`ABOUT`, `PREFERS`, `PURSUES`, …) | Motives, interests, topics |

## The ten CTI entity types

`Person · Pet · Group · Place · Item · Event · Content · Communication · Concept · File`

Folds of legacy vocabulary:

| Legacy | Canonical |
| --- | --- |
| `Location` | Place (alias during migration; explorer maps to both) |
| `Object` / `Thing` | Item |
| `Contact` | Person |
| `Goal` | Concept (via `PURSUES`) |
| `Tag` | Concept (via `ABOUT`) — Tag is not a graph node |
| `Note` | Content with `properties.provenance = user_created` |
| `browser-activity` | Event + Content (projected; not a CTI type itself) |

### Explicit non-nodes

These tables may **produce** edges between CTI nodes but are not themselves
graph-visible CTI types:

- `ci.receipts`, `ci.object_observations`, `ci.position`, `ci.devices`
- `ci.tasks`, `ci.threads` (out of scope for this epic)
- Search tags (`ci_search.tags`) — filter facet only

## Relationship layers

| Layer | What | Storage | Writer |
| --- | --- | --- | --- |
| **L0 structural** | Containment / pairing already true in domain FKs | **Materialized** into `ci.relationships` by projector jobs | `DeterministicEdgeBackfillService` / `promote.edge_*` — **not** ad-hoc app code |
| **L1 asserted** | Facts a person or importer states | `ci.relationships` | `RelationshipService` (sole L1 gate) on the `graph_deltas` trail |
| **L2 derived** | Patterns learned from behavior | `ci.relationships` + `strength` + provenance | pg-boss derive jobs; re-derivable |

### L0 lock-in (revises #1945/#1946 “project at read only”)

Structural edges are **owned by the deterministic matrix jobs**. Idempotent
`ON CONFLICT` makes re-runs safe. App code must not invent duplicate structural
edges the matrix owns. GraphQL/REST may still **shape** reads (inverses, labels,
neighbor counts) without a second store.

Catalog: [`deterministicEdgeMatrix.ts`](../../backend/apps/api/src/domains/maintenance/services/deterministicEdgeMatrix.ts).

## Matrix allowlist

The allowlist lives in code as `RelationshipType` + `RelationshipMap` in
[`domains/graph/types.ts`](../../backend/apps/api/src/domains/graph/types.ts).
`RelationshipService.resolveType()` / `normalizeRelationship()` is the single
enforcement seam (#1946). An empty cell is a decision; populating one is a
reviewed change.

Governing rules (from #1945):

1. `entity_type` is what a thing *is*; a relationship is what it *is to someone*.
2. One direction per fact; the dependent points at its anchor. Inverses are
   computed at read time (GraphQL) or normalised at write (aliases).
3. The matrix is an allowlist.
4. Nothing in L1 requires manual data entry.
5. Reuse beats invention (`LIVES_IN` not `RESIDES_AT`, etc.).

## Job path

| Stage family | Purpose |
| --- | --- |
| `promote.edge_*` | Continuous L0 projection from source tables |
| `POST /api/maintenance/materialize-edges` | Operator / orchestrator full-history L0 sweep |
| Normalize job (`RelationshipNormalizeService`) | Alias rewrite, `IS` purge, `WORKS_AT`→Group |
| Derive job (`DerivedRelationshipService`) | L2 aggregates + Group reification |

## GraphQL shapes (read contract)

Entities and relationships define what can appear as GraphQL types. Prefer:

- Ego fields: `outgoingRelationships` / `incomingRelationships` on CTI types
- Computed helpers in resolvers (inverse labels, counts) — not a second store
- REST `/graph/*` as thin consumers of the same services

## Sequencing

WS0 ontology (this doc) → WS1 CTI nodes → WS2 write path → WS3 projectors/normalize
→ WS4 L2/groups → WS5 GraphQL shapes → WS6 UI demos (non-blocking).

## Where the code lives

No new package was invented. The epic extends the domains that already own
entities, jobs, and the Memory Graph UI:

| Concern | Path |
| --- | --- |
| **Ontology / allowlist** | `backend/apps/api/src/domains/graph/types.ts` |
| **L0 edge catalog** | `backend/apps/api/src/domains/maintenance/services/deterministicEdgeMatrix.ts` |
| **L0 backfill** | `…/DeterministicEdgeBackfillService.ts` + `POST /api/maintenance/materialize-edges` |
| **Continuous L0** | `backend/apps/api/src/domains/pipeline/stages/promote/EdgePromoteStage.ts` (`promote.edge_*`) |
| **Normalize / derive / fold** | `RelationshipNormalizeService`, `DerivedRelationshipService`, `NoteContentFoldService` |
| **Graph REST** | `domains/memory/controllers/GraphController.ts` (`/graph/node`, `/graph/dots`, `/graph/edges`) |
| **Graph services** | `GraphUtilityService`, `GraphQueryService` |
| **GraphQL ego edges** | `PersonType` / `PlaceType` + resolvers (`outgoingRelationships` / `incomingRelationships`) |
| **Dots + LOD UI** | `frontend/apps/web/src/api/useGraphDots.ts`, `components/ForceGraph/`, `pages/MemoryPage/GraphView/` |
| **What-bar Events filter** | `components/MemoryHub/entityTypeCategories.ts`, `MemoryEntityTypeNav.tsx` |
| **Schedule hover titles** | `components/HorizonGrid/` + `api/useScheduleService.ts` (`metadata.url`) |

## What PR #1943 delivered (end-to-end)

Delivered on `feat/graph-focus-communications` against issues #1945–#1947.
Rough order of the work:

1. **Person focus could not see mail** — linking filled
   `communications.from_entity_id` / `to_entity_ids`, but nothing wrote
   Person↔Communication into `ci.relationships`. Focus traversal was blind.
   First fix: `/graph/node` synthesizes recent `SENT`/`RECEIVED` edges at read
   time so focus is usable immediately.
2. **Make the edges real** — declarative L0 matrix + idempotent
   `materialize-edges` backfill (merge-tombstone aware) + orchestrator leg.
   Ran on the appliance: ~394k edges across both users; re-run creates 0.
3. **Keep edges fresh** — `promote.edge_*` nightly stages project the matrix
   as linkers fill columns (not only on operator backfill).
4. **Overview shows every CTI type** — waterfill overview slots so Persons do
   not consume the whole budget; Communications / Events / Content / Places
   appear as their own nodes.
5. **Dots LOD UI** — `GET /graph/dots` (~2k hubs, degree-ranked) + progressive
   hydrate; type-cluster sunflowers; pins (no spring blob); edges on
   hover/zoom/focus; relatedness meter; soft hover dim.
6. **Events as a filter, not a view** — Events live in the What bar; the
   top-row Events view tab was removed (Map / List / Gallery / Graph only).
7. **Life-graph CTI lock-in** — matrix allowlist + write-time normalisation,
   derive/normalize/fold jobs, GraphQL ego relationship fields, this doc.
8. **Schedule polish (same branch)** — narrow capture chips stay quiet; hover
   expands a selectable title; `metadata.url` opens in a new tab.

### Operator endpoints (recap)

| Endpoint | Stage |
| --- | --- |
| `POST /api/maintenance/materialize-edges` | L0 projectors |
| `POST /api/maintenance/normalize-relationships` | #1947 A |
| `POST /api/maintenance/derive-relationships` | #1947 C–D |
| `POST /api/maintenance/fold-notes` | Note→Content |
| Orchestrator legs | `materialize_edges`, `normalize_relationships`, `derive_relationships`, `fold_notes` |

## WS6 — UI demos (non-blocking)

The Memory Graph UI on this branch (progressive dots LOD, soft hover, focus
expansion, What-bar Events filter) is the acceptance demo that the architecture
works. Closing the epic does not require further viz work beyond keeping that
demo honest as the matrix grows.
