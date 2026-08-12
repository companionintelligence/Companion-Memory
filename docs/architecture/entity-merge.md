<<<<<<< Updated upstream
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
=======
# Entity Merge — Design

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Status: **proposed** · Scope: `ci.entities` (Person, Location, Object/Item, Concept) · Owner: TBD

---

## 1. The problem

CI-Server has five independent promotion paths that mint entities:

| # | Path | Entry point | Provenance stamp |
|---|------|-------------|------------------|
| 1 | Connector ETL (Google, Microsoft, Facebook, Signal, Spotify) | `PromoteService.upsertPeopleFromParticipants` | `properties.email` lookup, then create |
| 2 | Bulk graph import (CI-Import-Tools) | `GraphIngestService.ingest` | `import:<sourceSystem>` / `uuidv5(key)` |
| 3 | Reverse geocode | `PlaceService.findOrCreateForGeocode` | `properties.source = 'reverse_geocode'` |
| 4 | Communications participant sweep | `PersonStubBackfillService` | `import:communications:participant` |
| 5 | LLM / CV inference | `GraphEnrichmentService`, `WriteKnowledgeTool`, `CvDetectionsListener` | varies; often none |

Every one of them dedupes **only against itself**, via the provenance key
`(owner_user_id, entity_type, linked_table, linked_id)` (index `entities_linked_uniq`).
Re-running a path never duplicates. Two paths describing the same person *always* duplicate.

There is no merge primitive anywhere in the codebase — no `SAME_AS`, no alias table, no
survivorship rules, no way to fold one entity into another. The gap is acknowledged in
`PersonStubBackfillService` itself:

> …the identifier index keeps pointing at whichever Person we already created — safe but not
> a merge; that's a separate chip.

### 1.1 Why the naive fix doesn't work

The obvious move — "UPDATE the referrers, DELETE the loser" — fails on this schema for three
independent reasons:

1. **Provenance is single-valued.** `ci.entities` has exactly one `(linked_table, linked_id)`
   pair. A survivor can only carry one source's key. The next sync from the *other* source
   won't find its key, and will re-create the loser. **Merge would be undone on every sync.**
   This is the crux and Section 4 is entirely about it.
2. **There are no foreign keys to lean on.** `20260127185821_remove_relationship_foreign_keys_to_entities.sql`
   deliberately dropped the FKs. ~20 columns across ~15 tables hold entity references
   (including three `UUID[]` columns), and nothing in the catalog says so.
3. **One referrer is a hypertable.** `ci.communications` (`from_entity_id`, `to_entity_ids[]`)
   cannot be rewritten in a merge transaction; it needs the same windowed walk the existing
   backfills use.

### 1.2 What already exists that we should use

- `ci.graph_deltas` already defines `change_type = 'merged'` and `change_source = 'merge_operation'`,
  with a `changed_fields` `{"name": {"old": …, "new": …}}` shape. The audit vocabulary is done.
- `ci.entity_identifiers` is unique on `(owner_user_id, kind, value_normalized)` with
  `ON CONFLICT DO NOTHING`. **That collision is the strongest merge signal in the system and it
  is currently discarded.** Section 5 recovers it for free.
- `ci.entities.is_active` / `is_archived` exist and are unused for this purpose.
- PostGIS on `ci.events.location_coordinates`; pgvector on `ci_search.embeddings`.

---

## 2. Principles

**P1 — The ledger is the merge; repointing is a projection.**
A merge takes effect the instant its ledger row commits. Rewriting the ~20 referrer columns
is an asynchronous, resumable sweep. Reads are correct in both states.

**P2 — Canonicalisation is a SQL-level primitive, not a service method.**
The HBPE sidecar reads `ci.*` directly as its training corpus. If merge resolution lives only
in TypeScript, HBPE trains on the un-merged world. Resolution must be a column + a view.

**P3 — Nothing is destroyed.**
The loser row survives, tombstoned. Every merge is reversible from the ledger alone.

**P4 — Auto-merge only on deterministic evidence.**
Shared normalized email/phone auto-merges. Name similarity never does — it suggests.
A wrong merge is far more expensive than a missed one, because it silently corrupts the
behavioural corpus HBPE trains on.

**P5 — Rejection is sticky.**
An unmerge, or a user declining a suggestion, must be recorded as a negative assertion.
Otherwise the next sweep re-proposes it forever.

---

## 3. Core mechanism

