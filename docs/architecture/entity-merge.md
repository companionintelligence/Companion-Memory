# Entity Identity & Merge — State of Play

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Status: **survey + design for the unbuilt parts** · Scope: `ci.entities` Person / Location / Object / Concept
· Re-verified against `main` on **2026-08-19** (after PR [#2176](https://github.com/companionintelligence/CI-Server/pull/2176),
merge `ead9fb425`), which shipped the Thing half this document previously listed as unbuilt.

This file reconciles two versions that were concatenated by an unresolved `git stash pop` in
c81768074 ("Fix/cleanup (#1955)"): the post-#1810 survey, and the pre-#1810 design draft that the
survey had already superseded. The survey is the spine — it describes a merge primitive that
exists. The draft's design of the parts that are *still unbuilt* is folded in below, re-checked
against the schema and services on `main` rather than carried over as written; anything it proposed
that has since shipped in a different shape is described in its shipped shape.

Section **2.1(b)** is cited from `GraphIngestService.ts`. Do not renumber it.

---

## 1. What landed

### 1.1 People identity and merge — #1810 (`20260803211455_add_person_identity_and_merge.sql`)

- `ci.entities.merged_into_entity_id` — tombstone pointer, indexed.
- `ci.entity_merges` — audit log, one row per `(source_entity_id → target_entity_id)`, with
  per-table re-point counts and the source's pre-merge properties in
  `details` (`{ counts, sourceProperties }`). **The Person and Location `counts` were constants
  until the `countAffected` fix** (2026-09-29): each was `….length` of a bare
  `UPDATE/DELETE … RETURNING`, which TypeORM resolves to the pair `[rows, rowCount]`, so every
  Person count read 2 and `relationshipsDropped` 6, and every Location count 2, 4 or 6, whatever
  moved. Rows written before the fix still carry those numbers — see §5.4. `relationshipsRescued`
  (the final relationship sweep, §5.2) is newer still: a Person or Location merge row written before
  it has no such key, which means "not counted", not "none".
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
tombstones are removed from *both* search stores (`ci_search.embeddings` and
`ci_search.vectors`). The merge used to lift `timescaledb.max_tuples_decompressed_per_dml_transaction`
for its `ci.communications` re-points; that table stopped being a hypertable in
`20260807072321_dehypertable_communications`, and the dead lift was removed. `PlaceMergeService`
keeps it, because `ci.position` is still a compressed hypertable.

### 1.2 Object identity — schema (`20260803223013`–`20260803223025`), services since #2176

- `ci.product_models` — the catalog half of the product/instance split.
- `ci.object_identifiers` — GTIN/serial index, deliberately *separate* from
  `ci.entity_identifiers` rather than widening its CHECK, so people-resolution and
  thing-resolution do not share one unique index.
- `ci.object_observations` — a sighting ("a mug is visible in this photo") as a distinct, weaker
  claim than ownership ("I own this mug"), which is what the retired inventory listener was conflating.
- `ci.objects` gained `merged_into_object_id`, a model link, a lifecycle and a confidence.

`ObjectMergeService` and `ObjectDuplicateService` are named in those migrations' comments as the
owners of re-pointing and duplicate surfacing. **Both shipped on 2026-08-19 in
[#2176](https://github.com/companionintelligence/CI-Server/pull/2176)** — see §3.2 for what they
encode and what is still open.

### 1.3 What landed after the survey was written

Three pieces shipped between #1840 and today, and they close items this document previously listed
as open:

- **`ci.entity_merge_blocks`** (`20260805151501`) — negative assertions, deliberately
  entity-agnostic (an ordered `(entity_id_a, entity_id_b)` pair is the whole assertion, with
  `reason ∈ {user_rejected, unmerged}`). `EntityMergeBlockService` is wired into
  `PersonDuplicateService` and `PersonResolver`, so a rejected pair is not re-proposed. This was
  item 2 of the old ordering; §3.4 records what it changes.
- **Tombstone-aware resolution** — both resolution paths now follow the pointer. See §2.1(a).
- **The CLEAN pipeline generation** (`20260809183010`, `20260809184710`) — `ci.identifier_claims`
  and `ci.merge_candidates`, with `IdentifierNormalizeStage`, `PersonLinkStage` and
  `DuplicateDetectStage`. Two things matter here for merge:
  - `ci.identifier_claims` records **every** identifier observation — winning, losing and
    unresolved — because `ci.entity_identifiers`' `ON CONFLICT DO NOTHING` was discarding the
    losing claim, which is the single strongest duplicate signal in the system. That discard is
    also why `PersonDuplicateService` has to `unnest` `properties->'emails'` instead of grouping
    the identifier index.
  - `ci.merge_candidates` is the review queue: ordered pair, unique per
    `(owner, entity_type, a, b)`, `status ∈ {pending, accepted, rejected}`, plus
    `detected_by`/`detector_version`. **CLEAN proposes and a human disposes** —
    `DuplicateDetectStage` never writes `merged_into_entity_id`, and a bump of its scoring or
    candidate generation rescores pending pairs without resurrecting rejected ones.

  `DuplicateDetectStage` currently covers `entity_type = 'Person'` only.

  **A merge carries the claims with it** (2026-09-29). Until then `PersonMergeService` re-pointed
  `ci.entity_identifiers` but not `ci.identifier_claims.entity_id`, so a source's claims — its
  `enrich.person_self_claim` self claims included — stayed on the tombstone. The detector's holder
  join admits live people only, so they stopped being evidence, and the source~third pair it had
  already proposed went moot with the source. Nothing re-examined the survivor either: the ledger
  re-runs a stage only on a version bump. A third copy sharing only the merged-away card's address
  or number was therefore never proposed against the survivor. Two halves now close it:
  - **In the merge transaction**, every claim that resolved to a source is re-pointed to the target.
    Only `entity_id` moves — the observation (`subject_type`/`subject_id`, role, value), its
    `method`/`confidence` and a human's `disposition` stay. It cannot collide, because
    `identifier_claims_observation_uniq` does not include `entity_id`. A `rejected` claim moves
    too and stays rejected: every reader excludes rejected claims on both sides, and
    `enrich.person_link`'s own upsert would move it the same way. The count is
    `details.counts.claims`. In the same transaction each source's `ci.entity_merge_blocks` row is
    carried to the target as a new (target, X) row (`details.counts.blocksCarried`). Without it,
    the re-examination below would re-find a pair a human had ruled out; one evidenced by a shared
    address would then be folded by the deterministic drain.
  - **On the ledger**, `IdentifierArrivalService` (called by the control tick) re-opens a live
    survivor's `enrich.person_self_claim` and `clean.duplicate_detect` decisions recorded before a
    `ci.entity_merges` row into it, with a `CLAIM_LEASE_SECONDS` margin. The merge does not write
    the ledger itself: `PipelineStateService` is its only writer, and memory does not depend on the
    pipeline domain. The merge's audit row, committed with the claims, is the signal. It counts only
    if it records `counts.blocksCarried`. A merge from before this change moved no claims and
    carried no blocks, so its survivor waits for the next version bump, as before. That bump is
    where the old merges' uncarried blocks bite: a survivor whose self claims are re-derived from
    its folded card can be proposed against someone a human ruled out for the source.

  Proven against Postgres in `pipeline/__tests__/mergeSurvivorEvidence.integration.spec.ts`. Take
  away either half and the third copy is never proposed; take away the block carry and the
  ruled-out stranger is.

### 1.4 The promotion paths

Every path that mints an entity, and how it dedupes today. The first five are the original set;
the ledger-backed pipeline (`domains/pipeline`, §1.3) added four more after this section was
written, plus one service outside it.

| # | Path | Entry point | Provenance stamp |
|---|------|-------------|------------------|
| 1 | Connector ETL (Google, Microsoft, Facebook, Signal, Spotify) | `PromoteService.upsertPeopleFromParticipants` | `properties.email` lookup, then create |
| 2 | Bulk graph import (native import domain; ported from the retired CI-Import-Tools) | `GraphIngestService.ingest` | `import:<sourceSystem>` / `uuidv5(key)` |
| 3 | Reverse geocode | `PlaceService.findOrCreateForGeocode` | `properties.source = 'reverse_geocode'` |
| 4 | Communications participant sweep | `PersonStubBackfillService` | `import:communications:participant` |
| 5 | LLM / CV inference | `GraphEnrichmentService`, `WriteKnowledgeTool`, `CvDetectionsListener` | varies; often none |
| 6 | `promote.place` — Locations from forward-geocoded event locations | `PlacePromoteStage` → `PlaceService.findOrCreateForGeocode` + `ensureHierarchy` | provider `place_id` first, then the 0.001° snap cell |
| 7 | `promote.place_position` — Locations from reverse-geocoded position fixes | `PositionPlacePromoteStage`, composing the same two `PlaceService` methods | as #6 — deliberately one implementation, so the admin-place fold cannot fork |
| 8 | `promote.object` — `ci.objects` units from receipts and identified objects | `ObjectPromoteStage` | `ci.objects.source_type` + the provenance triple |
| 9 | `promote.observation` — sightings from `capture.scan` | `ObservationPromoteStage` → `ObjectObservationService` | the observation table's own idempotency arbiters |
| 10 | Receipt lines → owned units | `ObjectMintService` | `source_type = 'receipt-line'`, triple `(receipt-line, <receipt source_system>, …)` |

Paths 6–10 are ledger-gated rather than nullability-gated: re-processing is a version bump in
`versions.ts`, not a backfill (see [adr-pipeline-ledger.md](adr-pipeline-ledger.md)).

Each dedupes **only against itself**, via `(owner_user_id, entity_type, linked_table, linked_id)`
(index `entities_linked_uniq`) or, for #6–#10, its own natural key. Re-running a path never
duplicates. Two paths describing the same person still always duplicate — that is what §2.1(b) is
for.

### 1.5 A related design landed in the same window

`docs/prd/unified-content-identity-lifecycle-embeds.md` (Track 3, §4) defines an identity ladder —
`src > url > sha256 > txt > nat` — plus `ci.object_merge_candidates`, whose header calls out
`ci.entity_identifiers`' `.orIgnore()` as the thing that forced `PersonDuplicateService` to
re-derive normalization in SQL. **Anything built here should adopt that ladder's vocabulary rather
than inventing a third one.**

Two caveats on that document, as of 2026-08-19: `backend/apps/api/src/domains/identity` implements
the ladder but **nothing imports it** — the identity rules actually in force are
`ci.entity_identifiers` (people, normalized by `graph/utils/normalizeIdentifier.ts`),
`ci.object_identifiers` (things, `graph/utils/normalizeObjectIdentifier.ts`) and the
`(owner_user_id, entity_type, linked_table, linked_id)` upsert coordinate. And
`ci.object_merge_candidates` was never created; the Thing duplicate queue that shipped is
`ObjectDuplicateService` computing groups on read (§3.2), not a persisted candidate table.

---

## 2. Provenance is single-valued, so a merge is bypassed on the next sync

Entity resolution keys on `(owner_user_id, entity_type, linked_table, linked_id)`. A tombstone
keeps its linked key, so it keeps winning that lookup. Reproduced against `GraphIngestService`
with a seeded tombstone: ingesting the source's own natural key after the merge resolved to the
**tombstone's** entity id, not the canonical one.

Consequences, in order of severity:

1. The next Apple Contacts / Google / Signal sync writes name, description and properties onto a
   dead row. The merged person silently stops receiving updates from that source.
2. Relationships from that batch attach to the tombstone. The graph accumulates live edges
   pointing at a tombstoned node.
3. `indexIdentifiers` is the one part that degrades safely — the merge re-pointed those identifier
   rows to the target, so the `ON CONFLICT DO NOTHING` keeps them there.

The merge was never undone (the tombstone is not resurrected as a visible person), but it was
**bypassed**: the source that fed the duplicate went on feeding a corpse.

### 2.1 The fix

Two layers, and both are needed.

**(a) Follow the pointer on resolve — shipped.** Every linked-key lookup resolves the tombstone to
its canonical target:

- `GraphIngestService` resolves through `canonicalIdOf` (`mergedIntoEntityId ?? entityId`), and
  excludes tombstones from the `DO UPDATE` outright — otherwise the upsert would write a fresh
  name and properties onto the merged-away row and hand its id back via `RETURNING`, undoing the
  tombstone-following one step earlier. The source's update is *dropped* rather than misapplied.
- `PersonService.resolveTombstone` does the same for `create`'s `linkedWhere` lookup and for the
  `23505` race path.

One hop is enough by construction: `PersonMergeService` re-points existing tombstones at the new
target as part of merging, so `merged_into_entity_id` never chains. That invariant is asserted in
`PersonMergeService.spec`.

This fixed the observable bug. It did not make the model coherent — a dropped update is still a
lost update.

**(b) Make provenance many-to-one — not built.** `ci.entities` has exactly *one*
`(linked_table, linked_id)` pair, so a survivor can only carry one source's key — which is *why*
the loser has to be kept around to hold the other one, and why (a) can only drop the second
source's write instead of applying it. A `ci.entity_provenance` table keyed on
`(owner_user_id, source_system, natural_key) → entity_id` lets the canonical row carry every
source's key directly and makes (a) a consequence rather than a patch. This is also the shape
`ci.object_identifiers` and the content-identity ladder already use, so it converges the three
models instead of adding a fourth.

### 2.2 `ci.entity_provenance`

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

Every promotion path in §1.4 resolves `(source_system, natural_key) → entity_id` **through this
table** instead of through `entities.linked_table/linked_id`.

The payoff:

- Apple Contacts' key and the communications-stub key can both point at the same survivor.
- On merge, all of the loser's provenance rows re-point. The next Apple Contacts sync looks up its
  own key, finds the survivor, and **updates the survivor** — instead of today's outcome, where
  the write is discarded to avoid resurrecting the loser.
- A source that later stops carrying an entity is visible as a stale `last_seen_at` rather than as
  a phantom duplicate.

Migration path: backfill one row per existing entity from `(linked_table, linked_id)` —
`source_system = ltrim(linked_table, 'import:')`. Keep `linked_table`/`linked_id` and
`entities_linked_uniq` in place as a read-compat shim; dual-write for one release; then
`GraphIngestService`, `PersonService.create/createMany`, `ConceptService`, `ItemService`,
`ContentService`, and `EventService` switch their idempotency lookups over and the columns are
dropped.

One wrinkle to fix while here: `PromoteService` still looks people up via
`personService.search({ properties: { email } })`, which matches the **raw** stored value, while
`ci.entity_identifiers` stores the **normalized** one. Those two disagree on the same mailbox.
Route path 1 through the identifier index so all five paths share one resolution rule.

---

## 3. Gap matrix

| | promotion | duplicate detection | merge service | survives re-sync | unmerge | rejection is sticky |
|---|---|---|---|---|---|---|
| **Person** | ✅ 5 paths | ✅ `PersonDuplicateService` + `DuplicateDetectStage` | ✅ `PersonMergeService` | ⚠️ §2.1(a) only | ❌ | ✅ `ci.entity_merge_blocks`, written by `PersonResolver` |
| **Place** | ✅ geocode + import + `promote.place` / `promote.place_position` | ❌ none | ❌ none | — | ❌ | ⚠️ table is type-agnostic, nothing writes it |
| **Thing** | ✅ + observations + `promote.object` / `ObjectMintService` | ✅ `ObjectDuplicateService` | ✅ `ObjectMergeService` (units *and* models) | ⚠️ §2.1(a) only | ❌ | ⚠️ `ObjectDuplicateService` *reads* blocks; nothing writes one for a Thing pair |
| **Concept** | ✅ enrichment | ❌ none | ❌ none | — | ❌ | ⚠️ as Place |

### 3.1 Place is the untouched one *for merge*

`PlaceService.findOrCreateForGeocode` dedupes within *its own path*: the provider `place_id` claim
in `properties` is the primary identity when the geocoder supplied one, and the fallback is
`(owner, lower(btrim(name)), round(lat,3), round(lng,3))` — ~110 m. Nothing dedupes across paths,
and `PlaceService.createMany` still has **no dedup key at all** (the comment saying so is still in
the file), so a bulk import re-inserts every place on every run. That is a provenance-layer fix
(§2.2), not something the merger should clean up afterwards.

**What did land for places since this was written** (#1811/#1813/#2161) is geography and hierarchy,
not merge: typed PostGIS `location_point` / `location_boundary` geography columns on `ci.entities`
plus `place_kind` and `parent_place_id` (`20260803213950_add_place_geography_and_hierarchy.sql`),
an `ensureHierarchy` fold that mints shared city → region → country admin nodes deduped per parent
via `entities_admin_place_uniq`, and two spatial reads — `placesNear` (ST_DWithin) and
`placesContaining` (ST_Covers, smallest footprint first). There is still **no** `PlaceMergeService`
and no `PlaceDuplicateService`; the rule below is still a design, not code.

Place matching needs a rule of its own, because distance alone is wrong in both directions: two
Starbucks 50 m apart are two places; the same Starbucks geocoded twice 200 m apart is one. The rule
is conjunctive:

```
merge if  ST_DWithin(a.geog, b.geog, radius(a.type, b.type))
      and similarity(normalize_name(a.name), normalize_name(b.name)) > 0.8
      and no conflicting address component (street_number, postal_code)
```

`radius` scales by place kind: dwelling ~30 m, venue ~100 m, campus/airport ~2 km. The existing
`findOrCreateForGeocode` 3-decimal rule stays as the *dedupe* key for that one path; it is
deliberately tighter than the merge radius and the two serve different jobs.

The distinctive hazard is **containment, which is not identity**: café ⊂ street ⊂ city all match
spatially. When two Locations match on distance but their precision/extent differs by more than an
order of magnitude, the answer is a `CONTAINED_BY` relationship, never a merge. That needs an
explicit guard, not a threshold — it is the most likely route to a catastrophic bad merge (folding
a city into a café).

### 3.2 Thing — shipped in #2176, and the instance/model rule it encodes

The product/instance split was right and already modelled; the services that use it landed on
2026-08-19. The distinction this section asked for is honoured in the shipped shape — `ci.entity_merges`
rows are written under `entity_type` `'ObjectInstance'` for owned units and `'ProductModel'` for
catalog models, so the two are separate audit lineages rather than one blurred one:

- **Model** ("Sony WH-1000XM5" as a product class): merges on GTIN/MPN/normalized name.
  `ObjectMergeService.mergeProductModels` re-points identifiers, receipt line items,
  `ci.objects.product_id` and observations.
- **Instance** (my specific pair): **two of the same product are two objects.**
  `ObjectMergeService` folds units, moving identifiers, observations, inventory parent/related
  links, receipt line items, tag links, and deleting the source's search rows.

**Nothing auto-merges.** `ObjectDuplicateService` is candidate generation only — three rungs,
strongest first: `identifier` (unnesting `ci.objects.identifier_codes` and unioning the
`ci.object_identifiers` claim index, because that index is first-writer-wins and therefore hides
the duplicate by construction), then `product_name`, then `brand_model`. Groups are capped at six
members and carry `totalItems` so the UI can say "showing 6 of 900" for the junk-SKU groups a bad
import creates; identifiers shorter than six characters are not grouped on at all, because "1" and
"N/A" appear in identifier bags far more often as placeholders than as identity. The merge itself
is `mergeItems` / `mergeProductModels`, a user decision.

`ObjectDuplicateService` also *reads* `ci.entity_merge_blocks` (`blockedPairsAmong`) and greedily
drops members until no rejected pair remains in a group — because the review UI merges a group
whole, so one rejected pair inside a bigger group would re-propose that rejection. What is still
missing on the Thing side is the **writer**: there is no reject mutation for an item pair, so
nothing puts a block row there in the first place (§3.4).

The instance rule matters most for `CvDetectionsListener`, which mints an entity per detection. A
detection carries a class label, not identity, so a naive "same label ⇒ same thing" merger folds
every chair in the house into one chair and every unrecognised face into one person. **CV output
should default to instance semantics and never auto-merge** — a candidate *source*, never a merge
*decision*.

### 3.3 Concept

Concepts are intensional — "Pilates" and "pilates" genuinely are one concept — so they are the
safest auto-merge, on normalized name within the same `properties.type`. Embedding cosine
similarity over `ci_search.embeddings` is a good second signal here in a way it is not for people,
because concept names carry their meaning. Do not merge across `properties.type`: `food` "Orange"
≠ `music_genre` "Orange".

### 3.4 Rejection is sticky for Person, and unclaimed for everything else

`ci.entity_merge_blocks` exists and is entity-agnostic by design, and `ci.merge_candidates` keeps a
`rejected` status that a rescoring bump will not overwrite. For Person that closes the loop: a user
who declines a suggested pair is not shown it again.

Nothing writes a block row for Place, Thing or Concept. For Place and Concept that is because
nothing proposes those pairs yet — the table is ready for them; the detectors are not written. For
Thing the detector now exists and *consumes* blocks (§3.2), so the only missing piece there is the
"don't ask again" mutation on the Things review UI; `PersonResolver.blockAllPairs` is the shape to
copy. What remains genuinely absent for every type is the **unmerge** side — see §5.4.

---

## 4. Principles

Carried from the design draft, annotated with where they now stand.

**P1 — The ledger is the merge; re-pointing is a projection.**
A merge takes effect the instant its ledger row commits; rewriting the ~20 referrer columns can be
an asynchronous, resumable sweep. *Today `PersonMergeService` does both synchronously in one
transaction, which is fine at current corpus sizes; `PlaceMergeService` does the same, and its
`ci.position` re-point is why it has to lift `max_tuples_decompressed_per_dml_transaction`. §5.3 is
what P1 would buy.*

**P2 — Canonicalisation should be a SQL-level primitive, not only a service method.**
The HBPE sidecar reads `ci.*` directly as its training corpus. Resolution that lives only in
TypeScript means HBPE trains on the un-merged world. *Not built: there is no `ci.entities_canonical`
view and no `ci.entity_canonical(uuid)` function. Direct-SQL consumers filter
`merged_into_entity_id IS NULL` by hand — `entitySourceMap`, `DuplicateDetectStage`,
`IdentifierNormalizeStage` each spell it out separately.*

**P3 — Nothing is destroyed.**
The loser row survives, tombstoned. *Holds.* Note that `PersonMergeService` does delete the
source's **search-index** rows — deliberately, and re-derivable.

**P4 — Auto-merge only on deterministic evidence.**
Shared normalized email/phone could auto-merge; name similarity never does — it suggests. A wrong
merge is far more expensive than a missed one, because it silently corrupts the behavioural corpus
HBPE trains on. *Holds, and is now exercised.* `DuplicateDetectStage` still only proposes into
`ci.merge_candidates` (§1.3); `MergeCandidateService.autoMergeDeterministicPairs` folds the pending
pairs in three deterministic tiers:

| Tier | Evidence | Where it is graded |
|------|----------|--------------------|
| Email | a shared normalized mailbox (evidence, claims or `properties`) — held for review, never folded, when one side is the owner and the other's name contradicts theirs (`email_check: self_endpoint`), or when two contacts' full names share nothing (`email_check: name_conflict`) | `SHARES_EXACT_EMAIL`; `utils/emailIdentity.ts` `emailHoldReason` |
| Phone | one equal, valid, ordinary number in both people's own `properties`, names compatible, line not shared (`phone` 0.95) — see the rule table below | `utils/phoneIdentity.ts` `PhoneHolders.adjudicate` |
| Profile URL | equal LinkedIn `/in/` URL sets, corroborated by a shared name token or an agreeing "Connected On" date, contradicted by neither (`profile_url` 0.95) | `utils/profileUrls.ts` `adjudicateProfileUrls` |

The phone tier (`clean.duplicate_detect` v8: `DUPLICATE_SCORING_GENERATION` 6,
`DUPLICATE_CANDIDATE_GENERATION` 3) reads `Phones` (the vCard's numbers as typed), `Faxes` (only to
refuse them), the `phones`/`phone` ten-digit keys and a display name that is a number (the Google
Voice participant stub). Its adjudicator is the only producer of a 0.95 phone item; the claim pass's
unguarded E.164 tier is capped at 0.85 (`phone_check: unadjudicated`), and the drain no longer joins
`identifier_claims.value_e164` at all.

What a contact states reaches both tiers whole. Staging used to keep ONE handle per contact — the
smallest, which is also its natural key — so a card with any phone never indexed its email (600 of
1,018 cards with an email in one real export) and mail from it minted a stub. Staging now records
every email and phone a contact states as `emails` / `phones` (`import/staging/identity.ts`
`contactIdentifiers`), less a shared handle (a fax anywhere in the export, or a line another card
lists under a name that describes someone else — `markSharedContactHandles`, the same rule that
keeps them from keying the card), a fax, a number with an extension and a role inbox (`info@`),
reading a Google CSV cell joined with ` ::: ` value by value, and the push indexes them all —
except on a row that is several people: staging collapses sightings on their identity key, and a
household on one home line stays together (#2795 cannot tell a shared surname from a nickname), so
its lists hold every member's addresses. The sightings' names (`contactNames`) show it, and such a
row is indexed on its handle alone (`describesSeveralPeople`).

Migration `20260930022046` repaired the vCard rows already imported, from their own `Emails` /
`Phones`. It skips a row whose `Names` are several people, and indexes a value only when no other
card lists it under a different name: first writer wins would hand an office line, or the owner's
address, to whichever card is older. It also dropped the fake numbers extensions had left in
`phones` and in the index ("(310) 447-8675;229" keyed as 4478675229): any key the card's own typed
`Phones` proves, by one extension rule (`PHONE_EXTENSION_PATTERN`) shared by the TypeScript and the
SQL. That includes a fake a form save marked verified, because `replaceForEntity` promotes every
row it round-trips. It never removes a row a user typed (those keep their `raw_value`), and never
touches a merge survivor, whose ten digits can be a merged-in record's real line.

`enrich.person_self_claim` (v2) turns a record's `emails` / `phones` into claims, and retracts the
ones it no longer states (its own rows only).

| Rule | Detail |
|------|--------|
| Fax | A number either record files under `Faxes` is never evidence, whatever else states it: one office's fax is on every card from that office. The vCard parser files a number under `Faxes` on every card of an export once any card in it types that number FAX (`TEL;TYPE=FAX`, or a fax label): one person's duplicate cards type it on one copy and leave it bare on the next. |
| Parsing | Stated when the value says its country: `+`, `00`, `011` (NANP only), or eleven digits led by `1`. A national value is read as `+1` only under a NANP owner region and only when it is a valid geographic number. Toll-free (800/833/844/855/866/877/888, reserved 822/880–887/889), premium (900, NXX 976), personal/non-geographic (456, 500, 521–529, 533, 544, 566, 577, 588, 600, 622, 700, 710), N11 and 950/958/959 exchanges, reserved area codes (N11, N9X, 37X, 96X, 555), extensions, short codes and anything invalid are never evidence. |
| Region | The owner's own stated numbers if unanimous, else an explicit list of North American IANA zones (`UTC` and `America/Mexico_City` give none). Once the corpus states ≥ 20 numbers, ≥ 50% must be `+1` or no region is used. No region: national numbers match at most as "country not confirmed" (0.75). |
| Stated vs inferred | Per last ten digits a stated form beats an inferred one, two stated forms that disagree are unresolved, a refused raw value (a UK "020 …" number, an extension) beats the inferred reading of its own truncated `phones` key, and digits any person or claim states under another country are never read as `+1`. |
| Country conflict | The same ten digits resolving to two E.164 numbers write `phone_country_conflict` and no match. |
| Names | Exact needs the same first given name, an unambiguous initial, or a placeholder side (empty, email, @handle, or its own number in any formatting). A shared surname is never corroboration. Different given names, a prefix (Chris/Christine), a family-name conflict, a Jr/Sr (or suffix-on-one-side) mismatch, a relational or surname-only name, or a name that is someone else's number write 0.85 + `phone_check`. |
| Line census | Distinct real identities on the number, counted by the Names rule itself: two holders it would not fold (different given names, or the same given name with a family-name or Jr/Sr conflict — two Adas with different surnames on one office line) are two identities. At most 1 for a placeholder or initial pair, at most 2 for a same-given pair (`PHONE_LINE_MAX_IDENTITIES`). A holder that fits two people who cannot be one — a bare "Ada" beside both Adas, an "A." beside Ada and Abe — makes the line ambiguous, and no pair on it is exact. So does an initial that starts two different given names on the line even when it folds with only one of them: a one-sided Jr/Sr or a different surname holds a pair for review but does not prove two people, so an "A." beside "Abe Quill" and "Ada Quill Sr." may still be that Ada. The two people being judged are always counted. Otherwise `phone_check: shared_line`. |
| Holder cap | Digits more than six live people carry (`PHONE_MAX_HOLDERS`, pinned to `MAX_GROUP_MEMBERS`) are not evidence. |
| Owner and self | The self Person's numbers are never evidence between two contacts; a pair with a self endpoint is graded review (`self_endpoint`) and the drain never folds a phone-only pair into self. |
| Order | Phone verdict first, then the profile-URL veto, so `profile_url_conflict` caps a phone-exact pair at 0.8. |

Guards, all on every merge:
- **Veto.** Disjoint (`profile_url_conflict`) or overlapping-but-unequal (`profile_url_partial`)
  LinkedIn URL sets remove a pair from every tier — including a shared email — and cap its score at
  0.8. A vetoed pair is *not* hidden: it stays on the review queue, labelled, so a person can reject
  it and the rejection is sticky (P5).
- **Holder cap.** A LinkedIn URL stated by more than six live Persons (`PROFILE_URL_MAX_HOLDERS`,
  pinned equal to `MAX_GROUP_MEMBERS`) is a page pasted into many cards, not anyone's profile. It is
  removed from every holder's facts before *any* pair is graded — name and claim pairs included, not
  only pairs the URL pass found — so it can neither lift a pair to 0.95 nor veto one. Both callers
  count over the same population (`PROFILE_FACTS_CORPUS_SQL`) and grade through
  `ProfileUrlHolders.adjudicate`.
- **Live re-check.** The same adjudicator, and the same holder cap counted on the corpus as it is
  now, runs on the live rows immediately before each merge; a pair that no longer qualifies —
  including one whose URL became over-common after detection — is rewritten to reviewable evidence
  (demoted) instead of merged on stale evidence or hidden forever.
- **Phone live re-check.** A phone-only pair is re-graded by `PhoneHolders.adjudicate` on the live
  endpoints against the owner's whole phone corpus (read once per drain, kept in step after every
  merge); a rename, a number that became over-common or gained a second real identity, or a self
  endpoint demotes it to a labelled review row. A pair whose two records no longer share ANY number
  keeps its phone item only while both people are still observed with it (a claim other than their
  own self claim), held below the tier; with nothing left the row is retired, not floored.
- **Review-queue re-check.** The detector never withdraws a pair and is not re-run when a record
  changes, so before the People page shows the queue, `MergeCandidateService.revalidatePhoneEvidence`
  checks every pending pair's phone evidence as a FACT — is the number still on both records (their
  own lines, less a fax), or still observed for both? — and takes out what is not: a row that lost
  some is rewritten, a row left with nothing is deleted (pending rows only; the detector re-proposes
  if evidence returns). It never reads `ci.entity_identifiers` (unique per value, so two people can
  never both hold a number there) and never re-grades, so it needs no corpus read.
- **Two people on one mailbox.** A card that lists one person's address under another person's
  name would fold the two, and carry the card's other addresses along. The detector writes such a
  pair held (0.85, with an `email_check` marker), the drain re-checks live names before every email
  fold, and the marker keeps the pair off every tier and on the queue. Two holds:
  `self_endpoint` when one side is the self Person and the other's real name contradicts the
  owner's (the owner's own mail stubs, named by the address, still fold), and `name_conflict` when
  two contacts' full names share nothing (a different given name AND surname, no nickname prefix,
  not one token in common). The second is the one that matters in practice: the owner's own contact
  cards are ordinary Persons (the self Person is minted from `ci.users`), so a friend's card listing
  the owner's work address meets them as two contacts. In one real 4,927-card export, it holds that
  friend card against the owner's two cards and one double-typo pair, and folds the other 20
  differently spelled pairs among the 63 addresses shared across cards.
