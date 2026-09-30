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
  type CreateEventDto,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { shiftLocalDate } from '../../engine/computePlacement';
import { PLANNING_PREFS_DEFAULTS } from '../../entities/PlanningPrefsEntity';
import { TaskEntity } from '../../entities/TaskEntity';
import { TaskPendingChangeEntity } from '../../entities/TaskPendingChangeEntity';
import { PlannedBlockService } from '../PlannedBlockService';
import { PlanningTimeService } from '../PlanningTimeService';
import { TaskService } from '../TaskService';

/**
 * The gap solver against a REAL calendar, not a hand-rolled occupancy array.
 *
 * Every other `scheduleTask` / `propose` exercise mocks `findInRange` to `[]`
 * or to objects carrying exactly the four fields `occupiedSpans` reads, so the
 * unit suite can only ever prove that the solver is consistent with the fixture
 * the same test wrote. What it cannot prove is the part that actually broke in
 * production: whether the rows the DATABASE hands back are the rows the solver
 * should see at all. Both halves of the all-day exemption depend on it (an
 * `is_all_day` column that survives ingress and reaches egress), and so does
 * every "this event is dead" rule — those live in `findInRange`'s SQL, which no
 * mock executes.
 *
 * So this suite writes real `ci.events` rows through `CalendarEventService` and
 * calls `PlannedBlockService.scheduleTask`, asserting where the block lands.
 * `occupiedSpans` reads only startTime/endTime/isAllDay/plannedMinutes, so the
 * fixture stays small and every row in it is there to move the answer.
 *
 * Opt-in: set `PLANNING_TEST_DATABASE_URL` to a database with the migrations
 * applied (see TaskService.tenancy.integration.test.ts for the setup).
 */
const DATABASE_ENV = { urlEnvVar: 'PLANNING_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[planning/PlannedBlockService.gapSolver] SKIPPED — ${availability.reason}`);
}

