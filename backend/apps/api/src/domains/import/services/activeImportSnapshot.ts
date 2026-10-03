import { basename } from 'node:path';

import { IMPORT_STAGE_CONCURRENCY } from '../constants';
import type { ImportRun } from '../entities/ImportRunEntity';
import type { ImportStage } from '../entities/ImportStageEntity';

import { isStageStalled } from './stageLiveness';

/**
 * The live picture of everything importing right now, assembled once.
 *
 * ## Why this exists at all
 *
 * The progress surfaces used to answer "what is happening" by polling
 * `GET /import/runs/:id` per run. That is fine for the one or two runs a wizard
 * card starts, and it falls over on the shape people actually run: a 13-source
 * batch (one run per top-level folder in the inbox) meant thirteen requests
 * every two seconds, thirteen independent re-render clocks, and — the part that
 * mattered — no way for either the UI or a person reading a log to answer the
 * only question worth asking, which is "why has that one not moved in an hour?"
 *
 * So this is ONE object, computed server-side, that answers the five questions a
 * fresh reader (human or agent) has about an import in flight:
 *
 *   1. **What is running?** — `runs[].stages[]` with `queueState: 'running'`.
 *   2. **What is it working on?** — `phase`, `processed`/`total`, `itemsPerSec`.
 *   3. **What is waiting, and behind what?** — `queueState: 'waiting'` plus a
 *      real `queuePosition`, against a stated `queue.concurrency`.
 *   4. **How long has each thing taken?** — `elapsedMs` per stage and per run,
 *      live for the things still going.
 *   5. **What went wrong?** — `error` on the stage that failed, carried up to
 *      `batch.failed` so a caller does not have to go looking.
 *
 * `GET /import/runs/active` serves it verbatim, which makes that URL the single
 * thing to curl when an import looks wrong.
 *
 * ## The distinction this file exists to make
 *
 * `import_stages.status` has ONE value — `queued` — for two situations that
 * could not be more different to somebody watching:
 *
 *  - **waiting**: every earlier stage of this run is finished, so the stage has
 *    a real job on its kind's queue (`import-parse`, `import-media`, …) and
 *    will start the moment a slot of that kind frees. With one parse slot and
 *    thirteen runs, this is normal and can last an hour.
 *  - **blocked**: an earlier stage of the SAME run is still going, so this
 *    stage has not been enqueued at all — nothing is waiting on it yet, because
 *    nothing has asked for it. (`ImportRunService.enqueueStage` is called once
 *    per stage, as the previous one finishes; the whole ladder is NOT queued up
 *    front.)
 *
 * Rendering both as "queued" is precisely why a 51-minute wait is indis-
 * tinguishable from a stuck import today. {@link classifyStage} separates them
 * from the stage rows alone, with no coupling to pg-boss internals — which was
 * checked against the live queue and would have been wrong anyway: `pgboss.job`
 * held 142 `created` rows for 19 distinct stages on the observed batch, because
 * a redelivered stage job is a deliberate no-op and leaves its row behind.
 */

/** Stage statuses that will never move again. */
const TERMINAL_STAGE_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'skipped', 'cancelled']);

/** Run statuses that will never move again. Mirrors the frontend's copy. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'partial', 'failed', 'cancelled']);

/**
 * Where a stage sits relative to the slots its KIND has.
 *
 * Deliberately NOT a rename of `status`: both are reported, because they answer
 * different questions. `status` is what the database row says; this is what it
 * MEANS given the rest of the run and the queue.
 */
export type StageQueueState = 'running' | 'waiting' | 'blocked' | 'done';

/** A stage row plus what it MEANS: its queue state and when it became runnable. */
export interface ClassifiedStage {
  stage: ImportStage;
  state: StageQueueState;
  /** When it became runnable — the key the kind's ready queue is ordered by. */
  readyAt: Date | null;
}