### 3.1 Tombstone + path-compressed pointer

```sql
ALTER TABLE ci.entities
    ADD COLUMN merged_into_entity_id UUID;

CREATE INDEX entities_merged_into_idx
    ON ci.entities (merged_into_entity_id)
    WHERE merged_into_entity_id IS NOT NULL;
```

`merged_into_entity_id` always points at the **current** canonical entity, never at an
intermediate. When a survivor is itself later merged, every row pointing at it is updated in
the same transaction. Resolution is therefore a single hop — no recursive CTE on the read path.
The true parent chain lives in the ledger, which is what unmerge reads.

```sql
CREATE VIEW ci.entities_canonical AS
    SELECT * FROM ci.entities WHERE merged_into_entity_id IS NULL;

CREATE FUNCTION ci.entity_canonical(p_id UUID) RETURNS UUID
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(e.merged_into_entity_id, e.entity_id)
      FROM ci.entities e WHERE e.entity_id = p_id;
$$;
```

HBPE and any direct-SQL consumer switch from `ci.entities` to `ci.entities_canonical`.

### 3.2 The ledger

```sql
CREATE TABLE ci.entity_merges (
    merge_id            UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    owner_user_id       UUID NOT NULL,
    entity_type         TEXT NOT NULL,

    loser_entity_id     UUID NOT NULL,
    -- The DIRECT survivor at merge time, not the compressed target. Unmerge
    -- reconstructs the chain from these.
    survivor_entity_id  UUID NOT NULL,

    -- 'identifier' | 'geo' | 'provenance' | 'manual' | 'llm'
    strategy            TEXT NOT NULL,
    -- 'auto' | 'user_confirmed' | 'user_initiated'
    decided_by          TEXT NOT NULL,
    confidence          DOUBLE PRECISION,
    -- The matched values that justified it: {"email": ["a@b.c"], "distance_m": 12}
    evidence            JSONB NOT NULL DEFAULT '{}',
    -- Full pre-merge snapshot of the loser + the survivor fields we overwrote.
    -- This is what makes unmerge exact rather than approximate.
    before_snapshot     JSONB NOT NULL,

    merged_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    reverted_at         TIMESTAMPTZ,
    reverted_reason     TEXT,

    CONSTRAINT entity_merges_no_self CHECK (loser_entity_id <> survivor_entity_id)
);

CREATE UNIQUE INDEX entity_merges_active_loser_uniq
    ON ci.entity_merges (loser_entity_id) WHERE reverted_at IS NULL;
```

One active merge per loser. An entity can absorb many; it can be absorbed once.

Each merge also writes a `ci.graph_deltas` row with `change_type = 'merged'`,
`change_source = 'merge_operation'` — the existing audit surface, no new plumbing.

### 3.3 The merge transaction

Synchronous, short, and touches only graph-local tables:

1. Lock both rows `FOR UPDATE` in `entity_id` order (deadlock-free).
2. Assert both are canonical (`merged_into_entity_id IS NULL`) and same `owner_user_id`
   and `entity_type`. Reject otherwise.
3. Assert no active block row for the pair (§9).
4. Compute survivorship (§7); write merged fields onto the survivor.
5. Repoint `ci.entity_provenance` rows loser → survivor (§4).
6. Repoint `ci.entity_identifiers` rows loser → survivor.
7. Fold `ci.relationships` (§8).
8. Set `loser.merged_into_entity_id = survivor`, `is_active = FALSE`.
9. Path-compress: `UPDATE ci.entities SET merged_into_entity_id = survivor WHERE merged_into_entity_id = loser`.
10. Insert ledger row + `graph_deltas` row.
11. Enqueue: referrer repoint sweep (§6), survivor re-embed, search reindex.

Everything else — the ~20 referrer columns, the hypertable, the search index — happens after.

---

## 4. The provenance refactor (prerequisite)

**Without this, merge does not survive the next sync.** It is not optional and it should land
before any merge code.

Move provenance from a single-valued pair on the entity row to a many-to-one table:

```sql
CREATE TABLE ci.entity_provenance (
    provenance_id   UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    owner_user_id   UUID NOT NULL,
    entity_id       UUID NOT NULL,
    -- 'apple_contacts', 'google:contacts', 'communications:participant',
    -- 'reverse_geocode', 'cv:detection', 'self', …
    source_system   TEXT NOT NULL,
    -- The importer-stable natural key, verbatim (NOT the uuid5 of it).
    natural_key     TEXT NOT NULL,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT entity_provenance_uniq UNIQUE (owner_user_id, source_system, natural_key)
);

CREATE INDEX entity_provenance_entity_idx ON ci.entity_provenance (entity_id);
```

