import { Field, GraphQLISODateTime, ID, InputType } from '@nestjs/graphql';

@InputType()
export class CreateReminderInput {
  @Field(() => ID, { nullable: true, description: 'Exactly one of `taskId`/`blockId` must be set.' })
  taskId?: string;

  @Field(() => ID, { nullable: true, description: 'A planned block (`ci.events` id). See `taskId`.' })
  blockId?: string;

  @Field(() => GraphQLISODateTime, { description: 'The instant this reminder fires. Must be in the future.' })
  fireAt!: Date;
}
