import { STAGE_ID_LIST, STAGE_IDS, type StageId } from './constants';
import type { StageSchedule } from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SCHEDULE. When each stage is allowed to run, and what a run may cost.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before this file the pipeline had ONE clock. `PipelineTickCron` fired every
 * five minutes, `PipelineControlService.tick()` probed all twelve stages, and
 * every stage that had anything stale was dispatched — a Postgres-only cleaner
 * and a metered geocoder treated identically, forever, at the same cadence. Two
 * consequences, both of which a user has now asked to be rid of:
 *
 *  - enrichment became a PERMANENT background tenant of an appliance whose
 *    Ollama process is shared with interactive chat, HBPE and the summary
 *    sidecar;
 *  - the only way to stop a metered stage from being a recurring, unauthorised
 *    charge was to make it unreachable by the timer entirely (`METERED_STAGES`
 *    was excluded from `defaultStageSet()`), which is not "slower", it is
 *    "never".
 *
 * The cadence question is split in two, and this file owns exactly one half:
 *
 *  - **WHEN is the appliance willing to spend anything at all, and on whom?**
 *    `ENRICHMENT_WINDOW` in `constants.ts` and `EnrichmentWindowService` — the
 *    daily time box, its budget, and the per-user rotation inside it. NOT here,
 *    and deliberately not restated here: a second copy of "is it 03:00?" is the
 *    same drift this file exists to remove.
 *  - **WHICH stages are due once it is open, and how much may one sweep touch?**
 *    {@link STAGE_SCHEDULES}, and {@link stageDueness}, which turns a
 *    declaration plus a per-leg last-run instant into a yes or a no with a
 *    greppable reason.
 *
 * {@link StageSchedule.window} is the seam between the two: it declares whether
 * a stage is confined to the window, and the caller supplies whether the window
 * is open. This file never reads a clock to answer that.
 *
 * ── Per USER, not per appliance ────────────────────────────────────────────
 *
 * Every interval in this file is measured per `(user, stage, entity_type)` leg.
 * {@link stageDueness} takes the last-run instant as a PARAMETER rather than
 * reading a clock of its own, and that is the whole of what makes the schedule
 * work for a second user: their first import is due immediately regardless of
 * how recently the first user's nightly pass ran. A module-level `lastRunAt`
 * map — the obvious shortcut — would be an appliance-wide clock wearing a
 * per-stage costume, and would starve every user but whoever the tick reached
 * first.
 *
 * ── Why a map keyed by stage id, and not a field on `Stage` ────────────────
 *
 * The argument is on the `Stage` interface in `types.ts`, at length. In one
 * line: `STAGE_VERSIONS` and `STAGE_REGISTRY` are flat maps precisely so a
 * module-load key comparison can prove them complete before a queue exists, and
 * a field on a Nest-constructed provider cannot be checked until after the
 * workers are already running.
 *
 * ── What this file does NOT decide ─────────────────────────────────────────
 *
 * Ordering (`STAGE_DEPENDENCIES`), queue depth (`BackpressureService`), slice
 * size (`DEFAULT_SLICE_SIZE`) and re-run watermarks (`STAGE_VERSIONS`) all live
 * elsewhere and are not restated here. A schedule that also encoded ordering
 * would be the second copy of a graph that already exists, and the same fact in
 * two places is how it drifts.
 */

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Intervals are SECONDS, matching `CLAIM_LEASE_SECONDS`,
 * `SHARD_LEASE_SECONDS` and `RETRY_BACKOFF_BASE_SECONDS` in `constants.ts`.
 * Milliseconds would be the JavaScript-native unit and are rejected: every
 * other duration in this domain is seconds, and a file where `86_400` means a
 * day next to a file where it means eighty-six seconds is a bug waiting for a
 * hurried reader.
 */
const MINUTES = 60;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

// ---------------------------------------------------------------------------
// THE SCHEDULE, DECLARED
// ---------------------------------------------------------------------------

/**
 * Every stage's cadence, in one reviewable place.
 *
 * ── The shape of the decision ──────────────────────────────────────────────
 *
 * Three tiers, and each stage is in one of them because of what it does rather
 * than because of what tier it was convenient to put it in:
 *
 *  - **HOURLY, unwindowed** (every `index.*` leg, and every `promote.edge_*`
 *    leg). Two different reasons for one tier. Search freshness is the thing on
 *    this appliance a user notices within the hour — an entity that is not
 *    embedded is an entity that cannot be found — so `index.embed` also gets
 *    `trigger: 'onArrival'` and is not confined to the night. The edge
 *    projections are here because their input arrives at IMPORT rate rather
 *    than at their producers' rate, and a day-long gate over a bulk-written
 *    column is not a slow graph, it is an empty one; see the block above
 *    `PROMOTE_EDGE_COMMUNICATION`.
 *  - **NIGHTLY, windowed** (the rest of the local work: the media probe, both
 *    person-link legs, all four `clean.*`, `promote.place` / `promote.object` /
 *    `promote.observation`, and `enrich.estimate_location`). None of it is
 *    user-visible within a day and none of it costs money, so it goes where it
 *    disturbs nobody.
 *  - **WEEKLY, windowed, CAPPED** (`enrich.position_reverse`, `enrich.geocode`,
 *    `enrich.event_reverse`, `enrich.unfurl`). Everything that egresses to a
 *    metered provider. This list is prose and {@link meteredStageIds} is the
 *    executable form; `schedule.spec.ts` asserts the weekly tier and the metered
 *    set are the SAME set, so a fifth arrives in both or in neither.
 *
 * ── Batch affinity: why nightly beats continuous for the linkers ───────────
 *
 * `enrich.person_link` and `enrich.event_person_link` are not merely tolerant of
 * a slow cadence, they are BETTER at one. Their whole job is resolving a
 * communication's participants against `ci.entity_identifiers`, and every
 * identifier that has landed since the last pass is one more chance for a match.
 * A continuous sweep resolves each message against whatever identifiers existed
 * in the minute it arrived and records the answer; a nightly sweep resolves a
 * day's messages against a day's accumulated identifiers at once. Same version,
 * same code, strictly more matches. (A re-run still repairs the difference —
 * that is what `STAGE_VERSIONS` is for — but a cadence that does not create the
 * damage is better than a lever that repairs it.)
 *
 * ── Why nothing is `trigger: 'manual'` ─────────────────────────────────────
 *
 * `enrich.geocode` was, in effect, until now: metered stages were excluded from
 * `defaultStageSet()`, so the only way to reach one was a run naming it. The
 * user asked for geocoding to happen AT A SLOWER CADENCE, which is not the same
 * request as "never", and answering it needs the stage to be startable by a
 * timer again. The cost discipline does not go away, it moves and gets stricter:
 * weekly instead of every five minutes, confined to the enrichment window,
 * capped per sweep, and all three enforced by {@link assertStageSchedules}
 * rather than by a comment.
 */
