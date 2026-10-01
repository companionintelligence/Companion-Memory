import type { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';

/**
 * Re-opens the pipeline's decisions about an event's TIME for events whose time
 * a writer outside the pipeline has just moved. The pipeline domain implements
 * it (`EventTimeReopenService`) and PipelineModule binds
 * {@link EVENT_TIME_REOPENER} to that implementation.
 *
 * ── Why the source refresh has to say anything ─────────────────────────────
 *
 * Stages decide on an event's time once, record `done`, and THE ONE RULE never
 * offers the row again at that version. Two of those decisions are wrong the
 * moment the time moves:
 *
 *  - `clean.temporal_repair` moves an all-day row from UTC midnight (how the
 *    Google transform stores a bare date) to the user's local midnight. When
 *    the source moves that event, the refresh writes the source's new UTC
 *    midnight and clears the stage's markers; without a re-open the row would
 *    keep that until the stage's next version bump, drawn a day early for
 *    everyone west of Greenwich.
 *  - `enrich.estimate_location` lent the event a coordinate from where the
 *    user was around its OLD time. It recomputes its own estimates, but only
 *    when offered the row again.
 *
 * A stage's `done` re-opens its consumers through `STAGE_REOPENS`. The refresh
 * is not a stage, so it re-opens the decisions itself, in the SAME transaction
 * as the write that moved the time: both commit, or neither.
 *
 * ── Why a token ────────────────────────────────────────────────────────────
 *
 * PipelineModule imports MemoryModule, so a pipeline service injected here
 * would need a module-level cycle. Memory owns the contract, pipeline supplies
 * it, and CalendarEventService resolves it lazily with
 * {@link resolveEventTimeReopener} — the `SELF_ENTITY_PROVISIONER` pattern, and
 * maintenance's `EDGE_PROJECTION_REOPENER`. The contract names events, not
 * stage ids: which stages decided on an event's time is the pipeline's
 * business.
 */
export const EVENT_TIME_REOPENER = 'EVENT_TIME_REOPENER';

export interface EventTimeReopener {
  /**
   * Re-open, for these events, every pipeline decision made on their time.
   * Runs on `manager`, the caller's transaction. Returns how many ledger rows
   * moved; an event a stage never decided has none to move (it is already a
   * candidate).
   */
  reopenTimeDecisions(eventIds: readonly string[], manager: Pick<EntityManager, 'query'>): Promise<number>;
}

/**
 * Resolve the {@link EVENT_TIME_REOPENER} binding, or throw.
 *
 * Never returns null, for the reason `resolveEdgeProjectionReopener` gives: a
 * time move whose re-open cannot run leaves the row in a state no stage ever
 * revisits, so the move must fail (its transaction rolls back, the sync logs
 * the event and the source's next delivery retries it) rather than land
 * half-done. The api and the worker both import PipelineModule, so the only
 * way here is a container assembled without it, or a service constructed by
 * hand without a ModuleRef.
 */
export function resolveEventTimeReopener(moduleRef: ModuleRef | undefined): EventTimeReopener {
  let reopener: EventTimeReopener | undefined;

  try {
    reopener = moduleRef?.get<EventTimeReopener>(EVENT_TIME_REOPENER, { strict: false });
  } catch (err: unknown) {
    throw new Error(
      `No provider is bound to ${EVENT_TIME_REOPENER}. A source's time move cannot re-open the ` +
        `pipeline's decisions on the event's time without it (PipelineModule binds it). Cause: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (reopener == null) {
    throw new Error(
      `${EVENT_TIME_REOPENER} is unavailable (no ModuleRef): a source's time move cannot re-open the ` +
        `pipeline's decisions on the event's time. Construct the service through Nest, or hand it a ` +
        `ModuleRef that resolves the token.`,
    );
  }

  return reopener;
}
