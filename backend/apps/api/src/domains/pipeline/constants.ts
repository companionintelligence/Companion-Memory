/**
 * Declared, reviewable constants for the pipeline control plane.
 *
 * Everything here is DECLARED rather than DISCOVERED. The event bus derives its
 * queue set from `@OnEvent` decorator side effects collected at module-import
 * time (`domains/events/event-registration.ts`), which means the set of queues
 * that exists depends on which files happened to be imported. That is
 * acceptable for a bus whose queues are incidental; it is not acceptable for a
 * pipeline, where "which queues exist" is a capacity decision. A queue name
 * that only exists as a string literal inside a decorator cannot be reviewed in
 * a diff, snapshot-tested, or reasoned about at planning time.
 */

import config from '@ci/configuration';

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/**
 * The pipeline's queues, one per RESOURCE CLASS rather than one per stage.
 *
 * Effective global concurrency on the appliance is 10 in-flight jobs across
 * every queue (`config/default.json` → `queues.concurrency`), with a per-queue
 * ceiling of 6. Splitting work into more queues than resource classes therefore
 * buys nothing but scheduling noise: the queues would contend for the same ten
 * slots. The split that matters is the one that keeps a queue bound by a SLOW
 * shared resource from consuming the slots a fast one needs:
 *
 *   - `pipeline-index`  — Postgres-bound. Cheap, high-throughput ledger and
 *     index writes. Also carries the pipeline's own housekeeping (sweeps,
 *     dead-letter reaps) because those are Postgres-bound too.
 *   - `pipeline-enrich` — mixed local CPU + object storage + external providers
 *     (sharp/ffprobe probes, document parsing, geocode). Slow, bursty, and the
 *     class most likely to have one job block for minutes.
 *   - `pipeline-embed`  — Ollama-bound. The single host Ollama process is shared
 *     with interactive chat, HBPE and the summary sidecar, so embedding work is
 *     isolated on its own queue to keep it from taking every global slot during
 *     a full-corpus re-embed.
 *
 * These names are consumed by `@OnEvent(..., { queue })` in the pipeline
 * listeners, which is what causes `PGBossEventService.onModuleInit` to create
 * the pg-boss queues and start workers for them. Renaming one strands whatever
 * is already queued under the old name.
 */
export const PIPELINE_QUEUES = {
  INDEX: 'pipeline-index',
  ENRICH: 'pipeline-enrich',
  EMBED: 'pipeline-embed',
} as const;

export type PipelineQueue = (typeof PIPELINE_QUEUES)[keyof typeof PIPELINE_QUEUES];

/** Every pipeline queue, in declaration order. Useful for snapshot tests and boot checks. */
export const PIPELINE_QUEUE_NAMES: readonly PipelineQueue[] = Object.values(PIPELINE_QUEUES);

/**
 * The queue that carries the pipeline's own housekeeping — sweeps and
 * dead-letter reap requests. Postgres-bound and cheap, so it rides on
 * `pipeline-index` rather than justifying a fourth queue against a budget of
 * ten global slots.
 */
export const PIPELINE_CONTROL_QUEUE: PipelineQueue = PIPELINE_QUEUES.INDEX;

/**
 * pg-boss's shared dead-letter queue.
 *
 * DUPLICATED from `PGBossEventService.DEAD_LETTER_QUEUE`, which is `private
 * static` and therefore not importable. The two MUST stay identical — this is
 * the queue name {@link DeadLetterReaperListener} reads out of `pgboss.job`, and
 * a drift means the reaper silently harvests nothing forever. Exporting the
 * constant from `domains/events` and importing it here is the correct fix; it
 * is not made in this change because that file belongs to another change set.
 */
export const DEAD_LETTER_QUEUE = 'dead-letter';

// ---------------------------------------------------------------------------
// Stage ids
// ---------------------------------------------------------------------------

