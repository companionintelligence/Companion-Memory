import { Field, ObjectType } from '@nestjs/graphql';

import { ConceptType } from './ConceptType';
import { Edge } from './Edge';

@ObjectType({ implements: () => [Edge] })
export class ConceptEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ConceptType)
  node!: ConceptType;
}
