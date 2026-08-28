/**
 * Planning domain — tasks, and (from M3) the planned blocks that schedule them.
 *
 * Scheduled work is NOT a table here: a planned block is a `ci.events` row with
 * `event_type = 'planned_block'`, so a Google Calendar event ingested by
 * `domains/etl` and a block you placed yourself are the same object. See
 * `docs/architecture/planning-roadmap.md` for the object model, the six
 * `ci.events` guardrails, and the milestone plan.
 *
 * The surface is GraphQL only (`domains/graphql/resolvers/TaskResolver.ts`),
 * gated by `planning.enabled`. There are no planning REST controllers.
 *
 * Automation jobs (`planning.todo_scan` etc.) fan out from PlanningJobsCron
 * onto the `planning` pg-boss queue and appear on the operator Jobs page.
 *
 * @module PlanningModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { LlmCoreModule } from '@ci/domains/llm/core.module';
import { CommunicationEntity, EventEntity, MemoryModule } from '@ci/domains/memory';
import { PersonalizationModule } from '@ci/domains/personalization';
import { SearchNextModule } from '@ci/domains/search-next';
import { UserEntity, UserModule } from '@ci/domains/user';

import { PlanningJobsCron } from './cron/PlanningJobsCron';
import { TaskDependencyEntity, type TaskDependency } from './entities/TaskDependencyEntity';
import { TaskEntity, TASK_STATUSES, type Task, type TaskStatus } from './entities/TaskEntity';
import {
  TaskPendingChangeEntity,
  type TaskPendingChange,
  type TaskPendingChangeKind,
  type TaskPendingChangeStatus,
} from './entities/TaskPendingChangeEntity';
import './events';
import { PlanningJobsListener } from './listeners/PlanningJobsListener';
import { InboxScanService } from './services/InboxScanService';
import { PlannedBlockService } from './services/PlannedBlockService';
import { PlanningTimeService } from './services/PlanningTimeService';
import { ProposedTaskReconcileService } from './services/ProposedTaskReconcileService';
import { TaskService } from './services/TaskService';
import { EventNowService, TodoProcessService, VerifyDoneService } from './services/TodoProcessService';
import { TodoScanService } from './services/TodoScanService';

/**
 * @internal
 */
@Module({
  // UserEntity is read-only here: PlanningTimeService resolves ci.users.timezone,
  // the single source of truth for "the user's day".
  imports: [
    TypeOrmModule.forFeature([
      TaskEntity,
      TaskDependencyEntity,
      TaskPendingChangeEntity,
      UserEntity,
      EventEntity,
      CommunicationEntity,
    ]),
    EventsModule,
    UserModule,
    MemoryModule,
    SearchNextModule,
    LlmCoreModule,
    PersonalizationModule,
  ],
  providers: [
    TaskService,
    PlanningTimeService,
    PlannedBlockService,
    ProposedTaskReconcileService,
    TodoScanService,
    TodoProcessService,
    InboxScanService,
    EventNowService,
    VerifyDoneService,
    PlanningJobsCron,
    PlanningJobsListener,
  ],
  exports: [TaskService, PlanningTimeService, PlannedBlockService],
})
export class PlanningModule {}

export { TaskEntity, TaskDependencyEntity, TaskPendingChangeEntity };

export { TaskService, PlanningTimeService, PlannedBlockService };

export { TASK_STATUSES };

export { isValidTimezone, localDateInTZ, todayInTZ, zonedWallTimeToUTC } from '@ci/common/time/zoned';

export type {
  Task,
  TaskStatus,
  TaskDependency,
  TaskPendingChange,
  TaskPendingChangeKind,
  TaskPendingChangeStatus,
};
export type { CreateTaskDto, UpdateTaskDto, FindTasksOptions, CreateTaskPendingChangeDto } from './types';
