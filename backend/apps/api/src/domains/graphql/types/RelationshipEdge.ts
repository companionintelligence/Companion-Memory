import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { RelationshipType } from './RelationshipType';

@ObjectType({ implements: () => [Edge] })
export class RelationshipEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => RelationshipType)
  node!: RelationshipType;
}
