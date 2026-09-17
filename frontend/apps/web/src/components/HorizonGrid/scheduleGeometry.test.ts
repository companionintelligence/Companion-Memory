import { describe, expect, it } from 'vitest';

import type { ForecastBucket } from '@/api/useForecastService';
import type { RhythmDay, ScheduleEvent } from '@/api/useScheduleService';

import { addDays, startOfLocalDay } from './nowNext';
import {
  daypartWeights,
  describes,
  dropInstant,
  eventUrl,
  movedStart,
  occupancyClaims,
  occupancySignalInRange,
  packLanes,
  rhythmCells,
  slotForecastLine,
  spanForDay,
} from './scheduleGeometry';

const MONDAY = startOfLocalDay(new Date(2026, 7, 3));

/**
 * The machine's own zone, read once before anything below can perturb it.
 *
 * It has to be captured at module load: once `withTimeZone` has run, Node's
 * resolved zone reports the *pinned* zone, so reading it later would "restore"
 * to whatever was last set.
 */
const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Run `fn` with the process timezone pinned, restoring it afterwards.
 *
 * Anything asserting on the UTC→local mapping, or on a day that is not 24 hours
 * long, has to name the zone it means. CI runs in UTC, where a local day IS a
 * UTC day and no calendar day ever changes length — so those cases are vacuous
 * unless the zone is chosen rather than inherited from the machine. Node
 * re-reads `process.env.TZ` on the next Date operation, which is all this needs.
 *
 * Build every Date inside the callback: one created outside carries the offset
 * that was in force when it was constructed.
 *
 * Restoring cannot use `delete process.env.TZ`, even though that is what an
 * originally-unset TZ looks like. Deleting the variable does NOT return Node to
 * the system zone — the resolved zone stays on the last value that was set, so
 * every later test in the file silently kept running in the pinned zone. That
 * is invisible on CI (already UTC, so the "leak" is UTC→UTC) and shows up only
 * on a developer machine in another zone, as absolute-epoch assertions failing
 * by exactly the offset between the two. Restore by assignment instead.
 */
function withTimeZone<T>(timeZone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;

  try {
    return fn();
  } finally {
    process.env.TZ = previous ?? SYSTEM_TIME_ZONE;
  }
}

function event(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: 'e1',
    title: 'Standup',
    description: null,
    startTime: new Date(2026, 7, 3, 9, 0).toISOString(),
    endTime: new Date(2026, 7, 3, 9, 30).toISOString(),
    isAllDay: false,
    status: 'confirmed',
    category: 'WORK',
    locationName: null,
    ...overrides,
  };
}