- **Self.** `users.entity_id` and any `is_self` row are always the target; a pair with two self
  endpoints is skipped. Otherwise the target is a real name over a placeholder, then the fuller name
  (`chooseMergeTarget`), because `PersonMergeService` keeps the target's display name.
- **Name alone never merges.** No name clause exists in the auto-merge predicate.

Two drains call it: the People review query folds for up to 5 s per load, and
`DeterministicPersonMergeCron.drain` (hourly, worker) keyset-drains the backlog for up to 10 min per
user. Disabling that cron on the Jobs page is the kill switch for the phone and profile-URL tiers in
both; only email pairs keep folding on read.
Every merge still writes its `ci.entity_merges` audit row.

**P5 — Rejection is sticky.**
*Shipped for Person (§3.4).*

---

## 5. Design of the parts that are still unbuilt

### 5.1 Survivorship

`PersonMergeService` today is target-wins-scalars plus union of `emails`/`phones`/`names`, and of
`Phones` (de-duplicated on the digit string) so a source's stated country survives the merge. That is
adequate for a user-initiated merge of two rows and inadequate the moment merges are proposed
automatically, because it has no notion of *which source* a field came from.

Field-level and source-ranked, precedence highest first:

```
user_edit > contact_import (apple/google/microsoft contacts)
          > connector_sync (calendar, mail, spotify…)
          > communications_stub
          > llm_inference
          > cv_detection
```

