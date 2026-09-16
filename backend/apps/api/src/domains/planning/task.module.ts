import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { EventEntity, MemoryModule } from '@ci/domains/memory';

import { TaskEntity } from './entities/TaskEntity';
import { TaskPendingChangeEntity } from './entities/TaskPendingChangeEntity';
import { TaskService } from './services/TaskService';

/**
 * `TaskService` alone, without the rest of `PlanningModule`.
 *
 * Tiny module for the same reason `ChatModelPreferenceModule`
 * (`domains/llm/chat-model-preference.module.ts`) is one: `PlanningModule` imports
 * `LlmCoreModule` (for `TodoScanService`/`TodoProcessService`/`InboxScanService`, which call
 * `OllamaService`), and `LlmCoreModule` imports `ToolsModule` (`OllamaService` dispatches through
 * `ToolRegistry`). `domains/tools`' own `planning.findTasks`/`planning.createTask` need
 * `TaskService`, so importing `PlanningModule` — or anything that resolves through
 * `@ci/domains/planning`'s barrel — from `domains/tools` would close
 * `tools → planning → llm → tools`, a cycle `no-circular` rejects outright (and there is no
 * `forwardRef` escape for it — this codebase does not use one for module graphs).
 *
 * `TaskService` itself never touches the LLM: its constructor only reaches `EventsModule` and
 * `MemoryModule`, both already leaves of that cycle. A standalone module depending on just those
 * two breaks it — `domains/tools` imports this instead of `PlanningModule`, `PlanningModule`
 * imports this instead of re-declaring the same providers, and neither side imports the other.
 *
 * This file is also the one place cross-domain callers of `TaskService` from inside a
 * cycle-adjacent domain (`domains/tools`) may reach into `domains/planning`'s internals —
 * `no-cross-domain-internals` normally forbids importing anything but another domain's `index.ts`
 * or `events.ts`, so each such import is a deliberate, narrow, grandfathered exception rather than
 * an accident. Re-exporting the plain types a caller needs to call `TaskService` (rather than just
 * the class) keeps that exception to ONE file instead of one per type's home module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TaskEntity, TaskPendingChangeEntity, EventEntity]),
    EventsModule,
    MemoryModule,
  ],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule {}

export { TaskService } from './services/TaskService';
export type { Task, TaskStatus } from './entities/TaskEntity';
export { ACTIVE_TASK_STATUSES, TASK_STATUSES } from './taskStatus';
export type { CreateTaskDto, FindTasksOptions } from './types';
