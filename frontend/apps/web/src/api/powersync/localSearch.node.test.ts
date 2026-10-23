import { GlobalUID } from '@ci/common';
import { describe, expect, it } from 'vitest';

import {
  documentToNode,
  ftsMatchExpression,
  likePrefix,
  localSearchStatement,
  parseDetail,
  resolveLocalTypes,
  toLocalDocument,
} from './localSearch';
import { DOCUMENTS_FTS_COLUMNS, searchIndexStatements } from './searchIndex';

describe('ftsMatchExpression', () => {
  it('quotes each word as a prefix term and ORs them, like the appliance tsquery rewrite, over the text columns only', () => {
    // The column filter keeps a hex-looking word from matching the person-id columns.
    expect(ftsMatchExpression('dinner Ana')).toBe('{title body}: ("dinner"* OR "ana"*)');
  });

  it('keeps FTS operators in the text from being read as syntax', () => {
    // AND / NEAR / - / : / " are all plain text once quoted or split away.
    expect(ftsMatchExpression('cats AND dogs NEAR "home" -work col:x')).toBe(
      '{title body}: ("cats"* OR "and"* OR "dogs"* OR "near"* OR "home"* OR "work"* OR "col"* OR "x"*)',
    );
  });

  it('folds case and keeps letters from any script', () => {
    expect(ftsMatchExpression('Zoë 東京')).toBe('{title body}: ("zoë"* OR "東京"*)');
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
    related_id: null,
    detail: null,
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

describe('toLocalDocument', () => {
  const row = {
    id: 'doc-2',
    entity_type: 'communication',
    entity_id: '0192f1a0-0000-7000-8000-000000000003',
    title: '',
    body: 'running late',
    occurred_at: '2026-10-01T12:00:00.000Z',
    related_id: 'c01c1d1c-79ec-56d8-a79a-e0e8f7f4a3c5',
    detail: '{"direction":"inbound","participants":{"from":"Ana","to":["Kyle"]}}',
  };

  it('parses the detail JSON and keeps the conversation key', () => {
    expect(toLocalDocument(row)).toEqual({
      id: 'doc-2',
      entityType: 'communication',
      entityId: row.entity_id,
      title: null,
      body: 'running late',
      occurredAt: '2026-10-01T12:00:00.000Z',
      relatedId: row.related_id,
      detail: { direction: 'inbound', participants: { from: 'Ana', to: ['Kyle'] } },
    });
  });

  it('a type with no display fields, or detail that is not a JSON object, has null detail', () => {
    expect(parseDetail(null)).toBeNull();
    expect(parseDetail('')).toBeNull();
    expect(parseDetail('[1]')).toBeNull();
    expect(parseDetail('not json')).toBeNull();
    expect(toLocalDocument({ ...row, entity_type: 'note', detail: null, related_id: null })).toMatchObject({
      detail: null,
      relatedId: null,
    });
  });
});

describe('localSearchStatement', () => {
  it('ranks by bm25 with the title over the body, scoped to the resolved types', () => {
    const statement = localSearchStatement({ query: 'harbour grill', includeTypes: ['event', 'place'] });

    expect(statement).not.toBeNull();
    // The record half comes back with every hit, for the offline list and record page.
    expect(statement!.sql).toContain('d.occurred_at, d.related_id, d.detail');
    expect(statement!.sql).toContain('mobile_search_documents_fts MATCH ?');
    // The plus keeps the planner on the FTS scan (15 s per keystroke without it on a 589k-row replica).
    expect(statement!.sql).toContain('+d.entity_type IN (?, ?)');
    // One weight per FTS column, in column order: title 10, body 1, nothing for the id columns.
    expect(DOCUMENTS_FTS_COLUMNS).toEqual(['title', 'body', 'from_id', 'to_ids', 'people']);
    expect(statement!.sql).toContain('ORDER BY bm25(mobile_search_documents_fts, 10.0, 1.0, 0.0, 0.0, 0.0)');
    expect(statement!.sql).toContain(
      'JOIN mobile_search_documents d ON d.rowid = mobile_search_documents_fts.rowid',
    );
    expect(statement!.params).toEqual(['{title body}: ("harbour"* OR "grill"*)', 'event', 'place', 25]);
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
      /CREATE VIRTUAL TABLE IF NOT EXISTS mobile_search_documents_fts USING fts5\(title, body, from_id, to_ids, people, content='mobile_search_documents'/,
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
