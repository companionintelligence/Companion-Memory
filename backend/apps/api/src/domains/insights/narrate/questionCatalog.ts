import type { MetricKey } from '../types';

/** The ten life domains the insight engine organizes questions under. */
export type Category =
  | 'Body'
  | 'Time'
  | 'Relationships'
  | 'Mind'
  | 'Places'
  | 'Money'
  | 'Attention'
  | 'Home'
  | 'Identity'
  | 'Commitments';

/** How a metric's daily series is collapsed over the timeframe. */
export type Aggregate = 'latest' | 'sum' | 'avg' | 'max' | 'active_days';

export interface Timeframe {
  /** Number of calendar days ending on the anchor date (1 = the anchor day). */
  days: number;
  /** Human phrase used in narration, e.g. "today", "the last 7 days". */
  label: string;
}

export type ValueFormat = 'int' | 'float1' | 'float2' | 'money' | 'signed2';

/**
 * A declarative descriptive question: it names a metric, how to aggregate it
 * over a timeframe, and how to phrase the result. The plan is fully data — no
 * per-question code — so the compute-then-narrate service can execute any spec.
 */
export interface QuestionSpec {
  key: string;
  category: Category;
  question: string;
  metric: MetricKey;
  aggregate: Aggregate;
  timeframe: Timeframe;
  /**
   * Narration template. Available placeholders: {value}, {unit}, {timeframe},
   * {days}, {daysWithData}, {coveragePct}.
   */
  template: string;
  unit?: string;
  format: ValueFormat;
  /** Optional multiplier applied to the aggregated value before formatting
   *  (e.g. 100 for a ratio→percent, 1/60 for minutes→hours). */
  scale?: number;
}

export const TODAY: Timeframe = { days: 1, label: 'today' };
export const WEEK: Timeframe = { days: 7, label: 'the last 7 days' };
export const MONTH: Timeframe = { days: 30, label: 'the last 30 days' };

/**
 * The descriptive question catalog (prototype slice). ~18 questions spanning
 * several of the ten life domains, each mapping to a metric that is actually
 * materialized in ci_derived.daily_metrics.
 */
