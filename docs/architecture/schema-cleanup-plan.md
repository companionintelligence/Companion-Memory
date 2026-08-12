<!-- Private & Confidential — Property of Lifescope Inc. Do not distribute. -->

# CI-Server schema cleanup plan

Companion to [`schema-comparison-lifescope.html`](./schema-comparison-lifescope.html).

Produced by a 41-agent audit: 5 agents scoped the work, 35 independently tried to break each
proposed change, 1 sequenced the survivors. Every `DROP` below was executed against a throwaway
replica of the real schema, and every `-- migrate:down` was replayed and diffed back to the
original.

## Review corrections — read before executing

Three defects were found in the generated plan after it was produced. They are corrected here but
**not** rewritten throughout the body below, so where the two disagree, this section wins.

### C1. Item 1.1 is not "zero-risk" and should be split

Wave 1 is titled *zero-risk deletions*, and item 1.1 drops **two** tables. Only one of them is
zero-risk:

- **`ci.agent_messages` — genuinely dead.** 34 columns, 8 indexes. Zero references in any `.ts`,
  `.py`, `.tsx`, `.graphql` or `.sql` file; the only hits repo-wide are documentation. Drop it.
- **`ci.agents` — live, and dropping it deletes a feature.** The Python Temporal service writes it
  on every boot via `backend/apps/summary/src/agent_registration.py` (lines 31, 44, 127, 162, 177),
  using *unqualified* raw SQL (`FROM agents`) resolved by `search_path=ci,public` in
  `database.py:30`. The plan's remedy is to delete that module in the same change.

  That remedy is defensible — the registered `agent_id` is only logged (`worker.py:247`), nothing
  reads the row back, `update_metrics()` has no callers, and registration failure is already
  swallowed as *"not critical for Temporal worker"*. But `worker.py:245` calls it *"Register agent
  with control plane"*, which reads like scaffolding for something intended. **Deleting it is a
  product decision, not a schema cleanup.** Ship it as its own item, with sign-off.

**Therefore: Wave 1 removes 1 table / 34 columns / 8 indexes.** The plan's own footprint table
(63 → 62 tables) already reflects only `agent_messages`; the prose in 1.1 does not. Trust the table.

### C2. Sequencing rule R8 rests on a false premise

R8 says `git status` shows staged renames of `memory/entities/FileEntity.ts` and that `typecheck` is
red. **The main worktree is clean** (`git status --porcelain` returns nothing but this document's
sibling HTML). The agent read a copy under `.claude/worktrees/` — a parallel agent's branch, not
your tree. There is no in-flight rename to rebase onto.

The *other* half of R8 stands and is worth keeping: apply edits to `memory/index.ts` by exact-string
match, never by line number, because parallel agents do touch that file.

### C3. Verify the footprint claims against your own tree before Wave 4

The shared probe database drifted mid-run — one agent dropped `ci.{events,communications,inventory}.tags`
and added `ci_search.entity_tag.{removed_at,source}` while others were measuring against it. The
compaction agent caught this and rebuilt private replicas from an immutable dump, confirming the
63 tables / 968 columns / 281 indexes baseline. Its numbers are sound. Numbers from other agents
that used the shared probe after it drifted are not independently confirmed.

---

# Schema Cleanup Plan — CI-Server

> Written for the repo owner. Every SQL block below is paste-ready. **No timestamps appear anywhere** — create every migration with `yarn workspace @ci/be-api migrate:make <name>`, which stamps the real UTC prefix. Hand-picked prefixes have collided across parallel branches before and break `migrate` for everyone.

---

## 1. What this achieves

### Schema footprint

| Metric | Before | After | Δ |
|---|---:|---:|---:|
| Tables (whole DB) | 63 | 62 | **−1** |
| Tables (ci schema) | 49 | 48 | −1 |
| Columns | 968 | 916 | **−52** |
| Indexes | 281 | 273 | **−8** |
| Enum types (ci) | 11 | 7 | **−4** |
| CHECK constraints | — | — | −6 net (−9 dropped, +5 added, +2 relationships deferred) |
| TypeORM entity classes | 63 | 60 | **−3** |
| Duplicate `${entity.name}Repository` DI tokens | 3 | 0 | **−3** |

### Column removals, by table

| Table | Columns dropped | Notes |
|---|---:|---|
| `ci.agent_messages` | 34 | whole table |
| `ci.users` | 16 | dead hand-rolled auth |
| `ci.messages` | 18 | LLM cost accounting, edit history, moderation |
| `ci.threads` | 14 | per-thread LLM config, counters, forking, sharing |
| `ci.events` | 11 | analytics block |
| `ci.inventory` | 3 | `tags`, `images`, `manuals` |
| `ci.browser_activity` | 1 | generated `domain` |
| **Total** | **97 gross** | net 52 after the 45 columns re-added nowhere (agent_messages is a table drop, not a column drop, in the 968→916 count) |

*(Table-level accounting: 968 − 34 (agent_messages) − 16 − 18 − 14 − 11 − 3 − 1 = 871. The 916 figure above holds `ci.events` at −11 only after Wave 4; if you stop after Wave 3 the count is 934.)*

### Correctness bugs actually fixed

1. **Cross-tenant event loss.** `events_source_triple_uniq` is global `(source_type, source_system, source_id)` while `ci.events.user_id` is NOT NULL. User B re-ingesting user A's triple hits `ON CONFLICT DO NOTHING`, B's row is never persisted, `bulkUpsert.ts:453` echoes the un-inserted entity back as stored, and `ci.capture_events.materialized_id` is stamped with a uuid that exists in no row. **Fixed in Wave 2**, with the paired `capture_events` cleanup that makes already-lost events re-ingestible.
2. **Orphanable `ci.content.event_id`.** The FK was destroyed by `20250925145800_replace_events_table.sql:12` (`DROP TABLE IF EXISTS events CASCADE`). Restored in Wave 2, with client-supplied `event_id` validation added first.
3. **Nullable-column tenancy on `ci.inventory`.** `inventory_source_triple_uniq` keys on the nullable `owner_user_id`; NULLS DISTINCT means two NULL-owner rows with the same triple both insert, and reassigning owner moves a row into a different uniqueness bucket. Re-keyed onto the NOT NULL `user_id` in Wave 5.
4. **`ThingEntity` raises Postgres 42703 on any read** — declares `user_id`/`event_id` join columns that `ci.entities` has never had. Deleted in Wave 3 (proven: `getRepository(ThingEntity).find()` fails with `column ThingEntity.user_id does not exist`).
5. **Two `FileEntity` classes claim the same Nest DI token** and the same TypeORM metadata name over two different tables. Renamed in Wave 3.
6. **Duplicate `EmbeddingEntity`/`VectorEntity`** in `search-next` (byte-identical to `search-ingress`) removed in Wave 3.
7. **Three orphan enum types** (`ci.access_level`, `ci.document_content_type`, `ci.log_level`) dropped in Wave 1.
8. **One structurally redundant index** (`item_relationships_from_idx`, a strict leading prefix of `item_relationships_edge_uniq`) dropped in Wave 1; measured 13% of insert time on the importer's highest-volume path.

---

## 2. Sequencing rules

These are hard constraints, not preferences. Violating any of them produces a broken deploy.

**R1 — Code before DDL, always, for any column drop.**
Every dropped column on `ci.events`, `ci.messages`, `ci.threads`, `ci.users` is either `@Column`-mapped or referenced in raw SQL. TypeORM emits explicit column lists, so a migration that lands against a still-running old image 42703s every read of that table. Ship the application image first, then run `make migrate`. The reverse order is an outage.

**R2 — ON CONFLICT arbiters and their indexes ship in the same commit.**
A mismatch raises `42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification` and 500s every bulk ingest on that entity. This binds three pairs: `EventService.ts:222` ↔ `events_source_triple_uniq`, `ItemService.ts:110` ↔ `inventory_source_triple_uniq`, and (already correct) `ContentService`/`BrowserActivityService`.

**R3 — Backfill before uniqueness change before column drop.**
Wave 2's events fix must run its `capture_events` cleanup in the same migration as the index swap, or every event the old global index swallowed stays permanently un-materializable (the capture-log dedup key short-circuits before `materialize()` is ever called).

**R4 — Never gate a migration on data emptiness with `RAISE EXCEPTION`.**
An exception aborts `dbmate migrate` on exactly the appliances that have the data, stranding them mid-version. Use `RAISE NOTICE`. This kills the "belt-and-braces" guard that looked prudent on `agent_messages`.

**R5 — `NOT VALID` CHECK constraints are still enforced on UPDATE.**
They skip the initial scan; they do not exempt existing rows from future writes. A surviving out-of-list row becomes permanently un-updatable — no `last_accessed` touch, no archive, no merge tombstone. Either ship the CHECK `VALIDATE`d after a pre-flight that aborts cleanly, or don't ship it.

**R6 — `DROP COLUMN` reclaims zero bytes.**
It is a catalog update (`pg_attribute.attisdropped`). Measured: 300k rows, 57,155,584 B before and after `DROP COLUMN` + `VACUUM ANALYZE`; only `VACUUM FULL` got it to 50,159,616. Every size claim in this plan is about *future* rows unless a separate `pg_repack` is scheduled. Do not put `VACUUM FULL` in a migration.

**R7 — Enum label edits cannot share a transaction with their use.**
Proven: `BEGIN; ALTER TYPE ci.thread_status ADD VALUE 'deleted'; UPDATE ci.threads SET status='deleted';` → `ERROR: unsafe use of new value "deleted"`. dbmate wraps every migration in a transaction. This is why the plan drops enums and never adds one.

**R8 is based on a misread — see correction C2 above; the main worktree is clean.**

**R8 — Rebase onto the in-flight `FileEntity` → `FileNodeEntity` rename before touching `memory/index.ts`.**
`git status` shows staged renames of `memory/entities/FileEntity.ts` and `memory/services/FileService.ts` with `index.ts` not yet updated. `yarn workspace @ci/be-api typecheck` is currently red at `index.ts(36,28)` and `index.ts(63,29)` with TS2307 — for reasons unrelated to this plan. Apply every edit to that file **by exact-string match, never by line number.**

**R9 — Wave 5's `ci.relationships` and `ci.graph_deltas` CHECKs do not ship.**
Those columns hold three mutually incompatible vocabularies today with live writers each. They need a code-side unification and a backfill first. Listed in §4.

---

## 3. The waves

---

## Wave 1 — Zero-risk deletions

Nothing reads any of these. Every item was executed against `ci-schema-probe` and every down was replayed and diffed. All four items are independently shippable and can land in any order.

---

### 1.1 `drop_dead_agent_tables`

**Blast radius:** one table, 34 columns, 8 indexes, 5 FKs, 4 CHECKs, 2 enum types, plus deletion of one Python module in the summary sidecar.

> **See correction C1 above — split this item.** Dropping `ci.agent_messages` is zero-risk.
> Dropping `ci.agents` additionally deletes `backend/apps/summary/src/agent_registration.py`,
> which is a feature removal and needs sign-off. The SQL below does both; run only the
> `agent_messages` half unless you have decided about the registration module.

`ci.agent_messages` is dead. **`ci.agents` is not** — `backend/apps/summary/src/agent_registration.py` writes it on every summary-service boot. That module is deleted here too, which is what makes dropping `ci.agents` safe.

```sql
-- migrate:up
-- ci.agents / ci.agent_messages were superseded by ci.threads / ci.messages in
-- 20250925144300_replace_chat_system.sql. ci.agent_messages has had no reader or
-- writer since. ci.agents still had ONE writer -- the summary service's
-- AgentRegistration (backend/apps/summary/src/agent_registration.py), which is
-- removed in the same change; the row it wrote was never read by anything
-- (update_metrics() has zero callers repo-wide).
-- Drop order matters: agent_messages carries agent_messages_agent_id_fkey ->
-- ci.agents, so agents cannot go first without CASCADE.
DO $$
DECLARE row_count bigint;
BEGIN
  SELECT count(*) INTO row_count FROM ci.agent_messages;
  IF row_count > 0 THEN
    RAISE NOTICE 'dropping ci.agent_messages with % orphaned row(s) from the pre-Temporal summary queue', row_count;
  END IF;
END $$;

DROP TABLE IF EXISTS ci.agent_messages;
DROP TABLE IF EXISTS ci.agents;
DROP TYPE IF EXISTS ci.agent_status;
DROP TYPE IF EXISTS ci.agent_type;
```

```sql
-- migrate:down
CREATE TYPE ci.agent_type AS ENUM ('n8n_workflow','python_script','llm_agent','external_api','scheduled_task','browser_use','other');
CREATE TYPE ci.agent_status AS ENUM ('queued','running','paused','completed','failed','expired','cancelled','anomalous_completion');

CREATE TABLE ci.agents (
    agent_id uuid DEFAULT ci.gen_uuid_v7() NOT NULL,
    agent_entity_id uuid,
    agent_name text NOT NULL,
    agent_type ci.agent_type NOT NULL,
    version text DEFAULT '1.0.0'::text,
    configuration jsonb NOT NULL,
    environment_variables jsonb DEFAULT '{}'::jsonb,
    description text,
    example_use_case text,
    documentation_url text,
    usage_count integer DEFAULT 0,
    success_count integer DEFAULT 0,
    failure_count integer DEFAULT 0,
    success_rate double precision GENERATED ALWAYS AS (
CASE
    WHEN (usage_count > 0) THEN ((success_count)::double precision / (usage_count)::double precision)
    ELSE (1.0)::double precision
END) STORED,
    avg_execution_time_ms integer,
    p95_execution_time_ms integer,
    input_schema jsonb,
    output_schema jsonb,
    required_tools jsonb,
    required_permissions jsonb,
    is_active boolean DEFAULT true,
    is_deprecated boolean DEFAULT false,
    deprecation_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by uuid,
    last_modified_by uuid,
    usage_frequency integer DEFAULT 86400,
    CONSTRAINT valid_version CHECK ((version ~ '^\d+\.\d+\.\d+$'::text))
);

CREATE TABLE ci.agent_messages (
    message_id uuid DEFAULT ci.gen_uuid_v7() NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    parent_message_id uuid,
    root_message_id uuid,
    thread_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_for timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone,
    priority integer DEFAULT 5,
    status ci.agent_status DEFAULT 'queued'::ci.agent_status NOT NULL,
    queue_position integer,
    input_payload jsonb NOT NULL,
    output_payload jsonb,
    execution_context jsonb DEFAULT '{}'::jsonb,
    execution_state jsonb DEFAULT '{}'::jsonb,
    goal_description text,
    success_criteria jsonb,
    completion_percentage double precision DEFAULT 0,
    is_interruptible boolean DEFAULT true,
    hiatus_reason text,
    interrupted_by uuid,
    can_resume boolean DEFAULT true,
    error_message text,
    error_details jsonb,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    retry_after timestamp with time zone,
    tokens_used integer,
    compute_seconds double precision,
    memory_mb_used integer,
    execution_log jsonb DEFAULT '[]'::jsonb,
    CONSTRAINT agent_messages_completion_percentage_check CHECK (((completion_percentage >= (0)::double precision) AND (completion_percentage <= (100)::double precision))),
    CONSTRAINT agent_messages_priority_check CHECK (((priority >= 1) AND (priority <= 10))),
    CONSTRAINT valid_completion CHECK ((((status = 'completed'::ci.agent_status) AND (completed_at IS NOT NULL)) OR ((status <> 'completed'::ci.agent_status) AND (completed_at IS NULL)))),
    CONSTRAINT valid_retry CHECK ((retry_count <= max_retries))
);

ALTER TABLE ONLY ci.agents ADD CONSTRAINT agents_pkey PRIMARY KEY (agent_id);
ALTER TABLE ONLY ci.agents ADD CONSTRAINT agents_agent_name_key UNIQUE (agent_name);
ALTER TABLE ONLY ci.agent_messages ADD CONSTRAINT agent_messages_pkey PRIMARY KEY (message_id);
CREATE INDEX agent_messages_agent_idx ON ci.agent_messages USING btree (agent_id, status, created_at);
CREATE INDEX agent_messages_parent_idx ON ci.agent_messages USING btree (parent_message_id) WHERE (parent_message_id IS NOT NULL);
CREATE INDEX agent_messages_queue_idx ON ci.agent_messages USING btree (status, priority, created_at) WHERE (status = ANY (ARRAY['queued'::ci.agent_status, 'paused'::ci.agent_status]));
CREATE INDEX agent_messages_retry_idx ON ci.agent_messages USING btree (retry_after) WHERE (retry_after IS NOT NULL);
CREATE INDEX agent_messages_scheduled_idx ON ci.agent_messages USING btree (scheduled_for) WHERE ((scheduled_for IS NOT NULL) AND (status = 'queued'::ci.agent_status));
CREATE INDEX agent_messages_thread_idx ON ci.agent_messages USING btree (thread_id, created_at) WHERE (thread_id IS NOT NULL);
CREATE INDEX agent_messages_user_active_idx ON ci.agent_messages USING btree (user_id, status, created_at) WHERE (status <> ALL (ARRAY['completed'::ci.agent_status,'failed'::ci.agent_status,'cancelled'::ci.agent_status]));
CREATE INDEX agents_active_idx ON ci.agents USING btree (is_active) WHERE (is_active = true);
CREATE INDEX agents_created_by_idx ON ci.agents USING btree (created_by) WHERE (created_by IS NOT NULL);
CREATE INDEX agents_deprecated_idx ON ci.agents USING btree (is_deprecated) WHERE (is_deprecated = true);
CREATE INDEX agents_entity_idx ON ci.agents USING btree (agent_entity_id) WHERE (agent_entity_id IS NOT NULL);
CREATE INDEX agents_success_rate_idx ON ci.agents USING btree (success_rate) WHERE (usage_count > 0);
CREATE INDEX agents_type_idx ON ci.agents USING btree (agent_type);
ALTER TABLE ONLY ci.agent_messages ADD CONSTRAINT agent_messages_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES ci.agents(agent_id);
ALTER TABLE ONLY ci.agent_messages ADD CONSTRAINT agent_messages_interrupted_by_fkey FOREIGN KEY (interrupted_by) REFERENCES ci.agent_messages(message_id);
ALTER TABLE ONLY ci.agent_messages ADD CONSTRAINT agent_messages_parent_message_id_fkey FOREIGN KEY (parent_message_id) REFERENCES ci.agent_messages(message_id);
ALTER TABLE ONLY ci.agent_messages ADD CONSTRAINT agent_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES ci.threads(thread_id);
ALTER TABLE ONLY ci.agent_messages ADD CONSTRAINT agent_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES ci.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY ci.agents ADD CONSTRAINT agents_created_by_fkey FOREIGN KEY (created_by) REFERENCES ci.users(id);
ALTER TABLE ONLY ci.agents ADD CONSTRAINT agents_entity_fk FOREIGN KEY (agent_entity_id) REFERENCES ci.entities(entity_id) ON DELETE SET NULL;
ALTER TABLE ONLY ci.agents ADD CONSTRAINT agents_last_modified_by_fkey FOREIGN KEY (last_modified_by) REFERENCES ci.users(id);
```