describe('spanForDay — clipping committed events onto a day row', () => {
  it('places a mid-morning event proportionally across the row', () => {
    const span = spanForDay(event(), MONDAY);

    // 09:00 of 1440 minutes = 37.5%
    expect(span?.leftPct).toBeCloseTo(37.5, 1);
    expect(span?.widthPct).toBeCloseTo((30 / 1440) * 100, 1);
  });

  it('omits an event belonging to a different day', () => {
    const span = spanForDay(
      event({ startTime: new Date(2026, 7, 5, 9, 0).toISOString(), endTime: null }),
      MONDAY,
    );

    expect(span).toBeNull();
  });

  it('shows an overnight event on the day it runs into, flagged as continuing from', () => {
    const overnight = event({
      title: 'Flight → SFO',
      description: null,
      startTime: new Date(2026, 7, 2, 22, 0).toISOString(),
      endTime: new Date(2026, 7, 3, 6, 0).toISOString(),
    });

    const span = spanForDay(overnight, MONDAY);

    expect(span).not.toBeNull();
    expect(span?.leftPct).toBe(0);
    expect(span?.continuesFrom).toBe(true);
    // Ends 06:00 → a quarter of the row.
    expect(span?.widthPct).toBeCloseTo(25, 1);
  });

  it('flags an event that runs past midnight into the next day', () => {
    const span = spanForDay(
      event({
        startTime: new Date(2026, 7, 3, 22, 0).toISOString(),
        endTime: new Date(2026, 7, 4, 2, 0).toISOString(),
      }),
      MONDAY,
    );

    expect(span?.continuesTo).toBe(true);
    // Clipped at local midnight, never spilling past the row.
    expect((span?.leftPct ?? 0) + (span?.widthPct ?? 0)).toBeCloseTo(100, 1);
  });

  it('gives an all-day event the whole row', () => {
    const span = spanForDay(event({ isAllDay: true }), MONDAY);

    expect(span?.leftPct).toBe(0);
    expect(span?.widthPct).toBe(100);
  });

  /** Which local day columns of that week an event claims, by day of month. */
  function coveredDays(entry: ScheduleEvent): number[] {
    return [1, 2, 3, 4, 5]
      .map((day) => startOfLocalDay(new Date(2026, 7, day)))
      .filter((day) => spanForDay(entry, day) !== null)
      .map((day) => day.getDate());
  }

  /**
   * A Google all-day row is date-only in the payload, so it is stored UTC
   * midnight to UTC midnight. Clipped by instant overlap it claimed TWO
   * adjacent columns in every zone — Aug 3 and Aug 4 under UTC and east of it,
   * Aug 2 and Aug 3 across the Americas — so one birthday drew two chips.
   */
  it('puts a UTC-midnight all-day event on exactly one day column, in every zone', () => {
    for (const zone of ['UTC', 'Asia/Tokyo', 'Pacific/Auckland', 'America/New_York', 'America/Los_Angeles']) {
      withTimeZone(zone, () => {
        const birthday = event({
          title: 'Ada’s birthday',
          startTime: '2026-08-03T00:00:00.000Z',
          endTime: '2026-08-04T00:00:00.000Z',
          isAllDay: true,
        });

        expect(coveredDays(birthday)).toEqual([3]);
      });
    }
  });

  /** The other shape: EventForm writes all-day events at LOCAL midnight. */
  it('puts a local-midnight all-day event on exactly one day column', () => {
    withTimeZone('Asia/Tokyo', () => {
      const holiday = event({
        startTime: new Date(2026, 7, 3).toISOString(),
        endTime: new Date(2026, 7, 4).toISOString(),
        isAllDay: true,
      });

      expect(coveredDays(holiday)).toEqual([3]);
    });
  });

  it('spans an all-day event over every date it names, exclusive end and all', () => {
    const trip = event({
      startTime: '2026-08-03T00:00:00.000Z',
      endTime: '2026-08-06T00:00:00.000Z',
      isAllDay: true,
    });

    expect(coveredDays(trip)).toEqual([3, 4, 5]);
  });

  it('leaves an event that ends exactly at midnight off the following day', () => {
    const lateShift = event({
      title: 'Close the bar',
      startTime: new Date(2026, 7, 2, 23, 0).toISOString(),
      endTime: new Date(2026, 7, 3, 0, 0).toISOString(),
    });

    // The old `end < dayStart` test admitted it, then clipped it to zero
    // minutes and widened it to the 20-minute floor: a phantom chip pinned to
    // the top of a day the event never touched.
    expect(spanForDay(lateShift, MONDAY)).toBeNull();
    expect(spanForDay(lateShift, addDays(MONDAY, -1))).not.toBeNull();
  });

  it('keeps a zero-length event that starts at midnight on its own day', () => {
    const span = spanForDay(
      event({ startTime: new Date(2026, 7, 3, 0, 0).toISOString(), endTime: null }),
      MONDAY,
    );

    expect(span?.leftPct).toBe(0);
    expect(span?.widthPct).toBeGreaterThan(0);
  });

  it('gives a zero-length event a floor width so it stays visible', () => {
    const span = spanForDay(
      event({ startTime: new Date(2026, 7, 3, 9, 0).toISOString(), endTime: null }),
      MONDAY,
    );

    expect(span?.widthPct).toBeGreaterThan(0);
  });

  it('ignores an unparseable start instant rather than rendering NaN', () => {
    expect(spanForDay(event({ startTime: 'not-a-date' }), MONDAY)).toBeNull();
  });
});

