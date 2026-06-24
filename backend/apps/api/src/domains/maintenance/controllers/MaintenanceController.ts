import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { EventService as SignallingEventService } from '@ci/domains/events';
import { EventEntity } from '@ci/domains/memory';
import { GeocodeBatchRequestEvent } from '@ci/domains/memory/events';

import {
  type DeferralResult,
  type DroppedIndex,
  IndexDeferralService,
  type RecreateResult,
} from '../services/IndexDeferralService';

// Body for POST /api/maintenance/indexes/recreate: the `dropped` array returned
// verbatim by the matching /drop call (each carries its exact CREATE statement).
const recreateIndexesSchema = z.object({
  dropped: z
    .array(
      z.object({
        schema: z.string(),
        name: z.string(),
        definition: z.string(),
      }),
    )
    .min(1),
});

const geocodeLocationsSchema = z.object({
  /** Max events to geocode in this batch. */
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  /** Re-attempt events still missing coordinates (default: same as the auto set). */
  retryNull: z.boolean().optional(),
});

type GeocodeLocationsRequest = z.infer<typeof geocodeLocationsSchema>;

interface GeocodeLocationsResponse {
  jobId: string | null;
  estimatedEventCount: number;
  status: 'enqueued' | 'noop';
}

/** Default batch size — mirrors GeocodeBatchListener.DEFAULT_LIMIT. */
const DEFAULT_LIMIT = 200;

/** The dedicated PGBoss queue the geocode listener consumes. */
const GEOCODE_QUEUE = 'geocode';

/**
 * Operator-facing maintenance endpoints. POST /api/maintenance/geocode-locations
 * enqueues a forward-geocode backfill (geodata-plan Phase 1): it counts the
 * candidate events (location_name present, coordinates missing) and emits a
 * {@link GeocodeBatchRequestEvent} onto the geocode queue for the batch listener
 * to process out-of-band.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('api/maintenance')
export class MaintenanceController {
  constructor(
    private readonly signallingEventService: SignallingEventService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly indexDeferralService: IndexDeferralService,
  ) {}

  @Post('geocode-locations')
  async geocodeLocations(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(geocodeLocationsSchema)) body: GeocodeLocationsRequest,
  ): Promise<GeocodeLocationsResponse> {
    const serviceContext = toServiceContext(context);
    const userId = serviceContext.userId;

    if (typeof userId !== 'string') {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const limit = body.limit ?? DEFAULT_LIMIT;

    // Estimate how many events this batch will touch, capped at the batch limit.
    const candidateCount = await this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId })
      .andWhere('event.location_name IS NOT NULL')
      .andWhere("btrim(event.location_name) <> ''")
      .andWhere('event.location_coordinates IS NULL')
      .getCount();

    const estimatedEventCount = Math.min(candidateCount, limit);

    if (estimatedEventCount === 0) {
      return { jobId: null, estimatedEventCount: 0, status: 'noop' };
    }

    const jobIds = await this.signallingEventService.send(
      GeocodeBatchRequestEvent,
      { userId, limit, retryNull: body.retryNull ?? false },
      { queue: GEOCODE_QUEUE },
    );

    return {
      jobId: jobIds[0] ?? null,
      estimatedEventCount,
      status: jobIds.length > 0 ? 'enqueued' : 'noop',
    };
  }

  /**
   * Index-deferral helper (issue #12), DROP phase. Drops the deferrable
   * secondary indexes (FTS GIN, pgvector HNSW, per-table btree/GIN on the bulk
   * destinations) before a very large load. Returns each dropped index's exact
   * recreate statement in `dropped` — POST that array back to /indexes/recreate
   * after the load. Provenance unique indexes and primary keys are never
   * dropped (enforced in IndexDeferralService). OPT-IN; operator-triggered.
   */
  @Post('indexes/drop')
  async dropIndexes(): Promise<DeferralResult> {
    return this.indexDeferralService.dropDeferredIndexes();
  }

  /**
   * Index-deferral helper (issue #12), RECREATE phase. Recreates the indexes
   * dropped by /indexes/drop from the definitions returned there (passed back
   * verbatim in the body).
   */
  @Post('indexes/recreate')
  async recreateIndexes(
    @Body(new ValidationPipe(recreateIndexesSchema)) body: { dropped: DroppedIndex[] },
  ): Promise<RecreateResult> {
    return this.indexDeferralService.recreateDeferredIndexes(body.dropped);
  }
}
