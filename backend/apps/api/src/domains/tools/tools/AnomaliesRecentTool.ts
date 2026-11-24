import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { AnomalyEngine } from '@ci/domains/daily-metrics';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const InputSchema = z.object({
  since: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)) || /^\d{4}-\d{2}-\d{2}$/.test(value), {
      message: 'since must be a date',
    })
    .optional(),
  metric: z.string().optional(),
});

export type AnomaliesRecentInput = z.infer<typeof InputSchema>;

export interface AnomaliesRecentItem {
  id: string;
  metric: string;
  date: string;
  detector: string;
  direction: string;
  score: number;
  text: string;
}

export interface AnomaliesRecentOutput {
  items: AnomaliesRecentItem[];
  text: string;
}

@Injectable()
export class AnomaliesRecentTool extends BaseTool<AnomaliesRecentInput, AnomaliesRecentOutput> {
  readonly schema: IntentDefinition = {
    name: 'anomalies.recent',
    domain: 'anomalies',
    title: 'Recent anomalies',
    description:
      'List computed metric and behavioral anomalies (robust z, changepoint, unusual-pattern days). ' +
      'Not the free-text anomalies list inside summaries.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    localCapable: true,
    phrases: ['Anything unusual lately', 'What looked different this week', 'Recent anomalies'],
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Inclusive yyyy-MM-dd or ISO-8601 lower bound' },
        metric: { type: 'string', description: 'Optional metric key filter' },
      },
    },
  };

  constructor(
    private readonly anomalyEngine: AnomalyEngine,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(AnomaliesRecentTool.name);
  }

  protected validateInput(input: unknown): AnomaliesRecentInput {
    return InputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: AnomaliesRecentInput,
  ): Promise<AnomaliesRecentOutput> {
    const since = input.since ? input.since.slice(0, 10) : undefined;
    const rows = await this.anomalyEngine.list(toServiceContext(context), { since, metric: input.metric });

    if (rows.length === 0) {
      const metric = input.metric ?? 'your metrics';

      return {
        items: [],
        text: `Still learning your patterns for ${metric}. No computed anomalies yet.`,
      };
    }

    const items = rows.slice(0, 20).map((row) => ({
      id: row.id,
      metric: row.metric,
      date: row.date,
      detector: row.detector,
      direction: row.direction,
      score: row.score,
      text:
        row.detector === 'hbpe_l0'
          ? `${row.date} looked unlike the usual pattern.`
          : `${row.metric} on ${row.date} was ${row.direction} relative to the recent baseline.`,
    }));

    return { items, text: items.map((item) => item.text).join(' ') };
  }
}