describe('packLanes — keeping overlapping events reachable', () => {
  /** The spans one day's worth of events produce, in the order the row uses. */
  function spansFor(...events: ScheduleEvent[]) {
    return events
      .map((e) => spanForDay(e, MONDAY))
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => a.leftPct - b.leftPct);
  }

  /** An event on MONDAY, by local hour. */
  function block(id: string, fromHour: number, toHour: number): ScheduleEvent {
    return event({
      id,
      title: id,
      startTime: new Date(2026, 7, 3, fromHour, 0).toISOString(),
      endTime: new Date(2026, 7, 3, toHour, 0).toISOString(),
    });
  }

  it('puts a lone event on the first lane', () => {
    expect(packLanes(spansFor(block('a', 9, 10)))).toEqual([0]);
  });

  it('splits two events that overlap onto separate lanes', () => {
    // Drawn into one strip, the second buries the first: unreachable by
    // pointer, and its tooltip can never open.
    expect(packLanes(spansFor(block('a', 9, 12), block('b', 10, 13)))).toEqual([0, 1]);
  });

  it('leaves back-to-back events on one lane — touching edges are not an overlap', () => {
    expect(packLanes(spansFor(block('a', 9, 10), block('b', 10, 11)))).toEqual([0, 0]);
  });

  it('opens a third lane for a three-way double-booking', () => {
    expect(packLanes(spansFor(block('a', 9, 12), block('b', 10, 13), block('c', 11, 14)))).toEqual([0, 1, 2]);
  });

  it('reuses a lane once the chip occupying it has ended', () => {
    // b overlaps a and takes lane 1; c starts after a ends, so lane 0 is free.
    expect(packLanes(spansFor(block('a', 9, 11), block('b', 10, 15), block('c', 12, 13)))).toEqual([0, 1, 0]);
  });

  it('reuses a freed lane rather than opening a new one', () => {
    // b sits inside a's long block and takes lane 1; c starts after b's chip has
    // ended, so lane 1 is the lowest one free by then — a third is not needed.
    expect(packLanes(spansFor(block('a', 9, 17), block('b', 10, 11), block('c', 12, 13)))).toEqual([0, 1, 1]);
  });

  it('is empty for a day with nothing on it', () => {
    expect(packLanes([])).toEqual([]);
  });
});

function day(clusters: RhythmDay['clusters'], date = '2026-08-03'): RhythmDay {
  return { date, dow: 'Monday', clusters };
}

function cluster(id: string, pOccur: number, dayparts: [string, number][]): RhythmDay['clusters'][number] {
  return {
    clusterId: id,
    name: id,
    l0Class: 'WORK',
    pOccur,
    scheduled: false,
    daypartProbs: dayparts.map(([label, probability]) => ({ label, probability })),
  };
}

describe('describes — whether the event text adds anything to the title', () => {
  it('shows the text when the title is a bare category word', () => {
    // The case that prompted this: candidates minted from ci.actions inherit
    // the action's title verbatim, which is often just "Action" or "Goal",
    // leaving what the thing actually is unread in the description.
    expect(
      describes(event({ title: 'Action', description: 'Send Liam the Q3 numbers before the review' })),
    ).toBe(true);
  });

  it('stays quiet when there is no text', () => {
    expect(describes(event({ description: null }))).toBe(false);
    expect(describes(event({ description: '   ' }))).toBe(false);
  });

  it('stays quiet when the text only restates the title', () => {
    // Several producers copy the title into the description; the same line
    // twice in one tooltip reads as a bug, not as detail.
    expect(describes(event({ title: 'Standup', description: 'Standup' }))).toBe(false);
    expect(describes(event({ title: 'Standup', description: '  standup ' }))).toBe(false);
  });
});

describe('eventUrl — page link for a captured visit', () => {
  it('reads a http(s) URL from metadata', () => {
    expect(eventUrl(event({ metadata: { url: 'https://github.com/companionintelligence/CI-Server' } }))).toBe(
      'https://github.com/companionintelligence/CI-Server',
    );
  });

  it('ignores missing or non-http values', () => {
    expect(eventUrl(event())).toBeNull();
    expect(eventUrl(event({ metadata: null }))).toBeNull();
    expect(eventUrl(event({ metadata: { url: 'javascript:alert(1)' } }))).toBeNull();
    expect(eventUrl(event({ metadata: { url: '  ' } }))).toBeNull();
  });
});