export interface ActiveStage {
  id: string;
  seq: number;
  kind: string;
  status: string;
  phase: string | null;
  processed: number;
  /** Null means "not yet countable" — draw an indeterminate bar, never 0%. */
  total: number | null;
  weight: number;
  /** Throughput the runner measured. Null until it has moved enough to mean anything. */
  itemsPerSec: number | null;
  etaSeconds: number | null;
  /** Wall clock for a FINISHED stage, as the runner recorded it. */
  durationMs: number | null;
  error: string | null;
  detail: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  /** See {@link StageQueueState} — the difference between "waiting" and "stuck". */
  queueState: StageQueueState;
  /**
   * 1-based place in the ready queue FOR THIS STAGE'S KIND, or null when the
   * stage is not `waiting`. Position 1 is next to run.
   *
   * Per kind because that is how the appliance queues them: a parse eighth in
   * a list of every waiting stage may be first among the parses, and telling
   * someone "8th in line" when it starts next is exactly the confident wrong
   * number this endpoint exists to stop reporting.
   */
  queuePosition: number | null;
  /**
   * When this stage became runnable — the instant the previous stage of its run
   * finished, which is when `enqueueStage` was called. Null unless `waiting`.
   *
   * Verified against the live queue: `pgboss.job.created_on` for a queued stage
   * matched this to within ~50ms on every row of the observed batch.
   */
  waitingSince: string | null;
  /**
   * Live wall clock: how long the stage has been going (`running`), or waiting
   * for the slot (`waiting`), or how long it took (`done`). Null for `blocked`,
   * which has not started waiting on anything yet.
   */
  elapsedMs: number | null;
  /** The claim's last sign of life — heartbeat or progress write. */
  heartbeatAt: string | null;
  /**
   * `running`, but silent past `IMPORT_STAGE_STALLED_SECONDS`: its worker is
   * gone or wedged. A separate flag rather than a new `queueState`, because the
   * stage still holds its slot — which is exactly what `running` says — and
   * because every consumer already switches on the four states it has.
   */
  stalled: boolean;
}

export interface ActiveRun {
  id: string;
  label: string | null;
  source: string;
  /**
   * The archive or folder this run is importing — `google-takeout`, `amazon`.
   *
   * THE field that makes a batch legible. Thirteen runs of one inbox scan all
   * carry the same `label` (the batch name the caller passed), so the run list
   * rendered thirteen rows reading "qa-full-corpus" and nothing distinguished
   * them. This is the staged source's own name, available from the first poll —
   * before `dataSources` exists, which needs a finished parse.
   */
  unit: string | null;
  /** Services the parse recognized, DEDUPED and most-common first. */
  dataSources: string[];
  declaredSources: string[] | null;
  status: string;
  percent: number;
  requestedStages: string[];
  error: string | null;
  /** Rows this run has written into `ci.*` so far (`push` stages' `detail.pushed`). */
  records: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Live for an unfinished run; final for a finished one. */
  elapsedMs: number | null;
  /** Any of its stages is {@link ActiveStage.stalled}. */
  stalled: boolean;
  stages: ActiveStage[];
}

export interface ActiveImportSnapshot {
  /** When the server computed this, so a log line or screenshot can be placed in time. */
  generatedAt: string;
  /** Is anything still going? The one boolean a caller needs to decide whether to render. */
  active: boolean;
  batch: {
    /** Runs in this snapshot — unfinished, plus the finished siblings of the same batch. */
    total: number;
    running: number;
    /** Runs whose every stage is `waiting` or `blocked` — started, doing nothing yet. */
    queued: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Unweighted mean of the runs' own weighted percents — see the note in build(). */
    percent: number;
    /** Rows written into `ci.*` across the batch so far. */
    records: number;
    startedAt: string | null;
    elapsedMs: number | null;
  };
  queue: {
    /**
     * Slots per stage KIND, across every run and user — the appliance runs one
     * queue per kind (`import-parse`, `import-media`, …), so a parse waits
     * behind other parses and nothing else. Reported per kind rather than as a
     * single number because the numbers differ (media has two slots, the rest
     * one) and because a surface that says "one at a time" while the appliance
     * runs two would be a new way to look broken.
     */
    concurrency: Record<string, number>;
    /** Every kind's slots added up. What the batch can have in flight at once. */
    slots: number;
    /** Stages holding a slot right now. */
    running: number;
    /** Stages enqueued and waiting for a slot. `queue.running + waiting` is the real backlog. */
    waiting: number;
    /** Stages not enqueued yet, because an earlier stage of their own run is unfinished. */
    blocked: number;
    /** How long the longest-waiting stage has been waiting. The stall/normal tell. */
    longestWaitMs: number | null;
    /** Running stages whose heartbeat has gone silent — see {@link ActiveStage.stalled}. */
    stalled: number;
  };
  runs: ActiveRun[];
  /**
   * The batch had more finished runs than the cap and they were dropped. Only
   * ever affects the finished tail — nothing unfinished is omitted.
   */
  truncated: boolean;
}

