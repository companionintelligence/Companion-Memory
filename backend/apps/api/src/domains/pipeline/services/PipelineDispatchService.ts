import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { BACKFILL_JOB_PRIORITY, EventService, OnEvent } from '@ci/domains/events';

import { DEFAULT_SLICE_SIZE, MAX_SLICES_PER_SWEEP, MAX_SWEEP_HOPS, PIPELINE_QUEUES } from '../constants';
import { PipelineSliceEvent, PipelineSweepEvent } from '../events';
import { pipelineSweepPayloadSchema, type PipelineSlicePayload, type PipelineSweepPayload } from '../types';

import { PipelineStateService } from './PipelineStateService';
import { StageRegistry } from './StageRegistry';

/** What a caller supplies to start a sweep; everything else has a default. */
export interface StartSweepInput {
  stage: string;
  userId: string;
  /** Required only for stages declaring more than one entity type. */
  entityType?: string;
  /** Ids per slice. Defaults to {@link DEFAULT_SLICE_SIZE}. */
  sliceSize?: number;
  /**
   * Ceiling on ids this whole sweep may dispatch, across every hop. Omitted is
   * uncapped.
   *
   * The caller supplies it rather than this service reading `STAGE_SCHEDULES`,
   * for the same reason `stageDueness` takes `lastStartedAt`: the dispatcher
   * does not own policy. `PipelineControlService` passes
   * `stagePerRunCap(stageId)`; an operator route sweeping one stage by hand may
   * pass its own number or none at all.
   */
  maxIds?: number;
}

/** Outcome of one sweep hop. Returned for tests and for the caller's log line. */
export interface SweepHopResult {
  stage: string;
  /** Ids dispatched by THIS hop. */
  dispatched: number;
  /** Slices enqueued by this hop. */
  slices: number;
  /** Keyset position after this hop; `null` when the hop found nothing. */
  cursor: string | null;
  /** True when the source is drained and no further hop was scheduled. */
  exhausted: boolean;
  /**
   * True when the sweep stopped because it reached `maxIds` rather than because
   * the source ran dry. Distinct from {@link exhausted} on purpose: both end the
   * chain, but only one of them means there is nothing left to do. A capped
   * sweep leaves stale rows behind deliberately, so the tick's probe still finds
   * candidates and the leg is not recorded as drained.
   */
  capped: boolean;
}

/**
 * Turns "this stage has stale rows" into pg-boss jobs.
 *
 * ── Why a self-requeuing chain instead of a loop ───────────────────────────
 *
 * Every backfill in this codebase is a `while` loop inside a request handler or
 * a single pg-boss job: it keyset-pages the source, does the work inline, and
 * holds one connection for as long as that takes. Two things follow. The loop
 * dies with the process — an API restart mid-sweep loses everything not yet
 * written, which is why one ETL leg marks a *failed* transform as transformed
 * "so a failed/heavy job does not re-queue forever after API OOM restarts". And
 * the loop is invisible: nothing outside the process knows how far it got, so
 * closing the tab or losing the connection means starting over.
 *
 * A sweep here is a CHAIN OF JOBS. Each hop selects a bounded number of slices,
 * enqueues them, and re-enqueues itself carrying the advanced cursor. The
 * cursor lives in `pgboss.job.data`, so a killed process resumes at the next
 * hop from exactly where it stopped, and the sweep's progress is inspectable
 * from the database with no cooperation from the running code.
 *
 * ── Backpressure, for free ─────────────────────────────────────────────────
 *
 * The sweep rides the SAME queue as the slices it produces, at the same
 * priority. pg-boss fetches `ORDER BY priority DESC, created_on`, so the next
 * hop sits behind the slices the previous hop just enqueued and cannot run
 * until the workers have drained them. The sweep therefore paces itself to the
 * workers' real throughput instead of enqueuing a million-row corpus in one
 * pass and burying every other queue behind it. No token bucket, no queue-depth
 * poll, no configuration — just ordering.
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 *
 * Safe to run against itself. Within one sweep the keyset cursor guarantees an
 * id is dispatched once. Across two overlapping sweeps (an operator clicking
 * twice, a replayed dead letter racing a live sweep) the same id can be
 * dispatched twice, because a row claimed but not yet completed still satisfies
 * the staleness predicate — `claim()` deliberately does not advance
 * `stage_version`. That duplicate is absorbed at the claim: the second worker
 * gets a shorter list back and does correspondingly less work. Duplicate
 * dispatch costs enqueues, never correctness.
 *
 * ── One caveat, for dev and tests ──────────────────────────────────────────
 *
 * `LocalEventService` runs listeners INLINE rather than through a queue, so
 * under it the self-requeue is direct recursion and a long sweep will grow the
 * call stack one frame per hop. Fine at dev-fixture sizes; a sweep over a real
 * corpus belongs on pg-boss, which is what production binds.
 */
