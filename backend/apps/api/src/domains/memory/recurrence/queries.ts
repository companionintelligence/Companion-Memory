import { In, LessThan, type Repository } from 'typeorm';

import { isValidTimezone, serverTimezone } from '@ci/common/time/zoned';
import { UserEntity } from '@ci/domains/user';

import type { EventEntity } from '../entities/EventEntity';
import { FEDERATED_SYSTEMS } from '../identity/registry';

import type { OccurrenceSpec } from './types';

/**
 * Series masters one read may pull in. The recurring leg carries no lookback
 * floor — reaching a 2023 DTSTART is the entire point — so this is what keeps
 * it from becoming an unbounded scan of the user's history.
 */
export const MAX_RECURRING_MASTERS = 500;

/** How long a resolved expansion zone is trusted; mirrors PlanningTimeService's own TTL shape. */
const ZONE_TTL_MS = 60_000;

const zoneCache = new Map<string, { zone: ExpansionZone; expiresAt: number }>();

export interface ExpansionZone {
  timeZone: string;
  /**
   * `'user'` when `ci.users.timezone` answered, `'server'` when it did not.
   * Carried rather than collapsed to a bare string because it ends up on every
   * occurrence's `metadata.occurrence.timeZoneSource`, and a row that says
   * "user" when the server zone was actually used is a lie in exactly the field
   * someone reads to explain why a meeting is an hour out.
   */
  source: 'user' | 'server';
}

/**
 * Recurring series masters that could put an occurrence inside a window ending
 * at `to`.
 *
 * Deliberately gated on `is_recurring`, NOT on `recurrence_pattern IS NOT NULL`:
 * `TransformGoogleCalendar` says in its own comment that it does not write that
 * column, so the second predicate matches zero rows in this database today.
 * Whether a row is genuinely expandable is decided by `parseRecurrence`, which
 * reads the rule text from `metadata.recurrenceRule` — where it actually is.
 *
 * Plain functions over a repository rather than a Nest provider so
 * `PeerAskService` can reach them through `this.eventRepository.manager`
 * without growing its constructor, which its own comment records as
 * load-bearing at a distance (it is hand-constructed by several suites).
 */
export function findRecurringMasters(
  repository: Repository<EventEntity>,
  userId: string,
  to: Date,
  limit: number = MAX_RECURRING_MASTERS,
): Promise<EventEntity[]> {
  return repository.find({
    where: {
      userId,
      isDeleted: false,
      isRecurring: true,
      startTime: LessThan(to),
      sourceSystem: FEDERATED_SYSTEMS.calendar,
    },
    order: { startTime: 'DESC' },
    take: limit,
  });
}

/**
 * The occurrences that do NOT already exist as their own row.
 *
 * A "changed just this one" edit and a "delete just this one" both arrive as a
 * real `ci.events` row keyed `<uid>#<instant>`, so an occurrence whose computed
 * override id is already taken must be dropped: the stored row is the truth,
 * and synthesizing beside it either double-books the hour or resurrects a
 * meeting the user cancelled.
 *
 * ═══ NO `is_deleted = false`, NO LIVE_EVENT_SQL — ON PURPOSE ═══
 * Those rows are precisely the ones carrying the suppression signal. A
 * `status = 'cancelled'` override IS how "delete this occurrence only" is
 * stored, and a tombstone is how a deletion syncs. Filtering either out would
 * bring back every occurrence the user has ever individually deleted, weekly,
 * forever — strictly worse than the bug this module fixes.
 *
 * One `source_id IN (…)` so the read lands on `events_source_identity_uniq`
 * (user_id, source_system, source_id).
 */
export async function dropExistingOverrides(
  repository: Repository<EventEntity>,
  userId: string,
  specs: readonly OccurrenceSpec[],
): Promise<OccurrenceSpec[]> {
  if (specs.length === 0) {
    return [];
  }

  const sourceIds = [...new Set(specs.map((spec) => spec.overrideSourceId))];
  const existing = await repository.find({
    where: { userId, sourceSystem: FEDERATED_SYSTEMS.calendar, sourceId: In(sourceIds) },
    select: { id: true, sourceId: true },
  });
  const taken = new Set(existing.map((row) => row.sourceId));

  return specs.filter((spec) => !taken.has(spec.overrideSourceId));
}

/**
 * The zone a series with no zone of its own is expanded in.
 *
 * Read straight off `ci.users` rather than through `PlanningTimeService`:
 * `planning` imports `memory`, and `.dependency-cruiser.mjs`'s `no-circular`
 * rule forbids the reverse. Cached for a minute because `findInRange` is on the
 * schedule surface's poll loop and the answer changes about once a year.
 */
export async function resolveExpansionZone(
  repository: Repository<EventEntity>,
  userId: string,
): Promise<ExpansionZone> {
  const cached = zoneCache.get(userId);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.zone;
  }

  const user = await repository.manager
    .getRepository(UserEntity)
    .findOne({ where: { id: userId }, select: { id: true, timezone: true } });
  const raw = user?.timezone?.trim();
  const zone: ExpansionZone =
    raw && isValidTimezone(raw)
      ? { timeZone: raw, source: 'user' }
      : { timeZone: serverTimezone(), source: 'server' };

  zoneCache.set(userId, { zone, expiresAt: Date.now() + ZONE_TTL_MS });

  return zone;
}

/** Test seam — the module-level cache would otherwise outlive a suite's fixtures. */
export function clearExpansionZoneCache(): void {
  zoneCache.clear();
}
