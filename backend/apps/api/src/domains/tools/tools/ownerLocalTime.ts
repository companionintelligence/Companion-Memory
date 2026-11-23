import { z } from 'zod/v3';

import type { UserServiceContext } from '@ci/common/context';
import { isValidTimezone, zonedWallTimeToUTC } from '@ci/common/time/zoned';

/**
 * A time the planning intents take from a model: the owner's own wall clock, turned into an
 * instant here, in their `ci.users.timezone` (or the `timeZone` the caller names).
 *
 * The intents used to take only a UTC instant, which made the model do the offset arithmetic
 * itself, and it gets daylight saving wrong: on 2026-11-13 OpenClaw told the user "6:00–6:30 PM
 * your time" and sent `2026-11-17T01:00:00Z`, using PDT's -7 for a November date that is PST, -8,
 * so the block landed at 5 PM. It had also been told the user's zone was UTC (OpenClaw's own
 * container zone) and guessed Los Angeles from an unrelated event's recurrence zone.
 *
 * Three forms are accepted:
 * - `2026-11-16T18:00` (seconds optional): a wall clock, read in the zone.
 * - `2026-11-16`: the start of that day, 00:00, in the zone. To cover all of a day as an upper
 *   bound, give the next day.
 * - Anything with `Z` or an offset (`2026-11-17T02:00:00Z`): already an instant, used as is.
 */
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

/** What a parameter's description says about the form, so every planning intent says the same. */
export const LOCAL_TIME_FORM =
  "the owner's local date and time, YYYY-MM-DDTHH:MM with no offset (a bare YYYY-MM-DD is that day's " +
  'start). Their time zone, daylight saving included, is applied here: never convert to UTC yourself';

/** Accepts a local time, a date, or an instant (see {@link LOCAL_TIME}). */
export function localTime(field: string) {
  return z.string().refine((value) => LOCAL_TIME.test(value) || !Number.isNaN(Date.parse(value)), {
    message: `${field} must be a local date and time (YYYY-MM-DDTHH:MM), a date (YYYY-MM-DD), or an ISO 8601 instant`,
  });
}

/** The optional IANA zone a call's local times are read in, instead of the owner's saved one. */
export const timeZoneInput = z
  .string()
  .max(64)
  .refine(isValidTimezone, 'timeZone must be an IANA time zone such as America/New_York')
  .optional();

/** The `timeZone` parameter as the model reads it; `fields` names the parameters it applies to. */
export function timeZoneParameter(fields: string) {
  return {
    type: 'string',
    maxLength: 64,
    description:
      `IANA time zone (America/New_York) that ${fields} are local to, when it is not the owner's home ` +
      'zone: the user names one ("6 PM Eastern") or says they are travelling. Omit to use the ' +
      "owner's saved time zone.",
  };
}

/**
 * The one method of `PlanningTimeService` that this helper calls. It is declared here rather than
 * imported: the planning barrel closes a `no-circular` cycle back through `domains/tools`.
 */
export interface LocalTimeConverter {
  toInstant(context: UserServiceContext, date: string, time: string): Promise<Date>;
}

/** The instant `value` names: a local time or date in `timeZone` or the owner's zone, else as given. */
export async function resolveLocalTime(
  planningTime: LocalTimeConverter,
  context: UserServiceContext,
  value: string,
  timeZone?: string,
): Promise<Date> {
  const local = LOCAL_TIME.exec(value);

  if (!local) {
    return new Date(value);
  }

  const [, date, time = '00:00'] = local;

  return timeZone ? zonedWallTimeToUTC(date, time, timeZone) : planningTime.toInstant(context, date, time);
}
