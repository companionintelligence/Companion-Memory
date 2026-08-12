import { type Relationship as GraphRelationship } from '@ci/domains/graph';
import type { RelationshipEntity as MemoryRelationship } from '@ci/domains/memory';

import { RelationshipType } from '../types/RelationshipType';

/**
 * Map a memory-domain relationship row onto the GraphQL RelationshipType shape.
 * Memory entities use snake_case columns; GraphQL egress uses camelCase.
 */
export function memoryRelToGql(rel: MemoryRelationship): RelationshipType {
  const egress: GraphRelationship = {
    id: rel.relationship_id,
    fromNodeId: rel.from_entity_id,
    fromNodeType: rel.from_entity_type ?? 'Unknown',
    toNodeId: rel.to_entity_id,
    toNodeType: rel.to_entity_type ?? 'Unknown',
    type: rel.relationship_type,
    strength: rel.strength,
    isBidirectional: rel.is_bidirectional,
    startDate: rel.start_date,
    endDate: rel.end_date,
    userId: rel.owner_user_id ?? '',
    properties: rel.properties ?? {},
    createdAt: rel.created_at,
    updatedAt: rel.updated_at,
  };

  return RelationshipType.toType(egress);
}
