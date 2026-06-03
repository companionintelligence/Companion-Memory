import { z } from 'zod';

import type { BaseClient, Connection } from '@ci/domains/connections';

import type { User } from '../user';

export type JobStatus = 'in_progress' | 'failed' | 'success' | 'pending';

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
}

export interface SearchConnectionSyncJobDto {
  jobId?: string | null;
  userId?: string;
  connectionId?: string;
  endpointName?: string;
  status?: JobStatus;
  type?: string;
  properties?: Record<string, unknown> | null;
  lastTransformed?: Date | null | undefined;
  orderBy?: OrderByFormat;
}

export const createConnectionSyncJobSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid(),
  connectionId: z.string().uuid(),
  jobId: z.string().uuid().nullable().optional(),
  endpointName: z.string(),
  status: z.enum(['in_progress', 'failed', 'success']).optional(),
  data: z.record(z.unknown()).optional(),
  type: z.string(),
  cursor: z.record(z.unknown()).nullable().optional(),
  nextCursor: z.record(z.unknown()).nullable().optional(),
  properties: z.record(z.unknown()).nullable().optional(),
  error: z.record(z.unknown()).nullable().optional(),
});

export const updateConnectionSyncJobSchema = z.object({
  jobId: z.string().uuid().nullable().optional(),
  endpointName: z.string().optional(),
  status: z.enum(['in_progress', 'failed', 'success']).optional(),
  data: z.record(z.unknown()).optional(),
  type: z.string().optional(),
  cursor: z.record(z.unknown()).nullable().optional(),
  nextCursor: z.record(z.unknown()).nullable().optional(),
  properties: z.record(z.unknown()).nullable().optional(),
  error: z.record(z.unknown()).nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  lastTransformed: z.string().datetime().nullable().optional(),
});

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
