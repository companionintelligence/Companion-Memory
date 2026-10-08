import { parseRecurrence, recurrenceRuleRejection, type RecurringSeriesRow } from '../parseRecurrence';
import { checkRecurrenceRule, hourlyRuleCanAdvance, MAX_RULE_INTERVAL } from '../ruleChecks';
import type { ExpansionDiagnostic } from '../types';

const PACIFIC = 'America/Los_Angeles';

function row(rule: string, startTime = new Date('2026-09-07T16:00:00Z')): RecurringSeriesRow {
  return {
    id: '0198f0a0-0000-7000-8000-000000000001',
    startTime,
    endTime: new Date(startTime.getTime() + 30 * 60_000),
    isAllDay: false,
    metadata: { recurrenceRule: [`RRULE:${rule}`], recurrenceTimeZone: PACIFIC },
    recurrencePattern: null,
    sourceSystem: 'calendar',
    sourceId: 'series@example.com',
  };
}

/** Rules real calendars write, from Google, Outlook-exported .ics and the RFC's own examples. */
const REAL_RULES = [
  'FREQ=WEEKLY;BYDAY=MO',
  'FREQ=WEEKLY;WKST=SU;BYDAY=MO,WE,FR',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231T235959Z',
  'FREQ=DAILY;COUNT=10',
  'FREQ=DAILY;UNTIL=20261231',
  'FREQ=MONTHLY;BYDAY=-1FR',
  'FREQ=MONTHLY;BYDAY=2TU',
  'FREQ=MONTHLY;BYMONTHDAY=-1',
  'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
  'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
  'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO',
  'FREQ=YEARLY;BYYEARDAY=1,100,200',
  'FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8',
  'freq=weekly;byday=mo',
  'FREQ=HOURLY',
  'FREQ=HOURLY;INTERVAL=3;BYHOUR=9,10,11',
  'FREQ=MINUTELY;INTERVAL=15',
];

/**
 * RFC 5545 says a rule MUST NOT carry both, but calendars write them, and rrule
 * ends the series at whichever comes first. Both spellings of the order, and
 * both an UNTIL that ends first and a COUNT that does.
 */
const UNTIL_AND_COUNT = [
  'FREQ=DAILY;UNTIL=20261231;COUNT=3',
  'FREQ=DAILY;COUNT=3;UNTIL=20261231',
  'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261020T160000Z;COUNT=10',
  'FREQ=WEEKLY;BYDAY=MO;COUNT=10;UNTIL=20261020T160000Z',
  'FREQ=HOURLY;INTERVAL=3;BYHOUR=9,10,11;COUNT=5;UNTIL=20261001T000000',
];

