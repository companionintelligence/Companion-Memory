import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { type RequestContext, toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { TaskService, type Task } from '@ci/domains/planning/task.module';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, IntentPrivacy, ToolExecutionContext } from '../core/types';

function isValidIsoInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const PlanningUpdateTaskInputSchema = z
  .object({
    taskId: z.string().uuid(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(5000).optional(),
    notes: z.string().max(10000).optional(),
    // Mirrors ci.tasks' `tasks_priority_check` (see TaskResolver.assertTaskFields).
    priority: z.number().int().min(0).max(5).optional(),
    parentId: z.string().uuid().optional(),
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
    // Owner-local `YYYY-MM-DD`.
    deferUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'deferUntil must be YYYY-MM-DD')
      .optional(),
    estimatedMinutes: z.number().int().min(1).optional(),
    actualMinutes: z.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'At least one field to update must be provided',
  });

export type PlanningUpdateTaskInput = z.infer<typeof PlanningUpdateTaskInputSchema>;

/**
 * Update a task in the personal to-do list, through {@link TaskService.update} — never the
 * repository directly, for the same tenancy/event reasons `planning.createTask` gives.
 *
 * Deliberately excludes `status` even though `UpdateTaskDto` allows it. `planning.createTask`'s own
 * docblock explains why status changes are kept out of agent hands: `proposed` is the trust-dial
 * review inbox for automation-surfaced work, and letting a general-purpose update tool flip status
 * would reopen exactly the loophole that tool was designed to close (an agent could just call
 * `planning.updateTask({ status: 'open' })` on a proposed task instead of going through the review
 * flow, or silently complete/archive a task without the confirmation `planning.completeTask` now
 * requires). Also excludes `metadata` — an opaque, schemaless internal bookkeeping field with no
 * natural-language shape for an agent to set — and does not support clearing a field to `null`
 * (only setting a new value): the DTO allows `| null` on several fields, but a curated agent
 * surface only needs "set" today, and adding "clear" is a decision for whoever needs it first.
 *
 * Declared not destructive: most fields here are short and freely re-editable by another call to
 * this same tool, unlike `planning.completeTask`'s one-way status flip. The exception is replacing
 * a description or notes that already hold text. Nothing keeps the old text, so "set the old value
 * back" is not available to anyone, and {@link PlanningUpdateTaskTool.privacyFor} labels that call
 * destructive.
 */
@Injectable()
export class PlanningUpdateTaskTool extends BaseTool<PlanningUpdateTaskInput, Task> {
  readonly schema: IntentDefinition = {
    name: 'planning.updateTask',
    local: {
      description:
        'Change fields on a task; only the given fields change. Not for marking done. dueAt is an ISO 8601 instant; dates are YYYY-MM-DD.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          title: { type: 'string', minLength: 1, maxLength: 500 },
          dueAt: { type: 'string' },
          scheduledFor: { type: 'string' },
          deferUntil: { type: 'string', description: 'YYYY-MM-DD to push it out to.' },
          priority: { type: 'integer', minimum: 0, maximum: 5, description: '0 highest, 5 lowest.' },
          notes: { type: 'string', maxLength: 10000 },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    domain: 'planning',
    title: 'Update a task',
    description:
      'Update fields on an existing task in the personal to-do list. Only the fields provided ' +
      'are changed. Does not accept status — use planning.completeTask to mark a task done. ' +
      'dueAt is an instant (ISO 8601); scheduledFor/deferUntil are owner-local calendar dates ' +
      '(YYYY-MM-DD); taskTime is a zoneless wall-clock time (HH:MM).',
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    // Every field here is the user's own data, freely re-editable by another call — the same
    // offline-first case planning.createTask already makes.
    localCapable: true,
    produces: ['task'],
    phrases: ['Change the due date for $title', 'Rename $title to $newTitle', 'Update the notes on $title'],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', format: 'uuid', description: 'The task id to update.' },
        title: { type: 'string', description: 'The task title.', minLength: 1, maxLength: 500 },
        description: { type: 'string', description: 'Longer free-text description.', maxLength: 5000 },
        notes: { type: 'string', description: 'Freeform notes.', maxLength: 10000 },
        priority: { type: 'integer', minimum: 0, maximum: 5, description: '0 (highest) to 5 (lowest).' },
        parentId: { type: 'string', format: 'uuid', description: 'New parent task id, to nest this task.' },
        dueAt: { type: 'string', description: 'ISO 8601 instant this task is due by.' },
        scheduledFor: {
          type: 'string',
          description: 'Owner-local calendar date (YYYY-MM-DD) to work on this.',
        },
        taskTime: { type: 'string', description: 'Zoneless wall-clock time, HH:MM or HH:MM:SS.' },
        deferUntil: {
          type: 'string',
          description: 'Owner-local calendar date (YYYY-MM-DD) to push this out to.',
        },
        estimatedMinutes: { type: 'integer', minimum: 1, description: 'Estimated effort in minutes.' },
        actualMinutes: { type: 'integer', minimum: 0, description: 'Actual time spent, in minutes.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    examples: [
      {
        input: {
          taskId: '11111111-1111-1111-1111-111111111111',
          priority: 0,
          dueAt: '2026-09-25T17:00:00.000Z',
        },
        output: { id: '11111111-1111-1111-1111-111111111111', priority: 0 },
        description: 'Raise a task to top priority and push its due date',
      },
    ],
  };

  constructor(
    private readonly taskService: TaskService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlanningUpdateTaskTool.name);
  }

  protected validateInput(input: unknown): PlanningUpdateTaskInput {
    return PlanningUpdateTaskInputSchema.parse(input);
  }

  /**
   * Destructive when the call replaces a task's non-empty description or notes with different
   * text: the stored text is gone afterwards, so a write key is refused the call and the autonomy
   * dial asks before it runs (see `ToolHandle.privacyFor`). Filling in an empty field, or sending
   * the text that is already there, stays a plain write.
   */
  async privacyFor(context: RequestContext, input: unknown): Promise<IntentPrivacy | undefined> {
    let parsed: PlanningUpdateTaskInput;

    try {
      parsed = this.validateInput(input);
    } catch {
      // `execute` refuses the same input before it touches anything.
      return undefined;
    }

    if ((parsed.description === undefined && parsed.notes === undefined) || !context.userId) {
      return undefined;
    }

    const task = await this.taskService.findById(toServiceContext(context), parsed.taskId);

    if (task == null) {
      return undefined;
    }

    // Compared trimmed, as `memory.remember` compares a description: resending the stored text
    // with a trailing newline loses nothing.
    const replaces = (stored: string | null, next: string | undefined) =>
      next !== undefined && (stored ?? '').trim() !== '' && next.trim() !== (stored ?? '').trim();

    return replaces(task.description, parsed.description) || replaces(task.notes, parsed.notes)
      ? { ...this.schema.privacy, destructive: true }
      : undefined;
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlanningUpdateTaskInput,
  ): Promise<Task> {
    const serviceContext = toServiceContext(context);
    const { taskId, dueAt, ...rest } = input;

    const task = await this.taskService.update(serviceContext, taskId, {
      ...rest,
      ...(dueAt !== undefined ? { dueAt: new Date(dueAt) } : {}),
    });

    if (task == null) {
      throw new Error(`Task ${taskId} not found`);
    }

    return task;
  }
}