/**
 * Every stage id the pipeline knows about.
 *
 * A stage id is `<phase>.<name>`: `get.*`, `index.*`, `enrich.*`, `clean.*`,
 * `promote.*`. The phase prefix is not enforced in code — it is a naming
 * convention that makes `GET /api/pipeline/state` groupable and makes a stage's
 * position in the flow legible from its id alone.
 *
 * IDS ARE PERMANENT. The id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming one abandons every ledger row written under the old
 * name: the sweep stops finding them, coverage silently drops to zero, and the
 * whole corpus is re-processed under the new id. If a stage's meaning changes,
 * bump its version (see `versions.ts`); if it is genuinely a different stage,
 * add a new id and leave the old rows to be reaped deliberately.
 *
 * This list grows by ONE ENTRY PER CONVERSION. Each maintenance leg moves onto
 * the ledger in its own change; declaring the whole planned roadmap here up
 * front would make `GET /api/pipeline/state` report a dozen stages at 0 %
 * coverage that no code can ever advance. Planned-but-unconverted ids live in
 * the rebuild plan document, not in this file.
 */
export const STAGE_IDS = {
  /**
   * Probe `ci.files` originals for width/height. The first conversion: smallest
   * leg, no external dependency, and the ledger fixes a bug for free — an
   * unreadable probe becomes `status='skipped', reason='probe_failed'` instead
   * of a permanently-NULL column that every future run re-fetches from object
   * storage and re-decodes.
   */
  ENRICH_MEDIA_DIMENSIONS: 'enrich.media_dimensions',

  /**
   * Dense-embed `ci.content` into `ci_search.embeddings`. The conversion that
   * justifies the whole rebuild, because its version is not a hand-chosen
   * integer: it is a function of `(embedding model, pgvector width)`, so
   * changing `CI_EMBED_MODEL` re-embeds the corpus by itself. See
   * `versions.ts` for how a derived version is declared, and
   * `stages/index/EmbedStage.ts` for why a hash would have been dangerous here.
   *
   * `index.*`, not `enrich.*`: this writes a search index, and the sibling
   * tsvector work belongs to a separate `index.vector` stage rather than being
   * smuggled in where one version bump could not address the two separately.
   */
  INDEX_EMBED: 'index.embed',

  /**
   * Reverse-geocode `ci.position` fixes into the seven address columns that
   * have existed since `20251111000000_add_position_fields` and that NO CODE
   * has ever written.
   *
   * The one stage on this list whose sweep is a BILL — `ci.position` is the
   * largest table on the appliance and the provider is metered — so it is swept
   * deliberately rather than nightly. `stages/enrich/PositionReverseStage.ts`
   * carries the cost argument and the two generations its version derives from.
   */
  ENRICH_POSITION_REVERSE: 'enrich.position_reverse',

  /**
   * Forward-geocode `ci.events.location_name` into `location_coordinates`,
   * replacing `GeocodeBatchListener`'s sweep. That listener's candidate predicate
   * is `location_coordinates IS NULL`, and its own comment states the
   * consequence — "a resolved coordinate is never re-billed" — so every coarse
   * city-centroid hit it ever wrote is frozen for the life of the appliance.
   *
   * The second stage whose sweep is a BILL, not just CPU: it egresses through
   * Portal to a paid provider. Bump deliberately.
   */
  ENRICH_GEOCODE: 'enrich.geocode',

  /**
   * Fill a physical-presence event's coordinates from the nearest-in-time REAL
   * location, replacing `LocationEstimateService`'s temporal fill — and its
   * `forced` flag, a request-scoped re-run lever that recorded nothing anywhere.
   *
   * Its version tracks the geocode provider generation as well as its own rule,
   * because its donors are overwhelmingly rows `enrich.geocode` resolved: an
   * estimate is a COPY of a donor's coordinate, so a better geocoder makes every
   * estimate stale too.
   */
  ENRICH_ESTIMATE_LOCATION: 'enrich.estimate_location',

  /**
   * Resolve a communication's participants to people, writing the evidence to
   * `ci.identifier_claims` and PROJECTING the resolved ids onto
   * `from_entity_id` / `to_entity_ids`.
   *
   * Replaces the sweeps of `PersonStubBackfillService` and
   * `CommunicationLinkBackfillService`, whose shared candidate predicate —
   * `(from_entity_id IS NULL OR to_entity_ids IS NULL OR
   * cardinality(to_entity_ids) = 0)` — is the ratchet at its worst: a row is
   * declared finished as soon as ONE recipient resolves, so a message to five
   * people where one had a contact can never link the other four.
   *
   * Postgres-only. Four statements per slice, no provider and no bill, so a
   * bump is CPU on the appliance and nothing else.
   */
  ENRICH_PERSON_LINK: 'enrich.person_link',

  /**
   * The same algorithm over `ci.events`, replacing
   * `EventParticipantBackfillService`.
   *
   * A SECOND id rather than a second entity type, because a `Stage` declares
   * exactly one `source` and this is a different table — see the long note at
   * the top of `stages/enrich/PersonLinkStage.ts`, which both ids share. Their
   * implementation, normalisation, confidence and version are all common, so
   * the two can only ever be swept independently, never disagree.
   */
  ENRICH_EVENT_PERSON_LINK: 'enrich.event_person_link',

  /**
   * Repair `ci.events.start_time` where the source's own timestamp can be
   * recovered, and LABEL it where it cannot. Two documented defects:
   * `TransformGoogleCalendar` declares `start.timeZone` and never reads it, so a
   * bare date becomes UTC midnight and a floating date-time becomes HOST-local;
   * and undated records are stamped with the import run's wall clock.
   *
   * The first stage whose sweep MOVES DATES THE USER HAS ALREADY SEEN. It writes
   * `start_time_original` alongside, never over, so the repair is reversible and
   * "which dates did we move?" stays answerable. Bump deliberately.
   */
  CLEAN_TEMPORAL_REPAIR: 'clean.temporal_repair',

  /**
   * PROPOSE duplicate entities into `ci.merge_candidates`; never merge them.
   * The standing decision is that CLEAN proposes and a human disposes, so this
   * stage scores pairs and records the evidence, and a bump RESCORES pending
   * candidates without resurrecting a pair a human already rejected.
   */
  CLEAN_DUPLICATE_DETECT: 'clean.duplicate_detect',

  /**
   * Canonicalise identifiers already stored — emails, phones to E.164, handles —
   * so identity work runs over a consistent corpus. Writes `value_e164` BESIDE
   * `value` rather than over it: `value` is a join key existing rows point at.
   * Idempotent by construction.
   */
  CLEAN_IDENTIFIER_NORMALIZE: 'clean.identifier_normalize',

  /**
   * Promote a resolved event location into a first-class place: the entity, its
   * city -> region -> country hierarchy, and `ci.entities.location_boundary`,
   * which no code has ever written. Costs nothing metered — the hierarchy comes
   * out of `ci.geocode_cache` by primary key — so a better place-dedupe rule can
   * re-run over the whole corpus without re-billing the geocoder.
   */
  PROMOTE_PLACE: 'promote.place',

  /**
   * Promote purchases into `ci.inventory` with real identity — the first writer
   * the rich object model has ever had.
   */
  PROMOTE_OBJECT: 'promote.object',

  /**
   * Project a communication's resolved participant columns (`from_entity_id`,
   * `to_entity_ids` — `enrich.person_link`'s output) into `ci.relationships`
   * SENT / RECEIVED edges, resolved through merge tombstones onto canonical
   * people. The graph traversal walks ONLY `ci.relationships`, so without this
   * stage a linked communication is invisible to the graph view. The pipeline
   * face of the deterministic-edge matrix; the operator backfill endpoint
   * (`POST /api/maintenance/materialize-edges`) sweeps history in time
   * windows, this keeps up with new data in ledger slices.
   */
  PROMOTE_EDGE_COMMUNICATION: 'promote.edge_communication',

  /**
   * The same projection over `ci.events`: organizer / participants →
   * PARTICIPATED_IN, resolved location → HAPPENED_AT. A second id rather than
   * a second entity type, for the reason `enrich.event_person_link` is one —
   * a `Stage` declares exactly one `source`, and the matrix reads two tables.
   */
  PROMOTE_EDGE_EVENT: 'promote.edge_event',

  /**
   * The same projection over `ci.content`: rows attached to an event
   * (`content.event_id`, written at ingest) become Content −PART_OF→ Event
   * edges — what makes a photo or document reachable from its event in the
   * graph view.
   */
  PROMOTE_EDGE_CONTENT: 'promote.edge_content',

  /**
   * The same projection over `ci.inventory`: `last_seen_place_entity_id`
   * (written by `promote.object` and importers) becomes Item −LOCATED_AT→
   * Place.
   */
  PROMOTE_EDGE_INVENTORY: 'promote.edge_inventory',

  /**
   * The same projection over `ci.receipts`: extraction's resolved columns
   * become Merchant −LOCATED_AT→ Place, document Content −PART_OF→ purchase
   * Event, and Event −HAPPENED_AT→ Place — the receipt row is the evidence,
   * the edge relates the entities it names.
   */
  PROMOTE_EDGE_RECEIPT: 'promote.edge_receipt',

  /**
   * The same projection over `ci.object_observations`: Content −PART_OF→
   * Event, resolved Item −LOCATED_AT→ Place and Item −ASSOCIATED_WITH→
   * Content (what the item was depicted in).
   */
  PROMOTE_EDGE_OBSERVATION: 'promote.edge_observation',

  /**
   * The same projection over `ci.position`: fixes snapped to a known place
   * (`location_entity_id`) become owner Person −VISITED→ Place. Telemetry
   * volume in, a handful of distinct edges out — the projection's DISTINCT
   * and the directed-unique index do the collapsing.
   */
  PROMOTE_EDGE_POSITION: 'promote.edge_position',

  /**
   * The same projection over `ci.devices`: registered devices with an entity
   * mirror become owner Person −OWNS→ Device.
   */
  PROMOTE_EDGE_DEVICE: 'promote.edge_device',

  /**
   * File hierarchy: `ci.files.parent_id` → File −DERIVED_FROM→ File via the
   * linked File graph entity mirror.
   */
  PROMOTE_EDGE_FILE: 'promote.edge_file',

  /**
   * Place hierarchy: `ci.entities.parent_place_id` → Place −PART_OF→ Place.
   */
  PROMOTE_EDGE_PLACE: 'promote.edge_place',
} as const;

