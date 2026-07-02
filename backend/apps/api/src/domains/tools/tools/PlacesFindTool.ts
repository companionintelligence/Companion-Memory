import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { DatabaseSearchTool, type SearchResult } from './DatabaseSearchTool';

const PlacesFindInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type PlacesFindInput = z.infer<typeof PlacesFindInputSchema>;

/**
 * Find places the user has visited, saved, or referenced. A domain-scoped specialization of
 * search: delegates to {@link DatabaseSearchTool} with a fixed `place` entity scope.
 */
@Injectable()
export class PlacesFindTool extends BaseTool<PlacesFindInput, SearchResult[]> {
  readonly schema: IntentDefinition = {
    name: 'places.find',
    domain: 'places',
    title: 'Find places',
    description: 'Find locations and places the user has visited, saved, or referenced.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    produces: ['place'],
    phrases: ['Where is $place', 'Find places near $area'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Place name or description to match.' },
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
    this.logger.setContext(PlacesFindTool.name);
  }

  protected validateInput(input: unknown): PlacesFindInput {
    return PlacesFindInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PlacesFindInput,
  ): Promise<SearchResult[]> {
    return this.search.run(context, {
      query: input.query,
      maxResults: input.maxResults,
      entityTypes: ['place'],
    });
  }
}
