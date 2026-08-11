import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { BaseEntity, EventBaseEntity, EventEntity, EventService, GraphDeltaWriter } from '@ci/domains/memory';

import { EventCandidateEntity } from '../../entities/EventCandidateEntity';
import { CandidateService } from '../CandidateService';

/**
 * accept → returnToSlate → event deleted, proved against real Postgres.
 *
 * Unit tests mock the repository, which is how the returnEventToSlate GlobalUID
 * bug and the promotion-consistency ordering both shipped green. This locks the
 * full lifecycle against the actual constraints.
 *
 * Opt-in: set `SCHEDULE_TEST_DATABASE_URL` (or `PLANNING_TEST_DATABASE_URL`) to
 * a database with migrations applied.
 */
const DATABASE_URL = process.env.SCHEDULE_TEST_DATABASE_URL ?? process.env.PLANNING_TEST_DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('CandidateService — accept / returnToSlate lifecycle (integration)', () => {
  let dataSource: DataSource;
  let candidateService: CandidateService;
  let eventService: EventService;

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
      url: DATABASE_URL,
      // EventBaseEntity is a @ChildEntity of the ci.entities STI tree, so its
      // root has to be mapped alongside it for metadata to build.
      entities: [EventCandidateEntity, EventEntity, BaseEntity, EventBaseEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Schedule Test', $2, 'x', true, 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [ctx.userId, `schedule.${ctx.userId}@example.test`],
    );

    eventService = new EventService(
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

    const gone = await dataSource.query('SELECT event_id FROM ci.events WHERE event_id = $1', [event.id]);
    expect(gone).toHaveLength(0);
  });
});
