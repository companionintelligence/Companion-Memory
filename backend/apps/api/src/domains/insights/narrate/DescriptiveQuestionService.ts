import { Inject, Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';

import { shiftIso, todayIso } from '../dateUtil';
import { DailyMetricsService } from '../services/DailyMetricsService';
import type { DailyMetrics, MetricKey } from '../types';
import { METRIC_SOURCES } from '../types';

import { aggregate, applyScale, formatValue, type DaySample } from './answerMath';
import { NARRATOR, type AnswerProvenance, type Narrator } from './Narrator';
import { QUESTION_CATALOG, type QuestionSpec } from './questionCatalog';

export interface DescriptiveAnswer {
  key: string;
  category: string;
  question: string;
  /** The deterministically computed value (null when there's no data). */
  value: number | null;
  unit?: string;
  timeframe: string;
  /** The narrated sentence. */
  answer: string;
  provenance: AnswerProvenance;
}

export interface AnswerOptions {
  /** Anchor date (YYYY-MM-DD), inclusive end of every timeframe. Defaults to today (UTC). */
  date?: string;
}

/**
 * Compute-then-narrate: for each descriptive question spec it (1) reads the
 * pre-computed daily_metrics over the question's timeframe, (2) aggregates the
 * metric deterministically into a value + provenance, then (3) hands that to a
 * Narrator for phrasing. The narrator only affects `.answer`; `.value` is always
 * the computed number, so a swapped-in LLM narrator can never change the fact.
 */
@Injectable()
export class DescriptiveQuestionService {
  constructor(
    private readonly metricsService: DailyMetricsService,
    @Inject(NARRATOR) private readonly narrator: Narrator,
  ) {}

  listQuestions(): readonly QuestionSpec[] {
    return QUESTION_CATALOG;
  }

  async answer(
    context: UserServiceContext,
    spec: QuestionSpec,
    options: AnswerOptions = {},
  ): Promise<DescriptiveAnswer> {
    const anchor = options.date ?? todayIso();
    const from = shiftIso(anchor, -(spec.timeframe.days - 1));

    const rows = await this.metricsService.getRange(context, from, anchor);
    const samples = this.toSamples(rows, spec.metric);
    const aggregated = aggregate(spec.aggregate, samples);

    const scaled = aggregated.value === null ? null : applyScale(aggregated.value, spec.scale);
    const displayValue = scaled === null ? null : formatValue(scaled, spec.format);

    const provenance: AnswerProvenance = {
      metric: spec.metric,
      aggregate: spec.aggregate,
      timeframe: spec.timeframe.label,
      dateRange: { from, to: anchor },
      daysWithData: aggregated.daysWithData,
      daysInRange: spec.timeframe.days,
      meanCoverage: aggregated.meanCoverage,
      sources: METRIC_SOURCES[spec.metric],
    };

    const fields: Record<string, string | number> = {
      value: displayValue ?? 'n/a',
      unit: spec.unit ?? '',
      timeframe: spec.timeframe.label,
      days: spec.timeframe.days,
      daysWithData: aggregated.daysWithData,
      coveragePct: Math.round(aggregated.meanCoverage * 100),
    };

    const narrated = await this.narrator.narrate({
      questionKey: spec.key,
      category: spec.category,
      question: spec.question,
      template: spec.template,
      value: scaled,
      unit: spec.unit,
      fields,
      provenance,
    });

    return {
      key: spec.key,
      category: spec.category,
      question: spec.question,
      value: scaled,
      unit: spec.unit,
      timeframe: spec.timeframe.label,
      answer: narrated,
      provenance,
    };
  }

  /** Answer the whole catalog for one anchor date. */
  async answerAll(context: UserServiceContext, options: AnswerOptions = {}): Promise<DescriptiveAnswer[]> {
    const answers: DescriptiveAnswer[] = [];
    for (const spec of QUESTION_CATALOG) {
      answers.push(await this.answer(context, spec, options));
    }

    return answers;
  }

  /** Keep only days that actually have a value for this metric (null = dropped). */
  private toSamples(rows: DailyMetrics[], metric: MetricKey): DaySample[] {
    const samples: DaySample[] = [];
    for (const row of rows) {
      const value = row.metrics[metric];
      if (value === null || value === undefined) {
        continue;
      }

      samples.push({ date: row.date, value, coverage: row.coverage?.[metric] ?? 0 });
    }

    return samples;
  }
}
