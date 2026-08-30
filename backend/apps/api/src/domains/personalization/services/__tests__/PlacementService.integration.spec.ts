import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { BaseEntity, EventBaseEntity, EventEntity, EventService, GraphDeltaWriter } from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PlacementService } from '../../placement';

/**
 * `PlacementService.acceptCandidate` — the optimistic-concurrency claim,
 * proved against real Postgres.
 *
 * The method is a textbook check-then-act: SELECT the open candidate, mint an
 * event for it, then `UPDATE ci.event_candidates ... WHERE status <> 'accepted'
 * RETURNING candidate_id`. If that UPDATE returns no row — because a concurrent
 * caller already claimed the same candidate — the event just created is deleted
 * and the call throws `schedule accept lost the candidate claim`. No unit test
 * exercises this: a mocked DataSource cannot show that a second, concurrent
 * UPDATE on the SAME row actually loses the race, only that the code *would*
 * throw if told to. Only Postgres's row-level locking can prove the claim is
 * exclusive — that two concurrent accepts of one candidate produce exactly one
 * event, not two, and that the loser's event does not linger as an orphan.
 *
 * Opt-in: set `PERSONALIZATION_TEST_DATABASE_URL` (or `DATABASE_URL` /
 * `DATABASE_PASSWORD`, as `yarn test` already does from the repo-root `.env`)
 * to a database with migrations applied.
 */
