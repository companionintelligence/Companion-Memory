import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Note } from '@ci/domains/notes';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class NoteType implements Node, Taggable {
  __typename = NoteType.name;

  __source!: Note;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => String, { nullable: true })
  content!: string | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(source: Note): NoteType {
    return {
      __typename: NoteType.name,
      __source: source,
      id: GlobalUID.encode('note', source.id),
      title: source.title,
      content: source.content,
      tags: [], // Hydrated by resolver
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }
}