describe('daypartWeights — collapsing a day of clusters into four weights', () => {
  it('is all-zero for a day with no forecast', () => {
    expect(daypartWeights(undefined)).toEqual([0, 0, 0, 0]);
  });

  it('weights a daypart by occurrence probability times daypart share', () => {
    const [, morning] = daypartWeights(day([cluster('gym', 0.8, [['morning', 0.5]])]));

    expect(morning).toBeCloseTo(0.4, 5);
  });

  it('takes the strongest claim, not the union — two certainties are still one', () => {
    const weights = daypartWeights(
      day([cluster('gym', 1, [['evening', 1]]), cluster('reading', 1, [['evening', 1]])]),
    );

    expect(weights[3]).toBeCloseTo(1, 5);
  });

  it('is not raised by piling on weak claims', () => {
    const weak = Array.from({ length: 12 }, (_, i) => cluster(`w${i}`, 0.4, [['morning', 0.4]]));

    // Twelve maybes do not add up to a certainty.
    expect(daypartWeights(day(weak))[1]).toBeCloseTo(0.16, 5);
  });

  it('stays differentiated at a realistic cluster count', () => {
    // ~20 near-certain clusters spreading mass over every daypart is what the
    // live account looks like; a noisy-OR union saturates all four to ~1 and the
    // layer stops carrying information.
    const many = Array.from({ length: 20 }, (_, i) =>
      cluster(`c${i}`, 0.99, [
        ['night', 0.23],
        ['morning', 0.23],
        ['afternoon', 0.31],
        ['evening', 0.23],
      ]),
    );
    many.push(
      cluster('discord', 0.99, [
        ['afternoon', 0.75],
        ['evening', 0.25],
      ]),
    );

    const [night, , afternoon] = daypartWeights(day(many));

    expect(afternoon).toBeGreaterThan(0.7);
    expect(night).toBeLessThan(0.3);
    expect(afternoon - night).toBeGreaterThan(0.4);
  });

  it('ignores daypart labels it does not recognise', () => {
    expect(daypartWeights(day([cluster('gym', 1, [['brunch', 1]])]))).toEqual([0, 0, 0, 0]);
  });
});

describe('rhythmCells — 15-minute intensities across a local day', () => {
  const lookupFor = (days: RhythmDay[]) => (utcDate: string) => days.find((d) => d.date === utcDate);

  it('emits one cell per 15-minute slot of the day', () => {
    expect(rhythmCells(MONDAY, () => undefined)).toHaveLength(96);
  });

  it('is all-zero when no forecast covers the day', () => {
    expect(rhythmCells(MONDAY, () => undefined).every((c) => c === 0)).toBe(true);
  });

  it('carries the weight of whichever UTC daypart each local hour falls in', () => {
    const cells = rhythmCells(
      MONDAY,
      lookupFor([
        day([cluster('a', 1, [['night', 0.9]])], '2026-08-03'),
        day([cluster('b', 1, [['night', 0.9]])], '2026-08-04'),
      ]),
    );

    // Whatever the viewer's offset, every slot resolves to some real daypart
    // weight — no slot is left unresolved by the UTC→local mapping.
    expect(cells.some((c) => c > 0)).toBe(true);
    expect(cells.every((c) => c >= 0 && c <= 1)).toBe(true);
  });

  it('reaches across the UTC date boundary for the tail of a local day', () => {
    // Only the NEXT UTC date carries any weight. A local day that runs past
    // midnight UTC must still pick it up, instead of flatlining.
    //
    // The zone is pinned because the assertion is ABOUT the offset: under UTC a
    // local day IS a UTC day, there is no tail reaching past midnight, and the
    // case proves nothing. New York in August is UTC-4, so local 20:00 onward
    // falls in the next UTC date's `night` daypart — and only those sixteen slots.
    const cells = withTimeZone('America/New_York', () =>
      rhythmCells(
        startOfLocalDay(new Date(2026, 7, 3)),
        lookupFor([
          day([], '2026-08-03'),
          day(
            [
              cluster('late', 1, [
                ['night', 1],
                ['morning', 1],
                ['afternoon', 1],
                ['evening', 1],
              ]),
            ],
            '2026-08-04',
          ),
        ]),
      ),
    );

    expect(cells.slice(0, 80)).toEqual(Array.from({ length: 80 }, () => 0));
    expect(cells.slice(80)).toEqual(Array.from({ length: 16 }, () => 1));
  });

  it('preserves ordering between a strong and a weak daypart', () => {
    // Pinned for the same reason as the case above: which local slots reach
    // which daypart is exactly what varies by offset. Left to the machine, a
    // far-eastern zone (Chatham is UTC+12:45) slides the whole row off the
    // afternoon band and the strong claim never appears at all.
    const cells = withTimeZone('America/New_York', () =>
      rhythmCells(
        startOfLocalDay(new Date(2026, 7, 3)),
        lookupFor([
          day(
            [
              cluster('work', 0.9, [
                ['afternoon', 0.9],
                ['night', 0.1],
              ]),
            ],
            '2026-08-03',
          ),
          day(
            [
              cluster('work', 0.9, [
                ['afternoon', 0.9],
                ['night', 0.1],
              ]),
            ],
            '2026-08-04',
          ),
        ]),
      ),
    );

    // Dayparts the clusters never claim stay at 0; among the ones they do, the
    // strong/weak ordering survives.
    const claimed = cells.filter((c) => c > 0);

    expect(Math.max(...claimed)).toBeCloseTo(0.81, 2);
    expect(Math.min(...claimed)).toBeCloseTo(0.09, 2);

    // At UTC-4 the UTC afternoon band (12:00–17:59Z) is local 08:00–13:59, and
    // UTC night is local 20:00–23:59 plus the 00:00–01:59 tail of the same band
    // the previous UTC date opened. Slot 40 is 10:00; slot 88 is 22:00.
    expect(cells[40]).toBeCloseTo(0.81, 2);
    expect(cells[88]).toBeCloseTo(0.09, 2);
  });
});

