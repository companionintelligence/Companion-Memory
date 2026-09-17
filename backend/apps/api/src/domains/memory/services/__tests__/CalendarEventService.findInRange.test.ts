import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { clearExpansionZoneCache } from '../../recurrence/queries';
import {
  CalendarEventService,
  DEAD_EVENT_STATUSES,
  LIVE_EVENT_SQL,
  MAX_RECURRING_MASTERS,
} from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

/** Chainable query-builder mock recording every clause, returning `many` from getMany. */
function makeQueryBuilder(many: unknown[]) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => {
    calls[name] ??= [];

    return (...args: unknown[]) => {
      calls[name].push(args);

      return qb;
    };
  };

  const qb = {
    where: record('where'),
    andWhere: record('andWhere'),
    orderBy: record('orderBy'),
    addOrderBy: record('addOrderBy'),
    take: record('take'),
    getMany: jest.fn(async () => many),
    calls,
  };

  return qb;
}

describe('CalendarEventService.findInRange — the calendar read path', () => {
  let service: CalendarEventService;
  /** The MAIN window query's builder. */
  let qb: ReturnType<typeof makeQueryBuilder>;
  /** The RECURRING-MASTERS leg's builder — a distinct one, see the note in `setup`. */
  let recurringQb: ReturnType<typeof makeQueryBuilder>;
  let overrideRows: { sourceId: string }[];

  const ctx = { userId: 'user-1' } as ServiceContext;
  const from = new Date('2026-08-03T00:00:00Z');
  const to = new Date('2026-08-10T00:00:00Z');

  beforeEach(() => {
    // The zone cache is module-level and would otherwise carry one test's
    // fixture user into the next suite's.
    clearExpansionZoneCache();
    overrideRows = [];
  });

  function setup(many: unknown[] = [], bases: unknown[] = [], masters: unknown[] = []) {
    qb = makeQueryBuilder(many);
    recurringQb = makeQueryBuilder(masters);

    // ═══ ONE BUILDER PER createQueryBuilder CALL, IN ORDER ═══
    // This used to hand the SAME `qb` back every time, which made the two legs
    // of findInRange indistinguishable: the recurring leg replayed the window
    // query's clauses and its fixture rows, so a test could assert a predicate
    // was present while the leg that actually needed it had none.
    const builders = [qb, recurringQb];
    let call = 0;
    const dataSource = {
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => builders[Math.min(call++, builders.length - 1)]),
      })),
    };

    // Title/description live on the ci.entities base row, which the service
    // fetches in one batch to compose the egress events.
    const baseRepository = { find: jest.fn(async () => bases) };

    // Reached only once a master is actually expanded: the override-suppression
    // read, and the users lookup behind the fallback zone.
    const eventRepository = {
      find: jest.fn(async () => overrideRows),
      manager: { getRepository: jest.fn(() => ({ findOne: jest.fn(async () => null) })) },
    };

    return Test.createTestingModule({
      providers: [
        CalendarEventService,
        { provide: getRepositoryToken(EventEntity), useValue: eventRepository },
        { provide: getRepositoryToken(EventBaseEntity), useValue: baseRepository },
        { provide: EventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    })
      .compile()
      .then((moduleRef) => {
        service = moduleRef.get(CalendarEventService);
      });
  }

  const clauses = () => (qb.calls.andWhere ?? []).map(([clause]) => String(clause));
  const clauseWith = (needle: string) => clauses().find((clause) => clause.includes(needle));
  const recurringClauses = () => (recurringQb.calls.andWhere ?? []).map(([clause]) => String(clause));
  const recurringClauseWith = (needle: string) =>
    recurringClauses().find((clause) => clause.includes(needle));

  it('filters on interval overlap, not "starts within the window"', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    // An event that began before `from` but runs into the window must survive —
    // COALESCE treats a null end_time as an instant at start_time.
    expect(clauseWith('COALESCE(event.end_time, event.start_time) >= :from')).toBeDefined();
    expect(clauseWith('event.start_time < :to')).toBeDefined();

    // The search path's "must also END in-window" predicate must NOT appear.
    expect(clauseWith('event.end_time <= :to')).toBeUndefined();
  });

  it('binds the window as given', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    const params = (qb.calls.andWhere ?? []).map(([, bind]) => bind);
    expect(params).toContainEqual({ to });
    expect(params).toContainEqual({ from });
  });

  it('floors start_time so the index range is bounded on both sides', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    // COALESCE(end_time, start_time) is an expression no index covers, so
    // without this floor the only usable index — (user_id, start_time DESC) —
    // has nothing to stop at and the scan walks the user's whole history.
    expect(clauseWith('event.start_time >= :lowerBound')).toBeDefined();
  });

  it('sets the floor a bounded lookback before the window, not at its start', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    const bind = (qb.calls.andWhere ?? [])
      .map(([, params]) => params as { lowerBound?: Date } | undefined)
      .find((params) => params?.lowerBound);

    // A flight that took off before `from` and lands inside the window must
    // still be returned, so the floor sits a quarter behind `from` — flooring
    // at `from` itself would silently drop every in-progress event.
    expect(bind?.lowerBound).toEqual(new Date('2026-05-03T00:00:00Z'));
    expect(bind?.lowerBound?.getTime()).toBeLessThan(from.getTime());
  });

  it('caps the number of rows one range read can return', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    // MAX_RANGE_DAYS bounds the span a caller may ask for but not the row
    // count; a quarter over a photo-heavy library is six figures of nodes.
    const [take] = qb.calls.take?.[0] ?? [];
    expect(typeof take).toBe('number');
    expect(take).toBe(2000);
  });

  it('excludes every "did not happen" status but keeps tentative', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    const status = clauseWith('event.status');
    // One vocabulary, shared with the planner: this clause and the planned-block
    // reads used to carry separate literals and drifted apart over `skipped`, so
    // a skipped block was invisible to every read while still occupying its slot
    // in the gap solver. Assert through the constant, not a copy of it.
    for (const dead of DEAD_EVENT_STATUSES) {
      expect(status).toContain(`'${dead}'`);
    }

    // A maybe on the calendar is still a claim on the slot.
    expect(status).not.toContain('tentative');
  });

  it('treats a NULL status as confirmed rather than filtering the row away', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    // `NOT IN` is three-valued: without the COALESCE a NULL-status row makes
    // the predicate NULL, so the event exists, is returned by every other read,
    // and is missing from the calendar with nothing to explain why.
    // 20260908000139 has since made the column NOT NULL, but the COALESCE stays
    // — it is what keeps this read correct against a database that has not
    // taken that migration yet.
    expect(clauseWith('event.status')).toBe(LIVE_EVENT_SQL);
  });

  it('excludes soft-deleted rows', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    expect((qb.calls.where ?? [])[0]?.[0]).toBe('event.is_deleted = false');
  });

  it('allowlists calendar event types', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    expect(clauseWith('event.event_type IN (:...scheduleEventTypes)')).toBeDefined();

    const params = (qb.calls.andWhere ?? []).map(([, bind]) => bind);
    expect(params).toContainEqual({
      scheduleEventTypes: ['calendar_event', 'meeting', 'appointment', 'planned_block'],
    });
  });

  it('keeps events with no event_type — user-created and accepted schedule candidates', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    expect(clauseWith('event.event_type IS NULL')).toBeDefined();
  });

  it('scopes to the viewer', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    const params = (qb.calls.andWhere ?? []).map(([, bind]) => bind);
    expect(params).toContainEqual({ userId: 'user-1' });
  });

  it('does not scope when acting as the system user', async () => {
    await setup();

    await service.findInRange({ userId: SYSTEM_USER } as ServiceContext, from, to);

    expect(clauseWith('event.user_id = :userId')).toBeUndefined();
  });

  it('orders chronologically with a deterministic tiebreak', async () => {
    await setup();

    await service.findInRange(ctx, from, to);

    expect(qb.calls.orderBy?.[0]).toEqual(['event.start_time', 'ASC']);
    expect(qb.calls.addOrderBy?.[0]).toEqual(['event.event_id', 'ASC']);
  });

  it('maps rows through the egress type', async () => {
    await setup(
      [{ id: 'e1', startTime: from, endTime: null }],
      [{ id: 'e1', name: 'Standup', description: null }],
    );

    const result = await service.findInRange(ctx, from, to);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'e1', title: 'Standup' });
  });

  describe('the recurring-masters leg', () => {
    /** A weekly 09:00 Pacific standup whose DTSTART is well before the window. */
    const master = (over: Record<string, unknown> = {}) => ({
      id: '0198f0a0-0000-7000-8000-000000000001',
      startTime: new Date('2026-06-01T16:00:00Z'),
      endTime: new Date('2026-06-01T16:30:00Z'),
      isAllDay: false,
      isRecurring: true,
      metadata: {
        recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        recurrenceTimeZone: 'America/Los_Angeles',
      },
      recurrencePattern: null,
      sourceSystem: 'calendar',
      sourceId: 'standup@google.com',
      ...over,
    });

    it('carries NO lookback floor', async () => {
      await setup();

      await service.findInRange(ctx, from, to);

      // The floor is what makes the MAIN query sargable, and it is exactly what
      // must not be here: a weekly standup anchored in 2023 is the row whose
      // occurrences are missing, and a quarter-deep floor would skip it.
      expect(recurringClauseWith(':lowerBound')).toBeUndefined();
      expect(recurringClauseWith('event.start_time < :to')).toBeDefined();
    });

    it('repeats the window query liveness and event-type predicates', async () => {
      await setup();

      await service.findInRange(ctx, from, to);

      // An occurrence must never appear under rules its own master would have
      // been hidden by.
      expect((recurringQb.calls.where ?? [])[0]?.[0]).toBe('event.is_deleted = false');
      expect(recurringClauseWith('event.status')).toBe(LIVE_EVENT_SQL);
      expect(recurringClauseWith('event.is_recurring = true')).toBeDefined();
      expect(recurringClauseWith('event.event_type IN (:...scheduleEventTypes)')).toBeDefined();
      expect(recurringClauseWith('event.user_id = :userId')).toBeDefined();
      expect(recurringQb.calls.take?.[0]?.[0]).toBe(MAX_RECURRING_MASTERS);
    });

    it('is not issued at all for the system user', async () => {
      await setup();

      await service.findInRange({ userId: SYSTEM_USER } as ServiceContext, from, to);

      // Both halves of expansion are per-user — the fallback zone and override
      // suppression — so the cross-user read stays master-only rather than
      // guessing a zone or leaking one user's overrides into another's grid.
      expect(recurringQb.getMany).not.toHaveBeenCalled();
    });

    it('materializes the occurrences a series puts in the window', async () => {
      await setup(
        [],
        [{ id: '0198f0a0-0000-7000-8000-000000000001', name: 'Standup', description: null }],
        [master()],
      );

      const result = await service.findInRange(ctx, from, to);

      // 2026-08-03 is the only Monday in [08-03, 08-10). The master's own
      // DTSTART is in June, outside the window, so nothing is duplicated.
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        title: 'Standup',
        seriesMasterId: '0198f0a0-0000-7000-8000-000000000001',
        recurrenceId: '20260803T160000Z',
        parentEventId: null,
      });
      expect(result[0].id).not.toBe('0198f0a0-0000-7000-8000-000000000001');
      expect(result[0].metadata).toMatchObject({ occurrence: { synthetic: true } });
    });

    it('drops an occurrence that already exists as its own override row', async () => {
      overrideRows = [{ sourceId: 'standup@google.com#20260803T160000Z' }];
      await setup(
        [],
        [{ id: '0198f0a0-0000-7000-8000-000000000001', name: 'Standup', description: null }],
        [master()],
      );

      expect(await service.findInRange(ctx, from, to)).toEqual([]);
    });

    it('does not re-compose a master the window query already returned', async () => {
      const row = master({
        startTime: new Date('2026-08-03T16:00:00Z'),
        endTime: new Date('2026-08-03T16:30:00Z'),
      });
      await setup([row], [{ id: row.id, name: 'Standup', description: null }], [row]);

      const result = await service.findInRange(ctx, from, to);

      // The master IS its DTSTART occurrence; expanding must not add a second
      // chip for the same meeting.
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(row.id);
    });

    it('merges deduped by id, ordered by start, and capped at MAX_RANGE_EVENTS', async () => {
      const rows = Array.from({ length: 2000 }, (_, index) => ({
        id: `e${String(index).padStart(4, '0')}`,
        startTime: new Date(from.getTime() + index * 1000),
        endTime: null,
      }));
      await setup(
        rows,
        rows.map((row) => ({ id: row.id, name: 'Photo', description: null })),
        [master()],
      );

      const result = await service.findInRange(ctx, from, to);

      // Occurrences are appended to a window read that is ALREADY at the cap;
      // the merge must not hand the resolver 2001 nodes.
      expect(result).toHaveLength(2000);
      expect(new Set(result.map((event) => event.id)).size).toBe(2000);

      for (let index = 1; index < result.length; index += 1) {
        expect(result[index].startTime.getTime()).toBeGreaterThanOrEqual(
          result[index - 1].startTime.getTime(),
        );
      }
    });
  });
});