export type StageId = (typeof STAGE_IDS)[keyof typeof STAGE_IDS];

/** Every declared stage id, in declaration order. */
export const STAGE_ID_LIST: readonly StageId[] = Object.values(STAGE_IDS);

// ---------------------------------------------------------------------------
// Slice sizing
// ---------------------------------------------------------------------------

/**
 * Entity ids carried by one slice — i.e. one pg-boss job's worth of work.
 *
 * Sized so a slice is ~60 s of work for a mid-cost stage, which is two orders
 * of magnitude inside pg-boss's `expireInHours: 12`. The point of a small slice
 * is not throughput (a bigger slice would amortise the fetch better) but
 * RESUMABILITY: a killed worker loses exactly one slice, and the ledger rows
 * for everything already completed survive. Today's batch listeners lose a
 * whole 200-row batch when the process dies at row 199, because the counters
 * are local variables and the pg-boss job is atomic.
 */
export const DEFAULT_SLICE_SIZE = 200;

/**
 * Hard ceiling on ids per slice, enforced by the slice payload schema.
 *
 * A slice is claimed with a single `unnest($ids::uuid[])` upsert, so the array
 * is one bind parameter regardless of length — the ceiling is about work
 * granularity, not statement size. An oversized slice re-introduces exactly the
 * unresumable batch the pipeline exists to delete.
 */
