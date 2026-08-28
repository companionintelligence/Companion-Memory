import { randomUUID } from 'node:crypto';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { ConnectionSyncJobService } from '../ConnectionSyncJobService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The two atomic claims, against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `claimPending` and `claimTransform` exist for exactly one reason: two
 * concurrently-dequeued deliveries of the same sync job must resolve to one
 * winner. No mocked test can establish that. It is a property of Postgres row
 * locking — the loser's UPDATE blocks on the winner's lock and then re-evaluates
 * its own WHERE against the committed row — and of the driver, which does NOT
 * hand back the RETURNING rows for an UPDATE but the pair `[rows, rowCount]`.
 *
 * That second detail is the whole point of preferring a real database here. The
 * first version of these claims read the pair as if it were the rows, so
 * `rows.length > 0` was true even for a claim that matched nothing, and every
 * caller "won". The mocked suite never saw it, because the mock returned a bare
 * `[]` for the no-match case — a shape the driver never produces. Nothing but
 * the real driver can keep that class of bug from coming back.
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ConnectionSyncJobService.claim.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

describeWithDatabase(
  `ConnectionSyncJobService claims, against real Postgres (${availability.target})`,
  () => {
    let scratch: ScratchDatabase;
    let service: ConnectionSyncJobService;

    const SYSTEM_CONTEXT = { userId: SYSTEM_USER } as ServiceContext;
    const userId = randomUUID();
    const connectionId = randomUUID();

    beforeAll(async () => {
      scratch = await ScratchDatabase.create({
        createdBy: 'ConnectionSyncJobService.claim.integration.spec',
      });

      await scratch.assertOwn();

      // The scratch DataSource maps no entities (the migrations are the schema),
      // and the claims reach Postgres through `repository.manager` alone — so the
      // manager is all the service needs to run its real SQL.
      const logger = {
        setContext: () => undefined,
        log: () => undefined,
        debug: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };

      service = new ConnectionSyncJobService(
        { manager: scratch.dataSource.manager } as never,
        logger as never,
      );
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    /**
     * One sync job row, in whatever state the case under test needs.
     *
     * Each row gets an endpoint name of its own: these cases share one
     * connection and leave their rows behind, and
     * `connection_sync_jobs_live_job_idx` permits only one live (pending or
     * in-progress) job per (connection, endpoint, type).
     */
    let seedCount = 0;

    async function seedSyncJob(
      overrides: { status?: string; lastTransformed?: Date | null; transformClaimedAt?: Date | null } = {},
    ): Promise<string> {
      const id = randomUUID();

      seedCount += 1;

      await scratch.dataSource.query(
        `INSERT INTO ci_etl.connection_sync_jobs
         (id, user_id, connection_id, endpoint_name, status, type, last_transformed, transform_claimed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::ci_etl.job_status, 'incremental', $6, $7)`,
        [
          id,
          userId,
          connectionId,
          `messages-${seedCount}`,
          overrides.status ?? 'pending',
          overrides.lastTransformed ?? null,
          overrides.transformClaimedAt ?? null,
        ],
      );

      return id;
    }

    async function readRow(id: string): Promise<{ status: string; transform_claimed_at: Date | null }> {
      const [row] = (await scratch.dataSource.query(
        `SELECT status, transform_claimed_at FROM ci_etl.connection_sync_jobs WHERE id = $1::uuid`,
        [id],
      )) as Array<{ status: string; transform_claimed_at: Date | null }>;

      return row;
    }

    describe('claimPending', () => {
      it('resolves two concurrent claims on the same job to exactly one winner', async () => {
        const id = await seedSyncJob();

        const results = await Promise.all([
          service.claimPending(SYSTEM_CONTEXT, id),
          service.claimPending(SYSTEM_CONTEXT, id),
        ]);

        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await readRow(id)).status).toBe('in_progress');
      });

      it('refuses a late redelivery of a job that already completed', async () => {
        const id = await seedSyncJob({ status: 'success' });

        await expect(service.claimPending(SYSTEM_CONTEXT, id)).resolves.toBe(false);
        // The guard that matters: a lost claim must not resurrect the row and
        // re-run the provider fetch.
        expect((await readRow(id)).status).toBe('success');
      });

      it('refuses a claim scoped to a different user', async () => {
        const id = await seedSyncJob();

        await expect(service.claimPending({ userId: randomUUID() } as ServiceContext, id)).resolves.toBe(
          false,
        );
        expect((await readRow(id)).status).toBe('pending');
      });
    });

    describe('claimTransform', () => {
      it('resolves two concurrent claims on the same job to exactly one winner', async () => {
        const id = await seedSyncJob({ status: 'success' });

        const results = await Promise.all([
          service.claimTransform(SYSTEM_CONTEXT, id),
          service.claimTransform(SYSTEM_CONTEXT, id),
        ]);

        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await readRow(id)).transform_claimed_at).not.toBeNull();
      });

      it('refuses a second claim while a fresh claim is still held', async () => {
        const id = await seedSyncJob({ status: 'success', transformClaimedAt: new Date() });

        await expect(service.claimTransform(SYSTEM_CONTEXT, id)).resolves.toBe(false);
      });

      it('re-claims a stale claim, so a crash mid-transform is retried rather than stuck', async () => {
        const id = await seedSyncJob({
          status: 'success',
          transformClaimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        });

        await expect(service.claimTransform(SYSTEM_CONTEXT, id)).resolves.toBe(true);
      });

      it('refuses a job that has already been transformed', async () => {
        const id = await seedSyncJob({ status: 'success', lastTransformed: new Date() });

        await expect(service.claimTransform(SYSTEM_CONTEXT, id)).resolves.toBe(false);
      });
    });
  },
);
