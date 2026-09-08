import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { UserEntity } from '@ci/domains/user';

import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { calendarEventIdentity, platformIdentity } from '../../identity';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * `createOne` re-places a tombstoned PLANNED BLOCK instead of returning it.
 *
 * Every other source keeps the find-or-return contract — a re-imported event
 * the user deleted must stay deleted — but a planned block's identity is
 * DERIVED (`platformIdentity('planning', 'task', id)` → `task:<uuid>`), so it
 * is single-use. Returning the tombstone verbatim made `unschedule` permanent:
 * the next `place()` matched the dead row, reported the task placed, and
 * rendered nothing, for every retry thereafter.
 *
 * This has to be an integration test. The bug lived in the interaction between
 * the unique index (which spans tombstones), the soft delete, and find-or-
 * return; the unit suites mock the repository and so cannot see any of it.
 *
 * Opt-in: set `PLANNING_TEST_DATABASE_URL` to a database with migrations
 * applied (see CandidateService.lifecycle.integration.test.ts).
 */
const DATABASE_URL = process.env.MEMORY_TEST_DATABASE_URL ?? process.env.PLANNING_TEST_DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('CalendarEventService — re-placing a tombstoned planned block (integration)', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: CalendarEventService;

  const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;

  const noopSignalling = { send: async () => undefined };
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  const FIRST_START = new Date('2026-09-11T16:00:00Z');
  const FIRST_END = new Date('2026-09-11T16:30:00Z');
  const SECOND_START = new Date('2026-09-08T17:00:00Z');
  const SECOND_END = new Date('2026-09-08T17:45:00Z');

  let taskId: string;

  /** What the planner sends for a block, at whichever slot it just chose. */
  function placement(start: Date, end: Date) {
    const identity = platformIdentity('planning', 'task', taskId);

    return {
      title: 'Write the quarterly memo',
      event_type: 'planned_block',
      start_time: start,
      end_time: end,
      status: 'planned',
      source_type: 'planning',
      source_system: identity.system,
      source_id: identity.id,
      planned_minutes: Math.round((end.getTime() - start.getTime()) / 60_000),
    };
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'CalendarEventService.plannedBlockRestore');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Memory Test', $2, 'x', true, 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [ctx.userId, `memory.${ctx.userId}@example.test`],
    );

    service = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      noopSignalling as never,
      dataSource,
      new GraphDeltaWriter(dataSource, noopLogger),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  beforeEach(() => {
    taskId = uuidv7();
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
  });

  it('restores and re-times the tombstoned block rather than handing back the dead row', async () => {
    const [first] = await service.create(ctx, placement(FIRST_START, FIRST_END));

    expect(first.startTime).toEqual(FIRST_START);

    // What `PlannedBlockService.unschedule` does: tombstone, never delete, so
    // the delete-toast's Undo still has something to bring back.
    await service.remove(ctx, first.id);

    const [second] = await service.create(ctx, placement(SECOND_START, SECOND_END));

    // Same row — the derived identity guarantees that — but live again, and at
    // the slot the placer chose this time, not the one it was tombstoned at.
    expect(second.id).toBe(first.id);
    expect(second.startTime).toEqual(SECOND_START);
    expect(second.endTime).toEqual(SECOND_END);

    const [row] = await dataSource.query(
      'SELECT is_deleted, start_time, planned_minutes FROM ci.events WHERE event_id = $1',
      [first.id],
    );
    expect(row.is_deleted).toBe(false);
    expect(new Date(row.start_time)).toEqual(SECOND_START);
    expect(row.planned_minutes).toBe(45);

    // And it is readable again — the symptom users actually saw was a task
    // reported as placed with nothing on the calendar.
    await expect(service.findById(ctx, first.id)).resolves.not.toBeNull();
  });

  it('still returns a tombstoned CAPTURE row untouched, so a deleted import stays deleted', async () => {
    // The identity a real calendar sync mints, built through the same
    // constructor the ETL uses — `source_system`/`source_id` are branded types,
    // and the raw `as` casts behind them are deliberately not exported.
    const minted = calendarEventIdentity(`uid-${uuidv7()}`);
    const identity = { source_system: minted?.system, source_id: minted?.id };

    const [imported] = await service.create(ctx, {
      title: 'Imported standup',
      event_type: 'meeting',
      start_time: FIRST_START,
      end_time: FIRST_END,
      source_type: 'calendar',
      ...identity,
    });

    await service.remove(ctx, imported.id);

    // The next sync re-sends the same event. It must NOT come back to life:
    // the deletion outlives the sync, which is the whole reason `createOne`
    // matches tombstones in the first place.
    const [resynced] = await service.create(ctx, {
      title: 'Imported standup',
      event_type: 'meeting',
      start_time: SECOND_START,
      end_time: SECOND_END,
      source_type: 'calendar',
      ...identity,
    });

    expect(resynced.id).toBe(imported.id);

    const [row] = await dataSource.query('SELECT is_deleted, start_time FROM ci.events WHERE event_id = $1', [
      imported.id,
    ]);
    expect(row.is_deleted).toBe(true);
    expect(new Date(row.start_time)).toEqual(FIRST_START);
  });
});