export const MAX_SLICE_SIZE = 1000;

/**
 * Slices a single sweep hop may enqueue before it stops and re-enqueues ITSELF
 * behind them.
 *
 * This is the pipeline's backpressure in Phase 1, and it is free: the sweep job
 * rides the SAME queue as the slices it produces, at the same priority, so
 * pg-boss's FIFO-within-priority ordering means the next hop cannot run until
 * the slices ahead of it have been worked. A sweep therefore paces itself to
 * the workers' actual rate instead of enqueuing a million-row corpus in one
 * pass and burying every other queue's traffic behind it.
 */
export const MAX_SLICES_PER_SWEEP = 5;

/**
 * Absolute ceiling on sweep hops for one (stage, user) sweep.
 *
 * A sweep that fails to advance its cursor would otherwise re-enqueue itself
 * forever, and a self-requeuing job with no fuel gauge is the one bug class
 * that can fill `pgboss.job` faster than any worker drains it. The dispatcher
 * additionally asserts the cursor strictly advanced on every hop; this is the
 * belt to that braces, sized so a default-slice sweep can still cover
 * 10,000 hops × 5 slices × 200 ids = 10M entities in one run.
 */
export const MAX_SWEEP_HOPS = 10_000;

// ---------------------------------------------------------------------------
// Leases and retries
// ---------------------------------------------------------------------------

