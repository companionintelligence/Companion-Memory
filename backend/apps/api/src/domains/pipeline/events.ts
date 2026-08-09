import { defineEvent } from '@ci/domains/events';

import type { PipelineDeadLetterReapPayload, PipelineSlicePayload, PipelineSweepPayload } from './types';

/**
 * The pipeline's entire event surface: three events.
 *
 * That is the point. The bus today carries ~40 hand-written event names, each
 * with its own listener, its own batching, its own cursor and its own retry
 * behaviour, and adding an enricher means adding another one. Here, a new
 * stage adds NO events — it adds a row to `STAGE_VERSIONS` and a row to
 * `STAGE_REGISTRY`, and rides the same three. `pipeline.slice` is generic over
 * the stage id, so one worker serves every stage that will ever exist.
 */

/**
 * A bounded set of entity ids for one stage. Consumed by
 * {@link PipelineSliceListener}, the single generic worker.
 */
export const PipelineSliceEvent = 'pipeline.slice';

/**
 * One hop of a keyset sweep for candidates. Consumed by
 * {@link PipelineDispatchService}, which re-emits it with an advanced cursor
 * until the sweep runs dry — so a full-corpus sweep is a chain of durable jobs
 * rather than a loop inside a request that dies with the connection.
 */
export const PipelineSweepEvent = 'pipeline.sweep';

/**
 * Ad-hoc request to drain pg-boss's dead-letter queue into
 * `ci.pipeline_dead_letters`. The reaper also runs on a cron; this exists so an
 * operator (or a test) can force a reap and read the table immediately instead
 * of waiting out the interval.
 */
export const PipelineDeadLetterReapEvent = 'pipeline.dead_letter.reap';

defineEvent<PipelineSlicePayload>(PipelineSliceEvent);
defineEvent<PipelineSweepPayload>(PipelineSweepEvent);
defineEvent<PipelineDeadLetterReapPayload>(PipelineDeadLetterReapEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [PipelineSliceEvent]: PipelineSlicePayload;
    [PipelineSweepEvent]: PipelineSweepPayload;
    [PipelineDeadLetterReapEvent]: PipelineDeadLetterReapPayload;
  }
}