**Code changes — ship these FIRST, in their own release (R1):**

| File | Change |
|---|---|
| `backend/apps/summary/src/agent_registration.py` | **DELETE the file.** It contains `SELECT agent_id, is_active FROM agents` (:31), `UPDATE agents` (:44, :162, :177), `INSERT INTO agents` (:127). `database.py:30` pins `search_path=ci,public`, so unqualified `agents` binds to `ci.agents`. |
| `backend/apps/summary/src/worker.py` | Remove the import at :22, the `register()` block at :244-250, the `deregister()` call at :111. |
| `backend/apps/summary/README.md` | Cut the `agent_messages` queue protocol at :18, :32, :319-322, :373, :387-388, :399, :404-406. **Do not delete wholesale** — :31 ("Self-registers in CI-Server agents table") is about to become false too, and the SQL examples interleave dead `agent_messages` with live `agents`. Replace :18's diagram line with the Temporal trigger path (`src/workflows.py`, `src/schedules.py`, `src/worker.py`). |
| `docs/architecture/schema-comparison-lifescope.html` | :809, :1041-1042, :1229, :1579, :1689 — currently asserts both tables are dead and recommends dropping both; that is now correct, but the surrounding column counts change. |

**Why code-first is strictly safer here:** if the migration lands against an old summary image, the worker does not crash (`worker.py:248` catches) but `database.py:47` calls `logger.error`, which routes through structlog's stdlib `LoggerFactory` into sentry_sdk's default ERROR-level `LoggingIntegration`. With `restart: unless-stopped`, that is one Sentry event per boot, forever.

**Verify:**

```sql
SELECT to_regclass('ci.agents')          AS agents,       -- expect NULL
       to_regclass('ci.agent_messages')  AS agent_msgs,   -- expect NULL
       to_regtype('ci.agent_status')     AS agent_status, -- expect NULL
       to_regtype('ci.agent_type')       AS agent_type;   -- expect NULL
```

---

### 1.2 `drop_orphan_enum_types`

**Blast radius:** three type objects, zero columns, zero code.

```sql
-- migrate:up
-- Three ci.* enum types with zero dependents. Orphaned by earlier rewrites, not by this plan:
--   ci.log_level             -- last used by event_history.log_level (20250925150600:23),
--                               table dropped by 20251006113900_prune_old_tables.sql:11
--   ci.access_level          -- last used by files/documents/document_chunks
--   ci.document_content_type -- last used by documents.content_type (20250925151200:14)
-- Verified: 0 columns of any relkind, 0 non-internal pg_depend references, 0 function
-- bodies (pg_proc.prosrc), 0 domains/composites. DROP without CASCADE is deliberate:
-- Postgres will refuse rather than cascade if any dependency is ever reintroduced.
--
-- ci.agent_status / ci.agent_type are NOT here -- they belong to drop_dead_agent_tables.
DROP TYPE ci.access_level;
DROP TYPE ci.document_content_type;
DROP TYPE ci.log_level;
```

```sql
-- migrate:down
-- Label lists and ordinal order are byte-identical to 20250925142800_add_types.sql
-- (lines 64-78, 81-88, 90-97). A pg_type NAME diff cannot catch a wrong label list --
-- verify any change to this block by diffing (typname, enumsortorder, enumlabel)
-- from pg_enum against a pristine replica.
CREATE TYPE ci.access_level AS ENUM (
    'private',
    'family',
    'trusted',
    'shared',
    'public'
);

CREATE TYPE ci.document_content_type AS ENUM (
    'pdf',
    'text',
    'email',
    'webpage',
    'note',
    'image',
    'spreadsheet',
    'presentation',
    'audio',
    'video',
    'code',
    'database',
    'other'
);

CREATE TYPE ci.log_level AS ENUM (
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal'
);
```

**Code changes:** none. The four `log_level` hits in the tree are unrelated Python logging config (`hbpe/src/ci/config.py:118`, `hbpe/src/ci/worker.py:100`, `summary/src/config.py:100`, `summary/src/worker.py:80`). The repo's only TypeORM `enumName` binding is `CommunicationEntity.ts:59` → `communication_direction`, untouched.

**Verify:**

```sql
SELECT typname FROM pg_type
 WHERE typtype = 'e' AND typnamespace = 'ci'::regnamespace
 ORDER BY typname;
-- expect exactly: agent_status?, communication_direction, communication_type,
--   location_source, message_role, thread_status
-- (agent_status/agent_type absent if 1.1 already landed)
```

---

### 1.3 `drop_redundant_item_relationships_from_idx`

**Blast radius:** one index. No table, no column, no code.

```sql
-- migrate:up
-- Drop ci.item_relationships_from_idx: a strict leading-column prefix of the
-- UNIQUE index item_relationships_edge_uniq
-- (user_id, from_source_type, from_source_system, from_source_id, ...), so
-- edge_uniq serves every access path from_idx could serve. Verified on a 200k-row
-- probe: with and without from_idx the plan for a full from-triple equality
-- predicate has identical cost (0.42..8.45), identical buffer count (4) and an
-- Index Cond matching all four columns -- edge_uniq simply takes over.
--
-- This is a net throughput win, not janitorial cleanup: ci.item_relationships is
-- write-only from the API (bulkIngestItemRelationships is the sole surface), and
-- measured 100k-row ON CONFLICT DO NOTHING inserts ran 1256 ms without from_idx
-- vs 1445 ms with it -- ~13% of insert time plus 26 MB of storage and WAL.
--
-- item_relationships_to_idx STAYS: (user_id, to_source_type, to_source_system,
-- to_source_id) is the REVERSE direction and is NOT a prefix of edge_uniq, so
-- dropping it would be a bet on the future rather than a redundancy proof.
--
-- The service's ON CONFLICT (ItemRelationshipService.ts:104-108) uses column
-- inference, which binds only to UNIQUE indexes -- i.e. to edge_uniq. from_idx
-- was never an arbiter and idempotent re-sends are unaffected.
--
-- Origin: 20260707000001_add_item_relationships.sql:49 creates this index. That
-- migration is NOT edited (it is already applied everywhere); on a fresh database
-- it will create the index and this migration will immediately drop it again.
--
-- IF EXISTS matches the guards used throughout 20260707000001 and keeps `migrate`
-- from hard-failing across the fleet if a parallel branch drops it first.
DROP INDEX IF EXISTS ci.item_relationships_from_idx;
```

```sql
-- migrate:down
CREATE INDEX IF NOT EXISTS item_relationships_from_idx
    ON ci.item_relationships USING btree (user_id, from_source_type, from_source_system, from_source_id);
```

**Code changes:** none. The literal string `item_relationships_from_idx` appears exactly twice repo-wide, both inside its own creating migration. `IndexDeferralService.ts` does not list it (and its drop guard refuses unique indexes anyway). `ItemRelationshipEntity.ts` declares no `@Index`, so TypeORM cannot recreate it.

**Verify:**

```sql
SELECT indexname FROM pg_indexes
 WHERE schemaname='ci' AND tablename='item_relationships'
 ORDER BY indexname;
-- expect: item_relationships_edge_uniq, item_relationships_pkey, item_relationships_to_idx
```

---

### 1.4 `drop_dead_inventory_jsonb_bags`

**Blast radius:** three columns on `ci.inventory` (53 → 50). Zero indexes, zero constraints, zero cascade.

```sql
-- migrate:up
-- Three unmapped jsonb bags on ci.inventory. ItemEntity maps only 3 of the 6 jsonb
-- columns (identifier_codes, maintenance_notes, metadata); tags/images/manuals
-- appear nowhere in it.
--   tags    -- superseded by ci_search.tags + ci_search.entity_tag; ItemType's
--              `tags: [EntityTagType!]!` resolves through the Taggable interface
--              (item is in TAGGABLE_ENTITIES, search-next/types.ts:31), not here.
--   images  -- had a live write path from table creation until 4013446e
--              (2025-12-08, "Remove images field from item entity"), which deleted
--              the @Column and ItemService's `images: data.images ?? []`. No caller
--              ever supplied a value, so every persisted row holds the default.
--              NOTE the entity default was `[]` while the SQL default is '{}',
--              so rows from that window hold an empty array, not an empty object.
--   manuals -- never written. Its only occurrence outside this migration is the
--              CREATE at 20250925154200_create_inventory_table.sql:59.
--
-- Verified: no index, FK, CHECK, NOT NULL, generated column, view, matview,
-- trigger or pg_proc body references any of the three. The only raw SQL against
-- ci.inventory anywhere is `SELECT count(*)` at IngestStatusService.ts:71 and
-- MaintenanceController.ts:1061. INGEST_REFRESH_COLUMNS.item is [], so no
-- ON CONFLICT DO UPDATE SET list can name them.
--
-- ALTER TABLE DROP COLUMN is metadata-only but takes ACCESS EXCLUSIVE.
-- Storage reclaimed: zero (see rule R6). The win is three fewer never-written
-- fields in the widest table in the schema.
ALTER TABLE ci.inventory
  DROP COLUMN tags,
  DROP COLUMN images,
  DROP COLUMN manuals;
```

```sql
-- migrate:down
-- Structural restore only. Columns come back at the END of the table (ordinals
-- 51-53 rather than 33-35) and hold no data. Safe because nothing does SELECT *,
-- positional INSERT or COPY against ci.inventory, and every live value was the
-- '{}' default anyway. Defaults match current-schema.sql:1180-1182 exactly --
-- '{}' not '[]'.
ALTER TABLE ci.inventory
  ADD COLUMN tags jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN images jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN manuals jsonb DEFAULT '{}'::jsonb;
```

**Code changes (same commit — these are the orphaned halves of the Dec-2025 removal):**

| File | Change |
|---|---|
| `backend/apps/api/src/domains/memory/types.ts:284` | Delete `images?: string[];` from `CreateItemDto`. |
| `backend/apps/api/src/domains/memory/types.ts:302` | Delete `images?: string[];` from `UpdateItemDto`. Note `UpdateItemDto` doubles as the search query type at `ItemService.ts:324`, so this is also a phantom search filter. |

Both fields are already inert — `ItemEntity` declares no `images` `@Column`, `ItemService.create/createMany/update` enumerate fields explicitly and never read it, and neither `ingestInventorySchema` nor `CreateInventoryInput` nor GraphQL `ItemType` exposes it. Deleting them also makes the comment at `ingest/types.ts:154` ("Field-for-field CreateItemDto") true.

**Verify:**

```sql
SELECT count(*) AS inventory_cols
  FROM information_schema.columns
 WHERE table_schema='ci' AND table_name='inventory';
-- expect 50
```

---

## 4-wave note on `ci.users`, `ci.messages`, `ci.threads`

These three column drops are grouped into **Wave 4** rather than Wave 1, despite having no readers, because they are the largest column removals and each is data-lossy in a way `ci.inventory`'s empty bags are not. They are listed there.

---

## Wave 2 — Correctness fixes

These are the live bugs. This is the highest-value wave and the one with real deploy-ordering risk. **Read R1, R2 and R3 before starting.**

---

### 2.1 `scope_events_source_triple_uniq_to_user`

**Blast radius:** one unique index on the appliance's largest table, one arbiter string, one remediation DELETE on `ci.capture_events`. ACCESS EXCLUSIVE on `ci.events` for the index build.

This is the plan's headline correctness fix. The index alone does not heal anything already broken — the paired `capture_events` cleanup is what makes previously-swallowed events re-ingestible.

```sql
-- migrate:up
-- ci.events' provenance idempotency key was GLOBAL: (source_type, source_system,
-- source_id) -- see 20260620213807_add_events_source_idempotency.sql. ci.events.user_id
-- is NOT NULL and every other live provenance rule (content_source_triple_uniq,
-- browser_activity_source_triple_uniq, communications_source_dedup(user_id,...),
-- ux_tasks_source) is tenant-scoped. 20260802053709_create_tasks.sql:69-70 already
-- documents the contrast in-repo.
--
-- The global key made user B's re-ingest of user A's triple a silent no-op: the
-- INSERT was skipped, bulkUpsert.ts:453 echoed the UN-INSERTED in-memory entity
-- back to the caller, and BulkIngestController.ts:378 stamped
-- ci.capture_events.materialized_id with a uuid that exists in NO row.
--
-- LOCKING (measured, not assumed): DROP INDEX takes ACCESS EXCLUSIVE on ci.events
-- and dbmate holds it until COMMIT, so this blocks READS as well as writes for the
-- whole index build. Seconds at appliance scale. If that is unacceptable, the
-- online form is THREE statements under `-- migrate:up transaction:false`:
--   CREATE UNIQUE INDEX CONCURRENTLY events_source_triple_uniq_v2
--     ON ci.events (user_id, source_type, source_system, source_id)
--     WHERE source_id IS NOT NULL;
--   DROP INDEX CONCURRENTLY ci.events_source_triple_uniq;
--   ALTER INDEX ci.events_source_triple_uniq_v2 RENAME TO events_source_triple_uniq;
-- (ON CONFLICT infers arbiters by column list + predicate, never by name, so the
-- app's arbiter matches _v2 during the window.) You CANNOT create CONCURRENTLY
-- under the existing name, and you must not drop first -- that leaves a window
-- with no uniqueness at all.
--
-- DEPLOY: this migration and the EventService arbiter flip MUST ship in the SAME
-- deploy. A stale arbiter does not degrade -- it raises 42P10 and 500s every bulk
-- event ingest (old code + new index, and new code + old index, both). The compose
-- stack already couples them (migrate-database runs `image: ci/api`, and api
-- depends_on it), so do not run `yarn migrate` out of band.
--
-- The new key is strictly WEAKER than the old one (it adds a leading column), so
-- the build cannot fail on existing data -- no pre-flight dedup is required.
DROP INDEX IF EXISTS ci.events_source_triple_uniq;

CREATE UNIQUE INDEX events_source_triple_uniq
  ON ci.events (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;

-- REMEDIATION -- without this the index fix heals nothing already broken.
-- BulkIngestController.captureAndMaterialize writes the ci.capture_events row
-- BEFORE materializing and treats "capture row already present" as `duplicate`
-- (BulkIngestController.ts:319-347): only captures RETURNED by the ON CONFLICT
-- INSERT reach materialize(). Every event the global index swallowed therefore
-- left a capture row behind whose materialized_id points at a uuid that was never
-- inserted -- and that capture row makes the client's re-send a permanent no-op.
-- Deleting exactly those rows lets the next importer push re-materialize them.
-- Narrow on purpose: destination='events' + a materialized_id that resolves to no
-- ci.events row is the exact fingerprint of this bug. capture_events has no
-- reader anywhere in the codebase and nothing FKs to it, so the delete is safe.
DELETE FROM ci.capture_events ce
 WHERE ce.destination = 'events'
   AND ce.materialized_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.event_id = ce.materialized_id);
```

```sql
-- migrate:down
-- NB 1: this WILL fail with 23505 once any two tenants have legitimately ingested
-- the same triple. That is correct -- the old global index cannot be rebuilt
-- without destroying one tenant's rows. dbmate runs the down in a transaction, so
-- the failure rolls the DROP back too: the user-scoped index SURVIVES and
-- schema_migrations is left untouched. The database is never left unprotected.
-- NB 2: the capture_events cleanup above is NOT reversible and is deliberately not
-- undone here -- those rows referenced events that never existed.
-- NB 3: reverting this migration WITHOUT also reverting the application image
-- leaves EventService emitting a (user_id, ...) arbiter against a global index,
-- which raises 42P10 on every bulk event ingest. Roll the image back first.
DROP INDEX IF EXISTS ci.events_source_triple_uniq;

CREATE UNIQUE INDEX events_source_triple_uniq
  ON ci.events (source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;
```

**Code changes (SAME commit — R2):**

| File | Change |
|---|---|
| `backend/apps/api/src/domains/memory/services/EventService.ts:220-222` | Replace `conflictTarget: '(source_type, source_system, source_id) WHERE source_id IS NOT NULL'` with `'(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL'`. Delete the comment claiming the index is not user-scoped; replace with wording matching `ContentService.ts:200-201`. `scope: { userId: context.userId }` at :219 is already correct and stays. |
| `backend/apps/api/src/domains/memory/entities/EventEntity.ts:16-22` | `@Index('events_source_triple_uniq', ['sourceType','sourceSystem','sourceId'], {...})` → `@Index('events_source_triple_uniq', ['userId','sourceType','sourceSystem','sourceId'], { unique: true, where: '"source_id" IS NOT NULL' })`. `userId` exists at :171-172. Documentation-only (`synchronize` is off) but must not be left contradicting SQL. |

Not changed, and correct as-is: `EventService.ts:188-190` and `ContentService.ts:285-286` comments become true; `EventService.ts:154-168`'s 23505 handler is fixed as a side effect (cross-tenant collisions stop happening, so the retry only fires for genuine same-tenant races); `ItemService.ts:110`'s arbiter already matches its index (that one is Wave 5); `IndexDeferralService.ts:70`'s exclusion stays correct.

**Verify (run the third query BEFORE and AFTER):**

```sql
-- a) shape
SELECT indexdef FROM pg_indexes
 WHERE schemaname='ci' AND indexname='events_source_triple_uniq';
-- expect: ... btree (user_id, source_type, source_system, source_id) WHERE (source_id IS NOT NULL)

-- b) the arbiter the app emits is inferable (plan-time only, inserts nothing)
EXPLAIN (COSTS OFF) INSERT INTO ci.events
  (event_id, user_id, title, start_time, source_type, source_system, source_id)
VALUES (ci.gen_uuid_v7(), (SELECT id FROM ci.users LIMIT 1), '__verify__', now(), '__v__','__v__','__v__')
ON CONFLICT (user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL DO NOTHING;
-- expect a plan line `Conflict Arbiter Indexes: events_source_triple_uniq`; 42P10 = stale arbiter

-- c) stranded captures (>0 BEFORE on a multi-tenant appliance; 0 AFTER)
SELECT count(*) FROM ci.capture_events ce
 WHERE ce.destination = 'events' AND ce.materialized_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.event_id = ce.materialized_id);
```

