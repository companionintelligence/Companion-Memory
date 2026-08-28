import { PipelineStateService } from '../../services/PipelineStateService';
import {
  CLEAN_TEMPORAL_REPAIR_STAGE_ID,
  CONFIRMATION_TOLERANCE_MS,
  SOURCE_TIME_SPECS,
  TEMPORAL_REPAIR_SOURCE,
  TEMPORAL_REPAIR_VERSION,
  TIME_PRECISIONS,
  TIME_SOURCES,
  TemporalRepairStage,
  type TemporalRow,
  classifyEventTime,
  isKnownTimeZone,
  parseSourceTime,
  temporalRepairStageVersion,
  wallClockInUtc,
  zonedWallClockToUtc,
} from '../clean/TemporalRepairStage';

/**
 * `clean.temporal_repair` — the stage that moves dates on the user's timeline.
 *
 * Three things are worth testing here and they are not the usual three:
 *
 *  1. **The classifier is a pure function**, so every repair class is a table
 *     row rather than an integration fixture. That matters more than for other
 *     stages because a wrong rule produces no error — it produces a timeline
 *     that is quietly wrong, which is indistinguishable from a timeline that is
 *     quietly right until someone notices their gym is dated today.
 *  2. **The provenance is complete.** Every row the stage writes gets a
 *     `time_source`, and only the rows it MOVES get a `start_time_original`.
 *     A repair nobody can see is a rewrite.
 *  3. **The undo survives a second generation.** `start_time_original` is
 *     written `COALESCE(existing, current)`, so a v2 repair cannot overwrite the
 *     true original with v1's answer. That single `COALESCE` is the difference
 *     between a cleaner that can be reversed and one that only looks reversible,
 *     and it is asserted against the SQL text because there is nowhere else it
 *     can be observed.
 *
 * Plus the selection block every stage in this domain carries: the sweep decides
 * candidacy from `ci.pipeline_state` and NEVER from `ci.events.time_source`.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const ENTITY_TYPE = 'event';

/** Ordered uuids: they compare the same way in Postgres and in JS. */
function eventId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function row(overrides: Partial<TemporalRow> = {}): TemporalRow {
  return {
    id: eventId(1),
    start_time: new Date('2020-06-15T00:00:00.000Z'),
    end_time: null,
    is_all_day: false,
    source_system: 'amazon',
    metadata: {},
    start_time_original: null,
    ...overrides,
  };
}

/* ===================================================================== *
 * The version
 * ===================================================================== */

