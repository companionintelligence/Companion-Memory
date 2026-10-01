import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import {
  BaseEntity,
  EventBaseEntity,
  EventEntity,
  CalendarEventService,
  GraphDeltaWriter,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { EventCandidateEntity } from '../../entities/EventCandidateEntity';
import { CandidateService } from '../CandidateService';

/**
 * accept → returnToSlate → event deleted, proved against real Postgres.
 *
 * Unit tests mock the repository, which is how the returnEventToSlate GlobalUID
 * bug and the promotion-consistency ordering both shipped green. This locks the
 * full lifecycle against the actual constraints.
 *
 * Needs a database with migrations applied: `SCHEDULE_TEST_DATABASE_URL`, else
 * `PLANNING_TEST_DATABASE_URL`, else `DATABASE_URL`, else `.env`'s `DATABASE_*`
 * values. `databaseAvailability()` decides whether that means run, skip or fail.
 */
const DATABASE_ENV = {
  urlEnvVar: ['SCHEDULE_TEST_DATABASE_URL', 'PLANNING_TEST_DATABASE_URL'],
  probeTimeoutEnvVar: 'SCHEDULE_TEST_PROBE_TIMEOUT_MS',
};
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[schedule/CandidateService.lifecycle] SKIPPED — ${availability.reason}`);
}

describeWithDb('CandidateService — accept / returnToSlate lifecycle (integration)', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let candidateService: CandidateService;
  let eventService: CalendarEventService;

  const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  let candidateId: string;

  const noopSignalling = { send: async () => undefined };
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
  } as unknown as LoggerService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      // EventBaseEntity is a @ChildEntity of the ci.entities STI tree, so its
      // root has to be mapped alongside it for metadata to build. UserEntity is
      // needed too: EventEntity.user is a @ManyToOne(() => UserEntity), and
      // TypeORM must be able to resolve every relation target's metadata.
      entities: [EventCandidateEntity, EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits and then DELETEs real `ci.users` rows, whose
    // cascade reaches the shared `ci.*` tables a migration suite alters inside
    // its own transaction. See `domains/__tests__/support/schemaLock.ts`.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'CandidateService.lifecycle');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Schedule Test', $2, 'x', true, 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [ctx.userId, `schedule.${ctx.userId}@example.test`],
    );

    eventService = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      noopSignalling as never,
      dataSource,
      new GraphDeltaWriter(dataSource, noopLogger),
    );

    candidateService = new CandidateService(
      dataSource.getRepository(EventCandidateEntity),
      eventService,
      dataSource,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    candidateId = uuidv7();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 7 * 86_400_000);

    await dataSource.query(
      `INSERT INTO ci.event_candidates (
         candidate_id, user_id, title, rationale, window_start, window_end,
         dedupe_key, status
       ) VALUES ($1, $2, 'Integration test task', 'because test', $3, $4, $5, 'open')`,
      [candidateId, ctx.userId, now, windowEnd, `integration:${candidateId}`],
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.event_candidates WHERE user_id = $1', [ctx.userId]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
  });

  it('accept mints an event linked by promoted_event_id; returnToSlate deletes it', async () => {
    const start = new Date(Date.now() + 3_600_000);

    const { candidate, event } = await candidateService.accept(ctx, candidateId, start);

    expect(candidate.status).toBe('accepted');
    expect(candidate.promotedEventId).toBe(event.id);

    const eventRow = await dataSource.query('SELECT event_id FROM ci.events WHERE event_id = $1', [event.id]);
    expect(eventRow).toHaveLength(1);

    const returned = await candidateService.returnToSlate(ctx, event.id);

    expect(returned.status).toBe('open');
    expect(returned.promotedEventId).toBeNull();

    // `returnToSlate` takes the event off the calendar via
    // `CalendarEventService.remove`. Events configure a `softDeleteFlag`, so
    // that is a TOMBSTONE, not a physical delete: `CtiAggregate.remove` leaves
    // BOTH the `ci.entities` base row and the `ci.events` detail row on disk
    // and only sets `is_deleted`, so the delete-toast's Undo (`restore`) can
    // bring the event back and nothing referencing it is cascaded away.
    // Asserting the detail row is physically gone fails against a real
    // database; the guarantee to pin is that the aggregate reads as absent.
    const detail = await dataSource.query('SELECT is_deleted FROM ci.events WHERE event_id = $1', [event.id]);
    expect(detail).toEqual([{ is_deleted: true }]);

    // The user-visible half: a tombstoned event is no longer readable.
    await expect(eventService.findById(ctx, event.id)).resolves.toBeNull();
  });
});
