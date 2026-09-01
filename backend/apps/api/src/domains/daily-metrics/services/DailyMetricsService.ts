import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, type FindOptionsWhere, Repository } from 'typeorm';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { UserService } from '@ci/domains/user';

import { isoDate, shiftIso, todayIsoInTimezone } from '../dateUtil';
import { DailyMetricEntity } from '../entities/DailyMetricEntity';
import { assembleDailyMetrics } from '../metrics/assembleDailyMetrics';
import { DAILY_AGGREGATE_SQL, parseAggregateRow, RECENT_DATA_DAYS_SQL } from '../metrics/dailyAggregateSql';
import type { PositionFix } from '../places/stayPoints';
import { timeAtHomeFromFixes } from '../places/timeAtHome';
import type { DailyMetrics } from '../types';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How many days the backfill materializes. NOT which days — see
 * {@link DailyMetricsService.recentDataDays}.
 *
 * 180, not 30, because the store has to be at least as wide as its widest
 * consumer or that consumer is structurally starved no matter how healthy the
 * appliance is. `CorrelationEngine` reads a 180-day history and tests
 * `WINDOWS = [30, 90, 180]`; with a 30-day store its 90- and 180-day windows
 * could never hold more than 30 points, so two of its three windows could
 * never be evaluated on their own terms and `robustKeys` (which needs a pair
 * of surviving windows to agree) had a third of its evidence permanently
 * missing. `AnomalyEngine` reads 90 days for the same reason.
 *
 * This width is only affordable because `DAILY_AGGREGATE_SQL` was made
 * sargable in the same change: at the 74.7s/day it used to cost, 180 days was
 * a 3.7-hour backfill. At the measured 78ms/day it is seconds.
 */
export const DEFAULT_REFRESH_WINDOW_DAYS = 180;

/**
 * The Daily Feature Store service. Computes ~10 derived scalar metrics per
 * (user, local day) from the raw capture tables and upserts them idempotently
 * into ci_derived.daily_metrics.
 */
@Injectable()
export class DailyMetricsService {
  constructor(
    @InjectRepository(DailyMetricEntity)
    private readonly repository: Repository<DailyMetricEntity>,
    private readonly logger: LoggerService,
    private readonly userService: UserService,
  ) {
    this.logger.setContext(DailyMetricsService.name);
  }

  /** Compute the metric surface for one local day WITHOUT persisting it. */
  async computeForDay(context: UserServiceContext, date: string, timezone = 'UTC'): Promise<DailyMetrics> {
    this.assertDay(date);

    const rows = (await this.repository.query(DAILY_AGGREGATE_SQL, [
      context.userId,
      date,
      timezone,
    ])) as Array<Record<string, unknown>>;

    const raw = parseAggregateRow(rows[0] ?? {});
    const { metrics, coverage } = assembleDailyMetrics(raw);
    const atHome = await this.computeTimeAtHome(context.userId, date, timezone);
    metrics.time_at_home = atHome.minutes;
    coverage.time_at_home = atHome.coverage;

    return {
      userId: context.userId,
      date,
      timezone,
      metrics,
      coverage,
      computedAt: new Date(),
    };
  }

  /** Compute and upsert one day into ci_derived.daily_metrics (idempotent). */
  async computeAndStore(context: UserServiceContext, date: string, timezone = 'UTC'): Promise<DailyMetrics> {
    const computed = await this.computeForDay(context, date, timezone);
    const entity = DailyMetricEntity.fromDailyMetrics(computed);

    await this.repository.upsert(entity, { conflictPaths: ['userId', 'date'] });

    this.logger.log('Computed daily metrics', {
      userId: context.userId,
      date,
      timezone,
    });

    return computed;
  }

  async getDay(context: ServiceContext, date: string): Promise<DailyMetrics | null> {
    this.assertDay(date);

    const entity = await this.repository.findOne({
      where: { ...this.userScope(context), date },
    });

    return entity ? DailyMetricEntity.toEgressType(entity) : null;
  }

