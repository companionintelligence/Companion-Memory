import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Concept } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class ConceptType implements Node, Taggable {
  __typename = ConceptType.name;

  __source!: Concept;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  static toType(concept: Concept): ConceptType {
    return {
      __typename: ConceptType.name,
      __source: concept,
      id: GlobalUID.encode('concept', concept.id),
      name: concept.name,
      description: concept.description,
      tags: [], // Hydrated by resolver
    };
  }
}
