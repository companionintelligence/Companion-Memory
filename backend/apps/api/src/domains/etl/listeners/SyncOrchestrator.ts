import { Injectable } from '@nestjs/common';

import { SYSTEM_USER } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { ConnectionService, ClientFactory, type Connection } from '@ci/domains/connections';
import { OnEvent, EventService } from '@ci/domains/events';

import type { ConnectionSyncJobEntity } from '../entities/ConnectionSyncJobEntity';
import { ConnectionSyncJobExecuteEvent, ConnectionSyncJobTransformEvent } from '../events';
import { ConnectionSyncJobService } from '../services/ConnectionSyncJobService';
import { EndpointServiceMap } from '../services/EndpointServiceMap';
import { LIVE_JOB_STATUSES } from '../types';

/** Sync jobs allowed in flight across the appliance at once. */
const MAX_SYNC_JOBS_IN_FLIGHT = 5;

/** Transform jobs dispatched per tick. */
const MAX_TRANSFORM_JOBS_PER_TICK = 2;

/**
 * How long a job may sit in `in_progress` before the orchestrator gives up on
 * it. Matches the staleness window `ConnectionSyncJobService.claimTransform`
 * uses for an abandoned transform claim.
 */
const STALLED_SYNC_MS = 60 * 60 * 1000;

/**
 * Minimum gap between one incremental sync finishing and the next one being
 * queued for the same endpoint.
 *
 * The first incremental job on a fresh connection is not subject to this — it
 * is created on the first sweep so a new connection shows data straight away.
 * Every one after that used to be queued the moment the previous one
 * succeeded, so each incremental endpoint made a provider call every minute
 * whether or not anything had changed. Two costs: a Facebook connection with
 * three incremental endpoints burned ~180 of its 200 calls/hour on empty
 * `since=` polls, and every one of those polls produced a sync job the
 * transform sweep then had to spend a slot on.
 */
const INCREMENTAL_SYNC_INTERVAL_MS = 10 * 60 * 1000;

/** One endpoint of the provider a connection belongs to. */
type ProviderEndpoint = NonNullable<Connection['provider']>['endpoints'][number];

/** The two ways an endpoint is walked, and half of a sync job's natural key. */
type SyncJobType = 'incremental' | 'historical';

/**
 * Whether a job has been left in `in_progress` long enough to be treated as
 * dead. `updated_at` moves on every write the executor makes, so a job that is
 * genuinely working keeps resetting the window.
 */
function isStalled(job: Pick<ConnectionSyncJobEntity, 'status' | 'updatedAt'>): boolean {
  return job.status === 'in_progress' && Date.now() > new Date(job.updatedAt).getTime() + STALLED_SYNC_MS;
}

// Seconds 5, 8/38 and 15, not 0. These are the appliance's heaviest recurring
// sweeps — four unbounded `search()` calls between them — and both constants
// they replace fire on second 0, where every schedule that never picked one
// already lands. Cadence is unchanged: `CronExpression.EVERY_MINUTE` is
// `*/1 * * * *`, which `cron` right-aligns to second 0 of every minute, and
// `EVERY_30_SECONDS` is `*/30` on the seconds field — seconds 0 and 30, so an
// offset copy needs both halves of the pair. See
// common/schedule/__tests__/cronSecondOffsets.test.ts for who holds what.
const ORCHESTRATE_SYNC_JOBS_CRON = '5 * * * * *';
const EXECUTE_SYNC_JOBS_CRON = '8,38 * * * * *';
const EXECUTE_TRANSFORM_JOBS_CRON = '15 * * * * *';

@Injectable()
export class SyncOrchestrator {
  /** Guards {@link SyncOrchestrator.orchestrateSyncJobs} against overrunning itself. */
  private orchestrating = false;

