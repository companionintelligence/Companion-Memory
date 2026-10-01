import type { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';

/**
 * Re-opens the pipeline's decisions about an event's LOCATION for events whose
 * location a writer outside the pipeline has just moved. The pipeline domain
 * implements it (`EventLocationReopenService`) and PipelineModule binds
 * {@link EVENT_LOCATION_REOPENER} to that implementation. It is the location's
 * twin of `EVENT_TIME_REOPENER` (eventTimeReopener.ts), and is shaped the same
 * way for the same reasons.
 *
 * ── Why the source refresh has to say anything ─────────────────────────────
 *
 * Stages decide on an event's location once, record `done` or `skipped`, and
 * THE ONE RULE never offers the row again at that version. Four of those
 * decisions are wrong the moment the source moves the place:
 *
 *  - `enrich.geocode` resolved the OLD name to a point (or recorded that it
 *    could not). The new name has never been asked about.
 *  - `enrich.event_reverse` named the old point; a delivery that brings a point
 *    with no name wants one.
 *  - `enrich.estimate_location` lent a neighbour's point to an event with no
 *    place of its own, and recorded `has_location_name` for one that had a name.
 *    A delivery that adds a place makes the first obsolete; one that removes it
 *    makes the event a candidate again.
 *  - `promote.place` linked the old name and point to a Location.
 *
 * A stage's `done` re-opens its consumers through `STAGE_REOPENS`. The refresh
 * is not a stage, so it re-opens the decisions itself, in the SAME transaction
 * as the write that moved the place: both commit, or neither.
 *
 * ── Why a token ────────────────────────────────────────────────────────────
 *
 * PipelineModule imports MemoryModule, so a pipeline service injected here
 * would need a module-level cycle. Memory owns the contract, pipeline supplies
 * it, and CalendarEventService resolves it lazily with
 * {@link resolveEventLocationReopener} — the `EVENT_TIME_REOPENER` pattern. The
 * contract names events, not stage ids: which stages decided on an event's
 * location is the pipeline's business.
 */
export const EVENT_LOCATION_REOPENER = 'EVENT_LOCATION_REOPENER';

export interface EventLocationReopener {
  /**
   * Re-open, for these events, every pipeline decision made on their location.
   * Runs on `manager`, the caller's transaction. Returns how many ledger rows
   * moved; an event a stage never decided has none to move (it is already a
   * candidate).
   */
  reopenLocationDecisions(
    eventIds: readonly string[],
    manager: Pick<EntityManager, 'query'>,
  ): Promise<number>;
}

/**
 * Resolve the {@link EVENT_LOCATION_REOPENER} binding, or throw.
 *
 * Never returns null, for the reason `resolveEventTimeReopener` gives: a
 * location move whose re-open cannot run leaves the row in a state no stage ever
 * revisits (a name that no stage has geocoded, a link to the old place), so the
 * move must fail (its transaction rolls back, the sync logs the event and the
 * source's next delivery retries it) rather than land half-done. The api and
 * the worker both import PipelineModule, so the only way here is a container
 * assembled without it, or a service constructed by hand without a ModuleRef.
 */
export function resolveEventLocationReopener(moduleRef: ModuleRef | undefined): EventLocationReopener {
  let reopener: EventLocationReopener | undefined;

  try {
    reopener = moduleRef?.get<EventLocationReopener>(EVENT_LOCATION_REOPENER, { strict: false });
  } catch (err: unknown) {
    throw new Error(
      `No provider is bound to ${EVENT_LOCATION_REOPENER}. A source's location move cannot re-open the ` +
        `pipeline's decisions on the event's place without it (PipelineModule binds it). Cause: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (reopener == null) {
    throw new Error(
      `${EVENT_LOCATION_REOPENER} is unavailable (no ModuleRef): a source's location move cannot re-open ` +
        `the pipeline's decisions on the event's place. Construct the service through Nest, or hand it a ` +
        `ModuleRef that resolves the token.`,
    );
  }

  return reopener;
}