const availability = databaseAvailability({ urlEnvVar: 'PERSONALIZATION_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[personalization/PlacementService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(
  `PlacementService.acceptCandidate — against real Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let eventService: EventService;
    let placementService: PlacementService;

    const ctx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;

    const noopSignalling = { send: async () => undefined };
    const noopLogger = {
      setContext: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
    } as unknown as LoggerService;

    beforeAll(async () => {
      const connection = resolveConnection({ urlEnvVar: 'PERSONALIZATION_TEST_DATABASE_URL' });

      if (connection == null) {
        throw new Error('databaseAvailability passed but no connection resolved');
      }

      dataSource = new DataSource({
        type: 'postgres',
        ...(connection.url != null
          ? { url: connection.url }
          : {
              host: connection.host,
              port: connection.port,
              username: connection.username,
              password: connection.password,
              database: connection.database,
            }),
        // EventBaseEntity is a @ChildEntity of the ci.entities STI tree, so its
        // root has to be mapped alongside it for metadata to build.
        entities: [EventEntity, BaseEntity, EventBaseEntity, UserEntity],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });

      await dataSource.initialize();

      // SHARED: this suite commits real ci.users / ci.event_candidates rows and
      // row-locks the shared ci.events / ci.entities tables. See
      // domains/__tests__/support/schemaLock.ts.
      schemaLock = await acquireSchemaWriteLock(dataSource, 'PlacementService.acceptCandidate');

      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded, timezone)
       VALUES ($1, 'Placement Test', $2, 'x', true, 'UTC')
       ON CONFLICT (id) DO NOTHING`,
        [ctx.userId, `placement.${ctx.userId}@example.test`],
      );

      eventService = new EventService(
        dataSource.getRepository(EventEntity),
        dataSource.getRepository(EventBaseEntity),
        noopSignalling as never,
        dataSource,
        new GraphDeltaWriter(dataSource, noopLogger),
      );

      placementService = new PlacementService(dataSource, eventService);
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        // ON DELETE CASCADE takes the candidates and events with the user.
        await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
        // Before `destroy()`: the lock is held on a runner from this pool.
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    /** Seed one open ci.event_candidates row and return its id. */
    async function seedCandidate(): Promise<string> {
      const candidateId = uuidv7();
      const now = new Date();
      const windowEnd = new Date(now.getTime() + 7 * 86_400_000);

      await dataSource.query(
        `INSERT INTO ci.event_candidates (
         candidate_id, user_id, title, rationale, window_start, window_end,
         dedupe_key, status
       ) VALUES ($1, $2, 'Placement integration test', 'because test', $3, $4, $5, 'open')`,
        [candidateId, ctx.userId, now, windowEnd, `placement-integration:${candidateId}`],
      );

      return candidateId;
    }

    it('accepts an open candidate: creates the event and claims the row', async () => {
      const candidateId = await seedCandidate();
      const start = new Date(Date.now() + 3_600_000);

      await placementService.acceptCandidate(ctx, candidateId, start);

      const [row] = await dataSource.query(
        `SELECT status, promoted_event_id FROM ci.event_candidates WHERE candidate_id = $1`,
        [candidateId],
      );

      expect(row.status).toBe('accepted');
      expect(row.promoted_event_id).not.toBeNull();

      const events = await dataSource.query(`SELECT event_id FROM ci.events WHERE event_id = $1`, [
        row.promoted_event_id,
      ]);
      expect(events).toHaveLength(1);
    });

    it('refuses to accept a candidate that is not open (already accepted)', async () => {
      const candidateId = await seedCandidate();
      await placementService.acceptCandidate(ctx, candidateId, new Date(Date.now() + 3_600_000));

      await expect(
        placementService.acceptCandidate(ctx, candidateId, new Date(Date.now() + 7_200_000)),
      ).rejects.toThrow('schedule accept matched no open candidate');
    });

    it('loses the claim — and rolls back the event it just created — when a concurrent accept wins first', async () => {
      // The race this guard exists for is a genuine TOCTOU: the initial
      // `WHERE status = 'open'` SELECT and the closing `WHERE status <> 'accepted'`
      // UPDATE are two separate statements with nothing holding a lock between
      // them, so a second accept can commit in the gap. Reproducing that gap by
      // firing two real concurrent calls at a local database is exactly the kind
      // of timing-dependent test that is flaky by construction — on a fast local
      // connection the first call's entire SELECT→create→UPDATE sequence can
      // complete before the second call's SELECT is even dispatched, which proves
      // nothing about the claim logic and everything about scheduling luck.
      //
      // So the race is reproduced deterministically instead: a thin wrapper around
      // the real DataSource lets a genuine, independent "concurrent" accept commit
      // in the exact gap between this call's own SELECT and its UPDATE, which is
      // the one interleaving that actually matters. The SQL PlacementService issues
      // is untouched — only the timing is controlled.
      const candidateId = await seedCandidate();

      // The "other" request that wins the race: a second, real candidate accepted
      // in full so its promoted event is a genuine ci.events row (promoted_event_id
      // has a real FK to ci.events).
      const winnerCandidateId = await seedCandidate();
      await placementService.acceptCandidate(ctx, winnerCandidateId, new Date(Date.now() + 1_800_000));
      const [{ promoted_event_id: winnerEventId }] = await dataSource.query(
        `SELECT promoted_event_id FROM ci.event_candidates WHERE candidate_id = $1`,
        [winnerCandidateId],
      );

      // Wraps the real DataSource so the ONE query matching PlacementService's
      // initial "is this candidate still open" SELECT triggers a fully independent
      // accept of the SAME row before this call's own claiming UPDATE runs — the
      // precise interleaving a second concurrent request would produce.
      let armed = true;
      const racingDataSource = {
        query: async (sql: string, params?: unknown[]) => {
          const result: unknown = await dataSource.query(sql, params);

          if (armed && sql.includes('FROM ci.event_candidates') && sql.includes("status = 'open'")) {
            armed = false; // once — the closing UPDATE must not also match this
            await dataSource.query(
              `UPDATE ci.event_candidates
                SET status = 'accepted', promoted_event_id = $2, feedback_at = NOW()
              WHERE candidate_id = $1`,
              [candidateId, winnerEventId],
            );
          }

          return result;
        },
      } as unknown as DataSource;

      const racingPlacementService = new PlacementService(racingDataSource, eventService);

      await expect(
        racingPlacementService.acceptCandidate(ctx, candidateId, new Date(Date.now() + 3_600_000)),
      ).rejects.toThrow('schedule accept lost the candidate claim');

      // The already-committed winner's claim must survive untouched — the loser's
      // UPDATE (`WHERE status <> 'accepted'`) must not have overwritten it.
      const [row] = await dataSource.query(
        `SELECT status, promoted_event_id FROM ci.event_candidates WHERE candidate_id = $1`,
        [candidateId],
      );
      expect(row.status).toBe('accepted');
      expect(row.promoted_event_id).toBe(winnerEventId);

      // And the event the LOSER minted before discovering it lost the claim must
      // not linger as an orphan. `acceptCandidate` rolls it back via
      // `EventService.remove`, which is a deliberate soft delete (`ci.events.is_deleted`,
      // see its doc comment: "restore can bring it back verbatim") rather than a
      // physical delete, so the row itself still exists — it just must be tombstoned.
      const orphans = await dataSource.query(
        `SELECT event_id FROM ci.events
          WHERE user_id = $1 AND inference_sources->>'candidate_id' = $2 AND is_deleted = false`,
        [ctx.userId, candidateId],
      );
      expect(orphans).toHaveLength(0);
    });
  },
);
