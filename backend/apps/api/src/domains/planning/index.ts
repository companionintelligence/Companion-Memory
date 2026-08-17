/**
 * Planning domain — tasks, and (from M3) the planned blocks that schedule them.
 *
 * Scheduled work is NOT a table here: a planned block is a `ci.events` row with
 * `event_type = 'planned_block'`, so a Google Calendar event ingested by
 * `domains/etl` and a block you placed yourself are the same object. See
 * `docs/architecture/planning-roadmap.md` for the object model, the six
 * `ci.events` guardrails, and the milestone plan.
 *
 * The surface is GraphQL only (`domains/graphql/resolvers/TaskResolver.ts`);
 * there are no planning REST controllers.
 *
 * @module PlanningModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { TaskDependencyEntity, type TaskDependency } from './entities/TaskDependencyEntity';
import { TaskEntity, TASK_STATUSES, type Task, type TaskStatus } from './entities/TaskEntity';
import { PlanningTimeService } from './services/PlanningTimeService';
import { TaskService } from './services/TaskService';

/**
 * @internal
 */
@Module({
  // UserEntity is read-only here: PlanningTimeService resolves ci.users.timezone,
  // the single source of truth for "the user's day".
  imports: [TypeOrmModule.forFeature([TaskEntity, TaskDependencyEntity, UserEntity]), EventsModule],
  providers: [TaskService, PlanningTimeService],
  exports: [TaskService, PlanningTimeService],
})
export class PlanningModule {}

export { TaskEntity, TaskDependencyEntity };

export { TaskService, PlanningTimeService };

export { TASK_STATUSES };

export { isValidTimezone, localDateInTZ, todayInTZ, zonedWallTimeToUTC } from './time/zoned';

export type { Task, TaskStatus, TaskDependency };
export type { CreateTaskDto, UpdateTaskDto, FindTasksOptions } from './types';