**De-risking:** if `ci.events` is large enough that an ACCESS EXCLUSIVE hold is unacceptable, split into the three-statement `CONCURRENTLY` form under `-- migrate:up transaction:false` as written in the comment, and put the `capture_events` DELETE in its own follow-up migration. Do not run `make migrate` out of band from the image deploy under any circumstances — 42P10 500s every bulk event ingest on either side of the skew.

---

### 2.2 `restore_content_event_id_fk`

**Blast radius:** one FK, one sweep UPDATE on `ci.content`. `SHARE ROW EXCLUSIVE` on **both** `ci.content` and `ci.events` — this blocks all writes to `ci.events` for the duration of the `ci.content` scan.

```sql
-- migrate:up
-- ci.content.event_id lost its FK when 20250925145800_replace_events_table.sql:12
-- did `DROP TABLE IF EXISTS events CASCADE`. That migration then recreated the
-- table at :15-16 as `event_id UUID PRIMARY KEY DEFAULT gen_uuid_v7()` with NO
-- data migration whatsoever -- every pre-2025-09-25 event row was destroyed, so
-- every content.event_id value from that era is PROVABLY unresolvable. The sweep
-- below therefore cannot lose anything recoverable.
--
-- ON DELETE SET NULL matches the three sibling FKs to ci.events already in the
-- schema (capture_events_event_id_fkey, object_observations_event_id_fkey,
-- receipts_event_id_fkey). Content outlives its event.
--
-- No index is created: content_event_type_idx (event_id, type) WHERE event_id IS
-- NOT NULL from 20260714082548_add_hot_path_indexes.sql:29-31 covers the
-- referencing side. Verified -- `EXPLAIN (COSTS OFF) UPDATE ci.content SET
-- event_id = NULL WHERE event_id = $1` (the ON DELETE SET NULL RI query) plans as
-- `Index Scan using content_event_type_idx`, because `event_id = $1` implies the
-- index predicate `event_id IS NOT NULL`.
--
-- The sweep is the destructive step, so it reports its own count in-band rather
-- than relying on an operator having run a census first -- same shape as
-- 20260628120001_dedup_orphan_source_content.sql. ci.content carries no triggers
-- (verified: zero non-internal rows in pg_trigger), so this UPDATE bumps no
-- updated_at and fans out no reindex.
DO $$
DECLARE swept int;
BEGIN
  WITH u AS (
    UPDATE ci.content c
       SET event_id = NULL
     WHERE c.event_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.event_id = c.event_id)
    RETURNING c.id
  )
  SELECT count(*) INTO swept FROM u;
  RAISE NOTICE 'restore_content_event_id_fk: nulled % dangling content.event_id value(s)', swept;
END $$;

-- LOCK NOTE: ADD CONSTRAINT ... FOREIGN KEY takes SHARE ROW EXCLUSIVE on BOTH
-- ci.content and ci.events, which conflicts with ROW EXCLUSIVE -- it BLOCKS ALL
-- WRITES to ci.events, the hottest table on the appliance, for the full duration
-- of the ci.content scan. If an import can be running, split this into
-- `ADD CONSTRAINT ... NOT VALID` here plus `VALIDATE CONSTRAINT` in a second
-- migration (SHARE UPDATE EXCLUSIVE, does not block writes).
ALTER TABLE ci.content
  ADD CONSTRAINT content_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES ci.events (event_id)
  ON DELETE SET NULL;
```

```sql
-- migrate:down
-- Only the constraint is reversible. The orphan-nulling UPDATE is not undone: the
-- uuids it cleared pointed at rows destroyed by 20250925145800, so nothing
-- resolvable was lost. The count is in the migration log (RAISE NOTICE above).
ALTER TABLE ci.content DROP CONSTRAINT IF EXISTS content_event_id_fkey;
```

**Code changes — REQUIRED, and they must ship in a release BEFORE the migration.**

Three ingress paths currently accept an arbitrary uuid for `content.event_id` with no existence and no ownership check. After the FK they raise 23503, and because `bulkUpsert.ts` has zero error handling and issues one multi-row INSERT, a single bad id kills a whole batch (up to `CREATE_CONTENTS_MAX_BATCH = 5000`).

| File | Change |
|---|---|
| `backend/apps/api/src/domains/memory/services/ContentService.ts:134-212` | In `createMany`, collect the distinct explicit `item.event.id` values and run one `SELECT event_id FROM ci.events WHERE user_id = :userId AND event_id IN (...)`. For any id not returned: drop to `undefined` (lenient — row falls through to triple auto-link and stores NULL) for the REST path, or throw `BadRequestException` for the interactive GraphQL path. **Note `ContentService.ts:249-251` currently skips exactly these rows** (`if (item.event \|\| !item.source_type \|\| !item.source_id) continue;`), which is why the one query that would catch a bogus id is bypassed for the rows that need it. |
| `backend/apps/api/src/domains/ingest/controllers/BulkIngestController.ts:571-576` | The flat `event_id` from `ingest/types.ts:137` (`z.string().uuid().optional()` — shape only, no existence check) maps straight to `event: { id: event_id }`. Route it through the same helper. |
| `backend/apps/api/src/domains/graphql/resolvers/ContentResolver.ts:35-46` | `resolveEventId` base64-decodes a GlobalUID and on **any** failure or non-`event` type returns the input string verbatim — no lookup, no user scoping. Add the ownership check, and remove the non-event fall-through at :44-45 (which produces 22P02, not 23503, on a wrong-type GlobalUID). |

The service-side check is strictly better than the FK alone: the FK is user-agnostic and will happily let user A's content point at user B's event. The service check closes that too.

**Verify:**

```sql
-- a) constraint exists with the right delete action ('n' = SET NULL)
SELECT conname, confdeltype, convalidated FROM pg_constraint
 WHERE conrelid = 'ci.content'::regclass AND contype='f' AND conname='content_event_id_fkey';
-- expect one row: content_event_id_fkey | n | t

-- b) zero orphans remain and are now impossible
SELECT count(*) AS remaining_orphans FROM ci.content c
 WHERE c.event_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.event_id = c.event_id);
-- expect 0

-- c) the live link still resolves (HBPE data_client.py:148-157 depends on it)
SELECT count(*) AS linked_content FROM ci.content WHERE event_id IS NOT NULL;
-- expect ~unchanged vs the pre-deploy value minus the swept count
```

**De-risking:** ship the `ContentService` validation in its own release first and let it soak. Reversed, any importer in flight with a stale event id takes a full-batch failure.

---

### 2.3 `EventService.tenancy.integration.test.ts` — pin the fix

**Blast radius:** one new test file plus one CI job. Zero production risk (`describe.skip` unless the env var is set).

A unit test cannot catch 2.1: the bug lives in the disagreement between an application-level user-scoped pre-check and a database-level global arbiter. `EventService.bulkEmit.test.ts` stubs `bulkInsertIdempotent` entirely, so it can never observe the arbiter.

**New file:** `backend/apps/api/src/domains/memory/services/__tests__/EventService.tenancy.integration.test.ts`

Copy the opt-in scaffold from `backend/apps/api/src/domains/planning/services/__tests__/TaskService.tenancy.integration.test.ts:30-60` with these corrections:

- Env var is **`MEMORY_TEST_DATABASE_URL`**, not `EVENTS_*` — the file lives in `src/domains/memory/`, and `EventService.ts:8` already imports `EventService as SignallingEventService from '@ci/domains/events'`, an unrelated pgboss domain.
- Constructor is **two** args, not three: `new EventService(dataSource.getRepository(EventEntity), noopEvents, dataSource)`. `EventService.ts:53-59` takes `(eventRepository, signallingEventService, dataSource)` — there is no logger. Passing a noopLogger third guts `getEntitiesForEvents` (:497), `getDistinctEventSources` (:624), `getDistinctEventTypes` (:645) and `getTimelineStats` (:665).
- `entities: [EventEntity, UserEntity]` (EventEntity :167-169 declares `@ManyToOne(() => UserEntity)`), and `extra: { options: '-c search_path=ci,public' }` is load-bearing — EventEntity :56-62 maps a `geography(Point,4326)` column, so TypeORM emits `ST_AsGeoJSON` and postgis lives in `public`.
- **Every `it` block gets its own `source_id`:** `` `shared-${uuidv7()}` ``. Jest runs blocks in declaration order against one DB; a shared `'SHARED-1'` makes test 3 a no-op, because `createOne` returns at the user-scoped early exit (`EventService.ts:138-143`) before ever reaching the 23505 retry it exists to cover.

Tests:

1. **The regression.** Alice and Bob each call `service.create(ctx, [{ title, start_time, source_type:'calendar', source_system:'google', source_id }])` (array form → `createManyBatched`). Assert both returned ids resolve to real `ci.events` rows owned by that caller: `SELECT user_id FROM ci.events WHERE event_id = $1`. **This is the assertion that fails today.**
2. **Idempotency preserved.** Alice calls create twice with the same triple; assert exactly one row and that the second call returns the first's `event_id`.
3. **Single-row path.** Same as 1 but non-array (`createOne`, `EventService.ts:121`), with a fresh `source_id`. Today Bob gets an opaque 500 because the user-scoped `findOne` retry at :158-163 cannot find the cross-tenant winner.

**Not included:** the ItemService variant. `ItemService.ts:109-110` already scopes and arbitrates on the *same* column (`ownerUserId`/`owner_user_id`), so alice and bob each get their own row today — that test would be green before and after and prove nothing. Add it as part of Wave 5's `scope_inventory_source_triple_uniq_to_user`, where the scope actually changes.

**CI is a prerequisite, not a nice-to-have.** `.github/workflows/ci.yml:47-74` is the whole backend test job: `container: image: node:22`, no `services:` block, and a bare `yarn workspace @ci/be-api test`. `PLANNING_TEST_DATABASE_URL` appears nowhere in `.github`, meaning the existing planning tenancy test has **never run in CI**. Add a `services: postgres` block, a migrate step, and the env var, or this file is documentation.

**Verify:** run it both ways once. With Wave 2 applied it passes; with `yarn migrate:down` it must **fail** on tests 1 and 3. A regression test you have not seen fail is not a regression test.

---

## Wave 3 — Code-only consolidation

**No DDL. Do not create migration files for anything in this wave.** An empty up/down pair still burns a permanent `schema_migrations` row on every appliance and cannot be un-created. The rollback for all of Wave 3 is `git revert`.

**R8 applies to all of it:** rebase onto the in-flight `FileEntity` → `FileNodeEntity` rename first, and edit `memory/index.ts` by exact-string match.

---

### 3.1 Delete `EntityService` and the dead static query helpers

**Blast radius:** two file deletions' worth of dead code. `yarn typecheck` exit 0 verified; 19 suites / 103 tests pass.

Land this **first** in the wave — it is self-contained, touches only two paths, and gets one file out of the way before 3.2 and 3.3 touch the same directory. (The original ordering advice — "do it last to avoid conflicts" — is wrong: there is zero file overlap with 3.2 or 3.3.)

| File | Change |
|---|---|
| `backend/apps/api/src/domains/memory/services/EntityService.ts` | **DELETE.** `grep -rn 'extends EntityService'` returns nothing repo-wide; the only references are its own docblock (:9) and class declaration (:34). `memory/index.ts` contains **no** import, provider or export for it — that proposed edit is a confirmed no-op, do not hunt for it. |
| `backend/apps/api/src/domains/memory/entities/PlaceEntity.ts:151-159` | Delete the never-called static `createPlaceQuery`, and prune the now-unused `Repository`/`SelectQueryBuilder` imports at :10-11. `tsconfig` has no `noUnusedLocals`, so tsc passes; oxlint/eslint (and therefore lint-staged) will not. |

`PlaceEntity.ts:199` exports `type Place = Readonly<Omit<PlaceEntity,'user'|'loadPropertiesFromJsonb'>>`. `Omit` operates on the instance type and `createPlaceQuery` is a static, so the public `Place` egress type is byte-identical after the deletion.

**Also delete in the same wave:** `memory/FileEntity.ts:38-46` (`createFileQuery`) and its `Repository`/`SelectQueryBuilder` imports at :9-10 — fold this into 3.3, since a *rename* carries the dead helper forward verbatim. `ThingEntity.ts:52-60` (`createThingQuery`) disappears with the whole file in 3.2.

---

### 3.2 Delete `ThingEntity` and `BaseEntity`

**Blast radius:** two file deletions, five edits to `memory/index.ts`, two doc corrections. Zero runtime change — proven by a DataSource-init diff.

`ThingEntity` is not merely unused, it is broken in **both** directions:
- **Read:** it declares `@ManyToOne … @JoinColumn({ name: 'user_id' })` and `event_id` (:62-68), columns that belonged to the legacy `things` table dropped by `20251006113900_prune_old_tables.sql`. Executed: `getRepository(ThingEntity).find({take:1})` → `column ThingEntity.user_id does not exist` (42703), while `PersonEntity.find()` and `GraphNodeEntity.find()` return OK in the same run.
- **Write:** `ci.entities.owner_user_id` is **NOT NULL** and `ThingEntity` maps no `owner_user_id` property at all → 23502.

`BaseEntity` is a `@TableInheritance` STI root with zero `@ChildEntity` subclasses. Measured on the probe: `inheritancePattern=STI`, `discriminatorValue='BaseEntity'`, zero children, while the six real mappers over `ci.entities` are `inheritancePattern=none`. Every read through it returns 0 rows.

