import { Field, ObjectType } from '@nestjs/graphql';

import { ConnectionSyncJobType } from './ConnectionSyncJobType';
import { Edge } from './Edge';

@ObjectType({ implements: () => [Edge] })
export class ConnectionSyncJobEdge {
  @Field(() => ConnectionSyncJobType)
  node!: ConnectionSyncJobType;

  @Field(() => String)
  cursor!: string;
}