Per field, take the value from the highest-precedence source that has one, and record the winner's
source in `properties._provenance = {"name": "contact_import", …}` so the next merge is
deterministic and a later low-rank correction cannot clobber a user edit.

Type-specific rules:

- **Arrays** (`emails`, `phones`, `aliases`) → **union**, never pick.
- **`name`** → highest precedence wins; every loser name is appended to `aliases`.
- **`properties`** → deep merge with precedence. Not `{...a, ...b}` — that lets an LLM-inferred
  scalar silently overwrite an imported one.
- **`created_at`** → `min()`. The merged entity is as old as the earliest observation.
- **Embedding** → **recompute, do not average.** `search_content` has changed, and the mean of two
  vectors from different text is not a meaningful point. Delete the loser's row and enqueue a
  re-embed of the survivor. *(The delete half is what `PersonMergeService` already does.)*
- **Tags** (`ci_search.entity_tag`) → union, deduped on the `(entity_type, entity_id, tag_id)`
  unique index.

**What a later import does to the survivor — built (2026-09-29).** The survivor is usually some
source's own row, and that source keeps re-importing it. `GraphIngestService` used to refresh it
with `properties = EXCLUDED.properties`, which quietly undid every merge into an imported contact:
the next import of the survivor's card replaced the folded `phones`/`Phones`/`names` with the card's
own. The refresh is now a merge, run inside the upsert against the locked row
(`graph/utils/ingestedProperties.ts`):

