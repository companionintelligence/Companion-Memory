import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { ConnectionSyncJobEntity } from '../entities/ConnectionSyncJobEntity';
import {
  LIVE_JOB_STATUSES,
  type ConnectionSyncJob,
  type CreateConnectionSyncJobDto,
  type SearchConnectionSyncJobDto,
  type UpdateConnectionSyncJobDto,
} from '../types';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * The partial unique index over (connection_id, endpoint_name, type) while a job
 * is pending or in progress — migration
 * `20260821064758_add_connection_sync_jobs_live_job_unique`.
 */
const LIVE_JOB_INDEX = 'connection_sync_jobs_live_job_idx';

/**
 * Whether this error is the live-job index refusing a second live job.
 *
 * Both spellings are checked because TypeORM's `QueryFailedError` copies the
 * driver error's own properties onto itself but also keeps the original under
 * `driverError`, and which one a caller sees depends on how the error was
 * re-thrown on the way up.
 */
function isLiveJobConflict(err: unknown): boolean {
  const driverError = (err as { driverError?: { code?: string; constraint?: string } }).driverError;
  const code = (err as { code?: string }).code ?? driverError?.code;
  const constraint = (err as { constraint?: string }).constraint ?? driverError?.constraint;

  return code === UNIQUE_VIOLATION && constraint === LIVE_JOB_INDEX;
}

