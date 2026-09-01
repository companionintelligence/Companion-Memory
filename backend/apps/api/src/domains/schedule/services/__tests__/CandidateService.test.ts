import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Not } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { CalendarEventService } from '@ci/domains/memory';

import { EventCandidateEntity } from '../../entities/EventCandidateEntity';
import { CandidateService } from '../CandidateService';

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
    getMany: jest.fn(async () => many),
    calls,
  };

  return qb;
}

const ctx = { userId: 'user-1' } as UserServiceContext;

function baseCandidate(overrides: Partial<EventCandidateEntity> = {}): EventCandidateEntity {
  return {
    id: 'cand-1',
    userId: 'user-1',
    title: 'Strength session',
    description: null,
    rationale: 'Shoulder rehab shows up in 4 notes since June.',
    rationaleSources: [{ kind: 'summary', id: 'sum-1' }],
    windowStart: new Date('2026-08-03T00:00:00Z'),
    windowEnd: new Date('2026-08-10T00:00:00Z'),
    timeFlex: 'week',
    durationMinutes: 60,
    constraints: {},
    l0Class: 'EXERCISE',
    l1ClusterId: null,
    energyCost: 6,
    fitScore: 0.8,
    fitCurve: null,
    status: 'open',
    feedbackReason: null,
    feedbackAt: null,
    snoozedUntil: null,
    promotedEventId: null,
    dedupeKey: 'strength-session',
    generator: 'proposer/v1',
    confidence: 0.7,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as EventCandidateEntity;
}

describe('CandidateService', () => {
  let service: CandidateService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let events: { create: jest.Mock; remove: jest.Mock };
  let qb: ReturnType<typeof makeQueryBuilder>;

  async function setup(many: unknown[] = []) {
    qb = makeQueryBuilder(many);
    repo = {
      findOne: jest.fn(),
      find: jest.fn(async () => []),
      save: jest.fn(async (entity: EventCandidateEntity) => entity),
      create: jest.fn((entity: EventCandidateEntity) => entity),
      // The conditional claim in accept() — one row moved off 'open' by default.
      update: jest.fn(async () => ({ affected: 1 })),
      // The raw INSERT ... ON CONFLICT in upsert() returns the id it wrote.
      query: jest.fn(async () => [{ candidate_id: 'cand-1' }]),
    };
    events = { create: jest.fn(async () => [{ id: 'event-9' }]), remove: jest.fn(async () => true) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CandidateService,
        { provide: getRepositoryToken(EventCandidateEntity), useValue: repo },
        { provide: CalendarEventService, useValue: events },
        {
          provide: DataSource,
          useValue: { getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => qb) })) },
        },
        { provide: LoggerService, useValue: { setContext: jest.fn(), log: jest.fn(), debug: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(CandidateService);
  }

  describe('findInRange', () => {
    const from = new Date('2026-08-03T00:00:00Z');
    const to = new Date('2026-08-10T00:00:00Z');

    it('surfaces open candidates and snoozed ones whose deferral has elapsed', async () => {
      await setup();

      await service.findInRange(ctx, from, to);

      const clause = (qb.calls.andWhere ?? [])
        .map(([c]) => String(c))
        .find((c) => c.includes("status = 'open'"));

      expect(clause).toContain("candidate.status = 'snoozed' AND candidate.snoozed_until <= NOW()");
    });

    it('does not surface declined or accepted candidates', async () => {
      await setup();

      await service.findInRange(ctx, from, to);

      const clauses = (qb.calls.andWhere ?? []).map(([c]) => String(c)).join(' ');
      expect(clauses).not.toContain('declined');
      expect(clauses).not.toContain('accepted');
    });

    it('ranks by fit score, best first', async () => {
      await setup();

      await service.findInRange(ctx, from, to);

      expect(qb.calls.orderBy?.[0]).toEqual(['candidate.fit_score', 'DESC', 'NULLS LAST']);
    });

    it('breaks ties newest-first so a task just added lands at the front', async () => {
      await setup();

      await service.findInRange(ctx, from, to);

      expect(qb.calls.addOrderBy?.[0]).toEqual(['candidate.created_at', 'DESC']);
      // Deterministic final tiebreak — two rows can share a created_at.
      expect(qb.calls.addOrderBy?.[1]).toEqual(['candidate.candidate_id', 'DESC']);
    });

    it('puts what the user typed ahead of what the machine proposed', async () => {
      await setup([
        baseCandidate({ id: 'sugg-1', generator: 'adapter/action' }),
        baseCandidate({ id: 'typed-1', generator: 'braindump/llm' }),
        baseCandidate({ id: 'sugg-2', generator: 'adapter/insight' }),
        baseCandidate({ id: 'typed-2', generator: 'braindump/llm' }),
      ]);

      const found = await service.findInRange(ctx, from, to);

      expect(found.map((c) => c.id)).toEqual(['typed-1', 'typed-2', 'sugg-1', 'sugg-2']);
    });

    it('leaves the query order untouched when nothing was user-authored', async () => {
      await setup([
        baseCandidate({ id: 'sugg-1', generator: 'adapter/action' }),
        baseCandidate({ id: 'sugg-2', generator: null }),
      ]);

      const found = await service.findInRange(ctx, from, to);

      expect(found.map((c) => c.id)).toEqual(['sugg-1', 'sugg-2']);
    });
  });

  describe('returnToSlate', () => {
    it('deletes the event it minted and reopens the candidate', async () => {
      await setup();
      repo.findOne.mockResolvedValue(
        baseCandidate({
          id: 'cand-9',
          status: 'accepted',
          promotedEventId: 'event-9',
          feedbackReason: 'not_now',
          feedbackAt: new Date('2026-08-01T00:00:00Z'),
          windowEnd: new Date('2099-01-01T00:00:00Z'),
        }),
      );

      const returned = await service.returnToSlate(ctx, 'event-9');

      expect(events.remove).toHaveBeenCalledWith(ctx, 'event-9');
      expect(returned.status).toBe('open');
      expect(returned.promotedEventId).toBeNull();
      expect(returned.feedbackReason).toBeNull();
      expect(returned.feedbackAt).toBeNull();
    });

    it('clears the candidate before deleting the event, never after', async () => {
      // Ordering is the whole bug, so this asserts the sequence rather than the
      // end state. promoted_event_id is ON DELETE SET NULL: deleting first makes
      // Postgres resolve that referential action against a row still claiming
      // 'accepted', which is a state no view surfaces and no path can return —
      // and which the promotion-consistency check used to reject outright,
      // aborting the DELETE and making the event permanently undeletable.
      await setup();
      const candidate = baseCandidate({
        id: 'cand-9',
        status: 'accepted',
        promotedEventId: 'event-9',
        windowEnd: new Date('2099-01-01T00:00:00Z'),
      });
      repo.findOne.mockResolvedValue(candidate);

      let statusAtDelete: string | undefined;
      let backlinkAtDelete: string | null | undefined;
      events.remove.mockImplementation(async () => {
        statusAtDelete = candidate.status;
        backlinkAtDelete = candidate.promotedEventId;

        return true;
      });

      await service.returnToSlate(ctx, 'event-9');

      expect(repo.save).toHaveBeenCalled();
      expect(repo.save.mock.invocationCallOrder[0]).toBeLessThan(events.remove.mock.invocationCallOrder[0]);
      expect(statusAtDelete).toBe('open');
      expect(backlinkAtDelete).toBeNull();
    });

    it('refuses an event that did not come from a suggestion', async () => {
      // A mirrored calendar row has no candidate behind it. Un-committing it
      // here would either lie about the source or destroy it.
      await setup();
      repo.findOne.mockResolvedValue(null);

      await expect(service.returnToSlate(ctx, 'event-from-google')).rejects.toThrow(NotFoundException);
      expect(events.remove).not.toHaveBeenCalled();
    });

    it('gives a candidate whose window has closed a fresh one', async () => {
      // Otherwise it returns invisible: findInRange only surfaces windows that
      // overlap the view.
      await setup();
      repo.findOne.mockResolvedValue(
        baseCandidate({
          status: 'accepted',
          promotedEventId: 'event-9',
          windowStart: new Date('2020-01-01T00:00:00Z'),
          windowEnd: new Date('2020-01-08T00:00:00Z'),
        }),
      );

      const returned = await service.returnToSlate(ctx, 'event-9');

      expect(new Date(returned.windowEnd).getTime()).toBeGreaterThan(Date.now());
    });

    it('leaves a still-open window alone', async () => {
      // It may carry real meaning — "before Friday" is not ours to overwrite.
      await setup();
      const windowEnd = new Date('2099-01-01T00:00:00Z');
      repo.findOne.mockResolvedValue(
        baseCandidate({ status: 'accepted', promotedEventId: 'event-9', windowEnd }),
      );

      const returned = await service.returnToSlate(ctx, 'event-9');

      expect(new Date(returned.windowEnd).getTime()).toBe(windowEnd.getTime());
    });
  });

  describe('upsert', () => {
    const proposal = (overrides: Record<string, unknown> = {}) => ({
      title: 'Strength session',
      rationale: 'Updated reasoning.',
      window_start: new Date('2026-08-03T00:00:00Z'),
      window_end: new Date('2026-08-10T00:00:00Z'),
      dedupe_key: 'strength-session',
      ...overrides,
    });

    it('refreshes an existing open candidate rather than duplicating it', async () => {
      await setup();
      repo.query.mockResolvedValue([{ candidate_id: 'existing-1' }]);
      repo.find.mockResolvedValue([baseCandidate({ id: 'existing-1', rationale: 'Updated reasoning.' })]);

      const [result] = await service.upsert(ctx, [proposal()]);

      expect(result.id).toBe('existing-1');
      expect(result.rationale).toBe('Updated reasoning.');
    });

    it('writes atomically, so two tabs syncing at once cannot both insert', async () => {
      // A findOne-then-save pair races event_candidates_dedupe_uniq: both
      // callers see no row, both insert, and the loser raises an unhandled
      // 23505. The conflict clause is what makes the second caller an update.
      await setup();

      await service.upsert(ctx, [proposal()]);

      const [sql] = repo.query.mock.calls[0];
      expect(String(sql)).toContain('ON CONFLICT (user_id, dedupe_key) DO UPDATE');
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('carries the do-not-resurrect rule into the conflict clause', async () => {
      // Suppression cannot live in a prior read — by the time the write lands,
      // another writer may have moved the row. Only 'open' rows get refreshed.
      await setup();

      await service.upsert(ctx, [proposal()]);

      const [sql] = repo.query.mock.calls[0];
      expect(String(sql)).toContain("WHERE candidate.status = 'open'");
    });

    it('refuses to resurrect a candidate the user already declined', async () => {
      // The conflict clause matched a non-open row, so nothing was updated and
      // nothing came back.
      await setup();
      repo.query.mockResolvedValue([]);

      const result = await service.upsert(ctx, [proposal({ rationale: 'Trying again.' })]);

      expect(result).toHaveLength(0);
      expect(repo.find).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    const start = new Date('2026-08-06T18:00:00Z');

    it('mints a committed event and links it back to the candidate', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());

      const { candidate, event } = await service.accept(ctx, 'cand-1', start);

      expect(events.create).toHaveBeenCalledTimes(1);
      expect(candidate.status).toBe('accepted');
      expect(candidate.promotedEventId).toBe('event-9');
      // The minted event comes back with the candidate so the caller need not
      // re-query to render what was just placed.
      expect(event.id).toBe('event-9');
    });

    it('writes the event as committed fact, not as a prediction', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());

      await service.accept(ctx, 'cand-1', start);

      const [, dto] = events.create.mock.calls[0];
      expect(dto.is_predicted).toBe(false);
      expect(dto.status).toBe('confirmed');
    });

    it('carries provenance onto the event so the trail survives promotion', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());

      await service.accept(ctx, 'cand-1', start);

      const [, dto] = events.create.mock.calls[0];
      expect(dto.inference_sources).toMatchObject({
        candidate_id: 'cand-1',
        rationale: 'Shoulder rehab shows up in 4 notes since June.',
      });
    });

    it('derives the end time from the estimated duration when none is given', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate({ durationMinutes: 90 }));

      await service.accept(ctx, 'cand-1', start);

      const [, dto] = events.create.mock.calls[0];
      expect(dto.end_time).toEqual(new Date('2026-08-06T19:30:00Z'));
    });

    it('honours an explicit end time over the estimate', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate({ durationMinutes: 90 }));
      const end = new Date('2026-08-06T18:45:00Z');

      await service.accept(ctx, 'cand-1', start, end);

      const [, dto] = events.create.mock.calls[0];
      expect(dto.end_time).toBe(end);
    });

    it('rejects a double-accept instead of minting a second event', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate({ status: 'accepted', promotedEventId: 'event-1' }));

      await expect(service.accept(ctx, 'cand-1', start)).rejects.toThrow(BadRequestException);
      expect(events.create).not.toHaveBeenCalled();
    });

    it('claims the candidate with a conditional write, not a blind save', async () => {
      // The in-memory status check above cannot stop a double-click: both
      // requests read 'open' before either writes. Only the database can.
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());

      await service.accept(ctx, 'cand-1', start);

      const [criteria, values] = repo.update.mock.calls[0];
      expect(criteria).toMatchObject({ id: 'cand-1', userId: 'user-1' });
      expect(criteria.status).toEqual(Not('accepted'));
      expect(values).toMatchObject({ status: 'accepted', promotedEventId: 'event-9' });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('loses a concurrent accept cleanly and takes its orphan event back out', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());
      repo.update.mockResolvedValue({ affected: 0 }); // another accept got there first

      await expect(service.accept(ctx, 'cand-1', start)).rejects.toThrow(BadRequestException);
      // Otherwise a real calendar row survives with no candidate pointing at it,
      // which returnToSlate can never find.
      expect(events.remove).toHaveBeenCalledWith(ctx, 'event-9');
    });

    it('throws when the candidate does not belong to the viewer', async () => {
      await setup();
      repo.findOne.mockResolvedValue(null);

      await expect(service.accept(ctx, 'cand-1', start)).rejects.toThrow(NotFoundException);
    });
  });

  describe('decline', () => {
    it('retires the idea permanently on "never"', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());

      const result = await service.decline(ctx, 'cand-1', 'never');

      expect(result.status).toBe('never');
      expect(result.feedbackReason).toBe('never');
    });

    it('defers a "wrong time" rejection so the card can resurface later', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());

      const result = await service.decline(ctx, 'cand-1', 'wrong_time');

      expect(result.status).toBe('snoozed');
      expect(result.feedbackReason).toBe('wrong_time');
      expect(result.snoozedUntil).toBeInstanceOf(Date);
      expect(result.snoozedUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    it('defers "not_now" the same way drag-to-dismiss expects', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());

      const result = await service.decline(ctx, 'cand-1', 'not_now');

      expect(result.status).toBe('snoozed');
      expect(result.feedbackReason).toBe('not_now');
    });

    it('refuses to decline something already accepted', async () => {
      // Moving it off 'accepted' while it still holds promoted_event_id trips
      // the promotion-consistency check and abandons the event it minted.
      // returnToSlate is the way back out. snooze() guards the same way.
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate({ status: 'accepted', promotedEventId: 'event-9' }));

      await expect(service.decline(ctx, 'cand-1', 'never')).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('snooze', () => {
    it('defers a candidate to a future instant', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());
      const until = new Date(Date.now() + 86_400_000);

      const result = await service.snooze(ctx, 'cand-1', until);

      expect(result.status).toBe('snoozed');
      expect(result.snoozedUntil).toBe(until);
    });

    it('rejects a snooze into the past, which would silently re-surface it', async () => {
      await setup();
      repo.findOne.mockResolvedValue(baseCandidate());

      await expect(service.snooze(ctx, 'cand-1', new Date(Date.now() - 1000))).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
