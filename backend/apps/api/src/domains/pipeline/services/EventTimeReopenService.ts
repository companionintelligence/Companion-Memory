import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { EventTimeReopener } from '@ci/domains/memory';

import { STAGE_IDS, type StageId } from '../constants';

import { PipelineStateService } from './PipelineStateService';
import { StageRegistry } from './StageRegistry';

/**
 * The stages whose decision about an `event` reads its time, and is therefore
 * wrong once a writer outside the pipeline moves that time:
 *
 *  - `clean.temporal_repair` — whether `start_time` is a floating wall clock
 *    stored as UTC (an all-day row at UTC midnight), and where it really is;
 *  - `enrich.estimate_location` — which neighbouring events, by time, lend the
 *    event a coordinate.
 *
 * NOT here, though they read the event: the reverse geocode and the place
 * promotion (they read its coordinate, not its time), and the search index
 * (`EventUpdatedEvent` re-indexes it, as for any edit).
 */
export const EVENT_TIME_STAGES: readonly StageId[] = [
  STAGE_IDS.CLEAN_TEMPORAL_REPAIR,
  STAGE_IDS.ENRICH_ESTIMATE_LOCATION,
];

/**
 * The pipeline's side of `EVENT_TIME_REOPENER` (declared in
 * `memory/services/eventTimeReopener.ts`, which says why it exists): when an
 * event's source moves it, re-open the decisions {@link EVENT_TIME_STAGES} made
 * on its old time.
 *
 * The ledger entity type is each stage's own `entityTypes`, and the re-open is
 * `PipelineStateService.reopen()` on the caller's transaction, so the ledger
 * keeps its one writer — as `EdgeProjectionReopenService` does it.
 */
@Injectable()
export class EventTimeReopenService implements EventTimeReopener {
  constructor(
    private readonly stateService: PipelineStateService,
    private readonly stageRegistry: StageRegistry,
  ) {}

  async reopenTimeDecisions(
    eventIds: readonly string[],
    manager: Pick<EntityManager, 'query'>,
  ): Promise<number> {
    if (eventIds.length === 0) {
      return 0;
    }

    let reopened = 0;

    for (const stageId of EVENT_TIME_STAGES) {
      const stage = this.stageRegistry.get(stageId);

      for (const entityType of stage.entityTypes) {
        reopened += await this.stateService.reopen(entityType, stage.id, eventIds, manager);
      }
    }

    return reopened;
  }
}