describe('occupancyClaims — 96-bin histogram clipped onto a local day', () => {
  function bucket(overrides: Partial<ForecastBucket> = {}): ForecastBucket {
    return {
      bucketIndex: 36,
      startTime: new Date(2026, 7, 3, 9, 0).toISOString(),
      l0Probs: [{ label: 'WORK', probability: 0.8 }],
      l1Probs: [{ label: 'focus', probability: 0.7 }],
      l2Probs: null,
      q10: 0.5,
      q50: 0.8,
      q90: 0.9,
      ...overrides,
    };
  }

  it('returns null when nothing lands on the day', () => {
    expect(occupancyClaims(MONDAY, [])).toBeNull();
    expect(occupancyClaims(MONDAY, [bucket({ startTime: addDays(MONDAY, 2).toISOString() })])).toBeNull();
  });

  it('emits 96 cells and places a 09:00 bin at slot 36', () => {
    const cells = occupancyClaims(MONDAY, [bucket()]);

    expect(cells).toHaveLength(96);
    expect(cells?.[36].weight).toBe(0.8);
    expect(cells?.[36].l0Class).toBe('WORK');
    expect(cells?.[36].bucket?.l1Probs[0]?.label).toBe('focus');
    expect(cells?.filter((cell) => cell.bucket !== null)).toHaveLength(1);
  });

  it('keeps a UTC histogram on the local day the instant actually falls in', () => {
    // 02:00 UTC on the 4th is 22:00 the previous evening in New York in August.
    const cells = withTimeZone('America/New_York', () => {
      const monday = startOfLocalDay(new Date(2026, 7, 3));

      return occupancyClaims(monday, [
        bucket({
          bucketIndex: 8,
          startTime: '2026-08-04T02:00:00.000Z',
          l0Probs: [{ label: 'SLEEP', probability: 0.9 }],
          q50: 0.9,
        }),
      ]);
    });

    expect(cells).not.toBeNull();
    expect(cells?.[88].l0Class).toBe('SLEEP');
    expect(cells?.[88].weight).toBe(0.9);
  });

  it('only counts occupancy that falls inside the drawn window', () => {
    const bins = [bucket()];

    expect(occupancySignalInRange(bins, MONDAY, addDays(MONDAY, 1))).toBe(true);
    expect(occupancySignalInRange(bins, addDays(MONDAY, 1), addDays(MONDAY, 8))).toBe(false);
    expect(occupancySignalInRange([bucket({ q50: 0.01 })], MONDAY, addDays(MONDAY, 1))).toBe(false);
  });
});

