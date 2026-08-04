# Entity Identity & Merge — State of Play

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Status: **survey + remaining work** · Scope: `ci.entities` Person / Location / Object
Supersedes the pre-#1810 draft of this file, which was written when no merge primitive existed.

---

## 1. What landed

Two large pieces shipped while the earlier draft of this document was sitting on a branch.

**#1810 — People identity and merge** (`20260803211455_add_person_identity_and_merge.sql`)

- `ci.entities.merged_into_entity_id` — tombstone pointer, indexed.
- `ci.entity_merges` — audit log, one row per (source → target), with per-table re-point counts
  and the source's pre-merge properties in `details`.
- `ci.entity_identifiers` grew from a bare lookup into a real contact-method table:
  `raw_value`, `label`, `is_primary`, `source`, `verified_at`.
- `PersonDuplicateService` — candidate groups by shared normalized email / phone / name.
- `PersonMergeService` — the merge itself, in one transaction: re-points identifiers,
  `communications.from_entity_id` / `to_entity_ids[]`, `events.organizer_entity_id` /
  `participant_entity_ids[]`, and relationship endpoints; folds properties (target wins scalars,
  `emails`/`phones`/`names` unioned); tombstones each source; deletes its search rows; writes the
  audit row.
- GraphQL: `MergePeopleInput`, `MergePeoplePayload`, `PersonDuplicateGroupType`; UI on `PeoplePage`.

The hard parts are handled well and should not be re-litigated: the self person may be a merge
*target* but never a *source*; relationship re-points are guarded against both the
`no_self_references` CHECK and the `relationships_unique_directed_idx` partial unique index, with a
`DISTINCT ON` so two duplicates carrying the same edge cannot collapse onto the index mid-UPDATE;
the hypertable re-point lifts `timescaledb.max_tuples_decompressed_per_dml_transaction` for the
transaction; tombstones are removed from *both* search stores (`ci_search.embeddings` and
`ci_search.vectors`).

**Object identity** (`20260803223013`–`20260803223025`)

- `ci.product_models` — the catalog half of the product/instance split.
- `ci.object_identifiers` — GTIN/serial index, deliberately *separate* from
  `ci.entity_identifiers` rather than widening its CHECK, so people-resolution and
  thing-resolution do not share one unique index.
- `ci.object_observations` — a sighting ("a mug is visible in this photo") as a distinct, weaker
  claim than ownership ("I own this mug"), which is what `InventoryListener` was conflating.
- `ci.inventory` gained `merged_into_object_id`, a model link, a lifecycle and a confidence.

**A related design landed in the same window**: `docs/prd/unified-content-identity-lifecycle-embeds.md`
(Track 3, §4) defines an identity ladder — `src > url > sha256 > txt > nat` — plus
`ci.object_merge_candidates`, whose header calls out `ci.entity_identifiers`' `.orIgnore()` as the
thing that forced `PersonDuplicateService` to re-derive normalization in SQL. **Anything built here
should adopt that ladder's vocabulary rather than inventing a third one.**

---

## 2. Verified defect: a merge does not survive the next sync

**This is the highest-value item and it is demonstrated, not inferred.**

Entity resolution still keys on `(owner_user_id, entity_type, linked_table, linked_id)`, and
**no resolution path filters `merged_into_entity_id`**:

- `GraphIngestService.findExistingNodes` — plain `WHERE userId AND (entityType, linkedTable, linkedId)`.
- `PersonService.create`'s `linkedWhere` — same shape, no tombstone predicate.

A tombstone keeps its linked key, so it keeps winning that lookup.

Reproduced against `GraphIngestService` with a seeded tombstone: ingesting the source's own
natural key after the merge resolves to the **tombstone's** entity id, not the canonical one.

Consequences, in order of severity:

1. The next Apple Contacts / Google / Signal sync writes name, description and properties onto a
   dead row. The merged person silently stops receiving updates from that source.
2. Relationships from that batch attach to the tombstone. The graph accumulates live edges
   pointing at a tombstoned node.
3. `indexIdentifiers` is the one part that degrades safely — the merge re-pointed those identifier
   rows to the target, so the `ON CONFLICT DO NOTHING` keeps them there.

So the merge is not undone (the tombstone is not resurrected as a visible person), but it is
**bypassed**: the source that fed the duplicate goes on feeding a corpse.

### 2.1 The fix

Two layers, and both are needed:

**(a) Follow the pointer on resolve.** Every linked-key lookup resolves the tombstone to its
canonical target. `PersonService` already has this shape for reads (`mergedIntoEntityId ?? row`);
`GraphIngestService.upsertEntities` needs it on the resolution path so re-ingest lands on the
canonical row. Cheap, and it fixes the observable bug on its own.