/**
 * How long a `status='running'` ledger row is treated as owned by a live worker.
 *
 * `claim()` refuses to re-claim a row another worker is already running, which
 * is what makes two concurrently-dispatched slices over the same ids do the work
 * once instead of twice. A crashed worker never clears its rows, so the claim
 * has to expire or those entities would be stranded in `running` forever —
 * invisible to the staleness sweep, which only reclaims NULL / stale-version /
 * retry-due rows.
 *
 * 15 minutes: comfortably longer than the ~60 s slice budget (so a slow-but-live
 * slice is never stolen mid-flight) and comfortably shorter than a human
 * noticing (so a crash costs one lease period, not a support ticket).
 */
export const CLAIM_LEASE_SECONDS = 15 * 60;

/**
 * Lease held on a `ci.pipeline_shards` row by the worker draining it.
 *
 * Same cooperative-mutex-with-a-deadline shape as the claim lease above, one
 * level up: shards are the unit of resumability, claims are the unit of work.
 * Consumed by the shard runner (a later change); declared here so both leases
 * are visible in one place and cannot drift into an ordering where a shard
 * lease expires before the claims it contains.
 */
export const SHARD_LEASE_SECONDS = 10 * 60;

/**
 * First retry delay, in seconds, for a failed entity. Doubles per attempt.
 *
 * The delay lives in `ci.pipeline_state.next_attempt_at`, not in a timer, so it
 * survives a process restart — the sweep simply does not re-select the row
 * until the gate is due. That is the difference between backoff and "backoff
 * until the API container OOMs".
 */
export const RETRY_BACKOFF_BASE_SECONDS = 60;

/** Backoff ceiling. Six doublings from the base lands here; further attempts hold. */
export const RETRY_BACKOFF_MAX_SECONDS = 6 * 60 * 60;

/**
 * Attempts after which a failed entity is QUARANTINED instead of retried.
 *
 * A quarantined row is terminal by design: the staleness sweep reclaims only
 * `failed` rows whose retry gate is due, so quarantine is the state that stops
 * a poison record from consuming a worker slot every hour until someone
 * notices. It is not a tombstone — bumping the stage version re-selects
 * quarantined rows along with everything else, so a fixed enricher automatically
 * re-admits the corpus it previously choked on.
 */
export const MAX_ATTEMPTS_BEFORE_QUARANTINE = 5;

// ---------------------------------------------------------------------------
// Dead letters
// ---------------------------------------------------------------------------

/**
 * pg-boss dead-letter rows copied into `ci.pipeline_dead_letters` per reap.
 *
 * Bounds one statement's work. The reaper is an anti-join against a primary key
 * and the dead-letter partition is empty in a healthy system, so this ceiling
 * only ever engages while catching up after an incident — exactly when NOT
 * flooding the database matters most.
 */
export const DEAD_LETTER_REAP_BATCH = 500;

/**
 * Reap cadence. Deliberately off the top of the minute: `SyncOrchestrator`,
 * `AnswerInferenceCron` and `McpController` all fire at second 0, and stacking
 * a fourth scheduled job there turns a quiet appliance into a periodic spike.
 */
export const DEAD_LETTER_REAP_CRON = '40 */2 * * * *';

// ---------------------------------------------------------------------------
// The nightly enrichment window
// ---------------------------------------------------------------------------