Every promotion path resolves `(source_system, natural_key) → entity_id` **through this table**
instead of through `entities.linked_table/linked_id`.

The payoff:

- Apple Contacts' key and the communications-stub key can both point at the same survivor.
- On merge, all of the loser's provenance rows repoint. The next Apple Contacts sync looks up
  its own key, finds the survivor, and **updates the survivor instead of resurrecting the loser.**
- A source that later stops carrying an entity is visible as a stale `last_seen_at` rather than
  as a phantom duplicate.

Migration path: backfill one row per existing entity from `(linked_table, linked_id)` —
`source_system = ltrim(linked_table, 'import:')`. Keep `linked_table`/`linked_id` and
`entities_linked_uniq` in place as a read-compat shim; dual-write for one release; then
`GraphIngestService`, `PersonService.create/createMany`, `ConceptService`, `ItemService`,
`ContentService`, and `EventService` switch their idempotency lookups over and the columns
are dropped.

One wrinkle to fix while here: `PromoteService` looks up people via
`personService.search({ properties: { email } })`, which matches the **raw** stored value,
while `ci.entity_identifiers` stores the **normalized** one. Those two disagree on the same
mailbox. Route path 1 through `EntityIdentifierService.findEntityIdByIdentifier` so all five
paths share one resolution rule.

---

## 5. Candidate generation

### 5.1 Free signal: the identifier collision

`EntityIdentifierService.upsertForEntities` currently does `ON CONFLICT DO NOTHING`. Change it
to `RETURNING` the conflicting row, and when the incumbent `entity_id` differs from the
incoming one, emit a merge candidate.

This costs nothing extra — no scan, no similarity pass — and it fires exactly when two paths
claim the same email, phone, or normalized display name. That is the single highest-precision
signal available, and today it is thrown away. It alone resolves the
Apple-Contacts-vs-mail-header duplicate that motivates this whole design.

### 5.2 Candidate table

```sql
CREATE TABLE ci.entity_merge_candidates (
    candidate_id    UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    owner_user_id   UUID NOT NULL,
    entity_type     TEXT NOT NULL,
    -- Ordered pair: least(a,b), greatest(a,b), so a pair is proposed once.
    entity_id_a     UUID NOT NULL,
    entity_id_b     UUID NOT NULL,
    strategy        TEXT NOT NULL,
    score           DOUBLE PRECISION NOT NULL,
    evidence        JSONB NOT NULL DEFAULT '{}',
    -- 'pending' | 'auto_merged' | 'confirmed' | 'rejected' | 'stale'
    state           TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at      TIMESTAMPTZ,

    CONSTRAINT emc_ordered CHECK (entity_id_a < entity_id_b)
);

CREATE UNIQUE INDEX emc_pair_uniq
    ON ci.entity_merge_candidates (entity_id_a, entity_id_b) WHERE state = 'pending';
```

### 5.3 Blocking

Never compare all pairs. Candidates come only from a blocking key:

| Type | Blocking key |
|------|-------------|
| Person | normalized email / phone / name (the identifier index *is* the block) |
| Location | PostGIS `ST_DWithin` on a geohash-bucketed grid |
| Object/Item | `properties.type` + trigram bucket on name |
| Concept | `properties.type` + kNN over `ci_search.embeddings` (top-k, not all-pairs) |

---

## 6. Type-specific matching

The user-facing question — *when are two representations the same thing?* — has a genuinely
different answer per type. Getting this wrong in either direction is the main risk.

### 6.1 Person

| Tier | Evidence | Action |
|------|----------|--------|
| 1 | Shared normalized email **or** phone | **auto-merge** |
| 2 | Shared normalized name **and** a corroborator: same `connection_id`, co-attendance on ≥2 events, or ≥1 shared relationship neighbour | suggest at high confidence |
| 3 | Name trigram similarity alone, or embedding proximity alone | suggest, low confidence |

Tier 1 is safe because `normalizeEmail` already strips RFC-5322 display names
(`"Max <max@…>"` → `max@…`) and `normalizePhone` takes the last 10 digits, so both sides of a
comparison have been through the identical rule.