export const STAGE_SCHEDULES: Record<StageId, StageSchedule> = {
  /**
   * ON ARRIVAL, with an HOURLY backstop. Contended, not billed.
   *
   * The only stage on this appliance whose latency a user feels directly: an
   * unembedded entity is one that search cannot return, and "I added it and it
   * is not there" is a bug report. So it is dispatched by arrival and swept
   * anyway, hourly, at any hour of the day.
   *
   * The backstop is the point of the hourly floor, not the freshness: arrival
   * dispatch goes through a listener and a pg-boss job and both can be lost —
   * a listener that threw before enqueuing, a job that spent its retries into
   * the dead-letter queue, an import that ran while the bus was down. Every one
   * of those is permanent and silent without a sweep behind it.
   *
   * No `perRunCap`, and no window. What bounds this stage is
   * `QUEUE_READY_CAPS['pipeline-embed']` — 25 ready jobs, the tightest of the
   * three caps and a deliberate reservation of the single Ollama process that
   * interactive chat, HBPE and the summary sidecar also share. A cap here would
   * be a second, weaker copy of that number.
   *
   * `maxStaleness` of 6 h rather than 24: a stage this cheap to start has no
   * reason to be a day behind, and an appliance awake for six hours has
   * certainly been awake long enough to embed.
   */
  [STAGE_IDS.INDEX_EMBED]: {
    trigger: 'onArrival',
    cost: 'contended',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  /**
   * The other dense-embed types, at content's cadence (search freshness is
   * user-visible for all of them) but `scheduled` rather than `onArrival`:
   * their live creates are still indexed immediately by the search-index
   * listeners, and `StageArrivalListener` subscribes to no event for them yet —
   * declaring `onArrival` here would promise a fast path that does not exist.
   * The post-import kick reaches them directly through `startSweep`, so bulk
   * loads do not wait for the hourly backstop either.
   */
  [STAGE_IDS.INDEX_EMBED_COMMUNICATION]: {
    trigger: 'scheduled',
    cost: 'contended',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_EMBED_EVENT]: {
    trigger: 'scheduled',
    cost: 'contended',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_EMBED_ITEM]: {
    trigger: 'scheduled',
    cost: 'contended',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_EMBED_PERSON]: {
    trigger: 'scheduled',
    cost: 'contended',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_EMBED_FILE]: {
    trigger: 'scheduled',
    cost: 'contended',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_EMBED_BROWSER_ACTIVITY]: {
    trigger: 'scheduled',
    cost: 'contended',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  /**
   * The tsvector family: pure local Postgres work (the `setweight` expression
   * is computed by the database), so `local`, unwindowed, at the same hourly
   * cadence — keyword search should not lag semantic search.
   */
  [STAGE_IDS.INDEX_VECTOR]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_VECTOR_COMMUNICATION]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_VECTOR_EVENT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_VECTOR_ITEM]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_VECTOR_PERSON]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_VECTOR_FILE]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },
  [STAGE_IDS.INDEX_VECTOR_BROWSER_ACTIVITY]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  /**
   * NIGHTLY. sharp / ffprobe over `ci.files` originals — local CPU and object
   * storage, no provider, no bill.
   *
   * Nobody is waiting on an image's width. Probing is the most CPU-hungry local
   * stage there is (decode a video header, decode an image), which is a reason
   * to do it while the machine is otherwise idle rather than a reason to do it
   * often.
   */
  [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * Same shape as media_dimensions, and for the same reasons: local CPU
   * (sharp / ffmpeg) plus an object-storage read per file, and the upload
   * path already covers the common case — this sweep is the net under it.
   * An on-demand run is available through `POST /api/maintenance/file-preview-sweep`.
   */
  [STAGE_IDS.ENRICH_FILE_PREVIEW]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * Every key is a request to someone else's server, so this is metered even
   * though nobody bills for it: provider oEmbed endpoints and Wikimedia both
   * rate-limit, and a full-corpus first pass (tens of thousands of YouTube and
   * Spotify keys) is hours of polite 2/s traffic. Every OTHER metered stage
   * stays weekly; this one runs daily so a large existing corpus (a personal
   * library is tens of thousands of plays) backfills over days rather than
   * months at the same per-run cap — 7x the weekly throughput, still metered,
   * still `perRunCap`-bounded per run. The per-run cap is sized to what 2/s
   * fits in one enrichment window (rows, not requests — rows sharing a key
   * cost one request). The cache row's expiry, not the schedule, decides when
   * a key is asked again. A first pass over a large corpus is still faster
   * started by hand: `POST /pipeline/sweeps { stage: 'enrich.unfurl' }`.
   */
  [STAGE_IDS.ENRICH_UNFURL]: {
    trigger: 'scheduled',
    cost: 'metered',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 30 * DAYS,
    perRunCap: 20_000,
  },

  /**
   * NIGHTLY. Four Postgres statements per slice; no provider.
   *
   * Nightly for BATCH AFFINITY, not merely for politeness — see the note on
   * this map. More identifiers accumulated per pass means more of a message's
   * recipients resolve in that pass.
   */
  [STAGE_IDS.ENRICH_PERSON_LINK]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /** NIGHTLY. Same algorithm over `ci.events`, same reasoning, same numbers. */
  [STAGE_IDS.ENRICH_EVENT_PERSON_LINK]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. A PRODUCER of `clean.duplicate_detect` alongside both person-link
   * legs (`STAGE_DEPENDENCIES`), same tier and same night for the same
   * producer/consumer reason as `clean.identifier_normalize` below.
   */
  [STAGE_IDS.ENRICH_PERSON_SELF_CLAIM]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. Moves `start_time` on events the user may already have looked at.
   *
   * The one nightly stage with a human argument for `manual`, and it is not
   * taken: the repair writes `start_time_original` alongside rather than over,
   * so it is reversible and "which dates did we move?" stays answerable. A
   * stage that is reversible and audited does not need to be un-runnable, it
   * needs to run while nobody is reading the calendar.
   */
  [STAGE_IDS.CLEAN_TEMPORAL_REPAIR]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. Canonicalises identifiers so the person-link legs join a
   * consistent corpus.
   *
   * It is a PRODUCER of both linkers (`STAGE_DEPENDENCIES`), and it shares
   * their cadence deliberately: a producer on a slower clock than its consumer
   * means the consumer spends most of its passes blocked, and a producer on a
   * faster clock buys nothing because the consumer cannot use the output until
   * it runs. Same tier, same night, ordering handled by the graph.
   */
  [STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. Counts contradictory single-valued edges; changes none of them.
   *
   * Same tier as its `clean.*` siblings, and the reasoning is the same one
   * `clean.object_duplicate_detect` gives: the output is a REPORT nobody can
   * act on until they look at it, so an hour of freshness buys nothing, and
   * arrival-triggering a corpus-wide group-by at import rate is exactly the
   * shape this file exists to refuse.
   *
   * `cost: 'local'` is exact — one SELECT per slice over
   * `relationships_from_idx`, no provider and no Ollama. Not `metered`, so no
   * `perRunCap`: there is no bill for a cap to bound, and capping a stage whose
   * entire deliverable is a COUNT would make that count a sample of itself.
   *
   * No `STAGE_DEPENDENCIES` ordering. It reads `ci.relationships`, which the
   * `promote.edge_*` legs write, but it is a detector: running before them
   * counts fewer edges rather than wrong ones, and the next night's pass sees
   * whatever landed. A gate would buy precision this stage does not claim.
   */
  [STAGE_IDS.CLEAN_SINGLE_VALUED_EDGE_AUDIT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. Proposes merge candidates; a human disposes.
   *
   * Consumes `ci.identifier_claims`, which both person-link legs write, so it
   * is on the same nightly tier for the same producer/consumer reason. Nothing
   * it writes is acted on without a person, so there is no value in it being
   * faster than the people who read it.
   */
  [STAGE_IDS.CLEAN_DUPLICATE_DETECT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. The same proposal over owned units; a human disposes.
   *
   * Consumes `ci.objects`, which `promote.object` writes, so it sits on the
   * same nightly tier for the same producer/consumer reason as its sibling —
   * and it is genuinely cheaper to run late: the detector groups on
   * identifiers, catalogue product and brand+model+day, and every unit an
   * import has landed since the last pass is one more member a group can
   * collapse onto.
   *
   * `cost: 'local'` is exact: one grouping query per page plus one upsert per
   * slice, no provider and no Ollama. Not `onArrival` — a proposal nobody can
   * act on until they open the review queue buys nothing by being an hour
   * fresher, and arrival-triggering a corpus-wide group-by at import rate is
   * the shape `STAGE_SCHEDULES` exists to refuse.
   */
  [STAGE_IDS.CLEAN_OBJECT_DUPLICATE_DETECT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY, and GATED BEHIND GEOCODE by `STAGE_DEPENDENCIES` rather than by
   * anything here.
   *
   * An estimate is a COPY of a donor's coordinate and the donors are
   * overwhelmingly rows the forward geocoder resolved. Nightly rather than
   * weekly even though its producer is weekly: on the six nights geocode is not
   * due there is still a day of newly-imported events whose donors already
   * exist, and holding those back would make a free stage as slow as the
   * expensive one it reads from.
   *
   * This is the leg that proves the ordering graph and the schedule have to be
   * read together — see the note in this file's header, and the exact tick edit
   * it implies: a producer that is not DUE is not a producer the consumer is
   * waiting for.
   */
  [STAGE_IDS.ENRICH_ESTIMATE_LOCATION]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. Promotes resolved event locations into places plus their
   * city → region → country hierarchy.
   *
   * Reads `ci.geocode_cache` BY PRIMARY KEY — no provider call, so a bump is
   * free and there is no reason for it to be on the metered tier just because
   * its producers are. Ordering keeps it behind them; cost keeps it here.
   */
  [STAGE_IDS.PROMOTE_PLACE]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. The same promotion over `ci.position` — named GPS fixes into
   * places, and `ci.position.location_entity_id`.
   *
   * Same tier and same cadence as `promote.place`, for the same reasons: it
   * reads `ci.geocode_cache` BY PRIMARY KEY, so no provider call and no bill,
   * and `STAGE_DEPENDENCIES` (not the cadence) is what keeps it behind
   * `enrich.position_reverse`, which writes both of its inputs.
   *
   * NO `perRunCap`, deliberately, and it is worth being explicit because the
   * producer over this same table has one. `enrich.position_reverse` is capped
   * because every row it touches is a BILLED provider call; this stage's cost
   * is a Postgres round trip per DISTINCT venue in a slice, and the candidate
   * set is only the NAMED fixes (2,815 of 65,115 on the legacy corpus). What
   * bounds a sweep here is `MAX_SLICES_PER_SWEEP`, the same thing that bounds
   * `promote.place`. A cap would be a second, weaker copy of that number, and
   * on a first import it would be the reason the map fills over weeks instead
   * of overnight.
   */
  [STAGE_IDS.PROMOTE_PLACE_POSITION]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /** NIGHTLY. Purchases into `ci.objects`. Reads nothing another stage produces. */
  [STAGE_IDS.PROMOTE_OBJECT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * NIGHTLY. `capture.scan` detections into `ci.object_observations`.
   *
   * Same tier as `promote.object` and for the same reasons: Postgres only, no
   * provider, no bill. Ordered behind `promote.place` by `STAGE_DEPENDENCIES`
   * because it reads `location_entity_id` when something has filled it — not
   * because a scan needs it, since a scan resolves its own place from the geo
   * block in its payload.
   *
   * Nightly rather than `onArrival` deliberately: a room scan is not something
   * a user watches a list for the way they watch search, and the sightings it
   * produces are input to a review queue, not to anything time-critical.
   */
  [STAGE_IDS.PROMOTE_OBSERVATION]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'enrichment',
    minInterval: 1 * DAYS,
    maxStaleness: 3 * DAYS,
  },

  /**
   * HOURLY, AT ANY HOUR, all legs. One INSERT…SELECT per matrix rule per
   * slice; Postgres only, no provider, no Ollama, no bill.
   *
   * ── Why these are NOT on the nightly, windowed tier ────────────────────────
   *
   * They were, and it was the single reason the graph view was a dust cloud.
   * The argument for putting them there was BATCH AFFINITY WITH THEIR
   * PRODUCERS — edges are a pure projection of the columns `enrich.person_link`
   * and `promote.place` fill, so "a faster clock buys nothing before the
   * producers run". That argument has one false premise: the linkage columns
   * have a SECOND writer, and it is the one that matters at scale. A bulk
   * import writes `communications.from_entity_id` / `to_entity_ids` at ingest
   * (`/v1` push, `GraphIngestService`), for the whole corpus, in minutes — with
   * no linker involved at all. Measured on the QA corpus: 598,146 of 767,020
   * communications carried a resolved sender the moment the import finished,
   * and 525,706 carried recipients. Every one of those was a candidate for this
   * projection, immediately.
   *
   * What the nightly tier did with that: `minInterval: 1 * DAYS` is measured
   * from the sweep's START, and the last sweep started two minutes BEFORE the
   * push began. So the leg was "already run today" over 2,279 rows, went not-due
   * for twenty-four hours, and 1.5M derivable edges — 78% of the corpus's
   * entities — stayed invisible to a graph traversal that reads no other table.
   * That is not a slow convergence, it is a coin flip on when the sweep clock
   * happened to land relative to the import, and it comes up wrong every time an
   * import lasts longer than the gap between two sweeps.
   *
   * ── Why hourly and unwindowed is SAFE, not merely faster ───────────────────
   *
   * The window bounds SPEND and Ollama contention (see this file's header).
   * These legs have neither: `cost: 'local'`, ten INSERT…SELECTs against
   * indexed columns, `ON CONFLICT DO NOTHING`, in the same resource class as
   * `promote.place`. The `index.*` legs — which DO contend for Ollama — already
   * sit on exactly this tier, and they drained 777,340 communications in a day
   * on the corpus that defeated this one.
   *
   * The premature-`done` hazard the nightly tier was also guarding against does
   * not exist here, and not by luck: every leg's `StageSource.predicate`
   * requires its linkage column to be POPULATED, so an unlinked row is not a
   * candidate and cannot be marked `done` by a sweep that outruns its producer.
   * It becomes a candidate — never-run, immediately due — the moment the linker
   * fills the column. Ordering against the producers stays where it belongs, in
   * `STAGE_DEPENDENCIES`, which holds a leg back on any tick where its producer
   * is due WITH candidates; outside the enrichment window the nightly producers
   * are not due, so the projection runs on its own clock and the two never
   * fight.
   *
   * `maxStaleness` of 6 h for the same reason `index.embed` has it: a stage this
   * cheap to start has no business being a day behind the rows it projects.
   */
  [STAGE_IDS.PROMOTE_EDGE_COMMUNICATION]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_EVENT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_CONTENT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_OBJECT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_RECEIPT]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_OBSERVATION]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_POSITION]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_DEVICE]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_FILE]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  [STAGE_IDS.PROMOTE_EDGE_PLACE]: {
    trigger: 'scheduled',
    cost: 'local',
    window: 'any',
    minInterval: 1 * HOURS,
    maxStaleness: 6 * HOURS,
  },

  /**
   * WEEKLY, WINDOWED, CAPPED. Forward-geocodes `ci.events.location_name`
   * through Portal to a paid provider.
   *
   * THE CADENCE THE USER ASKED FOR, and the measurement behind it: 95 events
   * carry a `location_name` awaiting a forward lookup, against 358 that already
   * have coordinates. A sweep of this stage is not a large bill today — it is a
   * bill on a schedule, which is the thing worth controlling, and 95 rows is not
   * a number that justifies asking a paid provider anything every five minutes.
   *
   * `perRunCap: 1000` does not bind today; it binds on the two days it matters.
   * A version bump re-opens all 453 events that ever resolved (that is the
   * entire point of `STAGE_VERSIONS` — the old `location_coordinates IS NULL`
   * predicate meant a coarse city-centroid hit was frozen for the life of the
   * appliance), and an import can land a hundred thousand events carrying a
   * location name overnight. The cap is what makes the second case a bounded
   * weekly charge instead of an invoice.
   *
   * `maxStaleness: 30 * DAYS` is generous on purpose. It is the escape hatch for
   * an appliance that is never awake while the window is open, not a second
   * cadence: a machine
   * that IS awake at night resolves this at ~7 days and never reaches 30.
   */
  [STAGE_IDS.ENRICH_GEOCODE]: {
    trigger: 'scheduled',
    cost: 'metered',
    window: 'enrichment',
    minInterval: 7 * DAYS,
    maxStaleness: 30 * DAYS,
    perRunCap: 1_000,
  },

  /**
   * WEEKLY, WINDOWED, CAPPED. The other direction over the same table:
   * reverse-geocodes `ci.events.location_coordinates` into `location_name`.
   *
   * Same tier, cadence and cap as `enrich.geocode` deliberately — it is the same
   * table, the same provider and the same order of magnitude. The two candidate
   * sets are disjoint by construction (a row with a name is one this stage
   * refuses, and a row without one the forward stage never selects), so a shared
   * cap is a bound on each rather than a budget they compete for.
   *
   * The measurement behind the number: on the appliance this was written
   * against, 91 events carried coordinates and 79 of them had no name — every
   * one of them stranded, because nothing scheduled could give them one. That
   * backlog is not a bill; it is 76 distinct cache cells. What makes the cap
   * worth having is the shape of the corpus it is waiting for — a photo library
   * arrives with EXIF GPS on every frame, so one Takeout import can land tens of
   * thousands of coordinate-bearing events overnight. Cache cells hold the
   * BILLED count far below the candidate count (an afternoon of photos in one
   * room is one lookup), but the cap is what makes the worst case a known weekly
   * quantity rather than an invoice.
   *
   * `maxStaleness: 30 * DAYS` for the reason its sibling gives: the escape hatch
   * for an appliance that is never awake while the window is open, not a second
   * cadence.
   */
  [STAGE_IDS.ENRICH_EVENT_REVERSE]: {
    trigger: 'scheduled',
    cost: 'metered',
    window: 'enrichment',
    minInterval: 7 * DAYS,
    maxStaleness: 30 * DAYS,
    perRunCap: 1_000,
  },

  /**
   * WEEKLY, WINDOWED, CAPPED — and the cap is the part that matters.
   *
   * Reverse-geocodes `ci.position` fixes into the seven address columns nothing
   * has ever written. `ci.position` is EMPTY today, and that fact is misleading
   * in the most expensive possible direction: it is empty only because a debug
   * push used the legacy GraphQL lane. A real `/v1` import fills it from 66,579
   * Google Fit records plus GPX and location history, and THAT is where reverse
   * geocoding becomes a real bill — not the 95 forward lookups next door.
   *
   * So the interval is the smaller half of this policy. Weekly with no cap is
   * not a slow bill, it is one night a week on which 66,000 fixes hit a paid
   * provider at once, and the week it happens is the week the corpus lands. The
   * cap makes the worst case a known quantity:
   *
   *   2,000 ids = 10 slices at `DEFAULT_SLICE_SIZE` = 2 sweep hops. At 2,000 a
   *   week the 66,579-row backlog drains over roughly eight months, which reads
   *   as slow until two things are added: `GeocodeService` is CACHE-AWARE and
   *   consecutive GPS fixes collapse onto the same `ci.geocode_cache` rows, so
   *   the number of BILLED lookups is far below the number of ids; and nothing
   *   downstream is waiting on it.
   *
   * This number is the dial. It is the one line to raise once a provider's real
   * per-lookup price is known, and raising it is a one-integer diff with this
   * paragraph attached — which is exactly what it could not be while "metered"
   * existed only in prose.
   */
  [STAGE_IDS.ENRICH_POSITION_REVERSE]: {
    trigger: 'scheduled',
    cost: 'metered',
    window: 'enrichment',
    minInterval: 7 * DAYS,
    maxStaleness: 30 * DAYS,
    perRunCap: 2_000,
  },
};