/**
 * WHEN the appliance is willing to spend on enrichment, and HOW MUCH.
 *
 * ── Why a window at all ────────────────────────────────────────────────────
 *
 * Everything the pipeline enriches is contended. `index.embed` runs through the
 * ONE host Ollama process that also serves interactive chat, HBPE and the
 * summary sidecar — and `BackpressureService` says plainly that there is no
 * honest way to measure that contention from inside this process. What cannot
 * be measured has to be BOUNDED instead, and the only bound nobody has to
 * measure is a clock: run when the owner is asleep, and stop.
 *
 * The alternative that was in place — a perpetual tick with a queue-depth cap —
 * makes enrichment a permanent background tenant. It is never egregious at any
 * one moment and it never stops, which on an appliance shared with an assistant
 * somebody is talking to is the worse failure.
 *
 * ── Why the window and the budget are TWO numbers ──────────────────────────
 *
 * They answer different questions, and collapsing them loses the second one:
 *
 *  - the WINDOW (`start` + `durationMinutes`) is PERMISSION. Its edges are a
 *    fact about the owner — they are asleep — and nothing else.
 *  - the BUDGET (`budgetMinutes`) is SPEND. It is consumed only by ticks that
 *    actually dispatch, so a night with nothing to do costs nothing, and an
 *    appliance that was powered off until 03:00 still gets its whole budget
 *    instead of the remainder of a window it slept through.
 *
 * A single 90-minute window would give the first property and lose the second,
 * which is exactly the case that matters on a box that is not on 24/7.
 *
 * ── Why the defaults are these defaults ────────────────────────────────────
 *
 * 01:00 for five hours, spending ninety minutes of it. The window is wide
 * because "when is the owner asleep?" is a guess and a wide guess is a cheap
 * one; the budget is small because it is the number that is actually spent, and
 * because a small nightly budget is only safe if work RESUMES — which it does:
 * the sweep's position lives in `ci.pipeline_shards.cursor` and the ledger
 * re-derives the remainder from THE ONE RULE, so a night that stops mid-sweep
 * costs nothing but the slice in flight. Ninety minutes a night converges a
 * 324,044-row corpus over several nights instead of one long night, and several
 * short nights is the shape that never makes the assistant feel broken.
 *
 * Every field is overridable — see `config/default.json` → `enrichment.window`
 * and `config/custom-environment-variables.json` for the env var names.
 * `enabled: false` restores free-running enrichment, which is the right setting
 * for a supervised first-import burn-in.
 */
export const ENRICHMENT_WINDOW = {
  enabled: config.enrichment.window.enabled,
  /** Local wall-clock `HH:MM` the window opens. */
  start: config.enrichment.window.start,
  /** How long it stays open. May cross midnight. */
  durationMs: config.enrichment.window.durationMinutes * 60_000,
  /** Minutes of ACTUAL dispatching activity spent inside it. */
  budgetMs: config.enrichment.window.budgetMinutes * 60_000,
  /** IANA zone the wall clock is read in; empty means the host's zone. */
  timezone: config.enrichment.window.timezone,
} as const;

/**
 * Fair rotation across users.
 *
 * ── The problem it exists for ──────────────────────────────────────────────
 *
 * With one shared nightly budget and naive iteration, the second user waits
 * behind the WHOLE of the first user's archive. On a real import — 66,579
 * Google Fit records plus GPX and location history, before a single event or
 * file — that is weeks, silently, with nothing in any log that says so.
 *
 * ── The mechanism ──────────────────────────────────────────────────────────
 *
 * A user HOLDS the window for {@link turnMs}, then it passes to the
 * least-recently-served user (`ci.pipeline_turns.last_served_at ASC NULLS
 * FIRST`). So the bound on how long anybody waits is ONE TURN, not one import,
 * and a user who joined this afternoon has no row at all, sorts first, and is
 * served before anybody takes a second turn.
 *
 * ── The two numbers ────────────────────────────────────────────────────────
 *
 * `turnMinutes` (20) divides the 90-minute budget into roughly four or five
 * turns a night. Long enough that a turn is worth having — a sweep hop enqueues
 * up to `MAX_SLICES_PER_SWEEP` slices and a slice is sized for ~60 s, so twenty
 * minutes is real work rather than a handover — and short enough that the whole
 * rotation comes round inside one night for a small household.
 *
 * `usersPerTurn` (1) is deliberately not "as many as fit". Effective global
 * concurrency is 10 in-flight jobs and {@link MAX_SWEEPS_PER_TICK} is 4, so the
 * appliance's capacity is already the ceiling; splitting it across two users
 * makes both of them slower and neither of them earlier. Serving one user at a
 * time also means the per-night spend is attributable, which is what makes
 * "where did last night go?" answerable from `ci.pipeline_turns` alone.
 */
