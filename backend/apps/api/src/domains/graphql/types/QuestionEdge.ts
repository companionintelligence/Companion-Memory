import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { QuestionType } from './QuestionType';

@ObjectType({ implements: () => [Edge] })
export class QuestionEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => QuestionType)
  node!: QuestionType;
}
