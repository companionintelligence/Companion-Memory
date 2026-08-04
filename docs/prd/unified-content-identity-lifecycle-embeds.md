# Unified Content Identity, Lifecycle, and Embed Enrichment

**Status:** proposal · **Repo:** CI-Server (+ CI-Import-Tools) · **Author:** lead architect
**Supersedes:** three independent track designs. They are not independent, and treating them as such produced three incompatible object models.

> **Provenance.** Produced by a 14-agent survey-and-critique pass (7 surveyors → 3 design tracks
> → 3 adversarial critics → synthesis) over CI-Server, CI-Import-Tools, and the archived
> [LifeScope](https://github.com/lifescopelabs) repos (`lifescope-app`, `lifescope-api`,
> `lifescope-etl`, `lifescope-embed`, `lifescope-objects`). Every file:line citation below was
> verified against the tree at the time of writing; §9 lists what could not be verified.
>
> LifeScope is the reference implementation for the embed half: `lifescope-embed` is an
> iframely-derived oEmbed/OpenGraph gateway with 138 domain plugins and a whitelist trust
> model, and LifeScope's `content` model carried `embed_content` / `embed_format` /
> `embed_thumbnail` as first-class columns. CI-Server's seed data still writes those three
> keys into the untyped `ci.content.source_data` JSONB, where nothing reads them — the
> capability was lost in the port, not deferred.

---

## 1. What's actually broken today

Six defects, all verified against the current tree. Everything below exists to fix these.

**1.1 — `ci.events` idempotency returns a phantom row.** `events_source_triple_uniq` is `(source_type, source_system, source_id) WHERE source_id IS NOT NULL` — no `user_id` (`20260620213807_add_events_source_idempotency.sql:8`). But `EventService.createManyBatched` passes `scope: { userId }` for both the existence pre-check and the hydration SELECT (`EventService.ts:212-227`, whose own comment flags the mismatch). On a multi-user appliance, user B ingesting a triple owned by user A: the global arbiter skips the INSERT → the user-scoped hydration finds nothing → `bulkUpsert.ts:454` returns `hydratedByKey.get(key) ?? entity`, i.e. **an unsaved in-memory entity with an id that is in no row**. Every other triple index in the schema is user- or owner-scoped.

**1.2 — Triple-less `/v1` records bypass both dedupe layers.** `hasFullTriple` (`BulkIngestController.ts:56`) requires all three legs; failures go to `direct` (`:272-276`), skipping the capture log entirely, and then fail `isDedupable` (`bulkUpsert.ts:235`) too. `source_type`/`source_system`/`source_id` are `.optional()` for communications, contents, inventory, browser_activity and positions (`ingest/types.ts:106-108, 138-140`). Every re-send duplicates.

**1.3 — Re-import can never repair a row.** `INGEST_REFRESH_COLUMNS` is `event: []`, `item: []`, `content: []`, `browser_activity: []` — only `communication` is populated (`ingestRefreshColumns.ts:36-40`). A bad title is frozen at first write.

**1.4 — Zero URL identity.** No index on `ci.content.url` or `source_url` in any migration. The only `canonicalize` in the repo is `GeocodeService.ts:122` (free-text addresses). `youtu.be/X`, `youtube.com/watch?v=X&utm_source=…`, and `music.youtube.com/watch?v=X` are three unrelated rows.

**1.5 — YouTube rows render as permanently broken media.** `TransformYouTubeLikes.ts:170-171` writes `url` = the watch page and `mimetype: 'video/youtube'` → `mediaKind()` returns `'video'` (`GalleryView/media.ts:34-36`) → `resolveMediaUrl` passes absolute URLs through unchanged → `MediaTile` renders `<img src={watch page}>` (always broken) and `MediaLightbox.tsx:218-224` renders `<video src={watch page}>` (never plays). The API already returns `snippet.thumbnails` and `contentDetails.duration`; both are parsed into the local interface and discarded. Three `console.log` calls dump full provider payloads to stdout (`:136, :138, :160-163`).

**1.6 — No verb anywhere.** `ci.events.event_type` is nullable free text with no CHECK, populated by three incompatible vocabularies: `'capture.photo'` (v1 lane, `BulkIngestController.ts:214`), `'photo'` (graphql lane), `'calendar_event'` (ETL). `grep -rniE "'(view|watch|listen|consume|share|read)ed?'" backend/apps/api/src` → 0 hits. `HowFilter.tsx` renders all three spellings verbatim, side by side.

**Two prior attempts at this class of table shipped write-only.** `ci.item_relationships` (`20260707000001`) has one mutation and zero resolvers. `ci.capture_events` has a first-class `kind` column plus `capture_events_kind_idx` and `grep 'FROM ci.capture_events'` returns only the compensating DELETE. **Every phase below has a read-path acceptance test as a gate.**

---

## 2. Dependency order (this is the whole point)

```
Track 3: identity      →  ci.content_objects is THE object table.
   ↓                      Track 2 acts point at object_id.
Track 2: lifecycle     →  Track 1 embeds enrich object_id.
   ↓
Track 1: embeds
```

The three original designs each invented their own object identity. Track 2 proposed `ci.content_objects.object_key` with a "v0 passthrough" until Track 3 landed; Track 3 proposed `ci.object_identifiers` pointing at seven existing tables; Track 1 proposed `ci.embed_cache` keyed by URL hash. **Resolution: `ci.content_objects` is the single object table, and `ci.object_identifiers` is its identity index.** Embeds attach to `object_id`, not to a URL hash. Acts attach to `object_id`. There is one object concept.

This kills three critique blockers at once: Track 3's "identifiers point at a hypertable with no uuid PK" (positions and communications are no longer identity-bearing objects — they are *sources* that project into objects), Track 2's "sha256 over-merge is unrecoverable" (identity precedence is now explicit and single-sourced), and Track 1's "canonical_version churn breaks the FK" (embed rows reference `object_id`, which never changes).

---

## 3. Corrections applied from critique

