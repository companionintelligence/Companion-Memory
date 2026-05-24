import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { ProviderType } from './ProviderType';

@ObjectType({ implements: () => [Edge] })
export class ProviderEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ProviderType)
  node!: ProviderType;
}
