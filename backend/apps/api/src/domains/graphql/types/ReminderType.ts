import { Field, GraphQLISODateTime, ID, ObjectType, registerEnumType, Int } from '@nestjs/graphql';

import { type Reminder } from '@ci/domains/planning';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

export enum ReminderStatusEnum {
  pending = 'pending',
  fired = 'fired',
  delivering = 'delivering',
  scheduled = 'scheduled',
  delivered = 'delivered',
  failed = 'failed',
  cancelled = 'cancelled',
}

registerEnumType(ReminderStatusEnum, {
  name: 'ReminderStatus',
  description:
    'Reminder delivery state; delivered means a push provider accepted it, fired is a legacy outcome.',
});

export enum ReminderSourceEnum {
  manual = 'manual',
  auto = 'auto',
}

registerEnumType(ReminderSourceEnum, {
  name: 'ReminderSource',
  description:
    "'auto' is reserved for a future due-date derivation engine; today every reminder is 'manual'.",
});

@ObjectType({ implements: () => [Node] })
export class ReminderType implements Node {
  __typename = ReminderType.name;

  __source!: Reminder;

  @Field(() => ID)
  id!: string;

  @Field(() => ID, { nullable: true })
  taskId!: string | null;

  @Field(() => ID, { nullable: true, description: 'A planned block — a `ci.events` row.' })
  blockId!: string | null;

  @Field(() => GraphQLISODateTime)
  fireAt!: Date;

  @Field(() => ReminderStatusEnum)
  status!: ReminderStatusEnum;

  @Field(() => GraphQLISODateTime, { nullable: true })
  firedAt!: Date | null;

  @Field(() => String)
  deliveryMode!: string;

  @Field(() => Int)
  attempts!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  nextAttemptAt!: Date | null;

  @Field(() => String, { nullable: true })
  lastError!: string | null;

  @Field(() => ReminderSourceEnum)
  source!: ReminderSourceEnum;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  static toType(source: Reminder): ReminderType {
    return {
      __typename: ReminderType.name,
      __source: source,
      id: GlobalUID.encode('reminder', source.id),
      taskId: source.taskId ? GlobalUID.encode('task', source.taskId) : null,
      blockId: source.blockId ? GlobalUID.encode('event', source.blockId) : null,
      fireAt: source.fireAt,
      status: source.status as ReminderStatusEnum,
      firedAt: source.firedAt,
      source: source.source as ReminderSourceEnum,
      deliveryMode: source.deliveryMode,
      attempts: source.attempts,
      nextAttemptAt: source.nextAttemptAt,
      lastError: source.lastError,
      createdAt: source.createdAt,
    };
  }
}
