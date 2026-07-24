import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, type FindOptionsWhere, Repository } from 'typeorm';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { UserService } from '@ci/domains/user';

import { shiftIso, todayIsoInTimezone } from '../dateUtil';
import { DailyMetricEntity } from '../entities/DailyMetricEntity';
import { assembleDailyMetrics } from '../metrics/assembleDailyMetrics';
import { DAILY_AGGREGATE_SQL, parseAggregateRow } from '../metrics/dailyAggregateSql';
import type { DailyMetrics } from '../types';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Default backfill / refresh window ending on the user's local "today". */
export const DEFAULT_REFRESH_WINDOW_DAYS = 30;

/**
 * The Daily Feature Store service. Computes ~10 derived scalar metrics per
 * (user, local day) from the raw capture tables and upserts them idempotently
 * into ci.daily_metrics, and reads them back for the insight engine.
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

    return {
      userId: context.userId,
      date,
      timezone,
      metrics,
      coverage,
      computedAt: new Date(),
    };
  }

  /** Compute and upsert one day into ci.daily_metrics (idempotent). */
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

  /** Compute and store a contiguous window of `days` ending at `endDate`. */
  async computeWindow(
    context: UserServiceContext,
    endDate: string,
    days: number,
    timezone = 'UTC',
  ): Promise<DailyMetrics[]> {
    this.assertDay(endDate);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      throw new BadRequestException('days must be an integer between 1 and 366');
    }

    const out: DailyMetrics[] = [];
    for (let offset = days - 1; offset >= 0; offset--) {
      out.push(await this.computeAndStore(context, shiftIso(endDate, -offset), timezone));
    }

    return out;
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
   * Recompute a trailing window for one user ending on their local today.
   * Used by the GraphQL refresh mutation.
   */
  async refreshForUser(
    context: UserServiceContext,
    windowDays = DEFAULT_REFRESH_WINDOW_DAYS,
    timezone = 'UTC',
  ): Promise<DailyMetrics[]> {
    const endDate = todayIsoInTimezone(timezone);

    return this.computeWindow(context, endDate, windowDays, timezone);
  }

  /**
   * Recompute a trailing window for every user in their profile timezone.
   * Used by the cron. Failures for one user do not abort the rest of the run.
   */
  async refreshAll(windowDays = DEFAULT_REFRESH_WINDOW_DAYS): Promise<void> {
    const users = await this.userService.findAll();
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

  private userScope(context: ServiceContext): FindOptionsWhere<DailyMetricEntity> {
    return context.userId === SYSTEM_USER ? {} : { userId: context.userId };
  }

  private assertDay(value: string): void {
    if (!DAY_PATTERN.test(value)) {
      throw new BadRequestException(`Expected yyyy-MM-dd, got "${value}"`);
    }
  }
}
