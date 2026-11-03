import { GlobalUID } from '@ci/common';
import { describe, expect, it, vi } from 'vitest';

import {
  createLocalSavedSearch,
  deleteLocalSavedSearch,
  matchesSavedSearchQuery,
  parseFilters,
  parseFlag,
  parseStringList,
  renameLocalSavedSearch,
  toLocalSavedSearch,
  toResolvedSavedSearch,
  updateLocalSavedSearch,
} from './localSavedSearches';

function fakeDb() {
  const execute = vi.fn(async () => ({ rowsAffected: 1 }));

  return { db: { execute } as never, execute };
}

describe('toLocalSavedSearch', () => {
  it('parses the JSON text PowerSync delivers for arrays, filters and 0/1 flags', () => {
    const search = toLocalSavedSearch({
      id: 'ss-1',
      name: 'Work emails',
      description: null,
      query: 'quarterly',
      entity_types: '["communication"]',
      tags: '["work","email"]',
      filters: '{"direction":"inbound","connectors":["gmail"],"areas":[[1,2,3,4]]}',
      is_public: 1,
      is_seed: 0,
      share_token: 'tok',
      created_at: '2026-10-26T10:00:00Z',
      updated_at: '2026-10-26T11:00:00Z',
    });

    expect(search).toEqual({
      id: 'ss-1',
      name: 'Work emails',
      description: null,
      query: 'quarterly',
      entityTypes: ['communication'],
      tags: ['work', 'email'],
      filters: { direction: 'inbound', connectors: ['gmail'], areas: [[1, 2, 3, 4]] },
      isPublic: true,
      shareToken: 'tok',
      isSeed: false,
      createdAt: '2026-10-26T10:00:00Z',
      updatedAt: '2026-10-26T11:00:00Z',
    });
  });

  it('treats NULL, malformed and wrongly typed JSON as empty rather than throwing', () => {
    expect(parseStringList(null)).toEqual([]);
    expect(parseStringList('not json')).toEqual([]);
    expect(parseStringList('{"a":1}')).toEqual([]);
    expect(parseStringList('["a",1,null,"b"]')).toEqual(['a', 'b']);
    expect(parseFilters(null)).toBeNull();
    expect(parseFilters('[1]')).toBeNull();
    expect(parseFilters('{')).toBeNull();
    expect(parseFlag(null)).toBe(false);
    expect(parseFlag('true')).toBe(true);
    expect(parseFlag(true)).toBe(true);
    expect(parseFlag(0)).toBe(false);
  });
});

describe('matchesSavedSearchQuery', () => {
  const search = toLocalSavedSearch({
    id: 's',
    name: 'Trips',
    description: 'Flights and hotels',
    query: null,
    entity_types: null,
    tags: '["travel"]',
    filters: null,
    is_public: 0,
    is_seed: 0,
    share_token: null,
    created_at: null,
    updated_at: null,
  });

  it("matches the appliance's rule: name, description or a tag, case-insensitively; blank matches all", () => {
    expect(matchesSavedSearchQuery(search, '')).toBe(true);
    expect(matchesSavedSearchQuery(search, 'TRIP')).toBe(true);
    expect(matchesSavedSearchQuery(search, 'hotel')).toBe(true);
    expect(matchesSavedSearchQuery(search, 'trav')).toBe(true);
    expect(matchesSavedSearchQuery(search, 'work')).toBe(false);
  });
});

describe('toResolvedSavedSearch', () => {
  it('hands the explorer the GraphQL shape with the base64 global id', () => {
    const resolved = toResolvedSavedSearch(
      toLocalSavedSearch({
        id: 'ss-1',
        name: 'n',
        description: 'd',
        query: 'q',
        entity_types: '["place"]',
        tags: '[]',
        filters: '{"view":"map"}',
        is_public: 0,
        is_seed: 1,
        share_token: null,
        created_at: null,
        updated_at: null,
      }),
    );

    expect(resolved.id).toBe(GlobalUID.encode('saved-search', 'ss-1'));
    expect(resolved).toMatchObject({
      name: 'n',
      entityTypes: ['place'],
      filters: { view: 'map' },
      isSeed: true,
    });
  });
});

describe('local writes', () => {
  it('creates under the given id with the arrays and filters as JSON text, never a seed', async () => {
    const { db, execute } = fakeDb();

    await createLocalSavedSearch(db, {
      id: 'ss-new',
      name: 'Beatles',
      query: 'beatles',
      entityTypes: ['communication'],
      tags: ['music'],
      filters: { connectors: ['gmail'] },
    });

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]];

    expect(sql).toContain('INSERT INTO saved_searches');
    expect(sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?)');
    expect(params.slice(0, 7)).toEqual([
      'ss-new',
      'Beatles',
      null,
      'beatles',
      '["communication"]',
      '["music"]',
      '{"connectors":["gmail"]}',
    ]);
  });

  it('writes every dimension on update so a removed filter reaches the row', async () => {
    const { db, execute } = fakeDb();

    await updateLocalSavedSearch(db, { id: 'ss-1', name: 'Beatles', query: null, filters: null });

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]];

    expect(sql).toContain('UPDATE saved_searches');
    expect(sql).toContain(
      'SET name = ?, description = ?, query = ?, entity_types = ?, tags = ?, filters = ?, updated_at = ?',
    );
    expect(params.slice(0, 6)).toEqual(['Beatles', null, null, '[]', '[]', null]);
    expect(params[7]).toBe('ss-1');
  });

  it('renames without touching the definition, and deletes by id', async () => {
    const { db, execute } = fakeDb();

    await renameLocalSavedSearch(db, { id: 'ss-1', name: 'New', description: null });
    await deleteLocalSavedSearch(db, 'ss-1');

    expect((execute.mock.calls[0] as unknown as [string])[0]).toContain(
      'SET name = ?, description = ?, updated_at = ?',
    );
    expect(execute.mock.calls[1]).toEqual(['DELETE FROM saved_searches WHERE id = ?', ['ss-1']]);
  });
});
