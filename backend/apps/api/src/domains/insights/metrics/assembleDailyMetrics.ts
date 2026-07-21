import type { MetricCoverage, MetricValues } from '../types';

import type { RawDailyAggregates } from './dailyAggregateSql';

function round(value: number, dp: number): number {
  const factor = 10 ** dp;

  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

/** Fraction populated/total, clamped to [0,1]; 0 when there are no rows. */
function fraction(part: number, total: number): number {
  return total > 0 ? clamp01(part / total) : 0;
}

export interface AssembledMetrics {
  metrics: MetricValues;
  coverage: MetricCoverage;
}

/**
 * Pure derivation from raw daily counts to the metric surface + coverage.
 *
 * Contract:
 *  - A metric is `null` (NOT 0) when its source produced no usable rows, so a
 *    reader can distinguish "no data" from a real zero.
 *  - `coverage[metric]` is a 0..1 confidence: 1 for pure counts backed by rows,
 *    0 when the source is absent, and the fraction of rows carrying the needed
 *    field for value-bearing metrics (sentiment, location, duration, price).
 */
export function assembleDailyMetrics(raw: RawDailyAggregates): AssembledMetrics {
  const hasComms = raw.comms_rows > 0;
  const posLoc = raw.pos_rows_with_location;
  const hasBrowser = raw.br_rows > 0;
  const brDur = raw.br_rows_with_duration;

  const metrics: MetricValues = {
    n_messages: hasComms ? raw.comms_rows : null,
    n_conversations: hasComms ? raw.comms_threads + raw.comms_nullthread_rows : null,
    n_unique_contacts: hasComms ? raw.comms_unique_contacts : null,
    outbound_ratio: hasComms ? round(raw.comms_outbound / raw.comms_rows, 4) : null,
    avg_sentiment:
      raw.comms_sentiment_count > 0
        ? round((raw.comms_sentiment_sum ?? 0) / raw.comms_sentiment_count, 4)
        : null,
    n_places: posLoc > 0 ? raw.pos_place_cells : null,
    // A single ping cannot define a distance; require at least two located pings.
    km_traveled: posLoc >= 2 ? round(raw.pos_km ?? 0, 3) : null,
    screen_minutes: brDur > 0 ? round((raw.br_duration_seconds_sum ?? 0) / 60, 1) : null,
    n_domains: hasBrowser ? raw.br_distinct_domains : null,
    spend_total: raw.inv_rows_with_price > 0 ? round(raw.inv_price_sum ?? 0, 2) : null,
  };

  const coverage: MetricCoverage = {
    n_messages: hasComms ? 1 : 0,
    n_conversations: hasComms ? 1 : 0,
    n_unique_contacts: hasComms ? 1 : 0,
    outbound_ratio: hasComms ? 1 : 0,
    // fraction of the day's messages that carried a sentiment score
    avg_sentiment: fraction(raw.comms_sentiment_count, raw.comms_rows),
    // fraction of position pings that had coordinates
    n_places: fraction(posLoc, raw.pos_rows),
    km_traveled: fraction(posLoc, raw.pos_rows),
    // fraction of browser rows that carried a duration
    screen_minutes: fraction(brDur, raw.br_rows),
    n_domains: hasBrowser ? 1 : 0,
    // fraction of items acquired that day that carried a price
    spend_total: fraction(raw.inv_rows_with_price, raw.inv_rows),
  };

  return { metrics, coverage };
}
