/**
 * Shared types for the insights domain: the Daily Feature Store metric surface
 * and the descriptive compute-then-narrate question/answer shapes.
 */

/** Every scalar metric column materialized in ci_derived.daily_metrics. */
export type MetricKey =
  | 'n_messages'
  | 'n_conversations'
  | 'n_unique_contacts'
  | 'outbound_ratio'
  | 'avg_sentiment'
  | 'n_places'
  | 'km_traveled'
  | 'screen_minutes'
  | 'n_domains'
  | 'spend_total';

export const METRIC_KEYS: readonly MetricKey[] = [
  'n_messages',
  'n_conversations',
  'n_unique_contacts',
  'outbound_ratio',
  'avg_sentiment',
  'n_places',
  'km_traveled',
  'screen_minutes',
  'n_domains',
  'spend_total',
] as const;

/** A metric is `null` when there is no underlying data for it that day. */
export type MetricValues = Record<MetricKey, number | null>;

/** Per-metric confidence in [0, 1]; a low value warns of a NULL/estimate. */
export type MetricCoverage = Record<MetricKey, number>;

/** Which raw capture tables each metric is derived from (used as citations). */
export const METRIC_SOURCES: Record<MetricKey, readonly string[]> = {
  n_messages: ['ci.communications'],
  n_conversations: ['ci.communications'],
  n_unique_contacts: ['ci.communications'],
  outbound_ratio: ['ci.communications'],
  avg_sentiment: ['ci.communications'],
  n_places: ['ci.position'],
  km_traveled: ['ci.position'],
  screen_minutes: ['ci.browser_activity'],
  n_domains: ['ci.browser_activity'],
  spend_total: ['ci.inventory'],
};

/** A computed (or stored) day of the feature store. */
export interface DailyMetrics {
  userId: string;
  /** YYYY-MM-DD, local to `timezone`. */
  date: string;
  timezone: string;
  metrics: MetricValues;
  coverage: MetricCoverage;
  computedAt: Date;
}
