import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { CloudFileIngestEntity, type CloudFileIngest } from '../entities/CloudFileIngestEntity';

export interface CloudFileIngestKey {
  connectionId: string;
  provider: string;
  externalFileId: string;
}

export interface RecordCloudFileIngestSuccessInput extends CloudFileIngestKey {
  revision: string;
  contentSha256: string;
  byteSize: number;
  dropId: string;
  importRunId: string;
  attemptCount: number;
}

export interface RecordCloudFileIngestFailureInput extends CloudFileIngestKey {
  /**
   * The revision that was BEING attempted, so the next tick's skip check
   * still compares against the file's current revision rather than a stale
   * one — a 'failed' status already keeps the skip check from firing
   * regardless, but recording the right revision keeps the row honest.
   */
  revision: string;
  attemptCount: number;
  lastError: string;
}

/**
 * The download ledger CloudFileIngestService checks before fetching a cloud
 * file's bytes and updates after — see migration
 * 20260821224650_create_cloud_file_ingests for the table's full rationale.
 * Kept as its own thin service (rather than folding straight into
 * CloudFileIngestService) so the download/stage/retry logic can be unit
 * tested against a mocked ledger instead of a real repository — the same
 * split StagedSourceService/ImportRunService already use.
 */
@Injectable()
export class CloudFileIngestLedgerService {
  constructor(
    @InjectRepository(CloudFileIngestEntity)
    private readonly repository: Repository<CloudFileIngestEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CloudFileIngestLedgerService.name);
  }

  /** The ledger row for this file, or null if it has never been attempted. */
  async findCurrent(ctx: UserServiceContext, key: CloudFileIngestKey): Promise<CloudFileIngest | null> {
    const row = await this.repository.findOne({
      where: {
        userId: ctx.userId,
        connectionId: key.connectionId,
        provider: key.provider,
        externalFileId: key.externalFileId,
      },
    });

    return row ? CloudFileIngestEntity.toEgressType(row) : null;
  }

  /**
   * A download succeeded and a run was started for it. `id` is deliberately
   * left out of the upsert payload: on INSERT the column default
   * (`ci.gen_uuid_v7()`) fills it, and on the ON CONFLICT DO UPDATE path
   * (this is a RE-download of a changed file) leaving it out means the
   * existing row keeps its own id — churning a ledger row's primary key on
   * every re-sync would serve nothing.
   */
  async recordSuccess(ctx: UserServiceContext, input: RecordCloudFileIngestSuccessInput): Promise<void> {
    await this.repository.upsert(
      {
        userId: ctx.userId,
        connectionId: input.connectionId,
        provider: input.provider,
        externalFileId: input.externalFileId,
        revision: input.revision,
        contentSha256: input.contentSha256,
        byteSize: input.byteSize,
        status: 'downloaded',
        dropId: input.dropId,
        importRunId: input.importRunId,
        attemptCount: input.attemptCount,
        lastError: null,
        downloadedAt: new Date(),
      },
      { conflictPaths: ['connectionId', 'externalFileId'] },
    );

    this.logger.log('Recorded a successful cloud file download', {
      userId: ctx.userId,
      connectionId: input.connectionId,
      externalFileId: input.externalFileId,
      byteSize: input.byteSize,
    });
  }

  /**
   * An archive's file listing was checked at this revision and no importer
   * claimed it. Nothing was downloaded. A later revision of the file (it was
   * replaced with something else) is checked afresh.
   */
  async recordNotExport(
    ctx: UserServiceContext,
    input: CloudFileIngestKey & { revision: string },
  ): Promise<void> {
    await this.repository.upsert(
      {
        userId: ctx.userId,
        connectionId: input.connectionId,
        provider: input.provider,
        externalFileId: input.externalFileId,
        revision: input.revision,
        status: 'not_export',
        attemptCount: 1,
        lastError: null,
      },
      { conflictPaths: ['connectionId', 'externalFileId'] },
    );
  }

  /**
   * Every attempt for this file failed this sync tick. `status: 'failed'`
   * means the skip check in {@link findCurrent}'s caller never matches this
   * row, so the NEXT sync tick retries automatically — this is the
   * cross-sync half of "retried, not silently dropped"; the in-request half
   * is CloudFileIngestService's own retry loop.
   */
  async recordFailure(ctx: UserServiceContext, input: RecordCloudFileIngestFailureInput): Promise<void> {
    await this.repository.upsert(
      {
        userId: ctx.userId,
        connectionId: input.connectionId,
        provider: input.provider,
        externalFileId: input.externalFileId,
        revision: input.revision,
        status: 'failed',
        attemptCount: input.attemptCount,
        lastError: input.lastError,
      },
      { conflictPaths: ['connectionId', 'externalFileId'] },
    );

    this.logger.warn('Recorded a failed cloud file download', {
      userId: ctx.userId,
      connectionId: input.connectionId,
      externalFileId: input.externalFileId,
      attemptCount: input.attemptCount,
      lastError: input.lastError,
    });
  }
}
