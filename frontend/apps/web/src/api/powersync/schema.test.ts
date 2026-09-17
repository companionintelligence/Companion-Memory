import { describe, expect, it } from 'vitest';

import { AppSchema } from './schema';

function columnNames(tableName: string): string[] {
  const table = AppSchema.tables.find((t) => t.name === tableName);

  if (!table) {
    throw new Error(`No table named "${tableName}" in AppSchema`);
  }

  // `id` is an implicit column PowerSync adds to every table, not part of the
  // declared columns array.
  return table.columns.map((c) => c.name);
}

describe('AppSchema', () => {
  it('validates without throwing', () => {
    expect(() => AppSchema.validate()).not.toThrow();
  });

  it('declares every table from sync-rules.yaml', () => {
    const names = AppSchema.tables.map((t) => t.name).sort();

    expect(names).toEqual(['entities', 'events', 'files', 'messages', 'notes', 'tags', 'threads']);
  });

  // Column sets mirror infrastructure/powersync/sync-rules.yaml's `data` selects
  // exactly (minus `id`, which every Table gets implicitly).
  it('notes matches the user_data bucket select', () => {
    expect(columnNames('notes').sort()).toEqual(['content', 'created_at', 'title', 'updated_at', 'user_id']);
  });

  it('tags matches the user_data bucket select', () => {
    expect(columnNames('tags').sort()).toEqual([
      'created_at',
      'deleted_at',
      'description',
      'label',
      'updated_at',
      'user_id',
    ]);
  });

  it('threads matches the user_data bucket select (thread_id aliased to id)', () => {
    expect(columnNames('threads').sort()).toEqual([
      'created_at',
      'is_archived',
      'last_message_at',
      'status',
      'summary',
      'title',
      'updated_at',
      'user_id',
    ]);
  });

  it('messages matches the user_data bucket select (message_id aliased to id)', () => {
    expect(columnNames('messages').sort()).toEqual([
      'content',
      'content_type',
      'created_at',
      'role',
      'sequence_number',
      'thread_id',
      'updated_at',
      'user_id',
    ]);
  });

  it('events matches the user_data bucket select (event_id aliased to id)', () => {
    expect(columnNames('events').sort()).toEqual([
      'capture_tick_id',
      'category',
      'created_at',
      'end_time',
      'event_type',
      'is_all_day',
      'is_inferred',
      'is_predicted',
      'is_private',
      'observed_at',
      'parent_event_id',
      'priority',
      'sharing_level',
      'source_id',
      'source_system',
      'source_type',
      'start_time',
      'status',
      'sync_period',
      'task_id',
      'updated_at',
      'user_id',
    ]);
  });

  // The two columns this asserts the ABSENCE of are the point of the projection,
  // not an oversight. `metadata` is the raw capture payload — window titles, cwd,
  // established connections — and never syncs; `duration_minutes` is GENERATED and
  // Postgres does not replicate it under this publication (pubgencols='n'), so
  // declaring it would create a column that silently stays null forever.
  it('events does not mirror the raw capture payload or the generated column', () => {
    expect(columnNames('events')).not.toContain('metadata');
    expect(columnNames('events')).not.toContain('duration_minutes');
  });

  it('entities matches the user_data bucket select (entity_id aliased to id)', () => {
    expect(columnNames('entities').sort()).toEqual([
      'created_at',
      'description',
      'entity_type',
      'is_active',
      'is_archived',
      'linked_id',
      'linked_table',
      'name',
      'sync_period',
      'updated_at',
      'user_id',
    ]);
  });

  // ci.entities is the whole entity graph server-side — people, places, things,
  // with names, birth dates, geography and dossiers. Only the Event-typed slice
  // syncs, and only the columns needed to label an event. Anything here that
  // looks like the rest of that table means the projection widened by accident.
  it('entities carries no personal-graph columns', () => {
    for (const column of [
      'first_name',
      'last_name',
      'birth_date',
      'dossier',
      'location_point',
      'search_vector',
    ]) {
      expect(columnNames('entities')).not.toContain(column);
    }
  });
});
