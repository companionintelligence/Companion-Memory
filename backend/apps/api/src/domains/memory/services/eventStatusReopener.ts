import type { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';

/**
 * Settles the pipeline's decisions about whether an event HAPPENED, for events
 * whose status has just crossed the line between "still counts" and "called
 * off" (`DEAD_EVENT_STATUSES`: cancelled, no_show, skipped), in either
 * direction. The pipeline domain implements it (`EventStatusReopenService`) and
 * PipelineModule binds {@link EVENT_STATUS_REOPENER} to that implementation.
 *
 * ── Why the writers of a status have to say anything ───────────────────────
 *
 * `enrich.estimate_location` decides, per event, whether the user was somewhere
 * and where. It records `done` and THE ONE RULE never offers the row again at
 * that version, and its applicability predicate (`eventHappenedSql`) keeps an
 * event that did not happen out of the sweep altogether. Both turn the status
 * into something the stage reads once:
 *
 *  - An event estimated while it stood, and cancelled afterwards, keeps the
 *    coordinate it was lent. The sweep no longer offers the row, and a stage
 *    that was offered it anyway records `skipped: event_did_not_happen` and
 *    writes nothing — it never withdraws a coordinate. Re-opening the ledger row
 *    therefore does nothing for a cancellation. The estimate has to be taken
 *    back by something that sees the status move, and that is the writer of the
 *    status, here, in the same transaction.
 *  - An event reinstated afterwards has to be offered again, or it stays
 *    unlocated for good: its ledger row says `done` (or `skipped:
 *    event_did_not_happen`, for one called off between the sweep and its slice)
 *    at the current version, and nothing but a version bump re-opens that.
 *
 * Which decisions those are, and how an estimate is taken back, is the
 * pipeline's business. The contract names events, not stages — as
 * `EVENT_TIME_REOPENER` does, which is this contract's counterpart for a time
 * that moved (eventTimeReopener.ts has the reasoning on the token).
 */
export const EVENT_STATUS_REOPENER = 'EVENT_STATUS_REOPENER';

export interface EventStatusReopener {
  /**
   * Settle, for these events, the pipeline's decisions on whether they
   * happened: take back what an event that did not happen was lent, and
   * re-open the ledger so one that did is offered again. Runs on `manager`, the
   * caller's transaction. Returns how many ledger rows moved; an event a stage
   * never decided has none to move (it is already a candidate).
   *
   * The pipeline decides from the stored row, not from the caller: it acts only
   * on an event whose status says it did not happen.
   */
  reopenStatusDecisions(eventIds: readonly string[], manager: Pick<EntityManager, 'query'>): Promise<number>;
}

/**
 * Resolve the {@link EVENT_STATUS_REOPENER} binding, or throw.
 *
 * Never returns null, for the reason `resolveEventTimeReopener` gives: a status
 * change whose settling cannot run leaves the row in a state no stage ever
 * revisits, so the change must fail (its transaction rolls back, a sync's next
 * delivery retries it) rather than land half-done. The api and the worker both
 * import PipelineModule, so the only way here is a container assembled without
 * it, or a service constructed by hand without a ModuleRef.
 */
export function resolveEventStatusReopener(moduleRef: ModuleRef | undefined): EventStatusReopener {
  let reopener: EventStatusReopener | undefined;

  try {
    reopener = moduleRef?.get<EventStatusReopener>(EVENT_STATUS_REOPENER, { strict: false });
  } catch (err: unknown) {
    throw new Error(
      `No provider is bound to ${EVENT_STATUS_REOPENER}. A status change that calls an event off, or ` +
        `reinstates it, cannot settle the pipeline's decisions on whether it happened without it ` +
        `(PipelineModule binds it). Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (reopener == null) {
    throw new Error(
      `${EVENT_STATUS_REOPENER} is unavailable (no ModuleRef): a status change that calls an event off, ` +
        `or reinstates it, cannot settle the pipeline's decisions on whether it happened. Construct the ` +
        `service through Nest, or hand it a ModuleRef that resolves the token.`,
    );
  }

  return reopener;
}
