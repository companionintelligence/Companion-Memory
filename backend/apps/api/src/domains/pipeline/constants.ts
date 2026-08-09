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
