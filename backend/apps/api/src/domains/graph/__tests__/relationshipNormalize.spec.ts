import { normalizeRelationship, isSymmetric } from '../relationshipNormalize';
import { RelationshipType } from '../types';

describe('normalizeRelationship', () => {
  it('rejects IS as identity, not a relationship', () => {
    const result = normalizeRelationship('IS');
    expect(result?.reject).toBeDefined();
  });

  it('swaps CHILD_OF to PARENT_OF', () => {
    expect(normalizeRelationship('CHILD_OF')).toEqual({
      type: RelationshipType.PARENT_OF,
      swapEndpoints: true,
    });
  });

  it('renames HAPPENED_AT to LOCATED_AT', () => {
    expect(normalizeRelationship('happened_at')).toEqual({
      type: RelationshipType.LOCATED_AT,
      swapEndpoints: false,
    });
  });

  it('marks WORKS_AT as migration-pending', () => {
    const result = normalizeRelationship('WORKS_AT');
    expect(result?.type).toBe(RelationshipType.WORKS_AT);
    expect(result?.migrationPending).toBe(true);
  });

  it('passes through canonical types', () => {
    expect(normalizeRelationship('MEMBER_OF')?.type).toBe(RelationshipType.MEMBER_OF);
  });

  it('returns null for unknown types', () => {
    expect(normalizeRelationship('NOT_A_REAL_TYPE')).toBeNull();
  });

  it('treats FRIENDS_WITH as symmetric', () => {
    expect(isSymmetric(RelationshipType.FRIENDS_WITH)).toBe(true);
    expect(isSymmetric(RelationshipType.LOCATED_AT)).toBe(false);
  });
});
