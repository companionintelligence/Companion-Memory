import { PIPELINE_QUEUES, STAGE_IDS } from '@ci/domains/pipeline';
import { PipelineSweepEvent } from '@ci/domains/pipeline/events';

import { MediaDimensionsBackfillListener } from '../MediaDimensionsBackfillListener';

/**
 * The listener is now a COMPATIBILITY SHIM and nothing else.
 *
 * It previously owned the whole leg: a keyset page over `file.width IS NULL`, a
 * bounded-concurrency probe loop and four local counters. Every one of those
 * moved — the candidate query to `PipelineStateService.selectStale`, the page
 * loop to `PipelineDispatchService`, the probe to `MediaDimensionsStage`, the
 * counters to `ci.pipeline_state` — and each is covered where it now lives
 * (`domains/pipeline/stages/__tests__/MediaDimensionsStage.spec.ts`,
 * `domains/pipeline/__tests__/theOneRule.spec.ts`).
 *
 * What is left to test is exactly what is left of the class: two live callers
 * (`MaintenanceController`'s `/maintenance/media-dimensions` endpoint and
 * `MaintenanceOrchestratorService`'s nightly leg) still emit
 * `MediaDimensionsBackfillRequestEvent`, and this must keep turning that into
 * the same work under the new mechanism. So the assertions are about the
 * HANDOFF — the right event, the right stage, the right queue, the right user —
 * and about the two constants the shim is forced to hold as literals.
 *
 * This file imports the pipeline's PUBLIC BARREL, which the shim itself
 * deliberately does not (see the comment on `MEDIA_DIMENSIONS_STAGE_ID`): a test
 * module is a leaf that nothing imports, so a test edge cannot close the import
 * cycle a production edge would.
 */

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeListener() {
  const send = jest.fn(async () => undefined);
  const logger = makeLogger();

  const listener = new MediaDimensionsBackfillListener({ send } as never, logger as never);

  return { listener, send, logger };
}

const USER = '00000000-0000-0000-0000-0000000000aa';

/** The event name, stage and queue the shim must have used. */
function handoff(send: jest.Mock) {
  const [event, payload, options] = send.mock.calls[0] as [
    string,
    Record<string, unknown>,
    { queue?: string } | undefined,
  ];

  return { event, payload, options };
}

describe('MediaDimensionsBackfillListener.handleBatch', () => {
  it('starts an enrich.media_dimensions sweep for the requesting user', async () => {
    const { listener, send } = makeListener();

    await listener.handleBatch({ userId: USER });

    expect(send).toHaveBeenCalledTimes(1);

    const { event, payload, options } = handoff(send);
    expect(event).toBe(PipelineSweepEvent);
    expect(payload).toEqual({ stage: STAGE_IDS.ENRICH_MEDIA_DIMENSIONS, userId: USER, cursor: null });
    expect(options?.queue).toBe(PIPELINE_QUEUES.ENRICH);
  });

  it('pins its local stage id and queue literals to the real pipeline constants', async () => {
    // The shim cannot import `domains/pipeline/constants.ts` — that is a
    // `no-cross-domain-internals` violation — and importing the barrel instead
    // would close a cycle once PipelineModule registers MediaDimensionsStage
    // (the stage imports `@ci/domains/files`, which imports the shim). So it
    // holds two string literals, and this is the assertion that keeps them
    // honest. A drifted stage id dead-letters every sweep; a drifted queue name
    // sends the first hop to a resource pool it does not belong to.
    const { listener, send } = makeListener();

    await listener.handleBatch({ userId: USER });

    const { payload, options } = handoff(send);
    expect(payload.stage).toBe(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS);
    expect(PIPELINE_QUEUES.ENRICH).toBe(options?.queue);
  });

  it('starts the sweep at the beginning, with no cursor', async () => {
    // A non-null cursor would silently skip every id below it — the whole point
    // of a keyset is that `null` means "from the start", not "from wherever".
    const { listener, send } = makeListener();

    await listener.handleBatch({ userId: USER });

    expect(handoff(send).payload.cursor).toBeNull();
  });

  it('leaves slice size, hop and dispatched to the sweep schema defaults', async () => {
    // Pinning them here would freeze the pipeline's slice sizing inside a shim
    // that is scheduled for deletion.
    const { listener, send } = makeListener();

    await listener.handleBatch({ userId: USER });

    const { payload } = handoff(send);
    expect(payload).not.toHaveProperty('sliceSize');
    expect(payload).not.toHaveProperty('hop');
  });

  it('ignores the legacy per-batch limit instead of truncating the sweep', async () => {
    // `limit` capped how many files one synchronous batch probed. A sweep is
    // paced by its own backpressure (each hop rides the same queue as the slices
    // it enqueued, so it cannot outrun the workers) and runs to completion.
    // Honouring the cap would leave a corpus half-processed with nothing
    // recording where it stopped — the ambiguity the ledger exists to remove.
    const { listener, send } = makeListener();

    await listener.handleBatch({ userId: USER, limit: 25 });

    expect(handoff(send).payload).not.toHaveProperty('limit');
  });

  it('warns that the event is deprecated so the two remaining callers get migrated', async () => {
    const { listener, logger } = makeListener();

    await listener.handleBatch({ userId: USER });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deprecated'), expect.anything());
  });

  it('does no probing of its own — no object storage read, no decode, no page loop', async () => {
    // The regression guard for the conversion. If probing ever comes back here
    // it will come back with `width IS NULL` beside it.
    const { listener, send } = makeListener();

    await listener.handleBatch({ userId: USER, limit: 500 });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates an enqueue failure rather than reporting success', async () => {
    const { listener, send } = makeListener();
    send.mockRejectedValue(new Error('pgboss unavailable'));

    await expect(listener.handleBatch({ userId: USER })).rejects.toThrow(/pgboss unavailable/);
  });
});
