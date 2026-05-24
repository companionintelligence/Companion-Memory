import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { ProviderKeyType } from './ProviderKeyType';

@ObjectType({ implements: () => [Edge] })
export class ProviderKeyEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ProviderKeyType)
  node!: ProviderKeyType;
}
