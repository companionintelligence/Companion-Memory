import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { EventStatusReopener } from '@ci/domains/memory';

import { STAGE_IDS, type StageId } from '../constants';
import { withdrawEstimates } from '../stages/enrich/EstimateLocationStage';

import { PipelineStateService } from './PipelineStateService';
import { StageRegistry } from './StageRegistry';

/**
 * The stages whose decision about an `event` reads whether it happened, and is
 * therefore wrong once a writer outside the pipeline calls it off or reinstates
 * it:
 *
 *  - `enrich.estimate_location` — whether the event may be lent a coordinate
 *    (and may lend one), by `eventHappenedSql`.
 *
 * NOT here, though `promote.place` applies the same rule. What it decided is a
 * link — a Location, an edge and a footprint — which is not this contract's to
 * take back, and a link written while the event stood stays when it is called
 * off (migration `20261001153044` withdrew the ones written before that rule,
 * and says the limit). An event that stage recorded `skipped:
 * event_did_not_happen`, because it was called off between the sweep and its
 * slice, is not offered again when it is reinstated either.
 */
export const EVENT_STATUS_STAGES: readonly StageId[] = [STAGE_IDS.ENRICH_ESTIMATE_LOCATION];

/**
 * The pipeline's side of `EVENT_STATUS_REOPENER` (declared in
 * `memory/services/eventStatusReopener.ts`, which says why it exists): when a
 * status write calls an event off or reinstates it, take back what an event
 * that did not happen was lent and re-open {@link EVENT_STATUS_STAGES}.
 *
 * In that order, and both always, whichever way the status moved:
 *
 *  1. {@link withdrawEstimates} acts only on an event whose stored status says
 *     it did not happen, so for a reinstatement it finds nothing. It decides
 *     from the row, not from the caller, so a caller that is wrong about the
 *     direction cannot make it take an estimate from an event that happened.
 *  2. The ledger row is re-opened. After a withdrawal it has to be: it says
 *     `done` at the current version, and a reinstated event would stay without
 *     the coordinate it just lost. For a reinstatement it re-offers an event a
 *     slice recorded `skipped: event_did_not_happen`, which nothing else does.
 *
 * The ledger entity type is each stage's own `entityTypes`, and the re-open is
 * `PipelineStateService.reopen()` on the caller's transaction, so the ledger
 * keeps its one writer — as `EventTimeReopenService` does it.
 */
@Injectable()
export class EventStatusReopenService implements EventStatusReopener {
  constructor(
    private readonly stateService: PipelineStateService,
    private readonly stageRegistry: StageRegistry,
  ) {}

  async reopenStatusDecisions(
    eventIds: readonly string[],
    manager: Pick<EntityManager, 'query'>,
  ): Promise<number> {
    if (eventIds.length === 0) {
      return 0;
    }

    await withdrawEstimates(manager, eventIds);

    let reopened = 0;

    for (const stageId of EVENT_STATUS_STAGES) {
      const stage = this.stageRegistry.get(stageId);

      for (const entityType of stage.entityTypes) {
        reopened += await this.stateService.reopen(entityType, stage.id, eventIds, manager);
      }
    }

    return reopened;
  }
}
