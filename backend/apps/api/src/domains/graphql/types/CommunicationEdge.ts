import { Field, ObjectType } from '@nestjs/graphql';

import { CommunicationType } from './CommunicationType';
import { Edge } from './Edge';

@ObjectType({ implements: () => [Edge] })
export class CommunicationEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => CommunicationType)
  node!: CommunicationType;
}
