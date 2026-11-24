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
import { TaskEntity } from '../../entities/TaskEntity';
import { TaskPendingChangeEntity } from '../../entities/TaskPendingChangeEntity';
import { PlannedBlockService } from '../PlannedBlockService';
import { PlanningTimeService } from '../PlanningTimeService';
import { claimDueReminders } from '../ReminderDispatchService';
import { TaskService } from '../TaskService';

/**
 * `claimDueReminders`'s two load-bearing correctness properties, proved
 * against a real Postgres rather than a mock:
 *
 *  1. THE CLAIM IS FIRE-ONCE UNDER CONCURRENCY. A unit test calling the
 *     function sequentially cannot show this — sequential calls always
 *     serialize trivially. Only overlapping calls against a real database
 *     (`Promise.all`, so both statements are in flight against Postgres at
 *     the same time) can demonstrate that the second UPDATE's WHERE clause
 *     genuinely re-evaluates against the first's committed write rather than
 *     an in-memory snapshot. See the migration's header comment and
 *     `ReminderDispatchService`'s doc comment on `claimDueReminders` for the
 *     mechanism this proves.
 *  2. SUPPRESSION IS RE-CHECKED AT CLAIM TIME, not merely at creation time —
 *     a task/block already in a terminal status when the claim runs is
 *     excluded, and the same still-`pending` row becomes claimable again the
 *     moment the task/block leaves that status, with no re-sync step.
 *
 * Same database convention as `TaskService.tenancy.integration.test.ts`:
 * `PLANNING_TEST_DATABASE_URL`, else `DATABASE_URL`, else `.env`'s `DATABASE_*`,
 * pointing at a Postgres already migrated to `main` (e.g. the `ci-parity-db`
 * container: postgres://companion:parity_local@localhost:5433/companion).
 * `databaseAvailability()` decides whether that means run, skip or fail.
 */