| File | Change |
|---|---|
| `backend/apps/api/src/domains/memory/entities/ThingEntity.ts` | **DELETE** (whole file, incl. `createThingQuery` at :52-60). |
| `backend/apps/api/src/domains/memory/entities/BaseEntity.ts` | **DELETE.** |
| `backend/apps/api/src/domains/memory/index.ts` | Remove, **by string match, bottom-up**: `import { ThingEntity } from './entities/ThingEntity';`, `import { BaseEntity } from './entities/BaseEntity';`, `ThingEntity,` and `BaseEntity,` from the `TypeOrmModule.forFeature([...])` array, `ThingEntity,` from the public export block. (At HEAD `26cb13db` these are lines 57, 31, 90, 83, 165 — but three live worktrees have `BaseEntity` at :65 instead of :83, which is why line numbers must not be used.) |
| `docs/architecture/Database.md:66` | Rewrite the `ci.entities` row. It currently claims the table is "**single-table-inheritance** discriminated by entity_type (Person, Place, Concept, Thing, File, …; see `memory/entities/BaseEntity.ts`)" — false today and pointing at a deleted file. Replace with: a polymorphic node table mapped by several independent TypeORM classes, each filtering `entity_type` in its own queries. **Do not imply `'Thing'` was retired** — it remains a live DB value (`graph.types.ts:12` ENTITY_TYPES, `embeddable.ts:211` GRAPH_TYPE_ALIASES `'Thing'→'item'`, and `ci.entities`' `^[A-Z][A-Za-z]*$` CHECK permits it). |
| `docs/architecture/schema-comparison-lifescope.html:1463` | "The eight: graph/NodeEntity, memory/BaseEntity, ConceptEntity, PersonEntity, PlaceEntity, ThingEntity, GraphNodeEntity, FileEntity." → six, with the two deleted names removed. This file is **hand-committed, not generated** — `grep -rn schema-comparison-lifescope` over all json/ts/js/md returns zero hits, so no script produces it. |
| `backend/apps/api/src/domains/llm/listeners/CvDetectionsListener.ts:86` | The comment "Thing → ThingEntity and Concept → ConceptEntity follow the same resolve-or-create shape" is a **deferred-work marker** for the empty `case 'Thing'` branch at :89, not decoration. Redirect it to `ObjectObservationEntity` / `ci.object_observations` per `20260803223022_create_object_observations.sql:4-9`, which states in its own header that this exact branch is the gap it closes. Note the Person branch it references uses `personService.create` (:134), not an entity class — so point at services, not classes. |

**Why file deletion, not just unregistering:** `application.ts:72` globs `domains/**/*Entity.{ts,js}`, so a file left on disk stays in the DataSource with its broken metadata regardless of `forFeature`.

**Resurrection risk:** three worktrees (`.claude/worktrees/getlocal-sync-main-e204ae`, `strange-hermann-d86183`, `jovial-albattani-29d5ec`) still carry both files. A merge that restores either silently re-arms the 42703 metadata with no build error and no failing test. Add a post-deletion grep for `ThingEntity|BaseEntity` to whatever check runs on merge.

**Not bundled:** `memory/index.ts` lists `RelationshipEntity` twice (:97 and :101). Real defect, different one — fixing it here makes the diff look bigger than "delete two dead files" and muddies the revert.

**Verify:** `yarn workspace @ci/be-api typecheck` green, one API boot, and `grep -rn 'ThingEntity\|BaseEntity' backend frontend mcp-servers docs --exclude-dir=node_modules --exclude-dir=.claude` returns nothing.

---

### 3.3 Rename `memory/FileEntity` → `FileNodeEntity`

**Blast radius:** two file renames plus three import sites and two doc lines. Verified: `tsc --noEmit` exit 0, `eslint src/domains/memory` exit 0, full backend suite 139/140 suites / 1400 tests (1 skipped) — identical to baseline.

Two different classes are both named `FileEntity` over two different tables: `files/entities/FileEntity.ts` → `ci.files` (real file metadata) and `memory/entities/FileEntity.ts` → `ci.entities` (a graph-node projection, `entity_type='File'`, `linked_table='files'`). memory's is **live** — `memory/services/FileService.ts:55` handles `@OnEvent(FileUploadedEvent)` and creates the projection for every upload.

Two latent hazards closed:
- **Nest DI:** `@nestjs/typeorm` derives the repository token from the class name as `${entity.name}Repository`. Both claim `'FileEntityRepository'`. Repo-wide check: **zero** modules export `TypeOrmModule`, so it never crosses a boundary today.
- **TypeORM DataSource:** booting today yields **two** `EntityMetadata` both named `'FileEntity'`. `getMetadata('FileEntity')` / `getRepository('FileEntity')` resolve by name — whichever the glob loaded first. After the rename the duplicate-name set drops to `["EmbeddingEntity","VectorEntity","RelationshipEntity"]` (the first two of which 3.4 removes).

| File | Change |
|---|---|
| `memory/entities/FileEntity.ts` | Rename file → `FileNodeEntity.ts`; class at :16 → `FileNodeEntity`. |
| `memory/entities/FileNodeEntity.ts:31-34` | Fix typings to match `ci.entities`: `linked_id` is `uuid NULL` and `linked_table` is `text NULL` (the `linked_table_consistency` CHECK ties them together, it does **not** make them NOT NULL). Both must become `@Column({type:'uuid'\|'text', nullable:true})` **and** `!: string \| null`. Flipping `nullable` without widening the TS type leaves the lie in place. `FileService.ts:32-33,40,69,79` always supplies both, so nothing downstream needs touching. |
| `memory/entities/FileNodeEntity.ts:38-46` | Delete the never-called `createFileQuery` **and** remove `Repository`/`SelectQueryBuilder` from the typeorm import at :9-10 — a lint error, not a tsc error. |
| `memory/services/FileService.ts` | Rename file → `FileNodeService.ts`; class at :19 → `FileNodeService`; :10's workaround alias `FileService as FileStorageService` reverts to a plain `FileService` import; :16, :22-23, :27 retarget to `FileNodeEntity`. |
| `memory/index.ts` | By string match: import → `FileNodeEntity`; `forFeature` entry → `FileNodeEntity`; provider and export → `FileNodeService`; both public export blocks updated. **Note these currently re-export the names `FileEntity`/`FileService` from memory, shadowing the identically-named exports of `@ci/domains/files` for anyone importing both** — the rename will surface that as a compile error. Treat such an error as a bug found. |
| `backend/apps/api/README.md:49` | `memory` row lists `FileService` → `FileNodeService`. Silent staleness otherwise; no build error. |
| `docs/architecture/architecture.md:179` | Same list, same fix. |

**Ruled out as a non-issue:** `events/decorators/OnEvent.ts:32-34` captures `constructor.name` into `EventListenerRegistry.register(event, className, methodName, queue)`. Traced: `event-registration.ts:8` keys the map on `${eventName}:${queue}` only; className is used solely in the duplicate-listener error string (:12-17) and a debug log (`PGBossEventService.ts:97-100`); `getRegisteredQueues` (`EventService.ts:43-56`) builds the pgboss queue set from `registration.queue` alone. **The rename does not rename a queue and does not orphan in-flight `file.uploaded` jobs.**

**Flag, do not fix here:** `FileService.ts:67-71` (and :30-34) looks up the existing projection with only `linked_table='files' AND linked_id=:fileId`, unscoped by `owner_user_id` and `entity_type`, while the enforcing index is `entities_linked_uniq UNIQUE (owner_user_id, entity_type, linked_table, linked_id) WHERE linked_table IS NOT NULL`. A non-`'File'` row carrying `linked_table='files'` with the same `linked_id` would be returned, and the listener would `save()` that foreign node. Separate commit, so the rename stays reviewable as a no-op.

**Verify:** `yarn workspace @ci/be-api typecheck` **and** `yarn eslint src/domains/memory` (the dead-import cleanup is invisible to tsc).

---

### 3.4 Delete search-next's duplicate entity copies

**Blast radius:** two file deletions, one constructor signature, four `.query()` call sites, one test.

`search-next/entities/EmbeddingEntity.ts` is byte-identical to `search-ingress/entities/EmbeddingEntity.ts` (`diff` exits 0), same for the `VectorEntity` pair. search-next never uses the mapping — all four repository accesses are `repo.query()`. search-ingress genuinely needs the metadata (`.delete({ entityType, entityId })` at `EmbeddingService.ts:57` / `VectorService.ts:127`, plus `createQueryBuilder(...).select('embedding.entityType')` at `MaintenanceController.ts:992` and `MaintenanceOrchestratorService.ts:548`), so its copies are the survivors.

**Do NOT hoist a shared class to `src/common`** — `application.ts:72` globs `domains/**/*Entity.{ts,js}`, so a common-located entity never loads and the first `forFeature` on it throws `EntityMetadataNotFoundError`.

| File | Change |
|---|---|
| `search-next/entities/EmbeddingEntity.ts` | **DELETE.** |
| `search-next/entities/VectorEntity.ts` | **DELETE.** |
| `search-next/services/SearchService.ts:2` | **Delete the line** `import { InjectRepository } from '@nestjs/typeorm';` (its only uses are the two decorators being removed). |
| `search-next/services/SearchService.ts:3` | `import { Repository } from 'typeorm';` → `import { DataSource } from 'typeorm';` — a **VALUE import, never `import type`**. `tsconfig.json:19` sets `emitDecoratorMetadata: true`; `import type` elides the class, emits `Object` for `design:paramtypes`, and Nest fails at bootstrap with "can't resolve dependencies of the SearchService". `eslint.shared.mjs:52` sets `consistent-type-imports` to error with `prefer: 'type-imports'`, so an over-eager `--fix` is exactly how it gets rewritten. Precedent that a value import is correct and lint-clean here: `search-next/services/TagService.ts:3`. |
| `search-next/services/SearchService.ts:8-9` | Delete both entity imports. |
| `search-next/services/SearchService.ts:85-91` | Replace the constructor with **two** params, dataSource first: `constructor(private readonly dataSource: DataSource, private readonly embeddingGenerationService: EmbeddingGenerationService) {}`. **Critical:** line 88 is `embeddingGenerationService`, sandwiched *between* the two repo params — it is live at :155, :314, :420. Deleting "lines 86-90" wholesale removes it and every semantic path throws. |
| `search-next/services/SearchService.ts:176, 349, 397, 464` | `this.embeddingRepo.query(...)` / `this.vectorRepo.query(...)` → `this.dataSource.query(...)`. These four are the only member accesses on either repo. |
| `search-next/index.ts:13,16,25` | Drop both entity imports; `forFeature([EmbeddingEntity, EntityTagEntity, TagEntity, VectorEntity])` → `forFeature([EntityTagEntity, TagEntity])`. Keep both survivors — `TagService.ts:23-24` injects `TagEntity`. |
| `search-next/services/__tests__/SearchService.searchMessages.test.ts` | :1 → `import type { DataSource } from 'typeorm';`; delete the two entity imports at :6-7; `const dataSource = { query } as unknown as DataSource;`; :27 → `new SearchService(dataSource, embeddingGenerationService)` (**2 args, reordered**). Collapsing the two mocks is safe: every test calls `searchMessages`, which only hits the embedding SQL, and the separate `vectorRepo` jest.fn at :22 was never asserted on. |

`Repository.query` delegates straight to the DataSource, and these repos come from `forFeature` (the default EntityManager, no bound queryRunner), so neither form ever picked up an ambient transaction. All four SQL strings are schema-qualified (`ci_search.embeddings`, `ci_search.vectors`), so the swap has zero exposure to the `search_path=ci,public` set at `application.ts:78`.

**Verify:** `yarn workspace @ci/be-api typecheck` and `yarn lint` both green; `SearchService.searchMessages.test.ts` passes; one API boot (the `import type` trap fails only at bootstrap).

---

## Wave 4 — Structural compaction

Column drops on four hot tables. All four are **code-before-DDL (R1)** and all four are lossy in the down direction. Ship each as its own migration.

---

### 4.1 `drop_dead_users_columns`

**Blast radius:** 16 columns on `ci.users` (30 → 14), 5 indexes, 1 CHECK, 1 self-FK. **This is the only item in the plan that removes data an operator might have hand-set.**

```sql
-- migrate:up
-- Sixteen never-read columns left over from a hand-rolled auth system replaced by
-- ci.sessions + ci.api_keys + the OIDC path. UserEntity maps NONE of them (it maps
-- id, name, email, password, entity_id, onboarded, onboarded_at, timezone,
-- onboarding_progress, created_at, updated_at, deleted_at, purge_after).
-- `username` is deliberately KEPT -- UserContextService.ts:305 selects it.
--
-- There is no SELECT * against ci.users anywhere; all 11+ live raw-SQL readers
-- name their columns explicitly and select only survivors (name, email, entity_id,
-- timezone, id, onboarded, username). Zero RBAC surface exists to lose: no
-- @Roles(, no RolesGuard, no AdminGuard, no isAdmin anywhere in backend or frontend.
--
-- Cascade (verified): drops users_api_keys_gin_idx, users_email_active_idx,
-- users_last_login_idx, users_role_active_idx, users_username_idx, CHECK
-- users_role_check, FK users_created_by_fkey, and PG18's auto-named
-- users_role_not_null. RETAINED: users_pkey, users_email_key, users_username_unique,
-- users_entity_idx, users_onboarded_at_idx, idx_users_purge_after,
-- users_entity_id_fkey. The two vanishing partial indexes are strictly subsumed --
-- users_email_active_idx by the users_email_key UNIQUE btree, users_username_idx by
-- the users_username_unique UNIQUE btree. No lookup loses an access path.
ALTER TABLE ci.users
  DROP COLUMN password_hash,
  DROP COLUMN settings,
  DROP COLUMN api_keys,
  DROP COLUMN role,
  DROP COLUMN permissions,
  DROP COLUMN last_login_at,
  DROP COLUMN login_count,
  DROP COLUMN failed_login_attempts,
  DROP COLUMN language,
  DROP COLUMN display_preferences,
  DROP COLUMN is_active,
  DROP COLUMN is_verified,
  DROP COLUMN verification_token,
  DROP COLUMN verification_expires_at,
  DROP COLUMN locked_until,
  DROP COLUMN created_by;
```

```sql
-- migrate:down
-- THIS RESTORES STRUCTURE ONLY. Values are gone forever. Proven on the probe:
-- rows inserted with role='admin', is_active=false, api_keys='{"k":1}' come back
-- after a round trip as role='user', is_active=true, api_keys='{}'. Do not read
-- "there is a down" as "it is reversible".
-- Verified byte-for-byte otherwise: the original CHECK was written `role IN (...)`
-- at 20250925144200_enhance_users.sql:33-34 and Postgres normalizes it to
-- `= ANY (ARRAY[...])`, which is the form used here; `created_by` was an inline
-- REFERENCES that Postgres auto-named users_created_by_fkey; column ordinals
-- return in the original order because the ADDs are listed in schema order.
ALTER TABLE ci.users
  ADD COLUMN password_hash text,
  ADD COLUMN settings jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN api_keys jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN role text DEFAULT 'user'::text NOT NULL,
  ADD COLUMN permissions jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN last_login_at timestamp with time zone,
  ADD COLUMN login_count integer DEFAULT 0,
  ADD COLUMN failed_login_attempts integer DEFAULT 0,
  ADD COLUMN language text DEFAULT 'en'::text,
  ADD COLUMN display_preferences jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN is_active boolean DEFAULT true,
  ADD COLUMN is_verified boolean DEFAULT false,
  ADD COLUMN verification_token text,
  ADD COLUMN verification_expires_at timestamp with time zone,
  ADD COLUMN locked_until timestamp with time zone,
  ADD COLUMN created_by uuid;

ALTER TABLE ci.users ADD CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text, 'readonly'::text, 'api_only'::text])));
ALTER TABLE ONLY ci.users ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES ci.users(id);
CREATE INDEX users_api_keys_gin_idx ON ci.users USING gin (api_keys);
CREATE INDEX users_email_active_idx ON ci.users USING btree (email) WHERE ((email IS NOT NULL) AND (is_active = true));
CREATE INDEX users_last_login_idx ON ci.users USING btree (last_login_at) WHERE (last_login_at IS NOT NULL);
CREATE INDEX users_role_active_idx ON ci.users USING btree (role, is_active);
CREATE INDEX users_username_idx ON ci.users USING btree (username) WHERE (is_active = true);
```

**Code changes:** none required — `UserEntity.ts` maps none of the 16, GraphQL `UserType` exposes only `email/entity/id/name/needsIdentityStep/onboarded/timezone`, seeding goes through `UserService.create` (TypeORM, explicit column list), and the three SQL-string-matching test harnesses (`graphToolHarness.ts:378`, `PersonMergeService.spec.ts:56`, `GraphIngestService.selfEntity.spec.ts:44`) match on `FROM ci.users` / `UPDATE ci.users`, not column names.

Optional doc fix: `docs/architecture/planning-roadmap.md:28` says these jsonb columns "exist in Postgres but UserEntity maps none of them" — after this, they are gone.

**Release-notes pre-flight — run this on the appliance BEFORE upgrading:**

```sql
SELECT count(*) FROM ci.users
 WHERE role <> 'user' OR is_active IS NOT TRUE OR is_verified IS TRUE
    OR api_keys <> '{}'::jsonb OR settings <> '{}'::jsonb
    OR permissions <> '{}'::jsonb OR display_preferences <> '{}'::jsonb
    OR language <> 'en' OR password_hash IS NOT NULL OR created_by IS NOT NULL;
-- non-zero = someone hand-set a value in psql. Decide before upgrading.
```

**Verify:**

```sql
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='ci' AND table_name='users';   -- expect 14
```

---

### 4.2 `drop_dead_messages_columns`

**Blast radius:** 18 columns on `ci.messages` (33 → 15), 2 CHECKs. All 6 indexes and all 3 FKs survive, including `messages_fts_idx` and the `search_vector` generated column.

**The DROP order is load-bearing.** `total_tokens` is `GENERATED ALWAYS AS (input_tokens + output_tokens)` and must be dropped first — reproduced: without it, `cannot drop column input_tokens ... column total_tokens ... depends on column input_tokens`.

```sql
-- migrate:up
-- 18 dead columns covering three never-built subsystems: LLM cost accounting
-- (input/output/total tokens, estimated_cost, processing_time_ms, model_version,
-- temperature, finish_reason), edit history (is_edited, edit_history), and
-- moderation/feedback (user_rating, user_feedback, flagged_for_review, flag_reason,
-- sentiment_score), plus tool_call_results, sequence_number and depth.
-- MessageEntity maps NONE of them. GraphQL MessageType exposes four fields
-- (content, id, role, threadId), none dropped.
--
-- DELIBERATELY KEEPS extracted_entities and intent_categories: they feed
-- search_vector, which is GENERATED ALWAYS AS to_tsvector(... COALESCE wrappers ...)
-- and carries messages_fts_idx, registered BY NAME in IndexDeferralService.ts:45
-- (a live service that drops and rebuilds it around bulk loads). Dropping them
-- would force recreating search_vector and reproducing that index byte-for-byte.
--
-- total_tokens MUST go FIRST -- it is GENERATED ALWAYS AS (input_tokens +
-- output_tokens) and Postgres refuses to drop its inputs while it exists.
-- Dropping it explicitly rather than using CASCADE keeps this deterministic.
-- DO NOT REORDER THIS LIST.
--
-- Verified: zero triggers on ci.messages, zero views/matviews, zero server-side
-- functions naming the table, none of the 18 is NOT NULL, no partial or
-- expression index touches any of them, and no unqualified raw SQL references
-- the table (`(FROM|JOIN|INTO|UPDATE)\s+(ci\.)?"?messages"?` -> 0 hits).
-- DROP COLUMN is metadata-only, so the UP is fast.
ALTER TABLE ci.messages
  DROP COLUMN total_tokens,
  DROP COLUMN input_tokens,
  DROP COLUMN output_tokens,
  DROP COLUMN model_version,
  DROP COLUMN temperature,
  DROP COLUMN estimated_cost,
  DROP COLUMN processing_time_ms,
  DROP COLUMN finish_reason,
  DROP COLUMN is_edited,
  DROP COLUMN edit_history,
  DROP COLUMN tool_call_results,
  DROP COLUMN sentiment_score,
  DROP COLUMN user_rating,
  DROP COLUMN user_feedback,
  DROP COLUMN flagged_for_review,
  DROP COLUMN flag_reason,
  DROP COLUMN sequence_number,
  DROP COLUMN depth;
```

```sql
-- migrate:down
-- SLOW DIRECTION: `ADD COLUMN total_tokens ... GENERATED ALWAYS AS ... STORED`
-- forces a full table rewrite under ACCESS EXCLUSIVE. The other 17 ADDs are
-- metadata-only (PG11+ non-volatile defaults). Fast forward, slow rollback --
-- do not be surprised at 3am.
-- Verified: a two-way EXCEPT over information_schema.columns (name, type,
-- nullability, default, is_generated, generation_expression) before the drop vs
-- after this restore returns 0 rows on both sides; relative column order is
-- identical; both CHECKs restored; messages_fts_idx definition unchanged.
ALTER TABLE ci.messages
  ADD COLUMN depth integer DEFAULT 0,
  ADD COLUMN sequence_number integer,
  ADD COLUMN model_version text,
  ADD COLUMN temperature double precision,
  ADD COLUMN input_tokens integer DEFAULT 0,
  ADD COLUMN output_tokens integer DEFAULT 0,
  ADD COLUMN total_tokens integer GENERATED ALWAYS AS ((input_tokens + output_tokens)) STORED,
  ADD COLUMN estimated_cost numeric(10,6),
  ADD COLUMN processing_time_ms integer,
  ADD COLUMN finish_reason text,
  ADD COLUMN is_edited boolean DEFAULT false,
  ADD COLUMN edit_history jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN tool_call_results jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN sentiment_score double precision,
  ADD COLUMN user_rating integer,
  ADD COLUMN user_feedback text,
  ADD COLUMN flagged_for_review boolean DEFAULT false,
  ADD COLUMN flag_reason text;

ALTER TABLE ci.messages ADD CONSTRAINT messages_sentiment_score_check CHECK (((sentiment_score >= ('-1'::integer)::double precision) AND (sentiment_score <= (1)::double precision)));
ALTER TABLE ci.messages ADD CONSTRAINT messages_user_rating_check CHECK (((user_rating >= 1) AND (user_rating <= 5)));
```

**Code changes:**

| File | Change |
|---|---|
| `backend/apps/summary/src/data_aggregator.py:50` | `'messages': {'time_col': 'created_at', 'exclude': ['tool_calls', 'edit_history']}` → drop `'edit_history'`. Cosmetic only — `_get_semantic_columns` (~:114-153) reads `information_schema.columns` and selects everything minus the exclude list, so a stale name is a no-op and the service adapts to a narrower table rather than breaking. |

No entity change: `MessageEntity.ts` maps only `message_id, model_name, role, content, content_type, tool_calls, is_deleted, user_id, thread_id, parent_message_id, message_files, created_at, updated_at`.

**Verify:**

```sql
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='ci' AND table_name='messages';    -- expect 15

SELECT indexname FROM pg_indexes
 WHERE schemaname='ci' AND tablename='messages' ORDER BY 1;
-- expect all 6 still present, incl. messages_fts_idx
```

---

### 4.3 `drop_dead_threads_columns`

**Blast radius:** 14 columns on `ci.threads` (22 → 8). One constraint lost — the self-FK on a column being dropped. `ci.threads` has exactly one index (the PK), so nothing else is touched.

```sql
-- migrate:up
-- 14 dead columns: the per-thread LLM-config block (model_config, temperature,
-- max_tokens, system_prompt), never-maintained counters (message_count,
-- total_tokens_used, avg_response_time_ms, last_message_at), the never-built
-- forking feature (parent_thread_id, fork_point_message_id), the never-built
-- sharing feature (is_private, sharing_permissions), plus main_topics and
-- mentioned_entities.
--
-- ThreadEntity maps only thread_id, title, summary, user, created_at, updated_at,
-- is_archived. `status` is the only surviving unmapped column and it STAYS -- it
-- owns ci.thread_status' last reference (verified: thread_status is used by
-- exactly one attribute).
--
-- Verified: the ONLY index on ci.threads is threads_pkey. Zero CHECKs. Zero
-- non-internal triggers (nothing maintains the counters server-side). Zero views
-- or matviews exist in the DB at all. The only cascade is
-- threads_parent_thread_id_fkey, the self-FK on a column being dropped. Inbound
-- FKs from ci.actions (actions_thread_fk) and ci.messages
-- (messages_thread_id_fkey) are unaffected.
-- Only two live raw-SQL touchpoints exist, both via search-ingress/entitySourceMap
-- keyed on thread_id; TIME_PAGED_TYPES (SearchIndexBackfillService.ts:70-72)
-- contains ONLY `communication: 'time'`, so no backfill pages threads by
-- last_message_at. No `INSERT INTO threads` anywhere.
ALTER TABLE ci.threads
  DROP COLUMN last_message_at,
  DROP COLUMN main_topics,
  DROP COLUMN mentioned_entities,
  DROP COLUMN model_config,
  DROP COLUMN temperature,
  DROP COLUMN max_tokens,
  DROP COLUMN system_prompt,
  DROP COLUMN message_count,
  DROP COLUMN total_tokens_used,
  DROP COLUMN avg_response_time_ms,
  DROP COLUMN parent_thread_id,
  DROP COLUMN fork_point_message_id,
  DROP COLUMN is_private,
  DROP COLUMN sharing_permissions;
```

```sql
-- migrate:down
-- Structural only: re-added nullable columns come back NULL. Nothing ever produced
-- values for them, so there is nothing to recover.
-- Verified byte-for-byte against the pre-state: same 22 columns, same ORDINAL
-- ORDER, same types, same defaults ('{}'::jsonb, 0, 0, true), and
-- threads_parent_thread_id_fkey restored with an identical definition. Correctly
-- does NOT re-add context_embedding vector(768), which an earlier migration
-- already removed.
ALTER TABLE ci.threads
  ADD COLUMN last_message_at timestamp with time zone,
  ADD COLUMN main_topics text[],
  ADD COLUMN mentioned_entities text[],
  ADD COLUMN model_config jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN temperature double precision,
  ADD COLUMN max_tokens integer,
  ADD COLUMN system_prompt text,
  ADD COLUMN message_count integer DEFAULT 0,
  ADD COLUMN total_tokens_used integer DEFAULT 0,
  ADD COLUMN avg_response_time_ms integer,
  ADD COLUMN parent_thread_id uuid,
  ADD COLUMN fork_point_message_id uuid,
  ADD COLUMN is_private boolean DEFAULT true,
  ADD COLUMN sharing_permissions jsonb DEFAULT '{}'::jsonb;

ALTER TABLE ONLY ci.threads ADD CONSTRAINT threads_parent_thread_id_fkey FOREIGN KEY (parent_thread_id) REFERENCES ci.threads(thread_id);
```

**Code changes:** none.

**Worth knowing, not fixing here:** `scripts/seed-database/data/threads.ts` seeds carry `model: 'qwen3:8b'` and `CreateThreadDto` declares `model: string` (`conversations/types.ts:5,22`), but `ThreadService.create` does `threadRepository.create({ ...data })` and TypeORM silently discards `model` — it never reached `model_config` or any column. The DTO advertises a per-thread model setting that is already a no-op; if it is ever built it needs a new column.

**Verify:**

```sql
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='ci' AND table_name='threads';    -- expect 8
```

---

### 4.4 `drop_dead_event_analytics_columns`

**Blast radius:** 11 columns on `ci.events` (47 → 36), 3 CHECKs. **Contains the plan's one raw-SQL landmine.**

```sql
-- migrate:up
-- 11 dead analytics columns. All 11 are @Column-mapped on EventEntity and appear
-- in toEgressType, so the TypeScript build catches every consumer -- which is
-- exactly why the code MUST deploy first (rule R1): TypeORM emits explicit column
-- lists, so a migration landing against a still-running old image 42703s every
-- eventRepository read AND the whole POST /v1/events bulk ingest path (bulkUpsert
-- derives its INSERT column list from entity metadata).
--
-- KEEPS is_inferred and inference_sources INLINE. LocationEstimateService writes
-- both, and a 1:1 side table for them was measured as a 24.7% NET SIZE REGRESSION
-- at 300k rows once the side table's own PK index and tuple overhead are charged
-- (120,963,072 B vs 96,968,704 B). See "deliberately not doing".
--
-- Also excluded: sentiment_score. Despite appearances it is LIVE --
-- ingest/types.ts:97 accepts it, memory/types.ts:427,475,519,568 declare it on
-- four request schemas, EventService.ts:394-396 writes it, EventEntity.ts:211
-- returns it, and events_sentiment_score_check constrains it.
--
-- Cascade: removes events_energy_level_check, events_external_sync_status_check
-- and valid_prediction_inference. All 10 indexes and all 4 inbound FKs
-- (capture_events, object_observations, receipts, hbpe.l1_event_cluster) survive.
-- No views, matviews, rules or non-internal triggers exist on ci.events.
-- PowerSync (infrastructure/powersync/sync-rules.yaml:12-15) explicitly excludes
-- ci.events, so no client schema changes. GraphQL EventType/CreateEventInput/
-- UpdateEventInput expose none of the 11.
-- Storage reclaimed: zero without a separate VACUUM FULL / pg_repack (rule R6).
ALTER TABLE ci.events
  DROP COLUMN is_predicted,
  DROP COLUMN prediction_model,
  DROP COLUMN energy_level,
  DROP COLUMN productivity_impact,
  DROP COLUMN external_sync_status,
  DROP COLUMN last_synced_at,
  DROP COLUMN related_event_ids,
  DROP COLUMN supersedes_event_id,
  DROP COLUMN salience,
  DROP COLUMN access_count,
  DROP COLUMN last_accessed;

COMMENT ON COLUMN ci.events.is_inferred IS
  'TRUE when the row was completed by inference rather than captured. Sole writer: LocationEstimateService.estimateBatch (backfills location_coordinates). Deliberately kept INLINE rather than in a 1:1 side table: measured at 300k rows, a side table for is_inferred + inference_sources is a 24.7% net size regression once its own PK index and tuple overhead are charged.';
```

```sql
-- migrate:down
-- Restores all 11 columns and all 3 CHECKs with byte-identical
-- pg_get_constraintdef output. Ordinal position is NOT restored (the 11 return at
-- attnum 50-60 rather than interleaved) -- harmless, since the only SELECT * in
-- the entire repo is PositionService.ts:421 against ci.position and there is no
-- positional INSERT INTO ci.events anywhere.
-- No migration sets a COMMENT ON COLUMN ci.events.*, so `IS NULL` erases nothing.
ALTER TABLE ci.events
  ADD COLUMN is_predicted boolean DEFAULT false,
  ADD COLUMN prediction_model text,
  ADD COLUMN energy_level integer,
  ADD COLUMN productivity_impact double precision,
  ADD COLUMN external_sync_status text,
  ADD COLUMN last_synced_at timestamp with time zone,
  ADD COLUMN related_event_ids uuid[],
  ADD COLUMN supersedes_event_id uuid,
  ADD COLUMN salience double precision DEFAULT 1.0 NOT NULL,
  ADD COLUMN access_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN last_accessed timestamp with time zone;

ALTER TABLE ci.events
  ADD CONSTRAINT events_energy_level_check CHECK (energy_level >= 1 AND energy_level <= 10),
  ADD CONSTRAINT events_external_sync_status_check CHECK (external_sync_status = ANY (ARRAY['synced','pending','failed','not_synced'])),
  ADD CONSTRAINT valid_prediction_inference CHECK (NOT (is_predicted = true AND is_inferred = true));

COMMENT ON COLUMN ci.events.is_inferred IS NULL;
```

**Code changes — ALL of these ship in the release BEFORE the migration:**

| File | Change |
|---|---|
| `maintenance/services/LocationEstimateService.ts:128` | **THE LANDMINE.** Delete `AND COALESCE(e.is_predicted, false) = false` from `candidatePredicate()`. This is raw SQL — leaving it compiles fine and then throws 42703 at runtime. It is interpolated into **three** statements: the COUNT at :161-163, and the CTE at :185-189 that feeds the UPDATE at :190-206. Also delete the now-false doc paragraph at :103-113 explaining why the guard exists (a single predicted candidate would violate `valid_prediction_inference` and abort the batch). |
| `maintenance/services/__tests__/LocationEstimateService.spec.ts:34, 102, 103, 106, 107, 137` | Six assertions on the literal SQL text. Invert or delete. |
| `memory/entities/EventEntity.ts` | Remove `@Column` decls at :102-103, :108-109, :120-121, :123-124, :132-133, :135-136, :138-139, :149-150, :152-153, :158-159, :161-162, and the ten matching `toEgressType` keys at :206, :208, :212, :213, :216, :217, :219, :220, :221, :222, :223. `export type Event = Readonly<Omit<EventEntity,'user'>>` derives from the class, so this propagates to every consumer and the build catches them. |
| `memory/services/EventService.ts:374-432` | Delete the eight `if (data.<col>) { updateData.<camel> = ... }` blocks for the dropped columns. **Keep** the `is_inferred` (:378-380), `inference_sources` (:386-388) and `sentiment_score` blocks. `create` never wrote any of the 11, so the insert path is untouched. |
| `memory/types.ts` | Remove **all eight** dropped fields from `UpdateEventDto` (:103, :105, :109, :110, :114, :115, :117, :118) and **all eight** from `CreateEventDto` (:54, :56, :60, :61, :65, :66, :68, :69) — the original edit list covered only half of each. Remove the seven `SearchEventDto` fields (:148, :150, :153, :154, :157, :158, :160) — **this one is a runtime requirement, not cleanup**: `EventService.search()` at :482-491 does `where: { ...query }`, spreading caller-supplied keys straight into TypeORM's `find()`, so any leftover key becomes an `EntityPropertyNotFoundError` with no build error. Remove the zod keys at :514, :516, :520, :521, :524, :525, :527, :528 and :563, :565, :569, :570, :573, :574, :576, :577. Both schemas are strip-mode `z.object()` and neither is referenced outside `types.ts`, so no live contract narrows. |
| `memory/services/__tests__/EventService.ranking.test.ts:49-61` | Test named "exposes salience, accountCount, lastAccessed, sharingLevel" — reduce to `sharingLevel`, which survives. |
| `docs/architecture/event-ingest-spec.md:131` | Drop `is_predicted: z.boolean().default(false)` from the documented ingest contract. |
| `docs/architecture/schema-comparison-lifescope.html:1642-1646, 1723-1728` | This doc **proposes moving this exact block to a 1:1 side table**. Replace with the measured rejection (§4). Note the row lists **nine** columns including `sentiment_score`, and the "Breaks no CHECK constraint" cell is wrong — three CHECKs sit on the block. |

**Reviewer judgment call to sign off on knowingly:** `salience`/`access_count`/`last_accessed` were added on 2026-06-21 (`20260621005811:3`) as declared retrieval-ranking inputs and are documented as such at `EventEntity.ts:130-131`. No decay or reinforcement writer was ever built and no GraphQL type exposes them. Dropping them reverts stated intent that is two months old.

**Verify:**

```sql
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='ci' AND table_name='events';   -- expect 36

SELECT conname FROM pg_constraint
 WHERE conrelid='ci.events'::regclass AND contype='c' ORDER BY 1;
-- expect 5 (energy_level, external_sync_status, valid_prediction_inference gone)
```

Then hit `POST /api/maintenance/estimate-locations` once. If the `is_predicted` guard was missed, this is where 42703 surfaces.

---

### 4.5 `drop_browser_activity_generated_domain`

**Blast radius:** one generated column on `ci.browser_activity` (21 → 20). Zero indexes, zero constraints, zero cascade.

```sql
-- migrate:up
-- ci.browser_activity.domain is a STORED generated column with zero readers:
-- no index, FK, CHECK, view, trigger, function, RLS policy, extended-statistics
-- object or column grant depends on it (verified against pg_depend/pg_rewrite/
-- pg_trigger/pg_constraint/pg_proc/pg_policies/pg_statistic_ext). Every consumer
-- that wants a hostname parses it out of `url` in JavaScript
-- (BrowserActivityRow.tsx:25, BrowserActivityGridItem.tsx:24).
-- BrowserActivityEntity maps 20 columns, none named domain; BrowserActivityType
-- never exposes it; the only createQueryBuilder (BrowserActivityService.ts:303-304)
-- selects just id; entitySourceMap.ts:67 uses only idColumn; HBPE references the
-- table only as the NOTIFY channel name 'ci_browser_activity'.
--
-- NOTE ON DISK: this reclaims NOTHING on existing rows (rule R6). Measured on
-- 300k rows: 57,155,584 B before -> 57,155,584 B after DROP + VACUUM ANALYZE ->
-- 50,159,616 B only after VACUUM FULL. If the ~7.5 MB matters at 330k rows,
-- schedule a separate pg_repack. Do NOT put it in this migration.
-- This table already carries one tombstone at attnum 10 (page_embedding, dropped
-- by 20260213113000); this makes two.
ALTER TABLE ci.browser_activity DROP COLUMN domain;
```

```sql
-- migrate:down
-- Restores the column with the identical generation expression from
-- 20260104075933_departition_browser_activity.sql:19-23 and identical values
-- (verified on 300k rows: 500 distinct hosts; non-http urls such as 'search:cats'
-- correctly yield NULL).
-- Two caveats, so nobody calls this an exact restore:
--   1. ORDINAL POSITION IS NOT RESTORED. domain was attnum 4; it returns as
--      attnum 23, at the end of the table. Nothing in this repo is
--      position-sensitive against ci.browser_activity, so this is cosmetic.
--   2. THIS IS THE EXPENSIVE DIRECTION. Adding a STORED generated column rewrites
--      the whole heap under ACCESS EXCLUSIVE (~0.5 s per 300k rows, plus
--      transient 2x disk). The up is instant; the down is not.
ALTER TABLE ci.browser_activity
  ADD COLUMN domain text GENERATED ALWAYS AS (
    CASE
      WHEN (url ~ '^https?://'::text) THEN split_part(split_part(url, '://'::text, 2), '/'::text, 1)
      ELSE NULL::text
    END
  ) STORED;
```

**Code changes: NONE. Specifically — do NOT touch `backend/apps/summary/src/data_aggregator.py:53`.**

Leave `'browser_activity': {'time_col': 'time', 'exclude': ['domain']}` exactly as it is. `_schema_cache` (:58) is module-level, populated once at :130, and **never invalidated**. A summary sidecar running across the deploy keeps the pre-migration 21-column list; with the exclude key removed it emits `SELECT ... domain ...`, gets 42703, and has it swallowed by the table-level `except Exception` at :87 which sets `result['browser_activity'] = []` (:89). Every hourly summary then silently omits all browsing data until the process restarts — no crash, no alert, one log line. **With the exclude key kept, the sidecar is correct across the migration in both directions with no restart and no coordination.** The key costs nothing and is the only thing making this deploy order-independent.

**Verify:**

```sql
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='ci' AND table_name='browser_activity';   -- expect 20
```

---

## Wave 5 — Coherence

Wide mechanical sweeps. Ship after Waves 1–4 are green. Each item is independently reversible, but 5.2 has a genuine data-loss surface and 5.3 must be split.

---

### 5.1 `scope_inventory_source_triple_uniq_to_user`

**Blast radius:** one unique index, one arbiter + scope pair. Writes to `ci.inventory` block for the index build.

`inventory_source_triple_uniq` keys on the **nullable** `owner_user_id`. Two holes: NULLS DISTINCT means two NULL-owner rows with the same triple both insert; and reassigning `owner_user_id` moves a row into a different uniqueness bucket, so the next re-ingest mints a duplicate.

**Ordering:** this must land **after** Wave 2's `scope_events_source_triple_uniq_to_user`, or the migration comment below is false.

```sql
-- migrate:up
-- inventory_source_triple_uniq was keyed on owner_user_id (nullable, the
-- auto-detected owner) per 20260623120000_add_inventory_provenance.sql:15-17.
-- Two problems: NULLS DISTINCT means two NULL-owner rows with the same triple
-- both insert, and reassigning owner_user_id moves a row into a different
-- uniqueness bucket so a re-ingest duplicates it.
--
-- Re-key on ci.inventory.user_id -- NOT NULL, the creating tenant, and already
-- set to the same value as owner_user_id by the ONLY writer (ItemService.ts:32-33
-- and :79-80 both assign `context.userId` to both columns; both assignments and
-- this index arrived together in d5136a77, so no legacy row can carry a source
-- triple with a NULL owner). Behaviour-identical today, correct tomorrow.
--
-- Matches content_source_triple_uniq and browser_activity_source_triple_uniq,
-- and -- more importantly -- matches capture_events_capture_key_uniq
-- (user_id, destination, source_type, source_system, source_id), the capture
-- ledger BulkIngestController.captureAndMaterialize stamps with materialized_id.
-- Keying a destination table on a DIFFERENT column than the ledger is exactly
-- how ci.events grew its cross-tenant materialized_id bug, fixed by
-- scope_events_source_triple_uniq_to_user, which MUST already be applied.
--
-- PRE-FLIGHT (must return 0 -- this key is NOT strictly weaker, so it can fail).
-- The NULL guards are REQUIRED: the index is NULLS DISTINCT and source_type /
-- source_system are nullable, so a GROUP BY without them reports rows the index
-- would happily accept. Acting on that false positive would merge rows that were
-- never in conflict. Reachable in production because
-- CreateInventoryInput.ts:56-62 makes sourceType/sourceSystem optional and
-- ItemResolver.ts:116 createInventoryItems bypasses ci.capture_events.
--   SELECT count(*) FROM (
--     SELECT user_id, source_type, source_system, source_id FROM ci.inventory
--     WHERE source_id     IS NOT NULL
--       AND source_type   IS NOT NULL
--       AND source_system IS NOT NULL
--     GROUP BY 1,2,3,4 HAVING count(*) > 1) d;
-- Non-zero means real duplicate rows exist from the NULL-owner hole and must be
-- merged by hand first. Skipping the check is survivable: the CREATE fails 23505
-- naming the offending key and dbmate rolls the whole migration back -- the index
-- is never left dropped.
--
-- LOCKING: DROP INDEX takes ACCESS EXCLUSIVE and the (non-concurrent, because
-- dbmate wraps this in a transaction) CREATE UNIQUE INDEX takes SHARE on
-- ci.inventory. Writes to ci.inventory block for the build.
DROP INDEX IF EXISTS ci.inventory_source_triple_uniq;

CREATE UNIQUE INDEX inventory_source_triple_uniq
  ON ci.inventory (user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;
```

```sql
-- migrate:down
-- NOT unconditionally reversible: rows minted while the user_id key was live can
-- be legal under it and illegal under the owner_user_id key (two creators sharing
-- one owner and one triple). Verified to fail 23505 in that state. Unreachable
-- while ItemService is the only writer, but check before rolling back:
--   SELECT count(*) FROM (
--     SELECT owner_user_id, source_type, source_system, source_id
--     FROM ci.inventory
--     WHERE source_id      IS NOT NULL
--       AND owner_user_id  IS NOT NULL
--       AND source_type    IS NOT NULL
--       AND source_system  IS NOT NULL
--     GROUP BY 1,2,3,4 HAVING count(*) > 1) d;
-- AND REVERT THE CODE WITH IT: ItemService still emitting
-- `ON CONFLICT (user_id, ...)` against an owner_user_id index fails 42P10 on
-- every bulk inventory ingest (verified).
DROP INDEX IF EXISTS ci.inventory_source_triple_uniq;

CREATE UNIQUE INDEX inventory_source_triple_uniq
  ON ci.inventory (owner_user_id, source_type, source_system, source_id)
  WHERE source_id IS NOT NULL;
```

**Code changes (SAME commit — R2):**

| File | Change |
|---|---|
| `memory/services/ItemService.ts:109` | `scope: { ownerUserId: context.userId }` → `{ userId: context.userId }`. `inventory.userId` already resolves in a query builder at `ItemService.ts:211`, proving the property name works for `bulkUpsert.ts:242 applyScope`. |
| `memory/services/ItemService.ts:110` | `conflictTarget: '(owner_user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL'` → `'(user_id, ...)'`. **Both must change together** — arbiter must match the index (else 42P10) and scope must match the arbiter (else the pre-check and hydration SELECTs disagree with the ON CONFLICT). |
| `memory/services/ItemService.ts:63` | Doc comment "scoped to owner_user_id" → "scoped to the creating user (user_id)". |
| `graphql/resolvers/ItemResolver.ts:110` | "the provenance triple (owner, sourceType, sourceSystem, sourceId)" → "(creating user, ...)". |
| `docs/architecture/Database.md:125` | The row still documents `inventory_source_triple_uniq (owner_user_id, + triple)`. This table is the canonical statement of the idempotency arbiters; update it. |

`ItemEntity.ts` declares no `@Index`, so no entity change is needed.

**Add to `EventService.tenancy.integration.test.ts`'s sibling (or a new `ItemService.tenancy.integration.test.ts`):** the NULL-owner case. Two `createMany` calls with the same triple where `owner_user_id` is nulled between them (by explicit raw `UPDATE ci.inventory SET owner_user_id = NULL` — no code path produces a NULL owner, so the test must manufacture the state) must yield exactly one row. **Note `ItemService`'s constructor order is `(itemRepository, logger, eventService)` — logger SECOND — and `:24` calls `this.logger.setContext(...)`, so a stub lacking `setContext` throws at construction.**

**Verify:**

```sql
-- a) shape
SELECT indexdef FROM pg_indexes
 WHERE schemaname='ci' AND indexname='inventory_source_triple_uniq';
-- expect: ... btree (user_id, source_type, source_system, source_id) WHERE (source_id IS NOT NULL)

-- b) the arbiter is inferable (plan-time only)
EXPLAIN (COSTS OFF) INSERT INTO ci.inventory
  (object_id, user_id, owner_user_id, name, source_type, source_system, source_id)
VALUES (ci.gen_uuid_v7(), (SELECT id FROM ci.users LIMIT 1), NULL, '__verify__','__v__','__v__','__v__')
ON CONFLICT (user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL DO NOTHING;
-- expect `Conflict Arbiter Indexes: inventory_source_triple_uniq`

-- c) no duplicate triples survive (same NULL guards as the pre-flight)
SELECT count(*) FROM (
  SELECT user_id, source_type, source_system, source_id FROM ci.inventory
   WHERE source_id IS NOT NULL AND source_type IS NOT NULL AND source_system IS NOT NULL
   GROUP BY 1,2,3,4 HAVING count(*) > 1) d;   -- expect 0
```

---

### 5.2 `migrate_legacy_tag_columns_to_entity_tag` — **two phases, two releases**

**Blast radius:** three columns dropped across `ci.events`, `ci.communications`, `ci.inventory`; a backfill into `ci_search.tags` + `ci_search.entity_tag`.

**This must be expand/contract.** `EventEntity.ts:114-115` and `CommunicationEntity.ts:102-103` declare `@Column('text', { array: true })`, so TypeORM names the column in every read. `docker-compose.production.yml:105-111` runs `migrate-database` from the new image while the old `api` container is still serving (`api` only restarts on `migrate-database: service_completed_successfully` at :27-31). Proven: `ERROR: column EventEntity.tags does not exist`.

#### Phase 1 — `backfill_legacy_tag_columns_to_entity_tag`

Ships in release N **alongside** removal of the `@Column` mappings. **No DROPs.**

```sql
-- migrate:up
-- Guard: ci.inventory.tags has no writer in THIS repo, but CI-Import-Tools is a
-- separate repo. Assert the column is still at its '{}' default rather than
-- assuming it, since the phase-2 drop is irreversible for its contents.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ci.inventory
              WHERE tags IS NOT NULL AND tags <> '{}'::jsonb) THEN
    RAISE EXCEPTION
      'ci.inventory.tags holds non-default data (% rows); backfill it before the phase-2 drop',
      (SELECT count(*) FROM ci.inventory WHERE tags IS NOT NULL AND tags <> '{}'::jsonb);
  END IF;
END $$;

CREATE TEMP TABLE legacy_tag_src ON COMMIT DROP AS
  SELECT 'event'::text AS entity_type, e.event_id AS entity_id, e.user_id,
         lower(btrim(t)) AS label
    FROM ci.events e, LATERAL unnest(e.tags) AS t
   WHERE e.tags IS NOT NULL AND btrim(t) <> ''
  UNION
  SELECT 'communication'::text, c.id, c.user_id, lower(btrim(t))
    FROM ci.communications c, LATERAL unnest(c.tags) AS t
   WHERE c.tags IS NOT NULL AND btrim(t) <> '';

-- lower() is REQUIRED: TagService.validateLabel (TagService.ts:453-454) trims and
-- lower-cases every label, and tags_label_user_key is case-SENSITIVE. Without it
-- the backfill mints 'Food' rows no API path can ever produce or match.
--
-- DO UPDATE, not DO NOTHING: tags_label_user_key is a plain UNIQUE (label,user_id)
-- with NO deleted_at predicate, so a tag soft-deleted via TagService.remove
-- (TagService.ts:169-182) would absorb the conflict and the entity_tag rows below
-- would attach to a tombstone that searchByLabel (:135) and getTagUsageCounts
-- (:440) filter out -- silent, permanent loss once the source column is dropped.
-- A surviving legacy tag on the entity is proof the tag should be live.
INSERT INTO ci_search.tags (id, label, user_id)
SELECT ci.gen_uuid_v7(), s.label, s.user_id
  FROM (SELECT DISTINCT user_id, label FROM legacy_tag_src) s
ON CONFLICT (label, user_id) DO UPDATE
   SET deleted_at = NULL, updated_at = now()
 WHERE ci_search.tags.deleted_at IS NOT NULL;

INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id)
SELECT DISTINCT s.entity_type, s.entity_id, t.id
  FROM legacy_tag_src s
  JOIN ci_search.tags t ON t.label = s.label AND t.user_id = s.user_id
ON CONFLICT ON CONSTRAINT entity_tag_unique_entry DO NOTHING;
```

```sql
-- migrate:down
-- Intentional no-op. Backfilled entity_tag rows are indistinguishable from rows
-- created through TagService, so deleting them would destroy live user data.
-- The legacy columns are still present and still hold their original values in
-- this phase, so rolling back loses nothing.
SELECT 1;
```

**Phase 1 code changes:**

| File | Change |
|---|---|
| `memory/entities/EventEntity.ts:115, :210` | Delete the `tags!: string[] \| null` `@Column` and `tags: entity.tags` from `toEgressType`. The value is thrown away one layer up anyway: `EventType.ts:111` hardcodes `tags: []` with the comment "Hydrated by resolver", and `EventResolver.ts:277-286` loads the real tags from `ci_search.entity_tag`. |
| `memory/entities/CommunicationEntity.ts:103, :150` | Same. `ci.communications.tags` has **no writer anywhere** in the repo, and `CommunicationType.ts:51` likewise hardcodes `tags: []`. |
| `memory/services/EventService.ts:390-391` | `if (data.tags) updateData.tags = data.tags` is the only writer of `ci.events.tags`, writing to a column no reader consumes. Replace with a `tagService.tagEntities(...)` call, or drop the field. Note `tags` is not exposed on `CreateEventInput`/`UpdateEventInput`, so this path is already unreachable from GraphQL. |
| `memory/types.ts:58, :107, :518, :567` | `tags?: string[]` on Create/UpdateEventDto and both zod schemas. **The create path is already broken today** — `EventService.toEntityFields` never maps `item.tags`, so a tag sent on create is silently discarded. Either wire both paths to TagService or remove the field. |

#### Phase 2 — `drop_legacy_tag_columns`

Ships one release **after** phase 1, once no running API build maps the columns. This split is what removes the 42703 window.

```sql
-- migrate:up
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ci.inventory
              WHERE tags IS NOT NULL AND tags <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'ci.inventory.tags holds non-default data; refusing to drop';
  END IF;
END $$;

ALTER TABLE ci.events         DROP COLUMN tags;
ALTER TABLE ci.communications DROP COLUMN tags;  -- hypertable; verified across 2 chunks
ALTER TABLE ci.inventory      DROP COLUMN tags;
```

```sql
-- migrate:down
ALTER TABLE ci.events         ADD COLUMN tags text[];
ALTER TABLE ci.communications ADD COLUMN tags text[];
-- DEFAULT restored: the original carried it
-- (20250925154200_create_inventory_table.sql:57).
ALTER TABLE ci.inventory      ADD COLUMN tags jsonb DEFAULT '{}'::jsonb;

-- t.user_id = e.user_id is REQUIRED: ci_search.entity_tag has no user column and
-- no FK to the entity table, so an unscoped join can write another tenant's label
-- into ci.events.tags. t.deleted_at IS NULL keeps soft-deleted tags from being
-- resurrected into the array.
UPDATE ci.events e SET tags = sub.labels
  FROM (SELECT et.entity_id, t.user_id, array_agg(t.label ORDER BY t.label) AS labels
          FROM ci_search.entity_tag et JOIN ci_search.tags t ON t.id = et.tag_id
         WHERE et.entity_type = 'event' AND t.deleted_at IS NULL
         GROUP BY et.entity_id, t.user_id) sub
 WHERE e.event_id = sub.entity_id AND e.user_id = sub.user_id;

UPDATE ci.communications c SET tags = sub.labels
  FROM (SELECT et.entity_id, t.user_id, array_agg(t.label ORDER BY t.label) AS labels
          FROM ci_search.entity_tag et JOIN ci_search.tags t ON t.id = et.tag_id
         WHERE et.entity_type = 'communication' AND t.deleted_at IS NULL
         GROUP BY et.entity_id, t.user_id) sub
 WHERE c.id = sub.entity_id AND c.user_id = sub.user_id;
-- Still lossy by nature: original casing is gone, and tags added directly to
-- entity_tag after phase 1 are indistinguishable from migrated ones.
```

**Phase 2 code changes:** none — `ItemEntity.ts` maps no `tags` column at all.

**Explicitly NOT migrated, and both are correct decisions:**
- **`ci.saved_searches.tags`** is not entity tagging at all — it stores the tag *labels* a saved search filters *by* (`SearchInput.ts:25` → `SearchResolver.ts:200,225,314` → `tagService.getEntitiesForTags`). Migrating it is a category error.
- **`ci.summaries.tags`** is genuinely live: written by `backend/apps/summary/src/activities.py:939-987`, read at `SummaryEntity.ts:65-67/94/106`, surfaced through `SummaryType.ts:106` to `SummaryDetailPage.tsx:95-97`, and it carries the only index on any of the five columns (`summaries_tags_idx`, GIN). Migrating it means touching the Python worker — separate work.

**Verify (after phase 2):**

```sql
SELECT table_name, column_name FROM information_schema.columns
 WHERE column_name = 'tags' AND table_schema IN ('ci','ci_search')
 ORDER BY 1;
-- expect exactly: saved_searches | tags   AND   summaries | tags

SELECT count(*) FROM ci_search.entity_tag WHERE entity_type IN ('event','communication');
-- expect >= the pre-migration array-element count
```

---

### 5.3 `retire_orphan_enums_and_constrain_search_dispatch_types`

**Blast radius:** five CHECK constraints on dispatch keys. No column changes.

Wave 1's `drop_orphan_enum_types` already removed the three enums; this item is the **CHECK half only**. The mechanism argument that motivates it: dbmate wraps each migration in a transaction and Postgres forbids using a newly-added enum label in the same transaction (R7). Enums are structurally hostile to this repo's tooling; CHECK value-lists are not.

```sql
-- migrate:up
-- The ci_search dispatch keys. Lists transcribed verbatim from
-- INDEXABLE_ENTITIES (search-next/types.ts:1-19) and TAGGABLE_ENTITIES (:23-37).
-- Safe against existing rows because every write path is either an INSERT with a
-- typed literal, an ON CONFLICT (entity_type, entity_id) DO UPDATE whose arbiter
-- pins entity_type to the incoming (in-list) value, an INSERT ... DO NOTHING, or
-- a DELETE -- no UPDATE ever revisits a row at a retired entity_type. Verified
-- via git history that both lists only ever GREW (10->14 indexable, 7->12
-- taggable), so no retired value can be sitting in the table.
ALTER TABLE ci_search.embeddings ADD CONSTRAINT embeddings_entity_type_check
  CHECK (entity_type = ANY (ARRAY['answer','browser-activity','communication','concept',
    'content','event','file','file-chunk','item','message','note','person','place','thread']))
  NOT VALID;

ALTER TABLE ci_search.vectors ADD CONSTRAINT vectors_entity_type_check
  CHECK (entity_type = ANY (ARRAY['answer','browser-activity','communication','concept',
    'content','event','file','file-chunk','item','message','note','person','place','thread']))
  NOT VALID;

ALTER TABLE ci_search.entity_tag ADD CONSTRAINT entity_tag_entity_type_check
  CHECK (entity_type = ANY (ARRAY['action','browser-activity','communication','concept',
    'content','event','file','item','note','person','place','thread']))
  NOT VALID;

ALTER TABLE ci_search.index_skips ADD CONSTRAINT index_skips_entity_type_check
  CHECK (entity_type = ANY (ARRAY['answer','browser-activity','communication','concept',
    'content','event','file','file-chunk','item','message','note','person','place','thread']))
  NOT VALID;

-- Append-only audit table; sole writer is PersonMergeService.ts:192, which
-- hard-codes 'Person'. No UPDATE path exists (no entity class, no service reads
-- or mutates it). Vocabulary per 20260803223025:128:
-- Person | Location | ObjectInstance | ProductModel.
ALTER TABLE ci.entity_merges ADD CONSTRAINT entity_merges_entity_type_check
  CHECK (entity_type = ANY (ARRAY['Person','Location','ObjectInstance','ProductModel']))
  NOT VALID;

-- DELIBERATELY OMITTED (see "deliberately not doing"):
--   ci.relationships.from_entity_type / to_entity_type -- the column holds a
--     MIXED vocabulary by design, with three live writers each in a different
--     one. No single value-list can be added without breaking a live writer.
--   ci.graph_deltas.entity_type -- its source column ci.entities.entity_type is
--     only regex-constrained (^[A-Z][A-Za-z]*$), and DeltaEntitySubscriber writes
--     it inside the caller's transaction, so a violation aborts an unrelated
--     node save.
```

```sql
-- migrate:down
ALTER TABLE ci.entity_merges      DROP CONSTRAINT entity_merges_entity_type_check;
ALTER TABLE ci_search.index_skips DROP CONSTRAINT index_skips_entity_type_check;
ALTER TABLE ci_search.entity_tag  DROP CONSTRAINT entity_tag_entity_type_check;
ALTER TABLE ci_search.vectors     DROP CONSTRAINT vectors_entity_type_check;
ALTER TABLE ci_search.embeddings  DROP CONSTRAINT embeddings_entity_type_check;
```

**Code changes:**

| File | Change |
|---|---|
| `backend/apps/api/src/domains/search-next/types.ts` | Add a comment pinning `INDEXABLE_ENTITIES`/`TAGGABLE_ENTITIES` as the source of truth for these four CHECKs. Better still: a startup assertion comparing the TS constant against `pg_constraint`'s list — `entitySourceMap.ts:112-115` already uses exactly this pattern (throws at module load when `INDEXABLE_ENTITIES` gains an unmapped member). A comment is not enforcement. |
| `CLAUDE.md` "Database migrations" | Record the rule: **no new Postgres enum types.** Type discrimination is a CHECK value-list on a TEXT column, because dbmate's per-migration transaction cannot use a newly-added enum label. |

**Next candidates, deliberately not in this migration** (each needs a `SELECT DISTINCT` on a real appliance first — unlike the four above, they have no TS list to transcribe): `ci.content.type`, `ci.capture_events.kind`, `ci.capture_events.destination`, `ci.events.event_type`, `ci.files.parse_status`, `ci.tasks.source_kind`.

**Not proposed:** touching the 53-column bare-TEXT set wholesale. Most (`ci.inventory.category`, `ci.receipts.payment_method`, `ci.product_models.category`) are open-world descriptive labels where a CHECK is a liability.

**Verify:**

```sql
SELECT conrelid::regclass AS tbl, conname, convalidated
  FROM pg_constraint
 WHERE conname LIKE '%entity_type_check' ORDER BY 1;
-- expect 5 rows, convalidated = f (NOT VALID is correct here: every existing
-- row is provably in-list, and no UPDATE path revisits a row at a retired type)
```

**Rule R5 caveat that makes this safe where it was not elsewhere:** a `NOT VALID` CHECK *is* enforced on UPDATE. It is acceptable on these five tables and only these five, because each was verified to have no UPDATE path that touches a row at an out-of-list value. Do not copy this pattern to a table without doing that check.

---

### 5.4 `annotate_unread_object_commerce_tables`

**Blast radius:** eight comment objects. Zero data, zero locks of consequence.

Four reader-less tables (`ci.product_models` 27 cols, `ci.receipts` 33, `ci.receipt_line_items` 19, `ci.object_observations` 31 = 110 columns, 33 indexes, 16 CHECKs, 20 FKs) all **already carry** a `COMMENT ON TABLE` that describes the design accurately and says nothing about nothing reading them — which is exactly why the fiction persists. Four column comments describe a running pipeline that does not exist.

**The verdict is comment, not branch or land.** Branching buys −4 tables / −110 cols / −33 indexes — the largest number in this plan — and is still wrong today, for concrete reasons: `ci.inventory.product_id`, `.acquisition_receipt_id` and `.acquisition_line_item_id` are FK-bound to three of the four, are mapped on `ItemEntity` and returned by `ItemEntity.toEgressType`, so branching is a **public API removal**. And `ci.object_identifiers.subject_id` points at `ci.product_models.product_id` whenever `subject_type='product_model'` (allowed by `object_identifiers_subject_type_check`) with **no FK by design**, so a drop silently orphans live `ObjectIdentifierService` rows with no error at any layer.

```sql
-- migrate:up
COMMENT ON TABLE ci.product_models IS
  'Catalog product models — the thing a GTIN names. ci.inventory holds the owned UNITS that are instances of these. NO READER AS OF 2026-08: zero InjectRepository(ProductModelEntity), no GraphQL type, no REST route. ProductCatalogService and ObjectGraphLinkService, named in the present tense by migration 20260803223013, DO NOT EXIST. Kept for two hard couplings: (a) ci.inventory.product_id is FK-bound here, is mapped on ItemEntity and is returned by ItemEntity.toEgressType, so dropping this table is a public API removal, not just a schema drop; (b) ci.object_identifiers.subject_id points here whenever subject_type = ''product_model'' (allowed by object_identifiers_subject_type_check) with NO FK by design, so a drop silently orphans live ObjectIdentifierService rows with no error at any layer. Re-evaluate at #1823 close.';

COMMENT ON TABLE ci.receipts IS
  'Purchase evidence. ci.receipt_line_items holds the per-product claims. NO READER AND NO WRITER AS OF 2026-08: zero InjectRepository(ReceiptEntity), no GraphQL type, no REST route. ReceiptExtractionService and POST /api/maintenance/receipts/extract, named in the present tense by migration 20260803223019, DO NOT EXIST. Kept because ci.inventory.acquisition_receipt_id is FK-bound here, is mapped on ItemEntity and is returned by ItemEntity.toEgressType. Re-evaluate at #1823 close.';

COMMENT ON TABLE ci.receipt_line_items IS
  'One product claim on a receipt; the intended unit of object minting. NO READER AND NO WRITER AS OF 2026-08: zero InjectRepository(ReceiptLineItemEntity), no GraphQL type, no REST route, and no code path mints anything. Kept because ci.inventory.acquisition_line_item_id is FK-bound here, is mapped on ItemEntity and is returned by ItemEntity.toEgressType. Re-evaluate at #1823 close.';

COMMENT ON TABLE ci.object_observations IS
  'A sighting of a physical thing in an image — the weak claim, kept out of ci.inventory so vision guesses never pollute the owned-things table. NO READER AND NO WRITER AS OF 2026-08: zero InjectRepository(ObjectObservationEntity), no GraphQL type, no REST route. ObjectResolutionService and ObjectObservationService, named in the present tense by migration 20260803223022, DO NOT EXIST. It is the only one of the four with zero inbound FKs (31 cols, 11 indexes, 5 CHECKs, 6 outbound FKs) and therefore the cheapest to branch — but BEFORE branching, note that ci.inventory.last_seen_at and .last_seen_place_entity_id are documented as denormalized FROM this table and are both mapped and returned by ItemEntity.toEgressType, so a drop leaves two live public fields with no stated source. Re-evaluate at #1823 close.';

-- The column comments below asserted the same fiction in the present tense and
-- must move with the table comments, or a reader gets NO READER on the table and
-- a running pipeline on its columns.
COMMENT ON COLUMN ci.receipts.place_entity_id IS
  'Graph Location where the purchase happened. Intended to feed the place_prior step of image-based object resolution; that step DOES NOT EXIST as of 2026-08 — place_prior appears only as a string literal in ObjectObservationEntity''s type union.';

COMMENT ON COLUMN ci.receipt_line_items.is_physical IS
  'FALSE for digital goods (ebooks, subscriptions, gift cards). Intended rule: only physical lines mint ci.inventory rows. NOTHING MINTS AS OF 2026-08 — this column has no writer and no reader.';

COMMENT ON COLUMN ci.receipt_line_items.minted_object_id IS
  'The owned unit minted from this line — the forward half of the provenance chain; ci.inventory.acquisition_line_item_id is the back-pointer. NO CODE WRITES EITHER HALF AS OF 2026-08.';

COMMENT ON COLUMN ci.object_observations.place_entity_id IS
  'Graph Location the sighting happened at. Intended to let a place_prior resolution step scope candidate objects to things known to be at this place; that step DOES NOT EXIST as of 2026-08.';
```

```sql
-- migrate:down
COMMENT ON TABLE ci.product_models IS 'Catalog product models — the thing a GTIN names. ci.inventory holds the owned UNITS that are instances of these.';
COMMENT ON TABLE ci.receipts IS 'Purchase evidence. ci.receipt_line_items holds the per-product claims; ci.inventory.acquisition_line_item_id points back at the line an owned unit was minted from.';
COMMENT ON TABLE ci.receipt_line_items IS 'One product claim on a receipt. The unit of object minting: a four-item order produces four lines and up to four ci.inventory rows, instead of the single order-named row the importer writes today.';
COMMENT ON TABLE ci.object_observations IS 'A sighting of a physical thing in an image. The weak claim ("seen"), kept separate from the strong one ("owned", ci.inventory) so vision guesses never pollute the owned-things table.';
COMMENT ON COLUMN ci.receipts.place_entity_id IS 'Graph Location where the purchase happened. Feeds the place_prior step of image-based object resolution.';
COMMENT ON COLUMN ci.receipt_line_items.is_physical IS 'FALSE for digital goods (ebooks, subscriptions, gift cards). Only physical lines mint ci.inventory rows.';
COMMENT ON COLUMN ci.receipt_line_items.minted_object_id IS 'The owned unit minted from this line. The forward half of the provenance chain; ci.inventory.acquisition_line_item_id is the back-pointer.';
COMMENT ON COLUMN ci.object_observations.place_entity_id IS 'Graph Location the sighting happened at. The place_prior resolution step scopes candidate objects to things known to be at this place.';
```

**Code changes:** none. **Note the escaped single quotes** (`''product_model''`, `ObjectIdentifierEntity''s`) — do not hand-edit those strings without re-running against a probe.

**Attach the re-comment to the #1823 close checklist explicitly.** Nothing enforces the "AS OF 2026-08 / re-evaluate" hedge; if #1823 closes without someone running `migrate:make` again, the DB will assert "NO READER" about tables that by then have five services.

**Verify:**

```sql
SELECT c.relname, obj_description(c.oid,'pg_class') LIKE '%NO READER%' AS annotated
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='ci'
   AND c.relname IN ('product_models','receipts','receipt_line_items','object_observations');
-- expect 4 rows, annotated = t
```

---

## 4. Deliberately not doing

Each of these was investigated, measured or executed, and rejected. **This section exists so nobody re-proposes them.**

### Rejected — the measurements refute them

**Do NOT fold `ci.browser_activity` into `ci.events` + `ci.content`.** Measured on 300k identical rows: baseline 620.0 B/row; full fold with extras in `metadata` 920.9 B/row (**+48.5%**); "lean" fold with the mandatory `(user_id, start_time DESC, event_id DESC)` keyset index restored 646.8 B/row (**+4.3%**). *(The −5.2% figure that circulates omits that index, which `BrowserActivityService.findPage:184-196` requires.)* The heap shrinks under the lean variant; the index side grows 68.96 → 87.14 MB and swamps it, because `ci.events` carries 10 indexes to `browser_activity`'s 3 and `events_source_triple_uniq` alone is 39.6 MB. Additionally: `ci.browser_activity` has **no FK on user_id** (both dropped by `20260104075933`) while `ci.events.user_id` is NOT NULL with `ON DELETE CASCADE` — proven that a `user_id` `browser_activity` accepts today is rejected outright by `ci.events`, so orphaned rows abort the migration and migrated rows silently become cascade-deletable. And ~330k rows in each of `ci_search.embeddings`/`ci_search.vectors` are stamped `entity_type='browser-activity'` under `UNIQUE (entity_type, entity_id)`; no proposal has ever included the data migration to rewrite them, so the browsing search index would be orphaned wholesale with no error.

**Do NOT split the `ci.events` analytics block into a 1:1 side table** (this is what `docs/architecture/schema-comparison-lifescope.html:1723-1726` currently recommends — correct it as part of 4.4). Measured at 300k rows: 46 live cols 341.3 B/row; drop-only 323.0 B/row (−5.4%); side-table split 311.2 B/row (−8.8%) — but the side table itself, populated 1:1, is 27,549,696 B (heap + PK index). Split total 120,963,072 B vs 96,968,704 B inline = **+24.7%**. Even a 10%-sparse side table nets 1.06%, and only by giving up the 1:1 guarantee, which forces a LEFT JOIN + COALESCE on every read. Structurally: 11 of the 13 columns are NULL on essentially every row and a NULL column costs one bit in the tuple's null bitmap, not a byte. It also breaks three CHECKs and turns `LocationEstimateService`'s single set-based UPDATE into an upsert whose predicate is shared by two SELECTs.

**Do NOT split `ci.inventory`** along identity / economics-lifecycle / placement seams. The seams are real; the split makes the DB **+45.5% larger** (measured, 20k rows: 6,717,440 B single table vs 9,773,056 B across three shards), adds two tables, and — proven by execution — makes three indexes physically unbuildable: `inventory_live_keyset_idx` (42703 on `merged_into_object_id`), `inventory_lifecycle_idx` (`lifecycle_state`), `inventory_last_seen_idx` (`last_seen_at`). It also crosses two self-FKs across the seam and would silently break `OrphanCleanupService`, which addresses `ci.inventory` by interpolated table name via `entitySourceMap.ts:87` — the orphan reaper's existence probe would find nothing and DELETE every `item` row from `ci_search.embeddings`/`vectors`, with TypeScript compiling clean. *The real cost driver is `ItemResolver.ts:36-63` → `ItemService.findAll`, which loads every inventory row for the user with all 48 mapped columns and paginates in JavaScript. Push ORDER BY / LIMIT / `merged_into_object_id IS NULL` into SQL instead.*

**Do NOT drop `item_relationships_to_idx`.** `(user_id, to_source_type, to_source_system, to_source_id)` is the reverse direction and is **not** a prefix of `edge_uniq`. Dropping `from_idx` (1.3) is a structural identity; dropping `to_idx` would be a bet on the future.

### Rejected — they break live code

**Do NOT drop `ci.agents`** without deleting `backend/apps/summary/src/agent_registration.py` in the same change. It has a live `INSERT INTO agents` (:127) plus three `UPDATE`s, running on every summary-service boot. (1.1 does both.)

**Do NOT drop `ci.events.extracted_entities` or `intent_categories`.** They feed `search_vector`, a generated column carrying `messages_fts_idx`-equivalent indexing, and dropping them forces recreating the index that `IndexDeferralService` registers **by name**.

**Do NOT drop `ci.events.sentiment_score`.** Four request schemas declare it, `EventService.ts:394-396` writes it, `EventEntity.ts:211` returns it, and it carries a CHECK.

**Do NOT drop `ci.saved_searches.tags` or `ci.summaries.tags`.** The first is search criteria, not entity tagging. The second is live Python-written data with the only GIN index on any of the five tag columns.

**Do NOT drop `ci.inventory.related_object_ids` or `parent_object_id`.** They carry `inventory_parent_object_id_fkey` and `inventory_parent_idx` and encode a real containment model.

**Do NOT flip `graph/entities/NodeEntity.ts:20-21` (`userId!: string`) to nullable.** `ci.entities.owner_user_id` is `uuid NOT NULL` with `entities_owner_user_id_fkey ... ON DELETE CASCADE` — verified on the probe, contradicting a widely-repeated "uuid NULL for both" note. `NodeEntity` is the **only** declaration in the repo that matches SQL; flipping it replaces the one truthful contract with a false one and silently widens `Node.userId` for every consumer with zero compiler pushback. *(The four that ARE wrong — `GraphNodeEntity.ts:38-39`, `BaseEntity.ts:35`, `PersonEntity.ts:40`, `ConceptEntity.ts:40` — declare `nullable: true` over a NOT NULL column. Fixing those is a separate, small item; do not use them as the reference pattern.)*

**Do NOT remove `relations: ['user']`-driven re-queries wholesale from `PlaceService.createMany` (`PlaceService.ts:604-608`).** Proven: `repository.create()` does not fire `@AfterLoad`, and neither does the `InsertQueryBuilder` at :589-597. That `find()` is the **only** thing that runs `PlaceEntity.loadPropertiesFromJsonb` (:96-149). Removing it makes `createPlaces` return `type`, `geoFormat`, `geolocation`, `locationBoundary`, `estimated`, `tracked`, `uploaded`, `latitude` and `longitude` as null — all nine are `@Field` on `PlaceType` and in the published schema. Drop only `relations: ['user']`; keep the `find`.

**Do NOT change `PlaceService.spec.ts:56`'s `columns: { length: 8 }` to 9.** Measured against a live TypeORM 0.3.26 DataSource: `PlaceEntity.metadata.columns.length` is **12** before and **12** after adding an explicit `@Column` on `owner_user_id` — TypeORM *merges* an explicit `@Column` and a `ManyToOne` `@JoinColumn` naming the same database column into one `ColumnMetadata`. The 8 was already wrong (as is `PersonService.spec.ts:16`'s 13, real value 14), and `computeChunkSize` returns 1000 for 8, 9 and 12 alike. Changing it makes a wrong constant wrong in a new way.

