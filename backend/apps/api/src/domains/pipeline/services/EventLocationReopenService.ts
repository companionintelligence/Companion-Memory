import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { EventLocationReopener } from '@ci/domains/memory';

import { STAGE_IDS, type StageId } from '../constants';

import { PipelineStateService } from './PipelineStateService';
import { StageRegistry } from './StageRegistry';

/**
 * The stages whose decision about an `event` reads its location, and is
 * therefore wrong once a writer outside the pipeline moves it:
 *
 *  - `enrich.geocode` — name to point. It resolved the OLD name, or recorded
 *    that it could not (`zero_results`, `virtual_location`); the new name has
 *    never been asked about.
 *  - `enrich.event_reverse` — point to name. A delivery that arrives with a
 *    point and no name is exactly the shape it exists for.
 *  - `enrich.estimate_location` — a borrowed point for an event with no place
 *    of its own. A delivery that adds a place retires it; one that removes the
 *    place makes the event a candidate again.
 *  - `promote.place` — name and point to a link to a Location.
 *
 * NOT here, though they read the event:
 *
 *  - `promote.edge_event` (the Event −LOCATED_AT→ Place edge). `promote.place`'s
 *    `done` re-opens it through `STAGE_REOPENS` when the new link lands, and the
 *    refresh itself deletes the edge to the OLD place in its transaction, which
 *    no stage does: the projection only ever inserts.
 *  - The search index. The refresh publishes `EventUpdatedEvent`, which
 *    re-indexes the event as for any edit (`searchTexts.ts` weights the name).
 *  - `clean.temporal_repair`, and the person-link stages: they read neither the
 *    name nor the point.
 */
export const EVENT_LOCATION_STAGES: readonly StageId[] = [
  STAGE_IDS.ENRICH_GEOCODE,
  STAGE_IDS.ENRICH_EVENT_REVERSE,
  STAGE_IDS.ENRICH_ESTIMATE_LOCATION,
  STAGE_IDS.PROMOTE_PLACE,
];

/**
 * The pipeline's side of `EVENT_LOCATION_REOPENER` (declared in
 * `memory/services/eventLocationReopener.ts`, which says why it exists): when
 * an event's source moves its place, re-open the decisions
 * {@link EVENT_LOCATION_STAGES} made on the old one.
 *
 * The ledger entity type is each stage's own `entityTypes`, and the re-open is
 * `PipelineStateService.reopen()` on the caller's transaction, so the ledger
 * keeps its one writer — as `EventTimeReopenService` and
 * `EdgeProjectionReopenService` do it.
 *
 * A stage that has the row `running` at this moment is a live claim, and
 * `reopen()` leaves it alone (see its note): that stage completes against the
 * row it read before this commit. The window is the length of one slice.
 */
@Injectable()
export class EventLocationReopenService implements EventLocationReopener {
  constructor(
    private readonly stateService: PipelineStateService,
    private readonly stageRegistry: StageRegistry,
  ) {}

  async reopenLocationDecisions(
    eventIds: readonly string[],
    manager: Pick<EntityManager, 'query'>,
  ): Promise<number> {
    if (eventIds.length === 0) {
      return 0;
    }

    let reopened = 0;

    for (const stageId of EVENT_LOCATION_STAGES) {
      const stage = this.stageRegistry.get(stageId);

      for (const entityType of stage.entityTypes) {
        reopened += await this.stateService.reopen(entityType, stage.id, eventIds, manager);
      }
    }

    return reopened;
  }
}
