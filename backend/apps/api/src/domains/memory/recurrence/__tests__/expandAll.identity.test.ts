import type { Repository } from 'typeorm';

import type { EventEntity } from '../../entities/EventEntity';
import { expandAll } from '../expandAll';
import { occurrenceEventId, seriesUidOf } from '../occurrenceIdentity';
import type { RecurringSeriesRow } from '../parseRecurrence';
import { dropExistingOverrides } from '../queries';
import type { ExpansionDiagnostic } from '../types';

const PACIFIC = 'America/Los_Angeles';
const MASTER_ID = '0198f0a0-0000-7000-8000-000000000001';

function master(over: Partial<RecurringSeriesRow> = {}): RecurringSeriesRow {
  return {
    id: MASTER_ID,
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

const WINDOW = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };
const OPTS = { fallbackTimeZone: 'UTC' as const };

describe('expandAll — identity and suppression', () => {
  it('does not duplicate the DTSTART occurrence, which the master row already is', () => {
    const specs = expandAll([master()], WINDOW, OPTS);

    expect(specs.map((spec) => spec.startTime.toISOString())).toEqual([
      '2026-09-14T16:00:00.000Z',
      '2026-09-21T16:00:00.000Z',
      '2026-09-28T16:00:00.000Z',
    ]);
  });

  it('keys every occurrence by the source_id a real override would carry', () => {
    const [first] = expandAll([master()], WINDOW, OPTS);

    expect(first.recurrenceInstant).toBe('20260914T160000Z');
    expect(first.overrideSourceId).toBe('standup@google.com#20260914T160000Z');
    expect(first.seriesId).toBe(MASTER_ID);
    expect(first.endTime?.toISOString()).toBe('2026-09-14T16:30:00.000Z');
  });

  it('keys an ALL-DAY occurrence by date, the DATE-valued RECURRENCE-ID both pipelines store', () => {
    // TransformGoogleCalendar keys an all-day override from
    // `originalStartTime.date`; the .ics importer keeps `RECURRENCE-ID;VALUE=DATE`
    // as written. Spelled as an instant, the key matched neither, and a
    // cancelled or moved all-day occurrence was synthesized right back.
    const [first] = expandAll(
      [
        master({
          startTime: new Date('2026-09-07T00:00:00Z'),
          endTime: new Date('2026-09-08T00:00:00Z'),
          isAllDay: true,
          sourceId: 'office-day@google.com',
        }),
      ],
      WINDOW,
      OPTS,
    );

    expect(first.startTime.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(first.overrideSourceId).toBe('office-day@google.com#20260914');
    // The synthetic id and the RECURRENCE-ID the client sees keep their
    // instant spelling: only the suppression key changes.
    expect(first.recurrenceInstant).toBe('20260914T000000Z');
    expect(first.occurrenceId).toBe(occurrenceEventId(MASTER_ID, '20260914T000000Z'));
  });

  it('mints a stable uuid so every uuid-typed consumer keeps working', () => {
    const [first] = expandAll([master()], WINDOW, OPTS);

    expect(first.occurrenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Neither `@` (which explodes in `ANY($1::uuid[])`) nor `:` (which
    // GlobalUID.decode truncates on) can appear.
    expect(first.occurrenceId).not.toMatch(/[@:]/);
    expect(first.occurrenceId).toBe(occurrenceEventId(MASTER_ID, '20260914T160000Z'));
  });

  it('is deterministic: the same window expanded twice yields identical ids', () => {
    expect(expandAll([master()], WINDOW, OPTS).map((spec) => spec.occurrenceId)).toEqual(
      expandAll([master()], WINDOW, OPTS).map((spec) => spec.occurrenceId),
    );
  });

  it('does not expand a master whose identity is platform-scoped', () => {
    const diagnostics: ExpansionDiagnostic[] = [];

    expect(
      expandAll([master({ sourceSystem: 'google_calendar', sourceId: 'evt-123' })], WINDOW, {
        ...OPTS,
        onDiagnostic: (d) => diagnostics.push(d),
      }),
    ).toEqual([]);
    expect(diagnostics).toEqual([{ kind: 'unfederated-identity', seriesId: MASTER_ID }]);
  });

  it('stops at maxTotalOccurrences so occurrences cannot crowd out real rows', () => {
    const diagnostics: ExpansionDiagnostic[] = [];
    const specs = expandAll(
      [master({ metadata: { recurrenceRule: ['RRULE:FREQ=DAILY'], recurrenceTimeZone: PACIFIC } })],
      WINDOW,
      { ...OPTS, limits: { maxTotalOccurrences: 5 }, onDiagnostic: (d) => diagnostics.push(d) },
    );

    expect(specs).toHaveLength(5);
    expect(diagnostics).toContainEqual({
      kind: 'truncated',
      seriesId: MASTER_ID,
      limit: 'maxTotalOccurrences',
    });
  });
});

describe('seriesUidOf', () => {
  it('keeps a master UID whole and strips an override suffix', () => {
    expect(seriesUidOf('standup@google.com')).toBe('standup@google.com');
    expect(seriesUidOf('standup@google.com#20260914T160000Z')).toBe('standup@google.com');
    expect(seriesUidOf(null)).toBeNull();
    expect(seriesUidOf('   ')).toBeNull();
  });
});

describe('dropExistingOverrides', () => {
  /**
   * A repository stub that answers the ONE query this function issues and
   * records the criteria, so the suppression rule can be asserted without a
   * database — including the part that is about which rows are NOT filtered out.
   */
  function repositoryReturning(rows: { sourceId: string }[]) {
    const find = jest.fn(async () => rows);

    return { repository: { find } as unknown as Repository<EventEntity>, find };
  }

  const specs = expandAll([master()], WINDOW, OPTS);

  it('drops an occurrence that already exists as its own row', async () => {
    const { repository } = repositoryReturning([{ sourceId: 'standup@google.com#20260921T160000Z' }]);

    expect(
      (await dropExistingOverrides(repository, 'user-1', specs)).map((spec) => spec.recurrenceInstant),
    ).toEqual(['20260914T160000Z', '20260928T160000Z']);
  });

  it('asks WITHOUT is_deleted or status filters, because those rows carry the signal', async () => {
    // A `status = 'cancelled'` override IS how "delete this occurrence only"
    // arrives, and a tombstone is how a deletion syncs. Filtering either out
    // resurrects every occurrence the user ever individually deleted — weekly,
    // forever, which is strictly worse than the bug this module fixes.
    const { repository, find } = repositoryReturning([]);

    await dropExistingOverrides(repository, 'user-1', specs);

    const [{ where, select }] = find.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; select: Record<string, unknown> },
    ];
    expect(where).not.toHaveProperty('isDeleted');
    expect(where).not.toHaveProperty('status');
    expect(where.userId).toBe('user-1');
    expect(where.sourceSystem).toBe('calendar');
    expect(select).toEqual({ id: true, sourceId: true });
  });

  it('issues no query at all when nothing was expanded', async () => {
    const { repository, find } = repositoryReturning([]);

    expect(await dropExistingOverrides(repository, 'user-1', [])).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
