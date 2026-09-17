import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';
import { ReminderType } from './ReminderType';

@ObjectType()
export class CreateReminderPayload extends MutationPayload {
  @Field(() => ReminderType, { nullable: true })
  reminder?: ReminderType;
}