| Critique | Verdict | Resolution |
|---|---|---|
| Corpus is 194k content rows, not 1M | **Correct** — `20260714082548:12-15` states "ci.content (194k rows / ~144MB)". | All sizing re-derived. Plain `CREATE INDEX` on a 144MB table is sub-second; no maintenance window needed. Poster ceiling ~8GB not 40GB. |
| Backfill listener caps at 500 and never requeues | **Correct** — `MediaDimensionsBackfillListener.ts:84,126-133` has no follow-on send; `IngestLifecycleController.ts:60-62` passes no limit. | All backfill listeners self-requeue with a keyset cursor. Acceptance test asserts it. |
| `bulkInsertIdempotent` takes ONE conflictTarget | **Correct** — `bulkUpsert.ts:39-46`. | Two-arbiter scheme abandoned. One arbiter per call; triple-less acts get a *synthetic deterministic* triple, not a second index. |
| Session coalescing breaks backfill idempotency | **Correct** — a merged row leaves no `source_id`, so every re-run re-merges. | Write path is strictly 1 origin row = 1 act. Coalescing is **read-side only**. |
| `canonical_version` incoherent with url_hash PK | **Correct.** | Deleted. Embeds key on `object_id`; re-canonicalization is a Track-3 merge, not an embed concern. |
| Twitch `parent=` can't be server-cached; `maxresdefault` 404s | **Correct.** | Store `provider` + `provider_ref` + aspect; construct src client-side. Poster is `hqdefault.jpg`. Twitch dropped from v1. |
| CSP `frame-src` per-user is unachievable for a static SPA | **Correct** — only two ad-hoc CSP headers exist (`OidcController.ts:538`, `ConnectController.ts:238`). | CSP demoted to static defense-in-depth. React non-render is the gate. |
| `sandbox="allow-scripts allow-same-origin"` on cross-origin iframe is a no-op that breaks players | **Correct.** | Dropped for player iframes; retained (without `allow-same-origin`) for the `srcdoc` path only. |
| `user_edited_fields` doesn't exist | **Correct** — 0 grep hits. | Refresh lists restricted to columns with **no** server-side edit path; disjointness enforced by test. |
| `≥2 non-temporal dims` law tests the literal string `'timestamp'` | **Correct** — `day`, `start_iso`, `visit_time_ms` all slip through. | Temporality is declared per-dimension, not inferred from name. |
| Netflix regresses to `rnd` → unbounded duplication | **Correct.** | `rnd` deleted from the ladder. Universal fallback is `nat` over `{archive_relpath, record_ordinal}` — deterministic, ≥2 non-temporal dims by construction. |
| `value_normalized TEXT` in a btree PK exceeds 2704 bytes for URLs | **Correct.** | `value_normalized` is always a fixed-width digest; human-readable form goes in unindexed `raw_value`. |
| Two-index overlap window turns phantom-id into 23505 | **Correct** — Postgres does not absorb conflicts on non-arbiter indexes. | Old index dropped in the *same* deploy as the arbiter flip. |
| `IndexDeferralService` has no "excluded set" to register in | **Correct** — `:41` is an opt-in list; exclusions are prose. | No edit; just don't list the new indexes. |
| Phase C dedupe as a `DO $$` migration can't COMMIT | **Correct** — `2D000` inside dbmate's transaction. | Dedupe is a maintenance leg with real per-batch commits, not a migration. |
| `act_verb_map` conflates four source columns | **Correct** — six seeded values are `ci.content.type`, not `event_type`. | PK is `(source_column, source_kind)`; one hint view per column. |
| ETL `create()` has no ON CONFLICT, so a triple alone yields 23505 | **Correct** — `ContentService.ts:70-86` is plain save. | YouTube transforms routed through `createMany`. |
| Absence inference / `ci.sync_runs` | **Correct that no connector declares completeness.** | **Cut from v1 entirely.** Only source-reported deletes ship. |
| pHash / perceptual dedupe | Defensible but unfunded. | **Cut from v1.** |
| SSRF DNS-rebinding, missing `100.64/10` | **Correct** — the appliance is routinely reached over Tailscale CGNAT. | Pinned-address `undici` Agent + manual redirect loop. |

Two critique points I judge **wrong**: (a) "CHECK constraints contradict repo precedent" — `geocode_cache` omits them, but `ci.events.status`, `ci.relationships.relationship_type` and `ci.activity_rollup.count` all use CHECKs; the constraint is cheap on a 194k-row table and I keep it. (b) "`Follow` has no representable object" — a YouTube channel is a legitimate `Collection`-kind object (a container of videos); no `Actor` kind needed.

---

## 4. Track 3 — Object identity (foundation)

### 4.1 The identity ladder

`backend/packages/object-identity/` — new yarn workspace (add `"backend/packages/*"` to root `workspaces`). Zero runtime deps, dual ESM/CJS so CI-Import-Tools consumes it too.

```ts
// backend/packages/object-identity/src/types.ts
export const IDENTITY_SPEC_VERSION = 1;

/** Precedence, highest first. No `rnd` rung — see §4.4. */
export type IdentityKind = 'src' | 'url' | 'sha256' | 'txt' | 'nat';

export interface Identity {
  kind: IdentityKind;
  /** ALWAYS fixed-width: sha256 hex, or a length-capped provider ref. */
  valueNormalized: string;
  /** Human-readable pre-digest form. Never indexed. */
  raw?: string;
  confidence: number;
  specVersion: number;
}

export interface Dimension {
  name: string;
  value: string | number | null | undefined;
  /** Declared, NOT inferred from the name. Fixes the `day`/`start_iso` hole. */
  temporal: boolean;
}

export function resolveIdentities(input: IdentityInput): Identity[];
export function primaryIdentity(input: IdentityInput): Identity; // never null
```

**Precedence and exclusivity.** All five rungs are exclusive (may be an `ON CONFLICT` arbiter). Precedence for *survivor selection* on merge: `src` > `url` > `sha256` > `txt` > `nat`. A single object accretes every applicable rung.

**`sha256` is demoted below `url`** (fixing the over-merge blocker): a zero-byte attachment or a shared stock JPEG must not fuse two objects. `sha256` is only minted when no `src` and no `url` exist, and its value is `sha256:<hash>#<owning_row_id>` in v1 — bytes-identity across rows is a *merge candidate*, never an automatic collapse.

### 4.2 URL canonicalization — full algorithm

Provider-aware allowlist first, generic strip second. This is the fix for the `youtu.be/X?t=30` vs `watch?v=X&t=30` divergence: for a recognized provider the canonical form is **reconstructed from the extracted id alone**, discarding all query.

