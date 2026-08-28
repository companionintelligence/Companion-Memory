import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
// The events leaf, NOT the maintenance barrel — the barrel would re-enter this
// domain through maintenance → llm → tools → import. Same import shape, and the
// same reason, as `SearchIndexSweepRequestListener` next door.
import {
  GRAPH_EDGE_BACKFILL_QUEUE,
  GraphEdgeBackfillRequestEvent,
  type GraphEdgeBackfillRequestPayload,
} from '@ci/domains/maintenance/events';

import { STAGE_IDS, type StageId } from '../constants';
import { PipelineDispatchService } from '../services/PipelineDispatchService';

/**
 * Edge SOURCE TABLE → the `promote.edge_*` leg that projects it.
 *
 * The keys are the `DeterministicEdgeSource` vocabulary
 * (`deterministicEdgeMatrix.ts`), which is also what every rule in the matrix
 * declares as its `source` — so "which leg covers `ci.communications`?" has one
 * answer and it is spelled the same on the wire, in the matrix and here.
 * Deliberately NOT imported as the union type: the payload carries plain
 * strings so an emitter needs no dependency on the maintenance domain, and this
 * map plus the spec below is what makes the strings safe.
 *
 * One leg per source, not one per rule. `EdgePromoteStage` declares a stage per
 * SOURCE TABLE precisely because a `Stage` has exactly one `source`, and the
 * matrix reads several tables — so a sweep of `promote.edge_receipt` runs every
 * receipt rule in the matrix, and this map has nothing finer to say.
 */
export const EDGE_STAGES_BY_SOURCE: Readonly<Record<string, StageId>> = {
  communications: STAGE_IDS.PROMOTE_EDGE_COMMUNICATION,
  events: STAGE_IDS.PROMOTE_EDGE_EVENT,
  content: STAGE_IDS.PROMOTE_EDGE_CONTENT,
  objects: STAGE_IDS.PROMOTE_EDGE_OBJECT,
  receipts: STAGE_IDS.PROMOTE_EDGE_RECEIPT,
  observations: STAGE_IDS.PROMOTE_EDGE_OBSERVATION,
  positions: STAGE_IDS.PROMOTE_EDGE_POSITION,
  devices: STAGE_IDS.PROMOTE_EDGE_DEVICE,
  files: STAGE_IDS.PROMOTE_EDGE_FILE,
  places: STAGE_IDS.PROMOTE_EDGE_PLACE,
};

/**
 * Consumes {@link GraphEdgeBackfillRequestEvent}: starts a pipeline sweep of the
 * requested sources' `promote.edge_*` legs for the requesting user, so a bulk
 * load's rows are reachable in the graph without waiting for the next scheduled
 * sweep.
 *
 * ── The bug this closes ────────────────────────────────────────────────────
 *
 * `ci.relationships` is the ONLY table a graph traversal reads. A bulk import
 * writes the linkage columns those edges project from (`from_entity_id`,
 * `to_entity_ids`, `event_id`, `parent_id`, …) at ingest, for the whole corpus,
 * in minutes — and until this listener existed, nothing told the projection.
 * The import's only post-push kick was the search-index one, so an import made
 * its rows findable immediately and left them isolated in the graph until a
 * scheduled sweep came round. Measured: 2,880 of 1,001,475 entities had any
 * edge at all, against ~1.5M derivable from columns already in the tables.
 *
 * ── Why this is a kick and not a fix ───────────────────────────────────────
 *
 * The legs are hourly and unwindowed (`STAGE_SCHEDULES`), so the corpus
 * converges with or without a request; what this removes is the hour. Both
 * halves matter and neither substitutes for the other — a kick with a daily
 * cadence behind it is one lost pg-boss job away from a day-long gap, and an
 * hourly cadence with no kick is an hour of an empty graph on every first
 * import, which is exactly when someone is looking.
 *
 * ── Refusals, and why they are refusals ────────────────────────────────────
 *
 * Same three as its sibling, for the same reasons. A request whose scope names
 * ONLY unknown sources is refused rather than widened: falling back to "every
 * source" would turn a typo into a full-corpus pass, the opposite of what a
 * scoped emitter asked for. An empty array is a scope too — it says "nothing" —
 * and a request with no `userId` cannot be started at all, because sweeps are
 * user-scoped and guessing an owner would project one user's rows under
 * another's name.
 *
 * Overlapping sweeps are safe by construction: hops select through the ledger's
 * claim, so the loser of a race gets a shorter list, and the projection itself
 * is `ON CONFLICT DO NOTHING`. There is deliberately no dedupe here — an empty
 * hop costs one query.
 */
@Injectable()
export class GraphEdgeSweepRequestListener {
  constructor(
    private readonly dispatchService: PipelineDispatchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphEdgeSweepRequestListener.name);
  }

  @OnEvent(GraphEdgeBackfillRequestEvent, { queue: GRAPH_EDGE_BACKFILL_QUEUE })
  async handleRequest(payload: GraphEdgeBackfillRequestPayload): Promise<void> {
    const { userId, requestedBy } = payload;

    if (userId == null || userId.length === 0) {
      this.logger.warn('Graph-edge sweep request carries no userId; ignoring', { requestedBy });

      return;
    }

    const requested = payload.sources;
    const known = requested?.filter((source) => EDGE_STAGES_BY_SOURCE[source] != null);

    if (requested != null && (known == null || known.length === 0)) {
      this.logger.warn('Graph-edge sweep request named no known edge sources; ignoring', {
        requested,
        requestedBy,
      });

      return;
    }

    if (known != null && known.length < (requested?.length ?? 0)) {
      this.logger.warn('Graph-edge sweep request named unknown edge sources; sweeping the rest', {
        requested,
        known,
        requestedBy,
      });
    }

    const sources = known ?? Object.keys(EDGE_STAGES_BY_SOURCE);
    const stages = sources.map((source) => EDGE_STAGES_BY_SOURCE[source]);

    for (const stage of stages) {
      await this.dispatchService.startSweep({ stage, userId });
    }

    this.logger.log('Graph-edge projection sweeps started', {
      requestedBy,
      userId,
      sources,
      stages,
    });
  }
}
