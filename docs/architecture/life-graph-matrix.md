# Life Graph under CTI

Canonical ontology for the user-visible life graph. Implements the intent of
GitHub [#1945](https://github.com/companionintelligence/CI-Server/issues/1945),
[#1946](https://github.com/companionintelligence/CI-Server/issues/1946), and
[#1947](https://github.com/companionintelligence/CI-Server/issues/1947).

**Spine:** CTI entities + job-managed relationships + GraphQL shapes.
UI (dots LOD, Events tab) is a demo of this architecture, not the source of truth.

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

## Operator endpoints

| Endpoint | Stage |
| --- | --- |
| `POST /api/maintenance/materialize-edges` | L0 projectors |
| `POST /api/maintenance/normalize-relationships` | #1947 A |
| `POST /api/maintenance/derive-relationships` | #1947 C–D |
| `POST /api/maintenance/fold-notes` | Note→Content |
| Orchestrator legs | `materialize_edges`, `normalize_relationships`, `derive_relationships`, `fold_notes` |

## WS6 — UI demos (non-blocking)

Existing graph UI on `feat/graph-focus-communications` (dots LOD, Events What-bar/tab,
focus expansion) remains the acceptance demo that the architecture works. No further
viz work is required to close this epic.