  constructor(
    private readonly connectionService: ConnectionService,
    private readonly connectionSyncJobService: ConnectionSyncJobService,
    private readonly eventService: EventService,
    private readonly endpointServiceMap: EndpointServiceMap,
    private readonly clientFactory: ClientFactory,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SyncOrchestrator.name);
  }

  /**
   * This method creates sync jobs for connection endpoints that are ready to be run again.
   * For incremental syncs, this is where there are no prior ones, or the last one was successful
   * and finished at least INCREMENTAL_SYNC_INTERVAL_MS ago.
   * For historical syncs, this is where there are no prior ones, or the last one was successful and has a nextCursor,
   * or the last one was successful and has no nextCursor but was completed more than TTL ago.
   */
  @Cron(ORCHESTRATE_SYNC_JOBS_CRON, { name: 'SyncOrchestrator.orchestrateSyncJobs' })
  async orchestrateSyncJobs(): Promise<void> {
    if (!(await this.featureService.isFeatureEnabled('scheduled.connection.sync'))) {
      return;
    }

    // Overlap guard — the same per-process flag AccountPurgeCron and
    // DailyMetricsCron carry. The sweep is a handful of round trips per
    // connection × endpoint × iteration type on a one-minute tick, so it
    // overruns on a box with many connections or a busy database, and the next
    // tick then starts on top of state the previous one is still acting on.
    //
    // A flag and not an advisory lock, deliberately. A boolean says nothing
    // about a second replica, and this cron must not depend on there being only
    // one — which is why the invariant it protects lives in the database
    // instead: `connection_sync_jobs_live_job_idx` lets two orchestrators race
    // to insert the same job and admits exactly one, whatever either process
    // believes. With that in place a lock would buy only what the flag already
    // buys — one process not spending a tick on work it is still doing — at the
    // cost of holding a connection for the length of the sweep.
    if (this.orchestrating) {
      this.logger.warn('Skipping sync orchestration; previous run still in progress');

      return;
    }

    this.orchestrating = true;

    try {
      await this.sweepActiveConnections();
    } finally {
      this.orchestrating = false;
    }
  }

  private async sweepActiveConnections(): Promise<void> {
    const activeConnections = await this.connectionService.findActiveConnections();

    // for...of, not forEach. `Array.prototype.forEach` discards the promise an
    // async callback returns, so a rejection inside the body is orphaned: it
    // reaches neither this method's caller, nor the @Cron wrapper, nor Nest's
    // own scheduler catch — it surfaces as an unhandled rejection, which
    // application.ts turns into process.exit(1). The body below makes several
    // awaited database calls and runs every minute, so one pool timeout was
    // enough to restart the API. Awaiting also bounds the concurrency, which was
    // previously every connection × every endpoint at once.
    for (const { connection } of activeConnections) {
      for (const endpoint of connection.activeEndpoints) {
        const providerEndpoint = connection.provider!.endpoints.find((e) => e.name === endpoint);
        if (!providerEndpoint) {
          this.logger.error('Active endpoint not found on provider', {
            connectionId: connection.id,
            endpoint,
          });

          // `continue`, not `return`: inside the old async forEach callback this
          // skipped one endpoint, but in a for...of it would abandon every
          // remaining endpoint AND every remaining connection in the sweep.
          continue;
        }

        const iterationTypes = providerEndpoint.iterationType.split(',');

        if (iterationTypes.includes('incremental')) {
          await this.orchestrateIncremental(connection, endpoint);
        }

        if (iterationTypes.includes('historical')) {
          await this.orchestrateHistorical(connection, endpoint, providerEndpoint);
        }
      }
    }
  }

  /**
   * Incremental: hold one live job per endpoint, and start the next one from the
   * cursor the last successful one left behind — once
   * {@link INCREMENTAL_SYNC_INTERVAL_MS} has passed since that success. The very
   * first job for an endpoint is started immediately.
   */
  private async orchestrateIncremental(connection: Connection, endpoint: string): Promise<void> {
    const live = await this.findLiveJob(connection, endpoint, 'incremental');

    if (live && !isStalled(live)) {
      // A pending job, or one running inside the stall window, IS the next sync.
      //
      // This is the test that used to be inverted: the predicate deciding
      // whether anything was already live counted an in-progress job only once
      // it had gone STALE, so a healthy running sync did not suppress creation
      // and every tick queued another job beside it. Staleness belongs to the
      // recovery path below, not to this one.
      return;
    }

    if (live) {
      await this.failStalledJob(connection, live);
    }

    const lastSuccess = await this.findLatestSuccess(connection, endpoint, 'incremental');

    if (lastSuccess) {
      // `completedAt` is what `handleSyncJobExecuteEvent` stamps on success;
      // `updatedAt` is the fallback for a row that predates that stamp.
      const finishedAt = new Date(lastSuccess.completedAt ?? lastSuccess.updatedAt).getTime();

      if (Date.now() >= finishedAt + INCREMENTAL_SYNC_INTERVAL_MS) {
        await this.createSyncJob(connection, endpoint, 'incremental', lastSuccess.nextCursor);
      }

      return;
    }

    if (!(await this.hasAnyJob(connection, endpoint, 'incremental'))) {
      await this.createSyncJob(connection, endpoint, 'incremental');
    }
  }

  /**
   * Historical: walk the endpoint's pages until the cursor runs out, then leave
   * it alone until its TTL expires.
   */
  private async orchestrateHistorical(
    connection: Connection,
    endpoint: string,
    providerEndpoint: ProviderEndpoint,
  ): Promise<void> {
    const live = await this.findLiveJob(connection, endpoint, 'historical');

    if (live && !isStalled(live)) {
      return;
    }

    if (live) {
      await this.failStalledJob(connection, live);
    }

    const lastSuccess = await this.findLatestSuccess(connection, endpoint, 'historical');

    if (!lastSuccess) {
      if (!(await this.hasAnyJob(connection, endpoint, 'historical'))) {
        await this.createSyncJob(connection, endpoint, 'historical');
      }

      return;
    }

    const nextCursor = lastSuccess.nextCursor ?? {};

    if (Object.keys(nextCursor).length > 0) {
      await this.createSyncJob(connection, endpoint, 'historical', nextCursor);

      return;
    }

    // No cursor left: the endpoint has been walked to the end, so the only
    // reason to walk it again is the provider's TTL expiring.
    if (lastSuccess.completedAt == null || providerEndpoint.TTL == null) {
      return;
    }

    if (Date.now() > new Date(lastSuccess.completedAt).getTime() + providerEndpoint.TTL * 1000) {
      await this.createSyncJob(connection, endpoint, 'historical');
    }
  }

  /**
   * The live job for this endpoint and iteration type, if there is one.
   *
   * At most one can be: `connection_sync_jobs_live_job_idx` is unique over
   * exactly this key while the status is pending or in progress. So `limit: 1`
   * is the whole answer rather than a sample of it — where this read used to
   * fetch the endpoint's ENTIRE history, once a minute, per connection ×
   * endpoint × iteration type, to look at `[0]` and `.length` of it.
   */
  private async findLiveJob(
    connection: Connection,
    endpoint: string,
    type: SyncJobType,
  ): Promise<ConnectionSyncJobEntity | undefined> {
    const [live] = await this.connectionSyncJobService.search(
      { userId: connection.userId },
      {
        connectionId: connection.id,
        userId: connection.userId,
        endpointName: endpoint,
        type,
        statuses: LIVE_JOB_STATUSES,
        orderBy: 'updated_at:DESC',
        limit: 1,
      },
    );

    return live;
  }

  /**
   * The most recently COMPLETED successful job for this endpoint and iteration
   * type.
   *
   * By `completed_at`, not `updated_at`. `updated_at` moves whenever the
   * transform sweep claims or finishes a job, and that sweep now drains its
   * backlog oldest-first — so once a minute some OLD success is touched and,
   * under an `updated_at` sort, became "the latest". Two things followed from
   * that: its `completedAt` was long past the incremental interval, so the
   * back-off never held (a new poll every tick, the exact load the interval
   * exists to remove), and for a historical endpoint an old page still
   * carries its `nextLink`, so the walk restarted from that page — every
   * transform of an old page re-fetched everything after it.
   */
  private async findLatestSuccess(
    connection: Connection,
    endpoint: string,
    type: SyncJobType,
  ): Promise<ConnectionSyncJobEntity | undefined> {
    const [success] = await this.connectionSyncJobService.search(
      { userId: connection.userId },
      {
        connectionId: connection.id,
        userId: connection.userId,
        endpointName: endpoint,
        type,
        status: 'success',
        orderBy: 'completed_at:DESC',
        limit: 1,
      },
    );

    return success;
  }

  /**
   * Whether this endpoint has ever had a job of this type at all.
   *
   * Only asked when there is neither a live job nor a successful one, which is
   * the one case where the two are not enough to decide: it separates "never
   * synced" (start the first job) from "every attempt so far failed" (leave it
   * alone — the orchestrator has never retried a failure, and starting one here
   * would turn a permanently failing endpoint into a per-minute retry loop).
   */
  private async hasAnyJob(connection: Connection, endpoint: string, type: SyncJobType): Promise<boolean> {
    const [any] = await this.connectionSyncJobService.search(
      { userId: connection.userId },
      {
        connectionId: connection.id,
        userId: connection.userId,
        endpointName: endpoint,
        type,
        orderBy: 'updated_at:DESC',
        limit: 1,
      },
    );

    return any != null;
  }

  private async failStalledJob(connection: Connection, job: ConnectionSyncJobEntity): Promise<void> {
    await this.connectionSyncJobService.markAsCompleted({ userId: connection.userId }, job.id, 'failed', {
      error: 'Sync job stalled in progress',
    });
  }

  /**
   * Enqueue one sync job.
   *
   * No check that one does not already exist: the caller has just read that, and
   * a read cannot hold between two statements. A tick that loses the race to
   * another tick or another replica gets the live job back from
   * `ConnectionSyncJobService.create` instead of a second row.
   */
  private async createSyncJob(
    connection: Connection,
    endpoint: string,
    type: SyncJobType,
    cursor?: Record<string, unknown>,
  ): Promise<void> {
    await this.connectionSyncJobService.create(
      { userId: connection.userId },
      {
        connectionId: connection.id,
        userId: connection.userId,
        endpointName: endpoint,
        type,
        status: 'pending',
        ...(cursor != null && { cursor }),
      },
    );
  }

  /**
   * This method finds sync jobs that are ready to be run (status pending) and executes them.
   * It will only execute one endpoint job per connection to avoid rate limits.
   * It will also limit itself to 5 total jobs in progress to avoid overwhelming the system.
   */
  @Cron(EXECUTE_SYNC_JOBS_CRON, { name: 'SyncOrchestrator.executeSyncJobs' })
  async executeSyncJobs(): Promise<void> {
    // This cron is the only executor of pending sync jobs, including the ones
    // `SyncNowService` enqueues from POST /connections/sync-now — so turning
    // `scheduled.connection.sync` off stops every outbound provider fetch, not
    // just the ones `orchestrateSyncJobs` created. That is the point of the
    // switch: an operator reaching for it wants the appliance to stop calling
    // out. Nothing is lost — the rows stay `pending` and run when it is back on.
    if (!(await this.featureService.isFeatureEnabled('scheduled.connection.sync'))) {
      return;
    }

    // Both reads are bounded by what this tick can actually dispatch. They used
    // to be two unbounded `search()` calls — every pending row and every
    // in-progress row on the box, hydrated into entities twice a minute, to
    // pick at most five ids out of them — against a table whose only index is
    // its primary key and which nothing prunes.
    const inFlight = await this.connectionSyncJobService.countInProgress(
      { userId: SYSTEM_USER },
      MAX_SYNC_JOBS_IN_FLIGHT,
    );

    const budget = MAX_SYNC_JOBS_IN_FLIGHT - inFlight;

    if (budget <= 0) {
      return;
    }

    // One id per connection with nothing already in flight, oldest first — the
    // two rules above, applied in SQL. They cannot be applied to a truncated
    // list, so the bound has to travel with them.
    const syncJobsToRun = await this.connectionSyncJobService.findDispatchablePending(
      { userId: SYSTEM_USER },
      budget,
    );

    for (const jobId of syncJobsToRun) {
      // Keyed on the sync job id: the send this key guards against is
      // `executeSyncJobs` re-sending the SAME job on the next 30-second tick
      // while it is still pending, not two different jobs.
      await this.eventService.send(
        ConnectionSyncJobExecuteEvent,
        { connectionSyncJobId: jobId },
        { singletonKey: jobId },
      );
    }
  }

  @OnEvent(ConnectionSyncJobExecuteEvent, { queue: 'etl', queueOptions: { policy: 'short' } })
  async handleSyncJobExecuteEvent(payload: { connectionSyncJobId: string }): Promise<void> {
    const syncJob = await this.connectionSyncJobService.findById(
      { userId: SYSTEM_USER },
      payload.connectionSyncJobId,
    );

    if (!syncJob) {
      this.logger.error('Sync job not found for execution', {
        connectionSyncJobId: payload.connectionSyncJobId,
      });

      return;
    }

    // Claim. `executeSyncJobs` now sends with a singletonKey and the `etl`
    // queue below is declared `policy: 'short'`, so pg-boss refuses a second
    // PENDING job for the same sync job while one is still queued (created).
    // That alone does not cover a redelivery of a job already dequeued once —
    // pg-boss 10's short-policy uniqueness index only applies to jobs still in
    // the `created` state — so the real gate stays here: a single atomic
    // `UPDATE ... WHERE status = 'pending' ... RETURNING`, not a separate read
    // and write, so two concurrently-dequeued redeliveries of the same job
    // cannot both read `pending` before either commits `in_progress`. It also
    // stops a completed row from being resurrected by a late redelivery.
    const claimed = await this.connectionSyncJobService.claimPending({ userId: SYSTEM_USER }, syncJob.id);

    if (!claimed) {
      this.logger.debug('Sync job is no longer pending; skipping duplicate delivery', {
        connectionSyncJobId: syncJob.id,
        status: syncJob.status,
      });

      return;
    }

    let connection = await this.connectionService.findById({ userId: SYSTEM_USER }, syncJob.connectionId);

    if (!connection) {
      this.logger.error('Connection not found for sync job execution', {
        connectionId: syncJob.connectionId,
        connectionSyncJobId: syncJob.id,
      });

      await this.connectionSyncJobService.markAsCompleted({ userId: SYSTEM_USER }, syncJob.id, 'failed', {
        error: 'Connection not found',
      });

      return;
    }

    if (!connection.provider) {
      this.logger.error('Provider not found for connection during sync job execution', {
        connectionId: connection.id,
        connectionSyncJobId: syncJob.id,
      });

      await this.connectionSyncJobService.markAsCompleted({ userId: SYSTEM_USER }, syncJob.id, 'failed', {
        error: 'Provider not found for connection',
      });

      return;
    }

    const { refreshToken, tokenExpiry } = connection;
    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

    if (refreshToken && tokenExpiry && new Date(tokenExpiry) < new Date()) {
      let newCredentials;
      const refreshCredentials = await client.refreshAccessToken(connection);

      //Some providers explicitly return null for refreshToken, which was overwriting the
      //existing refreshToken. Strip it out in those cases.
      if (refreshCredentials.refreshToken == null) {
        const { refreshToken, ...stripped } = refreshCredentials;
        newCredentials = stripped;
      } else {
        newCredentials = { ...refreshCredentials };
      }

      connection = await this.connectionService.update({ userId: connection.userId }, connection.id, {
        ...newCredentials,
      });
    }

    const providerName = connection!.provider!.name;

    const serviceFunction = this.endpointServiceMap.getSyncFunction(providerName!, syncJob.endpointName);

    if (!serviceFunction) {
      this.logger.error('No service function found for provider and endpoint', {
        providerName,
        endpointName: syncJob.endpointName,
      });

      await this.connectionSyncJobService.markAsCompleted({ userId: SYSTEM_USER }, syncJob.id, 'failed', {
        error: 'No service function found for provider and endpoint',
      });

      return;
    }

    try {
      const results = await serviceFunction({
        connection: connection!,
        client,
        nextCursor: syncJob.cursor!,
        historical: syncJob.type === 'historical',
      });

      const completedAt = new Date();

      await this.connectionSyncJobService.update({ userId: SYSTEM_USER }, syncJob.id, {
        data: results.data,
        nextCursor: results.nextCursor || {},
        error: undefined,
        status: 'success',
        completedAt,
      });

      // Stamp the connection itself, not just the job row.
      //
      // `syncState.lastSyncedAt` was already the convention — `findActiveConnections`
      // reads exactly this key for its own summary — but nothing in the codebase
      // ever WROTE it, so every reader got null forever and the UI's "synced N
      // days ago" could never appear. The successful completion of a sync job is
      // the one moment that fact is true, so it is recorded here.
      //
      // Merged into the existing object rather than replacing it: syncState also
      // carries per-endpoint cursors that the next run needs.
      await this.connectionService.update({ userId: connection!.userId }, connection!.id, {
        syncState: {
          ...(connection!.syncState ?? {}),
          lastSyncedAt: completedAt.toISOString(),
        },
      });
    } catch (err) {
      this.logger.error('Error executing sync job', {
        connectionSyncJobId: syncJob.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });

      await this.connectionSyncJobService.markAsCompleted({ userId: SYSTEM_USER }, syncJob.id, 'failed', {
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  /**
   * This method finds sync jobs that need to be transformed, retrieves their data, then
   * calls the appropriate transformation function based on the connection and endpoint.
   */
  @Cron(EXECUTE_TRANSFORM_JOBS_CRON, { name: 'SyncOrchestrator.executeTransformJobs' })
  async executeTransformJobs(): Promise<void> {
    if (!(await this.featureService.isFeatureEnabled('scheduled.connection.sync'))) {
      return;
    }

    // `limit`, not a `.slice()` on the result: the cap has always been two, but
    // it used to be applied in JavaScript after Postgres had returned — and
    // hydrated — every untransformed successful sync job in the table.
    const syncJobsToTransform = await this.connectionSyncJobService.search(
      { userId: SYSTEM_USER },
      {
        status: 'success',
        lastTransformed: null,
        // A transform in flight is not work this tick can start. The claim
        // below already refuses the duplicate, but without this the sweep
        // spends both of its two slots re-sending the same long transform
        // every minute until it finishes, starving the queue behind it.
        transformClaimable: true,
        // Oldest first, and this is not a style choice. This sweep is one
        // queue for the whole appliance — two slots a minute across EVERY
        // connection — and the sync executor completes up to two jobs a
        // minute PER connection. The moment a second connection existed the
        // backlog grew every minute, and with newest-first the two slots always
        // went to the two jobs that had just finished, so whatever had once
        // fallen a minute behind was never looked at again: a Facebook
        // connection's entire historical Posts and Photos payload sat
        // untransformed beside hundreds of empty incremental polls, and the
        // Google connection sharing the box started silently dropping Gmail
        // history pages the same minute. Oldest-first turns the backlog into a
        // queue that drains instead of a graveyard. ASC walks
        // `connection_sync_jobs_untransformed_idx` (updated_at, id) forward,
        // so it costs no more than DESC did.
        orderBy: 'updated_at:ASC',
        limit: MAX_TRANSFORM_JOBS_PER_TICK,
      },
    );

    for (const { id } of syncJobsToTransform) {
      // Keyed on the sync job id, same reasoning as the execute send above.
      await this.eventService.send(
        ConnectionSyncJobTransformEvent,
        { connectionSyncJobId: id },
        { singletonKey: id },
      );
    }
  }

  @OnEvent(ConnectionSyncJobTransformEvent, { queue: 'etl', queueOptions: { policy: 'short' } })
  async handleSyncJobTransformEvent(payload: { connectionSyncJobId: string }): Promise<void> {
    const syncJob = await this.connectionSyncJobService.findById(
      { userId: SYSTEM_USER },
      payload.connectionSyncJobId,
    );

    if (!syncJob) {
      this.logger.error('Sync job not found for transformation', {
        connectionSyncJobId: payload.connectionSyncJobId,
      });

      return;
    }

    // The self-DoS this prevents: `executeTransformJobs` runs every minute and
    // selects rows with `lastTransformed: null`, which is only written on
    // COMPLETION — and `updated_at` does not move while the transform runs. So
    // any transform exceeding 60 seconds was re-enqueued once a minute until it
    // finished, and with the `etl` per-queue ceiling of 6 a five-minute
    // transform ended up with six concurrent copies of itself, each holding a
    // slot. GmailTransformService.transformGmail routinely exceeds a minute.
    //
    // A plain `lastTransformed == null` read only ever caught a REDELIVERY
    // after the job had already finished — it did nothing while a transform
    // was still in flight, which is exactly the five-minute case above. The
    // singletonKey + `policy: 'short'` on this queue only stop a second
    // PENDING job from being created while one is still queued (created); they
    // say nothing once the first has been dequeued. So the claim itself is the
    // gate: a single atomic UPDATE, not a read followed by a later write, so
    // only one concurrent caller ever wins it.
    const claimed = await this.connectionSyncJobService.claimTransform({ userId: SYSTEM_USER }, syncJob.id);

    if (!claimed) {
      this.logger.debug('Sync job is already claimed or transformed; skipping duplicate delivery', {
        connectionSyncJobId: syncJob.id,
      });

      return;
    }

    const connection = await this.connectionService.findById({ userId: SYSTEM_USER }, syncJob.connectionId);

    if (!connection) {
      this.logger.error('Connection not found for transformation', {
        connectionSyncJobId: payload.connectionSyncJobId,
      });

      return;
    }

    const providerName = connection!.provider!.name;

    const serviceFunction = this.endpointServiceMap.getTransformFunction(providerName!, syncJob.endpointName);

    if (!serviceFunction) {
      this.logger.error('No service function found for provider and endpoint transform', {
        providerName,
        endpointName: syncJob.endpointName,
      });

      return;
    }

    try {
      await serviceFunction({
        syncJob,
        connection,
      });

      await this.connectionSyncJobService.update({ userId: SYSTEM_USER }, syncJob.id, {
        lastTransformed: new Date(),
      });

      await this.logger.log('Successfully transformed sync job', {
        connectionSyncJobId: syncJob.id,
      });
    } catch (err) {
      this.logger.error('Error transforming sync job', {
        connectionSyncJobId: syncJob.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });

      // Mark transformed so a failed/heavy job does not re-queue forever after API OOM restarts.
      await this.connectionSyncJobService.update({ userId: SYSTEM_USER }, syncJob.id, {
        lastTransformed: new Date(),
        error: {
          transformError: err instanceof Error ? err.message : 'Unknown error',
        },
      });
    }
  }
}