describe('the version', () => {
  it('is a positive integer, as versions.ts requires', () => {
    // 0 would make rows stranded in status='running' unreclaimable; a fraction
    // truncates in Postgres so the bump would be a silent no-op.
    expect(Number.isInteger(TEMPORAL_REPAIR_VERSION)).toBe(true);
    expect(TEMPORAL_REPAIR_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('accepts a STAGE_VERSIONS map that has no entry yet', () => {
    // This file exists before `constants.ts` and `versions.ts` learn the id.
    expect(temporalRepairStageVersion({})).toBe(TEMPORAL_REPAIR_VERSION);
  });

  it('throws when STAGE_VERSIONS disagrees with the derivation', () => {
    // The mirror-image of a hardcoded version: bump the generation, forget the
    // one-line diff, and the two disagree about what has already been repaired.
    expect(() =>
      temporalRepairStageVersion({ [CLEAN_TEMPORAL_REPAIR_STAGE_ID]: TEMPORAL_REPAIR_VERSION + 1 }),
    ).toThrow(/versions\.ts in the same commit/);
  });
});

/* ===================================================================== *
 * Time-zone arithmetic
 * ===================================================================== */

describe('zonedWallClockToUtc', () => {
  it('resolves a wall clock against a standard-time offset', () => {
    // 2020-01-15 00:00 in Los Angeles is PST (UTC-8).
    expect(
      zonedWallClockToUtc(
        { year: 2020, month: 1, day: 15, hour: 0, minute: 0, second: 0, millisecond: 0 },
        'America/Los_Angeles',
      ).toISOString(),
    ).toBe('2020-01-15T08:00:00.000Z');
  });

  it('resolves a wall clock against a daylight-time offset', () => {
    // 2020-06-15 00:00 in Los Angeles is PDT (UTC-7) — this is the exact case
    // TransformGoogleCalendar gets wrong, and it is why the naive "add a fixed
    // offset" repair would be wrong half the year.
    expect(
      zonedWallClockToUtc(
        { year: 2020, month: 6, day: 15, hour: 0, minute: 0, second: 0, millisecond: 0 },
        'America/Los_Angeles',
      ).toISOString(),
    ).toBe('2020-06-15T07:00:00.000Z');
  });

  it('resolves an east-of-Greenwich half-hour zone', () => {
    // Kolkata is UTC+5:30 and never observes DST — a fixed-offset table with
    // whole hours would be wrong for a fifth of the world.
    expect(
      zonedWallClockToUtc(
        { year: 2021, month: 3, day: 2, hour: 9, minute: 15, second: 0, millisecond: 0 },
        'Asia/Kolkata',
      ).toISOString(),
    ).toBe('2021-03-02T03:45:00.000Z');
  });

  it('is the inverse of reading the instant back in the same zone', () => {
    // The property that matters: whatever the offset rules are, the instant this
    // produces is the one at which the zone shows the wall clock it was given.
    const zone = 'Europe/Berlin';

    for (const month of [1, 4, 7, 10]) {
      const wall = { year: 2023, month, day: 12, hour: 14, minute: 30, second: 0, millisecond: 0 };
      const instant = zonedWallClockToUtc(wall, zone);
      const shown = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(instant);

      expect(shown).toBe(`${String(month).padStart(2, '0')}/12/2023, 14:30`);
    }
  });

  it('terminates on a spring-forward gap instead of looping', () => {
    // 2020-03-08 02:30 does not exist in Los Angeles. No answer is correct; the
    // requirement is that a slice never hangs on one.
    const instant = zonedWallClockToUtc(
      { year: 2020, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 0 },
      'America/Los_Angeles',
    );

    expect(Number.isNaN(instant.getTime())).toBe(false);
  });

  it('round-trips through wallClockInUtc for the zero-offset zone', () => {
    const instant = new Date('2021-11-04T03:55:35.237Z');

    expect(zonedWallClockToUtc(wallClockInUtc(instant), 'UTC').toISOString()).toBe(instant.toISOString());
  });
});

describe('isKnownTimeZone', () => {
  it.each([['UTC'], ['America/Los_Angeles'], ['Asia/Kolkata']])('accepts %s', (zone) => {
    expect(isKnownTimeZone(zone)).toBe(true);
  });

  it.each([[null], [undefined], [''], ['   '], [' UTC '], ['Mars/Olympus_Mons']])('rejects %p', (zone) => {
    expect(isKnownTimeZone(zone)).toBe(false);
  });

  it.each([['PST'], ['CST'], ['IST'], ['AST'], ['EST']])(
    'rejects the abbreviation %s even though ICU silently resolves it',
    (abbreviation) => {
      // THE reason this guard is not just a try/catch around Intl. ICU accepts
      // every one of these and picks one zone: CST → America/Chicago (not
      // China), IST → Asia/Calcutta (not Israel, not Ireland), AST →
      // America/Anchorage (not Arabia, not Atlantic). That is the same arbitrary
      // choice §6.6 records in the ETL's hand-rolled table, made inside a
      // formatting library instead. Accepting it would move a user's dates by
      // hours and call the result a repair.
      expect(() =>
        new Intl.DateTimeFormat('en-US', { timeZone: abbreviation }).format(new Date()),
      ).not.toThrow();

      expect(isKnownTimeZone(abbreviation)).toBe(false);
    },
  );
});

/* ===================================================================== *
 * Reading a retained source timestamp
 * ===================================================================== */

describe('parseSourceTime', () => {
  it('reads an explicit-offset instant and calls it second precision', () => {
    const parsed = parseSourceTime('2026-05-19T19:56:26.000Z');

    expect(parsed?.instant?.toISOString()).toBe('2026-05-19T19:56:26.000Z');
    expect(parsed?.wall).toBeNull();
    expect(parsed?.precision).toBe(TIME_PRECISIONS.SECOND);
  });

  it('reads a non-Z explicit offset', () => {
    expect(parseSourceTime('2020-06-15T10:00:00-07:00')?.instant?.toISOString()).toBe(
      '2020-06-15T17:00:00.000Z',
    );
  });

  it('reads a bare date as a floating wall clock at day precision', () => {
    const parsed = parseSourceTime('2020-06-15');

    // The crux: a bare date has NO instant. `new Date("2020-06-15")` inventing
    // UTC midnight is the bug, so the parser must refuse to invent one too.
    expect(parsed?.instant).toBeNull();
    expect(parsed?.wall).toEqual({
      year: 2020,
      month: 6,
      day: 15,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    expect(parsed?.precision).toBe(TIME_PRECISIONS.DAY);
  });

  it('reads a floating date-time as a wall clock, never as an instant', () => {
    const parsed = parseSourceTime('2020-06-15T10:30:00');

    expect(parsed?.instant).toBeNull();
    expect(parsed?.wall?.hour).toBe(10);
    expect(parsed?.precision).toBe(TIME_PRECISIONS.SECOND);
  });

  it.each([
    [null],
    [undefined],
    [42],
    ['   '],
    ['Order #114-7788'],
    ['June 15, 2020'],
    ['2020-13-45T99:99:99Z'],
  ])('refuses %p rather than handing it to new Date', (raw) => {
    // `new Date` accepts implementation-defined garbage and answers with a
    // host-local instant for exactly the inputs this stage repairs, so anything
    // not ISO-shaped is refused outright.
    expect(parseSourceTime(raw)).toBeNull();
  });
});

/* ===================================================================== *
 * The classifier
 * ===================================================================== */

describe('classifyEventTime', () => {
  describe('undated rows pinned to import time — the corpus bug', () => {
    it('marks a Google Maps saved place as an ingest stamp with unknown precision', () => {
      // The five rows on this appliance: "Home", "Work", "Gym", all carrying the
      // identical 2026-08-08T23:42:37Z from the import run, all sitting at the
      // top of the timeline dated today.
      const decision = classifyEventTime(
        row({
          source_system: 'google_maps_places',
          start_time: new Date('2026-08-08T23:42:37.000Z'),
          metadata: { Kind: 'labeled_place', Name: 'Gym' },
        }),
        'America/Los_Angeles',
      );

      expect(decision.result.outcome).toBe('done');
      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.INGEST);
      expect(decision.patch?.timePrecision).toBe(TIME_PRECISIONS.UNKNOWN);
    });

    it('does not move the instant it cannot recover', () => {
      // There is no date to recover. The repair is the LABEL — the difference
      // between the UI saying "today" and the UI saying "no date".
      const start = new Date('2026-08-08T23:42:37.000Z');
      const decision = classifyEventTime(
        row({ source_system: 'google_maps_places', start_time: start, metadata: { Kind: 'labeled_place' } }),
        'America/Los_Angeles',
      );

      expect(decision.patch?.startTime).toEqual(start);
      expect(decision.patch?.shiftMs).toBe(0);
    });

    it('marks a moderated subreddit as an ingest stamp with unknown precision', () => {
      // The two reddit rows on this appliance
      // (reddit:moderated_subreddit:bitscoop, :u_liambroza) both carry the
      // identical 2026-08-21T00:43:50.949Z — one import wall clock — because
      // moderated_subreddits.csv is `subreddit` only and the push's affiliation
      // branch keeps an undated affiliation on the timeline anyway. Before
      // reddit joined SOURCE_TIME_SPECS this row was skipped outright, so it
      // sat at the top of the timeline dated today with no label to say so.
      const start = new Date('2026-08-21T00:43:50.949Z');
      const decision = classifyEventTime(
        row({
          source_system: 'reddit',
          start_time: start,
          metadata: { Kind: 'moderated_subreddit', Subreddit: 'bitscoop' },
        }),
        'America/Los_Angeles',
      );

      expect(decision.result.outcome).toBe('done');
      expect(decision.result.detail?.repairClass).toBe('undated_ingest_stamp');
      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.INGEST);
      expect(decision.patch?.timePrecision).toBe(TIME_PRECISIONS.UNKNOWN);
      // Marked, never moved — there is no date to recover.
      expect(decision.patch?.startTime).toEqual(start);
      expect(decision.patch?.shiftMs).toBe(0);
    });

    it('leaves a dated reddit record alone', () => {
      // posts.csv / comments.csv / messages_archive.csv all carry real dates
      // (reddit.ts parseRedditDate), so only the two affiliation kinds are
      // Class 1 — widening the spec must not relabel the dated majority.
      const decision = classifyEventTime(
        row({
          source_system: 'reddit',
          start_time: new Date('2022-09-16T07:04:49.000Z'),
          metadata: { Kind: 'post', Subreddit: 'bitscoop' },
        }),
        'America/Los_Angeles',
      );

      expect(decision.patch?.timeSource).not.toBe(TIME_SOURCES.INGEST);
      expect(decision.patch?.shiftMs).toBe(0);
    });

    it('leaves a dated record from the same source alone', () => {
      // `place_review` shares the source system and DOES have a real date. Only
      // the declared undated kinds are marked.
      const decision = classifyEventTime(
        row({
          source_system: 'google_maps_places',
          start_time: new Date('2025-01-26T23:47:37.122Z'),
          metadata: { Kind: 'place_review', Name: 'A dispensary' },
        }),
        'America/Los_Angeles',
      );

      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.SOURCE);
      expect(decision.patch?.shiftMs).toBe(0);
    });
  });

  describe('the discarded TZID — floating date-times constructed as UTC', () => {
    it('reconstructs an all-day calendar event in the user zone', () => {
      // TransformGoogleCalendar: `new Date("2020-06-15")` is UTC midnight per
      // ECMA-262, so a US-Pacific user's June 15 all-day event renders June 14,
      // 17:00. The wall clock is recoverable from the stored instant without the
      // raw payload, which is the whole reason this class can be repaired today.
      const decision = classifyEventTime(
        row({
          source_system: 'google_calendar',
          is_all_day: true,
          start_time: new Date('2020-06-15T00:00:00.000Z'),
        }),
        'America/Los_Angeles',
      );

      expect(decision.patch?.startTime.toISOString()).toBe('2020-06-15T07:00:00.000Z');
      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.REPAIRED);
      expect(decision.patch?.timePrecision).toBe(TIME_PRECISIONS.DAY);
      expect(decision.patch?.shiftMs).toBe(7 * 60 * 60 * 1000);
    });

    it('prefers a TZID carried in the payload over the user zone', () => {
      // A meeting booked in another zone keeps that zone. The user's own zone is
      // the fallback, not the authority.
      const decision = classifyEventTime(
        row({
          source_system: 'google_calendar',
          is_all_day: true,
          start_time: new Date('2020-06-15T00:00:00.000Z'),
          metadata: { timeZone: 'Asia/Kolkata' },
        }),
        'America/Los_Angeles',
      );

      expect(decision.patch?.startTime.toISOString()).toBe('2020-06-14T18:30:00.000Z');
    });

    it('moves end_time by the same amount, preserving the duration', () => {
      const decision = classifyEventTime(
        row({
          source_system: 'google_calendar',
          is_all_day: true,
          start_time: new Date('2020-06-15T00:00:00.000Z'),
          end_time: new Date('2020-06-16T00:00:00.000Z'),
        }),
        'America/Los_Angeles',
      );

      // An hour-long meeting stays an hour long wherever it lands; Google's
      // exclusive all-day end was parsed by the same broken path.
      expect(decision.patch?.endTime?.toISOString()).toBe('2020-06-16T07:00:00.000Z');
      expect((decision.patch?.endTime?.getTime() ?? 0) - (decision.patch?.startTime.getTime() ?? 0)).toBe(
        24 * 60 * 60 * 1000,
      );
    });

    it('labels the row ambiguous rather than guessing when no zone is resolvable', () => {
      // A stage that assumed a zone here would move 324,044 dates on a default.
      const decision = classifyEventTime(
        row({
          source_system: 'google_calendar',
          is_all_day: true,
          start_time: new Date('2020-06-15T00:00:00.000Z'),
        }),
        null,
      );

      expect(decision.patch?.shiftMs).toBe(0);
      expect(decision.patch?.timePrecision).toBe(TIME_PRECISIONS.AMBIGUOUS);
      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.INGEST);
    });

    it('still corrects the PRECISION when the zone offset happens to be zero', () => {
      // The dev appliance's user is on 'UTC', so the instant does not move — but
      // an all-day event rendering a time of day is still wrong, and `day` is
      // what stops it.
      const decision = classifyEventTime(
        row({
          source_system: 'google_calendar',
          is_all_day: true,
          start_time: new Date('2020-06-15T00:00:00.000Z'),
        }),
        'UTC',
      );

      expect(decision.patch?.shiftMs).toBe(0);
      expect(decision.patch?.timePrecision).toBe(TIME_PRECISIONS.DAY);
      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.SOURCE);
    });

    it('is idempotent — a second pass does not move the date again', () => {
      // After the first repair the instant is no longer UTC midnight, so the
      // all-day signature no longer matches and the row falls through. Without
      // this the stage would walk an event backwards seven hours per sweep.
      const first = classifyEventTime(
        row({
          source_system: 'google_calendar',
          is_all_day: true,
          start_time: new Date('2020-06-15T00:00:00.000Z'),
        }),
        'America/Los_Angeles',
      );

      const second = classifyEventTime(
        row({
          source_system: 'google_calendar',
          is_all_day: true,
          start_time: first.patch?.startTime as Date,
          start_time_original: new Date('2020-06-15T00:00:00.000Z'),
        }),
        'America/Los_Angeles',
      );

      expect(second.patch?.shiftMs).toBe(0);
      expect(second.patch?.startTime.toISOString()).toBe('2020-06-15T07:00:00.000Z');
    });
  });

  describe('a retained source string', () => {
    it('confirms an instant that agrees with the source', () => {
      const decision = classifyEventTime(
        row({
          source_system: 'amazon',
          start_time: new Date('2026-05-19T19:56:26.000Z'),
          metadata: { 'Order Date': '2026-05-19T19:56:26.000Z' },
        }),
        'UTC',
      );

      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.SOURCE);
      expect(decision.patch?.shiftMs).toBe(0);
    });

    it('tolerates sub-second truncation', () => {
      const decision = classifyEventTime(
        row({
          source_system: 'amazon',
          start_time: new Date('2026-05-19T19:56:26.000Z'),
          metadata: { 'Order Date': '2026-05-19T19:56:26.400Z' },
        }),
        'UTC',
      );

      expect(Math.abs(decision.patch?.shiftMs ?? 0)).toBeLessThanOrEqual(CONFIRMATION_TOLERANCE_MS);
      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.SOURCE);
    });

    it('adopts the source when the stored instant disagrees', () => {
      // The safest repair in the file: no zone inference, no heuristic, just the
      // unambiguous string the source sent.
      const decision = classifyEventTime(
        row({
          source_system: 'amazon',
          start_time: new Date('2026-05-19T12:56:26.000Z'),
          metadata: { 'Order Date': '2026-05-19T19:56:26.000Z' },
        }),
        'UTC',
      );

      expect(decision.patch?.startTime.toISOString()).toBe('2026-05-19T19:56:26.000Z');
      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.REPAIRED);
      expect(decision.patch?.shiftMs).toBe(7 * 60 * 60 * 1000);
    });
  });

  describe('what it refuses to touch', () => {
    it('skips a source with no declared spec, with a countable reason', () => {
      // 321,169 rows on this appliance. A skip, not a guess — and a version bump
      // re-opens every one of them the moment a spec is added.
      const decision = classifyEventTime(row({ source_system: 'google_voice' }), 'UTC');

      expect(decision.patch).toBeNull();
      expect(decision.result).toMatchObject({
        outcome: 'skipped',
        reason: 'source_time_spec_missing',
      });
    });

    it('never parses a timestamp out of a contentHash', () => {
      // `uber|2026-01-25T09:02:52.000Z|40 Berkeley St…` embeds a perfectly good
      // instant. Reading it would work today and silently re-date the corpus the
      // day the importer changes its idempotency key format.
      const decision = classifyEventTime(
        row({
          source_system: 'uber',
          metadata: { contentHash: 'uber|2026-01-25T09:02:52.000Z|40 Berkeley St, Boston' },
        }),
        'UTC',
      );

      expect(decision.result).toMatchObject({ reason: 'source_time_spec_missing' });
    });

    it('labels a user-created event as asserted and never moves it', () => {
      const decision = classifyEventTime(
        row({ source_system: null, start_time: new Date('2024-02-02T09:00:00.000Z') }),
        'America/Los_Angeles',
      );

      expect(decision.patch?.timeSource).toBe(TIME_SOURCES.USER);
      expect(decision.patch?.shiftMs).toBe(0);
    });

    it('skips an unreadable start_time rather than binding NaN into a timestamptz', () => {
      const decision = classifyEventTime(row({ start_time: new Date('nonsense') }), 'UTC');

      expect(decision.patch).toBeNull();
      expect(decision.result).toMatchObject({ outcome: 'skipped', reason: 'start_time_unreadable' });
    });
  });

  it('gives every write a provenance label — there is no unlabelled outcome', () => {
    // An unlabelled timestamp is one the UI has to present as fact. Any patch
    // this stage produces must therefore say where the instant came from.
    const cases: Array<[string, TemporalRow, string | null]> = [
      ['user', row({ source_system: null }), 'UTC'],
      ['undated', row({ source_system: 'google_maps_places', metadata: { Kind: 'labeled_place' } }), 'UTC'],
      ['confirmed', row({ metadata: { 'Order Date': '2020-06-15T00:00:00.000Z' } }), 'UTC'],
      ['unverified', row({ source_system: 'amazon' }), 'UTC'],
      ['floating', row({ source_system: 'google_calendar', is_all_day: true }), 'America/Los_Angeles'],
      ['floating-no-zone', row({ source_system: 'google_calendar', is_all_day: true }), null],
    ];

    for (const [name, input, zone] of cases) {
      const decision = classifyEventTime(input, zone);

      expect([name, decision.patch?.timeSource]).toEqual([
        name,
        expect.stringMatching(/^(source|user|repaired|ingest)$/),
      ]);
      expect([name, decision.patch?.timePrecision]).toEqual([
        name,
        expect.stringMatching(/^(second|minute|day|ambiguous|unknown)$/),
      ]);
    }
  });
});

