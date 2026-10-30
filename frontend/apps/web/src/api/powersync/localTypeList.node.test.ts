import { describe, expect, it } from 'vitest';

import { localTypeListCountStatement, localTypeListStatement } from './localTypeList';

describe('localTypeListStatement', () => {
  it('browses a type by name through the type index, unnamed last', () => {
    const statement = localTypeListStatement('place', 'title', '', { limit: 30, offset: 60 })!;

    expect(statement.sql).toContain('WHERE d.entity_type = ?');
    expect(statement.sql).toContain('ORDER BY d.title IS NULL, d.title COLLATE NOCASE, d.id');
    expect(statement.sql).not.toContain('MATCH');
    expect(statement.params).toEqual(['place', 30, 60]);
  });

  it('browses a bulk type newest first, so the (type, time) index walks the rows in order', () => {
    const statement = localTypeListStatement('content', 'newest', '', { limit: 30, offset: 0 })!;

    expect(statement.sql).toContain('WHERE d.entity_type = ?');
    expect(statement.sql).toContain('ORDER BY d.occurred_at DESC, d.id');
    expect(statement.params).toEqual(['content', 30, 0]);
  });

  it('ranks a query through the FTS index with the type term off its own index', () => {
    const statement = localTypeListStatement('receipt', 'newest', 'whole foods', { limit: 30, offset: 0 })!;

    expect(statement.sql).toContain('mobile_search_documents_fts MATCH ?');
    expect(statement.sql).toContain('+d.entity_type = ?');
    expect(statement.sql).toContain('ORDER BY bm25(mobile_search_documents_fts, 10.0, 1.0), d.id');
    expect(statement.params).toEqual(['"whole"* OR "foods"*', 'receipt', 30, 0]);
  });

  it('matches nothing for a query of punctuation', () => {
    expect(localTypeListStatement('item', 'title', '!!!', { limit: 30, offset: 0 })).toBeNull();
    expect(localTypeListCountStatement('item', '!!!')).toBeNull();
  });

  it('counts with the same filter', () => {
    const browse = localTypeListCountStatement('item', '')!;

    expect(browse.sql).toContain('WHERE d.entity_type = ?');
    expect(browse.params).toEqual(['item']);
    expect(localTypeListCountStatement('item', 'lamp')!.params).toEqual(['"lamp"*', 'item']);
  });
});
