import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { TaskService, type Task } from '@ci/domains/planning/task.module';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

function isValidIsoInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const PlanningCreateTaskInputSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  notes: z.string().max(10000).optional(),
  // Mirrors ci.tasks' `tasks_priority_check` (see TaskResolver.assertTaskFields).
  priority: z.number().int().min(0).max(5).optional(),
  dueAt: z.string().refine(isValidIsoInstant, 'dueAt must be a valid ISO 8601 date/time').optional(),
  // Owner-local `YYYY-MM-DD` — an input to PlanningTimeService, never its output.
  scheduledFor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'scheduledFor must be YYYY-MM-DD')
    .optional(),
  // Zoneless wall-clock `HH:MM` or `HH:MM:SS`.
  taskTime: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'taskTime must be HH:MM or HH:MM:SS')
    .optional(),
  estimatedMinutes: z.number().int().min(1).optional(),
  parentId: z.string().uuid().optional(),
});

export type PlanningCreateTaskInput = z.infer<typeof PlanningCreateTaskInputSchema>;

/**
 * Create a task in the personal to-do list, through {@link TaskService.create} — never the
 * repository directly, so tenancy scoping and the `task.created` event (which
 * `TaskSearchIndexListener` consumes to make the task findable through `search`/recall) stay
 * exactly the ones every other writer gets.
 *
 * Deliberately does not accept `status`: `proposed` is the trust-dial review inbox for automation
 * that surfaced work the user did not directly ask for (`planning.todo_scan` et al.), and this tool
 * is a direct, user-directed create — it always lands in the real backlog (`open`, the entity's
 * column default).
 */
@Injectable()
export class PlanningCreateTaskTool extends BaseTool<PlanningCreateTaskInput, Task> {
  readonly schema: IntentDefinition = {
    name: 'planning.createTask',
    domain: 'planning',
    title: 'Create a task',
    description:
      'Create a task in the personal to-do list. Lands directly in the open backlog. ' +
      'dueAt is an instant (ISO 8601); scheduledFor is an owner-local calendar date (YYYY-MM-DD); ' +
      'taskTime is a zoneless wall-clock time (HH:MM). parentId nests this task under an existing one.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    // A create is not destructive and touches only the user's own data — the offline-first case:
    // record it on-device now, reconcile later. Mirrors memory.remember's localCapable rationale.
    localCapable: true,
    produces: ['task'],
    phrases: ['Add a task to $title', 'Remind me to $title', 'Create a to-do for $title'],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The task title.', minLength: 1, maxLength: 500 },
        description: { type: 'string', description: 'Longer free-text description.', maxLength: 5000 },
        notes: { type: 'string', description: 'Freeform notes.', maxLength: 10000 },
        priority: { type: 'integer', minimum: 0, maximum: 5, description: '0 (highest) to 5 (lowest).' },
        dueAt: { type: 'string', description: 'ISO 8601 instant this task is due by.' },
        scheduledFor: {
          type: 'string',
          description: 'Owner-local calendar date (YYYY-MM-DD) to work on this.',
        },
        taskTime: { type: 'string', description: 'Zoneless wall-clock time, HH:MM or HH:MM:SS.' },
        estimatedMinutes: { type: 'integer', minimum: 1, description: 'Estimated effort in minutes.' },
        parentId: { type: 'string', format: 'uuid', description: 'Parent task id, to create a subtask.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { title: 'Draft the Fenwick contract redline', dueAt: '2026-09-20T17:00:00.000Z' },
        output: { id: '11111111-1111-1111-1111-111111111111', title: 'Draft the Fenwick contract redline' },
        description: 'Create an open task with a due date',
      },
    ],
  };

  constructor(
    private readonly taskService: TaskService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlanningCreateTaskTool.name);
  }

  protected validateInput(input: unknown): PlanningCreateTaskInput {
    return PlanningCreateTaskInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlanningCreateTaskInput,
  ): Promise<Task> {
    const serviceContext = toServiceContext(context);

    const task = await this.taskService.create(serviceContext, {
      title: input.title,
      description: input.description,
      notes: input.notes,
      priority: input.priority,
      parentId: input.parentId,
      dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
      scheduledFor: input.scheduledFor,
      taskTime: input.taskTime,
      estimatedMinutes: input.estimatedMinutes,
    });

    if (task == null) {
      throw new Error('Failed to create task');
    }

    return task;
  }
}