// ---------------------------------------------------------------------------
// Reading the schedule
// ---------------------------------------------------------------------------

/**
 * The declared schedule for a stage.
 *
 * Throws rather than defaulting. A missing schedule is not "run it whenever" —
 * it is a stage nobody decided a cost for, and defaulting would let the most
 * expensive possible answer (every tick, any hour, uncapped) be the one that
 * arrives by accident. The same argument `stageVersion()` makes about a missing
 * version, and the boot guard below means this throw should be unreachable in a
 * process that started.
 */
export function stageSchedule(stageId: string): StageSchedule {
  const schedule = STAGE_SCHEDULES[stageId as StageId];

  if (schedule == null) {
    throw new Error(
      `No STAGE_SCHEDULES entry for stage "${stageId}". Every stage must declare when it may run and ` +
        `what a run costs; see domains/pipeline/schedule.ts.`,
    );
  }

  return schedule;
}

/**
 * Whether starting this stage costs money at an external provider.
 *
 * **THE single source of truth for "metered".** `PipelineControlService` used to
 * carry a hand-written `METERED_STAGES` set beside a `STAGE_IDS` comment saying
 * the same thing in prose, which is two copies of a fact and a comment that
 * could not be executed. Derived here so that declaring `cost: 'metered'` above
 * is the whole of making a stage metered — there is nowhere else to also
 * remember.
 */
