import { MIN_ANOMALY_COVERAGE } from '../anomaly/anomalyMath';
import type { DailyMetrics, MetricKey } from '../types';

export const SUGGESTION_BASELINE_DAYS = 28;
export const SUGGESTION_MIN_BASELINE_N = 14;
export const CONVERSATIONS_LOW_RATIO = 0.4;
export const SCREEN_SPIKE_RATIO = 1.6;

export type SuggestionArmKey =
  'rel.conversations_low' | 'attention.screen_spike' | 'places.one_place' | 'money.spend_spike';

export interface ArmTrigger {
  key: SuggestionArmKey;
  metric: MetricKey;
  current: number;
  baseline: number;
  gap: number;
  title: string;
  text: string;
  priority: number;
}

export const ARM_PRIORITY: Record<SuggestionArmKey, number> = {
  'rel.conversations_low': 0,
  'places.one_place': 1,
  'attention.screen_spike': 2,
  'money.spend_spike': 3,
};

function coverageOf(row: DailyMetrics, metric: MetricKey): number {
  return row.coverage[metric] ?? 0;
}

function covered(row: DailyMetrics | null, metric: MetricKey): row is DailyMetrics {
  return row !== null && coverageOf(row, metric) >= MIN_ANOMALY_COVERAGE && row.metrics[metric] !== null;
}

export function baselineMean(
  rows: DailyMetrics[],
  metric: MetricKey,
  minN = SUGGESTION_MIN_BASELINE_N,
): number | null {
  const values = rows.filter((row) => covered(row, metric)).map((row) => row.metrics[metric] as number);

  if (values.length < minN) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function whole(value: number): string {
  return String(Math.round(value));
}

function money(value: number): string {
  return value.toFixed(2);
}

export function detectArmTriggers(
  yesterday: DailyMetrics | null,
  window: DailyMetrics[],
  minBaselineN = SUGGESTION_MIN_BASELINE_N,
): ArmTrigger[] {
  const triggers: ArmTrigger[] = [];

  if (covered(yesterday, 'n_conversations')) {
    const typical = baselineMean(window, 'n_conversations', minBaselineN);
    const actual = yesterday.metrics.n_conversations as number;
    if (typical !== null && typical >= 3 && actual <= typical * CONVERSATIONS_LOW_RATIO) {
      triggers.push({
        key: 'rel.conversations_low',
        metric: 'n_conversations',
        current: actual,
        baseline: typical,
        gap: typical - actual,
        title: 'Quiet day',
        text: `You had ${whole(actual)} conversations yesterday vs about ${whole(typical)} most days.`,
        priority: 2,
      });
    }
  }

  if (covered(yesterday, 'n_places')) {
    const places = yesterday.metrics.n_places as number;
    const typical = baselineMean(window, 'n_places', minBaselineN);
    if (places === 1 && typical !== null && typical > 1) {
      triggers.push({
        key: 'places.one_place',
        metric: 'n_places',
        current: 1,
        baseline: typical,
        gap: typical - 1,
        title: 'One place yesterday',
        text: 'You stayed in one place yesterday.',
        priority: 3,
      });
    }
  }

  if (covered(yesterday, 'screen_minutes')) {
    const typical = baselineMean(window, 'screen_minutes', minBaselineN);
    const actual = yesterday.metrics.screen_minutes as number;
    if (typical !== null && typical >= 30 && actual >= typical * SCREEN_SPIKE_RATIO) {
      triggers.push({
        key: 'attention.screen_spike',
        metric: 'screen_minutes',
        current: actual,
        baseline: typical,
        gap: actual - typical,
        title: 'More web time than usual',
        text: `About ${whole(actual)} minutes on the web yesterday vs about ${whole(typical)} most days.`,
        priority: 3,
      });
    }
  }

  if (covered(yesterday, 'spend_total')) {
    const typical = baselineMean(window, 'spend_total', minBaselineN);
    const actual = yesterday.metrics.spend_total as number;
    if (typical !== null && typical > 0 && actual >= typical * 3) {
      triggers.push({
        key: 'money.spend_spike',
        metric: 'spend_total',
        current: actual,
        baseline: typical,
        gap: actual - typical,
        title: 'A bigger spend day',
        text: `You acquired items worth $${money(actual)} yesterday vs about $${money(typical)} most days.`,
        priority: 4,
      });
    }
  }

  return triggers.sort((left, right) => ARM_PRIORITY[left.key] - ARM_PRIORITY[right.key]);
}

export function updateArm(alpha: number, beta: number, accepted: boolean): { alpha: number; beta: number } {
  return accepted ? { alpha: alpha + 1, beta } : { alpha, beta: beta + 1 };
}

/** Posterior mean of Beta(alpha, beta). Dismissed arms sink; used to pick the live card. */
export function armMean(alpha: number, beta: number): number {
  const denom = alpha + beta;

  return denom <= 0 ? 0.5 : alpha / denom;
}

export const SUGGESTION_ARM_KEYS: readonly SuggestionArmKey[] = [
  'rel.conversations_low',
  'attention.screen_spike',
  'places.one_place',
  'money.spend_spike',
];
