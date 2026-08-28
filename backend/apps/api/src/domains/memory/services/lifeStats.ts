/**
 * Pure helpers for the stats-page life series. SQL in {@link LifeStatsService}
 * must stay aligned with {@link parseAmountToMinor} and the outgoing / time /
 * social allowlists — the service tests pin both sides.
 */

/**
 * Commerce event_type values that are outgoing spend WHATEVER the sign.
 *
 * Every word here names a direction on its own: a payment, a purchase, an
 * order and a withdrawal are money leaving, and importers disagree only about
 * whether to write that as `-12.00` or `12.00`. `abs()` normalises the two
 * conventions. `sale` used to sit here and does not belong: it is the one
 * commerce word whose direction depends on which side of the counter the owner
 * is on — a card processor writes `SALE` for a debit, a marketplace export
 * writes it for a credit — so it is sign-gated below instead of guessed at.
 */
export const OUTGOING_EVENT_TYPES = ['payment', 'purchase', 'order', 'withdrawal'] as const;

/**
 * Ambiguous types that are spend ONLY when the parsed amount is negative.
 *
 * `transaction` is a bank line with no direction in the word; `sale` is
 * direction-ambiguous for the reason above. Both are read from the sign rather
 * than assumed, so an importer that starts emitting either cannot silently
 * inflate the spend chart. No row in the reference corpus carries either type,
 * so this moves no number today — it stops the first one that does.
 */
export const SIGNED_EVENT_TYPES = ['transaction', 'sale'] as const;

/**
 * Social event_type values.
 *
 * `social` is the type the shipping importers actually write (LinkedIn,
 * X/Twitter, Facebook, Instagram, Reddit); the other three are the per-action
 * types older and third-party importers emit. Leaving `social` out cost the
 * chart 2,737 of its 2,765 rows on the reference corpus — 99.2% — and left it
 * drawing four Instagram likes.
 *
 * The allowlist is only the first leg. {@link SOCIAL_KIND_PREFIX} catches rows
 * whose `metadata.kind` is namespaced `social.*` under some other event_type,
 * which is how `social.bookmark` arrives as `event_type = 'interaction'`.
 */
export const SOCIAL_EVENT_TYPES = ['social', 'like', 'post', 'comment'] as const;

/** Importer `metadata.kind` namespace for social activity, e.g. `social.like`. */
export const SOCIAL_KIND_PREFIX = 'social.';

export const CALENDAR_EVENT_TYPES = ['event', 'calendar_event', 'meeting', 'appointment'] as const;
export const MEDIA_EVENT_TYPES = ['play', 'watch', 'listen', 'read'] as const;
export const PLACE_EVENT_TYPES = ['place'] as const;
export const TRAVEL_EVENT_TYPES = ['trip'] as const;

/**
 * A duration at or above this many minutes describes a SPAN, not attended time.
 *
 * An all-day calendar entry is stored as a 1,440-minute duration and a
 * multi-day one as a multiple of it, but neither is a claim about hours spent:
 * a 21-day "Time Off" entry is one decision, not 504 waking hours. Summing
 * them as hours is what made "Most hours: Calendar (14,526h)" — 671,550 of the
 * reference corpus's 871,556 calendar minutes, 77% of the bar, from 246 rows.
 *
 * Spans are counted in DAYS and reported beside the hours (see
 * {@link TimeRow.spanCount} / {@link TimeRow.spanDays}) rather than dropped, so
 * the multi-day commitments still show up — as what they are.
 */
export const SPAN_MINUTES = 1440;

/** Importer metadata flag marking a calendar entry as all-day. */
export const ALL_DAY_METADATA_KEY = 'isAllDay';

export type TimeBucket = 'calendar' | 'media' | 'places' | 'travel' | 'calls' | 'other';

export const TIME_BUCKET_LABELS: Readonly<Record<TimeBucket, string>> = {
  calendar: 'Calendar',
  media: 'Media',
  places: 'Places',
  travel: 'Travel',
  calls: 'Calls',
  other: 'Other',
};

/** Show hours only when at least this share of considered events have a duration. */
export const TIME_HOURS_COVERAGE = 0.25;

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  imessage: 'iMessage',
  whatsapp: 'WhatsApp',
  gmail: 'Gmail',
  email: 'Email',
  sms: 'SMS',
  signal: 'Signal',
  twitter: 'Twitter',
  instagram: 'Instagram',
  telegram: 'Telegram',
};