/* ===================================================================== *
 * The declared source specs
 * ===================================================================== */

describe('SOURCE_TIME_SPECS', () => {
  it('declares only sources somebody has read the payload of', () => {
    // The corpus's four largest sources are deliberately absent. Adding one is a
    // reviewable line plus a generation bump, and that is the point.
    expect(Object.keys(SOURCE_TIME_SPECS).sort()).toEqual([
      'amazon',
      'google_calendar',
      'google_maps_places',
      'outlook_calendar',
      'reddit',
    ]);
  });

  it('never marks a source as floating-as-UTC without a zone key to resolve it', () => {
    // A floating reconstruction with no zone source anywhere would produce
    // nothing but `ambiguous` rows forever.
    for (const [source, spec] of Object.entries(SOURCE_TIME_SPECS)) {
      if (spec.floatingAsUtc) {
        expect([source, spec.zoneKeys.length]).toEqual([source, expect.any(Number)]);
        expect(spec.zoneKeys.length).toBeGreaterThan(0);
      }
    }
  });

  it('never declares an undated kind without the key that identifies it', () => {
    for (const spec of Object.values(SOURCE_TIME_SPECS)) {
      if (spec.undatedKinds.length > 0) {
        expect(typeof spec.kindKey).toBe('string');
      }
    }
  });
});

