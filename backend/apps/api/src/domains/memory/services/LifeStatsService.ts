import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import { EventEntity } from '../entities/EventEntity';

import {
  ALL_DAY_METADATA_KEY,
  amountToMinorSql,
  CALENDAR_EVENT_TYPES,
  currencySql,
  MEDIA_EVENT_TYPES,
  OUTGOING_EVENT_TYPES,
  PLACE_EVENT_TYPES,
  SIGNED_EVENT_TYPES,
  SOCIAL_EVENT_TYPES,
  SOCIAL_KIND_PREFIX,
  SPAN_MINUTES,
  TIME_BUCKET_LABELS,
  resolveTimeMode,
  TRAVEL_EVENT_TYPES,
  buildLifeInsights,
  type ChannelRow,
  type ConversationRow,
  type LifeSeries,
  type SocialRow,
  type SpendRow,
  type TimeBucket,
  type TimeRow,
  type TimeSeries,
} from './lifeStats';

export type { LifeSeries } from './lifeStats';

const SPEND_LIMIT = 40;
const CONVERSATION_LIMIT = 12;
const CHANNEL_LIMIT = 8;

/**
 * How many conversation rows to ask SQL for before the owner-name backstop runs.
 *
 * `topConversations` drops any row whose display name resolves to the appliance
 * owner (see {@link LifeStatsService.resolveIsSelf}), which happens in JS after
 * the SQL `LIMIT`. Overfetching means a handful of surviving owner aliases costs
 * chart rows nobody sees rather than rows the chart needed.
 */
const CONVERSATION_FETCH_LIMIT = CONVERSATION_LIMIT * 2;

const TIMED_EVENT_TYPES = [
  ...CALENDAR_EVENT_TYPES,
  ...MEDIA_EVENT_TYPES,
  ...PLACE_EVENT_TYPES,
  ...TRAVEL_EVENT_TYPES,
] as const;

/** Range bounds for the life series. Null means unbounded on that side. */
export interface LifeStatsRange {
  from: Date | null;
  to: Date | null;
}

/**
 * The receipts this stats query counts, and the event rows it must therefore
 * NOT count again. Shared verbatim by {@link LifeStatsService.spendByMerchant}
 * and its duplicate detector so the detector can never drift from the query it
 * is checking. Both bind the same $1 user / $2 from / $3 to / $4 outgoing
 * types / $5 signed types.
 */
const COUNTED_RECEIPTS_CTE = `counted_receipts AS (
         SELECT r.event_id,
                r.source_system,
                r.source_id,
                r.purchased_at,
                COALESCE(NULLIF(r.merchant_name, ''), 'Unknown merchant') AS merchant,
                r.total_minor,
                COALESCE(NULLIF(r.currency, ''), 'USD') AS currency
           FROM ci.receipts r
          WHERE r.user_id = $1
            AND r.total_minor IS NOT NULL
            AND r.total_minor > 0
            AND ($2::timestamptz IS NULL OR r.purchased_at >= $2)
            AND ($3::timestamptz IS NULL OR r.purchased_at < $3)
       )`;

/** Event rows that are outgoing spend and are not already claimed by a receipt. */
const UNCLAIMED_SPEND_EVENTS_WHERE = `e.user_id = $1
              AND e.is_deleted = false
              AND ($2::timestamptz IS NULL OR e.start_time >= $2)
              AND ($3::timestamptz IS NULL OR e.start_time < $3)
              AND ${amountToMinorSql('e.metadata')} IS NOT NULL
              AND ${amountToMinorSql('e.metadata')} <> 0
              AND (
                    e.event_type = ANY($4::text[])
                    OR (
                      e.event_type = ANY($5::text[])
                      AND ${amountToMinorSql('e.metadata')} < 0
                    )
                  )
              -- Same purchase, already counted from its receipt: explicit link…
              AND NOT EXISTS (
                    SELECT 1
                      FROM counted_receipts cr
                     WHERE cr.event_id = e.event_id
                  )
              -- …or the shared importer natural key.
              AND NOT EXISTS (
                    SELECT 1
                      FROM counted_receipts cr
                     WHERE e.source_id IS NOT NULL
                       AND cr.source_id = e.source_id
                       AND COALESCE(cr.source_system, '') = COALESCE(e.source_system, '')
                  )`;

