import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { NoteEdge } from './NoteEdge';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class NoteConnection implements Connection {
  @Field(() => [NoteEdge])
  edges!: NoteEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
