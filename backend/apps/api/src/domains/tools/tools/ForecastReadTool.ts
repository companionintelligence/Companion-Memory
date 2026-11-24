import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { FORECAST_HORIZONS, HbpeService, type ForecastResponse } from '@ci/domains/predictions';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const ForecastReadInputSchema = z.object({
  horizon: z.enum(FORECAST_HORIZONS).optional().default('24h'),
});

export type ForecastReadInput = z.infer<typeof ForecastReadInputSchema>;

export interface ForecastLabelProbability {
  label: string;
  probability: number;
}

export interface ForecastSummaryBucket {
  bucketIndex: number;
  startTime: string;
  dominantL0: ForecastLabelProbability | null;
  topL1: ForecastLabelProbability | null;
}

export interface ForecastReadOutput {
  horizon: string;
  generatedAt: string;
  systemStatus: string;
  bucketCount: number;
  buckets: ForecastSummaryBucket[];
}

export function summarizeForecast(response: ForecastResponse): ForecastReadOutput {
  const buckets = (response.buckets ?? []).map((bucket) => ({
    bucketIndex: bucket.bucket_index,
    startTime: bucket.start_time,
    dominantL0: dominantEntry(bucket.l0_probs),
    topL1: dominantEntry(bucket.l1_probs),
  }));

  return {
    horizon: response.horizon,
    generatedAt: response.generated_at,
    systemStatus: response.system_status,
    bucketCount: buckets.length,
    buckets,
  };
}

function dominantEntry(probs: Record<string, number> | null | undefined): ForecastLabelProbability | null {
  if (!probs) {
    return null;
  }

  let best: ForecastLabelProbability | null = null;

  for (const [label, value] of Object.entries(probs)) {
    const probability = Number(value);
    if (Number.isNaN(probability)) {
      continue;
    }

    if (
      best === null ||
      probability > best.probability ||
      (probability === best.probability && label.localeCompare(best.label) < 0)
    ) {
      best = { label, probability: Math.round(probability * 10_000) / 10_000 };
    }
  }

  return best;
}

@Injectable()
export class ForecastReadTool extends BaseTool<ForecastReadInput, ForecastReadOutput> {
  readonly schema: IntentDefinition = {
    name: 'forecast.read',
    domain: 'forecast',
    title: 'Read Forecast',
    description:
      'Predict what the user will likely be doing over the next day. Returns 96 fifteen-minute buckets, ' +
      'each with the dominant predicted activity class (L0) and its probability plus the most likely ' +
      'fine-grained activity (L1), and the engine status (COLD_START/TRAINING/READY).',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    localCapable: false,
    phrases: [
      'What will I be doing at $time',
      'When am I free $day',
      'Predict my day tomorrow',
      'What does tomorrow look like for me',
    ],
    parameters: {
      type: 'object',
      properties: {
        horizon: {
          type: 'string',
          enum: [...FORECAST_HORIZONS],
          default: '24h',
          description: "Forecast horizon; only '24h' (96 × 15-minute buckets) is supported.",
        },
      },
    },
  };

  constructor(
    private readonly hbpeService: HbpeService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ForecastReadTool.name);
  }

  protected validateInput(input: unknown): ForecastReadInput {
    return ForecastReadInputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: ForecastReadInput,
  ): Promise<ForecastReadOutput> {
    const response = await this.hbpeService.getForecast(toServiceContext(context), input.horizon);

    return summarizeForecast(response);
  }
}
