import {
  type EventWhen,
  type StoredWhen,
  mergeSourceTitle,
  mergeSourceWhen,
  recurrenceOf,
  sameWhen,
} from '../sourceFieldMerge';

/**
 * The time and title refresh's whole decision, as tables. The real-Postgres
 * spec (CalendarEventService.sourceFields.integration.test.ts) proves the rows,
 * the lock and the expansion; this pins the rule.
 */
const at = (iso: string): Date => new Date(iso);

const WEEKLY = { rule: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], timeZone: 'Europe/London' };

function when(start: string, end: string | null, recurrence: EventWhen['recurrence'] = null): EventWhen {
  return { startTime: at(start), endTime: end === null ? null : at(end), recurrence };
}

function stored(
  base: EventWhen,
  markers: Partial<Pick<StoredWhen, 'startTimeOriginal' | 'endTimeOriginal' | 'lastMovedAt'>> = {},
): StoredWhen {
  return { ...base, startTimeOriginal: null, endTimeOriginal: null, lastMovedAt: null, ...markers };
}

const NINE = when('2026-10-07T09:00:00Z', '2026-10-07T10:00:00Z');
const ELEVEN = when('2026-10-07T11:00:00Z', '2026-10-07T12:00:00Z');
const USERS = when('2026-10-08T13:00:00Z', '2026-10-08T14:00:00Z');

