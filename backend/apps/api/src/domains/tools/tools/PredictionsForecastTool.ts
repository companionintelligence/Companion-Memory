import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

import { toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { HbpeService, type ForecastResponse } from '@ci/domains/predictions';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

/** The only horizon the HBPE sidecar's /histogram endpoint accepts today. */
const SUPPORTED_HORIZON = '24h';

const PredictionsForecastInputSchema = z.object({
  horizon: z.string().default(SUPPORTED_HORIZON),
  fromNow: z.boolean().default(true),
});

export type PredictionsForecastInput = z.infer<typeof PredictionsForecastInputSchema>;

/** The most probable label of a probability histogram (top-1). */
export interface ForecastTopLabel {
  label: string;
  prob: number;
}

/** One 30-minute forecast bucket, reduced to the agent-relevant top-1 signals. */
export interface PredictionsForecastBucket {
  /** ISO start time of the 30-minute bucket. */
  startTime: string;
  /** Most likely L0 activity for the bucket. */
  topActivity: ForecastTopLabel;
  /** Most likely L1 context for the bucket, if the model produced one. */
  topContext: ForecastTopLabel | null;
}

/**
 * Result shape of `predictions.forecast`. Either an honest "not available" (feature off,
 * cold start, sidecar down, unsupported horizon) or the compacted forecast.
 *
 * NOTE: the sidecar's q10/q50/q90 are deliberately NOT exposed — they are a cross-day spread
 * (how much past days agreed), not a predictive confidence interval, and labelling them
 * "confidence" would mislead agents.
 */
export type PredictionsForecastOutput =
  | { available: false; reason?: string; status?: string; message?: string }
  | {
      available: true;
      horizon: string;
      generatedAt: string;
      /** HBPE engine status passthrough (READY once a trained checkpoint exists). */
      systemStatus: string;
      buckets: PredictionsForecastBucket[];
    };

/**
 * Curated `predictions.forecast` intent — the read-only agent surface over the HBPE
 * behavioral-prediction sidecar (CI-Engineering #59).
 *
 * Gated on the `hbpe` feature flag exactly like the GraphQL ForecastResolver; degrades to a
 * structured `{ available: false, … }` result (never a raw throw) when the flag is off, the
 * model is still cold-starting, or the sidecar is unreachable, so harnesses can always parse
 * the response.
 */
@Injectable()
export class PredictionsForecastTool extends BaseTool<PredictionsForecastInput, PredictionsForecastOutput> {
  readonly schema: IntentDefinition = {
    name: 'predictions.forecast',
    domain: 'predictions',
    title: 'Forecast likely activities',
    description:
      "Forecast the user's likely activities: 30-minute buckets, each with the most likely " +
      'activity (and context) plus its probability. Only a 24h window is currently supported ' +
      'by the HBPE prediction engine — other horizons are rejected. May report ' +
      'available:false while the engine is still learning the user’s patterns.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    phrases: [
      'What am I likely to do next',
      'What does the rest of my day look like',
      'Predict my activities for tomorrow',
    ],
    parameters: {
      type: 'object',
      properties: {
        horizon: {
          type: 'string',
          description:
            "Forecast window. Only '24h' is currently supported by the HBPE sidecar; any other " +
            'value returns available:false.',
          default: SUPPORTED_HORIZON,
        },
        fromNow: {
          type: 'boolean',
          description: 'Only include buckets starting at or after the current time (default true).',
          default: true,
        },
      },
    },
  };

  constructor(
    private readonly hbpe: HbpeService,
    private readonly features: FeatureService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PredictionsForecastTool.name);
  }

  protected validateInput(input: unknown): PredictionsForecastInput {
    return PredictionsForecastInputSchema.parse(input ?? {});
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: PredictionsForecastInput,
  ): Promise<PredictionsForecastOutput> {
    if (!(await this.features.isFeatureEnabled('hbpe'))) {
      return { available: false, reason: 'hbpe feature disabled' };
    }

    if (input.horizon !== SUPPORTED_HORIZON) {
      return {
        available: false,
        reason: `unsupported horizon '${input.horizon}' — the HBPE sidecar currently supports only '${SUPPORTED_HORIZON}'`,
      };
    }

    let response: ForecastResponse;

    try {
      response = await this.hbpe.getForecast(toServiceContext(context), SUPPORTED_HORIZON);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        return { available: false, reason: 'forecast service unavailable' };
      }

      throw error;
    }

    // Cold-start honesty: anything but READY means the engine has no trained checkpoint yet
    // (COLD_START, or a live BOOTSTRAP/NIGHTLY workflow step) — say so instead of returning
    // low-signal placeholder histograms.
    const status = response.system_status;

    if (status !== 'READY' || response.buckets.length === 0) {
      return { available: false, status, message: 'still learning your patterns' };
    }

    const now = Date.now();
    const buckets: PredictionsForecastBucket[] = [];

    for (const bucket of response.buckets) {
      if (input.fromNow && Date.parse(bucket.start_time) < now) {
        continue;
      }

      const topActivity = this.topLabel(bucket.l0_probs);

      // A READY bucket without any L0 mass carries no signal — skip rather than fabricate.
      if (!topActivity) {
        continue;
      }

      buckets.push({
        startTime: bucket.start_time,
        topActivity,
        topContext: this.topLabel(bucket.l1_probs),
      });
    }

    return {
      available: true,
      horizon: response.horizon,
      generatedAt: response.generated_at,
      systemStatus: status,
      buckets,
    };
  }

  private topLabel(probs: Record<string, number> | null | undefined): ForecastTopLabel | null {
    if (!probs) {
      return null;
    }

    let best: ForecastTopLabel | null = null;

    for (const [label, prob] of Object.entries(probs)) {
      if (best === null || prob > best.prob) {
        best = { label, prob };
      }
    }

    if (best) {
      // Keep the payload compact for LLM consumption.
      best = { label: best.label, prob: Math.round(best.prob * 10_000) / 10_000 };
    }

    return best;
  }
}
