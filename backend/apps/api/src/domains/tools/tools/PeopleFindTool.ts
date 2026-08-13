import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { DatabaseSearchTool, type SearchResult } from './DatabaseSearchTool';

const PeopleFindInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type PeopleFindInput = z.infer<typeof PeopleFindInputSchema>;

/**
 * Find people in the social graph. A domain-scoped specialization of search: the implementation
 * delegates to {@link DatabaseSearchTool} with a fixed `person` entity scope, co-located with its
 * own curated intent definition.
 */
@Injectable()
export class PeopleFindTool extends BaseTool<PeopleFindInput, SearchResult[]> {
  readonly schema: IntentDefinition = {
    name: 'people.find',
    domain: 'people',
    title: 'Find people',
    description: 'Find people in the social graph matching a name or description.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // A scoped read of the user's own social graph.
    localCapable: true,
    produces: ['person'],
    phrases: ['Find $name', 'Who is $name'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or description to match.' },
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
    this.logger.setContext(PeopleFindTool.name);
  }

  protected validateInput(input: unknown): PeopleFindInput {
    return PeopleFindInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PeopleFindInput,
  ): Promise<SearchResult[]> {
    return this.search.run(context, {
      query: input.query,
      maxResults: input.maxResults,
      entityTypes: ['person'],
    });
  }
}