export function isMeteredStage(stageId: string): boolean {
  return STAGE_SCHEDULES[stageId as StageId]?.cost === 'metered';
}

/** Every stage that egresses to a paid provider, in declaration order. */
export function meteredStageIds(): StageId[] {
  return STAGE_ID_LIST.filter((stageId) => isMeteredStage(stageId));
}

/**
 * The stages a timer may ever start: everything not `trigger: 'manual'`.
 *
 * This is what `defaultStageSet()` should filter on. It used to filter out
 * METERED stages, which made "costs money" and "unreachable by a schedule" the
 * same statement — so the only available cadence for a metered stage was never.
 * Cost and reachability are now two fields, and the cost discipline for a
 * metered stage is `minInterval`, `window` and `perRunCap` instead of exclusion.
 */
export function automaticStageIds(): StageId[] {
  return STAGE_ID_LIST.filter((stageId) => stageSchedule(stageId).trigger !== 'manual');
}

/** The per-sweep id ceiling for a stage, or `null` when it is uncapped. */
export function stagePerRunCap(stageId: string): number | null {
  return stageSchedule(stageId).perRunCap ?? null;
}

// ---------------------------------------------------------------------------
// Due-ness
// ---------------------------------------------------------------------------

/**
 * Why a leg is or is not due. A stable, greppable token, in the discipline
 * `StageResult.reason` and `AdmissionReason` already follow: an operator asking
 * "why did geocode not run last night?" needs an answer they can count, not a
 * formatted sentence.
 */
