import { STAGE_ID_LIST, STAGE_IDS, type StageId } from './constants';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SAME-ROW RE-OPENS. A producer's `done` makes a consumer's old decision stale.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `STAGE_DEPENDENCIES` orders a consumer behind its producers: on a tick where a
 * producer is due with candidates, the consumer waits. That is ordering WITHIN
 * a tick. It says nothing ACROSS ticks: once the consumer has recorded `done`
 * for a row at its current version, THE ONE RULE never offers it that row
 * again, whatever a producer writes onto the row afterwards. Only a version bump
 * does, and a bump re-opens the whole corpus for a handful of rows' worth of
 * news.
 *
 * Most consumers are safe from this by construction. Their applicability
 * predicate requires the producer's column to be POPULATED, so a row cannot be
 * decided before the producer has written it; it becomes a candidate — never
 * run, immediately due — the moment the column is filled.
 *
 * A consumer whose predicate is an OR over columns filled by DIFFERENT
 * producers has no such protection, and `promote.edge_event` is one:
 *
 *   organizer_entity_id, participant_entity_ids   ← enrich.event_person_link
 *   location_entity_id                             ← promote.place
 *   parent_event_id                                ← importers
 *
 * An event with participants qualifies before it has a place link. The edge leg
 * projects its PARTICIPATED_IN edges and records `done`. When `promote.place`
 * links it later — the night `enrich.geocode` resolves its `location_name`, or
 * `enrich.estimate_location` gives it a coordinate — the decided row is never
 * re-offered, so its Event −LOCATED_AT→ Place edge (`event.happened_at`) is
 * never projected. The edge leg runs hourly at any hour and `promote.place`
 * nightly, so the order that loses the edge is the ordinary one, not a race.
 *
 * `promote.edge_communication` is another, and a message is decided on the
 * FIRST of its columns to arrive:
 *
 *   from_entity_id, to_entity_ids   ← the importer's push (whatever it could
 *                                     resolve at ingest), enrich.person_link,
 *                                     and the maintenance linkers
 *   attachments                     ← the importer's push
 *
 * A Twitter DM with an attachment is decided on its ATTACHED_TO edge before its
 * participants have people. A WhatsApp message the owner sent arrives with its
 * recipient and no sender. Whatever links the rest afterwards has to re-open
 * the decision, or the SENT / RECEIVED edges for it never exist (17,417
 * messages on the reference appliance, 2026-09-30). `enrich.person_link` does
 * it through the declaration below. The same holds for
 * `enrich.event_person_link` against the event leg.
 *
 * ── What a declaration here means ─────────────────────────────────────────
 *
 * `[producer]: [consumer, …]` — when the producer records `done` for an id,
 * each consumer's ledger row for THE SAME `(entity_type, id)` is re-opened
 * through `PipelineStateService.reopen()`: `stage_version` back to 0, so the
 * next sweep re-decides it against the row as it now stands. Re-deciding a row
 * whose output did not change costs one idempotent pass (the edge projection
 * is `ON CONFLICT DO NOTHING`), so no attempt is made to tell a changed link
 * from a confirmed one.
 *
 * `PipelineSliceListener` applies it, not the producer: a stage never writes
 * the ledger (see `Stage` in `types.ts`), and keeping the graph out of the stage
 * keeps "ids in, decisions out" true. The producer only reports `done`, exactly
 * as it always has.
 *
 * Only `done` re-opens. It is the outcome that says the producer wrote (or
 * confirmed) its output; a skip wrote nothing, and a failure is retried on its
 * own gate and re-opens when it finally succeeds.
 *
 * The re-open runs BEFORE the producer's own results are recorded. If it throws,
 * the producer's claimed rows are failed and retried like any slice that threw,
 * and the retry re-opens again — so there is no moment at which the producer is
 * `done` and the consumer was never told.
 *
 * ── What it does NOT cover ────────────────────────────────────────────────
 *
 *  - A consumer row that is `running` when the re-open lands is a live claim,
 *    and `reopen()` leaves it alone; when it completes it is stamped at the
 *    current version like any other. If that projection read the row before
 *    the producer's write committed, the edge is still missed. The window is
 *    two stages working the same id within the same seconds, which
 *    `STAGE_DEPENDENCIES` and the queue's FIFO order make rare. Closing it
 *    needs a ledger that can mark a claimed row dirty, which this one cannot.
 *  - A write by something that is not a stage never reports `done`, so nothing
 *    here can see it. Such a writer re-opens the decision ITSELF, in its own
 *    transaction, through `EDGE_PROJECTION_REOPENER`
 *    (`maintenance/edgeProjectionReopener.ts`, bound to
 *    `EdgeProjectionReopenService`). The maintenance linkers do:
 *    `CommunicationLinkBackfillService` and `EventParticipantBackfillService`
 *    (the `link_*` legs smart-rotation's `graph_link` runs every two hours) and
 *    `CommunicationParticipantLinkListener`. They were the writer behind 17,416
 *    of those 17,417 messages. The legacy `GeocodeBatchListener`, which also
 *    writes `ci.events.location_entity_id`, still does not.
 *  - A person or place merge that RACES the projection, in the one window the
 *    merge cannot close. `PersonMergeService` and `PlaceMergeService` re-point
 *    the losers' edges to the survivor and then sweep what is left
 *    (`memory/services/mergeEdgeSweep.ts`), moving a loser edge a projection
 *    committed in between onto the survivor. They used to delete it, with the
 *    leg's ledger row still `running`, so no re-open could have reached it:
 *    five SENT/RECEIVED edges were lost that way in one person merge on the
 *    reference appliance at 15:23 on 2026-09-30, during a
 *    `DeterministicPersonMergeCron` drain, and repair migration
 *    `20260930161359` re-opened those five. The place merge ended in the same
 *    statement and re-points the columns `promote.edge_event`,
 *    `promote.edge_position` and `promote.edge_place` read; no loss is recorded
 *    for it, but the real-Postgres specs show the same one. What is left is a
 *    projection whose own snapshot predates the merge's commit and that commits
 *    after the sweep: its edge stays on the tombstone while the row is `done`.
 *    That window is the length of the sweep plus the rest of the merge's
 *    transaction; closing it would take a lock the projection also takes.
 *
 * ── Rules ─────────────────────────────────────────────────────────────────
 *
 *  - Producer and consumer key their ledgers on the SAME row: same source
 *    table and id column, and the consumer declares every entity type the
 *    producer records under. `__tests__/stageWiring.spec.ts` checks it against
 *    the real stage classes, because the two stages' sources are only known once
 *    they are constructed.
 *  - Every edge here is also a `STAGE_DEPENDENCIES` edge: a consumer that
 *    re-reads a producer's output must also be ordered after it.
 *    `assertStagePolicy()` checks it at module load, beside that map.
 *  - Ids are declared stage ids and no stage re-opens itself — checked below, at
 *    module load, for the reason every declaration in this domain is: a typo
 *    here is a re-open that silently never happens.
 */
export const STAGE_REOPENS: Readonly<Partial<Record<StageId, readonly StageId[]>>> = {
  [STAGE_IDS.PROMOTE_PLACE]: [STAGE_IDS.PROMOTE_EDGE_EVENT],
  // The person-link legs MERGE into the linkage columns: a `done` can add a
  // sender or recipients to a message the edge leg projected when it had only
  // an attachment, or only its other half. On a real import this is the NORMAL
  // order: the edge leg projects the push's rows hourly, the linkers run
  // nightly. `done` also covers a pass that added nothing new; re-deciding
  // that costs one idempotent projection. `IdentifierArrivalService`'s re-opens
  // of these producers reach the edge legs through this too, when they finish.
  [STAGE_IDS.ENRICH_PERSON_LINK]: [STAGE_IDS.PROMOTE_EDGE_COMMUNICATION],
  [STAGE_IDS.ENRICH_EVENT_PERSON_LINK]: [STAGE_IDS.PROMOTE_EDGE_EVENT],
};

/** The consumers a producer's `done` results re-open. Empty for most stages. */
export function stagesReopenedBy(producer: string): readonly StageId[] {
  return STAGE_REOPENS[producer as StageId] ?? [];
}

/** Module-load guard over {@link STAGE_REOPENS}. */
export function assertStageReopens(
  reopens: Partial<Record<string, readonly string[]>> = STAGE_REOPENS,
): void {
  const declared = new Set<string>(STAGE_ID_LIST);
  const problems: string[] = [];

  for (const [producer, consumers] of Object.entries(reopens)) {
    if (!declared.has(producer)) {
      problems.push(`"${producer}" is a key of STAGE_REOPENS but is not a declared stage id`);
    }

    for (const consumer of consumers ?? []) {
      if (!declared.has(consumer)) {
        problems.push(`"${producer}" re-opens "${consumer}", which is not a declared stage id`);
      }

      if (consumer === producer) {
        problems.push(`"${producer}" re-opens itself`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`STAGE_REOPENS is invalid — ${problems.join('; ')}.`);
  }
}

assertStageReopens();