export interface ActiveSnapshotInput {
  /** The batch's runs, any order. */
  runs: readonly ImportRun[];
  /** Every stage of every run above, any order. */
  stages: readonly ImportStage[];
  /** Run id → the staged source's path or filename, for {@link ActiveRun.unit}. */
  units: ReadonlyMap<string, string>;
  /** Run id → rows written, from the push stages' `detail.pushed`. */
  records: ReadonlyMap<string, number>;
  truncated?: boolean;
  /** Injectable so tests can pin every elapsed number. */
  now?: Date;
}

/** The empty answer, for when the user has nothing in flight. */
export function idleSnapshot(now: Date = new Date()): ActiveImportSnapshot {
  return {
    generatedAt: now.toISOString(),
    active: false,
    batch: {
      total: 0,
      running: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      percent: 0,
      records: 0,
      startedAt: null,
      elapsedMs: null,
    },
    queue: {
      concurrency: { ...IMPORT_STAGE_CONCURRENCY },
      slots: TOTAL_STAGE_SLOTS,
      running: 0,
      waiting: 0,
      blocked: 0,
      longestWaitMs: null,
      stalled: 0,
    },
    runs: [],
    truncated: false,
  };
}

/** Every kind's slots added up — what the appliance can have in flight at once. */
const TOTAL_STAGE_SLOTS = Object.values(IMPORT_STAGE_CONCURRENCY).reduce((sum, slots) => sum + slots, 0);

/**
 * Assemble the snapshot from raw rows. Pure — every clock reading comes from
 * `now`, so the tests can assert exact durations.
 */
