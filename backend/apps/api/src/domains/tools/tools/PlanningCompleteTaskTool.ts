import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { TaskService, type Task } from '@ci/domains/planning/task.module';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const PlanningCompleteTaskInputSchema = z.object({
  taskId: z.string().uuid(),
  actualMinutes: z.number().int().min(0).optional(),
});

export type PlanningCompleteTaskInput = z.infer<typeof PlanningCompleteTaskInputSchema>;

const PlanningProposedTaskInputSchema = z.object({
  taskId: z.string().uuid(),
});

export type PlanningAcceptProposedTaskInput = z.infer<typeof PlanningProposedTaskInputSchema>;
export type PlanningDeclineProposedTaskInput = z.infer<typeof PlanningProposedTaskInputSchema>;

/**
 * Mark a task done, through {@link TaskService.complete} — never the repository directly, for the
 * same tenancy/event reasons `planning.createTask` gives. Idempotent: completing an already-done
 * task keeps its original `completedAt` rather than moving it, so "when did I finish this?" stays
 * answerable no matter how many times an agent (re-)calls this.
 *
 * `destructive: true`, unlike `planning.createTask`. Not because completion destroys the task row —
 * `TaskService.reopen` can flip it straight back to `open` — but because nothing in this CURATED
 * surface exposes that reopen path to an agent: there is no `planning.uncompleteTask`. The same
 * "irreversible through THIS channel" reasoning `messaging.send` documents for an unsendable message
 * applies here to an unfinishable-through-this-tool completion. The product already treats
 * completion as the more cautious case: `PersonalizationService`'s own `task_complete` auto-promote
 * threshold is kept deliberately higher than an inferred-answer write because "completing a task is
 * a different, less reversible action" (see its docblock) — every AUTOMATED path to this same effect
 * already asks for confirmation outside `hands_off`. A direct agent call should be at least as
 * cautious as the automation that inspired that threshold, not less.
 *
 * `localCapable: false` follows the same precedent every other `destructive: true` tool in this
 * domain sets (`memory.forget`, `import.import_inbox`, `messaging.send`): an action that is
 * irreversible through its own tool should be confirmed and applied at the appliance — the
 * authoritative tier — rather than resolved against a possibly-stale on-device mirror.
 */
@Injectable()
export class PlanningCompleteTaskTool extends BaseTool<PlanningCompleteTaskInput, Task> {
  readonly schema: IntentDefinition = {
    name: 'planning.completeTask',
    domain: 'planning',
    title: 'Complete a task',
    description:
      'Mark a task done. Idempotent — completing an already-done task keeps its original ' +
      'completion time rather than moving it. actualMinutes optionally records how long the ' +
      'task actually took.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: true, external: false },
    localCapable: false,
    produces: ['task'],
    phrases: ['Mark $title as done', 'I finished $title', 'Complete the task $title'],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', format: 'uuid', description: 'The task id to complete.' },
        actualMinutes: {
          type: 'integer',
          minimum: 0,
          description: 'How long the task actually took, in minutes.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { taskId: '11111111-1111-1111-1111-111111111111', actualMinutes: 30 },
        output: { id: '11111111-1111-1111-1111-111111111111', status: 'done' },
        description: 'Complete a task and record 30 minutes actually spent',
      },
    ],
  };

  constructor(
    private readonly taskService: TaskService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlanningCompleteTaskTool.name);
  }

  protected validateInput(input: unknown): PlanningCompleteTaskInput {
    return PlanningCompleteTaskInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlanningCompleteTaskInput,
  ): Promise<Task> {
    const serviceContext = toServiceContext(context);

    const task = await this.taskService.complete(serviceContext, input.taskId, input.actualMinutes);

    if (task == null) {
      throw new Error(`Task ${input.taskId} not found`);
    }

    return task;
  }
}

