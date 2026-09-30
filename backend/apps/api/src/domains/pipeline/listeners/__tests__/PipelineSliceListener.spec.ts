import { PipelineSliceListener } from '../PipelineSliceListener';

/**
 * THE generic worker: one class executes every stage that will ever exist.
 *
 * A slice arrives off a pg-boss queue carrying `{ stage, entityType, userId,
 * ids }` — the candidate sweep (THE ONE RULE) and the keyset cursor live in the
 * dispatcher, not here. What this listener owns is the part every one of the
 * fourteen hand-written enrichment legs got wrong in its own way:
 *
 *  1. **claim** the ids, and work only the subset actually claimed — two
 *     overlapping sweeps must not run the same entity twice;
 *  2. **run** the stage over exactly those ids;
 *  3. **record an outcome for every claimed id**. Silence is never success. An
 *     id the stage said nothing about must not stay `running` (it would be
 *     re-swept, re-run and forgotten forever, reporting no failures) and must
 *     never be recorded `done`. This is the structural replacement for the ~30
 *     `catch { log; continue }` blocks;
 *  4. **on a throw**, leave the ledger and the dead-letter table telling the
 *     truth, and let the error propagate so pg-boss's retry still applies.
 *
 * Stages never touch pg-boss, never write the ledger, and never see a cursor.
 *
 * ## Wiring
 *
 * Written alongside the implementation, so it depends on neither the
 * constructor's parameter ORDER nor the handler's exact name: the listener is
 * constructed, then has its collaborators assigned under every plausible field
 * name, and the handler is located on the prototype. Only `makeListener` knows
 * any of that.
 */

const USER = '00000000-0000-4000-8000-00000000aaaa';
const STAGE_ID = 'enrich.media_dimensions';
const ENTITY_TYPE = 'file';
const QUEUE = 'pipeline-enrich';

function srcId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface StageResultLike {
  outcome: 'done' | 'skipped' | 'failed';
  reason?: string;
  detail?: Record<string, unknown>;
}

function makeStage() {
  return {
    id: STAGE_ID,
    version: 1,
    queue: QUEUE,
    entityTypes: [ENTITY_TYPE],
    source: {
      schema: 'ci',
      table: 'files',
      idColumn: 'id',
      userColumn: 'user_id',
      predicate: "s.content_type LIKE 'image/%'",
    },
    run: jest.fn(
      async (_ctx: unknown, ids: string[]) =>
        new Map<string, StageResultLike>(ids.map((id) => [id, { outcome: 'done' as const }])),
    ),
  };
}

interface HarnessOptions {
  /** Ids the claim actually wins. Defaults to everything the payload asked for. */
  claims?: (ids: string[]) => string[];
  /** Resolve the stage id to nothing, as an unregistered stage would. */
  unknownStage?: boolean;
  /** Present the stage as a different one — its id is what `STAGE_REOPENS` is keyed on. */
  stage?: { id: string; queue: string; entityTypes: string[] };
  /** How `reopen()` answers. Defaults to "every id asked about moved". */
  reopen?: (entityType: string, stageId: string, ids: string[]) => Promise<number>;
}

