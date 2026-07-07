import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { SummaryService } from '@ci/domains/summaries';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { SUMMARY_SCAN_LIMIT, projectNarrativeItems, type NarrativeListOutput } from './summaryNarrative';

const InsightsListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  since: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 datetime')
    .optional(),
});

export type InsightsListInput = z.infer<typeof InsightsListInputSchema>;

/**
 * Curated `insights.list` intent — narrative insights from the user's period summaries.
 *
 * Interim honesty: these rows are produced by a free-LLM summarizer over activity windows, so
 * every result is labelled `basis: 'llm-narrative'` — narrative claims, NOT computed analytics.
 * Grounded compute-then-narrate insights land with the daily feature store (CI-Engineering #63).
 */
@Injectable()
export class InsightsListTool extends BaseTool<InsightsListInput, NarrativeListOutput> {
  readonly schema: IntentDefinition = {
    name: 'insights.list',
    domain: 'insights',
    title: 'List insights',
    description:
      "Narrative insights derived from the user's recent activity summaries, newest first. " +
      "These are written by an LLM summarizer (basis: 'llm-narrative') — treat them as " +
      'narrative observations, not computed metrics.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    phrases: ['What insights do you have about me', 'What have you noticed about my week'],
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Max insight items to return (default 20).',
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        since: {
          type: 'string',
          description:
            'ISO 8601 datetime; only include insights from summary windows ending at or after this time.',
        },
      },
    },
  };

  constructor(
    private readonly summaries: SummaryService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(InsightsListTool.name);
  }

  protected validateInput(input: unknown): InsightsListInput {
    return InsightsListInputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: InsightsListInput,
  ): Promise<NarrativeListOutput> {
    const summaries = await this.summaries.findRecent(toServiceContext(context), SUMMARY_SCAN_LIMIT);

    return projectNarrativeItems(summaries, 'keyInsights', {
      since: input.since,
      limit: input.limit,
    });
  }
}
