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

  // One device record per entity (2026-10-21): the managed tables are the
  // writable notes and saved searches (2026-10-26), the tags and the tag join;
  // everything else the phone shows comes from the raw documents table below. `events`, `entities`,
  // `files`, `threads` and `messages` were synced and never read, and left
  // the sync rules and this schema together — one of them reappearing here
  // means the replica grew back by accident.
  it('declares exactly the managed tables sync-rules.yaml still sends, plus the local-only preview ledger', () => {
    const names = AppSchema.tables.map((t) => t.name).sort();

    expect(names).toEqual(['attachments', 'entity_tag', 'notes', 'saved_searches', 'tags']);
    expect(AppSchema.tables.find((t) => t.name === 'attachments')?.localOnly).toBe(true);
  });

  // Column sets mirror infrastructure/powersync/sync-rules.yaml's `data` selects
  // exactly (minus `id`, which every Table gets implicitly).
  it('notes matches the user_data bucket select', () => {
    expect(columnNames('notes').sort()).toEqual(['content', 'created_at', 'title', 'updated_at', 'user_id']);
  });

  it('saved_searches matches the user_data bucket select', () => {
    expect(columnNames('saved_searches').sort()).toEqual([
      'created_at',
      'description',
      'entity_types',
      'filters',
      'is_public',
      'is_seed',
      'name',
      'query',
      'share_token',
      'tags',
      'updated_at',
      'user_id',
    ]);
  });

  it('mobile_search_documents is a raw table whose put binds every column the device keeps', () => {
    // The sync rule sends id, entity_type, entity_id, title, body, occurred_at,
    // related_id, detail — and nothing else, since every synced column is also
    // kept in PowerSync's oplog copy.
    expect(AppSchema.rawTables.map((t) => t.name)).toEqual(['mobile_search_documents']);

    const raw = AppSchema.rawTables[0];

    expect(raw.put?.params).toEqual([
      'Id',
      { Column: 'entity_type' },
      { Column: 'entity_id' },
      { Column: 'title' },
      { Column: 'body' },
      { Column: 'occurred_at' },
      { Column: 'related_id' },
      { Column: 'detail' },
    ]);
    expect(raw.put?.sql).toContain('ON CONFLICT(id) DO UPDATE');
    // A re-sent row must refresh the record half too, not just the text.
    expect(raw.put?.sql).toContain('related_id = excluded.related_id');
    expect(raw.put?.sql).toContain('detail = excluded.detail');
    expect(raw.delete?.params).toEqual(['Id']);
    expect(raw.clear).toBe('DELETE FROM mobile_search_documents');
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

  it('entity_tag matches the entity_tags bucket select (bigint id sent as text), indexed for the offline tag filter', () => {
    expect(columnNames('entity_tag').sort()).toEqual(['created_at', 'entity_id', 'entity_type', 'tag_id']);

    const table = AppSchema.tables.find((t) => t.name === 'entity_tag')!;
    const indexed = table.indexes.map((index) => index.columns.map((column) => column.name));

    expect(indexed).toContainEqual(['entity_type', 'entity_id']);
    expect(indexed).toContainEqual(['tag_id']);
  });
});
