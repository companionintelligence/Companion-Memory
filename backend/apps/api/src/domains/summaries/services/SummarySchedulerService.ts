import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';
import { EventService, Events, SummaryPeriodType } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

interface DateWindow {
  start: Date;
  end: Date;
}

@Injectable()
export class SummarySchedulerService {
  private readonly logger = new LoggerService(SummarySchedulerService.name);

  private readonly timezone = 'UTC';

  /** Queue name for memory summaries (mirrors memory service default). */
  private readonly summaryQueue = 'memory-summaries';

  constructor(
    private readonly eventService: EventService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  @Cron('5 * * * *', { timeZone: 'UTC' })
  async enqueueHourlySummaries(): Promise<void> {
    await this.enqueueSummaries('hourly');
  }

  @Cron('10 0 * * *', { timeZone: 'UTC' })
  async enqueueDailySummaries(): Promise<void> {
    await this.enqueueSummaries('daily');
  }

  @Cron('15 0 * * 1', { timeZone: 'UTC' })
  async enqueueWeeklySummaries(): Promise<void> {
    await this.enqueueSummaries('weekly');
  }

  @Cron('20 0 1 * *', { timeZone: 'UTC' })
  async enqueueMonthlySummaries(): Promise<void> {
    await this.enqueueSummaries('monthly');
  }

  @Cron('25 0 1 3,6,9,12 *', { timeZone: 'UTC' })
  async enqueueSeasonalSummaries(): Promise<void> {
    await this.enqueueSummaries('seasonal');
  }

  @Cron('30 0 1 1 *', { timeZone: 'UTC' })
  async enqueueYearlySummaries(): Promise<void> {
    await this.enqueueSummaries('yearly');
  }

  private async enqueueSummaries(periodType: SummaryPeriodType): Promise<void> {
    if (!config.features['scheduled.memory.summaries']) {
      this.logger.debug('Scheduled memory summaries are disabled', { periodType });

      return;
    }

    const window = this.calculateWindow(periodType);
    const users = await this.userRepository.find({
      select: ['id'],
      where: { onboarded: true },
    });

    if (users.length === 0) {
      this.logger.debug('No onboarded users available for summary scheduling', {
        periodType,
      });

      return;
    }

    const payloadBase = {
      periodType,
      periodStart: window.start.toISOString(),
      periodEnd: window.end.toISOString(),
      timezone: this.timezone,
    } as const;

    const jobCounts = await Promise.all(
      users.map(async ({ id }) => {
        try {
          const jobIds = await this.eventService.send(
            Events.MEMORY_SUMMARY_GENERATION,
            {
              ...payloadBase,
              userId: id,
            },
            { queue: this.summaryQueue },
          );

          return jobIds.length;
        } catch (error) {
          this.logger.error('Failed to enqueue summary job', {
            periodType,
            userId: id,
            error: error instanceof Error ? error.message : error,
          });

          return 0;
        }
      }),
    );

    const enqueuedJobs = jobCounts.reduce((sum, count) => sum + count, 0);

    this.logger.log('Enqueued memory summary jobs', {
      periodType,
      userCount: users.length,
      enqueuedJobs,
      windowStart: payloadBase.periodStart,
      windowEnd: payloadBase.periodEnd,
    });
  }

  private calculateWindow(periodType: SummaryPeriodType, reference: Date = new Date()): DateWindow {
    switch (periodType) {
      case 'hourly': {
        const end = this.startOfUtcHour(reference);
        const start = new Date(end);
        start.setUTCHours(start.getUTCHours() - 1);

        return { start, end };
      }

      case 'daily': {
        const end = this.startOfUtcDay(reference);
        const start = new Date(end);
        start.setUTCDate(start.getUTCDate() - 1);

        return { start, end };
      }

      case 'weekly': {
        const end = this.startOfCurrentWeek(reference);
        const start = new Date(end);
        start.setUTCDate(start.getUTCDate() - 7);

        return { start, end };
      }

      case 'monthly': {
        const end = this.startOfMonth(reference);
        const start = new Date(end);
        start.setUTCMonth(start.getUTCMonth() - 1);

        return { start, end };
      }

      case 'seasonal': {
        const end = this.startOfSeason(reference);
        const start = new Date(end);
        start.setUTCMonth(start.getUTCMonth() - 3);

        return { start, end };
      }

      case 'yearly': {
        const end = this.startOfYear(reference);
        const start = new Date(end);
        start.setUTCFullYear(start.getUTCFullYear() - 1);

        return { start, end };
      }

      default: {
        const exhaustiveCheck: never = periodType;
        throw new Error(`Unsupported summary period: ${exhaustiveCheck}`);
      }
    }
  }

  private startOfUtcHour(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), 0, 0, 0),
    );
  }

  private startOfUtcDay(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  }

  private startOfCurrentWeek(date: Date): Date {
    const startOfDay = this.startOfUtcDay(date);
    const day = startOfDay.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;
    startOfDay.setUTCDate(startOfDay.getUTCDate() - daysSinceMonday);

    return startOfDay;
  }

  private startOfMonth(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
  }

  private startOfYear(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
  }

  private startOfSeason(date: Date): Date {
    const seasonStartMonths = [2, 5, 8, 11];
    const month = date.getUTCMonth();
    let seasonYear = date.getUTCFullYear();
    let seasonMonth = -1;

    for (const startMonth of seasonStartMonths) {
      if (month >= startMonth) {
        seasonMonth = startMonth;
      }
    }

    if (seasonMonth === -1) {
      // January and February belong to the winter season that started in December of the previous year.
      seasonMonth = 11;
      seasonYear -= 1;
    }

    return new Date(Date.UTC(seasonYear, seasonMonth, 1, 0, 0, 0, 0));
  }
}