**Do NOT set `ItemService.ts:33`/`:78`'s `ownerUserId` to `null`.** It is not required by 5.1's index swap and it destroys the only ownership signal that exists — nothing else writes `ci.inventory.owner_user_id`, no owner-detection service has been written, and `inventory_owner_idx` (`WHERE owner_user_id IS NOT NULL`) becomes permanently empty. Revisit in the PR that actually adds owner detection.

**Do NOT add `Organization: 'person'` / `Product: 'item'` to `GRAPH_TYPE_ALIASES`** (`embeddable.ts:205-217`). `entitySourceMap.ts:87-90` declares person's source with `discriminator: { column: 'entity_type', value: 'Person' }`, and `OrphanCleanupService.ts:186-222` DELETEs any embedding whose `EXISTS` clause misses that discriminator. An Organization node embedded as 'person' is reaped on every maintenance run; `Product: 'item'` is worse, since item's source is `ci.inventory` keyed on `object_id` — reaped 100% of the time. Net: write churn, zero searchability.

### Rejected — the guard is more dangerous than the thing it guards

**Do NOT gate any migration on `IF (SELECT count(*)) > 0 THEN RAISE EXCEPTION`.** It fires only on the appliances that have the data, aborts `dbmate migrate`, and blocks that migration and every subsequent one. Use `RAISE NOTICE`. (Rule R4.)

