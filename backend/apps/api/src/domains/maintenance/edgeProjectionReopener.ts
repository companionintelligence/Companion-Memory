import type { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';

import type { DeterministicEdgeSource } from './services/deterministicEdgeMatrix';

/**
 * Re-opens the pipeline's edge-projection decision for source rows whose
 * LINKAGE a writer outside the pipeline has just changed. The pipeline domain
 * implements it (`EdgeProjectionReopenService`) and PipelineModule binds
 * {@link EDGE_PROJECTION_REOPENER} to that implementation.
 *
 * ── Why a writer that is not a stage has to say anything ──────────────────
 *
 * `promote.edge_communication` projects `ci.communications.from_entity_id` /
 * `to_entity_ids` into SENT / RECEIVED edges, records `done`, and THE ONE RULE
 * never offers the row again at that version. Its predicate is an OR — a
 * sender, a recipient OR an attachment — so a message is decided as soon as
 * ANY of them is present. A column filled in after that is never projected.
 *
 * The linkers in this domain fill exactly those columns, and only when they
 * are still empty: `CommunicationLinkBackfillService` (the `link_communications`
 * leg, which smart-rotation's `graph_link` runs every two hours),
 * `EventParticipantBackfillService` (`link_events`, same job) and the
 * single-create `CommunicationParticipantLinkListener`. Measured on the
 * reference appliance 2026-09-30: 17,417 communications decided `done` at the
 * leg's then-current version (7) were missing 19,889 RECEIVED and 1,456 SENT
 * edges. For all but one of them, the column that was still empty when the
 * edge leg decided had been filled by a later `graph_link` run. A Twitter DM
 * with an attachment was decided on its ATTACHED_TO edge before its
 * participants had people. A WhatsApp message the owner sent had its recipient
 * but no sender yet. A Google Voice text had its sender but not the owner's
 * own number.
 *
 * A stage's `done` re-opens its consumers through `STAGE_REOPENS`
 * (`pipeline/reopens.ts`). A writer that is not a stage reports no outcome, so
 * it re-opens the decision ITSELF, in the SAME transaction as its write. The
 * re-open then commits with the write, or not at all.
 *
 * ── Why a token and not `PipelineStateService` ─────────────────────────────
 *
 * PipelineModule imports MaintenanceModule (the edge stages delegate the
 * projection to `DeterministicEdgeBackfillService`), so injecting a pipeline
 * service here would need a module-level cycle. A deep import of its file
 * would also close a CommonJS require cycle through the maintenance barrel
 * that the edge stages import. So maintenance owns the contract, pipeline
 * supplies it, and a maintenance service resolves it lazily with
 * {@link resolveEdgeProjectionReopener}. That is the `SELF_ENTITY_PROVISIONER`
 * pattern (memory ← graph).
 *
 * The contract speaks in edge SOURCES (`DeterministicEdgeSource`), not stage
 * ids. The writer knows which table's linkage it changed. Which leg projects
 * that table, and under which ledger entity type, is the pipeline's business.
 */
export const EDGE_PROJECTION_REOPENER = 'EDGE_PROJECTION_REOPENER';

export interface EdgeProjectionReopener {
  /**
   * Re-open, for these rows of `source`, the decision of the `promote.edge_*`
   * leg that projects it. Runs on `manager`, the caller's transaction. Returns
   * how many ledger rows moved. A row the leg never decided has no ledger row
   * to move, because it is already a candidate. A row a worker holds `running`
   * right now is left to that worker; see the residual in `pipeline/reopens.ts`.
   */
  reopen(
    source: DeterministicEdgeSource,
    ids: readonly string[],
    manager: Pick<EntityManager, 'query'>,
  ): Promise<number>;
}

/**
 * Resolve the {@link EDGE_PROJECTION_REOPENER} binding, or throw.
 *
 * Never returns null. A linkage write whose re-open cannot run is the defect
 * this contract exists to close, so the write must fail loudly (its
 * transaction rolls back, the leg or job reports the error) rather than
 * succeed and strand the row. Every process that runs these writers (the api
 * and the worker) imports PipelineModule, so the only way to get here is a
 * container assembled without it, which is a wiring mistake.
 */
export function resolveEdgeProjectionReopener(moduleRef: ModuleRef | undefined): EdgeProjectionReopener {
  let reopener: EdgeProjectionReopener | undefined;

  try {
    reopener = moduleRef?.get<EdgeProjectionReopener>(EDGE_PROJECTION_REOPENER, { strict: false });
  } catch (err: unknown) {
    throw new Error(
      `No provider is bound to ${EDGE_PROJECTION_REOPENER}. A linkage write cannot re-open the edge ` +
        `projection's decision without it (PipelineModule binds it). Cause: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (reopener == null) {
    throw new Error(
      `${EDGE_PROJECTION_REOPENER} is unavailable (no ModuleRef): a linkage write cannot re-open the ` +
        `edge projection's decision. Construct the service through Nest, or hand it a ModuleRef that ` +
        `resolves the token.`,
    );
  }

  return reopener;
}