describe('mergeSourceWhen', () => {
  it('moves a row nobody else touched to where the source moved it', () => {
    expect(mergeSourceWhen(stored(NINE), NINE, ELEVEN)).toEqual({
      when: ELEVEN,
      base: ELEVEN,
      timesChanged: true,
      recurrenceChanged: false,
    });
  });

  it('writes nothing when the source repeats itself, even over a user who moved the row', () => {
    expect(mergeSourceWhen(stored(NINE), NINE, NINE)).toBeNull();
    expect(
      mergeSourceWhen(stored(USERS, { lastMovedAt: at('2026-10-01T00:00:00Z') }), NINE, NINE),
    ).toBeNull();
  });

  it("keeps a user's time, and records what the source said as the new base", () => {
    const merged = mergeSourceWhen(stored(USERS, { lastMovedAt: at('2026-10-01T00:00:00Z') }), NINE, ELEVEN);

    expect(merged).toMatchObject({ base: ELEVEN, timesChanged: false, recurrenceChanged: false });
    expect(sameWhen(merged!.when, USERS)).toBe(true);
  });

  it('follows the source again once it agrees with the user', () => {
    // The organizer moves the meeting to where the user had put it...
    expect(mergeSourceWhen(stored(USERS), NINE, USERS)).toMatchObject({ base: USERS, timesChanged: false });
    // ...and the next move, from that base, lands.
    expect(mergeSourceWhen(stored(USERS), USERS, ELEVEN)).toMatchObject({ when: ELEVEN, timesChanged: true });
  });

  it('treats start and end as one: an end the user moved keeps the start with it', () => {
    // The user stretched 9-10 to 9-12; the organizer moves the meeting to
    // 11-12. Field by field that is 11 → 12 against the user's end — or, had
    // the organizer moved it to 12:30, an inverted pair.
    const stretched = when('2026-10-07T09:00:00Z', '2026-10-07T12:00:00Z');
    const later = when('2026-10-07T12:30:00Z', '2026-10-07T13:30:00Z');

    const merged = mergeSourceWhen(
      stored(stretched, { lastMovedAt: at('2026-10-01T00:00:00Z') }),
      NINE,
      later,
    );

    expect(merged?.timesChanged).toBe(false);
    expect(sameWhen(merged!.when, stretched)).toBe(true);
  });

  it('never stores a pair it was not given: either the row keeps its own, or takes the delivered one', () => {
    const rows = [stored(NINE), stored(USERS, { lastMovedAt: at('2026-10-01T00:00:00Z') })];
    const deliveries = [NINE, ELEVEN, USERS, when('2026-10-09T08:00:00Z', null)];

    for (const row of rows) {
      for (const base of [null, NINE, ELEVEN]) {
        for (const delivered of deliveries) {
          const merged = mergeSourceWhen(row, base, delivered);

          if (merged) {
            const pair = { ...merged.when, recurrence: null };
            expect(sameWhen(pair, { ...row, recurrence: null }) || sameWhen(pair, delivered)).toBe(true);
          }
        }
      }
    }
  });

  describe('a row with no base (NULL source_start_time)', () => {
    it("keeps the row's time, which may be a person's, and records the base", () => {
      expect(mergeSourceWhen(stored(NINE), null, ELEVEN)).toEqual({
        when: stored(NINE),
        base: ELEVEN,
        timesChanged: false,
        recurrenceChanged: false,
      });
    });

    it('records the base even when the source says what the row shows', () => {
      expect(mergeSourceWhen(stored(NINE), null, NINE)).toMatchObject({ base: NINE, timesChanged: false });
    });
  });

  describe('a row clean.temporal_repair moved', () => {
    // An all-day Christmas: delivered at UTC midnight, repaired to Pacific midnight.
    const DELIVERED = when('2026-12-25T00:00:00Z', '2026-12-26T00:00:00Z');
    const REPAIRED = stored(when('2026-12-25T08:00:00Z', '2026-12-26T08:00:00Z'), {
      startTimeOriginal: at('2026-12-25T00:00:00Z'),
      endTimeOriginal: at('2026-12-26T00:00:00Z'),
    });
    const MOVED = when('2026-12-28T00:00:00Z', '2026-12-29T00:00:00Z');

    it('is not undone by a repeat', () => {
      expect(mergeSourceWhen(REPAIRED, DELIVERED, DELIVERED)).toBeNull();
    });

    it('follows a move: the stage moved it from exactly the base, and nobody since', () => {
      expect(mergeSourceWhen(REPAIRED, DELIVERED, MOVED)).toEqual({
        when: MOVED,
        base: MOVED,
        timesChanged: true,
        recurrenceChanged: false,
      });
    });

    it('keeps it once a person has moved it, though the original pair is still the base', () => {
      const moved = {
        ...REPAIRED,
        startTime: at('2026-12-24T08:00:00Z'),
        lastMovedAt: at('2026-12-01T00:00:00Z'),
      };

      expect(mergeSourceWhen(moved, DELIVERED, MOVED)).toMatchObject({ timesChanged: false });
    });

    it('keeps it when the stage moved it from something other than the base', () => {
      expect(mergeSourceWhen(REPAIRED, MOVED, DELIVERED)).toMatchObject({ timesChanged: false });
    });

    it("keeps the stage's times when the source changed only the series' rule", () => {
      const series = { ...REPAIRED, recurrence: WEEKLY };
      const until = {
        rule: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270101T000000Z'],
        timeZone: 'Europe/London',
      };

      const merged = mergeSourceWhen(
        series,
        { ...DELIVERED, recurrence: WEEKLY },
        { ...DELIVERED, recurrence: until },
      );

      expect(merged).toMatchObject({ timesChanged: false, recurrenceChanged: true });
      expect(merged?.when).toEqual({
        startTime: series.startTime,
        endTime: series.endTime,
        recurrence: until,
      });
    });
  });

  describe("a series' rule, in the same unit", () => {
    const TUESDAYS = { rule: ['RRULE:FREQ=WEEKLY;BYDAY=TU'], timeZone: 'Europe/London' };

    it('moves the start and the rule together', () => {
      const monday = when('2026-09-28T09:00:00Z', '2026-09-28T09:30:00Z', WEEKLY);
      const tuesday = when('2026-09-29T10:00:00Z', '2026-09-29T10:30:00Z', TUESDAYS);

      expect(mergeSourceWhen(stored(monday), monday, tuesday)).toEqual({
        when: tuesday,
        base: tuesday,
        timesChanged: true,
        recurrenceChanged: true,
      });
    });

    it('takes a rule change alone, without touching the times', () => {
      const monday = when('2026-09-28T09:00:00Z', '2026-09-28T09:30:00Z', WEEKLY);
      const ended = { ...monday, recurrence: { ...WEEKLY, rule: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3'] } };

      expect(mergeSourceWhen(stored(monday), monday, ended)).toMatchObject({
        timesChanged: false,
        recurrenceChanged: true,
      });
    });

    it('counts a different zone as a different rule', () => {
      const london = when('2026-09-28T09:00:00Z', null, WEEKLY);
      const newYork = when('2026-09-28T09:00:00Z', null, { ...WEEKLY, timeZone: 'America/New_York' });

      expect(sameWhen(london, newYork)).toBe(false);
      expect(mergeSourceWhen(stored(london), london, newYork)).toMatchObject({ recurrenceChanged: true });
    });

    it("keeps a rule the row's own metadata changed", () => {
      const monday = when('2026-09-28T09:00:00Z', '2026-09-28T09:30:00Z', WEEKLY);
      const edited = stored({ ...monday, recurrence: TUESDAYS });

      expect(
        mergeSourceWhen(edited, monday, when('2026-09-28T09:00:00Z', '2026-09-28T09:30:00Z', null)),
      ).toMatchObject({ timesChanged: false, recurrenceChanged: false });
    });
  });
});

describe('recurrenceOf', () => {
  it('reads the rule and its zone from metadata', () => {
    expect(recurrenceOf({ recurrenceRule: WEEKLY.rule, recurrenceTimeZone: 'Europe/London' })).toEqual(
      WEEKLY,
    );
    expect(recurrenceOf({ recurrenceRule: WEEKLY.rule })).toEqual({ rule: WEEKLY.rule, timeZone: null });
  });

  it('is null without a rule: the Google transform records a zone for every timed event', () => {
    expect(recurrenceOf({ recurrenceTimeZone: 'Europe/London' })).toBeNull();
    expect(recurrenceOf({ recurrenceRule: [] })).toBeNull();
    expect(recurrenceOf(null)).toBeNull();
  });
});

describe('mergeSourceTitle', () => {
  it.each([
    // [row title, base, delivered] → [title, changed]; the new base is always
    // what was delivered.
    ['the organizer renames it', 'Standup', 'Standup', 'Daily standup', 'Daily standup', true],
    [
      "the user's title stands",
      'Standup (bring notes)',
      'Standup',
      'Daily standup',
      'Standup (bring notes)',
      false,
    ],
    ['the user and the source converge', 'Daily standup', 'Standup', 'Daily standup', 'Daily standup', false],
    ['a row with no base keeps its title', 'Standup', null, 'Daily standup', 'Standup', false],
    ['a row with no title and no base keeps none', null, null, 'Daily standup', null, false],
  ])('%s', (_case, row, base, delivered, title, changed) => {
    expect(mergeSourceTitle(row, base, delivered)).toEqual({ title, base: delivered, changed });
  });

  it('writes nothing when the source repeats itself', () => {
    expect(mergeSourceTitle('Standup', 'Standup', 'Standup')).toBeNull();
    expect(mergeSourceTitle('Mine', 'Standup', 'Standup')).toBeNull();
  });
});
