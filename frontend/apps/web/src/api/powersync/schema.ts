/**
 * On-device SQLite schema for PowerSync local-first sync.
 *
 * Table/column shapes here MUST mirror `infrastructure/powersync/sync-rules.yaml`
 * exactly — that file is the source of truth for what each bucket's `data` query
 * selects, and PowerSync silently drops any synced column that isn't declared here
 * (it parks the rows in `ps_untyped`, where nothing can read them). Table names
 * match the sync rules' client-facing `id`-aliased shape, not the raw Postgres
 * table/column names.
 *
 * Every `Table` gets an implicit `id TEXT PRIMARY KEY` column — do not declare `id`
 * explicitly, per the `@powersync/web` `Table` API.
 *
 * ONE DEVICE RECORD PER ENTITY (2026-10-21): the phone keeps one row per
 * searchable entity in the `mobile_search_documents` raw table (below) and reads
 * nothing else for search, the offline Memory list or the offline record page.
 * `events`, `entities`, `files`, `threads` and `messages` used to sync as whole
 * rows and were never read by any client code; they left the sync rules and this
 * schema together. See docs/architecture/mobile-local-search-plan.md, "Revision
 * 2026-10-21", for the reasoning and the measurements.
 *
 * Write support (see `./connector.ts`) exists for `notes` only. `tags` and
 * `entity_tag` are read replicas: a local write against them would be accepted
 * into the CRUD queue, but the connector has nothing to replay it through.
 */
import { AttachmentTable } from '@powersync/attachments';
import { column, Schema, Table } from '@powersync/web';

import { DOCUMENTS_RAW_TABLE, DOCUMENTS_TABLE } from './searchIndex';

// Writable: something the user writes in this app and may edit offline. The
// connector replays local changes through the `createNote` / `updateNote` /
// `deleteNote` mutations.
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

// Read-only. Which tag is on which entity, so a tag filter can apply offline:
// joined to the device records on (entity_type, entity_id). Synced through its
// own bucket, scoped by the tag's owner (the `entity_tags` bucket in the sync
// rules), since the row carries no user_id of its own. `id` is the server's
// bigint identity, sent as text.
const entity_tag = new Table(
  {
    entity_type: column.text,
    entity_id: column.text,
    tag_id: column.text,
    created_at: column.text,
  },
  { indexes: { entity: ['entity_type', 'entity_id'], tag: ['tag_id'] } },
);

// Local-only (never synced): the preview store's ledger — one row per photo or
// video preview this phone holds or is fetching, keyed by the original file's
// id, with the file's path under the app's data directory. See previews.ts.
const attachments = new AttachmentTable();

export const AppSchema = new Schema({
  notes,
  tags,
  entity_tag,
  attachments,
});

// The device record, `mobile_search_documents` (ci_search.mobile_search_documents,
// migrations 20261019212935 and 20261021203300), is a RAW table: the app
// creates and owns the SQLite table (searchIndex.ts) and the sync client
// writes it with these statements instead of through a `ps_data__*` JSON
// table and a view. Its columns are therefore declared there, next to the
// DDL, not here. `withRawTables` is keyed by the name the sync service sends,
// which is the sync rule's table name.
AppSchema.withRawTables({ [DOCUMENTS_TABLE]: DOCUMENTS_RAW_TABLE });

export type Database = (typeof AppSchema)['types'];
