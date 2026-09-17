import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { type Task } from '@ci/domains/planning';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

export enum TaskStatusEnum {
  proposed = 'proposed',
  open = 'open',
  in_progress = 'in_progress',
  delegated = 'delegated',
  done = 'done',
  skipped = 'skipped',
  archived = 'archived',
}

registerEnumType(TaskStatusEnum, {
  name: 'TaskStatus',
  description: 'Lifecycle state of a planning task.',
});

@ObjectType({ implements: () => [Node, Taggable] })
export class TaskType implements Node, Taggable {
  __typename = TaskType.name;

  __source!: Task;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  notes!: string | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  @Field(() => TaskStatusEnum)
  status!: TaskStatusEnum;

  @Field(() => Int, { description: '0 (highest) to 5 (lowest). Defaults to 3.' })
  priority!: number;

  @Field(() => ID, { nullable: true, description: 'Parent task, for subtasks.' })
  parentId!: string | null;

  @Field(() => [TaskType], {
    description: 'Direct children. Nesting is parent_id only — walk this field for a tree.',
  })
  children!: TaskType[];

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Deadline, as an instant.' })
  dueAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'Wall-clock time of day, `HH:MM:SS`, in the user timezone. Zoneless by design.',
  })
  taskTime!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'User-local calendar date, `YYYY-MM-DD`. Not an instant.',
  })
  scheduledFor!: string | null;

  @Field(() => Boolean, {
    description:
      'True when a planned calendar block exists. `scheduledFor` alone is a preferred date, not a placement.',
  })
  // Left unset by `toType()` — the `@ResolveField` in TaskResolver treats "not a
  // boolean yet" as "go look it up" and falls back to plannedBlockService. Only
  // callers that already know the real placement (e.g. TaskResolver.toTaskType)
  // should assign this.
  placedOnCalendar?: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'User-local calendar date, `YYYY-MM-DD`, before which the task stays hidden.',
  })
  deferUntil!: string | null;

  @Field(() => Int, { description: 'How many times this task has been pushed to a later day.' })
  deferCount!: number;

  @Field(() => Int, { nullable: true })
  estimatedMinutes!: number | null;

  @Field(() => Int)
  actualMinutes!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  completedAt!: Date | null;

  @Field(() => String, { description: 'Where the task came from: `manual`, or an ingest source.' })
  sourceKind!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  static toType(source: Task): TaskType {
    return {
      __typename: TaskType.name,
      __source: source,
      id: GlobalUID.encode('task', source.id),
      title: source.title,
      description: source.description,
      notes: source.notes,
      tags: [], // Hydrated by TaskResolver.tags
      status: source.status as TaskStatusEnum,
      priority: source.priority,
      parentId: source.parentId ? GlobalUID.encode('task', source.parentId) : null,
      children: [],
      dueAt: source.dueAt,
      taskTime: source.taskTime,
      scheduledFor: source.scheduledFor,
      // Intentionally omitted: see the field's doc comment above. Leaving it
      // unset lets TaskResolver.placedOnCalendar's fallback lookup run.
      deferUntil: source.deferUntil,
      deferCount: source.deferCount,
      estimatedMinutes: source.estimatedMinutes,
      actualMinutes: source.actualMinutes,
      completedAt: source.completedAt,
      sourceKind: source.sourceKind,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }
}
