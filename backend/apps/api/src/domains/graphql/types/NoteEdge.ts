import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { NoteType } from './NoteType';

@ObjectType({ implements: () => [Edge] })
export class NoteEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => NoteType)
  node!: NoteType;
}
