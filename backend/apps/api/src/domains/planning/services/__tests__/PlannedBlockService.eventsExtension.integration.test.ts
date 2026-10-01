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
import { TaskService } from '../TaskService';

/**
 * The remaining M3 `ci.events` column extension
 * (docs/architecture/planning-roadmap.md, migration
 * 20260916025813_planning_events_extension.sql), proved against a real
 * Postgres rather than a mock.
 *
 * `PlannedBlockService.test.ts` proves each write path hands `is_auto` /
 * `last_moved_at` to a MOCKED `CalendarEventService.create` — it cannot see
 * whether `toEntityFields` actually forwards them (a snake_case DTO key not
 * renamed there is a silent lost write, per that method's own comment) or
 * whether Postgres accepts the values at all. This suite writes real rows and
 * reads them back with SQL.
 *
 * Same database as the sibling suites (`PLANNING_TEST_DATABASE_URL`, else
 * `DATABASE_URL`, else `.env`'s `DATABASE_*`); see
 * TaskService.tenancy.integration.test.ts's header for how to stand one up.
 */
const DATABASE_ENV = {
  urlEnvVar: 'PLANNING_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'PLANNING_TEST_PROBE_TIMEOUT_MS',
};
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[planning/PlannedBlockService.eventsExtension] SKIPPED — ${availability.reason}`);
}

describeWithDb('ci.events M3 extension (integration)', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
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

  async function eventRow(eventId: string) {
    const [row] = await dataSource.query(
      `SELECT is_locked, is_auto, last_moved_at, status, occurrence_date, recurrence_parent_id,
              recurrence_rule, auto_run_id, category_tag_id, color_token
         FROM ci.events WHERE event_id = $1`,
      [eventId],
    );

    return row as {
      is_locked: boolean;
      is_auto: boolean;
      last_moved_at: Date | null;
      status: string;
      occurrence_date: string | null;
      recurrence_parent_id: string | null;
      recurrence_rule: string | null;
      auto_run_id: string | null;
      category_tag_id: string | null;
      color_token: string | null;
    };
  }

  async function placeBlock(title: string, start = new Date(Date.now() + 3_600_000)) {
    const task = await taskService.create(owner, { title });
    const outcome = await plannedBlocks.scheduleTaskAt(
      owner,
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
      entities: [TaskEntity, TaskPendingChangeEntity, EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: see schemaLock.ts — this suite commits and DELETEs real
    // `ci.users` rows, whose cascade reaches tables a migration suite alters.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'PlannedBlockService.eventsExtension');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Planning Test', $2, 'x', true, 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [owner.userId, `planning.ext.${owner.userId}@example.test`],
    );

    // Moving a block settles what the pipeline decided on its old time; this
    // suite is about the block, so PipelineModule's binding is a no-op here.
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
      // ON DELETE CASCADE takes the tasks and the events with the user.
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /**
   * `events_status_check` gained `planned`/`in_progress`/`skipped` in
   * 20260818185920, alongside `task_id`; this migration does not touch it
   * again (see that migration's own header). Regression coverage for the
   * widened vocabulary lived nowhere as a dedicated round-trip before this —
   * the nearby `event_revise` suite only exercises `cancelled`/`skipped`/
   * `no_show`. This iterates the FULL current vocabulary so a future
   * narrowing (or a typo in a future widening) fails here.
   */
  it('round-trips every status in events_status_check, including the M3 additions', async () => {
    const { event } = await placeBlock('Every event status');

    const statuses = [
      'tentative',
      'confirmed',
      'cancelled',
      'completed',
      'no_show',
      'rescheduled',
      'planned',
      'in_progress',
      'skipped',
    ];

    for (const status of statuses) {
      await dataSource.query('UPDATE ci.events SET status = $1 WHERE event_id = $2', [status, event.id]);

      const row = await eventRow(event.id);

      expect(row.status).toBe(status);
    }
  });

  it('still refuses a status outside the vocabulary', async () => {
    const { event } = await placeBlock('Not a status');

    await expect(
      dataSource.query('UPDATE ci.events SET status = $1 WHERE event_id = $2', ['obliterated', event.id]),
    ).rejects.toThrow();
  });

  /**
   * `PlannedBlockService.scheduleTaskAt` is the user/button/drag path —
   * `place()`'s `opts.source` defaults it and `scheduleTaskAt` never overrides
   * it, so a fresh placement here must land manual, and must record that it
   * was JUST placed.
   */
  it('scheduleTaskAt places a fresh block with is_auto=false and a fresh last_moved_at', async () => {
    const before = Date.now();
    const { event } = await placeBlock('Manual placement');

    const row = await eventRow(event.id);

    expect(row.is_auto).toBe(false);
    expect(row.is_locked).toBe(false);
    expect(row.last_moved_at).not.toBeNull();
    expect(row.last_moved_at!.getTime()).toBeGreaterThanOrEqual(before);
  });

  /**
   * Dragging an existing block to a new time is a human placing it right now
   * — `is_auto` must flip to false and `last_moved_at` must advance, even
   * starting from a block that was never auto-placed (the mock-based unit
   * suite cannot show the SECOND write actually reaching Postgres through
   * `CalendarEventService.reschedule`, only that it was called correctly).
   */
  it('moving a block via scheduleTaskAt advances last_moved_at and stamps is_auto=false', async () => {
    const { task, event } = await placeBlock('Will be dragged');
    const firstRow = await eventRow(event.id);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const newStart = new Date(Date.now() + 7_200_000);
    const outcome = await plannedBlocks.scheduleTaskAt(owner, task.id, newStart);

    expect(outcome.status).toBe('placed');

    const movedRow = await eventRow(event.id);

    expect(movedRow.is_auto).toBe(false);
    expect(movedRow.last_moved_at!.getTime()).toBeGreaterThan(firstRow.last_moved_at!.getTime());
  });

  /**
   * `EventEntity.durationMinutes` is `insert:false, update:false` and
   * `ci.events.duration_minutes` is `GENERATED ALWAYS` (guardrail 1) — the new
   * columns must not have quietly broken that. If any of the new `@Column`
   * decorators were mis-declared such that TypeORM tried to write
   * `duration_minutes`, this insert would fail outright rather than silently
   * mis-stamp one of the new columns.
   */
  it('leaves duration_minutes generated while writing every new column shape', async () => {
    const { event } = await placeBlock('Generated column guard', new Date(Date.now() + 3_600_000));

    const [row] = await dataSource.query<Array<{ duration_minutes: number }>>(
      'SELECT duration_minutes FROM ci.events WHERE event_id = $1',
      [event.id],
    );

    expect(row.duration_minutes).toBe(30);
  });

  /**
   * `recurrence_parent_id REFERENCES ci.events(event_id) ON DELETE SET NULL` —
   * proved by actually deleting the referenced row, not by reading the FK
   * definition back from the catalog.
   */
  it('recurrence_parent_id survives its template being deleted (ON DELETE SET NULL)', async () => {
    const { event: template } = await placeBlock('Recurrence template');
    const { event: instance } = await placeBlock('Recurrence instance');

    await dataSource.query('UPDATE ci.events SET recurrence_parent_id = $1 WHERE event_id = $2', [
      template.id,
      instance.id,
    ]);

    expect((await eventRow(instance.id)).recurrence_parent_id).toBe(template.id);

    await dataSource.query('DELETE FROM ci.events WHERE event_id = $1', [template.id]);

    expect((await eventRow(instance.id)).recurrence_parent_id).toBeNull();
  });

  /**
   * `category_tag_id REFERENCES ci_search.tags(id) ON DELETE SET NULL` — the
   * migration deliberately takes no dependency on `tags.kind` existing
   * (M2 may land it before or after this migration), so this only proves the
   * bare FK, written and cleared with raw SQL against a real `ci_search.tags`
   * row rather than through TagService.
   */
  it('category_tag_id survives its tag being deleted (ON DELETE SET NULL)', async () => {
    const { event } = await placeBlock('Category-tagged block');
    const tagId = uuidv7();

    await dataSource.query(`INSERT INTO ci_search.tags (id, label, user_id) VALUES ($1, 'Health', $2)`, [
      tagId,
      owner.userId,
    ]);
    await dataSource.query('UPDATE ci.events SET category_tag_id = $1 WHERE event_id = $2', [
      tagId,
      event.id,
    ]);

    expect((await eventRow(event.id)).category_tag_id).toBe(tagId);

    await dataSource.query('DELETE FROM ci_search.tags WHERE id = $1', [tagId]);

    expect((await eventRow(event.id)).category_tag_id).toBeNull();
  });

  /**
   * `occurrence_date`, `recurrence_rule`, `auto_run_id`, `color_token` are
   * schema-readiness only in this milestone — nothing writes them yet — but
   * the columns must round-trip their declared types through the entity for
   * whatever later milestone starts writing them.
   */
  it('round-trips the remaining schema-readiness columns through the entity', async () => {
    const { event } = await placeBlock('Schema readiness columns');
    const runId = uuidv7();

    await dataSource.query(
      `UPDATE ci.events
          SET occurrence_date = '2026-09-16',
              recurrence_rule = 'FREQ=WEEKLY;BYDAY=MO',
              auto_run_id = $1,
              color_token = 'category.health'
        WHERE event_id = $2`,
      [runId, event.id],
    );

    const row = await eventRow(event.id);

    // `pg`'s raw query path (unlike TypeORM's own `date`-typed column
    // transformer) hands a `date` column back as a JS Date built from the
    // LOCAL calendar fields (`new Date(year, month, day)`), not the ISO
    // string the entity mapping would give a caller going through the
    // repository — reading it back via local date parts (not
    // `toISOString`, which would shift a day east of UTC) is what makes
    // this assertion timezone-independent.
    const occurrenceDate = row.occurrence_date as unknown as Date;

    expect(occurrenceDate).toBeInstanceOf(Date);
    expect(
      `${occurrenceDate.getFullYear()}-${String(occurrenceDate.getMonth() + 1).padStart(2, '0')}-${String(
        occurrenceDate.getDate(),
      ).padStart(2, '0')}`,
    ).toBe('2026-09-16');
    expect(row.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(row.auto_run_id).toBe(runId);
    expect(row.color_token).toBe('category.health');
  });

  it('is_locked is settable and readable independent of placement', async () => {
    const { event } = await placeBlock('Lockable block');

    await dataSource.query('UPDATE ci.events SET is_locked = true WHERE event_id = $1', [event.id]);

    expect((await eventRow(event.id)).is_locked).toBe(true);
  });
});
