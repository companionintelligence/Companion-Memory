import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import type { Event } from '@ci/domains/memory';
import { PlannedBlockService, PlanningTimeService } from '@ci/domains/planning/task.module';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import {
  LOCAL_TIME_FORM,
  localTime,
  resolveLocalTime,
  timeZoneInput,
  timeZoneParameter,
} from './ownerLocalTime';

const PlanningPlannedBlocksInputSchema = z.object({
  from: localTime('from'),
  to: localTime('to'),
  timeZone: timeZoneInput,
});

export type PlanningPlannedBlocksInput = z.infer<typeof PlanningPlannedBlocksInputSchema>;

/**
 * List the calendar blocks already scheduled for tasks, through
 * {@link PlannedBlockService.list} — a SQL-pushdown range query over `ci.events`, bounded and
 * capped, not `CalendarEventService.findAll`'s unbounded explorer-facing read.
 *
 * Pairs with `planning.findTasks`: findTasks answers "what am I supposed to be doing" (the open
 * backlog), this answers "what's already on the schedule" — together, the full picture an agent
 * needs before proposing when to do the rest.
 *
 * `from`/`to` are the owner's local times at the tool boundary (see ownerLocalTime), matching how
 * `planning.findTasks` takes `dueBefore`/`dueAfter` — this tool converts them to instants before
 * calling the service, the same translation `planning.findTasks` makes for its own due-date bounds. Unlike that pair, both bounds
 * are REQUIRED here: `PlannedBlockService.list` is a genuinely bounded range query with no
 * unbounded fallback (its `.take(200)` cap exists precisely because nothing should read this table
 * without a range), so there is no sensible default to invent that the service itself doesn't have.
 */
@Injectable()
export class PlanningPlannedBlocksTool extends BaseTool<PlanningPlannedBlocksInput, Event[]> {
  readonly schema: IntentDefinition = {
    name: 'planning.plannedBlocks',
    domain: 'planning',
    title: 'List planned blocks',
    description:
      'List the calendar blocks already scheduled for tasks, between from (inclusive) and to ' +
      "(exclusive), both in the owner's local time: a day is from 2026-11-16 to 2026-11-17. " +
      'Use planning.findTasks for work ' +
      'that has not been scheduled yet.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // The user's own calendar, mirrorable on-device — same reasoning as calendar.findEvents.
    localCapable: true,
    produces: ['event', 'task'],
    phrases: ['What is on my schedule $when', 'Show me my planned blocks for $when'],
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: `Start of the range (inclusive): ${LOCAL_TIME_FORM}.` },
        to: { type: 'string', description: `End of the range (exclusive): ${LOCAL_TIME_FORM}.` },
        timeZone: timeZoneParameter('from and to'),
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { from: '2026-09-16', to: '2026-09-23' },
        output: [],
        description: 'List planned blocks for the coming week',
      },
    ],
  };

  constructor(
    private readonly plannedBlockService: PlannedBlockService,
    private readonly planningTime: PlanningTimeService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlanningPlannedBlocksTool.name);
  }

  protected validateInput(input: unknown): PlanningPlannedBlocksInput {
    return PlanningPlannedBlocksInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlanningPlannedBlocksInput,
  ): Promise<Event[]> {
    const serviceContext = toServiceContext(context);

    const from = await resolveLocalTime(this.planningTime, serviceContext, input.from, input.timeZone);
    const to = await resolveLocalTime(this.planningTime, serviceContext, input.to, input.timeZone);

    if (to.getTime() <= from.getTime()) {
      throw new Error('to must be after from');
    }

    return this.plannedBlockService.list(serviceContext, from, to);
  }
}
