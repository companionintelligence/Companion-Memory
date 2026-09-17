import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';
import { TagType } from './TagType';

/** Shared payload for setTagDirections / setTagCategories. */
@ObjectType()
export class SetTagGroupingPayload extends MutationPayload {
  /** The resulting membership (direction tags or category tags, depending on the mutation). Empty on failure. */
  @Field(() => [TagType])
  tags!: TagType[];
}
