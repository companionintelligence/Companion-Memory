import { RelationshipType } from './types';

/**
 * Write-time normalisation for the life-graph matrix (#1945 / #1946).
 *
 * Applied in {@link RelationshipService} before allowlist checks and insert so
 * every writer — app, ETL, backfill — stores the same canonical triple.
 */

export type NormalizedRelationship = {
  type: RelationshipType;
  /** When true, swap from/to before insert (stored inverse aliases). */
  swapEndpoints: boolean;
  /** Reject this type entirely (identity belongs in identifiers + merge). */
  reject?: { reason: string };
  /** Extra properties merged onto the edge (e.g. MEMBER_OF role). */
  properties?: Record<string, unknown>;
  /** Migration queue hint — caller may leave the edge for the normalize job. */
  migrationPending?: boolean;
};

/** Symmetric types that always get `is_bidirectional = true` on write. */
export const SYMMETRIC_RELATIONSHIP_TYPES: ReadonlySet<RelationshipType> = new Set([
  RelationshipType.KNOWS,
  RelationshipType.FRIENDS_WITH,
  RelationshipType.PARTNER_OF,
  RelationshipType.SPOUSE,
  RelationshipType.SIBLING_OF,
  RelationshipType.FAMILY_MEMBER,
  RelationshipType.WORKS_WITH,
  RelationshipType.COLLABORATED_WITH,
  RelationshipType.INDUSTRY_CONNECTION,
  RelationshipType.SHARES_INTERESTS_WITH,
  RelationshipType.LIVES_WITH,
  RelationshipType.LIVES_NEAR,
  RelationshipType.MET_WITH,
  RelationshipType.ORGANIZED_EVENT_WITH,
  RelationshipType.EDITED_WITH,
  RelationshipType.COMMUNICATES_WITH,
]);

/**
 * Map a raw relationship-type string onto the canonical stored form.
 * Unknown strings return null (caller treats as not in enum).
 */
export function normalizeRelationship(raw: string): NormalizedRelationship | null {
  const key = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  // Rejected: identity is not a relationship.
  if (key === 'IS') {
    return {
      type: RelationshipType.ASSOCIATED_WITH,
      swapEndpoints: false,
      reject: {
        reason: 'IS is not a relationship — enrich the self entity via ci.entity_identifiers + merge',
      },
    };
  }

  // Endpoint-swap aliases (stored as the dependent→anchor canonical).
  if (key === 'CHILD_OF') {
    return { type: RelationshipType.PARENT_OF, swapEndpoints: true };
  }

  if (key === 'LEARNED_FROM') {
    return { type: RelationshipType.TAUGHT, swapEndpoints: true };
  }

  if (key === 'RECEIVED_EMAIL_FROM') {
    return { type: RelationshipType.EMAILED, swapEndpoints: true };
  }

  // Renames.
  const renames: Record<string, RelationshipType> = {
    HAPPENED_AT: RelationshipType.LOCATED_AT,
    AT_LOCATION: RelationshipType.LOCATED_AT,
    RELATED_TO: RelationshipType.ASSOCIATED_WITH,
    FRIEND: RelationshipType.FRIENDS_WITH,
    COLLEAGUE: RelationshipType.WORKS_WITH,
    PARTNER: RelationshipType.PARTNER_OF,
    ROMANTIC_PARTNER: RelationshipType.PARTNER_OF,
  };

  if (key in renames) {
    return { type: renames[key], swapEndpoints: false };
  }

  // Migration aliases: person→place employment/education become MEMBER_OF Group
  // once a Group can be resolved. Until then, accept and stamp migrationPending
  // so the normalize job can retype.
  if (key === 'WORKS_AT') {
    return {
      type: RelationshipType.WORKS_AT,
      swapEndpoints: false,
      properties: { role: 'employee', migration: 'member_of_group' },
      migrationPending: true,
    };
  }

  if (key === 'STUDIES_AT') {
    return {
      type: RelationshipType.STUDIES_AT,
      swapEndpoints: false,
      properties: { role: 'student', migration: 'member_of_group' },
      migrationPending: true,
    };
  }

  if (!(key in RelationshipType)) {
    return null;
  }

  return {
    type: RelationshipType[key as keyof typeof RelationshipType],
    swapEndpoints: false,
  };
}

export function isSymmetric(type: RelationshipType): boolean {
  return SYMMETRIC_RELATIONSHIP_TYPES.has(type);
}
