import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { IngestRunEntity, type IngestRunStatus } from '../entities/IngestRunEntity';

/**
 * Plan 08 §3.3 — tracks one row per ETL sync attempt. Callers `start` a run
 * to get an id, then optionally call `incrementCounts` as they write, then
 * `end` to finalize. `rollback` is what the SPA's "undo last sync" button
 * calls — it sets `rollback_at`, and retrieval filters those runs out in a
 * follow-up.
 *
 * The service is best-effort: a failure to write the run row never breaks
 * the underlying ingest.
 */
@Injectable()
export class IngestRunService {
  constructor(
    @InjectRepository(IngestRunEntity)
    private readonly repo: Repository<IngestRunEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IngestRunService.name);
  }

  async start(input: { actorId: string; provider: string; cursor?: string }): Promise<string> {
    const id = uuidv7();
    try {
      await this.repo.save({
        id,
        actor_id: input.actorId,
        provider: input.provider,
        status: 'running' as IngestRunStatus,
        cursor: input.cursor ?? null,
        entities_written: 0,
        relationships_written: 0,
        error: null,
        ended_at: null,
        rollback_at: null,
      });
    } catch (error) {
      this.logger.warn('Failed to persist ingest_run start', {
        provider: input.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return id;
  }

  async incrementCounts(runId: string, counts: { entities?: number; relationships?: number }): Promise<void> {
    try {
      const qb = this.repo.createQueryBuilder().update().where('id = :id', { id: runId });
      const set: Record<string, () => string> = {};

      if (counts.entities) {
        set.entities_written = () => `entities_written + ${counts.entities}`;
      }

      if (counts.relationships) {
        set.relationships_written = () => `relationships_written + ${counts.relationships}`;
      }

      if (Object.keys(set).length === 0) {
        return;
      }

      await qb.set(set).execute();
    } catch (error) {
      this.logger.warn('Failed to increment ingest_run counts', { runId, error });
    }
  }

  async end(runId: string, status: Exclude<IngestRunStatus, 'running'>, error?: string): Promise<void> {
    try {
      await this.repo.update(
        { id: runId },
        {
          status,
          error: error ?? null,
          ended_at: new Date(),
        },
      );
    } catch (e) {
      this.logger.warn('Failed to end ingest_run', { runId, e });
    }
  }

  async rollback(runId: string): Promise<void> {
    try {
      await this.repo.update({ id: runId }, { rollback_at: new Date() });
    } catch (e) {
      this.logger.warn('Failed to mark ingest_run rolled back', { runId, e });
    }
  }
}
