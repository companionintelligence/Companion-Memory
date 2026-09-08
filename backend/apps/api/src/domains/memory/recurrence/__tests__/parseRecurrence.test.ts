import { wallClockInTZ } from '@ci/common/time/zoned';

import { expandSeries } from '../expandSeries';
import { parseRecurrence, seriesRuleOf, type RecurringSeriesRow } from '../parseRecurrence';
import type { ExpansionDiagnostic } from '../types';

const PACIFIC = 'America/Los_Angeles';

/** A Google-synced weekly standup, as `TransformGoogleCalendar` actually writes it. */
function row(over: Partial<RecurringSeriesRow> = {}): RecurringSeriesRow {
  return {
    id: '0198f0a0-0000-7000-8000-000000000001',
    startTime: new Date('2026-09-07T16:00:00Z'),
    endTime: new Date('2026-09-07T16:30:00Z'),
    isAllDay: false,
    metadata: { recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], recurrenceTimeZone: PACIFIC },
    recurrencePattern: null,
    sourceSystem: 'calendar',
    sourceId: 'standup@google.com',
    ...over,
  };
}

const localDatesOf = (starts: Date[], zone = PACIFIC) =>
  starts.map((start) => {
    const wall = wallClockInTZ(start, zone);

    return `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
  });

const WINDOW = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };

describe('seriesRuleOf', () => {
  it('splits the stored recurrence array into its rule and its date lists', () => {
    expect(
      seriesRuleOf(
        row({
          metadata: {
            recurrenceRule: [
              'RRULE:FREQ=WEEKLY;BYDAY=MO',
              'EXDATE;TZID=America/Los_Angeles:20260914T090000',
              'RDATE:20260916T160000Z',
            ],
          },
        }),
      ),
    ).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      exdate: ['EXDATE;TZID=America/Los_Angeles:20260914T090000'],
      rdate: ['RDATE:20260916T160000Z'],
    });
  });

  it('falls back to recurrence_pattern.rrule, spelled bare', () => {
    // The .ics lane and any producer that fills the column write the rule
    // value on its own, without the property name.
    expect(
      seriesRuleOf(row({ metadata: {}, recurrencePattern: { rrule: 'FREQ=DAILY;COUNT=3' } }))?.rrule,
    ).toBe('FREQ=DAILY;COUNT=3');
  });

  it('returns null when nothing carries a rule', () => {
    expect(seriesRuleOf(row({ metadata: {}, recurrencePattern: null }))).toBeNull();
  });
});

describe('parseRecurrence', () => {
  const diagnostics: ExpansionDiagnostic[] = [];
  const opts = { fallbackTimeZone: 'UTC', onDiagnostic: (d: ExpansionDiagnostic) => diagnostics.push(d) };

  beforeEach(() => {
    diagnostics.length = 0;
  });

  it('reads the zone from metadata and anchors DTSTART on its wall clock', () => {
    const spec = parseRecurrence(row(), opts);

    expect(spec?.timeZone).toBe(PACIFIC);
    expect(spec?.timeZoneSource).toBe('series');
    // 16:00Z is 09:00 Pacific; the floating DTSTART wears that wall clock.
    expect(spec?.dtstartFloating.toISOString()).toBe('2026-09-07T09:00:00.000Z');
    expect(spec?.durationMs).toBe(30 * 60_000);
  });

  it('falls back through recurrence_pattern.timeZone to the caller-supplied zone', () => {
    expect(
      parseRecurrence(
        row({
          metadata: { recurrenceRule: ['RRULE:FREQ=DAILY'] },
          recurrencePattern: { timeZone: 'Europe/Berlin' },
        }),
        opts,
      )?.timeZoneSource,
    ).toBe('pattern');

    const fallback = parseRecurrence(row({ metadata: { recurrenceRule: ['RRULE:FREQ=DAILY'] } }), {
      ...opts,
      fallbackTimeZone: 'Europe/Berlin',
      fallbackTimeZoneSource: 'server',
    });
    expect(fallback?.timeZone).toBe('Europe/Berlin');
    expect(fallback?.timeZoneSource).toBe('server');
  });

  it('pins an all-day series to UTC whatever zone the row names', () => {
    const spec = parseRecurrence(
      row({
        isAllDay: true,
        startTime: new Date('2026-09-07T00:00:00Z'),
        endTime: new Date('2026-09-08T00:00:00Z'),
      }),
      opts,
    );

    expect(spec?.timeZone).toBe('UTC');
    expect(spec?.timeZoneSource).toBe('utc-allday');
    // Whole days, so the end is re-derived per occurrence rather than added as ms.
    expect(spec?.wholeLocalDays).toBe(1);
    expect(spec?.durationMs).toBeNull();
  });

  it('refuses a row whose identity is not a federated calendar UID', () => {
    // `platformIdentity('google_calendar', …)` is the UID-less fallback. With no
    // iCalUID there is no `<uid>#<instant>` to look overrides up by, so every
    // occurrence the user individually deleted would come back weekly, forever.
    expect(parseRecurrence(row({ sourceSystem: 'google_calendar', sourceId: 'abc123' }), opts)).toBeNull();
    expect(diagnostics).toEqual([{ kind: 'unfederated-identity', seriesId: row().id }]);
  });

  it('refuses a row carrying no rule at all', () => {
    // Google marks single-occurrence OVERRIDES `is_recurring` too, and Outlook
    // marks instances it already expanded server-side. Neither carries an
    // RRULE, and expanding either double-books the hour.
    expect(parseRecurrence(row({ metadata: {}, recurrencePattern: null }), opts)).toBeNull();
  });

  it('refuses a sub-daily frequency', () => {
    expect(parseRecurrence(row({ metadata: { recurrenceRule: ['RRULE:FREQ=MINUTELY'] } }), opts)).toBeNull();
    expect(diagnostics).toEqual([{ kind: 'sub-daily-rejected', seriesId: row().id, freq: 'MINUTELY' }]);
  });

  it('converges a TZID-local EXDATE and its UTC spelling on one instant', () => {
    // A Takeout .ics writes the first, the API sync writes the second, and the
    // same meeting must be cancelled either way.
    const local = parseRecurrence(
      row({
        metadata: {
          recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/Los_Angeles:20260914T090000'],
          recurrenceTimeZone: PACIFIC,
        },
      }),
      opts,
    );
    const utc = parseRecurrence(
      row({
        metadata: {
          recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE:20260914T160000Z'],
          recurrenceTimeZone: PACIFIC,
        },
      }),
      opts,
    );

    expect(local?.exdates.map((d) => d.toISOString())).toEqual(['2026-09-14T16:00:00.000Z']);
    expect(utc?.exdates.map((d) => d.toISOString())).toEqual(local?.exdates.map((d) => d.toISOString()));
    expect(localDatesOf(expandSeries(local!, WINDOW).starts)).not.toContain('2026-09-14');
  });

  it('reads a VALUE=DATE EXDATE against an all-day series', () => {
    const spec = parseRecurrence(
      row({
        isAllDay: true,
        startTime: new Date('2026-09-07T00:00:00Z'),
        endTime: new Date('2026-09-08T00:00:00Z'),
        metadata: { recurrenceRule: ['RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20260909'] },
      }),
      opts,
    );

    expect(spec?.exdates.map((d) => d.toISOString())).toEqual(['2026-09-09T00:00:00.000Z']);
    expect(localDatesOf(expandSeries(spec!, WINDOW).starts, 'UTC')).not.toContain('2026-09-09');
  });

  it('rewrites a UTC UNTIL into the series wall clock', () => {
    // ═══ THE MOST-MISSED RRULE BUG ═══
    // UNTIL is an absolute instant; the rule is walked in floating wall clocks.
    // Compared directly, the series ends off by the zone's whole offset — seven
    // hours here, which is a whole occurrence at the tail.
    //
    // 20260921T170000Z is 10:00 Pacific, AFTER that Monday's 09:00 standup, so
    // the 21st is kept.
    const inclusive = parseRecurrence(
      row({
        metadata: {
          recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260921T170000Z'],
          recurrenceTimeZone: PACIFIC,
        },
      }),
      opts,
    );
    expect(inclusive?.rruleLine).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260921T100000');
    expect(localDatesOf(expandSeries(inclusive!, WINDOW).starts)).toEqual([
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
    ]);

    // 20260921T150000Z is 08:00 Pacific, BEFORE it, so the 21st drops.
    // Untranslated, rrule reads "15:00 floating" and keeps it — the bug.
    const exclusive = parseRecurrence(
      row({
        metadata: {
          recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260921T150000Z'],
          recurrenceTimeZone: PACIFIC,
        },
      }),
      opts,
    );
    expect(localDatesOf(expandSeries(exclusive!, WINDOW).starts)).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('leaves a floating UNTIL alone', () => {
    expect(
      parseRecurrence(
        row({ metadata: { recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260921T090000'] } }),
        opts,
      )?.rruleLine,
    ).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260921T090000');
  });
});
