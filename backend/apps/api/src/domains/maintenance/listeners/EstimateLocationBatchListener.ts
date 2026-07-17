import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import {
  EstimateLocationBatchRequestEvent,
  type EstimateLocationBatchRequestPayload,
} from '@ci/domains/memory/events';

import {
  DEFAULT_ESTIMATE_SOURCE_SYSTEMS,
  DEFAULT_MAX_GAP_HOURS,
  LocationEstimateService,
} from '../services/LocationEstimateService';

/** Dedicated PGBoss queue so estimation backfills don't block the default queue. */
export const ESTIMATE_LOCATION_QUEUE = 'estimate-location';

/** Default batch size when the request omits a limit. */
export const DEFAULT_ESTIMATE_BATCH_LIMIT = 500;

/**
 * Consumes {@link EstimateLocationBatchRequestEvent}: fills coordinates for
 * coordinate-less physical-presence events from the nearest-in-time real
 * location, via {@link LocationEstimateService.estimateBatch}. The heavy lifting
 * is one set-based SQL UPDATE; this listener only resolves defaults.
 */
@Injectable()
export class EstimateLocationBatchListener {
  constructor(
    private readonly estimateService: LocationEstimateService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EstimateLocationBatchListener.name);
  }

  @OnEvent(EstimateLocationBatchRequestEvent, { queue: ESTIMATE_LOCATION_QUEUE })
  async handleBatch(payload: EstimateLocationBatchRequestPayload): Promise<void> {
    const { userId } = payload;

    await this.estimateService.estimateBatch(userId, {
      limit: payload.limit ?? DEFAULT_ESTIMATE_BATCH_LIMIT,
      maxGapHours: payload.maxGapHours ?? DEFAULT_MAX_GAP_HOURS,
      sourceSystems: payload.sourceSystems ?? [...DEFAULT_ESTIMATE_SOURCE_SYSTEMS],
      forced: payload.forced === true,
    });
  }
}
