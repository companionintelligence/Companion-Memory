import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, type FindOptionsWhere, Repository } from 'typeorm';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { shiftIso } from '../dateUtil';
import { DailyMetricEntity } from '../entities/DailyMetricEntity';
import { assembleDailyMetrics } from '../metrics/assembleDailyMetrics';
import { DAILY_AGGREGATE_SQL, parseAggregateRow } from '../metrics/dailyAggregateSql';
import type { DailyMetrics } from '../types';

/**
 * The Daily Feature Store service. Computes ~10 derived scalar metrics per
 * (user, local day) from the raw capture tables and upserts them idempotently
 * into ci_derived.daily_metrics, and reads them back for the insight engine.
 */
@Injectable()
export class DailyMetricsService {
  constructor(
    @InjectRepository(DailyMetricEntity)
    private readonly repository: Repository<DailyMetricEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DailyMetricsService.name);
  }

  /** Compute the metric surface for one local day WITHOUT persisting it. */
  async computeForDay(context: UserServiceContext, date: string, timezone = 'UTC'): Promise<DailyMetrics> {
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

  /** Compute and store a contiguous window of `days` ending at `endDate`. */
  async computeWindow(
    context: UserServiceContext,
    endDate: string,
    days: number,
    timezone = 'UTC',
  ): Promise<DailyMetrics[]> {
    const out: DailyMetrics[] = [];
    for (let offset = days - 1; offset >= 0; offset--) {
      out.push(await this.computeAndStore(context, shiftIso(endDate, -offset), timezone));
    }

    return out;
  }

  async getDay(context: ServiceContext, date: string): Promise<DailyMetrics | null> {
    const entity = await this.repository.findOne({
      where: { ...this.userScope(context), date },
    });

    return entity ? DailyMetricEntity.toEgressType(entity) : null;
  }

  /** Read a contiguous [fromDate, toDate] window, oldest first. */
  async getRange(context: ServiceContext, fromDate: string, toDate: string): Promise<DailyMetrics[]> {
    const rows = await this.repository.find({
      where: { ...this.userScope(context), date: Between(fromDate, toDate) },
      order: { date: 'ASC' },
    });

    return rows.map((entity) => DailyMetricEntity.toEgressType(entity));
  }

  private userScope(context: ServiceContext): FindOptionsWhere<DailyMetricEntity> {
    return context.userId === SYSTEM_USER ? {} : { userId: context.userId };
  }
}
