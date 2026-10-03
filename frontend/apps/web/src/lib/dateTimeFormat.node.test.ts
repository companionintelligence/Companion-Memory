import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDateTimeFormatter,
  DEVICE_DATE_TIME_FORMATTER,
  HOUR_MINUTE,
  isTimeFormat,
  TIME_FORMATS,
} from './dateTimeFormat';

/**
 * The formatter every page writes its times through. What has to hold:
 *
 *  - 'auto' is byte-for-byte the native call it replaced — that is the whole promise to everyone
 *    who never opens the setting;
 *  - 'h12' / 'h23' win over the locale, including a leftover `hour12`;
 *  - instants move into the profile zone, wall-clock readings never do.
 */

const ORIGINAL_TZ = process.env.TZ;

/** Runs a case with the process — "the device" — in `tz`. */
function deviceZone(tz: string) {
  process.env.TZ = tz;
}

beforeEach(() => deviceZone('America/Los_Angeles'));
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

// 15:43:47 in Los Angeles, 23:43:47 in London, 07:43:47 next day in Tokyo.
const INSTANT = new Date('2026-09-30T22:43:47Z');
const ISO = INSTANT.toISOString();

const LOCALES = ['en-US', 'en-GB', 'de-DE', undefined] as const;

const OPTION_SETS: Intl.DateTimeFormatOptions[] = [
  {},
  HOUR_MINUTE,
  { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' },
  { dateStyle: 'medium', timeStyle: 'short' },
];

describe("'auto' — what every page printed before the setting existed", () => {
  const auto = createDateTimeFormatter({ timeFormat: 'auto' });

  it.each(LOCALES)('matches the native calls exactly in %s', (locale) => {
    for (const options of OPTION_SETS) {
      expect(auto.dateTime(INSTANT, options, locale)).toBe(INSTANT.toLocaleString(locale, options));

      // `toLocaleTimeString` itself refuses a dateStyle, so there is no native call to match.
      if (!options.dateStyle) {
        expect(auto.time(INSTANT, options, locale)).toBe(INSTANT.toLocaleTimeString(locale, options));
      }
    }

    expect(auto.date(INSTANT, { month: 'short', day: 'numeric' }, locale)).toBe(
      INSTANT.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    );
  });

  it('takes an ISO string or epoch milliseconds as readily as a Date', () => {
    expect(auto.dateTime(ISO)).toBe(INSTANT.toLocaleString());
    expect(auto.time(INSTANT.getTime(), HOUR_MINUTE)).toBe(
      INSTANT.toLocaleTimeString(undefined, HOUR_MINUTE),
    );
  });

  it('prints the same text in the profile zone as the device does when the two agree', () => {
    const inProfileZone = createDateTimeFormatter({ timeFormat: 'auto', timeZone: 'America/Los_Angeles' });

    for (const options of OPTION_SETS) {
      expect(inProfileZone.dateTime(INSTANT, options, 'en-US')).toBe(
        INSTANT.toLocaleString('en-US', options),
      );
    }
  });

  it('is what a component gets outside the provider', () => {
    expect(DEVICE_DATE_TIME_FORMATTER.timeFormat).toBe('auto');
    expect(DEVICE_DATE_TIME_FORMATTER.timeZone).toBeUndefined();
    expect(DEVICE_DATE_TIME_FORMATTER.dateTime(INSTANT)).toBe(INSTANT.toLocaleString());
  });

  it('still says "Invalid Date" for an unparseable value, like the call it replaced', () => {
    expect(DEVICE_DATE_TIME_FORMATTER.dateTime('not a date')).toBe(new Date('not a date').toLocaleString());
  });
});

describe("'h12' and 'h23' — the person's choice beats the locale", () => {
  const h12 = createDateTimeFormatter({ timeFormat: 'h12', timeZone: 'America/Los_Angeles' });
  const h23 = createDateTimeFormatter({ timeFormat: 'h23', timeZone: 'America/Los_Angeles' });

  it('writes 24-hour in a 12-hour locale', () => {
    expect(h23.time(INSTANT, HOUR_MINUTE, 'en-US')).toBe('15:43');
    expect(h23.time(INSTANT, { hour: '2-digit', minute: '2-digit', second: '2-digit' }, 'en-US')).toBe(
      '15:43:47',
    );
    expect(h23.dateTime(INSTANT, { dateStyle: 'medium', timeStyle: 'short' }, 'en-US')).toBe(
      'Sep 30, 2026, 15:43',
    );
    expect(h23.dateTime(INSTANT, undefined, 'en-US')).toBe('9/30/2026, 15:43:47');
  });

  it('writes 12-hour in a 24-hour locale', () => {
    expect(h12.time(INSTANT, HOUR_MINUTE, 'en-GB')).toMatch(/^3:43\spm$/);
    expect(h12.time(INSTANT, HOUR_MINUTE, 'de-DE')).toMatch(/^3:43\sPM$/);
  });

  it('reads midnight as 00, not 24 or 12', () => {
    const midnight = new Date('2026-10-01T07:05:00Z'); // 00:05 in Los Angeles

    expect(h23.time(midnight, HOUR_MINUTE, 'en-US')).toBe('00:05');
    expect(h12.time(midnight, HOUR_MINUTE, 'en-US')).toMatch(/^12:05\sAM$/);
  });

  it('is not undone by a leftover hour12 in the options', () => {
    // ECMA-402 lets hour12 override hourCycle, so a caller's hour12 must not survive the merge.
    expect(h23.time(INSTANT, { ...HOUR_MINUTE, hour12: true }, 'en-US')).toBe('15:43');
    expect(h12.time(INSTANT, { ...HOUR_MINUTE, hour12: false }, 'en-GB')).toMatch(/^3:43\spm$/);
  });

  it('leaves a date with no time on it alone', () => {
    expect(h23.date(INSTANT, { month: 'short', day: 'numeric' }, 'en-US')).toBe('Sep 30');
  });
});

describe('the zone', () => {
  it('shows an instant on the profile clock, not the device one', () => {
    deviceZone('Europe/London');
    const tokyo = createDateTimeFormatter({ timeFormat: 'h23', timeZone: 'Asia/Tokyo' });

    expect(tokyo.time(INSTANT, HOUR_MINUTE, 'en-US')).toBe('07:43');
    // The date half moves with it: 22:43 UTC on the 30th is already the 1st in Tokyo.
    expect(tokyo.date(INSTANT, { month: 'short', day: 'numeric' }, 'en-US')).toBe('Oct 1');
  });

  it('uses the device zone when the formatter has none', () => {
    deviceZone('Asia/Tokyo');

    expect(createDateTimeFormatter({ timeFormat: 'h23' }).time(INSTANT, HOUR_MINUTE, 'en-US')).toBe('07:43');
  });

  it('lets a surface that reads its own zone name it explicitly', () => {
    const inTokyo = createDateTimeFormatter({ timeFormat: 'h23', timeZone: 'Asia/Tokyo' });

    expect(inTokyo.time(INSTANT, { ...HOUR_MINUTE, timeZone: 'Europe/London' }, 'en-US')).toBe('23:43');
  });
});

describe('clock — a wall-clock reading with no instant behind it', () => {
  it('writes the reading as given, whatever zone the device or the profile is in', () => {
    deviceZone('Asia/Kolkata'); // a half-hour offset would show up in the minutes
    const h23 = createDateTimeFormatter({ timeFormat: 'h23', timeZone: 'America/Los_Angeles' });

    expect(h23.clock(15, 43, HOUR_MINUTE, 'en-US')).toBe('15:43');
    expect(h23.clock(9, 5)).toBe('09:05');
  });

  it('applies the hour cycle', () => {
    expect(createDateTimeFormatter({ timeFormat: 'h12' }).clock(15, 43, HOUR_MINUTE, 'en-GB')).toMatch(
      /^3:43\spm$/,
    );
    expect(createDateTimeFormatter({ timeFormat: 'h23' }).clock(13, 0, { hour: 'numeric' }, 'en-US')).toBe(
      '13',
    );
  });

  it("matches the old local-Date trick exactly under 'auto'", () => {
    for (const [hours, minutes] of [
      [0, 0],
      [8, 30],
      [12, 0],
      [23, 59],
    ]) {
      expect(DEVICE_DATE_TIME_FORMATTER.clock(hours, minutes)).toBe(
        new Date(2000, 0, 1, hours, minutes).toLocaleTimeString([], HOUR_MINUTE),
      );
      expect(DEVICE_DATE_TIME_FORMATTER.clock(hours, 0, { hour: 'numeric' })).toBe(
        new Date(2000, 0, 1, hours).toLocaleTimeString([], { hour: 'numeric' }),
      );
    }
  });
});

describe('isTimeFormat', () => {
  it('accepts exactly the values ci.users.time_format accepts', () => {
    expect(TIME_FORMATS.every(isTimeFormat)).toBe(true);
    expect(TIME_FORMATS).toEqual(['auto', 'h12', 'h23']);

    for (const value of ['h11', 'h24', 'AUTO', '', null, undefined, 12]) {
      expect(isTimeFormat(value)).toBe(false);
    }
  });
});
