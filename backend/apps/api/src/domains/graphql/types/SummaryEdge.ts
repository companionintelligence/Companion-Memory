import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { SummaryType } from './SummaryType';

@ObjectType({ implements: () => [Edge] })
export class SummaryEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => SummaryType)
  node!: SummaryType;
}