describe('checkRecurrenceRule', () => {
  it('accepts the rules real calendars write', () => {
    for (const rule of REAL_RULES) {
      expect({ rule, check: checkRecurrenceRule(rule) }).toEqual({
        rule,
        check: expect.objectContaining({ ok: true }),
      });
    }
  });

  it.each([
    ['FREQ=DAILY;INTERVAL=0', /INTERVAL/],
    ['FREQ=DAILY;INTERVAL=-1', /INTERVAL/],
    ['FREQ=DAILY;INTERVAL=1.5', /INTERVAL/],
    [`FREQ=DAILY;INTERVAL=${MAX_RULE_INTERVAL + 1}`, /INTERVAL/],
    ['FREQ=HOURLY;BYHOUR=24', /BYHOUR/],
    ['FREQ=HOURLY;BYHOUR=-1', /BYHOUR/],
    ['FREQ=DAILY;BYMINUTE=60', /BYMINUTE/],
    ['FREQ=DAILY;BYSECOND=61', /BYSECOND/],
    ['FREQ=YEARLY;BYMONTH=13', /BYMONTH/],
    ['FREQ=YEARLY;BYMONTH=0', /BYMONTH/],
    ['FREQ=MONTHLY;BYMONTHDAY=0', /BYMONTHDAY/],
    ['FREQ=MONTHLY;BYMONTHDAY=32', /BYMONTHDAY/],
    ['FREQ=YEARLY;BYYEARDAY=367', /BYYEARDAY/],
    ['FREQ=YEARLY;BYWEEKNO=-54', /BYWEEKNO/],
    ['FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0', /BYSETPOS/],
    ['FREQ=MONTHLY;BYDAY=0MO', /BYDAY/],
    ['FREQ=YEARLY;BYDAY=54MO', /BYDAY/],
    ['FREQ=WEEKLY;BYDAY=XX', /BYDAY/],
    ['FREQ=WEEKLY;WKST=XX', /WKST/],
    ['FREQ=DAILY;COUNT=0', /COUNT/],
    ['FREQ=DAILY;UNTIL=tomorrow', /UNTIL/],
    // With both present, each is still checked on its own.
    ['FREQ=DAILY;COUNT=0;UNTIL=20261231', /COUNT "0"/],
    ['FREQ=DAILY;UNTIL=20261231;COUNT=-3', /COUNT "-3"/],
    ['FREQ=DAILY;COUNT=3;UNTIL=tomorrow', /UNTIL "tomorrow"/],
    ['FREQ=DAILY;UNTIL=20261231;COUNT=3;UNTIL=20271231', /UNTIL appears more than once/],
    ['FREQ=DAILY;FREQ=WEEKLY', /more than once/],
    ['FREQ=DAILY;BYEASTER=0', /unsupported rule part BYEASTER/],
    ['FREQ=DAILY;TZID=Europe/Berlin', /unsupported rule part TZID/],
    ['FREQ=DAILY;X-NAME=1', /unsupported rule part/],
    ['FREQ=FORTNIGHTLY', /unknown FREQ/],
    ['BYDAY=MO', /no FREQ/],
    ['FREQ=DAILY;', /malformed/],
    ['FREQ=DAILY;BYDAY=', /malformed/],
  ])('refuses %s', (rule, reason) => {
    const check = checkRecurrenceRule(rule);

    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.reason).toMatch(reason);
  });

  it.each(UNTIL_AND_COUNT)('accepts UNTIL with COUNT: %s', (rule) => {
    expect(checkRecurrenceRule(rule)).toEqual(expect.objectContaining({ ok: true }));
  });
});

describe('hourlyRuleCanAdvance', () => {
  it('follows the hours an hourly step can visit from its start hour', () => {
    // INTERVAL=24 never leaves the start hour.
    expect(hourlyRuleCanAdvance(24, [5], 9)).toBe(false);
    expect(hourlyRuleCanAdvance(24, [9], 9)).toBe(true);
    // gcd(5, 24) = 1: every hour is reached eventually.
    expect(hourlyRuleCanAdvance(5, [3], 0)).toBe(true);
    // Even steps from an odd hour only ever see odd hours.
    expect(hourlyRuleCanAdvance(2, [9, 11], 9)).toBe(true);
    expect(hourlyRuleCanAdvance(2, [9, 11], 10)).toBe(false);
    // Hours outside 0..23 are never reached.
    expect(hourlyRuleCanAdvance(1, [24, -1], 0)).toBe(false);
  });

  it('answers for every start hour at once when none is given', () => {
    expect(hourlyRuleCanAdvance(2, [9, 11], null)).toBe(false);
    expect(hourlyRuleCanAdvance(2, [9, 10], null)).toBe(true);
    expect(hourlyRuleCanAdvance(1, [7], null)).toBe(true);
    expect(hourlyRuleCanAdvance(24, [7], null)).toBe(false);
  });
});

