import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { FileType } from './FileType';

@ObjectType({ implements: () => [Edge] })
export class FileEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => FileType)
  node!: FileType;
}