export const ENRICHMENT_ROTATION = {
  turnMs: config.enrichment.rotation.turnMinutes * 60_000,
  usersPerTurn: config.enrichment.rotation.usersPerTurn,
} as const;

/**
 * Where the rotation pointer and the nightly budget ledger live.
 *
 * One row per user. Named here rather than inlined so the boot-time presence
 * probe, the tick's user ordering and `EnrichmentWindowService`'s statements
 * cannot drift onto three different table names.
 */
export const PIPELINE_TURNS_TABLE = 'ci.pipeline_turns';

/**
 * Ceiling on the budget one tick may charge for the gap since the previous one.
 *
 * The budget measures ENRICHMENT ACTIVITY, and the only clock available for
 * that is the interval between two dispatching ticks. That interval is normally
 * the tick cadence (five minutes, `PIPELINE_TICK_CRON`), but it is not bounded:
 * suspend the appliance at 01:10 and resume it at 05:00 and the naive delta is
 * 230 minutes, which would spend a 90-minute budget on time when nothing ran —
 * every night, on any laptop-shaped box.
 *
 * Ten minutes is two tick periods: generous enough that a slow or contended
 * tick is charged honestly, tight enough that downtime is charged as one tick
 * rather than as a night. The error is deliberately in the direction of
 * UNDER-charging — a night that overruns its budget by one tick is a rounding
 * error, and a night that ends before it began is a pipeline that never runs.
 */
export const MAX_BUDGET_CHARGE_PER_TICK_MS = 10 * 60_000;

/**
 * Module-load sanity check over the two declarations above, in the style of
 * `BackpressureService`'s cap guard — and, like `assertStagePolicy`, it names
 * the consequence rather than merely rejecting a number.
 *
 * Neither problem is an error. A turn longer than the budget still rotates
 * correctly (the pointer carries across nights, so tomorrow's turn goes to
 * somebody else); a budget longer than the window is simply "spend the whole
 * window". Both are silently surprising, though, so they are said out loud once
 * at boot instead of being discovered from a graph of coverage that is not
 * moving.
 */
export function assertEnrichmentWindowPolicy(warn: (message: string) => void = console.warn): void {
  if (!ENRICHMENT_WINDOW.enabled) {
    return;
  }

  if (ENRICHMENT_ROTATION.turnMs > ENRICHMENT_WINDOW.budgetMs) {
    warn(
      `[pipeline] enrichment.rotation.turnMinutes (${ENRICHMENT_ROTATION.turnMs / 60_000}) is longer than ` +
        `enrichment.window.budgetMinutes (${ENRICHMENT_WINDOW.budgetMs / 60_000}), so exactly one user is ` +
        `served per night. The rotation still reaches everybody — the pointer is durable and carries across ` +
        `nights — but a household of N users now takes N nights to come round.`,
    );
  }

  if (ENRICHMENT_WINDOW.budgetMs > ENRICHMENT_WINDOW.durationMs) {
    warn(
      `[pipeline] enrichment.window.budgetMinutes (${ENRICHMENT_WINDOW.budgetMs / 60_000}) exceeds the ` +
        `window's own length (${ENRICHMENT_WINDOW.durationMs / 60_000}), so the budget can never be spent ` +
        `and the window's closing time is the only thing that stops enrichment.`,
    );
  }
}

assertEnrichmentWindowPolicy();