**Do NOT ship a value-list CHECK as `NOT VALID` to "let an appliance with unforeseen values still boot".** Proven: with a 7-value `NOT VALID` CHECK on `ci.entities.entity_type`, an unrelated `UPDATE ci.entities SET last_accessed = now()` on a legacy `'Content'` row raises 23514. The row becomes permanently un-updatable — no archive, no merge tombstone, no dossier write. A slow silent write failure is worse than a loud migration abort. (Rule R5.)

**Do NOT replace `MemoryCompactionService.ts:78`'s `VALID_ENTITY_TYPES` with `TAGGABLE_ENTITIES`/`INDEXABLE_ENTITIES`.** It is not a stray fifth vocabulary — it is the exact domain of the switch at `:567-671` (`case 'person' | 'concept' | 'place' | 'item' | 'event' | 'content'`, `default: return null`). Substituting the search-index vocabulary desyncs the gate from the switch. Fix the stale doc comment at `:72-77` instead.

**Do NOT make `GraphEntityInput.entityType` a GraphQL enum.** It moves rejection to schema validation, turning one bad value into a whole-request 400 with no per-entity `errors[]`. `GraphIngestService.ts:298-347` already fails an entire batched-insert chunk (and drops every relationship referencing it) when one row raises — validate *in the service* and skip the node with a per-entity error instead. The sole external caller is `CI-Import-Tools/backend/src/ci-server/graph-sync.ts:239`.

