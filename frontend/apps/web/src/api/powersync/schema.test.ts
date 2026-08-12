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

    expect(names).toEqual(['files', 'messages', 'notes', 'tags', 'threads']);
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
});