/**
 * Server-side aggregates for the stats page life charts. Thing totals stay
 * on {@link GraphUtilityService} / {@link CalendarEventService.getTimelineStats}; this
 * service only builds spend / time / conversation / social series so the
 * browser never pages those tables.
 */
/**
 * Fold a display name for owner comparison: lowercase, strip diacritics and
 * punctuation, collapse whitespace. Mirrors the rule `ci.entity_identifiers` is
 * keyed on, so a name that matches here matches people-linking too.
 */
function foldOwnerName(raw: string | null | undefined): string {
  if (!raw) {
    return '';
  }

  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class LifeStatsService {
  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(LifeStatsService.name);
  }

  async getLifeSeries(userId: string, range: LifeStatsRange): Promise<LifeSeries> {
    const [spendRows, time, conversationRows, social, channelRows] = await Promise.all([
      this.spendByMerchant(userId, range),
      this.timeBreakdown(userId, range),
      this.topConversations(userId, range),
      this.socialOverTime(userId, range),
      this.channels(userId, range),
    ]);

    return {
      spend: { rows: spendRows },
      time,
      conversations: { rows: conversationRows },
      social,
      channels: { rows: channelRows },
      insights: buildLifeInsights({
        spend: spendRows,
        time,
        conversations: conversationRows,
        channels: channelRows,
      }),
    };
  }

  private bounds(range: LifeStatsRange): [Date | null, Date | null] {
    return [range.from, range.to];
  }

  /**
   * Outgoing spend by merchant / counterparty, from the two places a purchase
   * can land: a `ci.receipts` row with a first-class `total_minor`, and a
   * `ci.events` row whose free-text `metadata.Amount` we parse.
   *
   * ONE PURCHASE, ONE ROW. An importer that produces both writes them with the
   * same natural key (`source_system` + `source_id`, e.g.
   * `amazon:order:102-7054694-8596925`), and `ci.receipts.event_id` links them
   * outright when the extractor had the event to hand. A plain `UNION ALL` over
   * the two tables therefore counted such a purchase twice — on the owner's
   * corpus that turned 505 Amazon orders / $80,093.67 into "999 payments,
   * $125,950.46", and fed the same inflated pair to the "Largest outgoing
   * merchant" insight.
   *
   * THE RECEIPT LEG WINS, and the event is dropped when a receipt already
   * claims it:
   *   - `receipts.total_minor` is a typed bigint in minor units with its own
   *     `currency` column, where the event leg regex-scrapes a display string.
   *   - Where both legs carry an amount they agree exactly (494/494 Amazon
   *     orders), so preferring receipts loses nothing.
   *   - Receipts cover purchases the event leg cannot parse — 11 more Amazon
   *     orders worth $34,236.88, invisible if the event leg won instead.
   * The event leg still stands alone for spend that has no receipt at all
   * (Venmo, PayPal, bank transactions), which is why both legs remain.
   *
   * The anti-join sees only receipts THIS query counts — same user, same range,
   * usable total — so a purchase whose receipt falls outside the window is still
   * counted from its event rather than silently dropped by both legs.
   *
   * ONE LEG DOES ALL THE WORK, AND IT IS NOT THE OBVIOUS ONE. `ci.receipts`
   * has an `event_id` column and nothing writes it: it is NULL on all 635 rows
   * of the reference corpus, so every one of the 505 suppressions runs through
   * the `source_id` anti-join alone. That leaves the whole guarantee resting on
   * importers agreeing to share a natural key, and an importer that does not
   * would double-count in silence — which is the bug this method exists to fix,
   * arriving through a different door. The `event_id` leg stays (it is free and
   * becomes load-bearing the moment an extractor populates it), and
   * {@link LifeStatsService.warnOnUnclaimedReceiptTwins} watches for the silence.
   *
   * GROUPED BY (merchant, currency), not merchant. `total_minor` is a bare
   * integer of minor units; grouping on merchant alone and taking
   * `MAX(currency)` summed €-cents into $-cents whenever one merchant billed in
   * two currencies, then labelled the total with whichever code sorted highest.
   * Two currencies now make two rows, each honestly labelled.
   */
  async spendByMerchant(userId: string, range: LifeStatsRange): Promise<SpendRow[]> {
    // The duplicate check rides along instead of after: it re-runs the event
    // leg, and overlapping the two round-trips keeps that off the page's clock.
    const [rows] = await Promise.all([
      this.eventRepository.manager.query<
        Array<{
          merchant: string;
          n: string;
          total_minor: string;
          avg_minor: string;
          currency: string | null;
          sources: string[] | null;
        }>
      >(
        `WITH ${COUNTED_RECEIPTS_CTE}
       SELECT merchant,
              currency,
              COUNT(*)::text AS n,
              SUM(amount_minor)::text AS total_minor,
              ROUND(AVG(amount_minor))::text AS avg_minor,
              ARRAY_AGG(DISTINCT source_system) AS sources
         FROM (
           SELECT COALESCE(
                    NULLIF(e.metadata->>'To', ''),
                    NULLIF(e.metadata->>'Merchant', ''),
                    NULLIF(e.metadata->>'From', ''),
                    NULLIF(b.name, ''),
                    'Unknown merchant'
                  ) AS merchant,
                  ABS(${amountToMinorSql('e.metadata')}) AS amount_minor,
                  COALESCE(e.source_system, 'unknown') AS source_system,
                  ${currencySql('e.metadata')} AS currency
             FROM ci.events e
             LEFT JOIN ci.entities b ON b.entity_id = e.event_id
            WHERE ${UNCLAIMED_SPEND_EVENTS_WHERE}
           UNION ALL
           SELECT cr.merchant,
                  cr.total_minor AS amount_minor,
                  COALESCE(cr.source_system, 'unknown') AS source_system,
                  cr.currency
             FROM counted_receipts cr
         ) spend
        GROUP BY merchant, currency
        ORDER BY SUM(amount_minor) DESC
        LIMIT $6`,
        [userId, ...this.bounds(range), [...OUTGOING_EVENT_TYPES], [...SIGNED_EVENT_TYPES], SPEND_LIMIT],
      ),
      this.warnOnUnclaimedReceiptTwins(userId, range),
    ]);

    return rows.map((row) => ({
      merchant: row.merchant,
      count: Number(row.n),
      totalMinor: Number(row.total_minor),
      avgMinor: Number(row.avg_minor),
      currency: row.currency ?? 'USD',
      sources: (row.sources ?? []).filter(Boolean),
    }));
  }

  /**
   * Watch the anti-join that carries the whole no-double-count guarantee.
   *
   * The suppression above only fires when a receipt and its event share
   * `event_id` or (`source_system`, `source_id`). Nothing writes `event_id`, so
   * in practice it is the natural key or nothing — and "nothing" is invisible:
   * the merchant's total simply doubles and the chart still looks plausible.
   *
   * So look for the shape that failure makes. A receipt this query counted, and
   * an event this query ALSO counted, from the same source system, for the same
   * amount, on the same day, is a purchase reported twice under two keys. That
   * is not proof — a genuine pair of identical same-day purchases from one
   * source would match too — which is exactly why it warns rather than
   * suppressing. A recurring warning means an importer needs a shared natural
   * key (or `receipts.event_id` populated), not that the numbers should be
   * quietly adjusted.
   *
   * Fails open, like {@link resolveIsSelf}: a diagnostic that cannot run must
   * never take the stats page down with it.
   */
  private async warnOnUnclaimedReceiptTwins(userId: string, range: LifeStatsRange): Promise<void> {
    try {
      const rows: Array<{ source_system: string; n: string; total_minor: string }> =
        await this.eventRepository.manager.query(
          `WITH ${COUNTED_RECEIPTS_CTE},
                unclaimed AS (
                  SELECT COALESCE(e.source_system, 'unknown') AS source_system,
                         ABS(${amountToMinorSql('e.metadata')}) AS amount_minor,
                         e.start_time::date AS day
                    FROM ci.events e
                   WHERE ${UNCLAIMED_SPEND_EVENTS_WHERE}
                )
           SELECT u.source_system,
                  COUNT(*)::text AS n,
                  SUM(u.amount_minor)::text AS total_minor
             FROM unclaimed u
             JOIN counted_receipts cr
               ON COALESCE(cr.source_system, 'unknown') = u.source_system
              AND cr.total_minor = u.amount_minor
              AND cr.purchased_at::date = u.day
            GROUP BY 1
            ORDER BY COUNT(*) DESC`,
          [userId, ...this.bounds(range), [...OUTGOING_EVENT_TYPES], [...SIGNED_EVENT_TYPES]],
        );

      if (rows.length === 0) {
        return;
      }

      const detail = rows
        .map((row) => `${row.source_system}: ${row.n} event(s), ${row.total_minor} minor units`)
        .join('; ');

      this.logger.warn(
        `spendByMerchant: receipt/event pairs share no natural key, so spend may be double-counted — ${detail}. ` +
          'Fix the importer to write ci.receipts.event_id or a shared source_system+source_id.',
      );
    } catch (error) {
      this.logger.warn(`spendByMerchant: duplicate-spend check could not run: ${String(error)}`);
    }
  }

  /**
   * Where time goes, in hours — with all-day and multi-day entries kept OUT of
   * the hours and reported beside them in days.
   *
   * A duration is not automatically time spent. A calendar writes an all-day
   * entry as 1,440 minutes and a multi-day one as a multiple of that, but
   * neither is a claim about attendance: a 21-day "Time Off" block is one
   * decision, not 504 waking hours. Summing them anyway is what produced "Most
   * hours: Calendar (14,526h)" — 246 span rows contributing 670,170 of 871,556
   * calendar minutes, 77% of the bar, and enough to beat every bucket that
   * measures real hours.
   *
   * SO: hours mean hours, days mean days, and both are reported.
   *  - A span contributes NO minutes, but is still counted in `count`, so no
   *    row vanishes from the event total.
   *  - Its days land in `spanDays`, so 246 multi-day commitments are still
   *    visible as 464 days rather than deleted.
   *
   * The alternatives were worse. Capping a span at some hours-per-day invents a
   * number the calendar never wrote — a 16-day block "capped" at 8h/day is
   * still a fabricated 128 hours. Dropping spans outright loses the fact that
   * the commitments exist. Only reporting both keeps every true statement and
   * makes none up.
   *
   * A span is recognised by the importer's own `metadata.isAllDay` first, and
   * failing that by a duration of a full day or more — which is what catches
   * multi-day conferences written as timed events (19 rows here) and the
   * 64-hour "workout" that is simply a bad row.
   */
  async timeBreakdown(userId: string, range: LifeStatsRange): Promise<TimeSeries> {
    const eventRows: Array<{
      bucket: TimeBucket;
      event_count: string;
      timed_count: string;
      minutes: string;
      span_count: string;
      span_days: string;
    }> = await this.eventRepository.manager.query(
      `WITH considered AS (
         SELECT CASE
                  WHEN e.event_type = ANY($4::text[]) THEN 'calendar'
                  WHEN e.event_type = ANY($5::text[]) THEN 'media'
                  WHEN e.event_type = ANY($6::text[]) THEN 'places'
                  WHEN e.event_type = ANY($7::text[]) THEN 'travel'
                  ELSE 'other'
                END AS bucket,
                e.duration_minutes AS minutes,
                (
                  COALESCE(e.metadata->>'${ALL_DAY_METADATA_KEY}', '') = 'true'
                  OR COALESCE(e.duration_minutes, 0) >= $9
                ) AS is_span
           FROM ci.events e
          WHERE e.user_id = $1
            AND e.is_deleted = false
            AND ($2::timestamptz IS NULL OR e.start_time >= $2)
            AND ($3::timestamptz IS NULL OR e.start_time < $3)
            AND (
                  e.event_type = ANY($8::text[])
                  OR e.duration_minutes IS NOT NULL
                )
       )
       SELECT bucket,
              COUNT(*)::text AS event_count,
              COUNT(minutes) FILTER (WHERE NOT is_span)::text AS timed_count,
              COALESCE(SUM(minutes) FILTER (WHERE NOT is_span), 0)::text AS minutes,
              COUNT(*) FILTER (WHERE is_span)::text AS span_count,
              COALESCE(
                SUM(GREATEST(1, ROUND(COALESCE(minutes, 0)::numeric / $9))) FILTER (WHERE is_span),
                0
              )::text AS span_days
         FROM considered
        GROUP BY 1`,
      [
        userId,
        ...this.bounds(range),
        [...CALENDAR_EVENT_TYPES],
        [...MEDIA_EVENT_TYPES],
        [...PLACE_EVENT_TYPES],
        [...TRAVEL_EVENT_TYPES],
        [...TIMED_EVENT_TYPES],
        SPAN_MINUTES,
      ],
    );

    // Calls get the same rule. Nothing in the reference corpus comes close to a
    // day-long call, which is exactly why a row that claims one is a bad row
    // rather than a marathon, and must not be allowed to own the chart.
    const callRows: Array<{ seconds: string; n: string; span_n: string; span_days: string }> =
      await this.eventRepository.manager.query(
        `SELECT COALESCE(SUM(c.duration_seconds) FILTER (WHERE c.duration_seconds < $4 * 60), 0)::text AS seconds,
                COUNT(*) FILTER (WHERE c.duration_seconds < $4 * 60)::text AS n,
                COUNT(*) FILTER (WHERE c.duration_seconds >= $4 * 60)::text AS span_n,
                COALESCE(
                  SUM(GREATEST(1, ROUND(c.duration_seconds::numeric / 60 / $4)))
                    FILTER (WHERE c.duration_seconds >= $4 * 60),
                  0
                )::text AS span_days
           FROM ci.communications c
          WHERE c.user_id = $1
            AND c.duration_seconds IS NOT NULL
            AND c.duration_seconds > 0
            AND ($2::timestamptz IS NULL OR c.time >= $2)
            AND ($3::timestamptz IS NULL OR c.time < $3)`,
        [userId, ...this.bounds(range), SPAN_MINUTES],
      );

    const rows: TimeRow[] = eventRows.map((row) => ({
      bucket: row.bucket,
      label: TIME_BUCKET_LABELS[row.bucket],
      minutes: Number(row.minutes),
      count: Number(row.event_count),
      spanCount: Number(row.span_count),
      spanDays: Number(row.span_days),
    }));

    const callSeconds = Number(callRows[0]?.seconds ?? 0);
    const callCount = Number(callRows[0]?.n ?? 0);
    const callSpanCount = Number(callRows[0]?.span_n ?? 0);
    const callSpanDays = Number(callRows[0]?.span_days ?? 0);
    if (callCount > 0 || callSpanCount > 0) {
      rows.push({
        bucket: 'calls',
        label: TIME_BUCKET_LABELS.calls,
        minutes: Math.round(callSeconds / 60),
        count: callCount + callSpanCount,
        spanCount: callSpanCount,
        spanDays: callSpanDays,
      });
    }

    const consideredEvents = rows.reduce((sum, row) => sum + row.count, 0);
    // Coverage asks "how much of this window is measured in hours", so a span
    // is not a timed event here — it has a duration, just not an hours one.
    const timedEvents = eventRows.reduce((sum, row) => sum + Number(row.timed_count), 0) + callCount;
    const totalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0);
    const mode = resolveTimeMode(timedEvents, consideredEvents, totalMinutes);
    const ordered = rows.sort((a, b) => (mode === 'hours' ? b.minutes - a.minutes : b.count - a.count));

    return {
      mode,
      coverage: { timedEvents, consideredEvents },
      rows: ordered,
    };
  }

  /**
   * The people the owner messages most — COUNTERPARTIES ONLY.
   *
   * "Most messaged people" that opens with your own name is not an answer. The
   * old query credited every participant of every message, so the owner's own
   * Person rows collected one hit per message they sent AND one per message
   * addressed to them: on this corpus rows 1, 2 and 10 were all the owner
   * ("Liam (William) David Collins-Broza" 137,920, "Me" 133,342, "Liam Broza"
   * 5,576) — ~85% of 325,153 communications, crowding out the actual people.
   *
   * Two independent defences, because either alone leaves residue:
   *
   * 1. STRUCTURAL — take the OTHER end of each message. `direction` is NOT NULL
   *    on every row, and the owner is by construction the sender of every
   *    outbound message and a recipient of every inbound one. So an inbound
   *    message credits its sender and an outbound one credits its recipients,
   *    and the owner is never their own counterparty. This needs no idea of who
   *    the owner IS, so it holds on corpora where self was never resolved — and
   *    it fixes the `inbound`/`outbound` split as a side effect: they now mean
   *    "they wrote me" / "I wrote them" rather than counting co-recipients.
   *
   * 2. IDENTITY — drop entities the appliance declares to be the owner:
   *    `ci.entities.is_self` (typed column or the pre-migration `properties`
   *    key), `ci.users.entity_id`, and — recursively — anything merged into one
   *    of those, since a merge tombstone still carries the owner's messages.
   *    This catches self-addressed mail and mislabelled directions, which rule 1
   *    legitimately keeps.
   *
   * A third pass runs in JS: {@link resolveIsSelf} folds the owner's names the
   * same way people-linking does, so an owner alias that no row has ever
   * declared ("Me") is still recognised by name rather than by a hardcoded
   * string. See {@link resolveIsSelf} for why that predicate lives here.
   */
  async topConversations(userId: string, range: LifeStatsRange): Promise<ConversationRow[]> {
    const [rows, isSelf] = await Promise.all([
      this.eventRepository.manager.query<
        Array<{
          pid: string;
          name: string | null;
          n: string;
          inbound: string;
          outbound: string;
          last_at: Date | null;
        }>
      >(
        `WITH RECURSIVE self_seed AS (
           SELECT e.entity_id
             FROM ci.entities e
            WHERE e.owner_user_id = $1::uuid
              AND (e.is_self IS TRUE OR e.properties ->> 'is_self' = 'true')
           UNION
           SELECT u.entity_id
             FROM ci.users u
            WHERE u.id = $1::uuid
              AND u.entity_id IS NOT NULL
         ),
         self_entities AS (
           SELECT entity_id FROM self_seed
           UNION
           SELECT e.entity_id
             FROM ci.entities e
             JOIN self_entities s ON e.merged_into_entity_id = s.entity_id
         ),
         counterparty AS (
           -- They wrote to me: the sender is the other end.
           SELECT c.from_entity_id AS pid, c.id, c.time, c.direction
             FROM ci.communications c
            WHERE c.user_id = $1
              AND c.direction = 'inbound'
              AND c.from_entity_id IS NOT NULL
              AND ($2::timestamptz IS NULL OR c.time >= $2)
              AND ($3::timestamptz IS NULL OR c.time < $3)
           UNION ALL
           -- I wrote to them: the recipients are the other end.
           SELECT p.pid, c.id, c.time, c.direction
             FROM ci.communications c
             CROSS JOIN LATERAL unnest(c.to_entity_ids) AS p(pid)
            WHERE c.user_id = $1
              AND c.direction = 'outbound'
              AND c.to_entity_ids IS NOT NULL
              AND ($2::timestamptz IS NULL OR c.time >= $2)
              AND ($3::timestamptz IS NULL OR c.time < $3)
         )
         SELECT m.pid,
                e.name,
                COUNT(DISTINCT m.id)::text AS n,
                COUNT(DISTINCT m.id) FILTER (WHERE m.direction = 'inbound')::text AS inbound,
                COUNT(DISTINCT m.id) FILTER (WHERE m.direction = 'outbound')::text AS outbound,
                MAX(m.time) AS last_at
           FROM counterparty m
           JOIN ci.entities e ON e.entity_id = m.pid
          WHERE e.entity_type = 'Person'
            AND COALESCE(e.is_self, false) = false
            AND e.merged_into_entity_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM self_entities s WHERE s.entity_id = m.pid)
          GROUP BY m.pid, e.name
          ORDER BY COUNT(DISTINCT m.id) DESC
          LIMIT $4`,
        [userId, ...this.bounds(range), CONVERSATION_FETCH_LIMIT],
      ),
      this.resolveIsSelf(userId),
    ]);

    return rows
      .filter((row) => !(row.name != null && isSelf(row.name)))
      .slice(0, CONVERSATION_LIMIT)
      .map((row) => ({
        personId: row.pid,
        name: row.name?.trim() || 'Unknown person',
        count: Number(row.n),
        inbound: Number(row.inbound),
        outbound: Number(row.outbound),
        lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
      }));
  }

  /**
   * The owner-name predicate.
   *
   * Deliberately implemented HERE rather than reusing
   * `domains/import/push/self.ts`, which does the same folding for the import
   * push. Importing it pulls the memory domain into the import domain's public
   * surface, and that barrel re-exports through `@ci/domains/graph`, which
   * itself reaches back into `@ci/domains/memory` — a require cycle that
   * evaluates to `undefined` at import time. Reaching past the barrel to the
   * leaf module dodges the cycle but violates `no-cross-domain-internals`, so
   * neither route is available. The duplicated logic is ~15 lines of string
   * folding against a rule that has not changed; the coupling would be
   * permanent.
   *
   * This is only the THIRD pass. The authoritative exclusion is the SQL above
   * (`is_self`, `ci.users.entity_id`, merge tombstones); this catches an alias
   * no row ever declared, like "Me". A failure to read is therefore not a
   * reason to fail the stats page — it degrades to "nobody is the owner" and
   * lets the structural rules stand on their own.
   */
  private async resolveIsSelf(userId: string): Promise<(name: string) => boolean> {
    const nobody = () => false;

    try {
      const rows = await this.eventRepository.manager.query<Array<{ name: string | null }>>(
        `SELECT u.name AS name FROM ci.users u WHERE u.id = $1::uuid
          UNION ALL
         SELECT u.email AS name FROM ci.users u WHERE u.id = $1::uuid
          UNION ALL
         SELECT e.name AS name
           FROM ci.entities e
          WHERE e.owner_user_id = $1::uuid
            AND e.entity_type = 'Person'
            AND e.merged_into_entity_id IS NULL
            AND (e.is_self IS TRUE OR e.properties ->> 'is_self' = 'true')`,
        [userId],
      );

      const targets = new Set<string>();
      for (const row of rows) {
        // An email's local part is a name in disguise on most accounts, and on
        // an account created without a display name it is the only signal left.
        const raw = row.name?.includes('@') ? row.name.split('@')[0].replace(/[._+-]/g, ' ') : row.name;
        const folded = foldOwnerName(raw);
        if (folded) {
          targets.add(folded);
        }
      }

      if (targets.size === 0) {
        return nobody;
      }

      return (name: string) => {
        const candidate = foldOwnerName(name);

        return candidate.length > 0 && targets.has(candidate);
      };
    } catch (error) {
      this.logger.warn(`topConversations: could not resolve owner identity: ${String(error)}`);

      return nobody;
    }
  }

  /**
   * Social activity over time, by platform.
   *
   * WHAT WENT WRONG: the allowlist was `like | post | comment`, and the
   * importers that actually ship write `event_type = 'social'`. On the
   * reference corpus that matched 22 rows — every one an Instagram like — while
   * 2,737 LinkedIn / X / Facebook / Reddit rows sat unread beside them. The
   * chart drew four points and read as "you are barely online".
   *
   * TWO LEGS, because neither alone is enough:
   *  1. {@link SOCIAL_EVENT_TYPES} — `social` for the current importers, plus
   *     the per-action types older and third-party ones emit.
   *  2. `metadata.kind LIKE 'social.%'` — the importer's own namespace, which
   *     catches social rows filed under an unrelated event_type. It is the only
   *     reason `social.bookmark` (`event_type = 'interaction'`) is counted, and
   *     it will pick up the next `social.*` action without a code change.
   *
   * `kind` is reported as the namespace suffix (`social.like` -> `like`), not
   * the event_type: a series that is social by construction learns nothing from
   * 2,737 rows all labelled "social".
   */
  async socialOverTime(
    userId: string,
    range: LifeStatsRange,
  ): Promise<{ granularity: 'week' | 'month'; rows: SocialRow[] }> {
    const granularity = socialGranularity(range);
    const rows: Array<{ bucket: Date; source_system: string; kind: string; n: string }> =
      await this.eventRepository.manager.query(
        `SELECT date_trunc($4, e.start_time) AS bucket,
                COALESCE(NULLIF(e.source_system, ''), 'unknown') AS source_system,
                COALESCE(
                  NULLIF(regexp_replace(e.metadata->>'kind', '^${SOCIAL_KIND_PREFIX}', ''), ''),
                  e.event_type
                ) AS kind,
                COUNT(*)::text AS n
           FROM ci.events e
          WHERE e.user_id = $1
            AND e.is_deleted = false
            AND (
                  e.event_type = ANY($5::text[])
                  OR e.metadata->>'kind' LIKE '${SOCIAL_KIND_PREFIX}%'
                )
            AND e.start_time IS NOT NULL
            AND ($2::timestamptz IS NULL OR e.start_time >= $2)
            AND ($3::timestamptz IS NULL OR e.start_time < $3)
          GROUP BY 1, 2, 3
          ORDER BY 1`,
        [userId, ...this.bounds(range), granularity, [...SOCIAL_EVENT_TYPES]],
      );

    return {
      granularity,
      rows: rows.map((row) => ({
        bucket: new Date(row.bucket).toISOString(),
        sourceSystem: row.source_system,
        kind: row.kind,
        count: Number(row.n),
      })),
    };
  }

  async channels(userId: string, range: LifeStatsRange): Promise<ChannelRow[]> {
    const rows: Array<{ source: string; n: string }> = await this.eventRepository.manager.query(
      `SELECT COALESCE(NULLIF(c.source_system, ''), c.communication_type::text, 'unknown') AS source,
              COUNT(*)::text AS n
         FROM ci.communications c
        WHERE c.user_id = $1
          AND ($2::timestamptz IS NULL OR c.time >= $2)
          AND ($3::timestamptz IS NULL OR c.time < $3)
        GROUP BY 1
        ORDER BY COUNT(*) DESC
        LIMIT $4`,
      [userId, ...this.bounds(range), CHANNEL_LIMIT],
    );

    return rows.map((row) => ({
      source: row.source,
      count: Number(row.n),
    }));
  }
}

function socialGranularity(range: LifeStatsRange): 'week' | 'month' {
  if (range.from == null || range.to == null) {
    return 'month';
  }

  const spanMs = range.to.getTime() - range.from.getTime();
  const day = 24 * 60 * 60 * 1000;

  return spanMs > 180 * day ? 'month' : 'week';
}