/**
 * Accept a proposed task (`status: 'proposed'` → `'open'`), through {@link TaskService.acceptProposed}.
 *
 * `PlanningUpdateTaskTool` deliberately excludes `status` from its input schema so an agent cannot
 * silently complete a task (`status: 'done'`) without going through `planning.completeTask` or
 * reopen an archived task. Exposing `planning.acceptProposedTask` and `planning.declineProposedTask`
 * as dedicated tools lets everyday users review their proposed task inbox from external MCP tools
 * (Claude Desktop, Cursor, OpenClaw, Hermes) while preserving `TaskService.acceptProposed`
 * invariants (no-op if the task is already open/done/archived) and emitting `task.updated`.
 */
@Injectable()
export class PlanningAcceptProposedTaskTool extends BaseTool<PlanningAcceptProposedTaskInput, Task> {
  readonly schema: IntentDefinition = {
    name: 'planning.acceptProposedTask',
    domain: 'planning',
    title: 'Accept a proposed task',
    description:
      'Accept a task proposed from your inbox or memory scan, promoting its status from ' +
      '"proposed" to "open" on your active task board. Idempotent if the task was already accepted.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    localCapable: true,
    produces: ['task'],
    phrases: [
      'Accept the proposed task $title',
      'Approve the suggested task $title',
      'Add proposed task $title to my open tasks',
    ],
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The id of the proposed task to accept.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { taskId: '11111111-1111-1111-1111-111111111111' },
        output: { id: '11111111-1111-1111-1111-111111111111', status: 'open' },
        description: 'Accept a proposed task into the open task list',
      },
    ],
  };

  constructor(
    private readonly taskService: TaskService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlanningAcceptProposedTaskTool.name);
  }

  protected validateInput(input: unknown): PlanningAcceptProposedTaskInput {
    return PlanningProposedTaskInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlanningAcceptProposedTaskInput,
  ): Promise<Task> {
    const serviceContext = toServiceContext(context);
    const task = await this.taskService.acceptProposed(serviceContext, input.taskId);

    if (task == null) {
      throw new Error(`Task ${input.taskId} not found`);
    }

    return task;
  }
}

/**
 * Decline a proposed task (`status: 'proposed'` → `'archived'`), through {@link TaskService.declineProposed}.
 *
 * Marked `destructive: true` and `localCapable: false` for the same reason `planning.completeTask`
 * and `TaskResolver.declineProposedTask` gate declining: archiving a proposed task removes it from
 * the review tray and there is no curated `unarchive` tool, so under `balanced` or `cautious` trust
 * presets a managed app or external agent is gated by a human-in-the-loop PendingAction.
 */
@Injectable()
export class PlanningDeclineProposedTaskTool extends BaseTool<PlanningDeclineProposedTaskInput, Task> {
  readonly schema: IntentDefinition = {
    name: 'planning.declineProposedTask',
    domain: 'planning',
    title: 'Decline a proposed task',
    description:
      'Decline a task proposed from your inbox or memory scan, archiving it so it no longer ' +
      'appears in the proposed review tray. No-op if the task was already accepted into open.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: true, external: false },
    localCapable: false,
    produces: ['task'],
    phrases: [
      'Decline the proposed task $title',
      'Dismiss the suggested task $title',
      'Reject proposed task $title',
    ],
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The id of the proposed task to decline.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { taskId: '11111111-1111-1111-1111-111111111111' },
        output: { id: '11111111-1111-1111-1111-111111111111', status: 'archived' },
        description: 'Decline a proposed task and archive it',
      },
    ],
  };

  constructor(
    private readonly taskService: TaskService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlanningDeclineProposedTaskTool.name);
  }

  protected validateInput(input: unknown): PlanningDeclineProposedTaskInput {
    return PlanningProposedTaskInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlanningDeclineProposedTaskInput,
  ): Promise<Task> {
    const serviceContext = toServiceContext(context);
    const task = await this.taskService.declineProposed(serviceContext, input.taskId);

    if (task == null) {
      throw new Error(`Task ${input.taskId} not found`);
    }

    return task;
  }
}
