import { describe, expect, it } from 'vitest';

import { getEntityDetailPath, resolveRelatedEntityTarget } from './EntityRelationshipCards';

describe('getEntityDetailPath', () => {
  it('normalizes uppercase graph entity types', () => {
    expect(getEntityDetailPath('COMMUNICATION', 'abc')).toBe('/communications/abc');
    expect(getEntityDetailPath('PERSON', 'p1')).toBe('/people/p1');
  });

  it('normalizes underscore-separated types', () => {
    expect(getEntityDetailPath('browser_activity', 'x')).toBeNull();
    expect(getEntityDetailPath('note', 'n1')).toBe('/notes/n1');
  });
});

describe('resolveRelatedEntityTarget', () => {
  const base = {
    otherEntityId: 'neighbor-1',
    otherEntityName: 'Neighbor',
    otherEntityType: 'person',
    otherEntityDescription: null as string | null,
    otherEntityProperties: {} as Record<string, unknown>,
    relationshipDetails: [] as Array<{ label: string; value: string }>,
  };

  it('keeps communication neighbors as-is', () => {
    expect(
      resolveRelatedEntityTarget({
        ...base,
        otherEntityId: 'comm-1',
        otherEntityType: 'COMMUNICATION',
        otherEntityName: 'Hello',
      }),
    ).toEqual({
      id: 'comm-1',
      name: 'Hello',
      entityType: 'COMMUNICATION',
      description: null,
      properties: {},
    });
  });

  it('recovers a communication id from relationship properties', () => {
    expect(
      resolveRelatedEntityTarget({
        ...base,
        otherEntityType: 'connection',
        relationshipProperties: { communication_id: 'comm-99' },
      }),
    ).toEqual({
      id: 'comm-99',
      name: 'Neighbor',
      entityType: 'communication',
      description: null,
      properties: {},
    });
  });
});