export type DuenessReason =
  /** No sweep has ever been recorded for this leg. Infinitely stale, so overdue. */
  | 'never_run'
  /** `maxStaleness` has passed. Due, and the window no longer applies. */
  | 'max_staleness_exceeded'
  /** Past `minInterval`, inside the window. The ordinary due. */
  | 'interval_elapsed'
  /**
   * At least one row of this leg is a FAILED retry whose own backoff has
   * already elapsed, so it is due even though the LEG's `minInterval` has not.
   * The window still applies — see {@link StageDueness.overdue} for why this is
   * not folded into it.
   */
  | 'retry_due'
  /** Swept more recently than `minInterval`, and nothing of it is a due retry. */
  | 'too_soon'
  /** Due by interval, but the window is shut and it is not yet overdue. */
  | 'outside_window'
  /** `trigger: 'manual'`. Only a run that names it may start it. */
  | 'manual';

/** One leg's answer to "may a sweep start right now?", with the numbers behind it. */
export interface StageDueness {
  stageId: string;

  /** May the tick start a sweep for this leg now? */
  due: boolean;

  reason: DuenessReason;

  /**
   * `maxStaleness` has been exceeded (which a never-run leg satisfies by
   * definition). Two consequences for the tick: the leg ignores its window, and
   * it should be preferred when `MAX_SWEEPS_PER_TICK` binds — an overdue leg has
   * already waited longer than it was ever meant to.
   *
   * `retry_due` is deliberately NOT this. It bypasses `minInterval` the way
   * `overdue` bypasses the window, but it must not bypass the window too: a
   * failed retry on a metered stage still spends against the same paid
   * provider as a fresh sweep, and the window is what bounds WHEN this
   * appliance is willing to spend anything, not just how often. Folding
   * `retry_due` into `overdue` would let a provider outage outside the window
   * turn into a metered call the moment it recovers, which is exactly the
   * unbounded spend `window: 'enrichment'` exists to prevent.
   */
  overdue: boolean;

