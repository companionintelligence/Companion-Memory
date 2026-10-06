import type { BaseClient, Connection } from '@ci/domains/connections';

import type { User } from '../user';

export type JobStatus = 'in_progress' | 'failed' | 'success' | 'pending';

/**
 * The states a sync job passes through on its way to a terminal one, and the
 * states the partial unique index `connection_sync_jobs_live_job_idx` covers:
 * at most one row in either of them may exist per connection endpoint and
 * iteration type. Everything else on that endpoint is history.
 */
export const LIVE_JOB_STATUSES: readonly JobStatus[] = ['pending', 'in_progress'];

export type OrderByFormat = `${string}:${'ASC' | 'DESC'}`;

export interface ConnectionSyncJob {
  readonly id: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly jobId: string | null;
  readonly endpointName: string;
  readonly status: JobStatus;
  readonly data: Record<string, unknown>;
  readonly type: string;
  readonly cursor: Record<string, unknown> | null;
  readonly nextCursor: Record<string, unknown> | null;
  readonly properties: Record<string, unknown> | null;
  readonly error: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly user?: User;
  readonly connection?: Connection;
  readonly lastTransformed?: Date | null;
  /** Whether the sync executor stored a fetch result in `data`. See the entity column. */
  readonly fetchedByExecutor?: boolean;
}

export interface CreateConnectionSyncJobDto {
  id?: string;
  userId: string;
  connectionId: string;
  jobId?: string | null;
  endpointName: string;
  status?: JobStatus;
  data?: Record<string, unknown>;
  type: string;
  cursor?: Record<string, unknown> | null;
  nextCursor?: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  lastTransformed?: Date | null | undefined;
}

export interface UpdateConnectionSyncJobDto {
  jobId?: string | undefined;
  endpointName?: string;
  status?: JobStatus;
  data?: Record<string, unknown>;
  type?: string;
  cursor?: Record<string, unknown> | undefined;
  nextCursor?: Record<string, unknown> | undefined;
  properties?: Record<string, unknown> | undefined;
  error?: Record<string, unknown> | undefined;
  completedAt?: Date | undefined;
  lastTransformed?: Date | null | undefined;
  /**
   * Set by the sync executor, and only by it, when it stores a fetch result. No client input maps
   * onto this; it is what the transform sweep trusts `data` on.
   */
  fetchedByExecutor?: boolean;
}

export interface SearchConnectionSyncJobDto {
  jobId?: string | null;
  userId?: string;
  connectionId?: string;
  endpointName?: string;
  status?: JobStatus;
  /** Any-of alternative to {@link status}, pushed down as a SQL `IN`. */
  statuses?: readonly JobStatus[];
  type?: string;
  properties?: Record<string, unknown> | null;
  lastTransformed?: Date | null | undefined;
  /**
   * Restrict to rows `ConnectionSyncJobService.claimTransform` could actually
   * win — unclaimed, or claimed longer than its staleness window ago. Lets the
   * sweep skip transforms already in flight instead of re-sending them every
   * tick for the life of the transform.
   */
  transformClaimable?: boolean;
  /** Only rows the sync executor stored a fetch result in (`fetched_by_executor`). */
  fetchedByExecutor?: boolean;
  /** Only rows whose connection is active: signed in, and not paused or removed. */
  connectionActive?: boolean;
  orderBy?: OrderByFormat;
  /** Row cap, pushed down as a SQL LIMIT. */
  limit?: number;
}

export interface EndpointServiceMapInterface {
  sync: {
    [providerName: string]: {
      [endpointName: string]: ({
        connection,
        client,
        nextCursor,
        historical,
      }: {
        connection: Connection;
        client: BaseClient;
        nextCursor: Record<string, unknown>;
        historical: boolean;
      }) => Promise<{ data: Record<string, unknown>; nextCursor?: Record<string, unknown> }>;
    };
  };
  transform: {
    [providerName: string]: {
      [endpointName: string]: ({
        syncJob,
        connection,
      }: {
        syncJob: ConnectionSyncJob;
        connection: Connection;
      }) => Promise<void>;
    };
  };
}