export const QUESTION_CATALOG: readonly QuestionSpec[] = [
  // ── Relationships ────────────────────────────────────────────────
  {
    key: 'rel.conversations_today',
    category: 'Relationships',
    question: 'How many conversations did I have today?',
    metric: 'n_conversations',
    aggregate: 'latest',
    timeframe: TODAY,
    format: 'int',
    template: 'You had {value} conversations {timeframe}.',
  },
  {
    key: 'rel.unique_contacts_week',
    category: 'Relationships',
    question: 'How many different people am I talking to lately?',
    metric: 'n_unique_contacts',
    aggregate: 'avg',
    timeframe: WEEK,
    format: 'float1',
    template: 'You talked with about {value} different people per day over {timeframe}.',
  },
  {
    key: 'rel.busiest_day_week',
    category: 'Relationships',
    question: 'What was my most social day this week?',
    metric: 'n_conversations',
    aggregate: 'max',
    timeframe: WEEK,
    format: 'int',
    template: 'Your most social day in {timeframe} had {value} conversations.',
  },
  {
    key: 'rel.messages_week',
    category: 'Relationships',
    question: 'How many messages did I exchange this week?',
    metric: 'n_messages',
    aggregate: 'sum',
    timeframe: WEEK,
    format: 'int',
    template: 'You exchanged {value} messages over {timeframe}.',
  },

  // ── Identity ─────────────────────────────────────────────────────
  {
    key: 'identity.initiation_month',
    category: 'Identity',
    question: 'Do I start conversations or mostly respond?',
    metric: 'outbound_ratio',
    aggregate: 'avg',
    timeframe: MONTH,
    format: 'float1',
    scale: 100,
    unit: '%',
    template: 'You initiate about {value}% of your conversations over {timeframe}.',
  },

  // ── Mind ─────────────────────────────────────────────────────────
  {
    key: 'mind.sentiment_today',
    category: 'Mind',
    question: 'What was the tone of my conversations today?',
    metric: 'avg_sentiment',
    aggregate: 'latest',
    timeframe: TODAY,
    format: 'signed2',
    template: 'Your conversations {timeframe} had an average sentiment of {value} (-1 to +1).',
  },
  {
    key: 'mind.sentiment_week',
    category: 'Mind',
    question: 'How positive have my conversations been this week?',
    metric: 'avg_sentiment',
    aggregate: 'avg',
    timeframe: WEEK,
    format: 'signed2',
    template: 'Your average conversation sentiment over {timeframe} was {value} (-1 to +1).',
  },

  // ── Places ───────────────────────────────────────────────────────
  {
    key: 'places.today',
    category: 'Places',
    question: 'How many places did I visit today?',
    metric: 'n_places',
    aggregate: 'latest',
    timeframe: TODAY,
    format: 'int',
    template: 'You visited {value} distinct places {timeframe}.',
  },
  {
    key: 'places.avg_week',
    category: 'Places',
    question: 'How much do I move around on a typical day?',
    metric: 'n_places',
    aggregate: 'avg',
    timeframe: WEEK,
    format: 'float1',
    template: 'You visited about {value} distinct places per day over {timeframe}.',
  },

  // ── Body / movement ──────────────────────────────────────────────
  {
    key: 'body.km_today',
    category: 'Body',
    question: 'How far did I travel today?',
    metric: 'km_traveled',
    aggregate: 'latest',
    timeframe: TODAY,
    format: 'float1',
    unit: 'km',
    template: 'You traveled about {value} km {timeframe}.',
  },
  {
    key: 'body.km_week',
    category: 'Body',
    question: 'How far have I traveled this week?',
    metric: 'km_traveled',
    aggregate: 'sum',
    timeframe: WEEK,
    format: 'float1',
    unit: 'km',
    template: 'You traveled about {value} km over {timeframe}.',
  },
  {
    key: 'body.active_days_week',
    category: 'Body',
    question: 'How many days was I on the move this week?',
    metric: 'km_traveled',
    aggregate: 'active_days',
    timeframe: WEEK,
    format: 'int',
    template: 'You were on the move on {value} of the last {days} days.',
  },

  // ── Attention ────────────────────────────────────────────────────
  {
    key: 'attention.screen_today',
    category: 'Attention',
    question: 'How much time did I spend on the web today?',
    metric: 'screen_minutes',
    aggregate: 'latest',
    timeframe: TODAY,
    format: 'float1',
    unit: 'min',
    template: 'You spent about {value} minutes on the web {timeframe}.',
  },
  {
    key: 'attention.screen_avg_week',
    category: 'Attention',
    question: 'What is my typical daily web time this week?',
    metric: 'screen_minutes',
    aggregate: 'avg',
    timeframe: WEEK,
    format: 'float1',
    unit: 'min',
    template: 'You averaged about {value} minutes of web time per day over {timeframe}.',
  },
  {
    key: 'attention.domains_today',
    category: 'Attention',
    question: 'How many different sites did I visit today?',
    metric: 'n_domains',
    aggregate: 'latest',
    timeframe: TODAY,
    format: 'int',
    template: 'You visited {value} different websites {timeframe}.',
  },

  // ── Time ─────────────────────────────────────────────────────────
  {
    key: 'time.screen_month_hours',
    category: 'Time',
    question: 'How many hours did I spend online this month?',
    metric: 'screen_minutes',
    aggregate: 'sum',
    timeframe: MONTH,
    format: 'float1',
    scale: 1 / 60,
    unit: 'hours',
    template: 'Over {timeframe} you spent about {value} hours on the web.',
  },

  // ── Money ────────────────────────────────────────────────────────
  {
    key: 'money.spend_today',
    category: 'Money',
    question: 'How much did I spend on things today?',
    metric: 'spend_total',
    aggregate: 'latest',
    timeframe: TODAY,
    format: 'money',
    unit: '$',
    template: 'You acquired items worth ${value} {timeframe}.',
  },
  {
    key: 'money.spend_month',
    category: 'Money',
    question: 'How much have I spent on things this month?',
    metric: 'spend_total',
    aggregate: 'sum',
    timeframe: MONTH,
    format: 'money',
    unit: '$',
    template: 'You acquired items worth ${value} over {timeframe}.',
  },
];
