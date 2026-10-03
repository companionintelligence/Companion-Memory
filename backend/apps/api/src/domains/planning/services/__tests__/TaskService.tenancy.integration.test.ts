import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  CalendarEventService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PLANNING_PREFS_DEFAULTS } from '../../entities/PlanningPrefsEntity';
import { TASK_STATUSES, TaskEntity } from '../../entities/TaskEntity';
import { TaskPendingChangeEntity } from '../../entities/TaskPendingChangeEntity';
import { PlannedBlockService } from '../PlannedBlockService';
import { PlanningTimeService } from '../PlanningTimeService';
import { TaskService } from '../TaskService';

/**
 * Cross-tenant isolation, proved against a real Postgres rather than a mock.
 *
 * `TaskService.test.ts` asserts the service *passes* a `userId` predicate; only
 * a database can show that the predicate actually isolates. Both matter: the
 * unit test catches a dropped `.where()` at review time, this one catches a
 * predicate that is present but wrong.
 *
 * Needs a database with the migrations applied: `PLANNING_TEST_DATABASE_URL`,
 * else `DATABASE_URL`, else `.env`'s `DATABASE_*` values. `databaseAvailability()`
 * decides whether that means run, skip or fail. The rest of the suite mocks its
 * repositories, so with no database configured this skips (and says why) rather
 * than failing `yarn test`.
 *
 *   docker run -d --name ci-test-db -e PASSWORD=pw -p 55433:5432 ci/database
 *   # create the companion role/db, enable extensions, then:
 *   DATABASE_HOST=localhost DATABASE_PORT=55433 \
 *     DATABASE_USERNAME=companion DATABASE_PASSWORD=pw yarn migrate
 *   PLANNING_TEST_DATABASE_URL=postgres://companion:pw@localhost:55433/companion \
 *     yarn test TaskService.tenancy
 */