describe('dropInstant — where a dragged suggestion lands', () => {
  it('maps the middle of a row to midday', () => {
    expect(dropInstant(MONDAY, 0.5).getHours()).toBe(12);
  });

  it('snaps to a quarter hour rather than implying false precision', () => {
    // 09:07 worth of ratio should land on 09:00, not 09:07.
    const ratio = (9 * 60 + 7) / 1440;

    const at = dropInstant(MONDAY, ratio);
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes() % 15).toBe(0);
  });

  it('rounds to the nearer quarter, not always down', () => {
    const ratio = (9 * 60 + 13) / 1440;

    expect(dropInstant(MONDAY, ratio).getMinutes()).toBe(15);
  });

  it('clamps a drop before the row to the start of the day', () => {
    expect(dropInstant(MONDAY, -0.4).getTime()).toBe(MONDAY.getTime());
  });

  it('never spills a drop past the end of the row into the next day', () => {
    const at = dropInstant(MONDAY, 1.4);

    expect(at.getDate()).toBe(MONDAY.getDate());
    expect(at.getTime()).toBeLessThan(addDays(MONDAY, 1).getTime());
  });

  it('lands on the row it was dropped on, not on today', () => {
    const thursday = addDays(MONDAY, 3);

    expect(dropInstant(thursday, 0.5).getDate()).toBe(thursday.getDate());
  });

  it('falls back to the start of the day rather than an invalid instant', () => {
    // A drop event with no usable coordinate must not send Invalid Date to the
    // accept mutation.
    expect(dropInstant(MONDAY, Number.NaN).getTime()).toBe(MONDAY.getTime());
  });
});

describe('dropInstant / movedStart — days that are not 24 hours long', () => {
  // New York springs forward on Sun 08 Mar 2026 (a 23-hour day) and falls back
  // on Sun 01 Nov 2026 (a 25-hour day). The row is still drawn as 1440 minutes
  // of wall clock, so a drop has to land on the time the user is pointing at
  // rather than that many milliseconds after midnight.
  const ZONE = 'America/New_York';

  it('books the visual noon guide at noon on a spring-forward day', () => {
    withTimeZone(ZONE, () => {
      const springForward = startOfLocalDay(new Date(2026, 2, 8));

      // Adding 12h of elapsed time to midnight lands on 13:00 here.
      expect(dropInstant(springForward, 0.5).getHours()).toBe(12);
    });
  });

  it('books the visual noon guide at noon on a fall-back day', () => {
    withTimeZone(ZONE, () => {
      const fallBack = startOfLocalDay(new Date(2026, 10, 1));

      // ...and 11:00 here, for the mirror-image reason.
      expect(dropInstant(fallBack, 0.5).getHours()).toBe(12);
    });
  });

  it('never spills a right-edge drop onto the next date across a spring-forward', () => {
    withTimeZone(ZONE, () => {
      const springForward = startOfLocalDay(new Date(2026, 2, 8));
      const at = dropInstant(springForward, 1.4);

      // The clamp is one grain short of the row's end. On a 23-hour day a
      // millisecond clamp overshoots and books 00:45 the FOLLOWING day, which
      // is the same invariant the non-DST case above asserts.
      expect(at.getDate()).toBe(8);
      expect(at.getHours()).toBe(23);
      expect(at.getMinutes()).toBe(45);
      expect(at.getTime()).toBeLessThan(addDays(springForward, 1).getTime());
    });
  });

  it('never spills a right-edge drop onto the next date across a fall-back', () => {
    withTimeZone(ZONE, () => {
      const fallBack = startOfLocalDay(new Date(2026, 10, 1));
      const at = dropInstant(fallBack, 1.4);

      expect(at.getDate()).toBe(1);
      expect(at.getTime()).toBeLessThan(addDays(fallBack, 1).getTime());
    });
  });

  it('moves an event to the wall-clock time it was dropped on, DST or not', () => {
    withTimeZone(ZONE, () => {
      const springForward = startOfLocalDay(new Date(2026, 2, 8));
      const at = movedStart(springForward, 15 / 24, 0);

      expect(at.getDate()).toBe(8);
      expect(at.getHours()).toBe(15);
      expect(at.getMinutes()).toBe(0);
    });
  });

  it('keeps a drop in the hour the clock skips on the day it was made', () => {
    withTimeZone(ZONE, () => {
      const springForward = startOfLocalDay(new Date(2026, 2, 8));

      // 02:00–03:00 does not exist on this date. Whatever it normalises to, it
      // must stay on the row it was dropped on.
      const at = dropInstant(springForward, (2 * 60 + 30) / 1440);

      expect(at.getDate()).toBe(8);
      expect(at.getTime()).toBeGreaterThanOrEqual(springForward.getTime());
      expect(at.getTime()).toBeLessThan(addDays(springForward, 1).getTime());
    });
  });
});

