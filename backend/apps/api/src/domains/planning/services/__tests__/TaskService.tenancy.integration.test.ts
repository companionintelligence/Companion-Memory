import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { TaskEntity } from '../../entities/TaskEntity';
import { TaskService } from '../TaskService';

/**
 * Cross-tenant isolation, proved against a real Postgres rather than a mock.
 *
 * `TaskService.test.ts` asserts the service *passes* a `userId` predicate; only
 * a database can show that the predicate actually isolates. Both matter: the
 * unit test catches a dropped `.where()` at review time, this one catches a
 * predicate that is present but wrong.
 *
 * Opt-in: set `PLANNING_TEST_DATABASE_URL` to a database with the migrations
 * applied. The rest of the suite mocks its repositories, so this must not be a
 * hard dependency of `yarn test`.
 *
 *   docker run -d --name ci-test-db -e PASSWORD=pw -p 55433:5432 ci/database
 *   # create the companion role/db, enable extensions, then:
 *   DATABASE_HOST=localhost DATABASE_PORT=55433 \
 *     DATABASE_USERNAME=companion DATABASE_PASSWORD=pw yarn migrate
 *   PLANNING_TEST_DATABASE_URL=postgres://companion:pw@localhost:55433/companion \
 *     yarn test TaskService.tenancy
 */
const DATABASE_URL = process.env.PLANNING_TEST_DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('TaskService — tenant isolation (integration)', () => {
  let dataSource: DataSource;
  let service: TaskService;

  const alice: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const bob: UserServiceContext = { userId: uuidv7() } as UserServiceContext;

  const noopEvents = { send: async () => undefined } as unknown as EventService;
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [TaskEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    for (const [context, name] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded)
         VALUES ($1, $2, $3, 'x', true)
         ON CONFLICT (id) DO NOTHING`,
        [context.userId, name, `${name.toLowerCase()}.${context.userId}@example.test`],
      );
    }

    service = new TaskService(dataSource.getRepository(TaskEntity), noopEvents, noopLogger);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the tasks with the users.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [[alice.userId, bob.userId]]);
      await dataSource.destroy();
    }
  });

  it("keeps each user's list to their own rows", async () => {
    const aliceTask = await service.create(alice, { title: "Alice's task" });
    const bobTask = await service.create(bob, { title: "Bob's task" });

    const aliceIds = (await service.findAll(alice)).map((task) => task.id);
    const bobIds = (await service.findAll(bob)).map((task) => task.id);

    expect(aliceIds).toContain(aliceTask!.id);
    expect(aliceIds).not.toContain(bobTask!.id);
    expect(bobIds).toContain(bobTask!.id);
    expect(bobIds).not.toContain(aliceTask!.id);
  });

  it("will not read, update, complete or delete another user's task by id", async () => {
    const aliceTask = await service.create(alice, { title: 'Private' });
    const id = aliceTask!.id;

    // Every path Bob could reach for must come back empty-handed.
    expect(await service.findById(bob, id)).toBeNull();
    expect(await service.findByIds(bob, [id])).toEqual([null]);
    expect(await service.update(bob, id, { title: 'Hijacked' })).toBeNull();
    expect(await service.complete(bob, id)).toBeNull();
    expect(await service.reopen(bob, id)).toBeNull();
    expect(await service.defer(bob, id, '2026-02-01')).toBeNull();
    expect(await service.remove(bob, id)).toBe(false);

    // ...and the row is untouched.
    const survivor = await service.findById(alice, id);

    expect(survivor?.title).toBe('Private');
    expect(survivor?.status).toBe('open');
  });

  it('lets two users hold the same source_ref without colliding', async () => {
    // ux_tasks_source is user-scoped, unlike ci.events' global source triple.
    // Two people forwarding the same email must both get a task.
    const shared = { sourceKind: 'gmail', sourceRef: `msg-${uuidv7()}` };

    const first = await service.create(alice, { title: 'Shared invite', ...shared });
    const second = await service.create(bob, { title: 'Shared invite', ...shared });

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBeTruthy();
    expect(first?.id).not.toBe(second?.id);
  });

  it('round-trips the timestamp discipline through Postgres', async () => {
    const dueAt = new Date('2026-03-08T17:00:00.000Z');
    const created = await service.create(alice, {
      title: 'Typed columns',
      dueAt,
      scheduledFor: '2026-03-08',
      taskTime: '09:00',
    });

    const read = await service.findById(alice, created!.id);

    // Instants come back as Date; user-local dates and wall-clock times come
    // back as strings. That split is what keeps them un-confusable, and what
    // stops a wall-clock value being fed to zonedWallTimeToUTC as an instant.
    expect(read?.dueAt).toBeInstanceOf(Date);
    expect(read?.dueAt?.toISOString()).toBe(dueAt.toISOString());
    expect(read?.scheduledFor).toBe('2026-03-08');
    expect(read?.taskTime).toBe('09:00:00');
  });

  it('rejects an out-of-range priority at the database, not just in the app', async () => {
    await expect(service.create(alice, { title: 'Bad', priority: 99 })).rejects.toThrow();
  });

  it("will not let one user parent a task onto another user's task", async () => {
    const bobsTask = await service.create(bob, { title: "Bob's task" });

    await expect(
      service.create(alice, { title: "Alice's subtask", parentId: bobsTask!.id }),
    ).rejects.toThrow();

    const aliceTask = await service.create(alice, { title: "Alice's other task" });

    await expect(service.update(alice, aliceTask!.id, { parentId: bobsTask!.id })).rejects.toThrow();
  });
});
