import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { DeterministicEdgeSource, EdgeProjectionReopener } from '@ci/domains/maintenance';

import { EDGE_STAGES_BY_SOURCE } from '../listeners/GraphEdgeSweepRequestListener';

import { PipelineStateService } from './PipelineStateService';
import { StageRegistry } from './StageRegistry';

/**
 * The pipeline's side of `EDGE_PROJECTION_REOPENER` (declared in
 * `maintenance/edgeProjectionReopener.ts`, which says why it exists): a
 * linkage writer that is not a stage names the edge SOURCE whose rows it
 * changed, and this re-opens the decision of the `promote.edge_*` leg that
 * projects that source.
 *
 * It resolves nothing by hand. Which leg projects a source is
 * {@link EDGE_STAGES_BY_SOURCE}, the same answer the post-push graph kick
 * uses. The ledger entity type is the resolved stage's own `entityTypes`,
 * because a hand-kept copy of either is a re-open that silently lands on rows
 * nothing sweeps. The re-open itself is `PipelineStateService.reopen()` on the
 * caller's transaction, so the ledger keeps its one writer.
 */
@Injectable()
export class EdgeProjectionReopenService implements EdgeProjectionReopener {
  constructor(
    private readonly stateService: PipelineStateService,
    private readonly stageRegistry: StageRegistry,
  ) {}

  async reopen(
    source: DeterministicEdgeSource,
    ids: readonly string[],
    manager: Pick<EntityManager, 'query'>,
  ): Promise<number> {
    const stageId = EDGE_STAGES_BY_SOURCE[source];

    // Thrown, not skipped: the caller's linkage write rolls back with it. A
    // source with no edge leg is a declaration mistake, and a write that goes
    // ahead without its re-open is the gap this contract exists to close.
    if (stageId == null) {
      throw new Error(
        `No promote.edge_* leg projects edge source "${source}"; cannot re-open its decisions.`,
      );
    }

    if (ids.length === 0) {
      return 0;
    }

    const stage = this.stageRegistry.get(stageId);
    let reopened = 0;

    for (const entityType of stage.entityTypes) {
      reopened += await this.stateService.reopen(entityType, stage.id, ids, manager);
    }

    return reopened;
  }
}