export function labelChannel(source: string): string {
  return CHANNEL_LABELS[source.toLowerCase()] ?? source;
}

export function resolveTimeMode(
  timedEvents: number,
  consideredEvents: number,
  totalMinutes: number,
): 'hours' | 'counts' {
  const coverage = consideredEvents > 0 ? timedEvents / consideredEvents : 0;

  return totalMinutes > 0 && coverage >= TIME_HOURS_COVERAGE ? 'hours' : 'counts';
}

/**
 * Postgres expression that turns `column->>'Amount'` (`-$12.00`, `+$74.00`,
 * `$1,299.00`) into integer minor units. Same cleanup as {@link parseAmountToMinor}.
 */
export function amountToMinorSql(column: string): string {
  return `CASE
  WHEN NULLIF(regexp_replace(${column}->>'Amount', '[^0-9.+-]', '', 'g'), '') IS NULL THEN NULL
  ELSE ROUND(regexp_replace(${column}->>'Amount', '[^0-9.+-]', '', 'g')::numeric * 100)::bigint
END`;
}

/**
 * Postgres expression for an event's currency.
 *
 * The event leg used to hardcode `'USD'`, which is a claim the row never made:
 * `total_minor` is a bare integer of MINOR units, so labelling €12,00 as USD
 * and summing it beside $12.00 adds two different things. Importers do write
 * the code — every amount-bearing event in the reference corpus carries
 * `metadata.Currency = 'USD'` — so read it, and fall back to USD only when the
 * row is genuinely silent.
 */
export function currencySql(column: string): string {
  return `COALESCE(NULLIF(${column}->>'Currency', ''), NULLIF(${column}->>'currency', ''), 'USD')`;
}

/**
 * True when a duration describes a span (all-day / multi-day) rather than time
 * attended. Mirrors the SQL predicate in `LifeStatsService.timeBreakdown`.
 *
 * Two legs, in order of authority:
 *  1. the importer's own all-day flag, when it set one;
 *  2. a duration of a full day or more, for importers that do not — which is
 *     what catches multi-day conferences written as timed events, and the
 *     64-hour "workout" that is plainly a bad row.
 */
export function isSpanDuration(minutes: number | null | undefined, allDay?: boolean): boolean {
  if (allDay === true) {
    return true;
  }

  return minutes != null && minutes >= SPAN_MINUTES;
}

/** Whole days a span covers — at least one, so a span is never worth nothing. */
export function spanDays(minutes: number | null | undefined): number {
  if (minutes == null || minutes <= 0) {
    return 1;
  }

  return Math.max(1, Math.round(minutes / SPAN_MINUTES));
}

/**
 * Display kind for a social row: the importer's `metadata.kind` with its
 * `social.` namespace stripped (`social.like` -> `like`), else the event_type.
 *
 * Without this every LinkedIn/X/Facebook row reports `kind: 'social'`, which
 * tells a reader nothing — the whole series is social by construction.
 */
export function normalizeSocialKind(kind: string | null | undefined, eventType: string): string {
  if (kind != null && kind.startsWith(SOCIAL_KIND_PREFIX)) {
    const suffix = kind.slice(SOCIAL_KIND_PREFIX.length).trim();
    if (suffix.length > 0) {
      return suffix;
    }
  }

  return eventType;
}

/**
 * Parse a commerce amount string into integer minor units (cents for USD).
 * Returns null when there is no finite number.
 */
export function parseAmountToMinor(raw: string | null | undefined): number | null {
  if (raw == null) {
    return null;
  }

  const cleaned = raw.replace(/[^0-9.+-]/g, '');
  if (
    !cleaned ||
    cleaned === '+' ||
    cleaned === '-' ||
    cleaned === '.' ||
    cleaned === '+.' ||
    cleaned === '-.'
  ) {
    return null;
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 100);
}