@Injectable()
export class PipelineDispatchService {
  constructor(
    private readonly stateService: PipelineStateService,
    private readonly stageRegistry: StageRegistry,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PipelineDispatchService.name);
  }

  /**
   * Begin a sweep for one stage and user.
   *
   * Returns as soon as the first hop is enqueued — the sweep itself runs on the
   * queue. A caller that wants to know how it went reads
   * `PipelineStateService.coverage`, not a return value; that is the whole
   * point of making progress durable rather than in-process.
   */
  async startSweep(input: StartSweepInput): Promise<void> {
    // Resolved here so a bad stage id fails at the call site — an HTTP request,
    // a cron, a controller — instead of inside a worker three minutes later
    // where the only trace is a dead letter.
    const stage = this.stageRegistry.get(input.stage);

    const payload: PipelineSweepPayload = {
      stage: stage.id,
      userId: input.userId,
      entityType: input.entityType,
      cursor: null,
      sliceSize: input.sliceSize ?? DEFAULT_SLICE_SIZE,
      hop: 0,
      dispatched: 0,
      maxIds: input.maxIds ?? null,
    };

    await this.eventService.send(PipelineSweepEvent, payload, {
      queue: stage.queue,
      priority: BACKFILL_JOB_PRIORITY,
    });

    this.logger.log('Started pipeline sweep', {
      stage: stage.id,
      userId: input.userId,
      queue: stage.queue,
      sliceSize: payload.sliceSize,
      maxIds: payload.maxIds,
    });
  }

  // -------------------------------------------------------------------------
  // Queue bindings
  //
  // One method per queue, all delegating to the same implementation. The
  // listener registry keys on `${eventName}:${queue}` and permits exactly one
  // handler per pair, so a single decorated method could only ever serve one
  // queue. A sweep must run on the queue its stage's slices ride (that is where
  // the backpressure comes from), hence three bindings over one body.
  // -------------------------------------------------------------------------

  @OnEvent(PipelineSweepEvent, { queue: PIPELINE_QUEUES.INDEX })
  async handleIndexSweep(payload: unknown): Promise<void> {
    await this.runSweepHop(payload);
  }

  @OnEvent(PipelineSweepEvent, { queue: PIPELINE_QUEUES.ENRICH })
  async handleEnrichSweep(payload: unknown): Promise<void> {
    await this.runSweepHop(payload);
  }

  @OnEvent(PipelineSweepEvent, { queue: PIPELINE_QUEUES.EMBED })
  async handleEmbedSweep(payload: unknown): Promise<void> {
    await this.runSweepHop(payload);
  }

  /**
   * One hop: select up to {@link MAX_SLICES_PER_SWEEP} slices of stale ids,
   * enqueue them in a single bulk insert, and re-enqueue this sweep behind them
   * unless the source is drained or the sweep has spent its budget.
   *
   * ── The budget, and why it is checked between slices ───────────────────────
   *
   * `payload.maxIds` is a `StageSchedule.perRunCap` that travelled here from the
   * control tick. It bounds the WHOLE sweep, not one hop: `payload.dispatched`
   * is the running total carried across the chain, so a cap of 2,000 at
   * `DEFAULT_SLICE_SIZE` ends the chain two hops in rather than letting every
   * hop dispatch 2,000 of its own.
   *
   * The check sits between slices rather than inside one. Trimming a page to hit
   * an exact number would make the cap a source of odd-sized slices — and the
   * last id of a trimmed page is not the cursor the sweep would have advanced
   * to, so a resumed chain would re-select rows it had already dispatched. The
   * declared contract is therefore slice granularity: a sweep may overshoot by
   * strictly less than `sliceSize`, which is the slack `StageSchedule.perRunCap`
   * documents. For the metered stages that is at most 199 extra ids against a
   * weekly budget of one or two thousand, and every one of them rides
   * `GeocodeService`'s cache.
   *
   * Public so a test can drive a sweep hop by hop without a queue.
   */
  async runSweepHop(rawPayload: unknown): Promise<SweepHopResult> {
    // Parsed, not cast. The payload came out of `pgboss.job.data` — JSON
    // written by some earlier release of this code, possibly weeks ago. A
    // malformed one throws here, where it dead-letters with the payload intact,
    // rather than flowing into a SQL parameter as `undefined`.
    const payload = pipelineSweepPayloadSchema.parse(rawPayload);

    const stage = this.stageRegistry.get(payload.stage);

    // A multi-type stage MUST be told which type it is sweeping — the ledger is
    // keyed per (entity_type, entity_id, stage), so defaulting to the first
    // declared type would record one type's progress under another's key and
    // both sweeps would then read the ledger wrong, in opposite directions.
    // `selectStale` enforces the same rule; refusing here too keeps the slice
    // payload from carrying a type the sweep never actually used.
    if (payload.entityType == null && stage.entityTypes.length !== 1) {
      throw new Error(
        `Sweep for stage "${stage.id}" must name an entityType: the stage declares ` +
          `${stage.entityTypes.length} (${stage.entityTypes.join(', ')}).`,
      );
    }

    const entityType = payload.entityType ?? stage.entityTypes[0];

    if (payload.hop >= MAX_SWEEP_HOPS) {
      // Reached only by a sweep that is not converging. Stopping is the correct
      // failure: a self-requeuing job with no fuel gauge is the one bug class
      // that fills `pgboss.job` faster than any worker can drain it.
      this.logger.error(
        `Pipeline sweep for stage ${stage.id} hit the hop ceiling (${MAX_SWEEP_HOPS}) and was stopped. ` +
          `The cursor is advancing but the source is not draining — check the stage's applicability ` +
          `predicate and whether its slices are completing.`,
      );

      return {
        stage: stage.id,
        dispatched: 0,
        slices: 0,
        cursor: payload.cursor ?? null,
        exhausted: false,
        capped: false,
      };
    }

    const maxIds = payload.maxIds ?? null;

    const slices: Array<{ name: string; data: Record<string, unknown> }> = [];

    let cursor: string | null = payload.cursor ?? null;
    let dispatched = 0;
    let exhausted = false;
    let capped = false;

    for (let i = 0; i < MAX_SLICES_PER_SWEEP; i += 1) {
      // BEFORE the select, so a spent budget costs nothing at all — not a
      // staleness query, and not the slice it would have produced. `>=` rather
      // than `>`: at exactly the cap the sweep has had everything it was
      // authorised for.
      if (maxIds != null && payload.dispatched + dispatched >= maxIds) {
        capped = true;
        break;
      }

      const ids: string[] = await this.stateService.selectStale(
        stage,
        payload.userId,
        cursor,
        payload.sliceSize,
        entityType,
      );

      if (ids.length === 0) {
        exhausted = true;
        break;
      }

      const slicePayload: PipelineSlicePayload = {
        stage: stage.id,
        entityType,
        userId: payload.userId,
        ids,
        runId: null,
        shardId: null,
      };

      slices.push({ name: PipelineSliceEvent, data: { ...slicePayload } });
      dispatched += ids.length;

      const nextCursor = ids[ids.length - 1];

      // The sweep orders by the keyset column and filters on `> cursor`, so the
      // last id of a page is strictly greater than the cursor that produced it.
      // If that ever stops being true the sweep would re-select the same page
      // forever; assert rather than trust, because the failure mode is an
      // infinite enqueue loop and the check costs one comparison per page.
      if (cursor != null && nextCursor <= cursor) {
        throw new Error(
          `Pipeline sweep for stage ${stage.id} failed to advance its cursor (${cursor} -> ${nextCursor}). ` +
            `The stage source's id column must be orderable and unique.`,
        );
      }

      cursor = nextCursor;

      // A short page means the source is drained: there is no id beyond this
      // cursor that satisfies the staleness predicate right now.
      if (ids.length < payload.sliceSize) {
        exhausted = true;
        break;
      }
    }

    if (slices.length > 0) {
      // ONE bulk insert for the whole hop. `send()` per slice would be a round
      // trip each; `sendMany` is a single INSERT and produces byte-identical
      // jobs, so the slice listener consumes them unchanged.
      await this.eventService.sendMany(stage.queue, slices, { priority: BACKFILL_JOB_PRIORITY });
    }

    const totalDispatched = payload.dispatched + dispatched;

    // The budget can also be reached by the LAST slice of a hop that filled
    // every page, in which case the loop ended on `MAX_SLICES_PER_SWEEP` rather
    // than on the check above. Re-tested here so the chain stops now instead of
    // enqueuing one more hop that would immediately stop itself — a wasted job,
    // and a log line that reads like the sweep is still running.
    //
    // `exhausted` wins a tie. A sweep that drained the source on the same slice
    // that spent the budget has nothing left to do, and "drained" is the fact
    // worth reporting: it is the one that says a later sweep will find nothing.
    if (!exhausted && maxIds != null && totalDispatched >= maxIds) {
      capped = true;
    }

    if (!exhausted && !capped) {
      const next: PipelineSweepPayload = {
        stage: stage.id,
        userId: payload.userId,
        entityType: payload.entityType,
        cursor,
        sliceSize: payload.sliceSize,
        hop: payload.hop + 1,
        dispatched: totalDispatched,
        maxIds,
      };

      // Behind the slices just enqueued, on the same queue, at the same
      // priority — see the class comment on backpressure.
      await this.eventService.send(PipelineSweepEvent, next, {
        queue: stage.queue,
        priority: BACKFILL_JOB_PRIORITY,
      });
    }

    this.logger.log(
      capped
        ? 'Pipeline sweep reached its per-run cap'
        : exhausted
          ? 'Pipeline sweep drained'
          : 'Pipeline sweep hop dispatched',
      {
        stage: stage.id,
        entityType,
        userId: payload.userId,
        hop: payload.hop,
        slices: slices.length,
        dispatched,
        totalDispatched,
        maxIds,
        cursor,
      },
    );

    return { stage: stage.id, dispatched, slices: slices.length, cursor, exhausted, capped };
  }
}