Tier 2 exists because chat networks (Messenger, Instagram) export display names only — that is
precisely why `kind = 'name'` was added to the identifier index. A bare display-name match is
*not* enough to auto-merge: "John Smith" is not a key. It needs a second, independent signal.

**Never auto-merge the self entity** (`ci.users.entity_id`, `properties.is_self`) into anything.
Merging *into* it requires explicit user action.

### 6.2 Location

Geometry is the discriminator, but distance alone is never sufficient:

- Two Starbucks 50 m apart are **two places**.
- The same Starbucks geocoded twice, 200 m apart, is **one place**.

So the rule is conjunctive — `ST_DWithin` **and** name agreement:

```
merge if  ST_DWithin(a.geog, b.geog, radius(a.type, b.type))
      and similarity(normalize_name(a.name), normalize_name(b.name)) > 0.8
      and no conflicting address component (street_number, postal_code)
```

`radius` scales by place kind: dwelling ~30 m, venue ~100 m, campus/airport ~2 km. The existing
`findOrCreateForGeocode` 3-decimal (~110 m) rule stays as the *dedupe* key for that one path;
it is deliberately tighter than the merge radius and the two serve different jobs.

**Containment is not identity.** "Starbucks on Main St" ⊂ "Main St" ⊂ "Seattle" will match
spatially. When two Locations match on distance but their precision/extent differs by more than
an order of magnitude, emit a `CONTAINED_BY` relationship — never a merge. This is the most
likely source of a catastrophic bad merge (folding a city into a café), and it needs an explicit
guard rather than a threshold.

Note `PlaceService.createMany` has **no** dedup key at all today, so bulk import re-inserts every
place on every run. That should be fixed at the provenance layer (§4) rather than left for the
merger to clean up afterwards.

### 6.3 Object / Item — the type-vs-instance trap

These are two different questions and conflating them is the classic failure:

- **Type** ("Sony WH-1000XM5" as a product class): merges on GTIN/model/normalized name.
  Reasonable to auto-merge.
- **Instance** (my specific pair of headphones): **two of the same product are two objects.**
  Merge only on a shared serial/asset tag, or on evidence of being the same physical object
  observed twice — same location, no co-occurrence in a single observation.

This matters directly for `CvDetectionsListener`, which mints an entity per detection. A naive
"same label ⇒ same thing" merger folds every chair in the house into one chair, and every
unrecognised face into one person. **CV detections should default to instance semantics and never
auto-merge** — they carry no identity evidence, only a class label. They are a candidate *source*,
never a merge *decision*.

### 6.4 Concept

Concepts are intensional — "Pilates" and "pilates" genuinely are one concept — so they are the
safest auto-merge, on normalized name within the same `properties.type`. Embedding cosine
similarity over `ci_search.embeddings` (already indexed) is a good tier-2 signal here in a way it
is not for people, because concept names carry their meaning.

Constrain to `PREFERENCE_CONCEPT_TYPES` semantics: do not merge across `properties.type`
(`food` "Orange" ≠ `music_genre` "Orange").

### 6.5 Event — explicitly out of scope