function makeListener(options: HarnessOptions = {}) {
  const stage = { ...makeStage(), ...options.stage };
  const claimsOf = options.claims ?? ((ids: string[]) => ids);
  const reopenImpl = options.reopen ?? (async (_type: string, _stage: string, ids: string[]) => ids.length);

  /** Every ledger call in order — the slice protocol, as observed. */
  const ledgerCalls: Array<{ method: string; args: unknown[] }> = [];
  const noWrites = { done: 0, skipped: 0, failed: 0, quarantined: 0 };

  // Parameters are spelled out (and recorded) so `mock.calls` is a typed tuple
  // the assertions can destructure — the ledger contract, restated.
  const stateService = {
    setContext: jest.fn(),
    selectStale: jest.fn(async () => [] as string[]),
    claim: jest.fn(async (stage: unknown, entityType: string, ids: string[], userId: string | null) => {
      ledgerCalls.push({ method: 'claim', args: [stage, entityType, ids, userId] });

      return claimsOf(ids);
    }),
    complete: jest.fn(async (stage: unknown, entityType: string, results: Map<string, StageResultLike>) => {
      ledgerCalls.push({ method: 'complete', args: [stage, entityType, results] });

      return noWrites;
    }),
    fail: jest.fn(
      async (stage: unknown, entityType: string, ids: string[], reason: string, backoff?: unknown) => {
        ledgerCalls.push({ method: 'fail', args: [stage, entityType, ids, reason, backoff] });

        return noWrites;
      },
    ),
    recordDeadLetter: jest.fn(async (entry: Record<string, unknown>) => {
      ledgerCalls.push({ method: 'recordDeadLetter', args: [entry] });
    }),
    reopen: jest.fn(async (entityType: string, stageId: string, ids: string[]) => {
      ledgerCalls.push({ method: 'reopen', args: [entityType, stageId, ids] });

      return reopenImpl(entityType, stageId, ids);
    }),
    coverage: jest.fn(async () => ({ done: 0, skipped: 0, failed: 0, pending: 0 })),
  };

  const registry = {
    setContext: jest.fn(),
    // The real registry THROWS for an unknown id rather than returning null: a
    // slice that cannot resolve its stage must be loud enough to dead-letter,
    // because "successfully processed nothing" is indistinguishable from work.
    get: jest.fn((stageId: string) => {
      if (options.unknownStage) {
        throw new Error(`Unknown pipeline stage "${stageId}".`);
      }

      return stage;
    }),
    has: jest.fn(() => !options.unknownStage),
    stageIds: jest.fn(() => (options.unknownStage ? [] : [STAGE_ID])),
  };

  const events = {
    setContext: jest.fn(),
    send: jest.fn(async () => ['job-1']),
    sendMany: jest.fn(async () => undefined),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  let listener: object;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener = new (PipelineSliceListener as any)(registry, stateService, logger, events);
  } catch {
    listener = Object.create(PipelineSliceListener.prototype) as object;
  }

  Object.assign(listener, {
    stageRegistry: registry,
    registry,
    stages: registry,
    stateService,
    pipelineStateService: stateService,
    pipelineState: stateService,
    state: stateService,
    eventService: events,
    events,
    logger,
  });

  /**
   * The slice entry point. Prefers the shared `handleSlice` over the per-queue
   * `@OnEvent` wrappers, and supplies the queue when the method takes one.
   */
  function handle(payload: unknown, queue: string = QUEUE): Promise<unknown> {
    const proto = Object.getPrototypeOf(listener) as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== 'constructor' && typeof proto[name] === 'function',
    );
    const name =
      names.find((n) => n === 'handleSlice') ??
      names.find((n) => /slice/i.test(n)) ??
      names.find((n) => /handle|process|consume|work/i.test(n));

    if (name === undefined) {
      throw new Error('PipelineSliceListener exposes no handler method');
    }

    const fn = proto[name] as (...args: unknown[]) => Promise<unknown>;

    return fn.length >= 2 ? fn.call(listener, queue, payload) : fn.call(listener, payload);
  }

  /** Everything the stage was asked to record, merged in call order. */
  function committed(): Map<string, StageResultLike> {
    const all = new Map<string, StageResultLike>();
    for (const [, , results] of stateService.complete.mock.calls) {
      for (const [id, result] of results) {
        all.set(id, result);
      }
    }

    return all;
  }

  /** Dead letters written through whichever recorder the listener uses. */
  function deadLetters(): Array<Record<string, unknown>> {
    return stateService.recordDeadLetter.mock.calls.map(([entry]) => entry);
  }

  return {
    listener,
    handle,
    stage,
    stateService,
    registry,
    events,
    logger,
    committed,
    deadLetters,
    ledgerCalls,
  };
}

