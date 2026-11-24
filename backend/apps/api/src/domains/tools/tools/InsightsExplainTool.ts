import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { CorrelationEngine } from '@ci/domains/daily-metrics';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const InputSchema = z.object({
  metricA: z.string().optional(),
  metricB: z.string().optional(),
  lagDays: z.number().int().min(0).max(7).optional(),
});

export type InsightsExplainInput = z.infer<typeof InputSchema>;

export interface InsightsExplainOutput {
  found: boolean;
  text: string;
  metricA: string | null;
  metricB: string | null;
  lagDays: number | null;
  n: number | null;
  effect: number | null;
  qValue: number | null;
  robust: boolean;
}

@Injectable()
export class InsightsExplainTool extends BaseTool<InsightsExplainInput, InsightsExplainOutput> {
  readonly schema: IntentDefinition = {
    name: 'insights.explain',
    domain: 'insights',
    title: 'Explain an association',
    description:
      'Explain a pairwise association over daily metrics with its evidence chain (n, r, q, lag, sources). ' +
      'Language is "associated with", never "causes".',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    localCapable: true,
    phrases: ['What is associated with my mood', 'How are exercise and mood related', 'Explain this insight'],
    parameters: {
      type: 'object',
      properties: {
        metricA: { type: 'string', description: 'First metric key, e.g. km_traveled' },
        metricB: { type: 'string', description: 'Second metric key, e.g. avg_sentiment' },
        lagDays: { type: 'integer', minimum: 0, maximum: 7, description: 'Lag of B behind A' },
      },
    },
  };

  constructor(
    private readonly correlationEngine: CorrelationEngine,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(InsightsExplainTool.name);
  }

  protected validateInput(input: unknown): InsightsExplainInput {
    return InputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: InsightsExplainInput,
  ): Promise<InsightsExplainOutput> {
    const serviceContext = toServiceContext(context);
    const rows = await this.correlationEngine.list(serviceContext, { robustOnly: true });
    const match = rows.find((row) => {
      if (input.metricA && row.metricA !== input.metricA && row.metricB !== input.metricA) {
        return false;
      }

      if (input.metricB && row.metricA !== input.metricB && row.metricB !== input.metricB) {
        return false;
      }

      if (input.lagDays !== undefined && row.lagDays !== input.lagDays) {
        return false;
      }

      return true;
    });

    if (!match) {
      const metric = input.metricA ?? input.metricB ?? 'those metrics';

      return {
        found: false,
        text: `Still learning your patterns for ${metric}. There is not enough overlapping history to call an association.`,
        metricA: input.metricA ?? null,
        metricB: input.metricB ?? null,
        lagDays: input.lagDays ?? null,
        n: null,
        effect: null,
        qValue: null,
        robust: false,
      };
    }

    const lag = match.lagDays === 0 ? 'the same day' : `${match.lagDays} day(s) later`;
    const r = match.effect === null ? 'n/a' : match.effect.toFixed(2);
    const q = match.qValue === null ? 'n/a' : match.qValue.toExponential(2);

    return {
      found: true,
      text:
        `${match.metricA.replaceAll('_', ' ')} has been associated with ${match.metricB.replaceAll('_', ' ')} ` +
        `(r=${r}, q=${q}, n=${match.n}, ${lag}). This is a hypothesis, not a cause.`,
      metricA: match.metricA,
      metricB: match.metricB,
      lagDays: match.lagDays,
      n: match.n,
      effect: match.effect,
      qValue: match.qValue,
      robust: match.robust,
    };
  }
}
