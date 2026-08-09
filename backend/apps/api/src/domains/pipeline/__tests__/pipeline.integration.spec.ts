import { MAX_SLICES_PER_SWEEP, PIPELINE_QUEUES } from '../constants';
import { PipelineSliceEvent, PipelineSweepEvent } from '../events';
import type { StageResult } from '../types';

import { PipelineHarness, databaseAvailability, sourceId } from './harness/pipelineHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PIPELINE, END TO END, AGAINST A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything else in `domains/pipeline/__tests__` is a unit test against a fake
 * `DataSource`. They pin the CONTRACT — which parameters the ledger binds, what
 * shape the sweep has, the order in which the worker calls claim/run/complete —
 * and they are fast, hermetic and worth keeping. What they structurally cannot
 * do is notice that the SQL is wrong, because the double is written from the
 * same understanding as the code.
 *
 * This file drives the real dispatcher, the real generic worker and the real
 * ledger against a real database, and asserts the five properties the rebuild
 * was actually for:
 *
 *  1. **Ledger transitions.** An entity goes `running` (claimed, at version 0 —
 *     the load-bearing zero) and then terminal at the CURRENT version, with a
 *     reason whenever it is not `done`.
 *  2. **Coverage counts.** `(done + skipped) / total` over rows the stage has
 *     recorded an opinion about — the answer to "is my import finished?" that
 *     the system has never been able to give.
 *  3. **Keyset paging across hops.** More rows than one slice, more slices than
 *     one hop: every id dispatched exactly once, by a chain of durable jobs
 *     rather than a loop, with the next hop queued BEHIND the slices it
 *     produced.
 *  4. **Idempotence.** A second sweep at an unchanged version does zero work.
 *     Not "little" work — zero slices, zero stage calls, not one row touched.
 *  5. **The bump.** Incrementing the integer in `versions.ts` makes the same
 *     rows candidates again, *even though the stage's output column is already
 *     populated*. Under the old `width IS NULL` predicate this corpus was
 *     finished forever; that is the defect the ledger deletes, and it can only
 *     be demonstrated against a database.
 *
 * Plus the paths that have never had a test at all: a stage that throws (ledger
 * failure with a reason, a real retry gate, a real dead letter), a stage that
 * returns nothing for an id, and a stage that skips without saying why.
 *
 * ── Skipping ───────────────────────────────────────────────────────────────
 *
 * The whole suite is SKIPPED, not failed, when no Postgres is reachable — the
 * repo's CI has no database in the default workflow, and a test that cannot run
 * must say so rather than break the build. The decision is made synchronously
 * at collection time; see `harness/README.md` for exactly what is probed and
 * what the (deliberately different) behaviour is for a database that IS
 * reachable but has not been migrated.
 */

const availability = databaseAvailability();

const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once per run so a skipped suite is never mistaken for a passing
  // one. `--verbose` shows the skipped test names; this shows the reason.
  console.warn(`[pipeline.integration] SKIPPED — ${availability.reason}`);
}

// Every hook here connects to Postgres, creates a schema and runs a handful of
// statements. Comfortably under a second in practice, but jest's 5 s default is
// not a budget worth having a flake over.
jest.setTimeout(60_000);

/** Terse `done` for a whole slice. */
function allDone(ids: string[]): Map<string, StageResult> {
  return new Map(ids.map((id) => [id, { outcome: 'done' }]));
}

