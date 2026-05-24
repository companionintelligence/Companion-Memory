import { Field, ObjectType } from '@nestjs/graphql';

import { ItemType } from './ItemType';
import { MutationPayload } from './MutationPayload';

@ObjectType()
export class CreateItemPayload extends MutationPayload {
  @Field(() => ItemType, { nullable: true })
  item?: ItemType;
}