**(b) Make provenance many-to-one.** `ci.entities` has exactly *one* `(linked_table, linked_id)`
pair, so a survivor can only carry one source's key — which is *why* the loser has to be kept
around to hold the other one. A `ci.entity_provenance (owner_user_id, source_system, natural_key)
→ entity_id` table, unique on the triple, lets the canonical row carry every source's key directly
and makes (a) a consequence rather than a patch. This is also the shape `object_identifiers` and
the content-identity ladder already use, so it converges the three models instead of adding a
fourth.

(a) without (b) is a real fix and worth landing first. (b) is what makes the model coherent.

---

## 3. Gap matrix

| | promotion | duplicate detection | merge service | survives re-sync | unmerge | rejection is sticky |
|---|---|---|---|---|---|---|
| **Person** | ✅ 5 paths | ✅ `PersonDuplicateService` | ✅ `PersonMergeService` | ❌ §2 | ❌ | ❌ |
| **Place** | ✅ geocode + import | ❌ none | ❌ none | — | ❌ | ❌ |
| **Thing** | ✅ + observations | ⚠️ schema only | ❌ column only | ❌ §2 | ❌ | ❌ |

### 3.1 Place is the untouched one

`PlaceService.findOrCreateForGeocode` dedupes within *its own path* on
`(owner, lower(btrim(name)), round(lat,3), round(lng,3))` — ~110 m. Nothing dedupes across paths,
and `PlaceService.createMany` has **no dedup key at all**, so a bulk import re-inserts every place
on every run.

Place matching needs a rule of its own, because distance alone is wrong in both directions: two
Starbucks 50 m apart are two places; the same Starbucks geocoded twice 200 m apart is one. The rule
is conjunctive — `ST_DWithin` **and** name agreement, with the radius scaled by place kind
(dwelling ~30 m, venue ~100 m, campus/airport ~2 km).

The distinctive hazard is **containment, which is not identity**: café ⊂ street ⊂ city all match
spatially. When two Locations match on distance but their extent differs by an order of magnitude,
the answer is a `CONTAINED_BY` relationship, never a merge. That needs an explicit guard, not a
threshold — it is the most likely route to a catastrophic bad merge.

### 3.2 Thing has the schema but no service

The product/instance split is right and already modelled. What is missing is the service that uses
it, and the rule it must encode: **two of the same product are two objects.** A model-level match
(GTIN, MPN) merges *product models*; merging two `ci.inventory` units requires a shared serial or
evidence of being the same physical unit observed twice.

This matters most for `CvDetectionsListener`, which mints an entity per detection. A detection
carries a class label, not identity — so CV output should be a candidate *source* and never a merge
*decision*, or every chair in the house fuses into one chair.

### 3.3 Rejection is not sticky anywhere

There is no `ci.entity_merge_blocks` (or equivalent) and no `rejected` state on a candidate. A user
who declines a suggested pair will be shown it again on the next sweep — and once auto-merge exists
for tier-1 evidence, an unmerge with nothing to record the decision will simply be re-performed.
This is the standard way an ER system becomes hated, and it is cheap to prevent now.

---

## 4. Proposed order

| # | Work | Why here |
|---|---|---|
| 1 | Tombstone-aware resolve (§2.1a) + regression test | Verified live defect; small, self-contained |
| 2 | `ci.entity_merge_blocks` + wire into `PersonDuplicateService` | Must exist *before* anything auto-merges or unmerges |
| 3 | Unmerge from the `ci.entity_merges` ledger | `details` already carries the source properties; the log was built for it |
| 4 | `ci.entity_provenance` + dual-write, resolution moved onto it (§2.1b) | Converges Person/Object/Content identity; makes 1 structural |
| 5 | Place: dedupe key for `createMany`, `PlaceDuplicateService`, `PlaceMergeService` with the containment guard | The untouched type |
| 6 | Thing: `ObjectMergeService` at the model and unit levels | Schema is waiting for it |

1–3 are independently shippable and none of them changes a matching rule. 4 is the structural one.
5–6 extend to the remaining types once the primitives are settled.

**Not in scope:** cross-user merging (every key is `owner_user_id`-scoped and stays that way);
merging across `entity_type`; event merging (recurring instances are distinct occurrences, and
HBPE's token stream depends on that).

---

## 5. Notes for whoever picks this up

- Migrations: `yarn workspace @ci/be-api migrate:make <name>`. Never hand-write the timestamp —
  `bin/check-migration-versions.js` gates it and parallel branches have collided on round numbers.
- `PersonMergeService`'s relationship re-point is the subtlest code in the area. Read the two
  guards in `repointReferences` before touching it; both exist because a set-based UPDATE can
  otherwise collide with `relationships_unique_directed_idx` mid-statement.
- The merge specs are mocked, not DB-backed (`PersonMergeService.spec.ts` fakes the query
  executor). A repro for §2 fits the same style using `__testHelpers__/fakeGraphRepositories`.
- `ci.entity_identifiers` is the people index; `ci.object_identifiers` is the things index. Keeping
  them separate was deliberate — do not widen either CHECK to cover the other.