```
FUNCTION canonicalizeUrl(raw) -> { canonical, host, provider?, providerRef? } | null

  1. u := trim(raw); if parse(u) fails, retry once with "https://" prefix;
     if still fails -> return null
  2. if u.scheme not in {http, https} -> return null
     u.scheme := "https"                          # http and https are ONE identity
  3. host := lowercase(punycode(u.host)), strip trailing "."
     strip leading "www."                          # universally safe
     if host in MOBILE_MIRROR_MAP -> host := MOBILE_MIRROR_MAP[host]
        # explicit map only: m.youtube.com->youtube.com, m.facebook.com->facebook.com,
        # mobile.twitter.com->x.com, en.m.wikipedia.org->en.wikipedia.org, ...
        # NEVER a blanket leading-label strip (would break m.media-amazon.com)
  4. drop port if default for scheme
  5. drop fragment, EXCEPT a leading "#!" hashbang (path-bearing legacy SPA route)

  6. p := PROVIDER_RULES.firstMatch(host, u.path, u.query)
     IF p matched:
        RETURN { canonical: p.rebuild(p.ref),    # rebuilt from id ONLY; query discarded
                 host, provider: p.name, providerRef: p.ref }

  # --- generic path, unrecognized hosts only ---
  7. drop query params matching /^utm_/i, and the exact set:
     fbclid gclid gbraid wbraid dclid msclkid twclid ttclid yclid igshid igsh
     mc_cid mc_eid _ga _gl mkt_tok vero_id vero_conv oly_anon_id oly_enc_id
     hsCtaTracking __hstc __hssc __hsfp s_kwcid ef_id sc_cid ncid mibextid
  8. drop host-scoped params via HOST_SCOPED_TRACKING[host]
     (ref/ref_src on x.com+reddit.com; source/trk on linkedin.com;
      spm/scm on aliexpress.com — NEVER globally: `ref` is identity elsewhere)
  9. drop params with empty value whose name is in DROP_IF_EMPTY
     sort remaining by (name, value) bytes; uppercase percent-escape hex
 10. path: collapse "//", resolve "." / "..", decode unreserved escapes,
     uppercase remaining hex, drop exactly one trailing "/" unless path == "/"

  IF host in SHORTENERS (bit.ly, t.co, tinyurl.com, lnkd.in, amzn.to, ...):
     RETURN null   # emit no `url` identity. NO network fetch, ever.
                   # Contract: no resolver may be built until an egress
                   # allowlist + RFC1918/link-local/100.64.0.0/10 deny list ships.

  RETURN { canonical: rebuild(scheme, host, path, sortedQuery), host }
```