describe('movedStart — dragging a committed event to a new time', () => {
  const NOON_OFFSET = 12 * 60 * 60 * 1000;

  it('moves by the delta between grab and drop, not to the cursor', () => {
    // Grabbed 30 minutes into the event, dropped at 15:00 → starts at 14:30.
    const grabOffsetMs = 30 * 60 * 1000;

    const at = movedStart(MONDAY, 15 / 24, grabOffsetMs);

    expect(at.getHours()).toBe(14);
    expect(at.getMinutes()).toBe(30);
  });

  it('starts the event at the cursor when it was grabbed by its leading edge', () => {
    const at = movedStart(MONDAY, 0.5, 0);

    expect(at.getHours()).toBe(12);
    expect(at.getMinutes()).toBe(0);
  });

  it('snaps the resulting start to the drop grain', () => {
    const at = movedStart(MONDAY, (9 * 60 + 7) / 1440, 0);

    expect(at.getMinutes() % 15).toBe(0);
  });

  it('carries the event onto the row it was dropped on', () => {
    const thursday = addDays(MONDAY, 3);

    expect(movedStart(thursday, 0.5, 0).getDate()).toBe(thursday.getDate());
  });

  it('walks an event back a day when it is grabbed past its own start', () => {
    // The clipped tail of an overnight event: the chip begins at local midnight
    // but the event began the previous evening, so the grab offset exceeds the
    // drop position and the new start lands on the day before.
    const at = movedStart(MONDAY, 0.1, NOON_OFFSET);

    expect(at.getTime()).toBeLessThan(MONDAY.getTime());
  });

  it('falls back to the start of the day on an unusable coordinate', () => {
    expect(movedStart(MONDAY, Number.NaN, 0).getTime()).toBe(MONDAY.getTime());
  });
});

describe('slotForecastLine — what the drawer is allowed to claim', () => {
  it('names the weekday and daypart when a cluster wins that hour', () => {
    withTimeZone('UTC', () => {
      const instant = new Date(Date.UTC(2026, 7, 6, 16, 15));
      const day: RhythmDay = {
        date: '2026-08-06',
        dow: 'Thu',
        clusters: [
          {
            clusterId: 'c1',
            name: 'Deep Work',
            l0Class: 'WORK',
            pOccur: 0.9,
            scheduled: false,
            daypartProbs: [
              { label: 'afternoon', probability: 0.8 },
              { label: 'morning', probability: 0.1 },
            ],
          },
        ],
      };

      const line = slotForecastLine({ instant, allDay: false }, (key) =>
        key === '2026-08-06' ? day : undefined,
      );

      expect(line).toMatch(/usually have Deep Work/);
      expect(line).toMatch(/afternoon/);
    });
  });

  it('returns null when the model has nothing honest to say', () => {
    withTimeZone('UTC', () => {
      const instant = new Date(Date.UTC(2026, 7, 6, 16, 15));

      expect(slotForecastLine({ instant, allDay: false }, () => undefined)).toBeNull();
    });
  });
});

/**
 * The zone the grid draws in is the OWNER'S, not the browser's.
 *
 * Every case here pins the process to a zone that disagrees with the profile
 * one being passed in — the browser zone is exactly what the old
 * `getHours()`-based geometry read, so a test that let the two coincide would
 * pass against the bug this closes.
 */
