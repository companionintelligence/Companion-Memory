import { Field, ObjectType } from '@nestjs/graphql';

import { ItemType } from './ItemType';
import { MutationPayload } from './MutationPayload';

@ObjectType()
export class UpdateItemPayload extends MutationPayload {
  @Field(() => ItemType, { nullable: true })
  item?: ItemType;
}
