import type { CreateRelationshipDto } from '@ci/domains/graph/types';

export { RelationshipType } from '@ci/domains/graph';

export type SeedRelationship = Pick<
  CreateRelationshipDto,
  'fromNodeId' | 'fromNodeType' | 'toNodeId' | 'toNodeType' | 'type' | 'strength' | 'properties'
>;