describe('scheduleGeometry — drawn in the profile zone, not the browser one', () => {
  const PROFILE = 'America/New_York';

  /** 09:00–09:30 in New York on Mon 03 Aug 2026, exactly as the placer books it. */
  const placedAtNine = event({
    startTime: '2026-08-03T13:00:00Z',
    endTime: '2026-08-03T13:30:00Z',
  });

  it('puts a block the placer booked at 09:00 on the 09:00 row', () => {
    withTimeZone('Asia/Tokyo', () => {
      const monday = startOfLocalDay(new Date('2026-08-03T13:00:00Z'), PROFILE);
      const span = spanForDay(placedAtNine, monday, PROFILE);

      expect(span?.leftPct).toBeCloseTo((9 * 60 * 100) / 1440, 5);
    });
  });

  it('is the wrong hour — and the wrong day — when the browser zone is used instead', () => {
    withTimeZone('Asia/Tokyo', () => {
      // Tokyo is nine hours ahead of UTC, so the same instant reads 22:00 there
      // and the Monday row does not even contain it. This is what the owner saw.
      const monday = startOfLocalDay(new Date('2026-08-03T13:00:00Z'));

      expect(spanForDay(placedAtNine, monday)?.leftPct).toBeCloseTo((22 * 60 * 100) / 1440, 5);
    });
  });

  it('keeps a late-evening block on the profile day rather than the UTC one', () => {
    withTimeZone('UTC', () => {
      // 22:00 Monday in New York is Tuesday 02:00 UTC.
      const lateEvening = event({
        startTime: '2026-08-04T02:00:00Z',
        endTime: '2026-08-04T03:00:00Z',
      });
      const monday = startOfLocalDay(new Date('2026-08-03T13:00:00Z'), PROFILE);
      const tuesday = addDays(monday, 1, PROFILE);

      expect(spanForDay(lateEvening, monday, PROFILE)?.leftPct).toBeCloseTo((22 * 60 * 100) / 1440, 5);
      expect(spanForDay(lateEvening, tuesday, PROFILE)).toBeNull();
    });
  });

  it('drops a chip at the profile wall-clock time the cursor was over', () => {
    withTimeZone('Asia/Tokyo', () => {
      const monday = startOfLocalDay(new Date('2026-08-03T13:00:00Z'), PROFILE);
      const at = dropInstant(monday, 15 / 24, PROFILE);

      // 15:00 in New York on 03 Aug 2026 (EDT, UTC-4).
      expect(at.toISOString()).toBe('2026-08-03T19:00:00.000Z');
    });
  });

  it('moves a dragged chip by the grab delta in profile wall clock', () => {
    withTimeZone('Asia/Tokyo', () => {
      const monday = startOfLocalDay(new Date('2026-08-03T13:00:00Z'), PROFILE);
      const at = movedStart(monday, 15 / 24, 30 * 60_000, PROFILE);

      expect(at.toISOString()).toBe('2026-08-03T18:30:00.000Z');
    });
  });

  it('paints the rhythm strip against the profile day, not the browser one', () => {
    withTimeZone('Asia/Tokyo', () => {
      // 12:00–18:00 UTC is the 'afternoon' daypart; 08:00–14:00 in New York.
      const day: RhythmDay = {
        date: '2026-08-03',
        dow: 'Mon',
        clusters: [
          {
            clusterId: 'c1',
            name: 'Deep work',
            l0Class: 'WORK',
            pOccur: 1,
            scheduled: false,
            daypartProbs: [{ label: 'afternoon', probability: 1 }],
          },
        ],
      };
      const monday = startOfLocalDay(new Date('2026-08-03T13:00:00Z'), PROFILE);
      const cells = rhythmCells(monday, (key) => (key === '2026-08-03' ? day : undefined), PROFILE);

      // Slot 36 is 09:00 profile time = 13:00 UTC, inside the band.
      expect(cells[36]).toBe(1);
      // Slot 4 is 01:00 profile time = 05:00 UTC, outside it.
      expect(cells[4]).toBe(0);
    });
  });
});