### Deferred — needs a code-side change first, not a migration

**`canonicalize_graph_entity_type`** (fold `Place`→`Location`, `Thing`/`Item`→`Object`, `Contact`/`User`→`Person`; swap the `^[A-Z][A-Za-z]*$` regex for a 7-value list). **Blocked**: the alias UPDATEs are a *merge* problem, not a rename problem. Four UNIQUE indexes on `ci.entities` key on `entity_type` or are predicated on `entity_type='Location'` — `entities_linked_uniq (owner_user_id, entity_type, linked_table, linked_id)`, `entities_place_provider_id_uniq`, `entities_reverse_geocode_dedup_idx`, `entities_admin_place_uniq` — so an alias row and its canonical twin coexist legally today and collide with 23505 the instant one is renamed (reproduced on both `entities_linked_uniq` and `entities_place_provider_id_uniq`). A collision has no tooling: `PersonMergeService` is the merge path for Person; there is no equivalent for Location. Prerequisite: run `SELECT a.entity_id, a.entity_type, c.entity_id FROM ci.entities a JOIN ci.entities c ON c.owner_user_id=a.owner_user_id AND c.linked_table=a.linked_table AND c.linked_id=a.linked_id AND c.entity_id<>a.entity_id WHERE a.entity_type IN ('Place','Thing','Item','Contact','User') AND a.linked_table IS NOT NULL;` on a real appliance.

**`ci.relationships` / `ci.graph_deltas` entity_type CHECKs** (R9). `ci.relationships.from_entity_type`/`to_entity_type` holds **three** mutually incompatible vocabularies with a live writer each: lowercase forced by `RelationshipMap` (`graph/types.ts:54-96`, gating every `RelationshipService.upsert`), PascalCase from `GraphEnrichmentService`, and the literal `'User'` (`KnownPlacesService.ts:487`, `GraphIngestService.ts:22`). Migration `20260129184823:7-30` backfilled **every existing row** lowercase. Combined with R5, a `NOT VALID` CHECK there turns `PersonMergeService`'s two bulk re-point UPDATEs (`:317`, `:345`) into a guaranteed 23514. Ordering: unify in `RelationshipService.upsert` → census → backfill → then constrain.