**Worked examples** (all pinned in `fixtures/identity-fixtures.json`, executed by *both* repos' test runners):

| Input | Canonical | Provider ref |
|---|---|---|
| `https://youtu.be/dQw4w9WgXcQ?t=30` | `https://youtube.com/watch?v=dQw4w9WgXcQ` | `youtube:video:dQw4w9WgXcQ` |
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&index=3&pp=abc` | `https://youtube.com/watch?v=dQw4w9WgXcQ` | `youtube:video:dQw4w9WgXcQ` |
| `https://m.youtube.com/shorts/dQw4w9WgXcQ` | `https://youtube.com/watch?v=dQw4w9WgXcQ` | `youtube:video:dQw4w9WgXcQ` |
| `https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xY` | `https://youtube.com/watch?v=dQw4w9WgXcQ` | `youtube:video:dQw4w9WgXcQ` |
| `https://open.spotify.com/intl-de/track/6rqhFgbbKwnb9?si=abc` | `https://open.spotify.com/track/6rqhFgbbKwnb9` | `spotify:track:6rqhFgbbKwnb9` |
| `spotify:track:6rqhFgbbKwnb9` | `https://open.spotify.com/track/6rqhFgbbKwnb9` | `spotify:track:6rqhFgbbKwnb9` |
| `https://twitter.com/jack/status/20?ref_src=twsrc` | `https://x.com/i/status/20` | `x:tweet:20` |
| `https://x.com/anyone/status/20` | `https://x.com/i/status/20` | `x:tweet:20` |
| `https://vimeo.com/76979871?share=copy` | `https://vimeo.com/76979871` | `vimeo:video:76979871` |
| `https://m.media-amazon.com/images/I/71x.jpg` | `https://m.media-amazon.com/images/I/71x.jpg` | *(none — no blanket `m.` strip)* |
| `https://blog.acme.com/p?ref=hn&utm_source=x` | `https://blog.acme.com/p?ref=hn` | *(none — `ref` kept off-allowlist host)* |
| `https://bit.ly/3abc` | `null` | *(no `url` identity; `nat` rung instead)* |

### 4.3 Schema

```sql
-- Create with: yarn workspace @ci/be-api migrate:make create_content_objects
-- NEVER hand-write the timestamp prefix (bin/check-migration-versions.js gates it).

-- migrate:up
CREATE TABLE IF NOT EXISTS ci.content_objects (
    object_id     uuid        PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id       uuid        NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    kind          text        NOT NULL DEFAULT 'Other'
                  CHECK (kind IN ('Document','Image','Video','Audio','Page',
                                  'Note','Article','Collection','Other')),
    title         text,
    url           text,               -- canonical form, human-readable
    mimetype      text,
    duration_ms   bigint      CHECK (duration_ms >= 0),
    provider      text,               -- 'youtube' | 'spotify' | ... (extractor name)
    provider_ref  text,               -- 'youtube:video:<id>'
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    -- AS2 Tombstone: the object outlives its deletion so the timeline can still
    -- say "you watched this; it is gone now". Never hard-delete.
    deleted_at    timestamptz,
    former_kind   text,
    -- Non-exclusive projection pointers back to the payload-bearing tables.
    content_id    uuid REFERENCES ci.content(id) ON DELETE SET NULL,
    file_id       uuid REFERENCES ci.files(id)   ON DELETE SET NULL,
    metadata      jsonb       NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Composite target so acts can FK on (user_id, object_id) and cross-user
-- mis-scoping becomes unrepresentable rather than merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS content_objects_user_object_uniq
    ON ci.content_objects (user_id, object_id);
CREATE INDEX IF NOT EXISTS content_objects_provider_ref_idx
    ON ci.content_objects (user_id, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_objects_live_idx
    ON ci.content_objects (user_id, last_seen_at DESC) WHERE deleted_at IS NULL;

-- THE identity index. value_normalized is ALWAYS a fixed-width digest
-- (sha256 hex or a <=200-char provider ref) so btree tuples stay well under
-- the ~2704-byte limit even for pathological URLs.
CREATE TABLE IF NOT EXISTS ci.object_identifiers (
    user_id          uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    object_id        uuid NOT NULL,
    kind             text NOT NULL CHECK (kind IN ('src','url','sha256','txt','nat')),
    value_normalized text NOT NULL CHECK (length(value_normalized) <= 200),
    raw_value        text,            -- unindexed, human-readable
    source           text,            -- 'import:netflix' | 'etl:google' | 'user'
    confidence       real NOT NULL DEFAULT 1.0
                     CHECK (confidence > 0 AND confidence <= 1),
    spec_version     integer NOT NULL,
    verified_at      timestamptz,     -- non-NULL = user-confirmed
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, object_id, kind, value_normalized),
    FOREIGN KEY (user_id, object_id)
        REFERENCES ci.content_objects (user_id, object_id) ON DELETE CASCADE
);

-- Resolution key. On a live DB build this CONCURRENTLY first (see runbook in
-- the header of the follow-up migration); IF NOT EXISTS makes this a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS object_identifiers_claim_uniq
    ON ci.object_identifiers (user_id, kind, value_normalized);

-- Losing claims are RECORDED, not dropped. This is the direct fix for
-- ci.entity_identifiers' .orIgnore() (EntityIdentifierService.ts:143), which
-- forced PersonDuplicateService to re-derive normalization in SQL (:66-81).
CREATE TABLE IF NOT EXISTS ci.object_merge_candidates (
    candidate_id     uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id          uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    left_object_id   uuid NOT NULL,
    right_object_id  uuid NOT NULL,
    kind             text NOT NULL,
    value_normalized text NOT NULL,
    confidence       real NOT NULL,
    resolved_at      timestamptz,
    resolution       text CHECK (resolution IN ('merged','rejected')),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS object_merge_candidates_pair_uniq
    ON ci.object_merge_candidates
       (user_id, left_object_id, right_object_id, kind, value_normalized);

-- migrate:down
DROP TABLE IF EXISTS ci.object_merge_candidates;
DROP TABLE IF EXISTS ci.object_identifiers;
DROP TABLE IF EXISTS ci.content_objects;
```

**Positions and communications are deliberately absent** from the object model. They are *sources* that may project into objects (a URL in a message body → an object), not objects themselves. This dissolves the "no uuid PK on a hypertable" blocker without a polymorphic `object_time` column.

### 4.4 CI-Import-Tools: killing `hashItem`

`hashItem` (`persistence.ts:150-164`) hashes `dataSource + classification + filename + timestampISO + coords`. For Netflix's quick export that reduces to `('netflix','watch','watch.txt', UTC-midnight, '')` — one constant non-temporal dimension, so an entire day's viewing collapses to one row, dropped silently by `INSERT OR IGNORE` (`:227-229`).

Replacement, in `backend/packages/object-identity/src/naturalKey.ts`:

```ts
export function buildNaturalKey(input: {
  specVersion: number; scope: string; kind: string;
  dims: Dimension[];
  /** Deterministic fallback, always available for archive-derived records. */
  fallback: { archiveRelpath: string; recordOrdinal: number };
  seen: Map<string, number>;
}): string {
  const present = input.dims.filter(
    d => !d.temporal && d.value != null && String(d.value).trim() !== ''
  );
  const dims = present.length >= 2
    ? present
    : [ { name: 'archive', value: input.fallback.archiveRelpath, temporal: false },
        { name: 'ordinal', value: input.fallback.recordOrdinal,  temporal: false } ];
  const payload = [`${input.specVersion}`, input.scope, input.kind,
    ...dims.slice().sort((a,b) => a.name < b.name ? -1 : 1)
           .map(d => `${d.name}=${String(d.value)}`)].join('\0');
  const base = `nat:v${input.specVersion}:${sha256(payload)}`;
  const n = input.seen.get(base) ?? 0;      // facebook.ts:172-189 pattern
  input.seen.set(base, n + 1);
  return n === 0 ? base : `${base}#${n}`;
}
```

The `#n` occurrence counter preserves genuine repeats in stable file order. `archiveRelpath + recordOrdinal` is deterministic across re-imports of the same archive — so Netflix goes from 1 item/day to 1 item/row, idempotently.

**Legacy bridge (the highest-consequence detail).** `items.id` *is* the server's `source_id` (`mapping.ts:127-129`). Re-keying changes it, so without a bridge the whole corpus re-pushes as new. During the transition the importer emits **both** the new key and `src:ci-import-tools:<data_source>:<legacy_content_hash>`; `ObjectIdentityService.resolve()` matches either. `legacy_content_hash` is backfilled locally first. **Hard gate: no P3 importer may run against a pre-P2 server** — enforced by an `X-CI-Identity-Spec` minimum-server check, not just the newer/older 409 rule.

Weak sources fixed, each given ≥2 declared-non-temporal dims (all verified id-less with constant filenames): `netflix.ts:173`, `last_fm.ts:145`, `apple_music.ts:156`, `tiktok.ts:107/127/147/166/185`, `sms_backup_restore.ts:169/206`, `googlevoice.ts:109`, `oura.ts:189`, `fitbit.ts:149`, `garmin.ts:161`, `mastodon.ts:151`, `gpx.ts`, `kmlgx.ts`, plus the conditional-id else-branches in `reddit.ts:249`, `strava.ts:114`, `youtube.ts`.

### 4.5 Conflict-target hardening

| Type | Arbiter (verbatim) | Action |
|---|---|---|
| event | `(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL` **(changed)** | `DO UPDATE` title, description, event_type, category, start_time, end_time, location_name |
| content | `(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL` | `DO UPDATE` text, url, mimetype, source_url |
| item | `(owner_user_id, …)` | `DO UPDATE` description, category |
| browser_activity | `(user_id, …)` | `DO UPDATE` duration_seconds, scroll_depth_percent |
| communication | companion table, unchanged | `DO NOTHING` |
| object_identifier | `(user_id, kind, value_normalized)` | `DO NOTHING` |

**Refresh lists exclude every column with a server-side edit path.** `title` is refreshed for events but **not** content (`ContentResolver` exposes `updateContent(title)`), and a test enumerates each entity's GraphQL update-input fields and asserts disjointness with its refresh set. This replaces the non-existent `user_edited_fields`.

**Triple-less `/v1` records** get a synthetic triple derived from `primaryIdentity()`: `source_type='identity'`, `source_system=<kind>`, `source_id=<value_normalized>`. Because there is no `rnd` rung, this value is deterministic per input, so capture-log idempotency (`capture_events_capture_key_uniq`) holds on replay.

