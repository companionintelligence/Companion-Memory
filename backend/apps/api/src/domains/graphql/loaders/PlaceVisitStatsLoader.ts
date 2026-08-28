import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { PlaceService, type PlaceVisitStats } from '@ci/domains/memory';

import { Loader } from './Loader';

const EMPTY: PlaceVisitStats = {
  visitCount: 0,
  firstVisitAt: null,
  lastVisitAt: null,
  // Defensive fallback only (getVisitStats always populates every requested
  // id) — never claim `confirmed` for a place this loader knows nothing
  // about.
  status: 'pending_enrichment',
};

/** Batches PlaceType.visitStats reads into one grouped events query. */
@Injectable()
export class PlaceVisitStatsLoader extends Loader<PlaceVisitStats> {
  constructor(
    private readonly placeService: PlaceService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlaceVisitStatsLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    placeIds: readonly string[],
  ): Promise<readonly PlaceVisitStats[]> {
    this.logger.log(`Loading visit stats for a batch of ${placeIds.length} places`);

    const stats = await this.placeService.getVisitStats(context, [...placeIds]);

    return placeIds.map((id) => stats.get(id) ?? EMPTY);
  }
}
