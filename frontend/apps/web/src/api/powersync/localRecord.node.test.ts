import { describe, expect, it, vi } from 'vitest';

import { getLocalDocument, listSiblings, siblingsStatement } from './localRecord';

describe('siblingsStatement', () => {
  it('pages one side of a conversation by (time, id), undated rows last', () => {
    const before = siblingsStatement(
      'conv-1',
      'before',
      { occurredAt: '2026-01-02 10:00:00Z', id: 'm5' },
      20,
    );

    expect(before.sql).toContain('WHERE d.related_id = ?');
    expect(before.sql).toContain("(coalesce(d.occurred_at, '~'), d.id) < (?, ?)");
    expect(before.sql).toContain("ORDER BY coalesce(d.occurred_at, '~') DESC, d.id DESC");
    expect(before.params).toEqual(['conv-1', '2026-01-02 10:00:00Z', 'm5', 20]);

    const after = siblingsStatement('conv-1', 'after', { occurredAt: null, id: 'm5' }, 20);

    expect(after.sql).toContain("(coalesce(d.occurred_at, '~'), d.id) > (?, ?)");
    expect(after.sql).toContain('ASC, d.id ASC');
    // An undated cursor sits with the undated rows, after every dated one.
    expect(after.params[1]).toBe('~');
  });
});

describe('listSiblings', () => {
  it('returns the earlier side in reading order, oldest first', async () => {
    const db = {
      getAll: vi.fn(async () => [
        {
          id: 'm4',
          entity_type: 'communication',
          entity_id: 'c4',
          title: '',
          body: 'four',
          occurred_at: '4',
          related_id: 'conv',
          detail: null,
        },
        {
          id: 'm3',
          entity_type: 'communication',
          entity_id: 'c3',
          title: '',
          body: 'three',
          occurred_at: '3',
          related_id: 'conv',
          detail: null,
        },
      ]),
    };

    const documents = await listSiblings(db as never, 'conv', 'before', { occurredAt: '5', id: 'm5' });

    expect(documents.map((d) => d.body)).toEqual(['three', 'four']);
  });
});

describe('getLocalDocument', () => {
  it('looks a record up by entity id and type, through the entity index', async () => {
    const db = {
      getOptional: vi.fn(async (_sql: string, _params?: unknown[]) => ({
        id: 'd1',
        entity_type: 'event',
        entity_id: 'e1',
        title: 'Dentist',
        body: '',
        occurred_at: null,
        related_id: null,
        detail: '{"status":"confirmed"}',
      })),
    };

    const document = await getLocalDocument(db as never, 'event', 'e1');

    expect(db.getOptional.mock.calls[0][0]).toContain('WHERE d.entity_id = ? AND d.entity_type = ?');
    expect(db.getOptional.mock.calls[0][1]).toEqual(['e1', 'event']);
    expect(document).toMatchObject({
      entityType: 'event',
      title: 'Dentist',
      detail: { status: 'confirmed' },
    });
  });
});
