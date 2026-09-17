import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import type { Event } from '@ci/domains/memory';
import { PlannedBlockService } from '@ci/domains/planning/task.module';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

function isValidIsoInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const PlanningPlannedBlocksInputSchema = z
  .object({
    from: z.string().refine(isValidIsoInstant, 'from must be a valid ISO 8601 date/time'),
    to: z.string().refine(isValidIsoInstant, 'to must be a valid ISO 8601 date/time'),
  })
  .refine((data) => Date.parse(data.to) > Date.parse(data.from), {
    message: 'to must be after from',
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
 * `from`/`to` are ISO 8601 instants at the tool boundary, matching how `planning.findTasks` takes
 * `dueBefore`/`dueAfter` — this tool converts them to `Date` before calling the service, the same
 * translation `planning.findTasks` makes for its own due-date bounds. Unlike that pair, both bounds
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
      'List the calendar blocks already scheduled for tasks, between from and to (both ISO 8601 ' +
      'instants, exclusive/inclusive as a normal calendar range). Use planning.findTasks for work ' +
      'that has not been scheduled yet.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // The user's own calendar, mirrorable on-device — same reasoning as calendar.findEvents.
    localCapable: true,
    produces: ['event', 'task'],
    phrases: ['What is on my schedule $when', 'Show me my planned blocks for $when'],
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO 8601 instant, start of the range (inclusive).' },
        to: { type: 'string', description: 'ISO 8601 instant, end of the range (exclusive).' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { from: '2026-09-16T00:00:00.000Z', to: '2026-09-23T00:00:00.000Z' },
        output: [],
        description: 'List planned blocks for the coming week',
      },
    ],
  };

  constructor(
    private readonly plannedBlockService: PlannedBlockService,
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

    return this.plannedBlockService.list(serviceContext, new Date(input.from), new Date(input.to));
  }
}