export function buildActiveSnapshot(input: ActiveSnapshotInput): ActiveImportSnapshot {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  const stagesByRun = new Map<string, ImportStage[]>();

  for (const stage of input.stages) {
    const bucket = stagesByRun.get(stage.runId);

    if (bucket == null) {
      stagesByRun.set(stage.runId, [stage]);
    } else {
      bucket.push(stage);
    }
  }

  // Oldest first — the order the appliance started them, which is also the
  // order it will finish them under a single slot. A newest-first list puts the
  // run that is furthest from running at the top, which is backwards for
  // watching a batch drain.
  const orderedRuns = [...input.runs].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
  );

  // Pass one: classify every stage, so the queue ranking below can see all of
  // them at once. Position is a property of the QUEUE, not of a run, and can
  // only be assigned after every run has been read.
  const classified = new Map<string, ClassifiedStage>();

  for (const run of orderedRuns) {
    const stages = (stagesByRun.get(run.id) ?? []).slice().sort((left, right) => left.seq - right.seq);

    for (const entry of classifyStages(run, stages)) {
      classified.set(entry.stage.id, entry);
    }
  }

  // The ready queues, in the order their workers will drain them: by the instant
  // each stage became runnable. `id` breaks ties so two stages enqueued in the
  // same millisecond get a stable, if arbitrary, order rather than flickering
  // between polls.
  //
  // ONE QUEUE PER KIND, because that is what the appliance runs
  // (`IMPORT_STAGE_QUEUE_BY_KIND`): a parse waits behind other parses and is
  // not delayed by a media stage at all. Ranking every waiting stage in one
  // line would report a position the worker will never honour — "9th in line"
  // for a stage that is actually next — which is precisely the kind of
  // confident wrong number this surface exists to stop telling people.
  const queuePositions = new Map<string, number>();
  const waitingByKind = new Map<string, ClassifiedStage[]>();
  const waiting = [...classified.values()]
    .filter((entry) => entry.state === 'waiting')
    .sort((left, right) => {
      const delta = (left.readyAt?.getTime() ?? 0) - (right.readyAt?.getTime() ?? 0);

      return delta !== 0 ? delta : left.stage.id.localeCompare(right.stage.id);
    });

  for (const entry of waiting) {
    const queue = waitingByKind.get(entry.stage.kind) ?? [];

    queue.push(entry);
    waitingByKind.set(entry.stage.kind, queue);
    queuePositions.set(entry.stage.id, queue.length);
  }

  const runs: ActiveRun[] = orderedRuns.map((run) => {
    const stages = (stagesByRun.get(run.id) ?? []).slice().sort((left, right) => left.seq - right.seq);
    const startedAt = run.startedAt ?? null;
    const finishedAt = run.finishedAt ?? null;
    const activeStages: ActiveStage[] = stages.map((stage) => {
      const entry = classified.get(stage.id);
      const state = entry?.state ?? 'blocked';
      const readyAt = entry?.readyAt ?? null;

      return {
        id: stage.id,
        seq: stage.seq,
        kind: stage.kind,
        status: stage.status,
        phase: stage.phase,
        processed: Number(stage.processed),
        total: stage.total == null ? null : Number(stage.total),
        weight: stage.weight,
        itemsPerSec: stage.itemsPerSec,
        etaSeconds: stage.etaSeconds,
        durationMs: stage.durationMs == null ? null : Number(stage.durationMs),
        error: stage.error,
        detail: stage.detail ?? {},
        startedAt: stage.startedAt?.toISOString() ?? null,
        finishedAt: stage.finishedAt?.toISOString() ?? null,
        queueState: state,
        queuePosition: queuePositions.get(stage.id) ?? null,
        waitingSince: state === 'waiting' ? (readyAt?.toISOString() ?? null) : null,
        elapsedMs: stageElapsed(stage, state, readyAt, nowMs),
        heartbeatAt: stage.updatedAt?.toISOString() ?? null,
        stalled: isStageStalled(stage, now),
      };
    });

    return {
      id: run.id,
      label: run.label,
      source: run.source,
      unit: unitLabel(input.units.get(run.id), stages) ?? null,
      dataSources: dedupeByFrequency(run.dataSources ?? []),
      declaredSources: run.declaredSources ?? null,
      status: run.status,
      percent: run.percent,
      requestedStages: [...(run.requestedStages ?? [])],
      error: run.error,
      records: input.records.get(run.id) ?? 0,
      createdAt: run.createdAt.toISOString(),
      startedAt: startedAt?.toISOString() ?? null,
      finishedAt: finishedAt?.toISOString() ?? null,
      elapsedMs: elapsed(startedAt, finishedAt, nowMs),
      stalled: activeStages.some((stage) => stage.stalled),
      stages: activeStages,
    };
  });

  const unfinished = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  const queueStates = [...classified.values()];
  const longestWait = waiting[0]?.readyAt ?? null;
  const earliestStart = runs
    .map((run) => run.startedAt)
    .filter((value): value is string => value != null)
    .sort()[0];

  return {
    generatedAt: now.toISOString(),
    active: unfinished.length > 0,
    batch: {
      total: runs.length,
      running: runs.filter((run) => run.status === 'running').length,
      queued: runs.filter((run) => run.status === 'queued').length,
      completed: runs.filter((run) => run.status === 'completed' || run.status === 'partial').length,
      failed: runs.filter((run) => run.status === 'failed').length,
      cancelled: runs.filter((run) => run.status === 'cancelled').length,
      // The MEAN of the runs' own weighted percents, not a re-weighting across
      // the batch. Each run's `percent` already accounts for the relative cost
      // of its stages (unpack 20 / parse 35 / media 30 / push 15); pretending
      // to know how a 40GB Takeout weighs against a 2MB Lyft export on top of
      // that would be a fabricated number, and this bar's only job is to say
      // roughly how far through the batch is.
      percent:
        runs.length === 0 ? 0 : Math.round(runs.reduce((sum, run) => sum + run.percent, 0) / runs.length),
      records: runs.reduce((sum, run) => sum + run.records, 0),
      startedAt: earliestStart ?? null,
      elapsedMs: earliestStart == null ? null : nowMs - new Date(earliestStart).getTime(),
    },
    queue: {
      concurrency: { ...IMPORT_STAGE_CONCURRENCY },
      slots: TOTAL_STAGE_SLOTS,
      running: queueStates.filter((entry) => entry.state === 'running').length,
      waiting: waiting.length,
      blocked: queueStates.filter((entry) => entry.state === 'blocked').length,
      longestWaitMs: longestWait == null ? null : nowMs - longestWait.getTime(),
      stalled: runs.reduce((sum, run) => sum + run.stages.filter((stage) => stage.stalled).length, 0),
    },
    runs,
    truncated: input.truncated ?? false,
  };
}