/* ===================================================================== *
 * run() — the slice
 * ===================================================================== */

interface RunHarness {
  stage: TemporalRepairStage;
  statements: Array<{ sql: string; params: unknown[] }>;
  update(): { sql: string; params: unknown[] } | undefined;
}

function makeStage(
  rows: TemporalRow[],
  opts: { timezone?: string | null; writeError?: Error } = {},
): RunHarness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params: params ?? [] });

    if (/FROM ci\.users/i.test(sql)) {
      return [{ timezone: opts.timezone === undefined ? 'America/Los_Angeles' : opts.timezone }];
    }

    if (/^select/i.test(sql)) {
      const [ids, userId] = (params ?? []) as [string[], string];

      return rows.filter((candidate) => ids.includes(candidate.id) && userId === USER);
    }

    if (opts.writeError != null) {
      throw opts.writeError;
    }

    return [];
  });

  const stage = new TemporalRepairStage({ query } as never, makeLogger() as never);

  return {
    stage,
    statements,
    update: () => statements.find((statement) => /^update/i.test(statement.sql)),
  };
}

const CTX = { userId: USER } as never;

describe('run', () => {
  it('returns exactly one result per id', async () => {
    // Ids missing from the map are recorded `failed: stage_returned_no_result`
    // by the worker — silence is never success.
    const rows = [row({ id: eventId(1) }), row({ id: eventId(2), source_system: 'google_voice' })];
    const { stage } = makeStage(rows);

    const results = await stage.run(CTX, [eventId(1), eventId(2), eventId(3)]);

    expect([...results.keys()].sort()).toEqual([eventId(1), eventId(2), eventId(3)]);
  });

  it('skips an id whose row is gone rather than failing it', async () => {
    const { stage } = makeStage([]);

    const results = await stage.run(CTX, [eventId(9)]);

    expect(results.get(eventId(9))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('gives every non-done outcome a reason', async () => {
    const { stage } = makeStage([
      row({ id: eventId(1), source_system: 'google_voice' }),
      row({ id: eventId(2), start_time: new Date('nope') }),
    ]);

    const results = await stage.run(CTX, [eventId(1), eventId(2), eventId(3)]);

    for (const [id, result] of results) {
      if (result.outcome !== 'done') {
        expect([id, result.reason]).toEqual([id, expect.any(String)]);
        expect(result.reason?.length).toBeGreaterThan(0);
      }
    }
  });

  it('issues one bulk UPDATE for the whole slice', async () => {
    // The per-row form is why the communication-link backfill never finished
    // over a 22-year history.
    const { stage, statements } = makeStage([
      row({ id: eventId(1) }),
      row({ id: eventId(2) }),
      row({ id: eventId(3) }),
    ]);

    await stage.run(CTX, [eventId(1), eventId(2), eventId(3)]);

    expect(statements.filter((statement) => /^update/i.test(statement.sql))).toHaveLength(1);
  });

  it('writes nothing at all when every row is skipped', async () => {
    const { stage, update } = makeStage([
      row({ id: eventId(1), source_system: 'whatsapp' }),
      row({ id: eventId(2), source_system: 'twitter' }),
    ]);

    await stage.run(CTX, [eventId(1), eventId(2)]);

    expect(update()).toBeUndefined();
  });

  it('scopes both reads to the user, not just the sweep', async () => {
    // A slice can arrive from a dead letter replayed weeks later. Re-scoping is
    // the difference between "this id is not yours" and moving a date on
    // someone else's timeline.
    const { stage, statements } = makeStage([row({ id: eventId(1) })]);

    await stage.run(CTX, [eventId(1)]);

    for (const statement of statements) {
      expect(statement.params).toContain(USER);
    }
  });

  it('fails the slice — not skips it — when the write throws', async () => {
    // The retry gate, the attempt budget and quarantine only apply to failures.
    const { stage } = makeStage([row({ id: eventId(1) })], { writeError: new Error('deadlock') });

    const results = await stage.run(CTX, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'temporal_write_failed',
    });
  });

  it('asks for the user timezone once per slice, not once per row', async () => {
    const { stage, statements } = makeStage([
      row({ id: eventId(1) }),
      row({ id: eventId(2) }),
      row({ id: eventId(3) }),
    ]);

    await stage.run(CTX, [eventId(1), eventId(2), eventId(3)]);

    expect(statements.filter((statement) => /FROM ci\.users/i.test(statement.sql))).toHaveLength(1);
  });

  it('treats an unusable declared timezone as no timezone', async () => {
    const { stage } = makeStage(
      [row({ id: eventId(1), source_system: 'google_calendar', is_all_day: true })],
      { timezone: 'PST' },
    );

    const results = await stage.run(CTX, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'done',
      detail: { repairClass: 'floating_no_zone' },
    });
  });
});

/* ===================================================================== *
 * The undo — the property that makes this a correction, not a rewrite
 * ===================================================================== */

describe('the write preserves the original', () => {
  it('COALESCEs start_time_original so a later generation cannot destroy it', async () => {
    // THE safety property. Without the COALESCE a v2 repair would stamp v1's
    // already-repaired instant as "the original", and
    // `SET start_time = start_time_original` would restore a wrong date while
    // looking like it had restored the right one.
    const { stage, update } = makeStage([
      row({ id: eventId(1), source_system: 'google_calendar', is_all_day: true }),
    ]);

    await stage.run(CTX, [eventId(1)]);

    expect(update()?.sql).toMatch(/COALESCE\(e\.start_time_original, e\.start_time\)/);
    expect(update()?.sql).toMatch(/COALESCE\(e\.end_time_original, e\.end_time\)/);
  });

  it('only claims a row was corrected when it actually moved', async () => {
    // A label-only pass is the overwhelming majority. Marking those rows as
    // corrected would make the UI's "corrected" affordance meaningless.
    const { stage, update } = makeStage([row({ id: eventId(1) })]);

    await stage.run(CTX, [eventId(1)]);

    expect(update()?.sql).toMatch(/CASE WHEN u\.shift_ms <> 0/);
  });

  it('reports the shift it applied in the result detail', async () => {
    const { stage } = makeStage([
      row({ id: eventId(1), source_system: 'google_calendar', is_all_day: true }),
    ]);

    const results = await stage.run(CTX, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'done',
      detail: { repairClass: 'floating_local_reconstructed', shiftMs: 7 * 60 * 60 * 1000 },
    });
  });
});

