import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MoreThan } from 'typeorm';

import { SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { CalendarEventService, EventEntity } from '@ci/domains/memory';

import { TaskEntity } from '../../entities/TaskEntity';
import { TaskPendingChangeEntity } from '../../entities/TaskPendingChangeEntity';
import { TaskCreatedEvent, TaskRemovedEvent, TaskUpdatedEvent } from '../../events';
import { TaskService } from '../TaskService';

const ALICE = { userId: 'alice-uuid' } as UserServiceContext;
const BOB = { userId: 'bob-uuid' } as UserServiceContext;

function makeTask(overrides: Partial<TaskEntity> = {}): TaskEntity {
  return {
    id: 'task-1',
    userId: ALICE.userId,
    title: 'Ship the thing',
    description: null,
    notes: null,
    status: 'open',
    priority: 3,
    parentId: null,
    dueAt: null,
    taskTime: null,
    scheduledFor: null,
    deferUntil: null,
    deferCount: 0,
    estimatedMinutes: null,
    actualMinutes: 0,
    completedAt: null,
    sourceKind: 'manual',
    sourceRef: null,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as TaskEntity;
}

/**
 * Chainable query-builder mock that records every call, mirroring the shape the
 * memory-domain service tests use.
 */
function makeQueryBuilder(rows: TaskEntity[]) {
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
    limit: record('limit'),
    getMany: jest.fn(async () => rows),
    calls,
  };

  return qb;
}

describe('TaskService', () => {
  let service: TaskService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let signalling: { send: jest.Mock };
  let qb: ReturnType<typeof makeQueryBuilder>;
  let pendingRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  /** `ci.events` rows for planned blocks — the delete path reads and tombstones these. */
  let blockRepo: { find: jest.Mock };
  let calendarEvents: { remove: jest.Mock };

  async function setup(rows: TaskEntity[] = [], blocks: Array<{ id: string }> = []) {
    qb = makeQueryBuilder(rows);
    repository = {
      create: jest.fn((data: Partial<TaskEntity>) => data as TaskEntity),
      save: jest.fn(async (entity: TaskEntity) => entity),
      find: jest.fn(async () => rows),
      findOne: jest.fn(async () => rows[0] ?? null),
      delete: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(() => qb),
    };
    signalling = { send: jest.fn(async () => undefined) };

    pendingRepo = {
      create: jest.fn((data: unknown) => data),
      save: jest.fn(async (entity: unknown) => entity),
      findOne: jest.fn(async () => null),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => []),
      })),
    };

    blockRepo = { find: jest.fn(async () => blocks) };
    calendarEvents = { remove: jest.fn(async () => true) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(TaskEntity), useValue: repository },
        { provide: getRepositoryToken(TaskPendingChangeEntity), useValue: pendingRepo },
        { provide: getRepositoryToken(EventEntity), useValue: blockRepo },
        { provide: EventService, useValue: signalling },
        { provide: CalendarEventService, useValue: calendarEvents },
        { provide: LoggerService, useValue: { setContext: jest.fn(), warn: jest.fn(), log: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(TaskService);
  }

  beforeEach(async () => {
    await setup();
  });

  // ---------------------------------------------------------------------------
  // Tenant scoping.
  //
  // This is the invariant most likely to be lost in a refactor: translating a
  // hand-written SQL statement to TypeORM is exactly when a `userId` predicate
  // gets dropped, and the failure is silent — reads succeed, they just return
  // someone else's rows. Every path is asserted, not a sample.
  // ---------------------------------------------------------------------------
  describe('tenant scoping', () => {
    it('scopes findById to the caller', async () => {
      await service.findById(ALICE, 'task-1');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1', userId: ALICE.userId },
      });
    });

    it('scopes findByIds to the caller', async () => {
      await service.findByIds(ALICE, ['task-1', 'task-2']);

      const [{ where }] = repository.find.mock.calls[0] as [{ where: { userId: string } }];

      expect(where.userId).toBe(ALICE.userId);
    });

    it('scopes findAll to the caller', async () => {
      await service.findAll(ALICE);

      expect(qb.calls.where[0]).toEqual(['task.user_id = :userId', { userId: ALICE.userId }]);
    });

    it('scopes remove to the caller', async () => {
      await service.remove(ALICE, 'task-1');

      expect(repository.delete).toHaveBeenCalledWith({ id: 'task-1', userId: ALICE.userId });
    });

    it.each(['update', 'complete', 'reopen', 'defer'] as const)('scopes %s to the caller', async (method) => {
      await setup([makeTask()]);

      // `update` takes a DTO, `defer` takes a date, the rest take nothing.
      const arg = method === 'update' ? {} : method === 'defer' ? '2026-02-01' : undefined;

      await (service[method] as (c: UserServiceContext, id: string, a?: unknown) => Promise<unknown>)(
        ALICE,
        'task-1',
        arg,
      );

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1', userId: ALICE.userId },
      });
    });

    it('stamps the creating user, ignoring any client-supplied owner', async () => {
      await service.create(ALICE, { title: 'Mine' } as never);

      const [created] = repository.create.mock.calls[0] as [Partial<TaskEntity>];

      expect(created.userId).toBe(ALICE.userId);
    });

    it("never returns another user's task", async () => {
      // The repository is the enforcement point: with Bob's id in the predicate,
      // Alice's row does not come back.
      await setup([]);

      expect(await service.findById(BOB, 'task-1')).toBeNull();
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1', userId: BOB.userId },
      });
    });

    it('does not widen the query for SYSTEM_USER', async () => {
      // Several CI-Server services spread `...(userId !== SYSTEM_USER && { userId })`,
      // which turns a system-context call into an unscoped read. Planning must
      // never do that — SYSTEM_USER is not a legitimate planning identity.
      await service.findById({ userId: SYSTEM_USER } as unknown as UserServiceContext, 'task-1');

      const [{ where }] = repository.findOne.mock.calls[0] as [{ where: Record<string, unknown> }];

      expect(where).toHaveProperty('userId');
      expect(where.userId).toBe(SYSTEM_USER);
    });
  });

  describe('create', () => {
    it('mints a uuidv7 id when none is supplied', async () => {
      await service.create(ALICE, { title: 'New' } as never);

      const [created] = repository.create.mock.calls[0] as [Partial<TaskEntity>];

      // v7: version nibble 7, variant 8..b. Time-ordering is load-bearing —
      // `ORDER BY id` must stay chronological.
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('honours a caller-supplied id (idempotent ingest)', async () => {
      await service.create(ALICE, { id: 'fixed-id', title: 'New' } as never);

      const [created] = repository.create.mock.calls[0] as [Partial<TaskEntity>];

      expect(created.id).toBe('fixed-id');
    });

    it('emits TaskCreatedEvent', async () => {
      await service.create(ALICE, { title: 'New' } as never);

      expect(signalling.send).toHaveBeenCalledWith(TaskCreatedEvent, {
        taskId: expect.any(String),
        userId: ALICE.userId,
      });
    });

    it("rejects a parentId that isn't one of the caller's own tasks", async () => {
      // parent_id's FK targets ci.tasks(id) with no user_id component, so
      // without this check the database would happily attach a task under
      // another tenant's row — and ON DELETE CASCADE would let that tenant
      // delete it later just by deleting their own task.
      await expect(
        service.create(ALICE, { title: 'Subtask', parentId: 'not-mine' } as never),
      ).rejects.toThrow(NotFoundException);

      expect(repository.create).not.toHaveBeenCalled();
    });

    it("creates when the parentId is one of the caller's own tasks", async () => {
      await setup([makeTask({ id: 'parent-1' })]);

      await service.create(ALICE, { title: 'Subtask', parentId: 'parent-1' } as never);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'parent-1', userId: ALICE.userId },
        // `parentId` too: the ancestor walk that refuses a cycle starts from it.
        select: { id: true, parentId: true },
      });

      const [created] = repository.create.mock.calls[0] as [Partial<TaskEntity>];

      expect(created.parentId).toBe('parent-1');
    });
  });

  describe('update', () => {
    it("rejects reparenting onto a task the caller doesn't own", async () => {
      await setup([makeTask()]);
      repository.findOne
        .mockResolvedValueOnce(makeTask()) // the task being updated
        .mockResolvedValueOnce(null); // parent ownership check

      await expect(service.update(ALICE, 'task-1', { parentId: 'not-mine' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('allows reparenting onto a task the caller owns', async () => {
      await setup([makeTask()]);
      repository.findOne
        .mockResolvedValueOnce(makeTask()) // the task being updated
        .mockResolvedValueOnce(makeTask({ id: 'parent-1' })); // parent ownership check

      const result = await service.update(ALICE, 'task-1', { parentId: 'parent-1' });

      expect(result?.parentId).toBe('parent-1');
    });

    // -------------------------------------------------------------------------
    // parentId cycles.
    //
    // `tasks_no_self_parent` rejects the one-hop edge and nothing else, so a
    // two-hop cycle was accepted by the database AND by the ownership check —
    // and the Plan board builds its columns from the tasks with no parent, so
    // both rows vanished from every column at once while the nav badge kept
    // counting them. TodoProcessService's `reparent` suggestion is the path
    // that produces one: it only guards `parent.id !== task.id`.
    // -------------------------------------------------------------------------
    it('refuses a parent that is a direct child of the task', async () => {
      await setup([makeTask()]);
      repository.findOne
        .mockResolvedValueOnce(makeTask()) // the task being updated: task-1
        .mockResolvedValueOnce(makeTask({ id: 'child-1', parentId: 'task-1' })); // the proposed parent

      await expect(service.update(ALICE, 'task-1', { parentId: 'child-1' })).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('refuses a parent further down the same subtree', async () => {
      await setup([makeTask()]);
      repository.findOne
        .mockResolvedValueOnce(makeTask()) // task-1
        .mockResolvedValueOnce(makeTask({ id: 'grandchild-1', parentId: 'child-1' })) // proposed parent
        .mockResolvedValueOnce(makeTask({ id: 'child-1', parentId: 'task-1' })); // one step up

      await expect(service.update(ALICE, 'task-1', { parentId: 'grandchild-1' })).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('refuses the task itself as its own parent, which the CHECK constraint would too', async () => {
      await setup([makeTask()]);
      repository.findOne.mockResolvedValueOnce(makeTask()).mockResolvedValueOnce(makeTask({ id: 'task-1' }));

      await expect(service.update(ALICE, 'task-1', { parentId: 'task-1' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('terminates on a cycle that already exists among the ancestors', async () => {
      // A pair written before this check existed would otherwise spin the walk
      // forever and hang the request rather than rejecting the edge.
      await setup([makeTask()]);
      repository.findOne
        .mockResolvedValueOnce(makeTask()) // task-1
        .mockResolvedValueOnce(makeTask({ id: 'loop-a', parentId: 'loop-b' })) // proposed parent
        .mockResolvedValueOnce(makeTask({ id: 'loop-b', parentId: 'loop-a' }))
        .mockResolvedValue(makeTask({ id: 'loop-a', parentId: 'loop-b' }));

      const result = await service.update(ALICE, 'task-1', { parentId: 'loop-a' });

      expect(result?.parentId).toBe('loop-a');
    });

    // -------------------------------------------------------------------------
    // Absent vs. `undefined` vs. `null`.
    //
    // TaskResolver.updateTask builds the DTO as an object literal with every
    // field present, so an untouched field arrives here as `key: undefined`
    // rather than an absent key — reproduced below rather than passing a
    // sparse object, since a sparse `{ title: 'x' }` in a test would not catch
    // a regression of this fix. `Object.assign` must not let that clobber the
    // entity's current value; an explicit `null` must still clear it.
    // -------------------------------------------------------------------------
    it('leaves untouched fields alone when the caller sends every key, undefined for the ones it did not set', async () => {
      await setup([makeTask({ priority: 3, status: 'open' })]);

      const result = await service.update(ALICE, 'task-1', {
        title: 'Renamed',
        description: undefined,
        notes: undefined,
        status: undefined,
        priority: undefined,
        parentId: undefined,
        dueAt: undefined,
        taskTime: undefined,
        scheduledFor: undefined,
        deferUntil: undefined,
        estimatedMinutes: undefined,
        actualMinutes: undefined,
        metadata: undefined,
      });

      expect(result?.title).toBe('Renamed');
      expect(result?.priority).toBe(3);
      expect(result?.status).toBe('open');
    });

    it('still clears a field when the caller sends an explicit null', async () => {
      await setup([makeTask({ description: 'old description', priority: 3 })]);

      const result = await service.update(ALICE, 'task-1', { description: null });

      expect(result?.description).toBeNull();
      expect(result?.priority).toBe(3);
    });
  });

  describe('complete', () => {
    it('marks done and stamps the completion instant', async () => {
      await setup([makeTask()]);

      const result = await service.complete(ALICE, 'task-1');

      expect(result?.status).toBe('done');
      expect(result?.completedAt).toBeInstanceOf(Date);
      expect(signalling.send).toHaveBeenCalledWith(TaskUpdatedEvent, {
        taskId: 'task-1',
        userId: ALICE.userId,
      });
    });

    it('records actual minutes when supplied', async () => {
      await setup([makeTask()]);

      expect((await service.complete(ALICE, 'task-1', 45))?.actualMinutes).toBe(45);
    });

    it('is idempotent — re-completing keeps the original instant', async () => {
      const first = new Date('2026-01-05T10:00:00.000Z');

      await setup([makeTask({ status: 'done', completedAt: first })]);

      // "When did I finish this?" must stay answerable; a second complete()
      // call must not slide the timestamp forward.
      expect((await service.complete(ALICE, 'task-1'))?.completedAt).toBe(first);
    });

    it('returns null for a task the caller does not own', async () => {
      await setup([]);

      expect(await service.complete(BOB, 'task-1')).toBeNull();
      expect(signalling.send).not.toHaveBeenCalled();
    });
  });

  describe('reopen', () => {
    it('clears the completion instant', async () => {
      await setup([makeTask({ status: 'done', completedAt: new Date() })]);

      const result = await service.reopen(ALICE, 'task-1');

      expect(result?.status).toBe('open');
      expect(result?.completedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Proposed intake — the Plan page's Accept and Dismiss.
  //
  // The `status !== 'proposed'` guard these two share is not just input
  // validation: it is the write-time check standing behind two cron-driven bulk
  // archivers. ProposedTaskReconcileService.reconcileStaleProposed and
  // TodoScanService.collapseDuplicateProposed both pick their victims from a
  // findAll snapshot and then hand ids to declineProposed one at a time, so a
  // proposal the user accepted in between is only saved from being archived by
  // this re-read. Relax the guard, or let the status string drift, and a daily
  // cron silently archives open work with no undo path.
  // ---------------------------------------------------------------------------
  describe('acceptProposed / declineProposed', () => {
    it('promotes a proposal into the backlog', async () => {
      await setup([makeTask({ status: 'proposed' })]);

      const result = await service.acceptProposed(ALICE, 'task-1');

      expect(result?.status).toBe('open');
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1', userId: ALICE.userId },
      });
      expect(signalling.send).toHaveBeenCalledWith(TaskUpdatedEvent, {
        taskId: 'task-1',
        userId: ALICE.userId,
      });
    });

    it('does not re-accept work that is already open', async () => {
      await setup([makeTask({ status: 'open' })]);

      expect(await service.acceptProposed(ALICE, 'task-1')).toBeNull();
      expect(repository.save).not.toHaveBeenCalled();
      expect(signalling.send).not.toHaveBeenCalled();
    });

    it('archives a declined proposal', async () => {
      await setup([makeTask({ status: 'proposed' })]);

      const result = await service.declineProposed(ALICE, 'task-1');

      expect(result?.status).toBe('archived');
      expect(signalling.send).toHaveBeenCalledWith(TaskUpdatedEvent, {
        taskId: 'task-1',
        userId: ALICE.userId,
      });
    });

    it('refuses to archive a task that is no longer a proposal', async () => {
      await setup([makeTask({ status: 'open' })]);

      expect(await service.declineProposed(ALICE, 'task-1')).toBeNull();
      expect(repository.save).not.toHaveBeenCalled();
      expect(signalling.send).not.toHaveBeenCalled();
    });

    it("cannot archive another user's proposal", async () => {
      await setup([]);

      expect(await service.declineProposed(BOB, 'task-1')).toBeNull();
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1', userId: BOB.userId },
      });
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('defer', () => {
    it('sets the new local date and counts the push', async () => {
      await setup([makeTask({ deferCount: 2 })]);

      const result = await service.defer(ALICE, 'task-1', '2026-02-01');

      expect(result?.deferUntil).toBe('2026-02-01');
      expect(result?.deferCount).toBe(3);
    });
  });

  describe('appendNotes', () => {
    it('appends a new fragment onto existing notes', async () => {
      await setup([makeTask({ notes: 'first note' })]);

      const result = await service.appendNotes(ALICE, 'task-1', 'second note');

      expect(result?.notes).toBe('first note\n\nsecond note');
      expect(signalling.send).toHaveBeenCalledWith(TaskUpdatedEvent, {
        taskId: 'task-1',
        userId: ALICE.userId,
      });
    });

    it('is idempotent — redelivering the same fragment does not duplicate it', async () => {
      // A pg-boss job that appends for items 1-4 of a batch and then throws on
      // item 5 gets the WHOLE job redelivered under the queue's retry policy.
      // Without this check, re-running the same append on retry would
      // string-concatenate the fragment a second time onto notes that already
      // have it.
      await setup([makeTask({ notes: 'first note' })]);

      const first = await service.appendNotes(ALICE, 'task-1', 'first note');

      expect(first?.notes).toBe('first note');
      expect(repository.save).not.toHaveBeenCalled();
      expect(signalling.send).not.toHaveBeenCalled();
    });

    it('is idempotent even when the fragment was the very first note (no separator to search past)', async () => {
      await setup([makeTask({ notes: null })]);

      const first = await service.appendNotes(ALICE, 'task-1', 'only note');

      expect(first?.notes).toBe('only note');

      await setup([makeTask({ notes: 'only note' })]);
      const retried = await service.appendNotes(ALICE, 'task-1', 'only note');

      expect(retried?.notes).toBe('only note');
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('returns null for a task the caller does not own', async () => {
      await setup([]);

      expect(await service.appendNotes(BOB, 'task-1', 'note')).toBeNull();
    });
  });

  describe('remove', () => {
    it('emits TaskRemovedEvent when a row was deleted', async () => {
      await service.remove(ALICE, 'task-1');

      expect(signalling.send).toHaveBeenCalledWith(TaskRemovedEvent, {
        taskId: 'task-1',
        userId: ALICE.userId,
      });
    });

    it('reports failure and emits nothing when no row matched', async () => {
      await setup();
      repository.delete.mockResolvedValueOnce({ affected: 0 });

      expect(await service.remove(ALICE, 'task-1')).toBe(false);
      expect(signalling.send).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // The planned block goes with the task.
    //
    // `ci.events.task_id` is ON DELETE SET NULL, so deleting the task alone
    // left the block on the calendar under the dead task's title, still
    // occupying the slot propose() reads as busy — and with a null task_id no
    // path in the product could reach it again (findActiveForTask matches on
    // task_id). TaskRemovedEvent's only listener is the search indexer.
    // -------------------------------------------------------------------------
    it("tombstones the task's planned blocks before the row goes", async () => {
      await setup([], [{ id: 'event-1' }, { id: 'event-2' }]);

      expect(await service.remove(ALICE, 'task-1')).toBe(true);

      const [{ where }] = blockRepo.find.mock.calls[0] as [{ where: Record<string, unknown> }];

      expect(where).toEqual({
        userId: ALICE.userId,
        taskId: 'task-1',
        eventType: 'planned_block',
        isDeleted: false,
      });
      expect(calendarEvents.remove.mock.calls.map(([, id]) => id)).toEqual(['event-1', 'event-2']);
      // Before, not after: once the delete lands, task_id is NULL and the block
      // is unfindable.
      expect(calendarEvents.remove.mock.invocationCallOrder[0]).toBeLessThan(
        repository.delete.mock.invocationCallOrder[0],
      );
    });

    it('leaves the task in place when the block cannot be taken off the calendar', async () => {
      // Deleting the task anyway is precisely the orphan this guards against,
      // so the failure surfaces instead of being swallowed.
      await setup([], [{ id: 'event-1' }]);
      calendarEvents.remove.mockRejectedValueOnce(new Error('events table unreachable'));

      await expect(service.remove(ALICE, 'task-1')).rejects.toThrow('events table unreachable');
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('sorts undated tasks last', async () => {
      await service.findAll(ALICE);

      // Postgres defaults ascending order to NULLS FIRST, which would float
      // every task without a deadline to the top of the list.
      expect(qb.calls.orderBy[0]).toEqual(['task.due_at', 'ASC', 'NULLS LAST']);
    });

    it('filters by status', async () => {
      await service.findAll(ALICE, { status: ['open', 'in_progress'] });

      expect(qb.calls.andWhere).toContainEqual([
        'task.status IN (:...status)',
        { status: ['open', 'in_progress'] },
      ]);
    });

    it('filters by a user-local scheduled date', async () => {
      await service.findAll(ALICE, { scheduledFor: '2026-01-15' });

      expect(qb.calls.andWhere).toContainEqual([
        'task.scheduled_for = :scheduledFor',
        { scheduledFor: '2026-01-15' },
      ]);
    });

    it('distinguishes "top-level only" from "no parent filter"', async () => {
      await service.findAll(ALICE, { parentId: null });

      expect(qb.calls.andWhere).toContainEqual(['task.parent_id IS NULL']);

      await setup();
      await service.findAll(ALICE, {});

      expect(qb.calls.andWhere ?? []).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // The pending-change review path.
  //
  // Every planning job's non-auto decision routes through here, and what an
  // Accept click actually DOES was previously unasserted end to end — which is
  // how `event_revise` shipped applying nothing at all.
  // ---------------------------------------------------------------------------
  describe('pending changes', () => {
    function makePendingChange(overrides: Partial<TaskPendingChangeEntity> = {}): TaskPendingChangeEntity {
      return {
        id: 'change-1',
        userId: ALICE.userId,
        taskId: 'task-1',
        kind: 'mutate',
        patch: {},
        rationale: null,
        confidence: 0.8,
        status: 'pending',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        resolvedAt: null,
        ...overrides,
      } as TaskPendingChangeEntity;
    }

    describe('createPendingChange', () => {
      it("refuses to file a change against a task the caller doesn't own", async () => {
        await setup([]);

        expect(
          await service.createPendingChange(BOB, { taskId: 'task-1', kind: 'mutate', patch: {} }),
        ).toBeNull();
        expect(pendingRepo.save).not.toHaveBeenCalled();
      });

      it('files a pending row stamped with the caller', async () => {
        await setup([makeTask()]);

        const change = await service.createPendingChange(ALICE, {
          taskId: 'task-1',
          kind: 'complete',
          patch: {},
          rationale: 'Looks done.',
          confidence: 0.6,
        });

        expect(change).toMatchObject({
          userId: ALICE.userId,
          taskId: 'task-1',
          kind: 'complete',
          status: 'pending',
          rationale: 'Looks done.',
        });
      });

      it('updates the existing pending change of the same kind instead of duplicating it', async () => {
        // Scan loops redeliver whole batches under pg-boss retry; a second run
        // must refresh the open question, not stack a second copy of it in the
        // Proposed column.
        await setup([makeTask()]);

        const existing = makePendingChange({ patch: { title: 'Old' }, rationale: 'Old reason' });
        pendingRepo.findOne.mockResolvedValue(existing);

        const change = await service.createPendingChange(ALICE, {
          taskId: 'task-1',
          kind: 'mutate',
          patch: { title: 'New' },
          rationale: 'New reason',
        });

        expect(pendingRepo.create).not.toHaveBeenCalled();
        expect(change).toMatchObject({ id: 'change-1', patch: { title: 'New' }, rationale: 'New reason' });
      });
    });

    describe('acceptPendingChange', () => {
      it("returns nothing for a change that is not the caller's own pending row", async () => {
        await setup([makeTask()]);
        pendingRepo.findOne.mockResolvedValue(null);

        expect(await service.acceptPendingChange(BOB, 'change-1')).toEqual({ task: null, change: null });
        expect(repository.save).not.toHaveBeenCalled();
      });

      it("completes the task for a 'complete' change", async () => {
        await setup([makeTask()]);
        pendingRepo.findOne.mockResolvedValue(makePendingChange({ kind: 'complete' }));

        const { task, change } = await service.acceptPendingChange(ALICE, 'change-1');

        expect(task?.status).toBe('done');
        expect(task?.completedAt).toBeInstanceOf(Date);
        expect(change?.status).toBe('accepted');
        expect(change?.resolvedAt).toBeInstanceOf(Date);
      });

      it("applies both the note append and the field patch for a 'mutate' change", async () => {
        await setup([makeTask({ notes: 'first note' })]);
        pendingRepo.findOne.mockResolvedValue(
          makePendingChange({ patch: { appendNotes: 'seen in memory', title: 'Ship the other thing' } }),
        );

        const { task } = await service.acceptPendingChange(ALICE, 'change-1');

        expect(task?.notes).toBe('first note\n\nseen in memory');
        expect(task?.title).toBe('Ship the other thing');
      });

      it("never writes the linked event's fields onto the task row for an 'event_revise' change", async () => {
        // `eventStatus`/`eventId` address the planned block, not the task.
        // `eventId` used to survive into `taskRepository.save` as a column that
        // exists on neither UpdateTaskDto nor TaskEntity, so TypeORM dropped it
        // — an accepted cancellation wrote nothing anywhere. The block write
        // now belongs to PlannedBlockService.applyPendingEventRevision.
        await setup([makeTask()]);
        pendingRepo.findOne.mockResolvedValue(
          makePendingChange({ kind: 'event_revise', patch: { eventStatus: 'cancelled', eventId: 'evt-1' } }),
        );

        const { task, change } = await service.acceptPendingChange(ALICE, 'change-1');

        expect(repository.save).not.toHaveBeenCalled();
        expect(task?.id).toBe('task-1');
        expect(change?.status).toBe('accepted');
      });
    });

    describe('hasDeclinedChangeSince', () => {
      it('asks for the declined rows resolved after the instant given', async () => {
        // The producers' only way to see a dismissal: createPendingChange
        // de-dupes against `pending` alone, so nothing else in the codebase
        // reads `declined` and every cron tick re-filed the same prompt.
        await setup([makeTask()]);
        const since = new Date('2026-01-05T09:30:00.000Z');

        expect(await service.hasDeclinedChangeSince(ALICE, 'task-1', 'complete', since)).toBe(false);

        const [{ where }] = pendingRepo.findOne.mock.calls[0] as [{ where: Record<string, unknown> }];

        expect(where).toMatchObject({
          taskId: 'task-1',
          userId: ALICE.userId,
          kind: 'complete',
          status: 'declined',
        });
        expect(where.resolvedAt).toEqual(MoreThan(since));
      });

      it('reports a standing decline', async () => {
        await setup([makeTask()]);
        pendingRepo.findOne.mockResolvedValue(makePendingChange({ status: 'declined' }));

        expect(await service.hasDeclinedChangeSince(ALICE, 'task-1', 'complete', new Date(0))).toBe(true);
      });
    });

    describe('declinePendingChange', () => {
      it('flips the row to declined and stamps the resolution', async () => {
        await setup([makeTask()]);
        pendingRepo.findOne.mockResolvedValue(makePendingChange());

        const change = await service.declinePendingChange(ALICE, 'change-1');

        expect(change?.status).toBe('declined');
        expect(change?.resolvedAt).toBeInstanceOf(Date);
        expect(repository.save).not.toHaveBeenCalled();
      });

      it("returns null for a change that is not the caller's own pending row", async () => {
        await setup([makeTask()]);
        pendingRepo.findOne.mockResolvedValue(null);

        expect(await service.declinePendingChange(BOB, 'change-1')).toBeNull();
        expect(pendingRepo.save).not.toHaveBeenCalled();
      });
    });
  });
});
