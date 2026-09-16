import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ACTIVE_TASK_STATUSES, TASK_STATUSES, TaskService, type Task } from '@ci/domains/planning/task.module';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

function isValidIsoInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const PlanningFindTasksInputSchema = z.object({
  status: z.array(z.enum(TASK_STATUSES)).min(1).optional(),
  query: z.string().min(1).max(200).optional(),
  dueBefore: z.string().refine(isValidIsoInstant, 'dueBefore must be a valid ISO 8601 date/time').optional(),
  dueAfter: z.string().refine(isValidIsoInstant, 'dueAfter must be a valid ISO 8601 date/time').optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type PlanningFindTasksInput = z.infer<typeof PlanningFindTasksInputSchema>;

/**
 * Find tasks in the personal to-do list.
 *
 * A thin filter over {@link TaskService.findAll}: `status` and tenancy scoping go straight to the
 * database query. `query` (title substring) and the due-date range are NOT pushed down to SQL —
 * `FindTasksOptions` does not carry them, and `TaskService`'s own doc comment is explicit that
 * planning services are the only sanctioned path to `ci.tasks`, so widening its query surface is
 * that service's call, not this tool's. Filtering the already tenant-scoped result in memory is a
 * defensible, reviewable trade for a personal task list; it would not be for a shared corpus.
 */
@Injectable()
export class PlanningFindTasksTool extends BaseTool<PlanningFindTasksInput, Task[]> {
  readonly schema: IntentDefinition = {
    name: 'planning.findTasks',
    domain: 'planning',
    title: 'Find tasks',
    description:
      'Find tasks in the personal to-do list. Defaults to open/in-progress/delegated work ' +
      '("what am I supposed to be doing") when no status is given; pass status explicitly to see ' +
      'proposed, done, skipped, or archived tasks instead. query matches (case-insensitively) ' +
      'anywhere in the title. dueBefore/dueAfter bound dueAt (ISO 8601, inclusive).',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // ci.tasks is entirely the user's own data with no third-party dependency, so a partial
    // on-device mirror can answer this — worse (staler) than the appliance, not impossible.
    localCapable: true,
    produces: ['task'],
    phrases: ['What are my tasks', 'What do I have to do about $topic', 'Show me tasks due $when'],
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          items: { type: 'string', enum: [...TASK_STATUSES] },
          minItems: 1,
          description: 'Filter to these statuses. Default: open, in_progress, delegated.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring to match against the task title.',
          minLength: 1,
          maxLength: 200,
        },
        dueBefore: {
          type: 'string',
          description: 'ISO 8601 date/time. Only tasks due at or before this instant.',
        },
        dueAfter: {
          type: 'string',
          description: 'ISO 8601 date/time. Only tasks due at or after this instant.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of results (default 25).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    examples: [
      {
        input: { query: 'Fenwick' },
        output: [],
        description: 'Find open tasks mentioning "Fenwick" in the title',
      },
    ],
  };

  constructor(
    private readonly taskService: TaskService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlanningFindTasksTool.name);
  }

  protected validateInput(input: unknown): PlanningFindTasksInput {
    return PlanningFindTasksInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlanningFindTasksInput,
  ): Promise<Task[]> {
    const serviceContext = toServiceContext(context);

    const status = input.status?.length ? input.status : [...ACTIVE_TASK_STATUSES];
    const tasks = await this.taskService.findAll(serviceContext, { status });

    const dueBefore = input.dueBefore ? new Date(input.dueBefore) : undefined;
    const dueAfter = input.dueAfter ? new Date(input.dueAfter) : undefined;
    const needle = input.query?.trim().toLowerCase();

    const filtered = tasks.filter((task) => {
      if (dueBefore && (task.dueAt == null || task.dueAt.getTime() > dueBefore.getTime())) {
        return false;
      }

      if (dueAfter && (task.dueAt == null || task.dueAt.getTime() < dueAfter.getTime())) {
        return false;
      }

      if (needle && !task.title.toLowerCase().includes(needle)) {
        return false;
      }

      return true;
    });

    return filtered.slice(0, input.limit ?? 25);
  }
}