Also: `events_source_triple_uniq` is dropped **in the same deploy** as the arbiter flip (metadata-only op; keeping it would raise `23505` on a non-arbiter index and kill a 1000-row chunk).

---

## 5. Track 2 — Lifecycle acts

### 5.1 Verb enum: ActivityStreams 2.0 + one extension

AS2 wins on closability (28 finite core types vs schema.org's open ~200-class tree), shape (actor/verb/object/target/audience is exactly what SHARE needs), and `Tombstone`/`Undo`. It lacks a video verb, so exactly one extension is taken from schema.org `WatchAction`.

```ts
// backend/apps/api/src/domains/content-acts/vocabulary.ts
export const ACT_VERBS = [
  'Create','Update','Delete','Undo',      // authoring
  'View','Read','Listen','Watch',          // consumption (Watch = the one extension)
  'Announce','Add','Remove',               // distribution (AS2 says Announce, not Share)
  'Like','Dislike','Follow',               // reaction / subscription
] as const;
export const ACT_VOCAB_VERSION = 1;
export const actVerbSchema = z.enum(ACT_VERBS);
```

Widening to another AS2 core type (`Accept`, `Join`, `Move`, `Travel`, …) is pre-approved: a migration widening the CHECK. Anything outside AS2 needs a `ci:` prefix, a cited schema.org derivation, and an `ACT_VOCAB_VERSION` bump.

### 5.2 Mapping from today's vocabularies

`ci.act_verb_map` is keyed on **`(source_column, source_kind)`** — the four vocabularies live in four different columns and must not share a namespace.

| source_column | source_kind | verb | object kind | conf |
|---|---|---|---|---|
| `content.type` | `youtube_video_like` | Like | Video | 1.0 |
| `content.type` | `youtube_playlist` | Add | Collection | 1.0 |
| `content.type` | `youtube_subscription` | Follow | Collection | 1.0 |
| `content.type` | `youtube_activity_upload` | Create | Video | 1.0 |
| `content.type` | `google_drive_document` / `onedrive_document` | Create | Document | **0.6** |
| `content.type` | `favorite` (Spotify) | Like | Audio | 1.0 |
| `events.event_type` | `played_music` | Listen | Audio | 1.0 |
| `events.event_type` | `github_branch_deletion` / `github_tag_deletion` | Delete | — | 1.0 |
| `events.event_type` | `github_comment` / `github_repository_creation` / `github_repo_fork` | Create | Note/Other | 1.0 |
| `events.event_type` | `capture.photo`, `photo` | Create | Image | 1.0 |
| `events.event_type` | `capture.video`, `capture.audio` | Create | Video/Audio | 1.0 |
| `events.event_type` | `note`, `social.post`, `post`, `social.comment` | Create | Note | 1.0 |
| `browser_activity.action_type` | `visit`, `reload` | View | Page | 1.0 |
| `browser_activity.action_type` | `bookmark` | Add | Collection | 1.0 |
| `browser_activity.action_type` | `search` | **NULL** | — | — |
| `importer.kind` | `media.watch`, `watch` | Watch | Video | 1.0 |
| `importer.kind` | `media.play`, `play` | Listen | Audio | 1.0 |
| `importer.kind` | `web.page_view`, `page_view` | View | Page | 1.0 |
| `importer.kind` | `reading.annotation` | Read | Article | 0.8 |
| `importer.kind` | `social.like`, `like` | Like | — | 1.0 |
| `importer.kind` | `web.bookmark`, `social.bookmark` | Add | Collection | 1.0 |
| *(any)* | `calendar_event`, `calendar.event`, `event`, `travel.trip`, `location.fix`, `place`, `web.search`, `commerce.purchase`, `commerce.transaction`, `wearable.sleep`, `fitness.workout`, `game_played`, `achievement_unlocked`, `friend_added`, `communication.*`, `message`, `email`, `call` | **NULL** | — | — |

NULL-verb rows are load-bearing: they are the durable record that a kind was *considered and excluded*, so a later reader cannot mistake absence for oversight. The projector distinguishes "mapped to NULL" (deliberate) from "absent from the map" (unknown), counts the latter per `source_kind`, and surfaces it in the maintenance leg's result payload — no silent loss.

`ci.event_verb_hint` becomes three views (`event_verb_hint`, `content_verb_hint`, `browser_activity_verb_hint`), each with `AND e.is_deleted = FALSE` on the events one so `events_type_category_idx` (partial on that predicate) is usable.

### 5.3 Act table

```sql
-- migrate:up
CREATE TABLE IF NOT EXISTS ci.content_acts (
    act_id       uuid        PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id      uuid        NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    object_id    uuid        NOT NULL,
    verb         text        NOT NULL CHECK (verb IN (
                   'Create','Update','Delete','Undo','View','Read','Listen',
                   'Watch','Announce','Add','Remove','Like','Dislike','Follow')),
    occurred_at  timestamptz NOT NULL,
    ended_at     timestamptz,
    observed_at  timestamptz NOT NULL DEFAULT now(),

    direction           text   NOT NULL DEFAULT 'self'
                        CHECK (direction IN ('self','inbound','outbound')),
    actor_entity_id     uuid REFERENCES ci.entities(entity_id),  -- NULL = owner
    audience_entity_ids uuid[] NOT NULL DEFAULT '{}',
    audience_channel    text CHECK (audience_channel IN
                          ('email','sms','imessage','slack','public','link')),
    target_object_id    uuid,

    dwell_ms     bigint CHECK (dwell_ms >= 0),
    completion   double precision CHECK (completion BETWEEN 0 AND 1),
    position_ms  bigint CHECK (position_ms >= 0),
    repeat_count integer NOT NULL DEFAULT 1 CHECK (repeat_count >= 1),

    revision           integer CHECK (revision >= 1),
    revision_of_act_id uuid REFERENCES ci.content_acts(act_id),
    changed_fields     jsonb,

    delete_reason text CHECK (delete_reason IN ('source_reported','user_deleted','purged')),
    undoes_act_id uuid REFERENCES ci.content_acts(act_id),

    source_type   text,
    source_system text,
    source_id     text,
    capture_event_id uuid,          -- gives ci.capture_events its first reader
    confidence    double precision NOT NULL DEFAULT 1.0
                  CHECK (confidence BETWEEN 0 AND 1),
    metadata      jsonb NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),

    -- Composite FK: a cross-user object reference is unrepresentable.
    FOREIGN KEY (user_id, object_id)
        REFERENCES ci.content_objects (user_id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, target_object_id)
        REFERENCES ci.content_objects (user_id, object_id) ON DELETE SET NULL
);

-- SINGLE arbiter. Triple-less acts get a deterministic synthetic triple
-- (§4.5), so one conflictTarget suffices for bulkInsertIdempotent.
CREATE UNIQUE INDEX IF NOT EXISTS content_acts_source_triple_uniq
    ON ci.content_acts (user_id, source_type, source_system, source_id)
    WHERE source_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS content_acts_revision_uniq
    ON ci.content_acts (user_id, object_id, revision) WHERE revision IS NOT NULL;

CREATE INDEX IF NOT EXISTS content_acts_object_time_idx     -- Q1
    ON ci.content_acts (user_id, object_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS content_acts_verb_time_idx       -- Q2
    ON ci.content_acts (user_id, verb, occurred_at DESC);
CREATE INDEX IF NOT EXISTS content_acts_audience_gin
    ON ci.content_acts USING GIN (audience_entity_ids);
CREATE INDEX IF NOT EXISTS content_acts_actor_idx
    ON ci.content_acts (user_id, actor_entity_id, occurred_at DESC)
    WHERE actor_entity_id IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS ci.content_acts;
```

**No write-side coalescing.** One origin row = one act, always. The 10k-scroll-events problem is solved read-side by a window query over `content_acts_verb_time_idx`, bucketed `HOUR|DAY|WEEK`. This makes the backfill genuinely idempotent by triple, which the coalescing design could not be.

**Two named queries** (P-gate acceptance tests):

```sql
-- Q1: everything I did with this object
SELECT act_id, verb, occurred_at, ended_at, direction, dwell_ms,
       completion, repeat_count, revision, confidence, source_system
  FROM ci.content_acts
 WHERE user_id = $1 AND object_id = $2
 ORDER BY occurred_at DESC LIMIT $3;

-- Q2: what did I watch last week
SELECT o.object_id, o.title, o.url, o.duration_ms,
       count(*) AS plays, sum(a.dwell_ms) AS dwell_ms,
       max(a.completion) AS best_completion, max(a.occurred_at) AS last_at
  FROM ci.content_acts a
  JOIN ci.content_objects o
    ON o.user_id = a.user_id AND o.object_id = a.object_id   -- user-scoped join
 WHERE a.user_id = $1 AND a.verb = 'Watch'
   AND a.occurred_at >= now() - interval '7 days'
 GROUP BY 1,2,3,4 ORDER BY dwell_ms DESC NULLS LAST LIMIT 50;
```

**Cut from v1:** absence-inferred DELETE (`ci.sync_runs` / `ci.object_presence` — no connector declares completeness today, and the presence upsert was the most expensive operation in the design); the `ci.content_object_act_rollup` per-object table (Q1's index serves it); `content_acts_session_idx` (redundant with the object index).

**Browser-activity projector gates:** consult `act_verb_map('browser_activity.action_type', …)` first, fall back to modality only when `action_type IS NULL`; skip rows where `is_incognito` or `contains_sensitive` is TRUE; skip rows whose url does not match `^https?://` (the schema is `z.string().min(1)`, not `.url()`, and carries `search:<query>` synthetics — those must never become identity keys).

**Announce/share projector deferred to P6** with hard gates: skip messages carrying `List-Unsubscribe`, strip query strings before keying, cap URLs-per-message, require a resolved `from_entity_id` that is a known contact. Without those, "what has Sarah shared with me" is dominated by MailChimp tracking links containing hashed recipient addresses.

---

## 6. Track 1 — Embeds

Embeds attach to `ci.content_objects.object_id`. Because Track 3 already extracted `provider` + `provider_ref` during canonicalization, **tier 0 needs no storage at all** — the player is a pure function of `provider_ref`. This is the biggest single cut versus the original design (two phases, three tables, one queue, one orchestrator leg, and a cross-repo contract change deleted).

```ts
// backend/apps/api/src/domains/embed/derivePlayer.ts
export interface StructuralPlayer {
  provider: string;
  /** Template; {origin} substituted client-side where a provider needs it. */
  playerUrlTemplate: string;
  posterUrl?: string;
  aspectRatio: number;
}
export function derivePlayer(providerRef: string): StructuralPlayer | null;
// youtube:video:ID -> https://www.youtube-nocookie.com/embed/ID,
//                    poster https://i.ytimg.com/vi/ID/hqdefault.jpg  (NOT maxres:
//                    maxres 404s for sub-720p uploads and tier 0 cannot check),
//                    16/9
// vimeo:video:ID   -> https://player.vimeo.com/video/ID?dnt=1, 16/9
// spotify:track:ID -> https://open.spotify.com/embed/track/ID, 1/1
// tiktok / dailymotion / soundcloud / archive.org / giphy ...
// Twitch omitted from v1: its `parent=` must equal the embedding page's
// hostname, and this appliance is reached at ci-server.localhost,
// <host>.ts.net:5173, and hub domains — no single server-baked value works.
```

Exposed as `@ResolveField`s on `ContentObjectType`. **No table, no queue, no backfill** for tier 0.

**Tier 1 (opt-in network resolve)** persists only network-derived results:

```sql
CREATE TABLE IF NOT EXISTS ci.object_embeds (
    user_id        uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    object_id      uuid NOT NULL,
    status         text NOT NULL,   -- vocabulary in this comment, not a CHECK:
        -- ok | not_embeddable | not_found | denied | rate_limited
        -- | transport_error | blocked_by_policy       (geocode_cache precedent)
    embed_format   text,            -- oembed | opengraph
    title          text,
    author_name    text,
    thumbnail_url  text,            -- remote; only used if policy permits
    poster_file_id uuid REFERENCES ci.files(id) ON DELETE SET NULL,  -- local
    aspect_ratio   numeric(8,4),
    duration_seconds integer,
    embed_html     text,            -- last resort; srcdoc-sandboxed only
    failure_count  integer NOT NULL DEFAULT 0,
    fetched_at     timestamptz,
    expires_at     timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, object_id),
    FOREIGN KEY (user_id, object_id)
        REFERENCES ci.content_objects (user_id, object_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS object_embeds_stale_idx
    ON ci.object_embeds (user_id, expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ci.embed_provider_policy (
    user_id         uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    provider        text NOT NULL,
    resolve_allowed boolean NOT NULL DEFAULT false,  -- appliance may fetch
    play_allowed    boolean NOT NULL DEFAULT false,  -- browser may mount iframe
    cache_poster    boolean NOT NULL DEFAULT true,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider)
);
```

**`aspect_ratio numeric(8,4)` needs an explicit TypeORM `ColumnTransformer`** — Postgres `numeric` deserializes as a JS string and the `100/ratio` padding fallback would silently produce `NaN`.

**Privacy tiers.** Tier 0 (default): pure derivation, zero network, renders a provider-badged placeholder + link-out. Tier 1 (per-provider opt-in): the *appliance* fetches once per object, downloads the poster into MinIO via `FileService.create({ variant: FileVariant.THUMBNAIL })` — filling a slot declared and never produced (`files/types.ts:6`, one grep hit repo-wide). Tier 2 (per-play gesture): iframe mounts only on click, `referrerpolicy="no-referrer"`, narrow `allow` list, **no `sandbox`** (a cross-origin frame is already origin-isolated; `allow-scripts allow-same-origin` adds nothing and removes `allow-popups`/storage-access, breaking YouTube and Spotify controls). `embed_html`, when stored, renders only in `<iframe srcdoc sandbox="allow-scripts">` (no `allow-same-origin`, so it gets an opaque origin) — never `dangerouslySetInnerHTML`.

CSP is **static defense-in-depth**: a fixed `frame-src` allowlist of the ~10 supported hosts, set once by middleware. It is not the gate — React not rendering the iframe is.

**Link rot is the argument for local posters.** In lifescope-embed's `providers.json`, ~a third of 90 entries point at dead services (Blip, Qik, Revision3, Rdio, Vine, Screenr) and five more moved endpoints (Instagram, Facebook, Twitch, Spotify, Hulu). That is the empirical seven-year decay rate for this exact data class. `title`, `author_name`, `duration_seconds`, `aspect_ratio` are denormalized at resolve time and never re-derived at render.

**SSRF chokepoint** (`EmbedFetcher`, the highest-risk file in the proposal — budget it as its own PR): `undici.Agent({ connect: { lookup } })` where `lookup` rejects blocked addresses so the *validated* address is the one connected to (no DNS-rebind TOCTOU), `redirect: 'manual'` with an explicit ≤3-hop loop through the same agent, 8s `AbortController`, `Range: bytes=0-262143`, fixed User-Agent, no cookies. Deny list: `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `0.0.0.0/8`, **`100.64.0.0/10`** (Tailscale CGNAT — this appliance is routinely on a tailnet), `::1`, `fc00::/7`, `::ffff:*` unwrapped, `.local`/`.internal`/`.localhost`. Per-host `RateLimiter` (copy `GeocodeBatchListener.ts:42-67`) plus a separate budget for poster hosts (`i.ytimg.com` is a different host from `youtube.com`).

**Poster GC:** a `deleted_at`-aware sweep in the maintenance orchestrator deletes `ci.files` rows with `external_id LIKE 'embed:%'` that no `object_embeds.poster_file_id` references.

---

## 7. Backfill mechanics (shared by all three tracks)

Every backfill uses one listener shape, and **every listener self-requeues** — the single most important correction in this document, because `MediaDimensionsBackfillListener` does not (`:84`, `:126-133`) and `IngestLifecycleController.ts:60-62` passes no limit, so the original design's "sweeps the whole corpus" would have processed 500 rows and reported success.

```ts
// backend/apps/api/src/domains/identity/listeners/ObjectIdentityBackfillListener.ts
export const OBJECT_IDENTITY_QUEUE = 'object-identity';

@OnEvent(ObjectIdentityBackfillRequestEvent, { queue: OBJECT_IDENTITY_QUEUE })
async handle(payload: { userId: string; after?: string; limit?: number }) {
  const cap = payload.limit ?? 2000;
  let cursor = payload.after ?? null;
  let processed = 0;
  while (processed < cap) {
    const page = await this.selectCandidates(payload.userId, cursor, 200);
    if (page.length === 0) return this.done(processed);
    await Promise.all(page.map(r => limit(() => this.claim(r))));
    cursor = page[page.length - 1].cursor;
    processed += page.length;
  }
  // Cap reached with rows remaining: CHAIN. Bounded jobs stay well inside
  // pg-boss expireInHours: 12 (PGBossEventService.ts:76-80).
  await this.eventService.send(
    ObjectIdentityBackfillRequestEvent,
    { userId: payload.userId, after: cursor, limit: cap },
    { queue: OBJECT_IDENTITY_QUEUE },   // ALWAYS explicit — send() without a
  );                                     // queue fans out to every registered
}                                        // queue (PGBossEventService.ts:229-249)
```

Idempotency is by candidate subtraction (`WHERE NOT EXISTS (SELECT 1 FROM ci.object_identifiers …)`). **Spec-version recompute is a separate leg** with its own predicate (`WHERE spec_version < $current`) — the original design's candidate-subtraction would have made spec bumps silently unapplicable.

**Dedupe sweep is a maintenance leg, not a migration.** `COMMIT` inside a `DO $$` under dbmate raises `2D000`; batching without commits gives no lock or WAL relief. The leg does real per-batch commits, oldest-wins canonical selection (`DISTINCT ON … ORDER BY created_at ASC, object_id ASC`), writes the merge-candidate/audit row *before* any DELETE, and ships with a dry-run that only counts. It is owner-scoped throughout — it does **not** repeat `20260628120001`'s `IF user_count <> 1 THEN RETURN` bailout, which left every multi-user appliance carrying the full ~2.4× content duplication permanently.

---

## 8. Phased plan

Each phase is one shippable PR (or tight pair) with a gating acceptance test.

| # | Scope | Effort | Acceptance test |
|---|---|---|---|
| **P0** | **Quick wins, no new subsystem.** Route the four YouTube transforms through `contentService.createMany` (which has ON CONFLICT DO NOTHING and the triple auto-link — `create()` is a plain save and would raise 23505); persist `snippet.thumbnails` and, **for Likes only**, `contentDetails.duration` (`videos.list` carries it; `activities.list` and `playlists.list` do not — the "zero quota" claim only holds for Likes); fix the interface to declare `maxres`; delete the three `console.log`s; stop `mediaKind()` classifying `video/youtube` as playable video. | 1 day | Gallery renders a YouTube like as a link-out card, not a broken `<img>`. Re-running the YouTube sync twice inserts 0 new content rows. |
| **P0.5** | `ContentService.update` drops `source_data` (declared at `memory/types.ts:196`, passed at `ContentResolver.ts:156`, unmapped at `ContentService.ts:430-458`). Add the branch. Code-only — **no placeholder migration**. | 0.5 day | `updateContent({ sourceData })` round-trips. |
| **P1** | `@ci/object-identity` package: canonicalizer (all 10 steps, both tracking tiers, provider extractors), `buildNaturalKey` with declared temporality + archive/ordinal fallback, `resolveIdentities`. ~400 golden fixtures. Digest lock + `sync-to-importer`. Nothing consumes it. | 4 days | Every row of the §4.2 worked-example table passes in **both** repos' runners against the same fixture file. `canonicalizeUrl(canonicalizeUrl(u)) === canonicalizeUrl(u)` (property test). |
| **P2** | `ci.content_objects` + `ci.object_identifiers` + `ci.object_merge_candidates`. `ObjectIdentityService` (batched row-values resolve, chunked claim, conflicts returned as data). Wire `resolveOrCreate` into every ingest write path. Self-requeuing backfill leg + orchestrator stage. GraphQL `contentObject` / `contentObjectByKey`. | 5 days | Backfill over the full 194k-row content corpus completes across chained jobs (assert: candidate count > limit ⇒ follow-on enqueue exists). `SELECT count(*) FROM ci.content c WHERE NOT EXISTS (…object_identifiers…)` = 0. |
| **P3** | Importer re-key: SQLite migration (`identity_key`, `identity_kind`, `legacy_content_hash`, `idx_items_identity`, `idx_items_sha256`), `hashItem` → `identityFor`, 15 weak sources fixed, legacy bridge emitted, `X-CI-Identity-Spec` min-server gate. Behind a flag with dry-run. | 4 days | Netflix quick export with 3 titles on one date yields **3** items (today: 1). Full double-import of a fixture archive yields identical SQLite `items` and identical `ci.*` counts. |
| **P4** | Arbiter hardening: `events_source_triple_user_uniq` (CONCURRENTLY out-of-band, then flip + drop old in one deploy); populate `INGEST_REFRESH_COLUMNS` with the disjointness test; synthetic triple for triple-less `/v1`; `files_user_hash_uniq` aligned to `findByHash`'s predicate; dedupe sweep leg (dry-run first). | 5 days | `idempotency.e2e-spec.ts`: POST the same `/v1` batch twice for all 7 types ⇒ run 2 reports `created: 0` and row counts unchanged. Nightly double-import CI job green. |
| **P5** | Acts: `ci.act_verb_map` (4-column-keyed) + three hint views; `ci.content_acts`; Create/View/Read/Listen/Watch projectors (**no** write-side coalescing); read-side bucket collapse; `reconcile_content_acts` leg + mirrored `ORCHESTRATE_LEG_ORDER` in the importer. Q1 + Q2 as GraphQL queries **in this PR**. | 8 days | Q1 and Q2 return correct results from the frontend. Running the reconcile leg twice changes zero rows. A repo test fails if `ContentActService` has a writer but no `@Query`. |
| **P6** | Embeds tier 0: `derivePlayer` + `AspectBox`/`EmbedPoster`/`EmbedPlayer` components + `@ResolveField`s. Click-to-play from day one (with no provider enabled, the click opens a new tab). Announce projector with the List-Unsubscribe / known-contact gates. | 6 days | A YouTube object in the gallery shows a poster and plays on click, with **zero** outbound requests before the click (assert via network log in the Playwright E2E). |
| **P7** | Embeds tier 1: `EmbedFetcher` (SSRF suite is its own gating test file), oEmbed/OG providers, poster cache into MinIO, provider policy UI, poster GC. Static CSP `frame-src`. | 7 days | `EmbedFetcher.ssrf.test.ts`: each blocked range (incl. `100.64.0.0/10` and `::ffff:127.0.0.1`) refused, on the initial request **and** on a redirect hop. |
| **P8** | Merge/unmerge: `ci.object_merges` + `ci.object_aliases`, survivorship, `repointObjectReferences` (incl. the `ci.item_relationships` **triple** re-point), `resolveCanonical` in every id-accepting read path, duplicate-review UI. | 7 days | `merge(a,b)` then `unmerge()` restores byte-identical state including original uuids (full-table snapshot diff). |

**Cumulative: ~48 days.** P0–P0.5 ship this week and fix a visible bug. P1–P4 are the foundation and are where the real value is. P5–P8 are each independently deferrable.

---

## 9. What I could not verify

- **Live row counts beyond `ci.content` (194k) and `ci.browser_activity` (330k)**, both taken from `20260714082548`'s header, itself citing a live-DB review of unknown vintage. `ci.events` size, `count(DISTINCT url)` on `ci.browser_activity` (which *is* the object cardinality for the browsing plane), and the media-content count are all unmeasured. **P2's effort estimate and the poster-storage budget both depend on these — run them before starting P2.**
- **Whether `ci.content.user_id` NULLs remain** after `20260628000000`'s backfill. The column is still nullable and the backfill was single-user-gated. The P2 candidate SQL's `WHERE user_id = $1` skips those rows silently; I have added a counter but not verified the population.
- **PowerSync replication-set impact.** `domains/powersync` exists; whether `ci.content_objects` / `ci.content_acts` should be in the mobile replication set is a decision I did not make, and silence is itself a choice with consequences.
- **`ci.content_acts` hypertable-or-not.** Every time-series peer (`position`, `communications`, `browser_activity` originally, `activities`) is a hypertable with compression. I propose a plain table on the argument that acts are a projection of already-partitioned sources, but I have not sized it against a real corpus, and `ci.browser_activity` was large enough to need departitioning (`20260104075933`).
- **Provider extractor coverage** against live 2026 URL forms. The YouTube/Spotify/Vimeo/X rules are written from current knowledge; TikTok and Dailymotion URL shapes in particular churn and are unverified against live traffic.
- **`ci.act_verb_map` operational lifecycle.** "Absorbing a new spelling is an INSERT, not a deploy" — but nothing states who runs it, how it survives `drop_all_pg_data.sql`, or how a locally-added row propagates. `migrate:down` drops the table, destroying operator additions.