describe('recurrenceRuleRejection (the write-side check)', () => {
  it('passes what Google and the .ics lane store', () => {
    expect(
      recurrenceRuleRejection([
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'EXDATE;TZID=America/Los_Angeles:20260914T090000',
        'RDATE:20260916T160000Z',
      ]),
    ).toBeNull();
    expect(recurrenceRuleRejection('FREQ=DAILY;COUNT=3')).toBeNull();
    expect(recurrenceRuleRejection(UNTIL_AND_COUNT)).toBeNull();
    expect(recurrenceRuleRejection(UNTIL_AND_COUNT.map((rule) => `RRULE:${rule}`))).toBeNull();
    expect(recurrenceRuleRejection(undefined)).toBeNull();
    expect(recurrenceRuleRejection({ not: 'a rule' })).toBeNull();
  });

  it('refuses any RRULE line the expander could not walk safely', () => {
    expect(recurrenceRuleRejection(['RRULE:FREQ=HOURLY;BYHOUR=24'])).toMatch(/BYHOUR/);
    expect(recurrenceRuleRejection('RRULE:FREQ=DAILY;INTERVAL=-1')).toMatch(/INTERVAL/);
    expect(recurrenceRuleRejection(['EXDATE:20260914T160000Z', 'FREQ=WEEKLY;BYDAY=XX'])).toMatch(/BYDAY/);
  });

  it('refuses an hourly BYHOUR that only some start hours could reach', () => {
    // From a 09:00 start this works; stored for an owner whose zone later moves
    // the start to 10:00, it would never return.
    expect(recurrenceRuleRejection('FREQ=HOURLY;INTERVAL=2;BYHOUR=9,11')).toMatch(/every start hour/);
    expect(recurrenceRuleRejection('FREQ=HOURLY;INTERVAL=24;BYHOUR=5')).toMatch(/every start hour/);
  });
});

describe('parseRecurrence refuses what rrule would never return from', () => {
  const opts = (diagnostics: ExpansionDiagnostic[]) => ({
    fallbackTimeZone: PACIFIC,
    onDiagnostic: (d: ExpansionDiagnostic) => diagnostics.push(d),
  });

  it.each([
    ['FREQ=HOURLY;BYHOUR=24', /BYHOUR/],
    ['FREQ=HOURLY;BYHOUR=-1', /BYHOUR/],
    ['FREQ=DAILY;INTERVAL=-1', /INTERVAL/],
    ['FREQ=DAILY;INTERVAL=0', /INTERVAL/],
  ])('refuses %s with a diagnostic', (rule, reason) => {
    const diagnostics: ExpansionDiagnostic[] = [];

    expect(parseRecurrence(row(rule), opts(diagnostics))).toBeNull();
    expect(diagnostics).toEqual([
      { kind: 'unparseable', seriesId: row(rule).id, reason: expect.stringMatching(reason) },
    ]);
  });

  it('checks an hourly BYHOUR against the start hour in the zone it is walked in', () => {
    // 16:00Z is 09:00 in Los Angeles: INTERVAL=24 stays on 09:00 forever.
    const never: ExpansionDiagnostic[] = [];
    expect(parseRecurrence(row('FREQ=HOURLY;INTERVAL=24;BYHOUR=5'), opts(never))).toBeNull();
    expect(never).toEqual([
      { kind: 'unparseable', seriesId: row('').id, reason: 'BYHOUR is never reached from this start hour' },
    ]);

    // 12:00Z is 05:00 in Los Angeles, so the same rule is fine from there.
    const fine: ExpansionDiagnostic[] = [];
    expect(
      parseRecurrence(row('FREQ=HOURLY;INTERVAL=24;BYHOUR=5', new Date('2026-09-07T12:00:00Z')), opts(fine)),
    ).not.toBeNull();
    expect(fine).toEqual([]);
  });

  it('still parses every rule real calendars write, UNTIL with COUNT included', () => {
    for (const rule of [...REAL_RULES.filter((r) => !/MINUTELY/.test(r)), ...UNTIL_AND_COUNT]) {
      const diagnostics: ExpansionDiagnostic[] = [];

      expect({ rule, spec: parseRecurrence(row(rule), opts(diagnostics)) !== null, diagnostics }).toEqual({
        rule,
        spec: true,
        diagnostics: [],
      });
    }
  });
});
