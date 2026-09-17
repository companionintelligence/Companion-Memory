/**
 * On-device SQLite schema for PowerSync local-first sync.
 *
 * Table/column shapes here MUST mirror `infrastructure/powersync/sync-rules.yaml`
 * exactly — that file is the source of truth for what each bucket's `data` query
 * selects, and PowerSync silently drops any synced column that isn't declared here.
 * Table names match the sync rules' client-facing `id`-aliased shape (e.g. `threads`,
 * not the raw `ci.threads` Postgres table with its `thread_id` PK), not the raw
 * Postgres table/column names.
 *
 * Every `Table` gets an implicit `id TEXT PRIMARY KEY` column — do not declare `id`
 * explicitly, per the `@powersync/web` `Table` API.
 *
 * Write support (see `./connector.ts`) exists for `notes` only in this pass. Every
 * other table below is a read replica: local inserts/updates/deletes against them
 * would be accepted into the CRUD queue but the connector has nothing to replay them
 * through, so `NoteResolver`/`TagResolver`-equivalent UI must not be built against
 * these tables yet. See `connector.ts` for the per-table rationale.
 */
import { column, Schema, Table } from '@powersync/web';

const notes = new Table({
  title: column.text,
  content: column.text,
  user_id: column.text,
  created_at: column.text,
  updated_at: column.text,
});

// Read-only. `ci_search.tags` has no standalone create/update/delete GraphQL
// mutation — TagResolver only exposes `tagEntities`/`untagEntities`, which mutate
// the entity_tag join (and create tags incidentally, keyed by label) rather than a
// tag by id. Writing this table's CRUD replay would mean guessing at a mutation
// shape that doesn't exist, which the connector explicitly avoids. See
// `connector.ts`'s module comment for the full rationale.
const tags = new Table({
  label: column.text,
  description: column.text,
  user_id: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

// Read-only. Threads are REST-only CRUD server-side — no GraphQL mutation exists.
const threads = new Table({
  user_id: column.text,
  title: column.text,
  summary: column.text,
  status: column.text,
  // SQLite has no BOOLEAN type; PowerSync/Postgres booleans arrive as 0/1.
  is_archived: column.integer,
  created_at: column.text,
  updated_at: column.text,
  last_message_at: column.text,
});

// Read-only. A message is only ever created as a side effect of POST
// /llm/generate (which also triggers live LLM inference) — there is no standalone
// "create message" mutation to replay a local insert through.
const messages = new Table({
  thread_id: column.text,
  user_id: column.text,
  role: column.text,
  content: column.text,
  content_type: column.text,
  sequence_number: column.integer,
  created_at: column.text,
  updated_at: column.text,
});

// Read-only, metadata only — the binary lives in Minio and is fetched via a signed
// URL, never synced. Lower priority per the integration plan; included for
// completeness since sync-rules.yaml already exposes the full row.
const files = new Table({
  filename: column.text,
  content_type: column.text,
  size: column.integer,
  width: column.integer,
  height: column.integer,
  variant: column.text,
  title: column.text,
  description: column.text,
  bucket: column.text,
  key: column.text,
  hash: column.text,
  external_id: column.text,
  parent_id: column.text,
  user_id: column.text,
  external_created_at: column.text,
  external_updated_at: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

// Read-only. Events are written server-side — CI-Capture's vizier and file-edit
// lanes POST /v1/events, which materializes into ci.events — and there is no
// mutation to replay a local insert through.
//
// Only rows inside the device window arrive (sync-rules.yaml filters on
// sync_period, which SyncWindowSweepCron clears to evict), and vizier_patch rows
// never do: they are JSON Patches a client has no way to fold.
//
// `metadata` is deliberately absent, matching the sync rule — it is the raw
// capture payload (window titles, cwd, established connections) and is not
// synced. The human-readable text is on `entities`, joined locally on id.
//
// duration_minutes is absent and cannot be added: it is a Postgres GENERATED
// column and this publication does not replicate generated columns. Derive it
// from start_time/end_time on device.
const events = new Table({
  user_id: column.text,
  event_type: column.text,
  category: column.text,
  status: column.text,
  start_time: column.text,
  end_time: column.text,
  observed_at: column.text,
  sync_period: column.text,
  source_type: column.text,
  source_system: column.text,
  source_id: column.text,
  capture_tick_id: column.text,
  // SQLite has no BOOLEAN type; PowerSync/Postgres booleans arrive as 0/1.
  is_all_day: column.integer,
  is_private: column.integer,
  sharing_level: column.text,
  priority: column.integer,
  is_predicted: column.integer,
  is_inferred: column.integer,
  parent_event_id: column.text,
  task_id: column.text,
  created_at: column.text,
  updated_at: column.text,
});

// Read-only. The CTI name rows for the events above: migration
// 20260811061409_convert_events_to_cti moved title/description off ci.events onto
// ci.entities, keyed entities.entity_id = events.event_id. Sync rules cannot
// JOIN, so both tables sync and the join happens here —
//   SELECT e.*, n.name, n.description
//     FROM events e LEFT JOIN entities n ON n.id = e.id
// — which is why an event's label is a local join, not a column.
//
// Only entity_type = 'Event' rows ever sync. People, places and things keep a
// NULL sync_period server-side and are filtered out by the same predicate that
// bounds the window, so none of their names, birth dates, geography or dossiers
// reach a device.
const entities = new Table({
  user_id: column.text,
  entity_type: column.text,
  name: column.text,
  description: column.text,
  linked_table: column.text,
  linked_id: column.text,
  is_active: column.integer,
  is_archived: column.integer,
  sync_period: column.text,
  created_at: column.text,
  updated_at: column.text,
});

export const AppSchema = new Schema({
  notes,
  tags,
  threads,
  messages,
  files,
  events,
  entities,
});

export type Database = (typeof AppSchema)['types'];