  /** Ceiling on ids this sweep may dispatch; `null` is uncapped. */
  perRunCap: number | null;

  /**
   * The instant `minInterval` elapses for this leg — the earliest moment it
   * could become due. `null` when the interval has already elapsed, when the leg
   * has never run, and for a manual stage.
   *
   * Deliberately NOT "when will this next run": that also depends on when the
   * enrichment window next opens, which is `WindowStatus.nextOpensAt`'s answer
   * and not this file's. Reporting an interval-only instant that is exact beats
   * reporting a combined one that is a guess — a caller wanting the full answer
   * takes the later of the two, and can see that it is doing so.
   */
  eligibleAt: Date | null;

  /** The declaration this decision came from. Carried so a caller need not re-read it. */
  schedule: StageSchedule;
}

/**
 * Is this leg due, and why?
 *
 * **`lastStartedAt` is a PARAMETER, and that is the design.** It is the last
 * instant a sweep was STARTED for one `(user, stage, entity_type)` leg — not for
 * the stage, and not for the appliance. Passing it in rather than reading it
 * here is what makes the schedule work for every user instead of for whichever
 * user the tick happened to reach first, and it keeps this function pure: no
 * clock of its own, no database, no cache, so every branch below is directly
 * testable.
 *
 * `null` means no sweep has ever been recorded for the leg, which is treated as
 * INFINITE staleness rather than as a special case. Two things fall out of that,
 * both wanted:
 *
 *  - a freshly imported appliance enriches immediately instead of sitting idle
 *    until the window opens — a first impression that matters more than one night of
 *    tidiness;
 *  - a metered stage's first pass is bounded by {@link StageSchedule.perRunCap}
 *    and by nothing else, which is precisely the argument for the cap mattering
 *    more than the interval.
 *
 * ── `windowOpen` is an INPUT, and this function owns no clock ──────────────
 *
 * Whether the enrichment window is open is `EnrichmentWindowService`'s answer —
 * it reads a zoned wall clock, a nightly budget and `ci.pipeline_turns`, and
 * none of that belongs to a policy table. Passing `WindowStatus.open` in keeps
 * exactly one implementation of "is it 03:00 for this owner?" in the codebase,
 * and keeps this function pure: no clock, no database, no cache, so every branch
 * below is directly testable.
 *
 * It is REQUIRED rather than defaulted. A default of `true` would make a
 * forgotten argument look like a working call and run every nightly stage at
 * midday; a default of `false` would silently stop the pipeline. Neither failure
 * announces itself, so the compiler asks instead.
 *
 * ── The order of the checks is the policy ──────────────────────────────────
 *
 * `manual` → `maxStaleness` → `minInterval` → `retryDue` → `window`. Staleness
 * is tested BEFORE the window because it is the window's override; testing it
 * after would make an appliance that is asleep every night permanently
 * un-enriched, which is the failure this whole rebuild exists to delete.
 * `minInterval` is tested before the window because a leg swept an hour ago is
 * not due at any hour, and reporting `outside_window` for it would send a
 * reader looking at the clock instead of at the interval.
 *
 * ── Why `hasOverdueRetry` is a THIRD input, next to the clock and the window ─
 *
 * `ci.pipeline_state.next_attempt_at` already answers "is this ONE failed row
 * due for retry?" (`RETRY_BACKOFF_BASE_SECONDS`, doubling, capped at
 * `RETRY_BACKOFF_MAX_SECONDS` — minutes to a few hours). Before this input
 * existed, that answer was advisory only: a row past its own backoff still sat
 * untouched until the LEG's `minInterval` elapsed, because a sweep can only be
 * dispatched by a fresh keyset cursor and the keyset only resets when a new
 * sweep starts. For a 1-hour or 1-day stage that is a rounding error. For the
 * two metered stages — `minInterval: 7 * DAYS` — it meant a transient
 * `provider_unavailable` blip stranded every row it touched for up to a week,
 * with `attempts` frozen at 1 the entire time: the backoff a stage's own
 * failure declared had no way to be honoured. `hasOverdueRetry` closes that —
 * a leg with a due retry is due NOW regardless of `minInterval`, on the
 * reasoning that retrying a handful of already-budgeted-for rows is not the
 * unbounded spend `minInterval` exists to prevent (see {@link
 * StageDueness.overdue} for why it still respects the window, unlike
 * `maxStaleness`).
 */
