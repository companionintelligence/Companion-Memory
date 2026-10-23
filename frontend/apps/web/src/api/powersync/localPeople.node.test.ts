import { describe, expect, it } from 'vitest';

import { localPeopleCountStatement, localPeopleStatement } from './localPeople';

describe('localPeopleStatement', () => {
  it('browses the person records by name through the type index, unnamed last', () => {
    const statement = localPeopleStatement('', { limit: 30, offset: 60 })!;

    expect(statement.sql).toContain("WHERE d.entity_type = 'person'");
    expect(statement.sql).toContain('ORDER BY d.title IS NULL, d.title COLLATE NOCASE, d.id');
    expect(statement.sql).not.toContain('MATCH');
    expect(statement.params).toEqual([30, 60]);
  });

  it('ranks a query through the FTS index with the type term off its own index', () => {
    const statement = localPeopleStatement('bri paul', { limit: 30, offset: 0 })!;

    expect(statement.sql).toContain('mobile_search_documents_fts MATCH ?');
    expect(statement.sql).toContain("+d.entity_type = 'person'");
    expect(statement.sql).toContain(
      'ORDER BY bm25(mobile_search_documents_fts, 10.0, 1.0, 0.0, 0.0, 0.0), d.id',
    );
    expect(statement.params).toEqual(['{title body}: ("bri"* OR "paul"*)', 30, 0]);
  });

  it('matches nothing for a query of punctuation', () => {
    expect(localPeopleStatement('!!!', { limit: 30, offset: 0 })).toBeNull();
    expect(localPeopleCountStatement('!!!')).toBeNull();
  });

  it('counts with the same filter', () => {
    expect(localPeopleCountStatement('')!.sql).toContain("WHERE d.entity_type = 'person'");
    expect(localPeopleCountStatement('ana')!.params).toEqual(['{title body}: ("ana"*)']);
  });
});
