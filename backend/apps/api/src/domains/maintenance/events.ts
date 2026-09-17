import { defineEvent } from '@ci/domains/events';

/**
 * Request a post-load search-index pass — embeddings + keyword tsvectors —
 * scoped to the entity types a bulk load wrote, without a compile-time
 * dependency between the emitter's domain and the consumer's.
 *
 * The emitter that exists for: the import domain's `PushStage`, whose post-push
 * kick cannot inject the indexing services directly (the module dependency
 * would close the cycle maintenance → llm → tools → import). Riding pg-boss
 * also makes the kick durable: a process killed between the push completing and
 * the sweep starting still has the job.
 *
 * CONSUMED BY THE PIPELINE DOMAIN, not maintenance: since the per-entity-type
 * `index.embed_*` / `index.vector*` stages landed, the request starts ledger
 * sweeps (`PipelineDispatchService.startSweep`) rather than the old
 * `SearchIndexBackfillService` — every row indexed off an import is recorded in
 * `ci.pipeline_state` with an outcome and a version. The event stays declared
 * here because the name is the wire contract and ids-on-the-wire are permanent;
 * the constant's home is a detail.
 *
 * Dogpile safety is the ledger's: a sweep re-requested while one runs selects
 * only rows still unclaimed, so a burst of requests degrades to empty hops, not
 * duplicate work.
 *
 * @see SearchIndexSweepRequestListener (domains/pipeline/listeners) - the consumer
 */
export const SearchIndexBackfillRequestEvent = 'maintenance.search-index-backfill-request';

/** Dedicated PGBoss queue so backfill requests don't block the default queue. */
export const SEARCH_INDEX_BACKFILL_QUEUE = 'search-index-backfill';

/**
 * Event payload of {@link SearchIndexBackfillRequestEvent}.
 */
export type SearchIndexBackfillRequestPayload = {
  /**
   * The user whose rows the sweeps cover. Pipeline sweeps are user-scoped by
   * design (`ci.pipeline_state` and every source query key on the owner), so a
   * request without a user cannot be started and is refused by the listener.
   */
  userId?: string;
  /**
   * Restrict the pass to these entity types. Plain strings rather than a
   * domain union so emitters don't need the import; the listener validates and
   * drops unknown values. Omitted → every indexable type.
   */
  entityTypes?: string[];
  /** Free-form provenance for the log line, e.g. `import-run:<uuid>`. */
  requestedBy?: string;
};

defineEvent<SearchIndexBackfillRequestPayload>(SearchIndexBackfillRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [SearchIndexBackfillRequestEvent]: SearchIndexBackfillRequestPayload;
  }
}

/**
 * Request a post-load GRAPH-EDGE projection pass — the `promote.edge_*` legs —
 * scoped to the source tables a bulk load wrote.
 *
 * ── Why this exists as a SECOND event ──────────────────────────────────────
 *
 * {@link SearchIndexBackfillRequestEvent} already gives a bulk load a
 * post-push kick, and for a long time it was the only one — so an import made
 * its rows SEARCHABLE within seconds and left them UNREACHABLE in the graph
 * for a day or more. That asymmetry is not theoretical: on the QA corpus the
 * index legs drained 777,340 communications the same afternoon, while
 * `ci.relationships` held 3,397 edges over 1,001,475 entities, because the
 * edge legs' last sweep had started two minutes before the push began.
 *
 * Widening the search-index event to mean "and also project edges" was the
 * cheaper change and is the wrong one: an event id is a wire contract, and
 * `search-index-backfill` carrying graph work is a name that lies to everyone
 * who greps for it later. Two events, two queues, two listeners — each
 * refusable, each greppable.
 *
 * Same emitter and same reasons as its sibling: the import domain's
 * `PushStage` cannot inject `PipelineDispatchService` (the module dependency
 * would close the cycle maintenance → llm → tools → import), and riding
 * pg-boss makes the kick survive a process killed between the push committing
 * and the sweep starting.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 *
 * Not a correctness requirement. `STAGE_SCHEDULES` puts every `promote.edge_*`
 * leg on an hourly, unwindowed cadence, so an import with no kick at all still
 * converges — this removes the last hour of that, which is the difference
 * between a graph that is populated when the user first opens it and one that
 * is populated the second time they look.
 *
 * Dogpile safety is the ledger's, exactly as for the search sweep: a re-request
 * while a sweep runs selects only unclaimed rows, so a burst degrades to empty
 * hops rather than duplicate edges (and the projection is
 * `ON CONFLICT DO NOTHING` besides).
 *
 * @see GraphEdgeSweepRequestListener (domains/pipeline/listeners) - the consumer
 */
export const GraphEdgeBackfillRequestEvent = 'maintenance.graph-edge-backfill-request';

/**
 * Dedicated PGBoss queue, for the same reason the search sweep has its own: a
 * slow projection must not sit in front of unrelated default-queue traffic, and
 * a queue per request kind is what makes "what is the graph kick doing?"
 * answerable from pg-boss alone.
 */
export const GRAPH_EDGE_BACKFILL_QUEUE = 'graph-edge-backfill';

