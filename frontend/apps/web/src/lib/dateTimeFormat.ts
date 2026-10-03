/**
 * ═══ ONE WAY TO WRITE A TIME OF DAY ═══
 *
 * Two things about a time are the person's to choose, and both live on their
 * account so they follow them from the web app to their phone:
 *
 *  - the HOUR CYCLE, `ci.users.time_format` (Settings › Preferences › Time
 *    format): `'auto'` leaves it to the locale, `'h12'` writes "3:43 PM" and
 *    `'h23'` writes "15:43";
 *  - the ZONE, `ci.users.timezone`, resolved exactly as Plan and Schedule
 *    resolve it (`resolveTimeZone` in `HorizonGrid/zonedClock`).
 *
 * Before this module each page picked its own: most asked the device's locale,
 * two forced 12-hour with `hour12: true`, and only Plan and Schedule read the
 * profile zone. A formatter built here applies both choices and otherwise
 * behaves exactly like the native call it replaces — same locale argument, same
 * options, same defaults — so under `'auto'` the text is what that call printed.
 *
 * Get one from `useDateTimeFormat()` in a component; a helper that formats
 * takes it as a parameter rather than reaching for a global, so it stays pure
 * and its tests can pin a zone and a cycle.
 */

import type { TimeFormat } from '@/graphql/graphql';

export type { TimeFormat };

/** Every value `ci.users.time_format` accepts, in the order Settings offers them. */
export const TIME_FORMATS: readonly TimeFormat[] = ['auto', 'h12', 'h23'];

/** An instant as the API hands it over: an ISO string, epoch milliseconds or a Date. */
export type DateInput = Date | string | number;

type Locales = Intl.LocalesArgument;

export interface DateTimeFormatter {
  /** The hour cycle in force. `'auto'` means the locale decides. */
  readonly timeFormat: TimeFormat;
  /** The IANA zone instants are shown in; undefined means the device's own. */
  readonly timeZone: string | undefined;
  /** An instant's date and time — `Date#toLocaleString`, with the preferences applied. */
  dateTime(value: DateInput, options?: Intl.DateTimeFormatOptions, locales?: Locales): string;
  /** An instant's time of day — `Date#toLocaleTimeString`, with the preferences applied. */
  time(value: DateInput, options?: Intl.DateTimeFormatOptions, locales?: Locales): string;
  /**
   * An instant's date — `Date#toLocaleDateString` in the preferred zone. For the date half of a
   * label whose other half comes from {@link time}, so the two agree about which day it is.
   */
  date(value: DateInput, options?: Intl.DateTimeFormatOptions, locales?: Locales): string;
  /**
   * A wall-clock reading with no instant behind it — an hour on a calendar axis, the edge of a
   * forecast bucket, a time the user typed into this device. Only the hour cycle applies: moving a
   * reading between zones would change what it says.
   */
  clock(hours: number, minutes?: number, options?: Intl.DateTimeFormatOptions, locales?: Locales): string;
}

/** "3:43 PM" / "15:43": the shape most clocks in the app use, and the default for `clock()`. */
export const HOUR_MINUTE: Readonly<Intl.DateTimeFormatOptions> = Object.freeze({
  hour: 'numeric',
  minute: '2-digit',
});

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/** True for the values `ci.users.time_format` accepts. */
export function isTimeFormat(value: unknown): value is TimeFormat {
  return (TIME_FORMATS as readonly unknown[]).includes(value);
}

/**
 * The caller's options with the hour cycle applied.
 *
 * `'auto'` passes them through untouched — that is what makes it byte-for-byte today's text. A
 * forced cycle drops any `hour12` first, because ECMA-402 lets `hour12` override `hourCycle`
 * when both are present and a leftover one would silently undo the person's choice.
 */
function withHourCycle(
  options: Intl.DateTimeFormatOptions,
  timeFormat: TimeFormat,
): Intl.DateTimeFormatOptions {
  if (timeFormat === 'auto') {
    return options;
  }

  const { hour12: _overridden, ...rest } = options;

  return { ...rest, hourCycle: timeFormat };
}

interface DateTimePreferences {
  timeFormat: TimeFormat;
  /** IANA zone; omit for the device's own. An invalid zone throws on first use — resolve it first. */
  timeZone?: string;
}

export function createDateTimeFormatter({ timeFormat, timeZone }: DateTimePreferences): DateTimeFormatter {
  // A zone the caller names in its options wins over the preference: the schedule surface reads
  // its day boundaries in a zone of its own, and its labels have to agree with them.
  const preferred = (options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormatOptions =>
    withHourCycle(
      timeZone === undefined || options.timeZone !== undefined ? options : { ...options, timeZone },
      timeFormat,
    );

  return {
    timeFormat,
    timeZone,
    dateTime: (value, options, locales) => toDate(value).toLocaleString(locales, preferred(options)),
    time: (value, options, locales) => toDate(value).toLocaleTimeString(locales, preferred(options)),
    date: (value, options, locales) => toDate(value).toLocaleDateString(locales, preferred(options)),
    clock: (hours, minutes = 0, options = HOUR_MINUTE, locales) =>
      // Built and read in UTC so no zone's offset (or DST gap) can move the reading.
      new Date(Date.UTC(2000, 0, 1, hours, minutes)).toLocaleTimeString(locales, {
        ...withHourCycle(options, timeFormat),
        timeZone: 'UTC',
      }),
  };
}

/**
 * What every page did before the preference existed: the locale's hour cycle, the device's zone.
 * It is what a component gets outside `DateTimeFormatProvider` — tests, stories, previews.
 */
export const DEVICE_DATE_TIME_FORMATTER = createDateTimeFormatter({ timeFormat: 'auto' });
