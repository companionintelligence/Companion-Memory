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
import {
  PLANNING_PREFS_DEFAULTS,
  type PlanningPrefs,
  PlanningPrefsEntity,
  type ResolvedPlanningPrefs,
} from './entities/PlanningPrefsEntity';
import { TaskDependencyEntity, type TaskDependency } from './entities/TaskDependencyEntity';
import { TaskEntity, type Task } from './entities/TaskEntity';
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
import { PlanningPrefsService } from './services/PlanningPrefsService';
import { PlanningTimeService } from './services/PlanningTimeService';
import { ProposedTaskReconcileService } from './services/ProposedTaskReconcileService';
import { EventNowService, TodoProcessService, VerifyDoneService } from './services/TodoProcessService';
import { TodoScanService } from './services/TodoScanService';
import { TaskModule, TaskService } from './task.module';

/**
 * @internal
 */
@Module({
  // UserEntity is read-only here: PlanningTimeService resolves ci.users.timezone,
  // the single source of truth for "the user's day".
  //
  // TaskEntity/TaskPendingChangeEntity are NOT registered here: TaskService now lives in
  // TaskModule (./task.module.ts), which registers them itself. That split is what lets
  // `domains/tools` depend on TaskService without also pulling in LlmCoreModule (below) — see
  // TaskModule's doc comment for why that matters.
  imports: [
    TypeOrmModule.forFeature([
      PlanningPrefsEntity,
      TaskDependencyEntity,
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
    TaskModule,
  ],
  providers: [
    PlanningPrefsService,
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
  exports: [TaskModule, PlanningTimeService, PlannedBlockService, PlanningPrefsService],
})
export class PlanningModule {}

export { TaskEntity, TaskDependencyEntity, TaskPendingChangeEntity, PlanningPrefsEntity };

export { TaskService, PlanningTimeService, PlannedBlockService, PlanningPrefsService };

// The status vocabulary and its named subsets. Cross-domain callers that filter
// tasks by status (ChatTurnService's Plan snapshot, for one) take a subset from
// here rather than writing the literals out again — see `./taskStatus`.
export {
  ACTIVE_TASK_STATUSES,
  CLOSED_TASK_STATUSES,
  LIVE_TASK_STATUSES,
  PROPOSED_TASK_STATUSES,
  SCHEDULABLE_TASK_STATUSES,
  TASK_STATUSES,
  TITLE_MATCH_TASK_STATUSES,
  isActiveTaskStatus,
  isClosedTaskStatus,
} from './taskStatus';
export { PLANNING_PREFS_DEFAULTS };

export { isValidTimezone, localDateInTZ, todayInTZ, zonedWallTimeToUTC } from '@ci/common/time/zoned';

export type { TaskStatus } from './taskStatus';
export type {
  PlanningPrefs,
  ResolvedPlanningPrefs,
  Task,
  TaskDependency,
  TaskPendingChange,
  TaskPendingChangeKind,
  TaskPendingChangeStatus,
};
export type {
  CreateTaskDto,
  UpdateTaskDto,
  FindTasksOptions,
  CreateTaskPendingChangeDto,
  UpdatePlanningPrefsDto,
} from './types';
