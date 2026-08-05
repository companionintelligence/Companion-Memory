import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { TaskEntity } from '../../entities/TaskEntity';
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

  async function setup(rows: TaskEntity[] = []) {
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

    const moduleRef = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(TaskEntity), useValue: repository },
        { provide: EventService, useValue: signalling },
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

      expect(signalling.send).toHaveBeenCalledWith(TaskCreatedEvent, { taskId: expect.any(String) });
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
        select: { id: true },
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
  });

  describe('complete', () => {
    it('marks done and stamps the completion instant', async () => {
      await setup([makeTask()]);

      const result = await service.complete(ALICE, 'task-1');

      expect(result?.status).toBe('done');
      expect(result?.completedAt).toBeInstanceOf(Date);
      expect(signalling.send).toHaveBeenCalledWith(TaskUpdatedEvent, { taskId: 'task-1' });
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

  describe('defer', () => {
    it('sets the new local date and counts the push', async () => {
      await setup([makeTask({ deferCount: 2 })]);

      const result = await service.defer(ALICE, 'task-1', '2026-02-01');

      expect(result?.deferUntil).toBe('2026-02-01');
      expect(result?.deferCount).toBe(3);
    });
  });

  describe('remove', () => {
    it('emits TaskRemovedEvent when a row was deleted', async () => {
      await service.remove(ALICE, 'task-1');

      expect(signalling.send).toHaveBeenCalledWith(TaskRemovedEvent, { taskId: 'task-1' });
    });

    it('reports failure and emits nothing when no row matched', async () => {
      await setup();
      repository.delete.mockResolvedValueOnce({ affected: 0 });

      expect(await service.remove(ALICE, 'task-1')).toBe(false);
      expect(signalling.send).not.toHaveBeenCalled();
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
});
