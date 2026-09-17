import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { EventEntity, MemoryModule } from '@ci/domains/memory';
// Reaches into personalization's internals rather than its public barrel, for the same reason
// `PlannedBlockService.ts` does (see its own comment): the barrel imports LlmCoreModule, which
// imports ToolsModule, which imports THIS module — a cycle through the barrel that the internal
// path avoids. `domains/tools/index.ts` already makes this exact trade for this exact class.
import { PersonalizationService } from '@ci/domains/personalization/services/PersonalizationService';
import { UserEntity } from '@ci/domains/user';

import { PlanningPrefsEntity } from './entities/PlanningPrefsEntity';
import { TaskEntity } from './entities/TaskEntity';
import { TaskPendingChangeEntity } from './entities/TaskPendingChangeEntity';
import { PlannedBlockService } from './services/PlannedBlockService';
import { PlanningPrefsService } from './services/PlanningPrefsService';
import { PlanningTimeService } from './services/PlanningTimeService';
import { TaskService } from './services/TaskService';

/**
 * `TaskService` and `PlannedBlockService`, without the rest of `PlanningModule`.
 *
 * Tiny module for the same reason `ChatModelPreferenceModule`
 * (`domains/llm/chat-model-preference.module.ts`) is one: `PlanningModule` imports
 * `LlmCoreModule` (for `TodoScanService`/`TodoProcessService`/`InboxScanService`, which call
 * `OllamaService`), and `LlmCoreModule` imports `ToolsModule` (`OllamaService` dispatches through
 * `ToolRegistry`). `domains/tools`' own `planning.*` tools need `TaskService` and (from the
 * scheduling tools) `PlannedBlockService`, so importing `PlanningModule` — or anything that
 * resolves through `@ci/domains/planning`'s barrel — from `domains/tools` would close
 * `tools → planning → llm → tools`, a cycle `no-circular` rejects outright (and there is no
 * `forwardRef` escape for it — this codebase does not use one for module graphs).
 *
 * Originally just `TaskService` (whose constructor only reaches `EventsModule`/`MemoryModule`,
 * both leaves of that cycle). `PlannedBlockService` joined it for `planning.scheduleTask` /
 * `planning.plannedBlocks`: its own constructor dependencies are `PlanningTimeService` and
 * `PlanningPrefsService` (both sibling planning services, cycle-safe — see below) plus
 * `PersonalizationService`, `CalendarEventService`, `PersonService` and `UserContextService`, all
 * four resolvable from `MemoryModule` alone once `PersonalizationService` is provided the same
 * cycle-avoiding way `domains/tools/index.ts` already provides it (an internal-path import rather
 * than through `PersonalizationModule`, which — like `PlanningModule` — imports `LlmCoreModule`).
 * Its only state is a 60-second profile cache, so a second instance here is cheap and behaviourally
 * identical to the one `PersonalizationModule` provides everywhere else, exactly as that comment
 * already argues for the `domains/tools/index.ts` copy.
 *
 * `PlanningTimeService` (needs only a `UserEntity` repository) and `PlanningPrefsService` (needs
 * only a `PlanningPrefsEntity` repository) have no LLM-adjacent dependencies of their own, so they
 * are provided directly here rather than reached through `PlanningModule` — the same reasoning,
 * applied one level down.
 *
 * This file is also the one place cross-domain callers of `TaskService`/`PlannedBlockService` from
 * inside a cycle-adjacent domain (`domains/tools`) may reach into `domains/planning`'s internals —
 * `no-cross-domain-internals` normally forbids importing anything but another domain's `index.ts`
 * or `events.ts`, so each such import is a deliberate, narrow, grandfathered exception rather than
 * an accident. Re-exporting the plain types a caller needs to call these services (rather than just
 * the classes) keeps that exception to ONE file instead of one per type's home module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TaskEntity,
      TaskPendingChangeEntity,
      EventEntity,
      PlanningPrefsEntity,
      UserEntity,
    ]),
    EventsModule,
    MemoryModule,
  ],
  providers: [
    TaskService,
    PlanningTimeService,
    PlanningPrefsService,
    PersonalizationService,
    PlannedBlockService,
  ],
  exports: [TaskService, PlannedBlockService],
})
export class TaskModule {}

export { TaskService } from './services/TaskService';
export { PlannedBlockService } from './services/PlannedBlockService';
export type { PlaceOutcome } from './services/PlannedBlockService';
export type { Task, TaskStatus } from './entities/TaskEntity';
export { ACTIVE_TASK_STATUSES, TASK_STATUSES } from './taskStatus';
export type { CreateTaskDto, UpdateTaskDto, FindTasksOptions } from './types';
