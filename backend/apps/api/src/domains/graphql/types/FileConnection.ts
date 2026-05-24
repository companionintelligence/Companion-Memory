import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { FileEdge } from './FileEdge';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class FileConnection implements Connection {
  @Field(() => [FileEdge])
  edges!: FileEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