  /** Read a contiguous [fromDate, toDate] window, oldest first. */
  async getRange(context: ServiceContext, fromDate: string, toDate: string): Promise<DailyMetrics[]> {
    this.assertDay(fromDate);
    this.assertDay(toDate);
    if (fromDate > toDate) {
      throw new BadRequestException('fromDate must be on or before toDate');
    }

    const rows = await this.repository.find({
      where: { ...this.userScope(context), date: Between(fromDate, toDate) },
      order: { date: 'ASC' },
    });

    return rows.map((entity) => DailyMetricEntity.toEgressType(entity));
  }

  /**
   * Recompute the `windowDays` most recent local days that the user's raw
   * capture tables actually have data for. Used by the cron and by the GraphQL
   * refresh mutation.
   *
   * This used to be `computeWindow(today, windowDays)` — a trailing CALENDAR
   * window ending on the wall clock. That is empty for any appliance whose
   * corpus is a static personal-data export, because an export's newest row is
   * whenever the export was taken and never advances while `now()` does.
   * Measured live on 2026-08-30: `ci.daily_metrics` held exactly 30 rows,
   * 2026-08-01..2026-08-30, and every one of the 13 metric columns was NULL in
   * all 30 — the trailing month contained no communications (newest
   * 2026-06-17), no browser activity (2026-06-19), no position (2026-01-25)
   * and no purchases (2026-05-19). The store was running hourly and writing
   * nothing but holes, and the anomaly/correlation/suggestion engines that
   * read it were consequently all at zero rows.
   *
   * Widening `windowDays` does not fix that; it only moves the cliff to the
   * day the corpus becomes older than the new number. The ANCHOR was the bug.
   * See {@link recentDataDays} for why the anchor is a set of days rather than
   * a single MAX(time), which on this corpus would have been just as empty.
   *
   * On an appliance capturing today, the newest `windowDays` days with data
   * ARE the trailing `windowDays` days, so this is a no-op for the healthy
   * case and only bites on a stale corpus.
   */
  async refreshForUser(
    context: UserServiceContext,
    windowDays = DEFAULT_REFRESH_WINDOW_DAYS,
    timezone = 'UTC',
  ): Promise<DailyMetrics[]> {
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) {
      throw new BadRequestException('windowDays must be an integer between 1 and 366');
    }

    const days = await this.recentDataDays(context.userId, timezone, windowDays);

    if (days.length === 0) {
      this.logger.warn('No days with capture data; nothing to materialize', {
        userId: context.userId,
        timezone,
      });

      return [];
    }

    const out: DailyMetrics[] = [];
    // Oldest first, so a run interrupted part-way leaves the store contiguous
    // from the back rather than pocked with holes.
    for (const date of [...days].reverse()) {
      out.push(await this.computeAndStore(context, date, timezone));
    }