function payloadFor(ids: string[] = [srcId(1), srcId(2)]) {
  return { stage: STAGE_ID, entityType: ENTITY_TYPE, userId: USER, ids };
}

describe('PipelineSliceListener', () => {
  it('claims, runs the stage, then commits — in that order', async () => {
    const h = makeListener();

    await h.handle(payloadFor());

    const order = [
      h.stateService.claim.mock.invocationCallOrder[0],
      h.stage.run.mock.invocationCallOrder[0],
      h.stateService.complete.mock.invocationCallOrder[0],
    ];
    expect(order.every((n) => typeof n === 'number')).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('claims the slice ids under the payload entity type and user', async () => {
    const h = makeListener();

    await h.handle(payloadFor([srcId(1), srcId(2)]));

    const [stage, entityType, ids, userId] = h.stateService.claim.mock.calls[0];
    expect(stage).toBe(h.stage);
    expect(entityType).toBe(ENTITY_TYPE);
    expect(ids).toEqual([srcId(1), srcId(2)]);
    expect(userId).toBe(USER);
  });

  it('runs only what it actually claimed, not what it was asked for', async () => {
    // The other worker owns the ids this one lost, including their outcome.
    // Running them anyway is duplicated work at best and a clobbered ledger row
    // at worst.
    const h = makeListener({ claims: (ids) => ids.slice(0, 1) });

    await h.handle(payloadFor([srcId(1), srcId(2), srcId(3)]));

    const [ctx, ids] = h.stage.run.mock.calls[0];
    expect(ctx).toEqual(expect.objectContaining({ userId: USER }));
    expect(ids).toEqual([srcId(1)]);
  });

  it('does nothing when the whole slice is already claimed elsewhere', async () => {
    const h = makeListener({ claims: () => [] });

    await h.handle(payloadFor());

    expect(h.stage.run).not.toHaveBeenCalled();
    expect(h.stateService.complete).not.toHaveBeenCalled();
  });

  it('commits exactly what the stage returned for the ids it answered', async () => {
    const h = makeListener();
    h.stage.run.mockResolvedValueOnce(
      new Map<string, StageResultLike>([
        [srcId(1), { outcome: 'done' }],
        [srcId(2), { outcome: 'skipped', reason: 'unsupported_codec' }],
      ]),
    );

    await h.handle(payloadFor());

    const [stage, entityType] = h.stateService.complete.mock.calls[0];
    expect(stage).toBe(h.stage);
    expect(entityType).toBe(ENTITY_TYPE);
    expect(h.committed().get(srcId(1))).toEqual({ outcome: 'done' });
    expect(h.committed().get(srcId(2))).toEqual(
      expect.objectContaining({ outcome: 'skipped', reason: 'unsupported_codec' }),
    );
  });

  it('records an outcome for EVERY claimed id — silence is never success', async () => {
    // An id left with no outcome stays `running`, gets re-swept once its claim
    // lease lapses, is re-run, and is forgotten again: an infinite retry loop
    // that reports zero failures. That is the shape of the bug this listener
    // exists to make impossible.
    const h = makeListener();
    h.stage.run.mockResolvedValueOnce(new Map<string, StageResultLike>([[srcId(1), { outcome: 'done' }]]));

    await h.handle(payloadFor([srcId(1), srcId(2)]));

    const committed = h.committed();
    expect(committed.has(srcId(2))).toBe(true);
    expect(committed.get(srcId(2))?.outcome).not.toBe('done');
    // Whatever it is recorded as, it is skipped-or-failed, so the contract
    // requires a reason a human can act on.
    expect(committed.get(srcId(2))?.reason).toEqual(expect.any(String));
    expect(committed.get(srcId(2))?.reason).not.toBe('');
  });

  it('ignores results for ids it never claimed', async () => {
    // Writing them would overwrite a ledger row another worker legitimately
    // owns — the same row its own claim is protecting.
    const h = makeListener({ claims: (ids) => ids.slice(0, 1) });
    h.stage.run.mockResolvedValueOnce(
      new Map<string, StageResultLike>([
        [srcId(1), { outcome: 'done' }],
        [srcId(2), { outcome: 'done' }],
      ]),
    );

    await h.handle(payloadFor([srcId(1), srcId(2)]));

    expect(h.committed().has(srcId(2))).toBe(false);
  });

  describe('when the stage throws', () => {
    it('marks the claimed ids failed, with the error as the reason', async () => {
      // The slice-level counterpart of a per-entity `failed` result. Without it
      // every claimed row stays `running` at its old version: re-swept, re-run
      // and re-thrown forever, never reaching the attempt budget that would
      // quarantine it, because only complete()/fail() can quarantine.
      const h = makeListener();
      h.stage.run.mockRejectedValueOnce(new Error('ollama unreachable'));

      await h.handle(payloadFor()).catch(() => undefined);

      expect(h.stateService.fail).toHaveBeenCalled();
      const [stage, entityType, ids, reason] = h.stateService.fail.mock.calls[0];
      expect(stage).toBe(h.stage);
      expect(entityType).toBe(ENTITY_TYPE);
      expect(ids).toEqual([srcId(1), srcId(2)]);
      expect(String(reason)).toContain('ollama unreachable');
    });

    it('never records any of them as done', async () => {
      const h = makeListener();
      h.stage.run.mockRejectedValueOnce(new Error('boom'));

      await h.handle(payloadFor()).catch(() => undefined);

      for (const [, result] of h.committed()) {
        expect(result.outcome).not.toBe('done');
      }
    });

    it('writes a replayable dead letter carrying the payload verbatim', async () => {
      const h = makeListener();
      h.stage.run.mockRejectedValueOnce(new Error('ollama unreachable'));

      await h.handle(payloadFor()).catch(() => undefined);

      const letters = h.deadLetters();
      expect(letters).toHaveLength(1);
      expect(letters[0]).toEqual(
        expect.objectContaining({
          queue: QUEUE,
          stage: STAGE_ID,
          entityType: ENTITY_TYPE,
          payload: expect.objectContaining({ ids: [srcId(1), srcId(2)], userId: USER }),
        }),
      );
      expect(String(letters[0].error)).toContain('ollama unreachable');
    });

    it('propagates the error so pg-boss retry and dead-lettering still apply', async () => {
      const h = makeListener();
      h.stage.run.mockRejectedValueOnce(new Error('ollama unreachable'));

      await expect(h.handle(payloadFor())).rejects.toThrow('ollama unreachable');
    });
  });

  it('refuses an unregistered stage id loudly instead of completing successfully', async () => {
    const h = makeListener({ unknownStage: true });

    let rejected = false;
    await h.handle(payloadFor()).catch(() => {
      rejected = true;
    });

    expect(h.stateService.claim).not.toHaveBeenCalled();
    expect(h.stage.run).not.toHaveBeenCalled();
    expect(rejected).toBe(true);
  });

  it('rejects a payload that is not a slice, without touching the ledger', async () => {
    // The payload came out of `pgboss.job.data`: untrusted JSON, not a typed
    // object. A malformed one must not reach a claim.
    const h = makeListener();

    await expect(h.handle({ stage: STAGE_ID, userId: 'not-a-uuid' })).rejects.toThrow();
    expect(h.stateService.claim).not.toHaveBeenCalled();
    expect(h.stage.run).not.toHaveBeenCalled();
  });
});

/**
 * `STAGE_REOPENS`: a producer's `done` re-opens the consumer's decision on the
 * same row. The stage never does it — it reports `done`, as always — so the
 * listener is where the rule lives, and where it is tested without a database.
 * `stages/__tests__/PlaceLinkReopensEdgeEvent.integration.spec.ts` runs the same
 * slice protocol against real Postgres.
 */
describe('PipelineSliceListener — re-opening what a producer made stale', () => {
  const PROMOTE_PLACE = { id: 'promote.place', queue: 'pipeline-index', entityTypes: ['event'] };

  function placeSlice(ids: string[]) {
    return { stage: PROMOTE_PLACE.id, entityType: 'event', userId: USER, ids };
  }

  function sliceLog(h: ReturnType<typeof makeListener>): Record<string, unknown> | undefined {
    const call = h.logger.log.mock.calls.find(([message]) => message === 'Processed pipeline slice');

    return call?.[1] as Record<string, unknown> | undefined;
  }

  it('re-opens promote.edge_event for exactly the events promote.place recorded done', async () => {
    const h = makeListener({ stage: PROMOTE_PLACE });
    h.stage.run.mockResolvedValueOnce(
      new Map<string, StageResultLike>([
        [srcId(1), { outcome: 'done', detail: { placeEntityId: srcId(90) } }],
        // Another writer's link: this stage wrote nothing, so it re-opens nothing.
        [srcId(2), { outcome: 'skipped', reason: 'place_link_not_owned' }],
        // Retried on its own gate, and re-opens the day it succeeds.
        [srcId(3), { outcome: 'failed', reason: 'place_resolve_failed' }],
        [srcId(4), { outcome: 'done', detail: { placeEntityId: srcId(90) } }],
      ]),
    );

    await h.handle(placeSlice([srcId(1), srcId(2), srcId(3), srcId(4)]), PROMOTE_PLACE.queue);

    // Same entity type as the slice, the consumer's stage id, the done ids only.
    expect(h.stateService.reopen.mock.calls).toEqual([['event', 'promote.edge_event', [srcId(1), srcId(4)]]]);
    expect(sliceLog(h)).toEqual(expect.objectContaining({ reopened: 2, stage: 'promote.place' }));
  });

  it('re-opens BEFORE recording the producer, so no moment exists where it is done and the consumer untold', async () => {
    const h = makeListener({ stage: PROMOTE_PLACE });

    await h.handle(placeSlice([srcId(1)]), PROMOTE_PLACE.queue);

    expect(h.ledgerCalls.map((call) => call.method)).toEqual(['claim', 'reopen', 'complete']);
  });

  it('fails the slice rather than recording it done when the re-open throws', async () => {
    // The link is already written; what is lost if this is swallowed is the
    // only signal the edge leg would ever get. Failing the claimed rows puts
    // the producer back on its retry gate, and the retry re-opens again.
    const h = makeListener({
      stage: PROMOTE_PLACE,
      reopen: async () => {
        throw new Error('ledger unavailable');
      },
    });

    await expect(h.handle(placeSlice([srcId(1), srcId(2)]), PROMOTE_PLACE.queue)).rejects.toThrow(
      'ledger unavailable',
    );

    expect(h.stateService.complete).not.toHaveBeenCalled();
    const [, entityType, ids, reason] = h.stateService.fail.mock.calls[0];
    expect(entityType).toBe('event');
    expect(ids).toEqual([srcId(1), srcId(2)]);
    expect(String(reason)).toContain('ledger unavailable');
  });

  it('touches no other ledger when the producer recorded nothing done', async () => {
    const h = makeListener({ stage: PROMOTE_PLACE });
    h.stage.run.mockResolvedValueOnce(
      new Map<string, StageResultLike>([[srcId(1), { outcome: 'skipped', reason: 'no_location_name' }]]),
    );

    await h.handle(placeSlice([srcId(1)]), PROMOTE_PLACE.queue);

    expect(h.stateService.reopen).not.toHaveBeenCalled();
    expect(sliceLog(h)).toEqual(expect.objectContaining({ reopened: 0 }));
  });

  it('never re-opens anything for a stage that declares no consumer', async () => {
    const h = makeListener();

    await h.handle(payloadFor());

    expect(h.stateService.reopen).not.toHaveBeenCalled();
    // And its log line is exactly what it was before re-opens existed.
    expect(sliceLog(h)).not.toHaveProperty('reopened');
  });
});