/**
 * Event payload of {@link GraphEdgeBackfillRequestEvent}.
 */
export type GraphEdgeBackfillRequestPayload = {
  /**
   * The user whose rows the sweeps cover. Pipeline sweeps are user-scoped by
   * design, so a request without a user cannot be started and is refused by the
   * listener rather than guessed at.
   */
  userId?: string;
  /**
   * Restrict the pass to these edge SOURCE TABLES — the
   * `DeterministicEdgeSource` vocabulary (`communications`, `events`,
   * `content`, …). Plain strings rather than the union so emitters need no
   * import from the maintenance domain; the listener validates and drops
   * unknown values. Omitted → every source with an edge leg.
   */
  sources?: string[];
  /** Free-form provenance for the log line, e.g. `import-run:<uuid>`. */
  requestedBy?: string;
};

defineEvent<GraphEdgeBackfillRequestPayload>(GraphEdgeBackfillRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [GraphEdgeBackfillRequestEvent]: GraphEdgeBackfillRequestPayload;
  }
}

/**
 * Run the nightly DERIVATION pass for one user.
 *
 * ── Why an event and not a direct call in the cron ─────────────────────────
 *
 * The same shape `PythonFunctionCrons.fanOut` uses, for the same three reasons:
 * one pg-boss job per user means a per-user failure retries on its own instead
 * of aborting the fan-out; a window-scoped `singletonKey`
 * (`derive:<userId>:<dayKey>`) means a slow pass never stacks a second copy of
 * itself on the next tick; and the job survives the process being killed
 * between the tick and the work.
 *
 * The key is only ENFORCED because {@link DERIVATION_RUN_QUEUE} declares
 * `policy: 'short'` — under pg-boss 10's default `standard` a singletonKey is
 * stored and never checked. Every send on this queue carries one, which is what
 * makes the queue-wide policy safe.
 *
 * @see DerivationCron - the producer
 * @see DerivationRunListener - the consumer
 */
export const DerivationRunRequestEvent = 'maintenance.derivation-run-request';

/**
 * Dedicated PGBoss queue, consumed by the WORKER process
 * (`queueOptions.role: 'worker'` on the listener). A nightly graph aggregate is
 * exactly the "heavy in-process sweep" the split exists for, and giving it its
 * own queue is what makes "what is the derivation pass doing?" answerable from
 * pg-boss alone.
 */
export const DERIVATION_RUN_QUEUE = 'derivation-run';

/** Event payload of {@link DerivationRunRequestEvent}. */
export type DerivationRunRequestPayload = {
  /**
   * The user whose graph is derived. Every leg is user-scoped SQL, so a request
   * without a user cannot be run and is refused by the listener rather than
   * guessed at.
   */
  userId?: string;
  /**
   * The UTC day this run belongs to (`YYYY-MM-DD`) — the window component of
   * the singleton key, carried on the payload so a job in flight says which
   * night it is for.
   */
  dayKey?: string;
  /** Free-form provenance for the log line, e.g. `DerivationCron`. */
  requestedBy?: string;
};

defineEvent<DerivationRunRequestPayload>(DerivationRunRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [DerivationRunRequestEvent]: DerivationRunRequestPayload;
  }
}

/**
 * Request a people-stub pass over a user's communications: create a stub
 * Person (and its `ci.entity_identifiers` row) for every participant the
 * identifier index does not yet know, so the person-link stage has someone to
 * resolve against.
 *
 * The emitter that exists for: the import domain's `PushStage`, after a bulk
 * push of communications. Bulk-created rows emit no per-row
 * `CommunicationCreatedEvent`, so the inline listener never sees them, and the
 * people they name used to exist only once an operator ran
 * `POST /api/maintenance/extract-people-from-communications` by hand. Meanwhile
 * the person-link stage had already swept the messages and recorded every
 * name as resolving to nobody. Requesting the pass here puts the people in the
 * index within minutes of the push; whatever the linker decided before they
 * arrived is re-opened by `IdentifierArrivalService` on the next tick.
 *
 * Same wire shape as the sibling kicks: durable on pg-boss, no compile-time
 * dependency from import on maintenance (the barrel would close the cycle
 * maintenance → llm → tools → import).
 *
 * @see PersonStubBackfillRequestListener (this domain) - the consumer
 */
export const PersonStubBackfillRequestEvent = 'maintenance.person-stub-backfill-request';

/** Dedicated PGBoss queue, like the other post-push kicks. */
export const PERSON_STUB_BACKFILL_QUEUE = 'person-stub-backfill';

/** Event payload of {@link PersonStubBackfillRequestEvent}. */
export type PersonStubBackfillRequestPayload = {
  /** The owner whose communications are walked. Refused without one. */
  userId?: string;
  /** Free-form provenance for the log line, e.g. `import-run:<uuid>`. */
  requestedBy?: string;
};

defineEvent<PersonStubBackfillRequestPayload>(PersonStubBackfillRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [PersonStubBackfillRequestEvent]: PersonStubBackfillRequestPayload;
  }
}
