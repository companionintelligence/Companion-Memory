import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  isValidTimezone,
  localDateInTZ,
  todayInTZ,
  utcDayBounds,
  utcToZonedWallTime,
  zonedWallTimeToUTC,
} from '@ci/common/time/zoned';
import { UserEntity } from '@ci/domains/user';

const FALLBACK_TIMEZONE = 'UTC';

/**
 * How long a resolved zone is trusted before `ci.users.timezone` is read again.
 *
 * The cache exists only to spare one placement pass a dozen identical
 * single-row lookups — `PlannedBlockService.propose` resolves the zone twice
 * per day of the flex window. It must not outlive a preference change, and it
 * used to: the entry was kept for the process lifetime, so a user who set their
 * zone in Settings kept getting workday windows built in the old zone and
 * `scheduled_for` stamped from the old local date until api *and* worker were
 * restarted.
 *
 * Bounded by time rather than by an invalidation event on purpose. The worker
 * is a separate process with its own map and never sees the mutation, so the
 * `invalidate()` that used to sit below could only ever have cleared the API's
 * copy — half a fix that reads like a whole one. A minute of staleness is the
 * same order as `ForecastContextService`, which re-reads the column uncached on
 * every call and is cheap enough at that.
 */
const TIMEZONE_TTL_MS = 60_000;

/**
 * The imperative shell around `time/zoned.ts`: resolves a user's IANA zone and
 * delegates. The arithmetic itself stays pure and is tested without a database.
 *
 * `ci.users.timezone` is the single source of truth. Planning deliberately has
 * no timezone column of its own — two sources of truth for a user's zone, in
 * code whose correctness is DST-sensitive, is a bug factory.
 */
@Injectable()
export class PlanningTimeService {
  private readonly cache = new Map<string, { timezone: string; expiresAt: number }>();

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlanningTimeService.name);
  }

  /**
   * The user's IANA zone, falling back to UTC when unset or unrecognised.
   *
   * Cached per user for {@link TIMEZONE_TTL_MS} only — long enough to collapse
   * a placement pass's repeated lookups into one, short enough that a zone the
   * user just changed is honoured without a restart.
   */
  async timezoneFor(userId: string): Promise<string> {
    const cached = this.cache.get(userId);

    if (cached != null && cached.expiresAt > Date.now()) {
      return cached.timezone;
    }

    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: { id: true, timezone: true },
    });
    const raw = user?.timezone?.trim();
    let timezone = FALLBACK_TIMEZONE;

    if (raw && isValidTimezone(raw)) {
      timezone = raw;
    } else if (raw) {
      this.logger.warn(`Unrecognised timezone "${raw}" for user ${userId}; falling back to UTC`);
    }

    this.cache.set(userId, { timezone, expiresAt: Date.now() + TIMEZONE_TTL_MS });

    return timezone;
  }

  /** Today's calendar date (`YYYY-MM-DD`) in the caller's zone. */
  async today(context: UserServiceContext, now: Date = new Date()): Promise<string> {
    return todayInTZ(await this.timezoneFor(context.userId), now);
  }

  /** The caller-local calendar date (`YYYY-MM-DD`) of a UTC instant. */
  async localDate(context: UserServiceContext, instant: Date): Promise<string> {
    return localDateInTZ(instant, await this.timezoneFor(context.userId));
  }

  /** The caller-local wall-clock `HH:MM` of a UTC instant. */
  async wallTime(context: UserServiceContext, instant: Date): Promise<string> {
    return utcToZonedWallTime(instant, await this.timezoneFor(context.userId));
  }

  /**
   * The UTC instant for a caller-local wall clock. `date` is `YYYY-MM-DD` and
   * `time` is `HH:MM` — both zoneless by construction.
   */
  async toInstant(context: UserServiceContext, date: string, time: string): Promise<Date> {
    return zonedWallTimeToUTC(date, time, await this.timezoneFor(context.userId));
  }

  /** `[start, end)` UTC bounds of a caller-local calendar day. */
  async dayBounds(context: UserServiceContext, date: string): Promise<{ start: Date; end: Date }> {
    return utcDayBounds(date, await this.timezoneFor(context.userId));
  }
}
