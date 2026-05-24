import { Field, ObjectType } from '@nestjs/graphql';

import { ConnectionType } from './ConnectionType';
import { Edge } from './Edge';

@ObjectType({ implements: () => [Edge] })
export class ConnectionEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ConnectionType)
  node!: ConnectionType;
}