export function stageDueness(input: {
  stageId: string;
  /** Last sweep START for this (user, stage, entity_type) leg. `null` = never. */
  lastStartedAt: Date | null;
  /** `WindowStatus.open` from `EnrichmentWindowService`. */
  windowOpen: boolean;
  /**
   * At least one `ci.pipeline_state` row for this leg is `status = 'failed'`
   * with `next_attempt_at <= now()` — `PipelineStateService.hasOverdueRetry`'s
   * answer, read off `pipeline_state_retry_idx`. Defaults to `false` so a
   * caller that has not wired the extra read gets the pre-existing behaviour
   * rather than a silent, permanent bypass of `minInterval`.
   */
  hasOverdueRetry?: boolean;
  /** Defaults to now. Injected by tests, and by anything asking "what happens at 03:00?". */
  now?: Date;
}): StageDueness {
  const { stageId, lastStartedAt, windowOpen, hasOverdueRetry = false } = input;
  const now = input.now ?? new Date();

  const schedule = stageSchedule(stageId);
  const perRunCap = schedule.perRunCap ?? null;

  const decide = (
    due: boolean,
    reason: DuenessReason,
    overdue: boolean,
    eligibleAt: Date | null,
  ): StageDueness => ({ stageId, due, reason, overdue, perRunCap, eligibleAt, schedule });

  if (schedule.trigger === 'manual') {
    // No projected time: nothing will ever make this due on its own, and
    // reporting a date would suggest otherwise.
    return decide(false, 'manual', false, null);
  }

  // A leg that has never run is the LIMIT of the staleness rule below, not an
  // exception to it: staleness is infinite, so it exceeds every finite
  // `maxStaleness` and is overdue. Written as its own branch purely so the
  // non-null narrowing that follows is a fact the compiler establishes rather
  // than one this function asserts.
  if (lastStartedAt == null) {
    return decide(true, 'never_run', true, null);
  }

  const staleness = (now.getTime() - lastStartedAt.getTime()) / 1000;

  if (staleness >= schedule.maxStaleness) {
    return decide(true, 'max_staleness_exceeded', true, null);
  }

  const eligibleAt = new Date(lastStartedAt.getTime() + schedule.minInterval * 1000);

  if (staleness < schedule.minInterval) {
    if (!hasOverdueRetry) {
      return decide(false, 'too_soon', false, eligibleAt);
    }

    // A due retry outranks `minInterval` but not the window — a metered stage
    // still may not spend outside it, so a retry recovering while the window
    // is shut waits for the window exactly as a fresh sweep would.
    if (schedule.window === 'enrichment' && !windowOpen) {
      return decide(false, 'outside_window', false, eligibleAt);
    }

    return decide(true, 'retry_due', false, null);
  }

  if (schedule.window === 'enrichment' && !windowOpen) {
    // Already eligible by interval — what it is waiting for is the window, not
    // the clock on its own cadence — so `eligibleAt` is in the past and is
    // reported as such rather than as null. The caller pairs it with
    // `WindowStatus.nextOpensAt` to get the whole answer.
    return decide(false, 'outside_window', false, eligibleAt);
  }

  return decide(true, 'interval_elapsed', false, null);
}

// ---------------------------------------------------------------------------
// The boot guard
// ---------------------------------------------------------------------------