const DATABASE_ENV = {
  urlEnvVar: 'PLANNING_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'PLANNING_TEST_PROBE_TIMEOUT_MS',
};
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[planning/TaskService.tenancy] SKIPPED — ${availability.reason}`);
}

describeWithDb('TaskService — tenant isolation (integration)', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
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
      ...dataSourceConnection(DATABASE_ENV),
      entities: [TaskEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits and then DELETEs real `ci.users` rows, whose
    // cascade reaches the shared `ci.*` tables a migration suite alters inside
    // its own transaction. See `domains/__tests__/support/schemaLock.ts`.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'TaskService.tenancy');

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

    // `ci.events` is stubbed out here: this DataSource maps TaskEntity alone,
    // and the suite is about the `user_id` predicate. The block cleanup
    // `remove` now does is proved against real rows in the second suite below.
    service = new TaskService(
      dataSource.getRepository(TaskEntity),
      dataSource.getRepository(TaskPendingChangeEntity),
      { find: async () => [] } as never,
      noopEvents,
      { remove: async () => true } as never,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the tasks with the users.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [[alice.userId, bob.userId]]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
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

  /**
   * ═══ THE VOCABULARY LIVED IN FIVE PLACES AND AGREED IN FOUR ═══
   *
   * #2558 added `delegated` to `TASK_STATUSES`, the entity, the GraphQL enum
   * and the web client — and to no migration. `tasks_status_check` did not know
   * the word, so the one line that writes it (`AgentDispatchService.dispatch`)
   * failed at the database on every dispatch, while a fully green unit suite
   * said otherwise: every other planning test mocks the repository, and a mock
   * has no CHECK constraint.
   *
   * Iterating `TASK_STATUSES` rather than listing values is the whole point.
   * The next status added to that array without a migration fails here on the
   * day it is added, not on the day a user presses the button.
   */
  it('round-trips every declared status through the tasks_status_check constraint', async () => {
    const task = await service.create(alice, { title: 'Every status' });

    for (const status of TASK_STATUSES) {
      const updated = await service.update(alice, task!.id, { status });

      expect(updated?.status).toBe(status);

      // Through SQL, not the ORM's in-memory copy: `save()` returns the object
      // it was handed, so only a re-read proves Postgres accepted the value.
      const [row] = await dataSource.query<Array<{ status: string }>>(
        'SELECT status FROM ci.tasks WHERE id = $1',
        [task!.id],
      );

      expect(row.status).toBe(status);
    }
  });

  it('still refuses a status outside the vocabulary', async () => {
    const task = await service.create(alice, { title: 'Not a status' });

    await expect(service.update(alice, task!.id, { status: 'delegatd' as never })).rejects.toThrow();
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

/**
 * Accepting an `event_revise` confirmation, end to end against real Postgres.
 *
 * The unit coverage for this path stops at a mock: `TaskResolver.test.ts`
 * proves the resolver DISPATCHES to `applyPendingEventRevision`, and
 * `PlannedBlockService.test.ts` proves the call reaches a mocked
 * `CalendarEventService` with `{ status }` and nothing else. Neither can see
 * the leg that actually fails in production — the CTI base/detail transaction
 * and the `events_status_check` CHECK constraint. This writes a real planned
 * block, accepts a real pending change, and reads `ci.events.status` back with
 * SQL, so a rejected status value or a broken aggregate update fails the suite.
 *
 * Same database, and the same run-or-skip decision, as the suite above.
 */
describeWithDb('PlannedBlockService — accepted event_revise (integration)', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let taskService: TaskService;
  let plannedBlocks: PlannedBlockService;

  const owner: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const stranger: UserServiceContext = { userId: uuidv7() } as UserServiceContext;

  const noopSignalling = { send: async () => undefined };
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  /** `ci.events.status` straight from the table — not through any service. */
  async function storedStatus(eventId: string): Promise<string | undefined> {
    const rows = await dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM ci.events WHERE event_id = $1',
      [eventId],
    );

    return rows[0]?.status;
  }

  async function placeBlock(context: UserServiceContext, title: string) {
    const task = await taskService.create(context, { title });
    const start = new Date(Date.now() + 3_600_000);
    const outcome = await plannedBlocks.scheduleTaskAt(
      context,
      task!.id,
      start,
      new Date(start.getTime() + 30 * 60_000),
    );

    if (outcome.status !== 'placed') {
      throw new Error(`expected a placed block, got ${outcome.status}`);
    }

    return { task: task!, event: outcome.event };
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      // EventBaseEntity is a @ChildEntity of the ci.entities STI tree, so its
      // root has to be mapped alongside it; UserEntity because EventEntity.user
      // and PlanningTimeService both resolve against it.
      entities: [TaskEntity, TaskPendingChangeEntity, EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED, for the same reason the suite above takes it: this one commits
    // and then DELETEs real `ci.users` rows.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'PlannedBlockService.eventRevise');

    for (const context of [owner, stranger]) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
         VALUES ($1, 'Planning Test', $2, 'x', true, 'UTC')
         ON CONFLICT (id) DO NOTHING`,
        [context.userId, `planning.${context.userId}@example.test`],
      );
    }

    // Taking a block off the calendar (event_revise) cancels it, which settles
    // what the pipeline decided about it; this suite is about tenancy, so
    // PipelineModule's binding is a no-op here.
    const pipelineReopeners = {
      reopenTimeDecisions: async (): Promise<number> => 0,
      reopenStatusDecisions: async (): Promise<number> => 0,
    };

    const eventService = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      noopSignalling as never,
      dataSource,
      new GraphDeltaWriter(dataSource, noopLogger),
      undefined,
      { get: () => pipelineReopeners } as never,
    );

    taskService = new TaskService(
      dataSource.getRepository(TaskEntity),
      dataSource.getRepository(TaskPendingChangeEntity),
      dataSource.getRepository(EventEntity),
      { send: async () => undefined } as unknown as EventService,
      eventService,
      noopLogger,
    );

    plannedBlocks = new PlannedBlockService(
      dataSource.getRepository(EventEntity),
      eventService,
      taskService,
      new PlanningTimeService(dataSource.getRepository(UserEntity), noopLogger),
      // The revise path never consults the trust dial or the workday hours;
      // those only steer where a NEW block is proposed.
      {} as never,
      {} as never,
      {} as never,
      // Preferences resolve to the shipped defaults here: this suite is about
      // tenancy, and a real prefs read would need a row per fixture user.
      {
        find: async () => null,
        resolve: async () => ({ ...PLANNING_PREFS_DEFAULTS }),
      } as never,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the tasks and the events with the users.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [[owner.userId, stranger.userId]]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('takes the block off the calendar, and the database agrees', async () => {
    const { task, event } = await placeBlock(owner, 'Dentist');

    expect(await storedStatus(event.id)).toBe('planned');

    const change = await taskService.createPendingChange(owner, {
      taskId: task.id,
      kind: 'event_revise',
      patch: { eventStatus: 'cancelled', eventId: event.id },
      rationale: 'They called to cancel',
    });

    // The resolver's accept body, minus GraphQL.
    const accepted = await taskService.acceptPendingChange(owner, change!.id);

    expect(accepted.change?.kind).toBe('event_revise');

    await plannedBlocks.applyPendingEventRevision(owner, task.id, accepted.change!.patch);

    // The point of this suite: not "a service was called" but "the row moved".
    // `cancelled` has to survive events_status_check, and the CTI base/detail
    // transaction has to commit, or this reads back 'planned'.
    expect(await storedStatus(event.id)).toBe('cancelled');
    expect(await plannedBlocks.findActiveForTask(owner, task.id)).toBeNull();
  });

  it('writes a second revisable status and leaves duration_minutes generated', async () => {
    const { task, event } = await placeBlock(owner, 'Standup');

    await plannedBlocks.applyPendingEventRevision(owner, task.id, {
      eventStatus: 'skipped',
      eventId: event.id,
    });

    const [row] = await dataSource.query<Array<{ status: string; duration_minutes: number }>>(
      'SELECT status, duration_minutes FROM ci.events WHERE event_id = $1',
      [event.id],
    );

    expect(row.status).toBe('skipped');
    // Still derived from the unchanged 30-minute window. This does not prove
    // the UPDATE could not name duration_minutes — `EventEntity.durationMinutes`
    // is `update: false`, so TypeORM drops it before Postgres ever sees it —
    // only that the revise leg leaves the generated value intact.
    expect(row.duration_minutes).toBe(30);
  });

  it('will not let another user cancel the block', async () => {
    const { task, event } = await placeBlock(owner, 'Private appointment');

    expect(
      await plannedBlocks.applyPendingEventRevision(stranger, task.id, {
        eventStatus: 'cancelled',
        eventId: event.id,
      }),
    ).toBeNull();

    expect(await storedStatus(event.id)).toBe('planned');
  });

  it('refuses a status the CHECK constraint would reject anyway', async () => {
    const { task, event } = await placeBlock(owner, 'Not a cancellation');

    expect(
      await plannedBlocks.applyPendingEventRevision(owner, task.id, {
        eventStatus: 'obliterated',
        eventId: event.id,
      }),
    ).toBeNull();

    expect(await storedStatus(event.id)).toBe('planned');
  });

  /**
   * Deleting the task used to strand its block. `ci.events.task_id` is
   * `ON DELETE SET NULL`, so the row survived the delete with a null task_id:
   * it kept rendering under the dead task's title, kept occupying the slot
   * `propose()` reads as busy, and `findActiveForTask` — the only way anything
   * in the product reaches a block — could never match it again.
   *
   * Only a real database can show this one, because the orphan is made by the
   * FK's own ON DELETE action rather than by any line of TypeScript.
   */
  it('takes the planned block with the task when the task is deleted', async () => {
    const { task, event } = await placeBlock(owner, 'Deleted while scheduled');

    expect(await taskService.remove(owner, task.id)).toBe(true);

    const [row] = await dataSource.query<Array<{ is_deleted: boolean; task_id: string | null }>>(
      'SELECT is_deleted, task_id FROM ci.events WHERE event_id = $1',
      [event.id],
    );

    // Tombstoned, not orphaned: is_deleted keeps it out of every read path,
    // and CalendarEventService.restore can still bring it back.
    expect(row.is_deleted).toBe(true);
    expect(await taskService.findById(owner, task.id)).toBeNull();

    const onCalendar = await plannedBlocks.list(owner, new Date(0), new Date('2100-01-01T00:00:00.000Z'));

    expect(onCalendar.map((block) => block.id)).not.toContain(event.id);
  });

  it("will not let another user's delete take a block off the calendar", async () => {
    const { task, event } = await placeBlock(owner, 'Still mine');

    expect(await taskService.remove(stranger, task.id)).toBe(false);

    const [row] = await dataSource.query<Array<{ is_deleted: boolean }>>(
      'SELECT is_deleted FROM ci.events WHERE event_id = $1',
      [event.id],
    );

    expect(row.is_deleted).toBe(false);
    expect(await taskService.findById(owner, task.id)).not.toBeNull();
  });
});