/* ===================================================================== *
 * Selection: THE ONE RULE, and what the predicate must never mention
 * ===================================================================== */

interface SourceRow {
  id: string;
  user_id: string;
  is_deleted: boolean | null;
  /** The stage's OUTPUT. Nothing in selection may ever read this. */
  time_source: string | null;
  start_time_original: Date | null;
}

interface LedgerRow {
  stageVersion: number;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'quarantined';
  nextAttemptAt: Date | null;
}

function ledgerKey(entityType: string, entityId: string, stage: string): string {
  return `${entityType}|${entityId}|${stage}`;
}

/** `TEMPORAL_REPAIR_SOURCE.predicate`, mirrored — note what it does not consult. */
function isApplicable(candidate: SourceRow): boolean {
  return (candidate.is_deleted ?? false) === false;
}

function evaluateOneRule(
  rows: SourceRow[],
  ledger: Map<string, LedgerRow>,
  params: unknown[],
): Array<{ id: string }> {
  const [entityType, stageId, userId, version, cursor, limit] = params as [
    string,
    string,
    string,
    number,
    string | null,
    number,
  ];

  const now = Date.now();

  return rows
    .filter((candidate) => candidate.user_id === userId)
    .filter(isApplicable)
    .filter((candidate) => {
      const entry = ledger.get(ledgerKey(entityType, candidate.id, stageId));

      if (entry === undefined) {
        return true;
      }

      if (entry.stageVersion < version) {
        return true;
      }

      return entry.status === 'failed' && entry.nextAttemptAt != null && entry.nextAttemptAt.getTime() <= now;
    })
    .filter((candidate) => cursor == null || candidate.id > cursor)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .map((candidate) => ({ id: candidate.id }));
}

