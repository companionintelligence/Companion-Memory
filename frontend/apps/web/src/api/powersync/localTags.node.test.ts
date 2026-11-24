import { describe, expect, it } from 'vitest';

import { listLocalTags, localTagsStatement } from './localTags';

describe('localTagsStatement', () => {
  it('lists live tags by label with a count from the entity_tag join', () => {
    const { sql, params } = localTagsStatement();

    expect(sql).toContain('FROM tags t');
    expect(sql).toContain('LEFT JOIN entity_tag et ON et.tag_id = t.id');
    expect(sql).toContain('WHERE t.deleted_at IS NULL');
    expect(sql).toContain('ORDER BY t.label COLLATE NOCASE, t.id');
    expect(params).toEqual([]);
  });
});

describe('listLocalTags', () => {
  it('shapes the rows, with a missing description as null and the count as a number', async () => {
    const db = {
      getAll: async () => [
        { id: 't1', label: 'Travel', description: 'Trips', n: 12 },
        { id: 't2', label: 'work', description: null, n: '0' },
      ],
    };

    await expect(listLocalTags(db as never)).resolves.toEqual([
      { id: 't1', label: 'Travel', description: 'Trips', entityCount: 12 },
      { id: 't2', label: 'work', description: null, entityCount: 0 },
    ]);
  });
});