Events dedupe on their provenance triple. Merging two events is usually wrong (recurring
instances are distinct occurrences, and HBPE's token stream depends on that). Excluded from v1.

---

## 7. Survivorship

Field-level and source-ranked, not row-level. Precedence, highest first:

```
user_edit > contact_import (apple/google/microsoft contacts)
          > connector_sync (calendar, mail, spotify…)
          > communications_stub
          > llm_inference
          > cv_detection
```

Per field, take the value from the highest-precedence source that has one. Record the winner's
source in `properties._provenance = {"name": "contact_import", …}` so the next merge is
deterministic and a later low-rank correction cannot clobber a user edit.

Type-specific rules:

- **Arrays** (`emails`, `phones`, `aliases`) → **union**, never pick.
- **`name`** → highest precedence wins; every loser name is appended to `aliases`.
- **`properties`** → deep merge with precedence. Not `{...a, ...b}` — that lets an LLM-inferred
  scalar silently overwrite an imported one.
- **`created_at`** → `min()`. The merged entity is as old as the earliest observation.
- **Embedding** → **recompute, do not average.** `search_content` has changed, and the mean of
  two 768-dim vectors from different text is not a meaningful point. Delete the loser's
  `ci_search.embeddings` row and enqueue a re-embed of the survivor.
- **Tags** (`ci_search.entity_tag`) → union, deduped on the `(entity_type, entity_id, tag_id)`
  unique index.

---

## 8. Relationship folding

Two hazards, both already encoded as constraints on `ci.relationships`:

**Self-references.** `CONSTRAINT no_self_references CHECK (from_entity_id != to_entity_id)`.
If `A —KNOWS→ B` and A merges into B, repointing yields `B → B` and violates the CHECK. These
edges must be **dropped** (deactivated, with the fact recorded in `before_snapshot`), not
repointed. An `A —SPOUSE→ B` that turns out to be one person is a signal the merge is wrong;
log it loudly.

**Duplicate collapse.** `relationships_unique_directed_idx (from_entity_id, to_entity_id,
relationship_type) WHERE is_active = TRUE`. Repointing can collide with an existing edge. Fold
rather than fail:

- `strength` → `max()`
- `properties` → deep merge, survivor's endpoint precedence
- `[start_date, end_date]` → union of the ranges
- loser edge → `is_active = FALSE` (kept for unmerge)

Both directions must be swept — the loser can appear as `from_entity_id` or `to_entity_id`.

---

## 9. Referrer repointing

### 9.1 A registry that cannot silently rot

The ~20 referring columns have no FKs and nothing declares them. Add an explicit registry:

```ts
export const ENTITY_REFERRERS = [
  { table: 'ci.communications', column: 'from_entity_id', kind: 'scalar', timeColumn: 'time' },
  { table: 'ci.communications', column: 'to_entity_ids',  kind: 'array',  timeColumn: 'time' },
  { table: 'ci.events',         column: 'location_entity_id',    kind: 'scalar' },
  { table: 'ci.events',         column: 'organizer_entity_id',   kind: 'scalar' },
  { table: 'ci.events',         column: 'participant_entity_ids', kind: 'array' },
  { table: 'ci.activities',     column: 'participant_entity_ids', kind: 'array' },
  { table: 'ci.inventory',      column: 'object_entity_id',      kind: 'scalar' },
  { table: 'ci_search.embeddings', column: 'entity_id', kind: 'scalar', onCollision: 'delete_loser' },
  { table: 'ci_search.entity_tag', column: 'entity_id', kind: 'scalar', onCollision: 'delete_loser' },
  // … position, documents, files, devices, sensors, agents, goals, document_chunks
] as const;
```

Guard it with a test that reads `information_schema.columns` for anything matching
`%entity_id` / `%entity_ids` and asserts every hit is either registered or explicitly
exempted. A new table that adds an entity reference then fails CI instead of failing silently
years later.

### 9.2 The sweep

Driven off unswept ledger rows, resumable, idempotent (re-running finds zero rows):

- **Scalar:** `UPDATE t SET col = $survivor WHERE col = $loser`.
- **Array:** `array_replace` then de-dup — the survivor may already be present in the array:
  ```sql
  UPDATE ci.events
     SET participant_entity_ids = (
           SELECT ARRAY(SELECT DISTINCT unnest(array_replace(participant_entity_ids, $loser, $survivor)))
         )
   WHERE participant_entity_ids @> ARRAY[$loser]::uuid[];
  ```
- **Unique-constrained** (`ci_search.embeddings` is `UNIQUE (entity_type, entity_id)`;
  `entity_tag` is `UNIQUE (entity_type, entity_id, tag_id)`): a plain UPDATE throws on
  collision. Delete the loser's row, keep the survivor's, then enqueue re-embed.
- **Hypertable** (`ci.communications`): window by `time` in `DEFAULT_WINDOW_DAYS` slices exactly
  as `CommunicationLinkBackfillService` does, so Postgres can exclude chunks. Never an unbounded
  scan — that is the all-chunk Append that segfaulted TSDB 2.28.

Because reads resolve through `ci.entity_canonical()`, a half-swept merge is *correct*, just
not yet compact. That is what makes the async split safe.

---

## 10. Negative assertions and unmerge

```sql
CREATE TABLE ci.entity_merge_blocks (
    block_id      UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    owner_user_id UUID NOT NULL,
    entity_id_a   UUID NOT NULL,
    entity_id_b   UUID NOT NULL,
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT emb_ordered CHECK (entity_id_a < entity_id_b),
    CONSTRAINT emb_uniq UNIQUE (entity_id_a, entity_id_b)
);
```

A user rejecting a suggestion, or reverting a merge, writes a block row. Candidate generation
filters against it. Without this the auto-merger re-proposes — or worse, re-performs — the same
wrong merge on every sweep. This is the single most common way an ER system becomes hated.

**Unmerge** replays the ledger row backwards:

1. Assert the loser has not since absorbed others (revert those first — LIFO).
2. Restore survivor fields from `before_snapshot`.
3. Move provenance + identifier rows back to the loser.
4. Reactivate folded relationships; drop edges created by the fold.
5. Clear `merged_into_entity_id`; un-compress any rows that were pointed past the loser.
6. Set `reverted_at`; write a block row; enqueue the referrer sweep in reverse.

Referrer rows already repointed are found by the reverse sweep — which is only possible because
the loser row was never deleted (**P3**).

---

## 11. Concurrency and transitivity

- **Chains.** A→B then B→C: step 9 of the merge transaction path-compresses A directly to C.
  Resolution stays one hop; the ledger keeps the real chain.
- **Cycles.** Rejected structurally: a merge whose survivor resolves to the loser fails the
  step-2 canonical assertion.
- **Races.** Two agents merging into the same survivor concurrently both take row locks in
  `entity_id` order. The second sees `merged_into_entity_id IS NOT NULL` and retries against the
  new canonical.
- **Merge vs. concurrent ingest.** An ingest that resolves a provenance key to the loser
  microseconds before the merge commits writes to a now-tombstoned entity. The referrer sweep
  runs *after* the ledger commit and picks it up; and because ingest resolves through
  `ci.entity_provenance` (which the merge repointed transactionally), the window is one
  statement wide and self-healing.

---

## 12. Effect on each promotion avenue

| Path | Change required | Post-merge behaviour |
|------|-----------------|----------------------|
| 1. Connector ETL (`PromoteService`) | Resolve via `EntityIdentifierService` (normalized) instead of raw `properties.email`; write `entity_provenance` | Re-sync resolves to survivor; no resurrection |
| 2. Bulk import (`GraphIngestService`) | `upsertEntities` keys on `entity_provenance` rather than `linked_table/linked_id`; `indexIdentifiers` emits candidates on conflict (§5.1) | Idempotent re-import respects prior merges |
| 3. Reverse geocode (`PlaceService`) | Keep the 3dp dedupe key; add provenance row; feed the geo matcher | Tighter-than-merge dedupe, unchanged; merger handles cross-source |
| 4. Communications stubs (`PersonStubBackfillService`) | Unchanged — already delegates to `GraphIngestService`. Gains candidate emission for free | A stub that collides with a real contact becomes a candidate instead of an orphan |
| 5. LLM / CV | Emit provenance with `source_system = 'llm_inference'` / `'cv:detection'`; lowest survivorship rank; **never auto-merge** | Inference can propose, never decide |

The `PlaceService.createMany` no-dedup-key gap and the raw-vs-normalized email mismatch in
`PromoteService` are both prerequisites, not merger responsibilities.

---

## 13. Rollout

Each phase is independently shippable and reversible.

| Phase | Deliverable | Risk |
|-------|-------------|------|
| 0 | Referrer registry + `information_schema` guard test. No behaviour change | none |
| 1 | `ci.entity_provenance` + backfill + dual-write; promotion paths read through it | medium — touches every ingest path |
| 2 | Candidate emission from identifier collision. **Observe only, nothing merges** | none; pure signal |
| 3 | Ledger, `merged_into_entity_id`, canonical view/function, manual merge API + UI, async sweeper | medium |
| 4 | Tier-1 auto-merge (shared email/phone) for Person only | low, given phase 2 data |
| 5 | Geo matcher for Location; concept matcher; tier-2/3 as suggestions in the existing insight surface | low |

Phase 2 is the one to run longest — it tells you the real duplicate rate per source pair before
anything is irreversible.

Migration files must be created with `yarn workspace @ci/be-api migrate:make <name>`
(never hand-write the timestamp prefix — see CLAUDE.md).

---

## 14. Explicitly out of scope

- Event merging (§6.5).
- Cross-user merging. Every key is `owner_user_id`-scoped and stays that way.
- Probabilistic record linkage at scale (Fellegi–Sunter, learned blocking). The blocking keys in
  §5.3 are sufficient for single-user corpora; revisit only if candidate volume demands it.
- Merging across `entity_type`. A Person and a Concept named "Pilates" are not the same thing.
>>>>>>> Stashed changes