/**
 * Split one run's stages into running / waiting / blocked / done.
 *
 * The rule, in full: a `queued` stage is WAITING when every lower-`seq` stage of
 * its run is terminal, and BLOCKED otherwise. That mirrors what the runner
 * actually does — `advanceRun` enqueues the next stage as the previous one
 * finishes, one at a time — so at most one stage per run can be waiting, which
 * is why the ready queues together are bounded by the number of live runs
 * rather than by four times that.
 *
 * `readyAt` for a waiting stage is the moment the last of those earlier stages
 * finished; for a run's very first stage it is the run's own start. That is the
 * instant `enqueueStage` was called, so it is the correct key to sort the queue
 * by — and it is what turns "queued" into "queued for 51 minutes, third in line".
 *
 * One exception, and it is not cosmetic: a stage of a FINISHED run is never
 * waiting, however terminal its predecessors are. A failed stage ends the run
 * without enqueueing its successor, so the successor's `queued` row survives
 * forever — and reporting it as "next in the save queue" both promises work
 * that will never happen and pads the backlog with jobs that do not exist.
 */
export function classifyStages(
  run: Pick<ImportRun, 'startedAt' | 'createdAt'> & Partial<Pick<ImportRun, 'status' | 'finishedAt'>>,
  stagesInSeqOrder: readonly ImportStage[],
): ClassifiedStage[] {
  let allEarlierTerminal = true;
  /** Latest finish among the earlier stages — when this one became runnable. */
  let readyAt: Date | null = run.startedAt ?? run.createdAt ?? null;
  // A run that is over will never enqueue anything again: when a stage fails,
  // `advanceRun` finishes the run instead of enqueueing its successor, and the
  // successor's `queued` row is left behind for good. Calling that row "next in
  // the save queue" — which it did, on a failed run, on screen — promises work
  // that will never happen and inflates the backlog counts with stages nothing
  // will ever pick up.
  const abandoned = run.finishedAt != null || (run.status != null && TERMINAL_RUN_STATUSES.has(run.status));

  return stagesInSeqOrder.map((stage) => {
    const state = classifyStage(stage.status, allEarlierTerminal && !abandoned);
    const entry = { stage, state, readyAt: state === 'waiting' ? readyAt : null };

    if (!TERMINAL_STAGE_STATUSES.has(stage.status)) {
      allEarlierTerminal = false;
    } else if (stage.finishedAt != null) {
      readyAt = stage.finishedAt;
    }

    return entry;
  });
}

function classifyStage(status: string, runnable: boolean): StageQueueState {
  if (status === 'running') {
    return 'running';
  }

  if (TERMINAL_STAGE_STATUSES.has(status)) {
    return 'done';
  }

  return runnable ? 'waiting' : 'blocked';
}

function stageElapsed(
  stage: ImportStage,
  state: StageQueueState,
  readyAt: Date | null,
  nowMs: number,
): number | null {
  if (state === 'waiting') {
    return readyAt == null ? null : nowMs - readyAt.getTime();
  }

  if (state === 'blocked') {
    // Nothing to measure: this stage is not waiting on the queue, it is waiting
    // on its own run. Reporting the run's elapsed time here would read as "this
    // stage has been stuck for an hour", which is the opposite of the truth.
    return null;
  }

  if (stage.durationMs != null) {
    return Number(stage.durationMs);
  }

  return elapsed(stage.startedAt ?? null, stage.finishedAt ?? null, nowMs);
}

function elapsed(startedAt: Date | null, finishedAt: Date | null, nowMs: number): number | null {
  if (startedAt == null) {
    return null;
  }

  return (finishedAt?.getTime() ?? nowMs) - startedAt.getTime();
}

/**
 * What to call the thing this run is importing.
 *
 * The staged source first — it is the ONLY identity available before the unpack
 * finishes, which is exactly when someone is staring at the screen wondering
 * which of thirteen identical rows is theirs. `UnpackStage` records the same
 * name in `detail.filename` once it has run, kept as the fallback for older
 * runs whose staged source row has since been cleaned up.
 */
function unitLabel(sourcePath: string | undefined, stages: readonly ImportStage[]): string | undefined {
  if (sourcePath != null && sourcePath.length > 0) {
    return basename(sourcePath);
  }

  const unpack = stages.find((stage) => stage.kind === 'unpack');
  const filename = unpack?.detail?.filename;

  return typeof filename === 'string' && filename.length > 0 ? filename : undefined;
}

/**
 * Collapse a run's recognized services to one entry each, most-frequent first.
 *
 * A Google Takeout arrives as 47 entries of which 30 are `google_my_activity`,
 * because the array records one per recognized FILE. Rendering it raw wrapped
 * the run row over five lines of the same word. Frequency order because the
 * dominant source is what the archive mostly is.
 */
function dedupeByFrequency(names: readonly string[]): string[] {
  const counts = new Map<string, number>();

  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([name]) => name);
}
