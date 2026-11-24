import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { CALIBRATION_BASIS, CalibrationService, type CalibrationScore } from '@ci/domains/predictions';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const ForecastCalibrationInputSchema = z.object({});

export type ForecastCalibrationInput = z.infer<typeof ForecastCalibrationInputSchema>;

export interface ForecastCalibrationOutput {
  scored: boolean;
  scoredAt: string | null;
  brier: number | null;
  l0Top1Accuracy: number | null;
  l1Top3Accuracy: number | null;
  ece: number | null;
  coverage: number | null;
  driftFlag: boolean;
  basis: string;
  quality: string;
  modelVersion: string | null;
}

const ACC_STRONG = 0.7;
const ACC_FAIR = 0.5;
const ECE_WELL_CALIBRATED = 0.05;
const ECE_ROUGHLY_CALIBRATED = 0.15;

/** Deterministic quality line from fixed thresholds — no LLM. */
export function calibrationQualityStatement(score: CalibrationScore | null): string {
  if (score === null || score.l0Top1Acc === null) {
    return 'No scored forecasts yet — quality cannot be judged until the nightly scoring loop has run.';
  }

  const pct = Math.round(score.l0Top1Acc * 100);
  let statement: string;

  if (score.l0Top1Acc >= ACC_STRONG) {
    statement = `Forecast self-consistency is strong: the top prediction matched pipeline labels ${pct}% of the time`;
  } else if (score.l0Top1Acc >= ACC_FAIR) {
    statement = `Forecast self-consistency is fair: the top prediction matched pipeline labels ${pct}% of the time`;
  } else {
    statement = `Forecast self-consistency is weak: the top prediction matched pipeline labels only ${pct}% of the time`;
  }

  if (score.ece !== null) {
    if (score.ece <= ECE_WELL_CALIBRATED) {
      statement += ' and its confidence is well calibrated against those labels.';
    } else if (score.ece <= ECE_ROUGHLY_CALIBRATED) {
      statement += ' and its confidence is roughly calibrated against those labels.';
    } else {
      statement +=
        ' but its stated confidence is poorly calibrated (probabilities overstate agreement with pipeline labels).';
    }
  } else {
    statement += '.';
  }

  if (score.driftFlag) {
    statement += ' Self-consistency has recently drifted below its trailing baseline.';
  }

  if (score.modelVersion && score.modelVersion !== 'hmt' && !score.modelVersion.startsWith('hmt')) {
    statement += ` The live histogram is currently served from the ${score.modelVersion} baseline, not the transformer.`;
  }

  return statement;
}

@Injectable()
export class ForecastCalibrationTool extends BaseTool<ForecastCalibrationInput, ForecastCalibrationOutput> {
  readonly schema: IntentDefinition = {
    name: 'forecast.calibration',
    domain: 'forecast',
    title: 'Forecast quality',
    description:
      'Report how consistent the behavior forecasts have been against pipeline labels: Brier, top-1/top-3, ' +
      'ECE, drift, and a one-line quality statement. This is self-consistency vs Qwen labels, not ground truth.',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    localCapable: false,
    phrases: [
      'How accurate are my predictions',
      'How good is the forecast',
      'Is the behavior model drifting',
    ],
    parameters: {
      type: 'object',
      properties: {},
    },
  };

  constructor(
    private readonly calibrationService: CalibrationService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ForecastCalibrationTool.name);
  }

  protected validateInput(input: unknown): ForecastCalibrationInput {
    return ForecastCalibrationInputSchema.parse(input ?? {});
  }

  protected async executeInternal(context: ToolExecutionContext): Promise<ForecastCalibrationOutput> {
    const report = await this.calibrationService.getReport(toServiceContext(context), 1);
    const latest = report.latest;

    return {
      scored: latest !== null,
      scoredAt: latest?.scoredAt ?? null,
      brier: latest?.brier ?? null,
      l0Top1Accuracy: latest?.l0Top1Acc ?? null,
      l1Top3Accuracy: latest?.l1Top3Acc ?? null,
      ece: latest?.ece ?? null,
      coverage: latest?.coverage ?? null,
      driftFlag: latest?.driftFlag ?? false,
      basis: CALIBRATION_BASIS,
      quality: calibrationQualityStatement(latest),
      modelVersion: latest?.modelVersion ?? null,
    };
  }
}
