import { Field, InterfaceType } from '@nestjs/graphql';

import { EntityTagType } from './EntityTagType';

@InterfaceType({ resolveType: (value) => value.__typename })
export abstract class Taggable {
  @Field(() => [EntityTagType])
  tags!: EntityTagType[];
}
