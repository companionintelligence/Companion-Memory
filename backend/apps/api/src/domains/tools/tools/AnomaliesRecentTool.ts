import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { SummaryService } from '@ci/domains/summaries';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

import { SUMMARY_SCAN_LIMIT, projectNarrativeItems, type NarrativeListOutput } from './summaryNarrative';

const AnomaliesRecentInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  since: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 datetime')
    .optional(),
});

export type AnomaliesRecentInput = z.infer<typeof AnomaliesRecentInputSchema>;

/**
 * Curated `anomalies.recent` intent — routine deviations surfaced from period summaries.
 *
 * Interim source: the LLM summarizer's per-window `anomalies` projection, so every result is
 * labelled `basis: 'llm-narrative'`. A grounded divergence producer (forecast-vs-actual scoring
 * loop) will replace this as the primary source.
 */
@Injectable()
export class AnomaliesRecentTool extends BaseTool<AnomaliesRecentInput, NarrativeListOutput> {
  readonly schema: IntentDefinition = {
    name: 'anomalies.recent',
    domain: 'anomalies',
    title: 'Recent anomalies',
    description:
      "Deviations from the user's routine noted in recent activity summaries, newest first. " +
      "Interim source: an LLM summarizer's narrative anomalies (basis: 'llm-narrative') — a " +
      'grounded divergence producer (forecast-vs-actual scoring) is coming and will replace it.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    phrases: ['Anything unusual lately', 'Did anything out of the ordinary happen this week'],
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Max anomaly items to return (default 20).',
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        since: {
          type: 'string',
          description:
            'ISO 8601 datetime; only include anomalies from summary windows ending at or after this time.',
        },
      },
    },
  };

  constructor(
    private readonly summaries: SummaryService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(AnomaliesRecentTool.name);
  }

  protected validateInput(input: unknown): AnomaliesRecentInput {
    return AnomaliesRecentInputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: AnomaliesRecentInput,
  ): Promise<NarrativeListOutput> {
    const summaries = await this.summaries.findRecent(toServiceContext(context), SUMMARY_SCAN_LIMIT);

    return projectNarrativeItems(summaries, 'anomalies', {
      since: input.since,
      limit: input.limit,
    });
  }
}
