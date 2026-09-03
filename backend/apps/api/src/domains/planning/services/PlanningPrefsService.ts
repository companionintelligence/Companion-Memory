import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import {
  PLANNING_PREFS_DEFAULTS,
  type PlanningPrefs,
  PlanningPrefsEntity,
  type ResolvedPlanningPrefs,
} from '../entities/PlanningPrefsEntity';
import type { UpdatePlanningPrefsDto } from '../types';

/**
 * Reads and writes a user's planning preferences.
 *
 * Like every planning service this takes `UserServiceContext`, never
 * `ServiceContext`: preferences are per-tenant and `SYSTEM_USER` is not a
 * legitimate planning identity.
 *
 * The contract callers rely on is {@link resolve}, which never returns null and
 * never returns a NULL field. Absent row and absent column both collapse onto
 * {@link PLANNING_PREFS_DEFAULTS}, so a caller cannot accidentally treat "no
 * preference" as "zero".
 */
@Injectable()
export class PlanningPrefsService {
  constructor(
    @InjectRepository(PlanningPrefsEntity)
    private readonly prefsRepository: Repository<PlanningPrefsEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlanningPrefsService.name);
  }

  /** The stored row, or null when the user has never set a preference. */
  async find(context: UserServiceContext): Promise<PlanningPrefs | null> {
    const entity = await this.prefsRepository.findOne({ where: { userId: context.userId } });

    return entity ? PlanningPrefsEntity.toEgressType(entity) : null;
  }

  /**
   * Effective preferences, with every unset value replaced by its shipped
   * default. This is what the placer should call — it cannot fail and cannot
   * hand back a null workday.
   */
  async resolve(context: UserServiceContext): Promise<ResolvedPlanningPrefs> {
    const stored = await this.find(context);

    return {
      workStart: normalizeWallClock(stored?.workStart) ?? PLANNING_PREFS_DEFAULTS.workStart,
      workEnd: normalizeWallClock(stored?.workEnd) ?? PLANNING_PREFS_DEFAULTS.workEnd,
      defaultEstimatedMinutes:
        stored?.defaultEstimatedMinutes ?? PLANNING_PREFS_DEFAULTS.defaultEstimatedMinutes,
      flexDays: stored?.flexDays ?? PLANNING_PREFS_DEFAULTS.flexDays,
    };
  }

  /**
   * Upsert. Only the keys present on the DTO are written, so a caller updating
   * the workday cannot blank out an estimate it never mentioned. Passing an
   * explicit `null` resets that one field to its default — the row survives,
   * which is what keeps `created_at` meaningful.
   *
   * Upserting on the primary key rather than read-modify-write keeps two
   * concurrent settings saves from losing one another's field.
   */
  async update(
    context: UserServiceContext,
    dto: UpdatePlanningPrefsDto,
  ): Promise<ResolvedPlanningPrefs> {
    const patch: Partial<PlanningPrefsEntity> = { userId: context.userId };

    if ('workStart' in dto) {
      patch.workStart = dto.workStart ?? null;
    }

    if ('workEnd' in dto) {
      patch.workEnd = dto.workEnd ?? null;
    }

    if ('defaultEstimatedMinutes' in dto) {
      patch.defaultEstimatedMinutes = dto.defaultEstimatedMinutes ?? null;
    }

    if ('flexDays' in dto) {
      patch.flexDays = dto.flexDays ?? null;
    }

    await this.prefsRepository.upsert(patch, { conflictPaths: ['userId'] });

    this.logger.log('Updated planning preferences', {
      userId: context.userId,
      fields: Object.keys(patch).filter((key) => key !== 'userId'),
    });

    return this.resolve(context);
  }
}

/**
 * Postgres hydrates `time` as `HH:MM:SS`, but the placer compares against and
 * stores `HH:MM`. Trimming here rather than at each call site keeps the two
 * shapes from meeting: a stray `09:00:00` compared against `09:00` as strings
 * is a silently wrong workday boundary rather than an error.
 */
function normalizeWallClock(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^(\d{2}):(\d{2})/.exec(value.trim());

  return match ? `${match[1]}:${match[2]}` : null;
}