const DATABASE_ENV = {
  urlEnvVar: 'PLANNING_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'PLANNING_TEST_PROBE_TIMEOUT_MS',
};
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[planning/ReminderDispatchService.claim] SKIPPED — ${availability.reason}`);
}

describeWithDb('claimDueReminders (integration)', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let taskService: TaskService;
  let plannedBlocks: PlannedBlockService;

  const userId = uuidv7();
  const context: UserServiceContext = { userId } as UserServiceContext;

  const noopSignalling = { send: async () => undefined };
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  async function insertTask(status: string): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.tasks (id, user_id, title, status) VALUES ($1, $2, 'Test task', $3)`,
      [id, userId, status],
    );

    return id;
  }

  async function insertReminder(
    target: { taskId?: string; blockId?: string },
    fireAt: Date,
  ): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.reminders (id, user_id, task_id, block_id, fire_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, userId, target.taskId ?? null, target.blockId ?? null, fireAt],
    );

    return id;
  }

  async function reminderStatus(id: string): Promise<string> {
    const [row] = await dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM ci.reminders WHERE id = $1',
      [id],
    );

    return row.status;
  }

  async function setEventStatus(eventId: string, status: string): Promise<void> {
    await dataSource.query('UPDATE ci.events SET status = $1 WHERE event_id = $2', [status, eventId]);
  }

  async function setTaskStatus(taskId: string, status: string): Promise<void> {
    await dataSource.query('UPDATE ci.tasks SET status = $1 WHERE id = $2', [status, taskId]);
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [TaskEntity, TaskPendingChangeEntity, EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED, same reason TaskService.tenancy.integration.test.ts takes it:
    // this suite commits real rows and then DELETEs a real ci.users row.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'ReminderDispatchService.claim');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Reminder Test', $2, 'x', true, 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [userId, `reminders.${userId}@example.test`],
    );

    const eventService = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      noopSignalling as never,
      dataSource,
      new GraphDeltaWriter(dataSource, noopLogger),
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
      {} as never,
      {} as never,
      {} as never,
      {
        find: async () => null,
        resolve: async () => ({ ...PLANNING_PREFS_DEFAULTS }),
      } as never,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the tasks, events and reminders with the user.
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  describe('fire-once under concurrency', () => {
    it('claims one due reminder exactly once across two overlapping claim attempts', async () => {
      const taskId = await insertTask('open');
      const reminderId = await insertReminder({ taskId }, new Date(Date.now() - 60_000));
      const now = new Date();

      const [first, second] = await Promise.all([
        claimDueReminders(dataSource, userId, now),
        claimDueReminders(dataSource, userId, now),
      ]);

      const claimedIds = [...first, ...second].map((row) => row.id);

      expect(claimedIds).toEqual([reminderId]);
      expect(await reminderStatus(reminderId)).toBe('fired');
    });

    it('claims a batch of contested reminders exactly once each under five overlapping claim attempts', async () => {
      const taskId = await insertTask('open');
      const ids = await Promise.all(
        Array.from({ length: 20 }, () => insertReminder({ taskId }, new Date(Date.now() - 60_000))),
      );
      const now = new Date();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => claimDueReminders(dataSource, userId, now)),
      );
      const claimedIds = results.flat().map((row) => row.id);

      // Every reminder claimed exactly once — no duplicates, none missed.
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect([...claimedIds].sort()).toEqual([...ids].sort());
    });

    it('a second tick after a fire re-selects nothing', async () => {
      const taskId = await insertTask('open');
      const reminderId = await insertReminder({ taskId }, new Date(Date.now() - 60_000));
      const now = new Date();

      const firstTick = await claimDueReminders(dataSource, userId, now);

      expect(firstTick.map((row) => row.id)).toEqual([reminderId]);

      const secondTick = await claimDueReminders(dataSource, userId, now);

      expect(secondTick).toEqual([]);
    });

    it('does not claim a reminder whose fire_at is still in the future', async () => {
      const taskId = await insertTask('open');
      const reminderId = await insertReminder({ taskId }, new Date(Date.now() + 3_600_000));

      const claimed = await claimDueReminders(dataSource, userId, new Date());

      expect(claimed.map((row) => row.id)).not.toContain(reminderId);
      expect(await reminderStatus(reminderId)).toBe('pending');
    });
  });

  describe('suppression re-checked at claim time', () => {
    it.each(['done', 'skipped', 'archived'])(
      'does not claim a reminder whose task is already %s',
      async (status) => {
        const taskId = await insertTask(status);
        const reminderId = await insertReminder({ taskId }, new Date(Date.now() - 60_000));

        const claimed = await claimDueReminders(dataSource, userId, new Date());

        expect(claimed.map((row) => row.id)).not.toContain(reminderId);
        expect(await reminderStatus(reminderId)).toBe('pending');
      },
    );

    it('claims a reminder on an active task', async () => {
      const taskId = await insertTask('open');
      const reminderId = await insertReminder({ taskId }, new Date(Date.now() - 60_000));

      const claimed = await claimDueReminders(dataSource, userId, new Date());

      expect(claimed.map((row) => row.id)).toContain(reminderId);
    });

    it('un-suppresses immediately once a terminal task reopens — no re-sync needed', async () => {
      const taskId = await insertTask('done');
      const reminderId = await insertReminder({ taskId }, new Date(Date.now() - 60_000));

      expect((await claimDueReminders(dataSource, userId, new Date())).map((row) => row.id)).not.toContain(
        reminderId,
      );
      expect(await reminderStatus(reminderId)).toBe('pending');

      await setTaskStatus(taskId, 'open');

      expect((await claimDueReminders(dataSource, userId, new Date())).map((row) => row.id)).toContain(
        reminderId,
      );
    });

    it('does not claim a reminder on a skipped planned block', async () => {
      const task = await taskService.create(context, { title: 'Block-linked task' });
      const start = new Date(Date.now() + 3_600_000);
      const outcome = await plannedBlocks.scheduleTaskAt(
        context,
        task!.id,
        start,
        new Date(start.getTime() + 1_800_000),
      );

      if (outcome.status !== 'placed') {
        throw new Error(`expected a placed block, got ${outcome.status}`);
      }

      await setEventStatus(outcome.event!.id, 'skipped');

      const reminderId = await insertReminder({ blockId: outcome.event!.id }, new Date(Date.now() - 60_000));

      const claimed = await claimDueReminders(dataSource, userId, new Date());

      expect(claimed.map((row) => row.id)).not.toContain(reminderId);
      expect(await reminderStatus(reminderId)).toBe('pending');
    });

    it('claims a reminder on a still-planned block', async () => {
      const task = await taskService.create(context, { title: 'Block-linked task, still live' });
      const start = new Date(Date.now() + 3_600_000);
      const outcome = await plannedBlocks.scheduleTaskAt(
        context,
        task!.id,
        start,
        new Date(start.getTime() + 1_800_000),
      );

      if (outcome.status !== 'placed') {
        throw new Error(`expected a placed block, got ${outcome.status}`);
      }

      const reminderId = await insertReminder({ blockId: outcome.event!.id }, new Date(Date.now() - 60_000));

      const claimed = await claimDueReminders(dataSource, userId, new Date());

      expect(claimed.map((row) => row.id)).toContain(reminderId);
    });

    /**
     * The cascading half of suppression: a block-targeted reminder is
     * suppressed if EITHER the block itself is terminal OR its linked task
     * is — covering "Objective complete" marking the task done without
     * touching the block's own status (mirrors CI-Planning's
     * `focus-reminders.test.ts` "cues fall silent once the linked task is
     * done" case, generalised to an ordinary block reminder).
     */
    it('does not claim a block-targeted reminder whose LINKED TASK is terminal, even though the block itself is still planned', async () => {
      const task = await taskService.create(context, { title: 'Task completed independently of its block' });
      const start = new Date(Date.now() + 3_600_000);
      const outcome = await plannedBlocks.scheduleTaskAt(
        context,
        task!.id,
        start,
        new Date(start.getTime() + 1_800_000),
      );

      if (outcome.status !== 'placed') {
        throw new Error(`expected a placed block, got ${outcome.status}`);
      }

      await setTaskStatus(task!.id, 'done');

      const [row] = await dataSource.query<Array<{ status: string }>>(
        'SELECT status FROM ci.events WHERE event_id = $1',
        [outcome.event!.id],
      );

      expect(row.status).toBe('planned'); // the block itself never moved

      const reminderId = await insertReminder({ blockId: outcome.event!.id }, new Date(Date.now() - 60_000));

      const claimed = await claimDueReminders(dataSource, userId, new Date());

      expect(claimed.map((row) => row.id)).not.toContain(reminderId);
    });
  });
});
