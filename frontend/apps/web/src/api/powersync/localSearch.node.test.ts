import { GlobalUID } from '@ci/common';
import { describe, expect, it } from 'vitest';

import {
  documentToNode,
  ftsMatchExpression,
  likePrefix,
  localSearchStatement,
  resolveLocalTypes,
} from './localSearch';
import { DOCUMENTS_FTS_COLUMNS, searchIndexStatements } from './searchIndex';

describe('ftsMatchExpression', () => {
  it('quotes each word as a prefix term and ORs them, like the appliance tsquery rewrite', () => {
    expect(ftsMatchExpression('dinner Ana')).toBe('"dinner"* OR "ana"*');
  });

  it('keeps FTS operators in the text from being read as syntax', () => {
    // AND / NEAR / - / : / " are all plain text once quoted or split away.
    expect(ftsMatchExpression('cats AND dogs NEAR "home" -work col:x')).toBe(
      '"cats"* OR "and"* OR "dogs"* OR "near"* OR "home"* OR "work"* OR "col"* OR "x"*',
    );
  });

  it('folds case and keeps letters from any script', () => {
    expect(ftsMatchExpression('Zoë 東京')).toBe('"zoë"* OR "東京"*');
  });

  it('is null when nothing is left to search for', () => {
    expect(ftsMatchExpression('   ')).toBeNull();
    expect(ftsMatchExpression('--- ...')).toBeNull();
  });
});

describe('resolveLocalTypes', () => {
  it('an include list wins and is case-insensitive', () => {
    expect(resolveLocalTypes(['Person', 'EVENT', 'receipt'])).toEqual(['event', 'person']);
  });

  it('otherwise everything the box can render, minus the exclusions', () => {
    expect(resolveLocalTypes(undefined, ['note', 'answer', 'browser-activity'])).toEqual([
      'communication',
      'concept',
      'content',
      'event',
      'file',
      'item',
      'person',
      'place',
      'thread',
    ]);
  });
});

describe('documentToNode', () => {
  const base = {
    id: 'doc-1',
    entity_id: '0192f1a0-0000-7000-8000-000000000002',
    body: null,
    occurred_at: null,
  };

  it('gives each type the fields its result row reads, with a GlobalUID the box can decode', () => {
    const communication = documentToNode({
      ...base,
      entity_type: 'communication',
      title: 'Lunch?',
      occurred_at: '2026-10-01T12:00:00.000Z',
    });

    expect(communication).toEqual({
      __typename: 'CommunicationType',
      id: GlobalUID.encode('communication', base.entity_id),
      preview: 'Lunch?',
      time: '2026-10-01T12:00:00.000Z',
    });
    expect(GlobalUID.decode(communication!.id)).toEqual({ type: 'communication', id: base.entity_id });

    expect(
      documentToNode({ ...base, entity_type: 'event', title: 'Dentist', occurred_at: '2026-10-02' }),
    ).toEqual({
      __typename: 'EventType',
      id: GlobalUID.encode('event', base.entity_id),
      title: 'Dentist',
      startTime: '2026-10-02',
    });
    expect(documentToNode({ ...base, entity_type: 'file', title: 'scan.pdf' })).toEqual({
      __typename: 'FileType',
      id: GlobalUID.encode('file', base.entity_id),
      filename: 'scan.pdf',
      previewUrl: null,
    });
    expect(documentToNode({ ...base, entity_type: 'person', title: 'Ana Ruiz', body: 'Neighbour' })).toEqual({
      __typename: 'PersonType',
      id: GlobalUID.encode('person', base.entity_id),
      name: 'Ana Ruiz',
      description: 'Neighbour',
      filterName: 'Ana Ruiz',
    });
  });

  it('a message with no subject previews its body', () => {
    expect(
      documentToNode({ ...base, entity_type: 'communication', title: '', body: 'running late' }),
    ).toMatchObject({
      preview: 'running late',
    });
  });

  it('a type the box has no row for is not a suggestion', () => {
    expect(documentToNode({ ...base, entity_type: 'receipt', title: 'Home Depot' })).toBeNull();
    expect(documentToNode({ ...base, entity_type: 'browser-activity', title: 'x' })).toBeNull();
  });
});

describe('localSearchStatement', () => {
  it('ranks by bm25 with the title over the body, scoped to the resolved types', () => {
    const statement = localSearchStatement({ query: 'harbour grill', includeTypes: ['event', 'place'] });

    expect(statement).not.toBeNull();
    expect(statement!.sql).toContain('mobile_search_documents_fts MATCH ?');
    expect(statement!.sql).toContain('d.entity_type IN (?, ?)');
    // One weight per FTS column, in column order: title 10, body 1.
    expect(DOCUMENTS_FTS_COLUMNS).toEqual(['title', 'body']);
    expect(statement!.sql).toContain('ORDER BY bm25(mobile_search_documents_fts, 10.0, 1.0)');
    expect(statement!.sql).toContain(
      'JOIN mobile_search_documents d ON d.rowid = mobile_search_documents_fts.rowid',
    );
    expect(statement!.params).toEqual(['"harbour"* OR "grill"*', 'event', 'place', 25]);
  });

  it('is null for an empty query or an empty type scope', () => {
    expect(localSearchStatement({ query: '!!!' })).toBeNull();
    expect(localSearchStatement({ query: 'x', includeTypes: ['receipt'] })).toBeNull();
  });
});

describe('likePrefix', () => {
  it('escapes the wildcard characters a user might type', () => {
    expect(likePrefix('100%_sure\\')).toBe('100\\%\\_sure\\\\');
  });
});

describe('searchIndexStatements', () => {
  it('builds an external-content FTS5 index over the documents table and keeps it current with three triggers', () => {
    const statements = searchIndexStatements();

    expect(statements[0]).toMatch(
      /CREATE VIRTUAL TABLE IF NOT EXISTS mobile_search_documents_fts USING fts5\(title, body, content='mobile_search_documents'/,
    );
    expect(statements[0]).toContain("tokenize = 'unicode61 remove_diacritics 2'");
    // The backfill of rows that synced before the index existed.
    expect(statements[1]).toBe(
      "INSERT INTO mobile_search_documents_fts(mobile_search_documents_fts) VALUES ('rebuild')",
    );
    expect(statements.filter((s) => s.startsWith('CREATE TRIGGER'))).toHaveLength(3);
    expect(statements.join('\n')).toContain('AFTER INSERT ON mobile_search_documents');
    expect(statements.join('\n')).toContain('AFTER UPDATE ON mobile_search_documents');
    expect(statements.join('\n')).toContain('AFTER DELETE ON mobile_search_documents');
    // External content: a change is a 'delete' of the old text, never a DELETE on the index.
    expect(statements.join('\n')).not.toMatch(/DELETE FROM mobile_search_documents_fts/);
  });
});