/**
 * Module-load guard over {@link STAGE_SCHEDULES}.
 *
 * Same shape and same reasoning as `assertStageRegistryComplete` and
 * `assertStagePolicy`: every mistake it catches is SILENT at runtime, and the
 * earliest failure is the cheapest one. Throwing while the import graph is still
 * being built means the appliance refuses to start, on an operator's terminal,
 * before a queue exists to enqueue anything onto.
 *
 * What it refuses, and what each mistake would otherwise cost:
 *
 *  - **A registered stage with no schedule.** It has no cadence, so a tick would
 *    either skip it forever or fall back to a default — and the only safe
 *    default (never) is indistinguishable from the bug. Symmetric with the
 *    version guard, and reported in both directions, because a schedule for a
 *    stage that does not exist is a cadence decision nobody will ever get.
 *  - **A metered stage on `trigger: 'onArrival'`.** Arrival triggering means
 *    "one provider call per row, at import rate", which is the precise opposite
 *    of a budget. An import of 66,000 position fixes would bill for 66,000
 *    lookups in the time it takes to write them.
 *  - **A metered stage outside the enrichment window.** Time-boxing is what the
 *    user asked for and spend is the one thing it must cover. (The window's own
 *    hours, budget and timezone are `assertEnrichmentWindowPolicy`'s business in
 *    `constants.ts`, not this guard's.)
 *  - **A metered stage with no `perRunCap`.** The measured failure: weekly with
 *    no cap is still one week in which the whole corpus hits the provider at
 *    once. A cadence without a ceiling bounds how OFTEN the bill arrives and not
 *    how big it is.
 *  - **`maxStaleness < minInterval`.** A ceiling below the floor makes every leg
 *    permanently overdue, which silently deletes both the interval and the
 *    window — a five-minute metered geocoder, arrived at by a typo.
 *  - **An `onArrival` stage confined to a window.** It is not arrival-triggered
 *    if it only runs at 03:00; one of the two declarations is a lie, and which
 *    one is not knowable from here.
 *  - **A non-positive or fractional interval or cap.** `perRunCap: 0` reads as
 *    "no cap" to a careless `?? null` and as "dispatch nothing" to a careful
 *    one, and a stage that dispatches nothing forever looks exactly like a
 *    converged one.
 *
 * Takes the map as a parameter, exactly as `assertStageRegistryComplete` takes
 * the versions map, so a spec can prove the guard actually fires instead of
 * merely proving today's declarations happen to pass it.
 */
export function assertStageSchedules(schedules: Record<string, StageSchedule> = STAGE_SCHEDULES): void {
  const problems: string[] = [];

  const declaredIds = new Set<string>(STAGE_ID_LIST);
  const scheduledIds = new Set<string>(Object.keys(schedules));

  const missingSchedules = [...declaredIds].filter((id) => !scheduledIds.has(id)).sort();
  const unknownStages = [...scheduledIds].filter((id) => !declaredIds.has(id)).sort();

  if (missingSchedules.length > 0) {
    problems.push(
      `declared in STAGE_IDS but absent from STAGE_SCHEDULES (nothing decides when they run or what ` +
        `they cost): ${missingSchedules.join(', ')}`,
    );
  }

  if (unknownStages.length > 0) {
    problems.push(
      `present in STAGE_SCHEDULES but not a declared stage id (their cadence can never apply to ` +
        `anything): ${unknownStages.join(', ')}`,
    );
  }

  for (const [stageId, schedule] of Object.entries(schedules)) {
    const at = `STAGE_SCHEDULES["${stageId}"]`;

    for (const field of ['minInterval', 'maxStaleness'] as const) {
      const value = schedule[field];

      if (!Number.isFinite(value) || value <= 0) {
        problems.push(`${at}.${field} must be a positive number of seconds, got ${String(value)}`);
      }
    }

    if (
      Number.isFinite(schedule.minInterval) &&
      Number.isFinite(schedule.maxStaleness) &&
      schedule.maxStaleness < schedule.minInterval
    ) {
      problems.push(
        `${at} has maxStaleness (${schedule.maxStaleness}s) below minInterval (${schedule.minInterval}s), ` +
          `which makes every leg permanently overdue and deletes both the interval and the window`,
      );
    }

    if (schedule.perRunCap != null && (!Number.isInteger(schedule.perRunCap) || schedule.perRunCap < 1)) {
      problems.push(
        `${at}.perRunCap must be an integer >= 1 when declared, got ${String(schedule.perRunCap)}. ` +
          `Omit the field for an uncapped stage; a cap of 0 reads as "no cap" to one caller and ` +
          `"dispatch nothing" to another`,
      );
    }

    if (schedule.trigger === 'onArrival' && schedule.window !== 'any') {
      problems.push(
        `${at} is trigger: 'onArrival' but window: '${schedule.window}'. A stage that only starts ` +
          `only while the enrichment window is open is not arrival-triggered`,
      );
    }

    if (schedule.cost !== 'metered') {
      continue;
    }

    if (schedule.trigger === 'onArrival') {
      problems.push(
        `${at} is metered and trigger: 'onArrival', which bills one provider call per arriving row at ` +
          `import rate. A metered stage must be 'scheduled' or 'manual'`,
      );
    }

    if (schedule.window !== 'enrichment') {
      problems.push(
        `${at} is metered but window: '${schedule.window}'. Spend is the one thing the daily time box ` +
          `exists to bound`,
      );
    }

    if (schedule.perRunCap == null) {
      problems.push(
        `${at} is metered with no perRunCap. The interval bounds how often the bill arrives, not how ` +
          `big it is — an uncapped weekly sweep is one week in which the whole corpus hits a paid ` +
          `provider at once`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Pipeline stage schedules are invalid — ${problems.join('; ')}.`);
  }
}

// Run at module load, not at `onModuleInit` — the same decision, for the same
// reason, as the registry and version guards. An unscheduled or uncapped stage
// is a programming error, and the cheapest place to discover a cost mistake is
// before the process that would incur it has finished starting.
assertStageSchedules();