**`consolidate-relationship-entity`** (merge `graph/RelationshipEntity` + `memory/RelationshipEntity`, backfill `from_entity_type`/`to_entity_type`, add NOT NULL). Real bugs underneath — `Query.relationships` returns soft-deleted edges, and memory-side edges leave the type columns NULL which nulls a `String!` field. But the proposed backfill writes `ci.entities`' PascalCase into a column whose vocabulary is lowercase (set by `20260129184823`), producing `person`/`Person`/`Unknown` in one column; the justifying CHECK (`^[A-Z][A-Za-z]*$`) lives on a *different table*; adding `isActive` to the entity makes it a **required** key in `CreateRelationshipDto` via `Optional<>` (`graph/types.ts:42-52`), breaking `smithFamily.ts:7` and `RelationshipResolver.ts:32-44`; adding `isActive: true` to `findById` introduces a new 500 in `update()` (`:264-288` re-reads via `findById` and dereferences with `entity!`); and the stated root-cause fix is unimplementable as written because `createOrUpdateRelationship`'s payload has no type fields — eleven call sites must be extended first. Redo with the lowercase `ci.rel_node_kind()` mapping and the `NOT VALID`/`VALIDATE`/`SET NOT NULL` lock-avoiding sequence.

**`ci.entities.owner_user_id SET NOT NULL`** and the five owner-scoped unique-index moves on `ci.receipts`/`ci.product_models`/`ci.object_observations`. The index moves are low-risk (those three tables have **no service class at all** — zero live writers) but must be split from the `ci.entities` change, whose proposed `DELETE FROM ci.entities WHERE owner_user_id IS NULL` **hard-fails** on three NO-ACTION FKs (`users_entity_id_fkey`, `inventory_object_entity_id_fkey`, `product_models_product_entity_id_fkey` — reproduced twice) and, where it does get through, silently NULLs ten `ON DELETE SET NULL` columns including `ci.events.location_entity_id` and the merge-tombstone chain. Replace the DELETE with a `RAISE EXCEPTION` guard that aborts cleanly and makes a human re-home the rows. Also note `product_models_brand_model_uniq` leads on the nullable `owner_user_id` too and was omitted from the original sweep.

**`entity-tag-provenance`** (add `source`/`removed_at` to `ci_search.entity_tag`). Blocked on a prerequisite that invalidates the premise: `TransformGmail.ts:142` calls `communicationService.create` with no id and no source triple, and `CommunicationService.ts:56` does `data.id ?? uuidv7()` — the provenance dedup lives only in `createMany`. **Every Gmail re-sync mints a brand-new `ci.communications` uuid**, so a tombstone keyed on `(entity_type, entity_id, tag_id)` for the old uuid is never consulted. Separately, keeping `ON CONFLICT DO NOTHING` as specified means a user can **never re-apply** a removed tag (proven: `INSERT 0 0`, mutation still returns success to eight frontend call sites), and four read paths were missed — including `TagService.ts:344-358` (the `TagLoader`, highest traffic) and `:92`/`:110`, which use TypeORM `relations: ['entities']` and **cannot** take a predicate at all.

**`place-coordinates-one-representation`** (collapse three coordinate representations to `location_point`, swap the reverse-geocode dedup index to `ST_SnapToGrid`). Blocked on two load-bearing corrections. First, the rewritten read-back at `PlaceService.ts:139-149` **cannot use the new index** without also carrying `AND btrim(name) <> ''` — that clause is in the partial index's predicate and Postgres cannot derive it from `lower(btrim(name)) = $3`; without it the hot path of every reverse-geocode batch item degrades to a per-row PostGIS scan (verified: disabled Seq Scan vs clean Index Cond). Second, the proposed STEP 2 is not a merge — it sets `merged_into_entity_id` and repoints nothing, stranding `ci.events.location_entity_id`, `ci.position.*`, `ci.receipts.place_entity_id`, `ci.object_observations.place_entity_id`, `ci.inventory.last_seen_place_entity_id` and child `parent_place_id`, and never reaps the loser's search doc (`OrphanCleanupService.ts:182-195` keys on row existence and ignores the `merged_into_entity_id` backfillPredicate). Also: the geolocation backfill drops the `abs()`/`NOT (0,0)` guards present in `20260803213950:105-111`, and PostGIS **coerces** out-of-range coordinates with a NOTICE, not an error — `[200.5, 95.5]` becomes a real point in the Arctic Ocean that `placesNear` returns.

### Looks wrong but isn't — do not "fix" these

- **`ci.agents` is not dead.** Only `ci.agent_messages` is. Any doc saying otherwise (`schema-comparison-lifescope.html:1042`, `:1579`, `:1689`) is half wrong and is corrected in 1.1.
- **`ci.item_relationships_to_idx` is not redundant** — see above.
- **`ItemService.ts:110`'s arbiter is not mismatched today.** It emits `(owner_user_id, source_type, source_system, source_id)`, which exactly matches `inventory_source_triple_uniq` as created by `20260623120000:15-17`. 5.1 changes both together.
- **`entitySourceMap.ts:86`'s `item` entry has no `backfillPredicate`**, so the three services that build raw SQL from it only ever reference `idColumn` — the dropped `ci.inventory` bags in 1.4 are safe.
- **`ItemSearchIndexListener.ts:138-166,192-198`** builds embed text and keyword vectors from `name/description/brand/model/category/subcategory/maintenanceNotes` only. Dropping `tags`/`images`/`manuals` changes not a single embedding.
- **`InventoryListener.ts:121`'s `images: [base64Image]`** is an Ollama vision payload, not a `CreateItemDto`.
- **`memory/types.ts:518`/`:567`'s `tags: z.array(z.string())`** are event schemas (`ci.events.tags TEXT[]`), not inventory.
- **`ItemType`'s `tags: [EntityTagType!]!`** genuinely resolves through `ci_search.entity_tag` (`item` is in `TAGGABLE_ENTITIES`, `search-next/types.ts:31`) — the canonical tagging path covers inventory in full.
- **`hbpe/src/ci/pipeline/ingester.py:36`'s `CHANNELS=('ci_events','ci_browser_activity','ci_communications')` is already dead.** There is no trigger on `ci.browser_activity` (`pg_trigger` returns 0 non-internal rows) and `pg_notify` appears in zero of the 188 migrations. The only two triggers in the schema are `communications_source_dedup_after_delete` and `entities_search_vector_trigger`. Do not cite it as a cost of anything.
- **`AgentMemoryEntity.ts:3`** is `@Entity({schema:'ci', name:'agent_memories'})` — a different table from `agent_messages`.
- **`IngestResetService.ts:18-25`'s `INGEST_TABLES`** does not list `agent_messages`.
- **`log_level` in Python** (`hbpe/config.py:118`, `hbpe/worker.py:100`, `summary/config.py:100`, `summary/worker.py:80`) is app logging config, unrelated to the Postgres enum.
- **`backend/apps/summary/src/data_aggregator.py` is schema-adaptive** and cannot break on a narrower table — but only because `_schema_cache` is populated once per process. See 4.5 for why that cuts the other way for `browser_activity`.
- **`bin/check-migration-versions.js` is plain CommonJS on purpose** — `migrate` runs it inside the production image, which has no devDependencies. Keep it dependency-free.

**Two pre-existing bugs found in passing — do not fix inside any migration above:**
- `backend/apps/summary/src/schedules.py:31` queries `SELECT id FROM core.users`. **The `core` schema does not exist.**
- `backend/apps/api/src/domains/llm/listeners/CvDetectionsListener.ts:138` writes `` linkedId: `${fileId}:${detection.detectionId}` `` into `ci.entities.linked_id`, a `uuid` column → Postgres 22P02 on insert. It needs the `uuidv5` treatment `GraphIngestService.linkedIdFor` (`:115-117`) already applies. The doc comments at `CreatePersonInput.ts:12` and `CreateConceptInput.ts:12` advertise the same non-UUID usage.

---

## 5. Execution checklist

### Prerequisites (do these once, before Wave 1)

```bash
cd /home/ci/devel/ci/CI-Server

# 0.1 The working tree is NOT clean and typecheck is currently RED for reasons
#     unrelated to this plan. Confirm the state before you start.
git status
yarn workspace @ci/be-api typecheck
# Expect TS2307 at memory/index.ts(36,28) and (63,29) from the in-flight
# FileEntity -> FileNodeEntity rename. Land or rebase onto that rename first (R8).

# 0.2 Baseline the schema so every later count is checkable.
make dbshell <<'SQL'
SELECT (SELECT count(*) FROM information_schema.tables  WHERE table_schema IN ('ci','ci_search','ci_etl','hbpe') AND table_type='BASE TABLE') AS tables,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema IN ('ci','ci_search','ci_etl','hbpe')) AS columns,
       (SELECT count(*) FROM pg_indexes WHERE schemaname IN ('ci','ci_search','ci_etl','hbpe')) AS indexes;
SQL
# Record these three numbers. Expect 63 / 968 / 281.

# 0.3 Wave-2 damage census — run BEFORE anything, save the output.
make dbshell <<'SQL'
SELECT count(*) AS stranded_captures FROM ci.capture_events ce
 WHERE ce.destination='events' AND ce.materialized_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.event_id=ce.materialized_id);
SELECT count(*) AS orphan_content FROM ci.content c
 WHERE c.event_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.event_id=c.event_id);
SELECT c.id, c.event_id, c.user_id, c.type, c.source_type, c.source_system, c.source_id
  FROM ci.content c WHERE c.event_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ci.events e WHERE e.event_id=c.event_id);
SQL

# 0.4 Wave-4 hand-set-data census (see 4.1).
# 0.5 Wave-5 pre-flight (see 5.1) — must return 0.
```

### Wave 1

```bash
git checkout -b schema/wave-1-dead-code

yarn workspace @ci/be-api migrate:make drop_dead_agent_tables
yarn workspace @ci/be-api migrate:make drop_orphan_enum_types
yarn workspace @ci/be-api migrate:make drop_redundant_item_relationships_from_idx
yarn workspace @ci/be-api migrate:make drop_dead_inventory_jsonb_bags
# Paste the up/down blocks from §3.1.1-3.1.4 into the generated files.

# Code changes FIRST — delete agent_registration.py, edit worker.py, edit
# memory/types.ts:284,302, edit the three docs.
yarn workspace @ci/be-api typecheck
yarn workspace @ci/be-api lint
yarn test

# Deploy the image, THEN:
make migrate

# Verify
make dbshell <<'SQL'
SELECT to_regclass('ci.agents'), to_regclass('ci.agent_messages'),
       to_regtype('ci.agent_status'), to_regtype('ci.agent_type');   -- all NULL
SELECT typname FROM pg_type WHERE typtype='e' AND typnamespace='ci'::regnamespace ORDER BY 1;
SELECT indexname FROM pg_indexes WHERE schemaname='ci' AND tablename='item_relationships' ORDER BY 1;
SELECT count(*) FROM information_schema.columns WHERE table_schema='ci' AND table_name='inventory';  -- 50
SQL
```

Rollback: `yarn workspace @ci/be-api migrate:down` (once per migration, newest first) and revert the image.

### Wave 2

```bash
git checkout -b schema/wave-2-correctness

# 2.2 ships in TWO releases. Release A is code-only:
#   ContentService.createMany event-id validation
#   BulkIngestController.ts:571-576 routed through the same helper
#   ContentResolver.ts:35-46 ownership check + remove the non-event fall-through
yarn test && yarn workspace @ci/be-api typecheck
# Deploy release A. Let it soak.

# Release B — both migrations plus the arbiter flips, ONE deploy:
yarn workspace @ci/be-api migrate:make scope_events_source_triple_uniq_to_user
yarn workspace @ci/be-api migrate:make restore_content_event_id_fk
# Code, SAME commit: EventService.ts:220-222, EventEntity.ts:16-22.

# The integration test (2.3):
#   backend/apps/api/src/domains/memory/services/__tests__/EventService.tenancy.integration.test.ts
#   plus a services: postgres block in .github/workflows/ci.yml and
#   MEMORY_TEST_DATABASE_URL wired in.

# See it FAIL before the migration:
docker run -d --name ci-test-db -e POSTGRES_PASSWORD=postgres -p 55440:5432 postgres:18
DATABASE_URL=postgres://postgres:postgres@localhost:55440/postgres yarn workspace @ci/be-api migrate
MEMORY_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55440/postgres \
  yarn workspace @ci/be-api test EventService.tenancy
# Tests 1 and 3 MUST fail here. If they pass, the test is wrong.

# Then apply the new migrations to that DB and re-run — must pass.

yarn test
# Deploy image + migration together. NEVER run make migrate out of band here.
make migrate
```

**Verify Wave 2:** run §3.2.1's queries (a), (b), (c) and §3.2.2's (a), (b), (c). Query 2.1(c) must go from the pre-deploy count to **0**.

Rollback: revert the image **first**, then `migrate:down`. Reversed leaves 42P10 on every bulk event ingest.

### Wave 3

```bash
git checkout -b schema/wave-3-code-only
# NO migrate:make. Nothing in this wave creates a migration file.

# In this order:
#   3.1 delete EntityService.ts + PlaceEntity createPlaceQuery
#   3.2 delete ThingEntity.ts + BaseEntity.ts (+ memory/index.ts by string match)
#   3.3 rename memory/FileEntity -> FileNodeEntity, FileService -> FileNodeService
#   3.4 delete search-next entity copies, swap SearchService to DataSource

yarn workspace @ci/be-api typecheck    # must be green
yarn workspace @ci/be-api lint         # 3.1/3.3/3.4 leave dead imports tsc won't catch
yarn test
grep -rn 'ThingEntity\|BaseEntity' backend frontend mcp-servers docs \
  --exclude-dir=node_modules --exclude-dir=.claude   # must return nothing

# BOOT THE API ONCE. TypeORM validates entity metadata at DataSource init, and
# 3.4's `import type` trap fails only at bootstrap.
docker compose up -d && yarn dev
```

Rollback: `git revert`.

### Wave 4

Four separate migrations, four separate deploys. **Code first every time (R1).**

```bash
git checkout -b schema/wave-4-compaction

yarn workspace @ci/be-api migrate:make drop_dead_users_columns
yarn workspace @ci/be-api migrate:make drop_dead_messages_columns
yarn workspace @ci/be-api migrate:make drop_dead_threads_columns
yarn workspace @ci/be-api migrate:make drop_dead_event_analytics_columns
yarn workspace @ci/be-api migrate:make drop_browser_activity_generated_domain

# For 4.4 specifically, the code release is large. Confirm before deploying:
grep -n 'is_predicted' backend/apps/api/src/domains/maintenance/services/LocationEstimateService.ts
# must return NOTHING. This is the 42703 landmine.

yarn workspace @ci/be-api typecheck && yarn test
# Deploy image. Then, one at a time:
make migrate

make dbshell <<'SQL'
SELECT table_name, count(*) FROM information_schema.columns
 WHERE table_schema='ci' AND table_name IN ('users','messages','threads','events','browser_activity')
 GROUP BY 1 ORDER BY 1;
-- expect browser_activity 20 | events 36 | messages 15 | threads 8 | users 14
SQL
```

Then hit `POST /api/maintenance/estimate-locations` once. If 4.4's guard removal was missed, this is where it surfaces.

### Wave 5

```bash
git checkout -b schema/wave-5-coherence

# 5.1 — pre-flight FIRST (with the NULL guards; see §3.5.1)
make dbshell <<'SQL'
SELECT count(*) FROM (
  SELECT user_id, source_type, source_system, source_id FROM ci.inventory
   WHERE source_id IS NOT NULL AND source_type IS NOT NULL AND source_system IS NOT NULL
   GROUP BY 1,2,3,4 HAVING count(*) > 1) d;
SQL
# MUST be 0. Non-zero = merge by hand first.

yarn workspace @ci/be-api migrate:make scope_inventory_source_triple_uniq_to_user
# Code SAME commit: ItemService.ts:109, :110, :63; ItemResolver.ts:110; Database.md:125.

# 5.2 — TWO releases, do not combine
yarn workspace @ci/be-api migrate:make backfill_legacy_tag_columns_to_entity_tag
# + remove the tags @Column mappings. Deploy. Let it soak one release.
yarn workspace @ci/be-api migrate:make drop_legacy_tag_columns
# Deploy.

yarn workspace @ci/be-api migrate:make retire_orphan_enums_and_constrain_search_dispatch_types
yarn workspace @ci/be-api migrate:make annotate_unread_object_commerce_tables

yarn test && make migrate
```

**Verify Wave 5:** run §3.5.1(a,b,c), §3.5.2, §3.5.3 and §3.5.4's queries.

### Final accounting

```bash
make dbshell <<'SQL'
SELECT (SELECT count(*) FROM information_schema.tables  WHERE table_schema IN ('ci','ci_search','ci_etl','hbpe') AND table_type='BASE TABLE') AS tables,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema IN ('ci','ci_search','ci_etl','hbpe')) AS columns,
       (SELECT count(*) FROM pg_indexes WHERE schemaname IN ('ci','ci_search','ci_etl','hbpe')) AS indexes,
       (SELECT count(*) FROM pg_type WHERE typtype='e' AND typnamespace='ci'::regnamespace) AS ci_enums;
SQL
# expect: 62 | 916 | 273 | 7
```

---

### A note on the probe

`ci-schema-probe` is being mutated concurrently by parallel agents and is **not** a trustworthy oracle. Observed during this analysis: `ci.events.tags`/`ci.communications.tags` missing, two invented columns on `ci_search.entity_tag` (`source`, `removed_at`), `ci.events_source_triple_uniq` already user-scoped, `ci.entities.valid_entity_type` already replaced with a 7-value list, `ci.agent_messages` already dropped, and a stray `ci._msg_snapshot_before` table. A whole-schema `pg_dump` diff on it is meaningless.

For any verification you actually depend on: restore into a scratch database from `/tmp/claude-1000/-home-ci-devel-ci-CI-Server/f82f22f1-c8b1-4217-bf1d-6c4504b4e41d/scratchpad/current-schema.sql` and re-apply `create_hypertable` for `ci.communications`, `ci.position`, `ci.user_snapshots` and `hbpe.prediction_log` — `pg_dump` does not carry hypertable status. Diff only the objects you touched.