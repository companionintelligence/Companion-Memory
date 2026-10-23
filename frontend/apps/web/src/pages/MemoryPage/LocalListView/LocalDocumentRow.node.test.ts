import { describe, expect, it } from 'vitest';

import type { LocalDocument } from '@/api/powersync/localSearch';

import { localDocumentLines } from './LocalDocumentRow';

const base: LocalDocument = {
  id: 'd1',
  entityType: 'communication',
  entityId: 'c1',
  title: null,
  body: null,
  occurredAt: null,
  relatedId: null,
  detail: null,
};

describe('localDocumentLines', () => {
  it('a titled record shows its body as the snippet', () => {
    expect(
      localDocumentLines({ ...base, entityType: 'event', title: 'Dentist', body: 'Dr Ruiz, 10am' }),
    ).toEqual({
      title: 'Dentist',
      subtitle: 'Dr Ruiz, 10am',
    });
  });

  it('a chat message with no subject is its text', () => {
    expect(localDocumentLines({ ...base, body: 'running   late\n\nsorry' })).toEqual({
      title: 'running late sorry',
      subtitle: null,
    });
  });

  it('cuts a long body short with an ellipsis', () => {
    const { title } = localDocumentLines({ ...base, body: 'x'.repeat(400) });

    expect(title).toHaveLength(160);
    expect(title.endsWith('…')).toBe(true);
  });

  it('names the kind when there is no text at all', () => {
    expect(localDocumentLines({ ...base, entityType: 'note' }).title).toBe('Untitled note');
    expect(localDocumentLines({ ...base, entityType: 'person' }).title).toBe('Unnamed person');
  });
});