describeWithDatabase(`pipeline integration (${availability.target})`, () => {
  // -------------------------------------------------------------------------
  // 1. One stage, end to end
  // -------------------------------------------------------------------------

  describe('a stage end to end', () => {
    let harness: PipelineHarness;
    let ids: string[];

    beforeAll(async () => {
      harness = await PipelineHarness.start();
      ids = await harness.seed(12);

      await harness.sweep({ sliceSize: 5 });
    });

    afterAll(async () => {
      await harness.teardown();
    });

    it('records one terminal ledger row per applicable entity, at the current version', async () => {
      const rows = await harness.ledgerRows();

      expect(rows).toHaveLength(12);
      expect(rows.map((row) => row.entity_id)).toEqual(ids);

      for (const row of rows) {
        expect(row.entity_type).toBe(harness.entityType);
        expect(row.stage).toBe(harness.stageId);
        expect(row.status).toBe('done');
        // The version the sweep will measure staleness against next time. A row
        // written at the wrong version either never comes back or never stops
        // coming back.
        expect(row.stage_version).toBe(harness.stageVersion());
        expect(row.reason).toBeNull();
        // Charged by `claim()` and nowhere else, so it counts genuine starts.
        expect(row.attempts).toBe(1);
        expect(row.next_attempt_at).toBeNull();
        // Denormalized at claim time so the sweep, the dashboard and the reaper
        // can all filter by user without joining back to the source table.
        expect(row.user_id).toBe(harness.userId);
      }
    });

    it('never offers the stage a row its applicability predicate excludes', async () => {
      // The decoy is `application/pdf` for the same user, ordered after every
      // applicable id — so its absence cannot be confused with the sweep
      // stopping early.
      const decoyId = sourceId(13);
      const ledger = await harness.ledgerById();

      expect(await harness.sourceRows()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: decoyId })]),
      );
      expect(ledger.has(decoyId)).toBe(false);
      expect(harness.processedIds()).not.toContain(decoyId);
    });

    it('never offers the stage another user’s row', async () => {
      const otherUsersId = sourceId(14);
      const ledger = await harness.ledgerById();

      expect(ledger.has(otherUsersId)).toBe(false);
      expect(harness.processedIds()).not.toContain(otherUsersId);
    });

    it('answers "is my import finished?" with a coverage number', async () => {
      const coverage = await harness.coverage();

      expect(coverage).toMatchObject({
        stage: harness.stageId,
        stageVersion: harness.stageVersion(),
        total: 12,
        done: 12,
        skipped: 0,
        failed: 0,
        pending: 0,
        running: 0,
        quarantined: 0,
        stale: 0,
      });

      expect(coverage.coverage).toBe(1);
    });

    it('hands the stage bounded slices, never the whole corpus', () => {
      // 12 applicable rows at a slice size of 5.
      expect(harness.invocationLog().map((call) => call.ids.length)).toEqual([5, 5, 2]);

      for (const call of harness.invocationLog()) {
        expect(call.userId).toBe(harness.userId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. The claim, observed mid-flight
  // -------------------------------------------------------------------------

  describe('the claim, seen from inside the stage', () => {
    let harness: PipelineHarness;
    let midFlight: Map<string, { status: string; stage_version: number; attempts: number }>;

    beforeAll(async () => {
      harness = await PipelineHarness.start();
      await harness.seed(3, { withDecoys: false });

      // The only moment the intermediate state is observable: the worker has
      // claimed the ids and has not yet completed them.
      harness.setBehaviour(async (_ctx, ids) => {
        midFlight = await harness.ledgerById();

        return allDone(ids);
      });

      await harness.sweep({ sliceSize: 10 });
    });

    afterAll(async () => {
      await harness.teardown();
    });

    it('marks claimed ids running and charges them an attempt', () => {
      expect(midFlight.size).toBe(3);

      for (const row of midFlight.values()) {
        expect(row.status).toBe('running');
        expect(row.attempts).toBe(1);
      }
    });

    it('leaves stage_version at 0 while running — the zero that makes crash recovery work', () => {
      // `claim()` deliberately does not stamp the version: a version is a claim
      // about what produced a RESULT, and a claim produces none. It is also what
      // rescues a row abandoned by a killed worker — at 0 it still satisfies
      // `stage_version < $current` and the next sweep re-selects it. If claim
      // stamped the version, that entity would be stranded forever.
      for (const row of midFlight.values()) {
        expect(row.stage_version).toBe(0);
      }

      expect(harness.stageVersion()).toBeGreaterThanOrEqual(1);
    });

    it('advances every claimed row to the current version once the slice completes', async () => {
      const rows = await harness.ledgerRows();

      expect(rows.map((row) => row.stage_version)).toEqual([1, 1, 1]);
      expect(rows.map((row) => row.status)).toEqual(['done', 'done', 'done']);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Keyset paging across a chain of hops
  // -------------------------------------------------------------------------

  describe('keyset paging over more rows than one slice', () => {
    const ROWS = 25;
    const SLICE = 4;

    let harness: PipelineHarness;
    let ids: string[];
    let report: Awaited<ReturnType<PipelineHarness['sweep']>>;

    beforeAll(async () => {
      harness = await PipelineHarness.start();
      ids = await harness.seed(ROWS);
      report = await harness.sweep({ sliceSize: SLICE });
    });

    afterAll(async () => {
      await harness.teardown();
    });

    it('needs more than one hop, because a hop enqueues at most MAX_SLICES_PER_SWEEP slices', () => {
      // 25 rows / 4 per slice = 7 slices, and a hop enqueues at most 5.
      expect(report.slices).toBe(Math.ceil(ROWS / SLICE));
      expect(report.slices).toBeGreaterThan(MAX_SLICES_PER_SWEEP);
      expect(report.hops).toBe(2);
    });

    it('dispatches every id exactly once, in keyset order', () => {
      expect(report.dispatchedIds).toHaveLength(ROWS);
      expect(new Set(report.dispatchedIds).size).toBe(ROWS);
      // Keyset, not OFFSET: pages come back in id order and the cursor is the
      // last id of the previous page, so the concatenation is the sorted set.
      expect(report.dispatchedIds).toEqual(ids);
      expect(report.sliceIds.map((slice) => slice.length)).toEqual([4, 4, 4, 4, 4, 4, 1]);
    });

    it('queues the next hop BEHIND the slices it just produced — the backpressure', () => {
      // This is the whole of the pipeline's Phase-1 backpressure: the sweep
      // rides the same queue at the same priority as its own slices, so
      // pg-boss's `ORDER BY priority DESC, created_on` means hop N+1 cannot be
      // fetched until the slices hop N enqueued have been drained. No token
      // bucket, no queue-depth poll — just ordering, which is only worth
      // anything if it is actually true.
      const history = harness.queueDouble.history();
      const firstHopSlices = history
        .filter((job) => job.name === PipelineSliceEvent)
        .slice(0, MAX_SLICES_PER_SWEEP);
      const secondHop = history.filter((job) => job.name === PipelineSweepEvent)[1];

      expect(secondHop).toBeDefined();

      for (const slice of firstHopSlices) {
        expect(slice.seq).toBeLessThan(secondHop.seq);
      }
    });

    it('sends every slice to the queue its stage declares', () => {
      for (const job of harness.queueDouble.history()) {
        expect(job.queue).toBe(PIPELINE_QUEUES.ENRICH);
      }
    });

    it('leaves the ledger covering every row exactly once', async () => {
      const rows = await harness.ledgerRows();

      expect(rows).toHaveLength(ROWS);
      expect(rows.map((row) => row.entity_id)).toEqual(ids);
      expect((await harness.coverage()).coverage).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Idempotence
  // -------------------------------------------------------------------------

  describe('idempotence: a second sweep at an unchanged version', () => {
    let harness: PipelineHarness;
    let firstPassUpdatedAt: string[];
    let second: Awaited<ReturnType<PipelineHarness['sweep']>>;

    beforeAll(async () => {
      harness = await PipelineHarness.start();
      await harness.seed(10);

      await harness.sweep({ sliceSize: 4 });

      firstPassUpdatedAt = (await harness.ledgerRows()).map((row) => row.updated_at.toISOString());

      harness.resetInvocations();
      harness.queueDouble.clearHistory();

      second = await harness.sweep({ sliceSize: 4 });
    });

    afterAll(async () => {
      await harness.teardown();
    });

    it('dispatches nothing — the converged corpus produces no candidates', () => {
      expect(second.slices).toBe(0);
      expect(second.dispatchedIds).toEqual([]);
      // One hop still runs: something has to ask the question. It finds an empty
      // page, declares the source drained and does NOT requeue itself.
      expect(second.hops).toBe(1);
      expect(harness.queueDouble.historyOf(PipelineSliceEvent)).toHaveLength(0);
      expect(harness.queueDouble.historyOf(PipelineSweepEvent)).toHaveLength(1);
    });

    it('never calls the stage', () => {
      expect(harness.invocationLog()).toEqual([]);
    });

    it('does not touch a single ledger row', async () => {
      const rows = await harness.ledgerRows();

      expect(rows).toHaveLength(10);
      // `updated_at` is stamped `now()` by every ledger write, so an identical
      // set of timestamps is proof no statement rewrote these rows — a stronger
      // claim than "the statuses still look right".
      expect(rows.map((row) => row.updated_at.toISOString())).toEqual(firstPassUpdatedAt);
    });

    it('still reports full coverage', async () => {
      expect(await harness.coverage()).toMatchObject({ total: 10, done: 10, stale: 0, coverage: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // 5. The bump
  // -------------------------------------------------------------------------

  describe('the bump: re-processing a corpus whose output column is already full', () => {
    const ROWS = 8;

    let harness: PipelineHarness;
    let ids: string[];

    beforeAll(async () => {
      harness = await PipelineHarness.start();
      ids = await harness.seed(ROWS, { width: null });

      // A real enricher: writes the output column, reports done.
      harness.setBehaviour(harness.widthWriter(1920));

      await harness.sweep({ sliceSize: ROWS });
    });

    afterAll(async () => {
      await harness.teardown();
    });

    it('leaves every source row with its output column populated', async () => {
      const rows = await harness.sourceRows();
      const applicable = rows.filter(
        (row) => row.contentType.startsWith('image/') && row.userId === harness.userId,
      );

      expect(applicable).toHaveLength(ROWS);
      // Under the predicate this rebuild deletes — `WHERE width IS NULL` — this
      // corpus is now finished FOREVER. Improving the probe could never repair
      // a single one of these rows.
      expect(applicable.every((row) => row.width === 1920)).toBe(true);
    });

    it('marks every row stale the instant the version is bumped, before any sweep runs', async () => {
      expect(await harness.coverage()).toMatchObject({ total: ROWS, done: ROWS, stale: 0 });

      const bumped = harness.bumpStageVersion();

      expect(bumped).toBe(2);

      // `stale` is "rows recorded below the current version" — i.e. exactly what
      // a bump would re-process. Being able to read this BEFORE spending the
      // work is the difference between a bump and a bill.
      expect(await harness.coverage()).toMatchObject({
        stageVersion: 2,
        total: ROWS,
        done: ROWS,
        stale: ROWS,
      });
    });

    it('re-selects every row on the next sweep, output column and all', async () => {
      harness.resetInvocations();
      harness.setBehaviour((_ctx, sliceIds) => allDone(sliceIds));

      const report = await harness.sweep({ sliceSize: ROWS });

      expect(report.dispatchedIds).toEqual(ids);
      expect(harness.processedIds()).toEqual(ids);
    });

    it('records the new version and a second attempt', async () => {
      const rows = await harness.ledgerRows();

      expect(rows).toHaveLength(ROWS);

      for (const row of rows) {
        expect(row.status).toBe('done');
        expect(row.stage_version).toBe(2);
        // `attempts` accumulates across versions: it counts starts, not starts
        // since the last bump.
        expect(row.attempts).toBe(2);
      }

      expect(await harness.coverage()).toMatchObject({ stageVersion: 2, total: ROWS, done: ROWS, stale: 0 });
    });

    it('is idempotent again at the new version', async () => {
      harness.resetInvocations();

      const report = await harness.sweep({ sliceSize: ROWS });

      expect(report.slices).toBe(0);
      expect(harness.invocationLog()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Failure: reasons, retry gates and dead letters
  // -------------------------------------------------------------------------

  describe('a stage that throws', () => {
    const ROWS = 6;

    let harness: PipelineHarness;
    let ids: string[];
    let report: Awaited<ReturnType<PipelineHarness['sweep']>>;

    beforeAll(async () => {
      harness = await PipelineHarness.start();
      ids = await harness.seed(ROWS, { withDecoys: false });

      harness.setBehaviour(() => {
        throw new Error('probe host unreachable');
      });

      report = await harness.sweep({ sliceSize: 3 });
    });

    afterAll(async () => {
      await harness.teardown();
    });

    it('propagates the failure so pg-boss’s own retry still applies', () => {
      expect(report.slices).toBe(2);
      expect(report.errors).toHaveLength(2);
      expect(report.errors[0].message).toContain('probe host unreachable');
    });

    it('fails the claimed rows in the ledger WITH a reason, instead of stranding them running', async () => {
      const rows = await harness.ledgerRows();

      expect(rows).toHaveLength(ROWS);

      for (const row of rows) {
        // Without this the rows would sit at `running` at their old version,
        // still stale, re-swept and re-run forever while reporting no failures
        // at all — a broken dependency turned into a permanent, invisible,
        // self-renewing workload.
        expect(row.status).toBe('failed');
        expect(row.reason).toContain('stage_threw:');
        expect(row.reason).toContain('probe host unreachable');
        expect(row.attempts).toBe(1);
      }
    });

    it('writes a retry gate roughly one backoff period out', async () => {
      const rows = await harness.ledgerRows();

      for (const row of rows) {
        expect(row.next_attempt_at).not.toBeNull();

        // RETRY_BACKOFF_BASE_SECONDS * 2^(attempts - 1) = 60 s at attempt 1.
        // Asserted as a window, not a value: the gate is computed by Postgres
        // from its own `now()`.
        const delayMs = (row.next_attempt_at as Date).getTime() - Date.now();

        expect(delayMs).toBeGreaterThan(30_000);
        expect(delayMs).toBeLessThan(90_000);
      }
    });

    it('keeps a replayable dead letter with the payload intact', async () => {
      const letters = await harness.deadLetters();

      expect(letters).toHaveLength(2);

      for (const letter of letters) {
        expect(letter.queue).toBe(PIPELINE_QUEUES.ENRICH);
        // payload + event_name is everything needed to re-emit, which is the
        // only reason a dead letter is worth keeping.
        expect(letter.event_name).toBe(PipelineSliceEvent);
        expect(letter.stage).toBe(harness.stageId);
        expect(letter.entity_type).toBe(harness.entityType);
        // Null on purpose: a slice covers many entities and blaming one would
        // be a guess. The ids are in the payload.
        expect(letter.entity_id).toBeNull();
        expect(letter.payload.ids).toHaveLength(3);
        expect(letter.error).toContain('probe host unreachable');
      }

      expect(letters.flatMap((letter) => letter.payload.ids as string[])).toEqual(ids);
    });

    it('does not re-select the failed rows while their gate is in the future', async () => {
      harness.resetInvocations();

      const second = await harness.sweep({ sliceSize: 3 });

      // The backoff lives in a column, not in a timer, so it survives a process
      // restart — and it is the sweep, not a scheduler, that honours it.
      expect(second.slices).toBe(0);
      expect(harness.invocationLog()).toEqual([]);
    });

    it('re-selects them once the gate is due, and clears them on the retry', async () => {
      // Standing in for the passage of a minute. Scoped to this harness's stage
      // id, so it cannot touch anything else in the ledger.
      await harness.dataSource.query(
        `UPDATE ci.pipeline_state SET next_attempt_at = now() - interval '1 minute' WHERE stage = $1`,
        [harness.stageId],
      );

      harness.resetInvocations();
      harness.setBehaviour((_ctx, sliceIds) => allDone(sliceIds));

      const retry = await harness.sweep({ sliceSize: 3 });

      expect(retry.dispatchedIds).toEqual(ids);

      const rows = await harness.ledgerRows();

      for (const row of rows) {
        expect(row.status).toBe('done');
        expect(row.reason).toBeNull();
        expect(row.attempts).toBe(2);
        expect(row.next_attempt_at).toBeNull();
      }

      expect(await harness.coverage()).toMatchObject({ total: ROWS, done: ROWS, failed: 0, coverage: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // 7. Outcomes, reasons and the silence that used to pass for success
  // -------------------------------------------------------------------------

  describe('outcomes and reasons', () => {
    let harness: PipelineHarness;
    let ids: string[];

    beforeAll(async () => {
      harness = await PipelineHarness.start();
      ids = await harness.seed(9, { withDecoys: false });
    });

    afterAll(async () => {
      await harness.teardown();
    });

    it('persists a reason for every non-done outcome and buckets them into coverage', async () => {
      harness.setBehaviour(
        (_ctx, sliceIds) =>
          new Map<string, StageResult>(
            sliceIds.map((id, index): [string, StageResult] => {
              if (index % 3 === 0) {
                return [id, { outcome: 'done' }];
              }

              if (index % 3 === 1) {
                // A stable, greppable token — not a sentence. This is what
                // `GET /api/pipeline/state` groups on and what selects rows for
                // replay.
                return [id, { outcome: 'skipped', reason: 'unsupported_codec' }];
              }

              return [id, { outcome: 'failed', reason: 'probe_failed' }];
            }),
          ),
      );

      await harness.sweep({ sliceSize: 9 });

      const rows = await harness.ledgerRows();
      const byStatus = new Map(rows.map((row) => [row.entity_id, row]));

      expect(rows).toHaveLength(9);
      expect(rows.filter((row) => row.status === 'done')).toHaveLength(3);
      expect(rows.filter((row) => row.status === 'skipped')).toHaveLength(3);
      expect(rows.filter((row) => row.status === 'failed')).toHaveLength(3);

      expect(byStatus.get(ids[1])?.reason).toBe('unsupported_codec');
      expect(byStatus.get(ids[2])?.reason).toBe('probe_failed');
      // A skip is terminal and needs no gate; a failure gets one.
      expect(byStatus.get(ids[1])?.next_attempt_at).toBeNull();
      expect(byStatus.get(ids[2])?.next_attempt_at).not.toBeNull();

      const coverage = await harness.coverage();

      // `skipped` counts as COVERED: the stage looked at the row and decided.
      // That is the distinction the old nullability predicates could not make —
      // "tried and legitimately produced nothing" was indistinguishable from
      // "never tried", so an unreadable file was re-fetched and re-decoded on
      // every run, forever.
      expect(coverage).toMatchObject({ total: 9, done: 3, skipped: 3, failed: 3 });
      expect(coverage.coverage).toBeCloseTo(6 / 9, 10);
    });

    it('records an id the stage said nothing about as a failure, never as success', async () => {
      const quiet = await PipelineHarness.start();

      try {
        const quietIds = await quiet.seed(4, { withDecoys: false });

        // The structural replacement for `catch { log; continue }`: a stage that
        // quietly drops half its input must not report full coverage.
        quiet.setBehaviour((_ctx, sliceIds) => new Map([[sliceIds[0], { outcome: 'done' }]]));

        await quiet.sweep({ sliceSize: 4 });

        const rows = await quiet.ledgerById();

        expect(rows.get(quietIds[0])?.status).toBe('done');

        for (const id of quietIds.slice(1)) {
          const row = rows.get(id);

          expect(row?.status).toBe('failed');
          expect(row?.reason).toBe('stage_returned_no_result');
        }

        expect((await quiet.coverage()).coverage).toBeCloseTo(1 / 4, 10);
      } finally {
        await quiet.teardown();
      }
    });

    it('refuses a skip with no reason, before anything is written', async () => {
      const nameless = await PipelineHarness.start();

      try {
        await nameless.seed(2, { withDecoys: false });

        nameless.setBehaviour(
          (_ctx, sliceIds) =>
            // No reason. A stage that cannot say why it skipped a row has not
            // skipped it, it has lost it.
            new Map(sliceIds.map((id) => [id, { outcome: 'skipped' as const }])),
        );

        const report = await nameless.sweep({ sliceSize: 2 });

        expect(report.errors).toHaveLength(1);
        expect(report.errors[0].message).toContain('with no reason');

        // The contract is enforced BEFORE the upsert, so the slice fails whole
        // rather than half-persisting. What lands is the honest record: failed,
        // with the enforcement message as the reason.
        const rows = await nameless.ledgerRows();

        expect(rows).toHaveLength(2);

        for (const row of rows) {
          expect(row.status).toBe('failed');
          expect(row.reason).toContain('stage_threw:');
          expect(row.reason).toContain('reason is REQUIRED');
        }
      } finally {
        await nameless.teardown();
      }
    });
  });
});
