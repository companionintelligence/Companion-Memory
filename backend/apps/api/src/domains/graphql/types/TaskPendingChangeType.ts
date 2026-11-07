import { Field, Float, GraphQLISODateTime, ID, ObjectType, registerEnumType } from '@nestjs/graphql';

import { GraphQLJSONObject } from '@ci/domains/graphql/scalars/JsonObjectScalar';
import { type TaskPendingChange } from '@ci/domains/planning';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

export enum TaskPendingChangeKindEnum {
  mutate = 'mutate',
  complete = 'complete',
  event_revise = 'event_revise',
  schedule = 'schedule',
}

registerEnumType(TaskPendingChangeKindEnum, {
  name: 'TaskPendingChangeKind',
  description: 'What automation wants to do to a task (or its planned event).',
});

export enum TaskPendingChangeStatusEnum {
  pending = 'pending',
  accepted = 'accepted',
  declined = 'declined',
}

registerEnumType(TaskPendingChangeStatusEnum, {
  name: 'TaskPendingChangeStatus',
});

@ObjectType({ implements: () => [Node] })
export class TaskPendingChangeType implements Node {
  __typename = TaskPendingChangeType.name;

  __source!: TaskPendingChange;

  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  taskId!: string;

  @Field(() => TaskPendingChangeKindEnum)
  kind!: TaskPendingChangeKindEnum;

  @Field(() => GraphQLJSONObject)
  patch!: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  rationale!: string | null;

  @Field(() => Float, { nullable: true })
  confidence!: number | null;

  @Field(() => TaskPendingChangeStatusEnum)
  status!: TaskPendingChangeStatusEnum;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  resolvedAt!: Date | null;

  static toType(source: TaskPendingChange): TaskPendingChangeType {
    return {
      __typename: TaskPendingChangeType.name,
      __source: source,
      id: GlobalUID.encode('taskPendingChange', source.id),
      taskId: GlobalUID.encode('task', source.taskId),
      kind: source.kind as TaskPendingChangeKindEnum,
      patch: source.patch,
      rationale: source.rationale,
      confidence: source.confidence,
      status: source.status as TaskPendingChangeStatusEnum,
      createdAt: source.createdAt,
      resolvedAt: source.resolvedAt,
    };
  }
}