function makeLedgerHarness(rows: SourceRow[]) {
  const ledger = new Map<string, LedgerRow>();
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

    if (/not\s+exists[\s\S]*ci\.pipeline_state/i.test(sql)) {
      sweeps.push({ sql, params: params ?? [] });

      return evaluateOneRule(rows, ledger, params ?? []);
    }

    return [];
  });

  return {
    service: new PipelineStateService({ query } as never, makeLogger() as never),
    sweeps,
    seed: (entityId: string, entry: LedgerRow) =>
      ledger.set(ledgerKey(ENTITY_TYPE, entityId, CLEAN_TEMPORAL_REPAIR_STAGE_ID), entry),
  };
}

function sourceRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: eventId(n),
    user_id: USER,
    is_deleted: false,
    time_source: null,
    start_time_original: null,
    ...overrides,
  };
}

describe('candidate selection asks the ledger, never the output column', () => {
  const stage = new TemporalRepairStage({ query: jest.fn() } as never, makeLogger() as never);

  it('does not mention any column this stage writes', () => {
    // The predicate that FINDS work must not be the predicate that DECLARES it
    // done. `time_source IS NULL` here would freeze the first — worst — repair
    // forever, and a row labelled `ambiguous` is exactly the row a better rule
    // must be able to revisit.
    const predicate = TEMPORAL_REPAIR_SOURCE.predicate ?? '';

    for (const column of ['time_source', 'time_precision', 'start_time_original', 'end_time_original']) {
      expect(predicate).not.toContain(column);
    }
  });

  it('does not reach into the ledger from the predicate', () => {
    // The mirror-image rule, which StageRegistry also enforces.
    const predicate = TEMPORAL_REPAIR_SOURCE.predicate ?? '';

    expect(predicate).not.toMatch(/pipeline_state|\bp\./);
  });

  it('re-selects a row that is already fully repaired when the version rises', async () => {
    // THE REASON THE REBUILD EXISTS, at this stage: a row that already has a
    // `time_source` and a `start_time_original` — i.e. one this stage has
    // already moved — comes back when the classification rule improves.
    const rows = [sourceRow(1, { time_source: 'repaired', start_time_original: new Date() })];
    const harness = makeLedgerHarness(rows);

    harness.seed(eventId(1), {
      stageVersion: TEMPORAL_REPAIR_VERSION,
      status: 'done',
      nextAttemptAt: null,
    });

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([]);

    const bumped = { ...stage, version: TEMPORAL_REPAIR_VERSION + 1 } as typeof stage;

    await expect(harness.service.selectStale(bumped, USER, null, 10)).resolves.toEqual([eventId(1)]);
  });

  it('re-opens a skip, which a nullability predicate never could', async () => {
    // 321,169 rows recorded `skipped: source_time_spec_missing`. Adding one line
    // to SOURCE_TIME_SPECS and bumping the generation re-examines all of them.
    const harness = makeLedgerHarness([sourceRow(1)]);

    harness.seed(eventId(1), {
      stageVersion: TEMPORAL_REPAIR_VERSION,
      status: 'skipped',
      nextAttemptAt: null,
    });

    const bumped = { ...stage, version: TEMPORAL_REPAIR_VERSION + 1 } as typeof stage;

    await expect(harness.service.selectStale(bumped, USER, null, 10)).resolves.toEqual([eventId(1)]);
  });

  it('excludes a soft-deleted event', async () => {
    const harness = makeLedgerHarness([sourceRow(1, { is_deleted: true }), sourceRow(2)]);

    await expect(harness.service.selectStale(stage, USER, null, 10)).resolves.toEqual([eventId(2)]);
  });

  it('uses the anti-join form the sweep is pinned to', async () => {
    // NOT EXISTS, not LEFT JOIN: measured at 7,803 blocks against 35,488 on this
    // corpus, and the LEFT JOIN degrades the keyset bound from an index
    // condition to a filter.
    const harness = makeLedgerHarness([sourceRow(1)]);

    await harness.service.selectStale(stage, USER, null, 10);

    expect(harness.sweeps[0].sql).toMatch(/NOT EXISTS/i);
    expect(harness.sweeps[0].sql).not.toMatch(/LEFT JOIN/i);
  });
});
