import type { UserServiceContext } from '@ci/common/context';

import { CalendarEventService } from '../CalendarEventService';

const keysetPaginate = jest.fn();

jest.mock('@ci/common/persistence', () => ({
  ...jest.requireActual('@ci/common/persistence'),
  keysetPaginate: (...args: unknown[]) => keysetPaginate(...args),
}));

/**
 * `deleteEvent` is a soft delete and `restoreEvent` reverses it — but until
 * `findDeletedPage` existed the reversal was nominal. Every other read path in
 * this service filters `is_deleted = false`, so the sole handle on a deleted
 * event was the id echoed once in the delete payload. A caller that discarded
 * that response had destroyed the event in every way it could observe, while
 * the operation's label advertised it as reversible.
 *
 * These tests pin the two halves of that contract: the trash shows exactly what
 * the timeline hides, and the timeline still hides it.
 */
describe('CalendarEventService deleted-event discovery', () => {
  const context = { userId: 'user-1' } as UserServiceContext;

  /** Capture the `scope` callback and record the predicates it applies. */
  const predicatesFor = async (run: () => Promise<unknown>): Promise<string[]> => {
    const applied: string[] = [];
    const qb = {
      andWhere: (clause: string) => {
        applied.push(clause);

        return qb;
      },
    };

    keysetPaginate.mockImplementation(
      async (
        _repo: unknown,
        _args: unknown,
        options: {
          scope: (builder: typeof qb) => unknown;
        },
      ) => {
        options.scope(qb);

        return { entities: [], hasNextPage: false, hasPreviousPage: false, totalCount: 0 };
      },
    );

    await run();

    return applied;
  };

  const service = Object.create(CalendarEventService.prototype) as CalendarEventService;

  beforeEach(() => {
    keysetPaginate.mockReset();
    // composeMany hydrates the CTI base rows; an empty page needs nothing from it.
    (service as unknown as { composeMany: unknown }).composeMany = async () => [];
    (service as unknown as { eventRepository: unknown }).eventRepository = {};
  });

  it('findDeletedPage returns ONLY tombstones', async () => {
    const applied = await predicatesFor(() =>
      service.findDeletedPage(context, { first: 20, last: null, afterId: null, beforeId: null }),
    );

    expect(applied).toContain('event.is_deleted = true');
    expect(applied).not.toContain('event.is_deleted = false');
  });

  it('findPage still hides them — the trash must not leak into the timeline', async () => {
    const applied = await predicatesFor(() =>
      service.findPage(context, { first: 20, last: null, afterId: null, beforeId: null }),
    );

    expect(applied).toContain('event.is_deleted = false');
    expect(applied).not.toContain('event.is_deleted = true');
  });

  it('both pages agree on what an event is', async () => {
    // The planned_block exclusion is repeated rather than shared, and if the two
    // drifted, the trash would advertise rows the timeline never had — or hide
    // rows it did. Same reasoning as findPage's own note about totalCount.
    const plannedBlock = "(event.event_type IS NULL OR event.event_type <> 'planned_block')";

    const deleted = await predicatesFor(() =>
      service.findDeletedPage(context, { first: 20, last: null, afterId: null, beforeId: null }),
    );
    const live = await predicatesFor(() =>
      service.findPage(context, { first: 20, last: null, afterId: null, beforeId: null }),
    );

    expect(deleted).toContain(plannedBlock);
    expect(live).toContain(plannedBlock);
  });

  it('scopes to the caller — a tombstone is not a way around user isolation', async () => {
    keysetPaginate.mockResolvedValue({
      entities: [],
      hasNextPage: false,
      hasPreviousPage: false,
      totalCount: 0,
    });

    await service.findDeletedPage(context, { first: 20, last: null, afterId: null, beforeId: null });

    expect(keysetPaginate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: 'user-1' }),
    );
  });
});
