import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { DatabaseSearchTool, type SearchResult } from './DatabaseSearchTool';

const CalendarFindEventsInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type CalendarFindEventsInput = z.infer<typeof CalendarFindEventsInputSchema>;

/**
 * Find events on the personal timeline. A domain-scoped specialization of search: delegates to
 * {@link DatabaseSearchTool} with a fixed `event` entity scope.
 */
@Injectable()
export class CalendarFindEventsTool extends BaseTool<CalendarFindEventsInput, SearchResult[]> {
  readonly schema: IntentDefinition = {
    name: 'calendar.findEvents',
    domain: 'calendar',
    title: 'Find events',
    description: 'Find events on the personal timeline — meetings, trips, captures, purchases.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // Timeline events are the user's own captures/meetings/trips, mirrored on-device; the query is
    // a filter over that mirror, so an offline device can answer it (with a partial timeline).
    localCapable: true,
    produces: ['event'],
    phrases: ['What happened on $date', 'Find my $event'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for on the timeline.' },
        maxResults: { type: 'integer', description: 'Max results (default 25).', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
  };

  constructor(
    private readonly search: DatabaseSearchTool,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(CalendarFindEventsTool.name);
  }

  protected validateInput(input: unknown): CalendarFindEventsInput {
    return CalendarFindEventsInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: CalendarFindEventsInput,
  ): Promise<SearchResult[]> {
    return this.search.run(context, {
      query: input.query,
      maxResults: input.maxResults,
      entityTypes: ['event'],
    });
  }
}
