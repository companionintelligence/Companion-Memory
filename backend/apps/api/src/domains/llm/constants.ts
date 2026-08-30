import type { QueueOptions } from '@ci/domains/events';

/**
 * Serial LLM work: chat turns, thread titles, and answer inference share this
 * queue so they cannot stampede a 1–2 slot local GPU. `localConcurrency: 1`
 * is the point — chat jobs jump the line via INTERACTIVE_JOB_PRIORITY, then
 * titles/inference run when the slot is free.
 *
 * `policy: 'short'` is what makes the singletonKeys its senders rely on
 * (`chat-generate:${threadId}`, `chat-summarize:${threadId}`,
 * `infer:${userId}:${questionId}`) actually refuse a duplicate — pg-boss's
 * default `standard` policy stores a singletonKey but never enforces it. It
 * is queue-wide, so every send on this queue must carry a key or it
 * collapses with every other keyless send under `COALESCE(singleton_key,'')`.
 */
export const LLM_QUEUE = 'llm';

export const LLM_QUEUE_OPTIONS: QueueOptions = {
  policy: 'short',
  localConcurrency: 1,
  expireInSeconds: 900,
  retryLimit: 3,
  retryDelay: 10,
};

/**
 * Ollama vision passes share the same 1–2 slot local-GPU discipline as
 * LLM_QUEUE, and `policy: 'short'` is what makes the singletonKey its senders
 * carry (`image-description:${previewId}`) actually refuse a duplicate —
 * pg-boss's default `standard` policy stores a singletonKey but never
 * enforces it. The policy is only safe here because BOTH senders of
 * `preview.generated` — FilePreviewGenerationListener (live) and
 * ImageDescriptionBackfillListener (re-drive) — key on the preview id, and
 * that event has no other registered queue.
 */
export const IMAGE_DESCRIPTION_QUEUE = 'image-description';

export const IMAGE_DESCRIPTION_QUEUE_OPTIONS: QueueOptions = {
  policy: 'short',
  localConcurrency: 1,
};

/**
 * Same 1-slot local-GPU discipline, but deliberately NO `policy: 'short'`.
 * This queue's only event is `file.uploaded`, whose sole producer
 * (`FileService.uploadWithDedupInfo`) sends without a singletonKey — and it
 * cannot grow one, because `file.uploaded` fans out to five queues under one
 * shared set of send options. Under `short`, every keyless job collapses into
 * one row via `COALESCE(singleton_key,'')` and pg-boss's `ON CONFLICT DO
 * NOTHING` discards the rest silently: concurrent uploads would lose their
 * vision pass with no error and no dead letter.
 */
export const THING_VISION_QUEUE = 'thing-vision';

export const THING_VISION_QUEUE_OPTIONS: QueueOptions = {
  localConcurrency: 1,
};

/**
 * Same 1-slot local-GPU discipline, and deliberately NO `policy: 'short'` —
 * same reasoning as THING_VISION_QUEUE. This queue's only event is
 * `browseractivity.created`, whose sole producer (`BrowserActivityService.create`)
 * sends without a singletonKey, and that event already fans out to the
 * `search-index` queue under the same keyless send. Under `short`, every
 * keyless job collapses into one row and every page visit but the first
 * would lose its insight pass silently.
 */
export const BROWSER_ACTIVITY_INSIGHT_QUEUE = 'browser-activity-insight';

export const BROWSER_ACTIVITY_INSIGHT_QUEUE_OPTIONS: QueueOptions = {
  localConcurrency: 1,
};

export type ThreadGenerationStatus = 'idle' | 'queued' | 'running' | 'failed';

export const GENERATION_STATUSES = ['idle', 'queued', 'running', 'failed'] as const;

export function isActiveGenerationStatus(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}
