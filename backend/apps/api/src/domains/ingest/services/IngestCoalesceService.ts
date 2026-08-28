import { Injectable } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { EventService, OnEvent } from '@ci/domains/events';
import { MaintenanceOrchestratorService } from '@ci/domains/maintenance';

import { IngestCoalesceEvent, type IngestCoalescePayload } from '../events';
import { COALESCE_STAGES } from '../owedStages';

export const INGEST_COALESCE_QUEUE = 'ingest-coalesce';
export const INGEST_COALESCE_DELAY_SECONDS = 60;

/**
 * Server-side finish: after bulk `/v1` materialize, enqueue a delayed singleton
 * so enrichment still runs if the client never calls finish.
 */
@Injectable()
export class IngestCoalesceService {
  constructor(
    private readonly eventService: EventService,
    private readonly featureService: FeatureService,
    private readonly orchestrator: MaintenanceOrchestratorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IngestCoalesceService.name);
  }

  async schedule(userId: string): Promise<void> {
    if (!(await this.featureService.isFeatureEnabled('ingest.selfHeal'))) {
      return;
    }

    await this.enqueue(userId, INGEST_COALESCE_DELAY_SECONDS);
  }

  @OnEvent(IngestCoalesceEvent, {
    queue: INGEST_COALESCE_QUEUE,
    // `policy: 'short'` is what makes the singletonKey `enqueue()` sends
    // (keyed by userId) actually refuse a duplicate — pg-boss's default
    // `standard` policy stores a singletonKey but never enforces it. Every
    // send on this queue carries a userId key, so `short` is safe queue-wide.
    queueOptions: { policy: 'short', expireInSeconds: 3600, retryLimit: 3, retryDelay: 60 },
  })
  async run(payload: IngestCoalescePayload): Promise<void> {
    const { userId } = payload;

    if (this.orchestrator.isRunning(userId)) {
      this.logger.log('Coalesce deferred — orchestrator already running', { userId });
      await this.enqueue(userId, INGEST_COALESCE_DELAY_SECONDS);

      return;
    }

    try {
      const summary = await this.orchestrator.orchestrate(userId, {
        stages: [...COALESCE_STAGES],
      });
      this.logger.log('Coalesce finished', {
        userId,
        ok: summary.ok,
        legs: summary.legs.length,
        totalDurationMs: summary.totalDurationMs,
      });
    } catch (error) {
      this.logger.warn('Coalesce failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async enqueue(userId: string, startAfterSeconds: number): Promise<void> {
    await this.eventService.send(
      IngestCoalesceEvent,
      { userId },
      {
        queue: INGEST_COALESCE_QUEUE,
        singletonKey: userId,
        startAfter: startAfterSeconds,
      },
    );
  }
}