@Injectable()
export class ConnectionSyncJobService {
  constructor(
    @InjectRepository(ConnectionSyncJobEntity)
    private readonly connectionSyncJobRepository: Repository<ConnectionSyncJobEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConnectionSyncJobService.name);
  }

  /**
   * Create a sync job, or return the live one that already exists for the same
   * connection endpoint and iteration type.
   *
   * Every caller here is a read-then-write: `SyncOrchestrator.orchestrateSyncJobs`
   * and `SyncNowService.enqueueForUser` both look for live work and then, in a
   * separate statement, insert if they saw none. Two overlapping cron ticks, two
   * replicas, or a sync-now request racing the cron could all pass that check
   * concurrently and create duplicates — each of which is dispatched
   * independently, so the provider is fetched twice.
   *
   * `connection_sync_jobs_live_job_idx` is what actually prevents that, and the
   * loser of the race lands here: a violation of that index is not a failure but
   * the answer "somebody already created it", so the row it collided with is
   * returned instead. Handled in the service rather than in one caller because
   * the constraint binds all three of them, and an unhandled 23505 in
   * `SyncNowService` would surface to the user as a 500.
   *
   * A caller may name the id (`createConnectionSyncJob` takes one). An id held
   * by the caller's own row updates that row, as it always has; an id held by
   * anyone else's is refused — see {@link findJobToWrite}.
   */
  async create(context: UserServiceContext, data: CreateConnectionSyncJobDto): Promise<ConnectionSyncJob> {
    const id = data.id ?? uuidv7();
    // Only a caller-named id can already be a row.
    const existing = data.id == null ? null : await this.findJobToWrite(context.userId, data.id);

    const SyncJob = this.connectionSyncJobRepository.create({
      id,
      userId: data.userId,
      connectionId: data.connectionId,
      jobId: data.jobId ?? null,
      endpointName: data.endpointName,
      status: data.status ?? 'pending',
      type: data.type,
      cursor: data.cursor || {},
      properties: data.properties ?? null,
    });

    try {
      // Only a row this call found and checked may go through save(); see insertJob.
      const result =
        existing == null
          ? await this.insertJob(SyncJob)
          : await this.connectionSyncJobRepository.save(SyncJob);

      return ConnectionSyncJobEntity.toEgressType(result);
    } catch (err) {
      if (!isLiveJobConflict(err)) {
        throw err;
      }

      const [live] = await this.search(context, {
        connectionId: data.connectionId,
        endpointName: data.endpointName,
        type: data.type,
        statuses: LIVE_JOB_STATUSES,
        orderBy: 'updated_at:DESC',
        limit: 1,
      });

      // The conflicting row is gone already — it reached a terminal status
      // between the INSERT and this read. Nothing to hand back, and swallowing
      // the error would leave the caller with no job at all.
      if (!live) {
        throw err;
      }

      this.logger.debug('Live sync job already exists for endpoint; returning it', {
        connectionId: data.connectionId,
        endpointName: data.endpointName,
        type: data.type,
        connectionSyncJobId: live.id,
      });

      return ConnectionSyncJobEntity.toEgressType(live);
    }
  }

  /**
   * The row a create naming `id` for `userId` lands on, or `null` when no row
   * holds `id`.
   *
   * Looked up by primary key alone, because `id` is the whole key: a row
   * holding it is the row TypeORM's save() would UPDATE, whoever owns it. An
   * owner filter here would only hide another user's row, and save() then took
   * it over — `user_id` flipped to the caller, the job's endpoint, status and
   * cursor overwritten, and the provider payload in `data` left in place for
   * the caller to read back. Another user's row is refused.
   */
  private async findJobToWrite(userId: string, id: string): Promise<ConnectionSyncJobEntity | null> {
    const job = await this.connectionSyncJobRepository.findOne({ where: { id } });

    if (job && job.userId !== userId) {
      throw new ForbiddenException(`Sync job ${id} is not owned by ${userId}; refusing to write it`);
    }

    return job;
  }

  /**
   * INSERT a job {@link findJobToWrite} found no row for, and return it with
   * the defaults Postgres filled in. Not save(): that loads the primary key
   * alone and UPDATEs whatever row it finds, so a row that took the id after
   * the lookup — another user's included — would be overwritten. A plain
   * INSERT fails on `connection_sync_jobs_pkey` instead, and still fails on
   * `connection_sync_jobs_live_job_idx` for a second live job.
   */
  private async insertJob(job: ConnectionSyncJobEntity): Promise<ConnectionSyncJobEntity> {
    await this.connectionSyncJobRepository
      .createQueryBuilder()
      .insert()
      // `metadata.target`, as in PlaceService: the entity class would narrow
      // `.values()` to `_QueryDeepPartialEntity`, which rejects the jsonb columns.
      .into(this.connectionSyncJobRepository.metadata.target)
      .values(job)
      .execute();

    return job;
  }

  async findAll(context: UserServiceContext): Promise<ConnectionSyncJob[]> {
    const result = await this.connectionSyncJobRepository.find({
      where: {
        userId: context.userId,
      },
      relations: ['user', 'connection'],
    });

    return result.map((entity) => ConnectionSyncJobEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<ConnectionSyncJob | null> {
    const result = await this.connectionSyncJobRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: ['user', 'connection'],
    });

    return result ? ConnectionSyncJobEntity.toEgressType(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(ConnectionSyncJob | null)[]> {
    const result = await this.connectionSyncJobRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: ['user', 'connection'],
    });

    const map = new Map(result.map((SyncJob) => [SyncJob.id, ConnectionSyncJobEntity.toEgressType(SyncJob)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findByConnectionId(
    context: ServiceContext,
    connectionId: string,
    endpointName?: string,
    type?: string,
  ): Promise<ConnectionSyncJob[]> {
    const result = await this.connectionSyncJobRepository.find({
      where: {
        connectionId,
        ...(endpointName != null && { endpointName }),
        ...(type != null && { type }),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: ['user', 'connection'],
      order: {
        createdAt: 'DESC',
      },
    });

    return result.map((entity) => ConnectionSyncJobEntity.toEgressType(entity));
  }

  async findByJobId(context: ServiceContext, jobId: string): Promise<ConnectionSyncJob[]> {
    const result = await this.connectionSyncJobRepository.find({
      where: {
        jobId,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: ['user', 'connection'],
      order: {
        createdAt: 'DESC',
      },
    });

    return result.map((entity) => ConnectionSyncJobEntity.toEgressType(entity));
  }

  async update(
    context: ServiceContext,
    id: string,
    data: UpdateConnectionSyncJobDto,
  ): Promise<ConnectionSyncJob | null> {
    const updateData: Partial<ConnectionSyncJobEntity> = {};

    if (data.jobId !== undefined) {
      updateData.jobId = data.jobId;
    }

    if (data.endpointName !== undefined) {
      updateData.endpointName = data.endpointName;
    }

    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    if (data.data !== undefined) {
      updateData.data = data.data;
    }

    if (data.type !== undefined) {
      updateData.type = data.type;
    }

    if (data.cursor !== undefined) {
      updateData.cursor = data.cursor;
    }

    if (data.nextCursor !== undefined) {
      updateData.nextCursor = data.nextCursor;
    }

    if (data.properties !== undefined) {
      updateData.properties = data.properties;
    }

    if (data.error !== undefined) {
      updateData.error = data.error;
    }

    if (data.completedAt !== undefined) {
      updateData.completedAt = data.completedAt;
    }

    if (data.lastTransformed !== undefined) {
      updateData.lastTransformed = data.lastTransformed;
    }

    const SyncJob = await this.connectionSyncJobRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (SyncJob) {
      Object.assign(SyncJob, updateData);
      await this.connectionSyncJobRepository.save(SyncJob);
    } else {
      return null;
    }

    return this.findById(context, id);
  }

  async delete(context: ServiceContext, id: string): Promise<boolean> {
    const SyncJob = await this.connectionSyncJobRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (!SyncJob) {
      return false;
    }

    await this.connectionSyncJobRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    return true;
  }

  /**
   * Atomically transitions one job from `pending` to `in_progress`, returning
   * whether this call won the claim.
   *
   * `handleSyncJobExecuteEvent` used to read `status` and then, in a separate
   * call, write `in_progress` — two concurrently-dequeued redeliveries of the
   * same job (pg-boss's `singletonKey` only refuses a second PENDING send; it
   * says nothing about a job already dequeued once and delivered again) could
   * both read `pending` before either committed `in_progress`, and both run
   * the sync. Folding the read and the write into one statement means only
   * one caller's UPDATE can match the row.
   */
  async claimPending(context: ServiceContext, id: string): Promise<boolean> {
    const scoped = context.userId !== SYSTEM_USER;

    return this.wonClaim(
      `UPDATE ci_etl.connection_sync_jobs
          SET status = 'in_progress', updated_at = now()
        WHERE id = $1::uuid AND status = 'pending'${scoped ? ' AND user_id = $2::uuid' : ''}
        RETURNING id`,
      scoped ? [id, context.userId] : [id],
    );
  }

  /**
   * Atomically claims one job for transformation, returning whether this call
   * won the claim.
   *
   * `lastTransformed` alone only marks completion, so a transform still
   * running past the next `executeTransformJobs` tick was re-enqueued and run
   * again alongside itself — see `SyncOrchestrator.handleSyncJobTransformEvent`.
   * The claim goes stale (and is re-claimable) after an hour, the same window
   * `orchestrateSyncJobs` already uses for a stalled sync job, so a crash
   * mid-transform is retried rather than stuck forever.
   */
  async claimTransform(context: ServiceContext, id: string): Promise<boolean> {
    const scoped = context.userId !== SYSTEM_USER;

    return this.wonClaim(
      `UPDATE ci_etl.connection_sync_jobs
          SET transform_claimed_at = now(), updated_at = now()
        WHERE id = $1::uuid
          AND last_transformed IS NULL
          AND (transform_claimed_at IS NULL OR transform_claimed_at < now() - interval '1 hour')
          ${scoped ? 'AND user_id = $2::uuid' : ''}
        RETURNING id`,
      scoped ? [id, context.userId] : [id],
    );
  }

  /**
   * Runs a `UPDATE ... RETURNING id` claim and reports whether it matched a row.
   *
   * TypeORM's Postgres driver special-cases UPDATE/DELETE and resolves
   * `query()` to the pair `[rows, rowCount]` rather than to the RETURNING rows
   * (`driver/postgres/PostgresQueryRunner.ts`), unlike a SELECT, which resolves
   * to the rows on their own. So a claim that matched nothing arrives as
   * `[[], 0]` — whose own `.length` is 2. Treating that pair AS the rows makes
   * every claim "win" and the whole atomic claim inert; `personalization/
   * placement.ts` shipped the identical bug for the same reason.
   */
  private async wonClaim(sql: string, params: unknown[]): Promise<boolean> {
    const [rows] = (await this.connectionSyncJobRepository.manager.query(sql, params)) as [
      Array<{ id: string }>,
      number,
    ];

    return rows.length > 0;
  }

  /**
   * How many jobs are in flight, counted no further than `cap`.
   *
   * `executeSyncJobs` only ever needs this to work out how much of its
   * five-job budget is left, so the count stops at the cap: the LIMIT lets
   * Postgres abandon the scan after `cap` rows instead of reading every
   * historical row in a table whose only index is its primary key and which
   * nothing prunes.
   */
  async countInProgress(context: ServiceContext, cap: number): Promise<number> {
    const scoped = context.userId !== SYSTEM_USER;

    const rows = (await this.connectionSyncJobRepository.manager.query(
      `SELECT count(*)::int AS count
         FROM (SELECT 1
                 FROM ci_etl.connection_sync_jobs
                WHERE status = 'in_progress'${scoped ? ' AND user_id = $2::uuid' : ''}
                LIMIT $1) capped`,
      scoped ? [cap, context.userId] : [cap],
    )) as Array<{ count: number }>;

    return rows[0]?.count ?? 0;
  }

  /**
   * The pending jobs `executeSyncJobs` may dispatch this tick: the oldest
   * pending job of each connection that has nothing already in flight, oldest
   * connection first, at most `limit` of them.
   *
   * Both of that cron's rules are expressed here rather than in the caller
   * because the caller cannot apply them to a truncated list. A plain
   * `status = 'pending'` search bounded at `limit` can hand back nothing but
   * rows whose connections are already busy — dispatching nothing while work
   * waits — and an unbounded one hydrates every pending row on the box twice a
   * minute. The `DISTINCT ON` picks each connection's oldest pending row, and
   * the outer sort then spends the budget on the connections that have waited
   * longest.
   *
   * `updated_at` is not unique, so both sorts carry the primary key as a
   * tiebreaker: without it the LIMIT would pick an arbitrary member of a tied
   * group, and a different one on the next tick.
   */
  async findDispatchablePending(context: ServiceContext, limit: number): Promise<string[]> {
    if (limit <= 0) {
      return [];
    }

    const scoped = context.userId !== SYSTEM_USER;

    const rows = (await this.connectionSyncJobRepository.manager.query(
      `SELECT id
         FROM (SELECT DISTINCT ON (connection_id) id, updated_at
                 FROM ci_etl.connection_sync_jobs pending
                WHERE pending.status = 'pending'
                  ${scoped ? 'AND pending.user_id = $2::uuid' : ''}
                  AND NOT EXISTS (SELECT 1
                                    FROM ci_etl.connection_sync_jobs busy
                                   WHERE busy.connection_id = pending.connection_id
                                     AND busy.status = 'in_progress'
                                     ${scoped ? 'AND busy.user_id = $2::uuid' : ''})
                ORDER BY connection_id, updated_at ASC, id ASC) dispatchable
        ORDER BY updated_at ASC, id ASC
        LIMIT $1`,
      scoped ? [limit, context.userId] : [limit],
    )) as Array<{ id: string }>;

    return rows.map((row) => row.id);
  }

  async markAsCompleted(
    context: ServiceContext,
    id: string,
    status: 'success' | 'failed',
    error?: Record<string, unknown>,
  ): Promise<ConnectionSyncJob | null> {
    return this.update(context, id, {
      status,
      completedAt: new Date(),
      ...(error && { error }),
    });
  }

  async search(
    context: ServiceContext,
    query: SearchConnectionSyncJobDto,
  ): Promise<ConnectionSyncJobEntity[]> {
    let executable = this.connectionSyncJobRepository.createQueryBuilder('syncJob');

    if (context.userId !== SYSTEM_USER) {
      executable = executable.where('user_id = :userId', { userId: context.userId });
    }

    if (query.connectionId) {
      executable = executable.andWhere('connection_id = :connectionId', { connectionId: query.connectionId });
    }

    if (query.jobId) {
      executable = executable.andWhere('job_id = :jobId', { jobId: query.jobId });
    }

    if (query.endpointName) {
      executable = executable.andWhere('endpoint_name = :endpointName', { endpointName: query.endpointName });
    }

    if (query.status) {
      executable = executable.andWhere('status = :status', { status: query.status });
    }

    if (query.statuses != null && query.statuses.length > 0) {
      executable = executable.andWhere('status IN (:...statuses)', { statuses: [...query.statuses] });
    }

    if (query.type) {
      executable = executable.andWhere('type = :type', { type: query.type });
    }

    if (query.properties) {
      for (const [key, val] of Object.entries(query.properties)) {
        executable = executable.andWhere(`item.properties->>'${key}' = :${key}`, { [key]: val });
      }
    }

    if (query.lastTransformed === null) {
      executable = executable.andWhere('last_transformed IS NULL');
    }

    if (query.lastTransformed != null) {
      executable = executable.andWhere('last_transformed >= :lastTransformed', {
        lastTransformed: query.lastTransformed,
      });
    }

    // Mirrors claimTransform's own condition, staleness window included. The
    // sweep that feeds it re-selects every minute, so without this a transform
    // still running is re-sent once a minute for its whole duration and the
    // claim discards each one. Excluding merely `transform_claimed_at IS NOT
    // NULL` would be wrong in the other direction: a worker killed mid-transform
    // would never be picked up again.
    if (query.transformClaimable === true) {
      executable = executable.andWhere(
        `(transform_claimed_at IS NULL OR transform_claimed_at < now() - interval '1 hour')`,
      );
    }

    let ordered = false;

    if (query.orderBy != null) {
      const [field, direction] = query.orderBy.split(':');
      if (direction !== 'DESC' && direction !== 'ASC') {
        this.logger.warn('Invalid orderBy direction in ConnectionSyncJobService.search', {
          query,
          direction,
        });
      } else {
        // `updated_at` — the sort key every caller passes — is not unique, so a
        // bounded search sorted on it alone returns an arbitrary member of each
        // tied group, and a different one on the next tick. The primary key
        // makes the sort total.
        executable = executable.orderBy(field, direction).addOrderBy('id', direction);
        ordered = true;
      }
    }

    if (query.limit != null) {
      // A LIMIT is only meaningful over a deterministic order, so a caller that
      // asks for one without a usable sort still gets one.
      if (!ordered) {
        executable = executable.orderBy('id', 'ASC');
      }

      executable = executable.take(query.limit);
    }

    return executable.getMany();
  }
}