    return out;
  }

  /**
   * The `limit` most recent local days, newest first, on which at least one
   * raw source could produce a metric. Never returns a day after the user's
   * local today.
   *
   * Why a SET of days and not `MAX(time) - windowDays`, the shape the
   * analogous planning fix (#2483) used: that works when the window's job is
   * "the newest N rows of one table", but here a day is a JOIN across five
   * sources with wildly different extents, and a single anchor is only ever as
   * good as the source that happens to reach furthest. Measured on this
   * corpus, MAX() over all five sources was 2026-08-30 08:38 — TODAY — because
   * two `ci.events` rows are reddit `moderated_subreddit` records that the
   * importer stamped with the import time. A window anchored there lands
   * straight back on the empty region the anchor was supposed to escape. Even
   * restricted to rows that can produce a metric the newest day is 2026-07-27,
   * a lone calendar entry 38 days past the end of the dense corpus, so a
   * contiguous 30-day window from it would still have swept mostly nothing.
   *
   * Selecting days that have data sidesteps the whole question. There is no N
   * to outrun and therefore no cliff to move: it degrades to "the trailing N
   * days" on an appliance capturing daily, and to "the newest N days the owner
   * actually has" on a historical import, with no configuration between them.
   *
   * The gaps this introduces in the stored series are already the contract
   * downstream. `pairDays` joins by DATE KEY and drops unmatched lags rather
   * than zero-filling; `robustZSeries` and `cusumChangepoints` slice by
   * position within the COVERED subset, not by calendar offset. A day with no
   * usable rows would have been written as an all-NULL row and then filtered
   * straight back out by every one of them, so skipping it loses no
   * information and spends the budget on a day that carries some.
   *
   * The per-source predicates mirror `DAILY_AGGREGATE_SQL`'s exactly. They
   * have to: a day this admits but the aggregate rejects burns a slot on an
   * all-NULL row (harmless, self-limiting), but a day this rejects can never
   * be materialized at all. When you change a source filter there, change it
   * here.
   */
  async recentDataDays(userId: string, timezone: string, limit: number): Promise<string[]> {
    const rows = (await this.repository.query(RECENT_DATA_DAYS_SQL, [
      userId,
      timezone,
      todayIsoInTimezone(timezone),
      limit,
    ])) as Array<{ day: Date | string }>;

    return rows.map((row) => (row.day instanceof Date ? isoDate(row.day) : String(row.day).slice(0, 10)));
  }

  /**
   * Recompute a trailing window for every onboarded user in their profile
   * timezone. Used by the cron. Failures for one user do not abort the rest of
   * the run.
   */
  async refreshAll(windowDays = DEFAULT_REFRESH_WINDOW_DAYS): Promise<void> {
    const users = await this.userService.findAllOnboarded();
    this.logger.log('Refreshing daily metrics', { users: users.length, windowDays });

    for (const user of users) {
      const timezone = user.timezone || 'UTC';
      const context: UserServiceContext = { userId: user.id };

      try {
        await this.refreshForUser(context, windowDays, timezone);
      } catch (err) {
        this.logger.error(
          `Daily metrics refresh failed for user ${user.id} (${timezone})`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }

  /**
   * The day the standing scans should treat as "the most recent complete day":
   * the newest day already in the store, never later than the user's local
   * yesterday. Null when the store holds nothing for the user.
   *
   * The engines that read this store — `AnomalyEngine`, `CorrelationEngine`,
   * `SuggestionEngine` — each independently computed `today - 1` and hung a
   * 90 / 180 / 28-day history off it. That is a SECOND wall-clock anchor,
   * downstream of the one on the writer and not fixed by fixing it: filling
   * the store with the corpus's real days leaves all three reading a calendar
   * window that those days are nowhere near. Both layers have to move or
   * ci_derived stays at zero, which is what it was measured at — 7 of its 8
   * tables held no rows at all.
   *
   * Clamped to yesterday rather than to today because these scans deliberately
   * exclude the current day: on a live appliance today is still accumulating,
   * and scoring a partial day against full ones manufactures a low-side
   * anomaly every morning. On a static corpus the newest stored day is
   * complete already and the clamp does nothing.
   *
   * "Newest day in the store" is not enough on its own — it has to be the
   * newest day that CARRIES A VALUE. This appliance is the proof: the broken
   * writer left 30 all-NULL rows dated 2026-08-01..2026-08-30, six weeks newer
   * than any real day, and a plain `max(date)` anchors every engine onto one of
   * those fossils. Measured after the writer fix, `max(date)` gave 2026-08-30
   * and the value-bearing anchor gave 2026-07-27 — which moved
   * `AnomalyEngine`'s 90-day window off a stretch that was mostly empty and
   * onto the corpus, and is the difference between `SuggestionEngine` reading
   * an all-NULL row as its subject day and reading a real one.
   *
   * The EXISTS strips the five bookkeeping columns by name and treats whatever
   * remains as metrics, rather than listing the thirteen metric columns. A
   * metric added later is then covered automatically; a list would silently
   * stop seeing it.
   *
   * On an appliance capturing daily the newest stored day IS yesterday, so
   * every caller behaves exactly as before.
   */
  async analysisAnchor(context: UserServiceContext, timezone = 'UTC'): Promise<string | null> {
    const yesterday = shiftIso(todayIsoInTimezone(timezone), -1);

    const rows = (await this.repository.query(
      `
      SELECT max(dm.date) AS day
        FROM ci_derived.daily_metrics dm
       WHERE dm.user_id = $1::uuid
         AND dm.date <= $2::date
         AND EXISTS (
               SELECT 1
                 FROM jsonb_each(
                        to_jsonb(dm) - 'user_id' - 'date' - 'timezone' - 'coverage' - 'computed_at'
                      ) AS metric(key, value)
                WHERE metric.value <> 'null'::jsonb
             )
      `,
      [context.userId, yesterday],
    )) as Array<{ day: Date | string | null }>;

    const day = rows[0]?.day;
    if (day == null) {
      return null;
    }

    return day instanceof Date ? isoDate(day) : String(day).slice(0, 10);
  }

  private async computeTimeAtHome(
    userId: string,
    date: string,
    timezone: string,
  ): Promise<{ minutes: number | null; coverage: number }> {
    const homeRows = (await this.repository.query(
      `
      SELECT
        COALESCE(
          ST_Y(e.location_point::geometry),
          CASE
            WHEN jsonb_typeof(r.properties->'coordinates') = 'array'
              THEN (r.properties->'coordinates'->>1)::double precision
            ELSE NULL
          END
        ) AS lat,
        COALESCE(
          ST_X(e.location_point::geometry),
          CASE
            WHEN jsonb_typeof(r.properties->'coordinates') = 'array'
              THEN (r.properties->'coordinates'->>0)::double precision
            ELSE NULL
          END
        ) AS lng
      FROM ci.relationships r
      JOIN ci.users u ON u.entity_id = r.from_entity_id AND u.id = $1
      JOIN ci.entities e ON e.entity_id = r.to_entity_id AND e.entity_type = 'Location'
      WHERE r.is_active = TRUE
        AND r.relationship_type = 'LIVES_IN'
      ORDER BY r.updated_at DESC
      LIMIT 1
      `,
      [userId],
    )) as Array<{ lat: string | number | null; lng: string | number | null }>;

    const lat = Number(homeRows[0]?.lat);
    const lng = Number(homeRows[0]?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { minutes: null, coverage: 0 };
    }

    const clusterRows = (await this.repository.query(
      `
      SELECT radius_m
        FROM ci_derived.place_clusters
       WHERE user_id = $1
         AND centroid IS NOT NULL
       ORDER BY ST_Distance(
         centroid,
         ST_SetSRID(ST_MakePoint($3::double precision, $2::double precision), 4326)::geography
       )
       LIMIT 1
      `,
      [userId, lat, lng],
    )) as Array<{ radius_m: string | number | null }>;
    const radiusM = Number(clusterRows[0]?.radius_m);

    const fixRows = (await this.repository.query(
      `
      SELECT pos.time AS time,
             ST_Y(pos.location::geometry) AS lat,
             ST_X(pos.location::geometry) AS lng
        FROM ci.position pos
       WHERE pos.user_id = $1
         AND pos.location IS NOT NULL
         AND pos.time >= ($2::date::timestamp AT TIME ZONE $3::text)
         AND pos.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       ORDER BY pos.time
      `,
      [userId, date, timezone],
    )) as Array<{ time: Date | string; lat: string | number; lng: string | number }>;

    const fixes: PositionFix[] = [];
    for (const row of fixRows) {
      const fixLat = Number(row.lat);
      const fixLng = Number(row.lng);
      if (!Number.isFinite(fixLat) || !Number.isFinite(fixLng)) {
        continue;
      }

      fixes.push({ time: new Date(row.time), lat: fixLat, lng: fixLng });
    }

    return timeAtHomeFromFixes(fixes, {
      lat,
      lng,
      radiusM: Number.isFinite(radiusM) && radiusM > 0 ? radiusM : undefined,
    });
  }

  private userScope(context: ServiceContext): FindOptionsWhere<DailyMetricEntity> {
    return context.userId === SYSTEM_USER ? {} : { userId: context.userId };
  }

  private assertDay(value: string): void {
    if (!DAY_PATTERN.test(value)) {
      throw new BadRequestException(`Expected yyyy-MM-dd, got "${value}"`);
    }
  }
}
