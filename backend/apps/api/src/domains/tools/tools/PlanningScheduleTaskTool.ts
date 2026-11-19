import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  PlannedBlockService,
  PlanningTimeService,
  type PlaceOutcome,
} from '@ci/domains/planning/task.module';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import {
  LOCAL_TIME_FORM,
  localTime,
  resolveLocalTime,
  timeZoneInput,
  timeZoneParameter,
} from './ownerLocalTime';

const PlanningScheduleTaskInputSchema = z
  .object({
    taskId: z.string().uuid(),
    // Explicit instant — a calendar drop. Mutually exclusive with `date`.
    startAt: localTime('startAt').optional(),
    // Only meaningful alongside `startAt`; defaults to the task's estimate otherwise.
    endAt: localTime('endAt').optional(),
    // Owner-local `YYYY-MM-DD` preferred day for the auto-placer. Mutually exclusive with `startAt`.
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
    estimatedMinutes: z.number().int().min(1).optional(),
    // IANA zone a zoneless startAt / endAt is read in, instead of the owner's saved one.
    timeZone: timeZoneInput,
  })
  .refine((data) => !(data.startAt && data.date), {
    message: 'Provide either startAt (an explicit instant) or date (a preferred day), not both',
  })
  .refine((data) => !(data.endAt && !data.startAt), {
    message: 'endAt requires startAt',
  })
  .refine((data) => !(data.timeZone && !data.startAt), {
    // Auto-placement plans within working hours, which are kept in the owner's saved zone.
    message: 'timeZone only applies with startAt',
  });

export type PlanningScheduleTaskInput = z.infer<typeof PlanningScheduleTaskInputSchema>;

/**
 * Put a task on the calendar, through {@link PlannedBlockService} — never `CalendarEventService`
 * directly, so the same gap-solving/occupancy rules the Plan page's Schedule button and the
 * calendar grid's drag-drop use are the ones an agent gets too.
 *
 * Two underlying methods, one tool, chosen by whether `startAt` is given:
 *  - No `startAt`: {@link PlannedBlockService.scheduleTask} — "put this somewhere", running the gap
 *    solver over an optional preferred `date` within working hours. This is the natural shape for
 *    "schedule my task" with no particular time in mind.
 *  - `startAt` given: {@link PlannedBlockService.scheduleTaskAt} — an EXPLICIT instant, the same
 *    path the calendar grid's drag-drop uses. The gap solver never runs; the given instant IS the
 *    placement decision. If the task already has an active block, this MOVES it rather than
 *    refusing (matching `scheduleTaskAt`'s own documented behavior) — a drag names a destination,
 *    unlike the no-`startAt` path where a second call on an already-placed task is rightly a no-op.
 *
 * Deliberately does NOT build `planning.rescheduleTask` — moving an EXISTING block by name/relative
 * time (rather than by naming a fresh instant) is architecturally deferred pending a shared Time
 * type (`docs/architecture/planning-roadmap.md`, `shared-time-selectors.plan.md`). A first schedule
 * is a different, unblocked capability from a reschedule; this tool only ever places or moves a
 * block to an instant the CALLER computed, never one this tool resolves from a relative phrase.
 *
 * Not destructive: placing or moving a block is an ordinary, freely-repeatable write — the
 * appointment persists and can be moved again, unlike `planning.completeTask`'s one-way status
 * flip. `localCapable: true` for the same reason `planning.createTask` is: everything read here
 * (the task, the calendar, working hours) is the user's own data with no third-party dependency.
 */
@Injectable()
export class PlanningScheduleTaskTool extends BaseTool<PlanningScheduleTaskInput, PlaceOutcome> {
  readonly schema: IntentDefinition = {
    name: 'planning.scheduleTask',
    local: {
      description:
        'Put a task on the calendar: at startAt (your local YYYY-MM-DDTHH:MM), or in the next free slot, preferring date (YYYY-MM-DD).',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          startAt: { type: 'string', description: 'Local date and time, YYYY-MM-DDTHH:MM, no offset.' },
          date: { type: 'string', description: 'YYYY-MM-DD to prefer when auto-placing.' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    domain: 'planning',
    title: 'Schedule a task',
    description:
      'Place a task on the calendar. With no startAt, auto-places into the next open gap within ' +
      'working hours (optionally preferring date, an owner-local YYYY-MM-DD). With startAt, places — ' +
      'or moves an already-placed task — at that exact time, optionally through endAt. Give startAt ' +
      "and endAt as the owner's local wall-clock time with no offset (2026-11-16T18:00 for 6 PM): " +
      'their time zone, daylight saving included, is applied here, so never convert to UTC yourself. ' +
      'Does not resolve a relative time like "tomorrow afternoon"; the caller must give a concrete ' +
      'date or time.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    localCapable: true,
    produces: ['task', 'event'],
    phrases: ['Schedule $title', 'Put $title on my calendar $when', 'Move $title to $when'],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', format: 'uuid', description: 'The task id to schedule.' },
        startAt: {
          type: 'string',
          description: `When to place this task exactly: ${LOCAL_TIME_FORM}. Omit to auto-place instead.`,
        },
        endAt: {
          type: 'string',
          description:
            'Local date and time this block ends, same form as startAt. Only valid with startAt; defaults to the estimate.',
        },
        date: {
          type: 'string',
          description: 'Owner-local calendar date (YYYY-MM-DD) to prefer for auto-placement.',
        },
        estimatedMinutes: { type: 'integer', minimum: 1, description: 'Estimated effort in minutes.' },
        timeZone: timeZoneParameter('startAt and endAt'),
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { taskId: '11111111-1111-1111-1111-111111111111', date: '2026-09-18' },
        output: { status: 'placed' },
        description: 'Auto-place a task on a preferred day',
      },
    ],
  };

  constructor(
    private readonly plannedBlockService: PlannedBlockService,
    private readonly planningTime: PlanningTimeService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlanningScheduleTaskTool.name);
  }

  protected validateInput(input: unknown): PlanningScheduleTaskInput {
    return PlanningScheduleTaskInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlanningScheduleTaskInput,
  ): Promise<PlaceOutcome> {
    const serviceContext = toServiceContext(context);

    if (input.startAt) {
      const resolve = (value: string) =>
        resolveLocalTime(this.planningTime, serviceContext, value, input.timeZone);
      const startAt = await resolve(input.startAt);
      const endAt = input.endAt ? await resolve(input.endAt) : undefined;

      if (endAt && endAt.getTime() <= startAt.getTime()) {
        throw new Error('endAt must be after startAt');
      }

      return this.plannedBlockService.scheduleTaskAt(
        serviceContext,
        input.taskId,
        startAt,
        endAt,
        input.estimatedMinutes,
      );
    }

    return this.plannedBlockService.scheduleTask(serviceContext, input.taskId, {
      estimatedMinutes: input.estimatedMinutes,
      date: input.date,
    });
  }
}
