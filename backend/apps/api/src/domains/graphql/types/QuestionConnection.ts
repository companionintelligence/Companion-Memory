import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { QuestionEdge } from './QuestionEdge';

@ObjectType({ implements: () => [Connection] })
export class QuestionConnection implements Connection {
  @Field(() => [QuestionEdge])
  edges!: QuestionEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