describeWithDb('PlannedBlockService — the gap solver over real calendar rows (integration)', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let eventService: CalendarEventService;
  let taskService: TaskService;
  let plannedBlocks: PlannedBlockService;

  const owner: UserServiceContext = { userId: uuidv7() } as UserServiceContext;

  const noopSignalling = { send: async () => undefined };
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  /**
   * The day the fixture lives on, two days out.
   *
   * `computePlacement` clamps its cursor to the REAL wall clock, so a window
   * that has already partly elapsed would make the expected placement depend on
   * when the suite runs. Planning a future date puts the whole workday ahead of
   * `now` and the arithmetic becomes exact. Two days rather than one so a run
   * that crosses UTC midnight still has its target in the future.
   */
  const TARGET_DATE = shiftLocalDate(new Date().toISOString().slice(0, 10), 2);
  const NEXT_DATE = shiftLocalDate(TARGET_DATE, 1);

  /** A UTC instant on the fixture day — the user's zone is UTC, so also local. */
  function at(wall: string): Date {
    return new Date(`${TARGET_DATE}T${wall}:00.000Z`);
  }

  async function addEvent(fields: Partial<CreateEventDto> & { title: string; start_time: Date }) {
    const [event] = await eventService.create(owner, { event_type: 'meeting', ...fields });

    return event;
  }

  async function scheduleFresh(title: string, estimatedMinutes: number) {
    const task = await taskService.create(owner, { title, estimatedMinutes });
    const outcome = await plannedBlocks.scheduleTask(owner, task!.id, { date: TARGET_DATE });

    return { task: task!, outcome };
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

    // SHARED: this suite commits and then DELETEs real `ci.users` rows, whose
    // cascade reaches the shared `ci.*` tables a migration suite alters inside
    // its own transaction. See `domains/__tests__/support/schemaLock.ts`.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'PlannedBlockService.gapSolver');

    // UTC explicitly: every instant below is written and asserted in UTC, and
    // PlanningTimeService reads this column to build the workday window.
    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Planning Test', $2, 'x', true, 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [owner.userId, `planning.${owner.userId}@example.test`],
    );

    eventService = new CalendarEventService(
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
      // The user-triggered Schedule never consults the trust dial, and the
      // workday falls through to the shipped default when no prefs row and no
      // legacy self-Person leaf exist — which is what these two stubs assert.
      {} as never,
      {} as never,
      { getSelfIdentity: async () => null } as never,
      {
        find: async () => null,
        resolve: async () => ({ ...PLANNING_PREFS_DEFAULTS }),
      } as never,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the tasks and the events with the user.
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [owner.userId]);
    await dataSource.query('DELETE FROM ci.tasks WHERE user_id = $1', [owner.userId]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [owner.userId]);
  });

  describe('a day of mixed real rows', () => {
    /**
     * One workday (09:00-17:00 UTC) carrying every kind of row that can change
     * the answer, and nothing that cannot:
     *
     *   00:00-24:00  all-day PTO      — a label on the day, not a claim on it
     *   09:00-09:30  tombstoned       — deleted work does not hold its slot
     *   09:30-10:00  status unwritten — live by default, holds its slot
     *   10:00-11:00  confirmed        — back-to-back with the row above
     *   11:00-12:00  cancelled        — dead, `findInRange` never returns it
     *   12:00-13:00  skipped block    — dead by the same vocabulary
     */
    beforeEach(async () => {
      await addEvent({
        title: 'Company holiday',
        event_type: 'calendar_event',
        start_time: new Date(`${TARGET_DATE}T00:00:00.000Z`),
        end_time: new Date(`${NEXT_DATE}T00:00:00.000Z`),
        is_all_day: true,
      });

      const deleted = await addEvent({
        title: 'Meeting the user deleted',
        start_time: at('09:00'),
        end_time: at('09:30'),
      });
      await eventService.remove(owner, deleted.id);

      // No `status` key at all — the shape an ETL row arrives in when its
      // transform has no status to map. `ci.events.status` has been NOT NULL
      // since 20260908000139, so the column DEFAULT decides, and the row is
      // live. (A genuinely NULL status can no longer exist in the database;
      // the COALESCE that used to be all that stood between such a row and
      // invisibility is pinned at unit level instead.)
      await addEvent({
        title: 'Standup',
        start_time: at('09:30'),
        end_time: at('10:00'),
      });

      await addEvent({
        title: 'Design review',
        start_time: at('10:00'),
        end_time: at('11:00'),
        status: 'confirmed',
      });

      await addEvent({
        title: 'Meeting they called off',
        start_time: at('11:00'),
        end_time: at('12:00'),
        status: 'cancelled',
      });

      await addEvent({
        title: 'A block the user marked skipped',
        event_type: 'planned_block',
        start_time: at('12:00'),
        end_time: at('13:00'),
        status: 'skipped',
      });
    });

    it('takes the 09:00 gap the deleted meeting left, right up against the 09:30 standup', async () => {
      const { task, outcome } = await scheduleFresh('Call the dentist', 30);

      // Not `no_gap`: the all-day row covers the entire workday, and treating
      // one as busy is what used to shut planning down for the whole flex
      // window. Not 11:00 either: the tombstone at 09:00 holds nothing.
      expect(outcome.status).toBe('placed');
      expect(outcome.status === 'placed' && outcome.event.startTime).toEqual(at('09:00'));
      // Ends exactly when the standup starts. An end that meets a start is not
      // an overlap, and the solver must be willing to use a gap that fits to
      // the minute.
      expect(outcome.status === 'placed' && outcome.event.endTime).toEqual(at('09:30'));

      const stored = await taskService.findById(owner, task.id);
      expect(stored?.scheduledFor).toBe(TARGET_DATE);
    });

    it('steps over the back-to-back pair and lands on the cancelled and skipped windows', async () => {
      // 90 minutes does not fit the 09:00-09:30 gap, so the answer moves to the
      // far side of the busy run — 11:00, not 10:00, because a meeting ending
      // when the next begins leaves no usable space between them. Everything
      // from 11:00 is dead calendar (cancelled meeting, skipped block), and the
      // planner is entitled to all of it.
      const { outcome } = await scheduleFresh('Write the quarterly memo', 90);

      expect(outcome.status).toBe('placed');
      expect(outcome.status === 'placed' && outcome.event.startTime).toEqual(at('11:00'));
      expect(outcome.status === 'placed' && outcome.event.endTime).toEqual(at('12:30'));
    });
  });

  /**
   * `skipped` is the status the two vocabularies used to disagree about:
   * `LIVE_BLOCK_SQL` dropped it, `findInRange` did not. The block was therefore
   * invisible on every planned-block surface while still occupying its slot in
   * the solver — the planner refusing to use time it was drawing as empty. Both
   * predicates now come from `LIVE_EVENT_SQL`; these two cases are what stops
   * them drifting apart again.
   */
  describe('a dead planned block does not reserve the time it no longer occupies', () => {
    async function blockTheMorning(status: string) {
      await addEvent({
        title: 'Someone else’s block',
        event_type: 'planned_block',
        start_time: at('09:00'),
        end_time: at('10:00'),
        status,
      });
    }

    it('places into a skipped block’s own window', async () => {
      await blockTheMorning('skipped');

      const { outcome } = await scheduleFresh('Call the dentist', 30);

      expect(outcome.status === 'placed' && outcome.event.startTime).toEqual(at('09:00'));
    });

    it('still yields to the same block while it is live', async () => {
      await blockTheMorning('planned');

      const { outcome } = await scheduleFresh('Call the dentist', 30);

      expect(outcome.status === 'placed' && outcome.event.startTime).toEqual(at('10:00'));
    });
  });
});
