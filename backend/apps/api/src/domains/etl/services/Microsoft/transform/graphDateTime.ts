import { utcInstantOfZonedTime } from '@ci/domains/memory';

/**
 * Microsoft Graph's `dateTimeTimeZone`, the type of an event's `start` and `end`.
 *
 * `dateTime` is a wall clock with NO offset (`2016-12-09T20:30:00.0000000`) and
 * `timeZone` names the zone that wall clock is in. Graph answers in UTC unless a
 * request carries `Prefer: outlook.timezone="<zone>"`; nothing in this codebase
 * sends it, so what arrives is `"timeZone": "UTC"`. For an `isAllDay` event the
 * wall clock is midnight in that zone, which needs no special case here.
 *
 * https://learn.microsoft.com/en-us/graph/api/resources/datetimetimezone
 */
export interface GraphDateTimeTimeZone {
  dateTime?: string;
  timeZone?: string;
}

/**
 * An ISO date-time with seconds: the offset-less form Graph spells `dateTime`
 * (seven fractional digits, usually zeros) and, tolerated, the same with an
 * explicit `Z` / `±hh:mm` offset.
 */
const GRAPH_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/i;

function validInstant(instant: Date, raw: string): Date {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`Unparseable Graph dateTime ${JSON.stringify(raw)}`);
  }

  return instant;
}

export interface GraphDateTimeOptions {
  /**
   * Called when `timeZone` names a zone this runtime does not know — a Windows
   * name such as "Pacific Standard Time" is not an IANA id — and the wall clock
   * was therefore read as UTC.
   */
  onUnrecognizedZone?: (timeZone: string) => void;
}

/**
 * The instant a Graph `dateTimeTimeZone` names, or undefined when it carries no
 * `dateTime`.
 *
 * The wall clock is read in `timeZone`, never in the zone of this process.
 * `new Date('2026-09-23T19:00:00.0000000')` does the latter: an offset-less
 * string is LOCAL time to JavaScript, so the same event was stored at 19:00Z in
 * a UTC container and at 02:00Z the next day under `America/Los_Angeles`. This
 * function reaches no local-time API at all, so its answer cannot depend on
 * where it runs.
 *
 * - `UTC`, or no `timeZone` (Graph's own default): the wall clock IS the instant.
 * - A zone `Intl` knows (an IANA id): converted through it, DST included.
 * - A zone it does not know: the wall clock is read as UTC and
 *   {@link GraphDateTimeOptions.onUnrecognizedZone} is told. Wrong by the zone's
 *   offset, but deterministic, and it keeps the event on the right day to within
 *   a day, where throwing would drop it.
 * - A `dateTime` that carries its own offset: that offset wins; `timeZone` has
 *   nothing to add to an instant.
 *
 * Throws RangeError for a `dateTime` that is not an ISO date-time with seconds.
 */
export function graphDateTimeToInstant(
  value: GraphDateTimeTimeZone | null | undefined,
  { onUnrecognizedZone }: GraphDateTimeOptions = {},
): Date | undefined {
  const raw = value?.dateTime?.trim();

  if (!raw) {
    return undefined;
  }

  const match = GRAPH_DATE_TIME.exec(raw);

  if (!match) {
    throw new RangeError(`Unparseable Graph dateTime ${JSON.stringify(raw)}`);
  }

  const [, year, month, day, hour, minute, second, fraction = '', offset] = match;
  // Graph counts 100 ns ticks; a Date holds milliseconds.
  const millis = fraction.slice(0, 3).padEnd(3, '0');
  const wallClock = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}`;

  if (offset) {
    return validInstant(new Date(`${wallClock}${offset.toUpperCase()}`), raw);
  }

  const wallClockAsUtc = validInstant(new Date(`${wallClock}Z`), raw);
  const timeZone = value?.timeZone?.trim();

  if (!timeZone || timeZone.toUpperCase() === 'UTC') {
    return wallClockAsUtc;
  }

  try {
    const instant = utcInstantOfZonedTime(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      timeZone,
    );

    return new Date(instant.getTime() + Number(millis));
  } catch (error) {
    // Intl rejects an id it does not know with a RangeError; anything else is a
    // bug, not an unfamiliar zone.
    if (!(error instanceof RangeError)) {
      throw error;
    }

    onUnrecognizedZone?.(timeZone);

    return wallClockAsUtc;
  }
}
