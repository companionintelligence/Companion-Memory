import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { EventUpdatedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { calendarEventIdentity, platformIdentity } from '../../identity';
import type { CreateEventDto } from '../../types';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SOURCE'S RE-DELIVERED STATUS, AGAINST THE ROWS IT LANDS ON. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `createOne` used to return a re-delivered row verbatim, so a cancellation at
 * the source never reached it. It now merges the source's status three ways
 * against `ci.events.source_status` (sourceStatusMerge.ts has the rule as a
 * table). This file pins what the rule does to real rows, through `create` —
 * the door every connection uses:
 *
 *  - who hears about a change: the graph delta, the update event and HBPE, and
 *    for a tombstone nobody;
 *  - that a repeat costs nothing (the row is not even rewritten);
 *  - that only a SOURCE's rows move — not a planned block, not a user's event;
 *  - and that the merge decides on the row it has locked, so a user's edit that
 *    commits while a sync waits on that lock is kept. That case needs two live
 *    connections and a rendezvous on `pg_blocking_pids`, which is why it lives
 *    here and not in a unit spec.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL to a
 * migrated database of your own.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CalendarEventService.sourceStatus] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const START = new Date('2026-09-23T19:00:00Z');
const END = new Date('2026-09-23T20:00:00Z');

describeWithDb(`CalendarEventService — a source re-delivering a status (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: CalendarEventService;
  let uid: string;

  const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const signalling = { send: jest.fn(async () => undefined) };
  const hbpe = { notifyEvents: jest.fn(async () => undefined) };
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  /** What a calendar connection sends for one meeting: the same identity every time, whatever the status. */
  function delivery(status?: string, over: Partial<CreateEventDto> = {}): CreateEventDto {
    const identity = calendarEventIdentity(uid);

    return {
      title: 'Quarterly review',
      event_type: 'calendar_event',
      start_time: START,
      end_time: END,
      source_type: 'ETL',
      source_system: identity?.system,
      source_id: identity?.id,
      ...(status ? { status } : {}),
      ...over,
    };
  }

  async function row(id: string): Promise<Record<string, unknown>> {
    const [found] = await dataSource.query(
      `SELECT status, source_status, is_deleted, updated_at, ctid::text AS ctid
         FROM ci.events WHERE event_id = $1`,
      [id],
    );

    return found;
  }

  function statusDeltas(
    id: string,
  ): Promise<Array<{ changed_fields: unknown; changed_by_user_id: unknown }>> {
    return dataSource.query(
      `SELECT changed_fields, changed_by_user_id FROM ci.graph_deltas
        WHERE entity_id = $1 AND change_source = 'CalendarEventService.refreshFromSource'`,
      [id],
    );
  }

  async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(`Timed out waiting for ${what}`);
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CalendarEventService.sourceStatus');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Source status fixture', $2, 'x', true, 'UTC')`,
      [ctx.userId, `source-status.${ctx.userId}@example.test`],
    );

    service = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      signalling as never,
      dataSource,
      new GraphDeltaWriter(dataSource, noopLogger),
      hbpe as never,
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    uid = `review-${uuidv7()}@example.test`;
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('records what the source said on the first delivery, beside what the row shows', async () => {
    const [stored] = await service.create(ctx, delivery('tentative'));

    expect(await row(stored.id)).toMatchObject({ status: 'tentative', source_status: 'tentative' });
  });

  it('publishes a moved status once: the graph delta, the update event, the HBPE day', async () => {
    const [stored] = await service.create(ctx, delivery('confirmed'));
    jest.clearAllMocks();

    const [resynced] = await service.create(ctx, delivery('cancelled'));

    expect(resynced.id).toBe(stored.id);
    expect(resynced.status).toBe('cancelled');
    expect(await row(stored.id)).toMatchObject({ status: 'cancelled', source_status: 'cancelled' });

    expect(signalling.send).toHaveBeenCalledTimes(1);
    expect(signalling.send).toHaveBeenCalledWith(EventUpdatedEvent, { eventId: stored.id });
    expect(hbpe.notifyEvents).toHaveBeenCalledWith(ctx.userId, START);
    expect(await statusDeltas(stored.id)).toEqual([
      // The source changed it, not the user.
      {
        changed_fields: expect.objectContaining({ status: { old: 'confirmed', new: 'cancelled' } }),
        changed_by_user_id: null,
      },
    ]);
  });

  it('costs nothing when the source repeats itself: the row is not even rewritten', async () => {
    const [stored] = await service.create(ctx, delivery('confirmed'));
    const before = await row(stored.id);
    jest.clearAllMocks();

    await service.create(ctx, delivery('confirmed'));

    // ctid moves on every UPDATE, even one that writes the same values.
    expect(await row(stored.id)).toEqual(before);
    expect(signalling.send).not.toHaveBeenCalled();
    expect(hbpe.notifyEvents).not.toHaveBeenCalled();
  });

  it('records a first base on a legacy row without bumping updated_at or telling anyone', async () => {
    const [stored] = await service.create(ctx, delivery('confirmed'));
    // A row stored before source_status existed, and not a Google one the
    // migration could backfill.
    await dataSource.query('UPDATE ci.events SET source_status = NULL WHERE event_id = $1', [stored.id]);
    const before = await row(stored.id);
    jest.clearAllMocks();

    await service.create(ctx, delivery('confirmed'));

    const after = await row(stored.id);
    expect(after).toMatchObject({ status: 'confirmed', source_status: 'confirmed' });
    expect(after.updated_at).toEqual(before.updated_at);
    expect(signalling.send).not.toHaveBeenCalled();
    expect(await statusDeltas(stored.id)).toEqual([]);
  });

  it('lets the live source cancel a row another pipeline stored without any status', async () => {
    // An import that stated no status (a VEVENT without STATUS, or anything
    // imported before the importer could say) leaves the column default and no
    // base. The connection's cancellation must still land.
    const [imported] = await service.create(ctx, delivery(undefined, { source_type: 'ci-import-tools' }));
    expect(await row(imported.id)).toMatchObject({ status: 'confirmed', source_status: null });

    await service.create(ctx, delivery('cancelled'));

    expect(await row(imported.id)).toMatchObject({ status: 'cancelled', source_status: 'cancelled' });
  });

  it('records the base on the bulk path too, so a tentative import can still be confirmed by the connection', async () => {
    // The importer's push goes through the array door (a set-based INSERT) and
    // now states an .ics VEVENT's STATUS. A TENTATIVE one must not read as the
    // user's choice when Google later says the meeting is on.
    const [imported] = await service.create(ctx, [delivery('tentative', { source_type: 'ci-import-tools' })]);
    expect(await row(imported.id)).toMatchObject({ status: 'tentative', source_status: 'tentative' });

    await service.create(ctx, delivery('confirmed'));

    expect(await row(imported.id)).toMatchObject({ status: 'confirmed', source_status: 'confirmed' });
  });

  it('never moves a status on a delivery that carries none', async () => {
    const [stored] = await service.create(ctx, delivery('cancelled'));
    const before = await row(stored.id);

    await service.create(ctx, delivery(undefined));

    expect(await row(stored.id)).toEqual(before);
  });

  it('writes a tombstone quietly: the status follows, is_deleted holds, nothing is published', async () => {
    const [stored] = await service.create(ctx, delivery('confirmed'));
    await service.remove(ctx, stored.id);
    jest.clearAllMocks();

    await service.create(ctx, delivery('cancelled'));

    expect(await row(stored.id)).toMatchObject({ status: 'cancelled', is_deleted: true });
    expect(signalling.send).not.toHaveBeenCalled();
    expect(hbpe.notifyEvents).not.toHaveBeenCalled();
    expect(await statusDeltas(stored.id)).toEqual([]);
    // Still gone to every reader.
    await expect(service.findById(ctx, stored.id)).resolves.toBeNull();
  });

  it("leaves a planned block's status to the planner", async () => {
    const taskId = uuidv7();
    const identity = platformIdentity('planning', 'task', taskId);
    const block = {
      title: 'Write the memo',
      event_type: 'planned_block',
      start_time: START,
      end_time: END,
      status: 'planned',
      source_type: 'planning',
      source_system: identity.system,
      source_id: identity.id,
    };

    const [placed] = await service.create(ctx, block);
    await service.update(ctx, placed.id, { status: 'completed' });

    await service.create(ctx, block);

    expect(await row(placed.id)).toMatchObject({ status: 'completed', source_status: null });
  });

  it('refuses, through the thin door, a row no source owns', async () => {
    const [own] = await service.create(ctx, { title: 'My own event', start_time: START, end_time: END });

    await expect(service.applyStatusFromSource(ctx, own.id, 'cancelled')).resolves.toBeNull();
    expect(await row(own.id)).toMatchObject({ status: 'confirmed', source_status: null });

    // And another user's row is not this caller's to find.
    const [stored] = await service.create(ctx, delivery('confirmed'));
    const stranger = { userId: uuidv7() } as UserServiceContext;
    await expect(service.applyStatusFromSource(stranger, stored.id, 'cancelled')).resolves.toBeNull();
    expect(await row(stored.id)).toMatchObject({ status: 'confirmed' });
  });

  it("keeps a user's edit that commits while the sync is waiting on the row lock", async () => {
    const [stored] = await service.create(ctx, delivery('confirmed'));
    const user = dataSource.createQueryRunner();
    await user.connect();
    await user.startTransaction();

    try {
      const [{ pid }] = await user.query('SELECT pg_backend_pid() AS pid');
      // The user marks the meeting a no-show, and has not committed yet.
      await user.query(`UPDATE ci.events SET status = 'no_show' WHERE event_id = $1`, [stored.id]);

      // Meanwhile the organizer cancels it, and the sync delivers that.
      const sync = service.create(ctx, delivery('cancelled'));

      // Rendezvous on the lock itself, not on timing: the sync must be QUEUED
      // behind the user's transaction before the user commits. A merge decided
      // from a read taken before the lock would already have its answer here.
      await waitFor(async () => {
        const [{ waiting }] = await dataSource.query(
          'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        );

        return waiting > 0;
      }, 'the sync to queue behind the user');

      await user.commitTransaction();
      await sync;
    } finally {
      if (user.isTransactionActive) {
        await user.rollbackTransaction();
      }

      await user.release();
    }

    // The user's status stands; what the source said is still recorded.
    expect(await row(stored.id)).toMatchObject({ status: 'no_show', source_status: 'cancelled' });
  });
});
