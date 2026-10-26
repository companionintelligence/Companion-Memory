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