- keys the source does not send are left alone, and a JSON null says nothing;
- the plural identity keys this fold unions (`IDENTITY_LIST_KEYS`) and the parser's own
  `accumulate[]` keys (carried on `ci_import.staged_entities.accumulate`) are unioned;
- any other key the source sends takes its new value, and `name`/`description` do too unless null.

The re-key that moves a row onto a new import key (`rekeyImportedEntities`, `resetProperties`) rests
on the same rule: it empties what the SOURCE put in the row and keeps the identity values its
standing merges brought in — the same `IDENTITY_LIST_KEYS` — and the ingest that follows unions the
card's values into them. Before this refresh was a merge, that following ingest would have replaced
the kept values too. The repair migration `restore_merged_person_identity_lists` (#2796) puts back
what earlier re-imports erased; it only stays put with this refresh in place.

Two limits follow from there being no per-key provenance yet: an import cannot *remove* a member of
a unioned list, and a key the source itself sends (`avatar_url` on a vCard) still overrides a user
edit of it. The precedence scheme above is what resolves the second.

### 5.2 Relationship folding

Two hazards, both already encoded as constraints on `ci.relationships`, and both already guarded in
`PersonMergeService.repointReferences` — this is the rule those guards implement.

**Self-references.** `CONSTRAINT no_self_references CHECK (from_entity_id != to_entity_id)`. If
`A —KNOWS→ B` and A merges into B, re-pointing yields `B → B`. These edges must be **dropped**
(deactivated, and counted — `relationshipsDropped` in the audit row), not re-pointed. An
`A —SPOUSE→ B` that turns out to be one person is a signal the merge is wrong; log it loudly.

**Duplicate collapse.** `relationships_unique_directed_idx (from_entity_id, to_entity_id,
relationship_type) WHERE is_active = TRUE`. Re-pointing can collide with an existing edge. Fold
rather than fail:

- `strength` → `max()`
- `properties` → deep merge, survivor's endpoint precedence
- `[start_date, end_date]` → union of the ranges
- loser edge → `is_active = FALSE` (kept for unmerge)

Both directions must be swept — the loser can appear as `from_entity_id` or `to_entity_id`.

**Edges that arrive while the merge runs.** `PersonMergeService.repointReferences` and
`PlaceMergeService.repointReferences` are each one READ COMMITTED transaction, so each statement sees
what had committed when *it* started. The edge projection reads the very columns the merge is
rewriting and, until the merge commits, still sees the loser: it writes the **loser's** edge, to a
table with no foreign key that could make it wait. (For people that is `promote.edge_communication` /
`promote.edge_event`; for places `promote.edge_event`, `promote.edge_position` and `promote.edge_place`,
which read `events.location_entity_id`, `position.location_entity_id` and `parent_place_id` — the last
puts the loser at the *from* end of its `Place → Place` edge.) The guarded UPDATEs cannot move an edge
they cannot see, and the statement after them used to be a plain `DELETE` of whatever loser edges were
left — on the premise that the UPDATEs had declined each as a duplicate. An edge committed in
between was deleted instead: no delta, the merge committed the columns pointing at the survivor, and
the leg's ledger row (`running` throughout) was stamped `done`, so nothing ever offered the row
again. Five SENT/RECEIVED edges went that way in one person merge on the reference appliance.

That statement is now a **sweep**, one per end of the edge, run after both guarded re-points
(`sweepLeftoverEdges` in `memory/services/mergeEdgeSweep.ts`, shared by both merges). Its DELETE and
its INSERT share a snapshot, so whatever the DELETE sees the INSERT puts back on the target — the
same row, `relationship_id` and every other column kept — except that:

- an active edge whose shape the target already holds conflicts with
  `relationships_unique_directed_idx` and is dropped (`ON CONFLICT DO NOTHING`), as the UPDATE would
  have declined it; of several sources' edges of one shape the oldest is kept;
- an edge whose other end is a source or the target is dropped, not inserted — re-pointed it would
  be a self-reference, and `no_self_references` is a CHECK, which no `ON CONFLICT` absorbs and which
  would abort the merge;
- an inactive edge is outside the index and kept, as the UPDATE keeps it.

An edge the sweep moves is written as a `relationship/updated` delta (`change_source`
`PersonMergeService.mergePeople` / `PlaceMergeService.mergePlaces`, `change_reason`
`person_merge.rescued_edge` / `place_merge.rescued_edge`, `changed_fields` naming the source it came
from) and counted in `relationshipsRescued`; an edge it drops leaves no trail, as before. The id is kept so a delta for a relationship that no longer exists in
`ci.relationships` stays an exact signal of a hard delete.

What this does **not** close: a projection whose own snapshot predates the merge's commit and that
commits after the sweep leaves its edge on the tombstone — a window the length of the sweep plus the
rest of the transaction. On the reference appliance no edge sits on any of 3,079 merged-away people
(checked 2026-09-30), against the five the straddle lost; no such check has been made for places.
Closing it entirely would take a lock the projection also takes. `PlaceMergeService` ended in the
same plain `DELETE` and had the same race for `Event → Place`, `Person → Place` and `Place → Place`
edges; it now ends in the same sweep. Proven against Postgres in
`pipeline/stages/__tests__/PersonMergeRacesEdgeProjection.integration.spec.ts` and
`pipeline/stages/__tests__/PlaceMergeRacesEdgeProjection.integration.spec.ts`, which interleave the
real merge with the real projection stages on two connections.

### 5.3 Referrer registry and the sweep

**A registry that cannot silently rot.** `20260127185821_remove_relationship_foreign_keys_to_entities.sql`
deliberately dropped the FKs, so ~20 columns across ~15 tables hold entity references (including
three `UUID[]` columns) and nothing in the catalog declares them. `PersonMergeService` re-points
the handful it knows about; the rest are unenumerated. Add an explicit registry:

```ts
export const ENTITY_REFERRERS = [
  { table: 'ci.communications', column: 'from_entity_id', kind: 'scalar', timeColumn: 'time' },
  { table: 'ci.communications', column: 'to_entity_ids',  kind: 'array',  timeColumn: 'time' },
  { table: 'ci.events',         column: 'location_entity_id',    kind: 'scalar' },
  { table: 'ci.events',         column: 'organizer_entity_id',   kind: 'scalar' },
  { table: 'ci.events',         column: 'participant_entity_ids', kind: 'array' },
  { table: 'ci.activities',     column: 'participant_entity_ids', kind: 'array' },
  { table: 'ci_search.embeddings', column: 'entity_id', kind: 'scalar', onCollision: 'delete_loser' },
  { table: 'ci_search.entity_tag', column: 'entity_id', kind: 'scalar', onCollision: 'delete_loser' },
  // Re-pointed by PersonMergeService since 2026-09-29 (§1.3). Never collides: its unique key
  // is the observation, and entity_id is not part of it.
  { table: 'ci.identifier_claims', column: 'entity_id', kind: 'scalar' },
  // … position, documents, files, devices, sensors, agents, goals, document_chunks
] as const;
```

Guard it with a test that reads `information_schema.columns` for anything matching `%entity_id` /
`%entity_ids` and asserts every hit is either registered or explicitly exempted. A new table that
adds an entity reference then fails CI instead of failing silently years later. **This is the
cheapest item in this document and it has no dependencies.**

The list above is a starting point, not a survey — it must be derived, which is the whole point.
An earlier draft of it carried `ci.objects.object_entity_id`, which
`20260811061402_convert_inventory_to_cti.sql` had already dropped as "a dead precursor of this link
(no writer anywhere, all NULL)". A hand-maintained registry rots in both directions.

`ci.identifier_claims.entity_id` is the latest case: an unregistered referrer for seven weeks, and a
stranded claim fails silently, because the detector simply stops seeing it (§1.3). The guard's
pattern needs widening too. `%entity_id` / `%entity_ids` misses the ordered pairs
`ci.merge_candidates.entity_id_a/_b` and `ci.entity_merge_blocks.entity_id_a/_b`. Since 2026-09-29
`PersonMergeService` carries a source's blocks to the target; otherwise the survivor's
re-examination would re-propose, as (target, X), a (source, X) pair a human rejected. It leaves the
source's pending candidates moot, for that re-examination to re-derive against the survivor.

**The sweep**, driven off the ledger, resumable, idempotent (re-running finds zero rows):

- **Scalar:** `UPDATE t SET col = $target WHERE col = $source`.
- **Array:** `array_replace` then de-dup — the target may already be present in the array:
  ```sql
  UPDATE ci.events
     SET participant_entity_ids = (
           SELECT ARRAY(SELECT DISTINCT unnest(array_replace(participant_entity_ids, $source, $target)))
         )
   WHERE participant_entity_ids @> ARRAY[$source]::uuid[];
  ```
- **Unique-constrained** (`ci_search.embeddings` is `UNIQUE (entity_type, entity_id)`;
  `entity_tag` is `UNIQUE (entity_type, entity_id, tag_id)`): a plain UPDATE throws on collision.
  Delete the loser's row, keep the survivor's, then enqueue re-embed.
- **Hypertable** (`ci.position`, the one referrer still a compressed hypertable;
  `ci.communications` stopped being one in `20260807072321_dehypertable_communications`): window by
  `time` in `DEFAULT_WINDOW_DAYS` slices, the way `CommunicationLinkBackfillService` windowed
  communications, so Postgres can exclude chunks. Never an unbounded scan — that is the all-chunk
  Append that segfaulted TSDB 2.28. A counting CTE (`WITH x AS (UPDATE … RETURNING 1) SELECT
  count(*) …`) is safe here: it decompresses and counts rows in compressed and partially compressed
  chunks exactly as a bare UPDATE does, and honours the decompression cap
  (`PlaceMergeService.integration.spec.ts`; checked on TimescaleDB 2.30.1).

Splitting the sweep out of the merge transaction is only safe once reads resolve through a
canonical primitive (P2): a half-swept merge is then *correct*, just not yet compact.

### 5.4 Unmerge

The ledger was built for this — `details` already carries `counts` and `sourceProperties` — but two
things are missing before a replay is exact:

- `ci.entity_merges` records the **source's** pre-merge properties, not the **target** fields the
  merge overwrote. Target-wins-scalars means some of those were clobbered. Either widen `details`
  to a full before-snapshot of both rows, or accept that unmerge restores the source exactly and
  the target approximately — and say which in the API.
- There is no `reverted_at` / `reverted_reason` column, so a reverted merge is indistinguishable
  from a live one. Add them, or unmerge cannot be idempotent.

**Do not trust `details.counts` on rows written before the `countAffected` fix** (2026-09-29,
§1.1). Those rows hold the constants TypeORM's `[rows, rowCount]` pair produced — for a Person
merge every count 2 and `relationshipsDropped` 6 — and no field marks a row as pre- or post-fix. A
replay must not size or verify anything from them. If it needs to tell the two apart, stamp a
marker on new rows first; the constant signature is only a heuristic. Even an exact count says how
many rows moved, not which ones, so the reverse sweep has to find its referrers either way.

The replay itself:

1. Assert the source has not since absorbed others (revert those first — LIFO).
2. Restore survivor fields from the snapshot.
3. Move identifier rows (and, once §2.2 lands, provenance rows) back to the source.
4. Reactivate folded relationships; drop edges created by the fold.
5. Clear `merged_into_entity_id`; un-compress any tombstones that were pointed past the source.
6. Set `reverted_at`; write a `ci.entity_merge_blocks` row with `reason = 'unmerged'`; enqueue the
   referrer sweep in reverse.

Step 6's block row is not optional. Reverting a merge with nothing to record the reversal leaves
the pair looking like a duplicate again, and the next sweep re-proposes it. The block table's
`reason` enum already reserves `'unmerged'` for exactly this.

Referrer rows already re-pointed are found by the reverse sweep — which is only possible because
the loser row was never deleted (**P3**).

### 5.5 Candidate generation for the remaining types

Never compare all pairs. Candidates come only from a blocking key:

| Type | Blocking key |
|------|-------------|
| Person | normalized email / phone / name — `ci.identifier_claims` *is* the block; plus LinkedIn profile URL read from `properties` (`URL`/`URLs`/Notes `URL:` lines), which is not a claim kind |
| Location | PostGIS `ST_DWithin` on a geohash-bucketed grid |
| Object/Item | *Shipped* (§3.2): identifier rung over `ci.objects.identifier_codes` ∪ `ci.object_identifiers`, then product name, then brand+model |
| Concept | `properties.type` + kNN over `ci_search.embeddings` (top-k, not all-pairs) |

For Person this is already the shape `DuplicateDetectStage` implements; extending it means widening
`DUPLICATE_DETECT_SOURCE` and bumping `DUPLICATE_CANDIDATE_GENERATION`, which rescores without
resurrecting rejected pairs.

### 5.6 Concurrency and transitivity

- **Chains.** A→B then B→C: `PersonMergeService` path-compresses A directly to C in the same
  transaction, so resolution stays one hop and the ledger keeps the real chain.
- **Cycles.** Rejected structurally: a merge whose target is itself a tombstone fails the
  canonical assertion at the top of the transaction.
- **Races.** Two agents merging into the same target both take row locks in `entity_id` order. The
  second sees `merged_into_entity_id IS NOT NULL` and retries against the new canonical.
- **Merge vs. concurrent ingest.** An ingest that resolves a key to the source microseconds before
  the merge commits writes to a now-tombstoned entity. Today that write is simply dropped on the
  next pass (§2.1a). Once resolution goes through `ci.entity_provenance` — which the merge
  re-points transactionally — the window is one statement wide and self-healing.

---

## 6. Proposed order

| # | Work | Why here |
|---|------|----------|
| 1 | Referrer registry + `information_schema` guard test (§5.3) | No behaviour change, no dependencies, and it stops the next silent rot |
| 2 | `ci.entity_provenance` + dual-write, resolution moved onto it (§2.2) | Converges Person/Object/Content identity; turns §2.1(a)'s dropped update into an applied one |
| 3 | Unmerge from the `ci.entity_merges` ledger (§5.4) | Needs the `details`/`reverted_at` widening first; blocks already exist |
| 4 | Canonical view + function (P2) | HBPE reads SQL directly; also the precondition for an async sweep |
| 5 | Place: dedupe key for `createMany`, then duplicate detection and merge with the containment guard (§3.1) | The untouched type |
| 6 | ~~Thing: `ObjectMergeService` / `ObjectDuplicateService` at the model and unit levels (§3.2)~~ | **Done — #2176, 2026-08-19.** Its leftover is the reject-pair mutation (§3.4) |

Items 1 and 3 are independently shippable and neither changes a matching rule. 2 is the structural
one. 5 extends to the remaining types once the primitives are settled.

Completed since this ordering was first written: tombstone-aware resolve (§2.1a),
`ci.entity_merge_blocks` wired into duplicate detection (§3.4), and item 6 (§3.2).

---

## 7. Explicitly out of scope

- **Event merging.** Events dedupe on their provenance triple. Recurring instances are distinct
  occurrences and HBPE's token stream depends on that.
- **Cross-user merging.** Every key is `owner_user_id`-scoped and stays that way.
- **Merging across `entity_type`.** A Person and a Concept named "Pilates" are not the same thing.
- **Probabilistic record linkage at scale** (Fellegi–Sunter, learned blocking). The blocking keys
  in §5.5 are sufficient for single-user corpora; revisit only if candidate volume demands it.

---

## 8. Notes for whoever picks this up

- Migrations: `yarn workspace @ci/be-api migrate:make <name>`. Never hand-write the timestamp —
  `bin/check-migration-versions.js` gates it and parallel branches have collided on round numbers.
- `PersonMergeService`'s relationship re-point is the subtlest code in the area. Read the two
  guards in `repointReferences` before touching it; both exist because a set-based UPDATE can
  otherwise collide with `relationships_unique_directed_idx` mid-statement.
- The merge specs are mocked, not DB-backed (`PersonMergeService.spec.ts` fakes the query
  executor). A DB-backed repro fits the same style using `__testHelpers__/fakeGraphRepositories`.
- `ci.entity_identifiers` is the people index; `ci.object_identifiers` is the things index. Keeping
  them separate was deliberate — do not widen either CHECK to cover the other.
- `DuplicateDetectStage`'s two version constants (`DUPLICATE_SCORING_GENERATION`,
  `DUPLICATE_CANDIDATE_GENERATION`) must be bumped in the same commit as `versions.ts`, or the
  module throws at load. The stage id is permanent: renaming it abandons every ledger row and
  re-proposes every pair the user has already dismissed.
- `GraphIngestService.ts` cites **§2.1(b)** of this file by section number. Renumbering it silently
  breaks that reference.
