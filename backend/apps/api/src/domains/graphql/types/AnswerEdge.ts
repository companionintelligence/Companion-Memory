import { Field, ObjectType } from '@nestjs/graphql';

import { AnswerType } from './AnswerType';
import { Edge } from './Edge';

@ObjectType({ implements: () => [Edge] })
export class AnswerEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => AnswerType)
  node!: AnswerType;
}