/** True when this event_type + signed amount is outgoing spend. */
export function isOutgoingSpend(eventType: string | null | undefined, amountMinor: number | null): boolean {
  if (amountMinor == null || amountMinor === 0) {
    return false;
  }

  if (eventType != null && (OUTGOING_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return true;
  }

  return (
    eventType != null && (SIGNED_EVENT_TYPES as readonly string[]).includes(eventType) && amountMinor < 0
  );
}

export function timeBucketForEventType(eventType: string | null | undefined): TimeBucket | null {
  if (eventType == null) {
    return null;
  }

  if ((CALENDAR_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return 'calendar';
  }

  if ((MEDIA_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return 'media';
  }

  if ((PLACE_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return 'places';
  }

  if ((TRAVEL_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return 'travel';
  }

  return null;
}

export function parseStatsBound(value: string | undefined): Date | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface SpendRow {
  merchant: string;
  count: number;
  totalMinor: number;
  avgMinor: number;
  currency: string;
  sources: string[];
}

export interface TimeRow {
  bucket: TimeBucket;
  label: string;
  /** Minutes of ATTENDED time. Spans are excluded — see {@link SPAN_MINUTES}. */
  minutes: number;
  /** Every row considered for this bucket, spans included. Nothing disappears. */
  count: number;
  /** How many of `count` were spans, and so contributed no minutes. */
  spanCount: number;
  /** Whole days those spans cover. Reported as days; never folded into `minutes`. */
  spanDays: number;
}

export interface ConversationRow {
  personId: string;
  name: string;
  count: number;
  inbound: number;
  outbound: number;
  lastAt: string | null;
}

export interface SocialRow {
  bucket: string;
  sourceSystem: string;
  kind: string;
  count: number;
}

export interface ChannelRow {
  source: string;
  count: number;
}

export interface LifeInsight {
  id: string;
  title: string;
  body: string;
  href?: string;
}

export interface TimeSeries {
  mode: 'hours' | 'counts';
  coverage: { timedEvents: number; consideredEvents: number };
  rows: TimeRow[];
}

export interface LifeSeries {
  spend: { rows: SpendRow[] };
  time: TimeSeries;
  conversations: { rows: ConversationRow[] };
  social: { granularity: 'week' | 'month'; rows: SocialRow[] };
  channels: { rows: ChannelRow[] };
  insights: LifeInsight[];
}

function formatMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
  } catch {
    // An importer can write anything into a currency column; a bad code must
    // not throw the whole insight list away.
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  if (hours >= 10) {
    return `${Math.round(hours)}h`;
  }

  const rounded = Math.round(hours * 10) / 10;

  return `${rounded}h`;
}

/**
 * Deterministic insight cards from the same aggregates the charts use.
 * Omit a card when its series is empty — never invent a number.
 */
export function buildLifeInsights(series: {
  spend: SpendRow[];
  time: TimeSeries;
  conversations: ConversationRow[];
  channels: ChannelRow[];
}): LifeInsight[] {
  const insights: LifeInsight[] = [];
  const topPerson = series.conversations[0];
  if (topPerson) {
    insights.push({
      id: 'top-person',
      title: 'Most messaged',
      body: `${topPerson.name} (${topPerson.count.toLocaleString()} messages)`,
      href: `/people/${topPerson.personId}`,
    });
  }

  const topMerchant = series.spend[0];
  if (topMerchant) {
    insights.push({
      id: 'top-spend',
      title: 'Largest outgoing merchant',
      body: `${topMerchant.merchant} (${formatMinor(topMerchant.totalMinor, topMerchant.currency)} across ${topMerchant.count.toLocaleString()} payments)`,
    });
  }

  const topTime = [...series.time.rows].sort((a, b) =>
    series.time.mode === 'hours' ? b.minutes - a.minutes : b.count - a.count,
  )[0];
  if (topTime) {
    // Spans are appended, never added in: "3356h + 464d" says a calendar holds
    // both, where "14526h" said the owner spent 605 days in meetings.
    const spanSuffix =
      topTime.spanDays > 0 ? ` + ${topTime.spanDays.toLocaleString()}d all-day` : '';

    insights.push({
      id: 'top-time',
      title: series.time.mode === 'hours' ? 'Most hours' : 'Most events',
      body:
        series.time.mode === 'hours'
          ? `${topTime.label} (${formatHours(topTime.minutes)}${spanSuffix})`
          : `${topTime.label} (${topTime.count.toLocaleString()} events)`,
    });
  }

  const topChannel = series.channels[0];
  if (topChannel) {
    insights.push({
      id: 'top-channel',
      title: 'Busiest channel',
      body: `${labelChannel(topChannel.source)} (${topChannel.count.toLocaleString()} messages)`,
    });
  }

  return insights;
}
