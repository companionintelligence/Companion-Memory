import type { QueueOptions } from '@ci/domains/events';

/**
 * The yield gate background GPU queues name (`queueOptions.yieldsTo`). It
 * closes while any thread has a chat turn queued or running, so a queue that
 * names it stops taking new jobs until the person has their answer. Registered
 * by {@link InteractiveChatYieldGate} at boot; the events domain only knows
 * the name.
 */
export const INTERACTIVE_CHAT_YIELD_GATE = 'interactive-chat';

/**
 * The lane (`queueOptions.lane`) every Ollama-bound BACKGROUND queue shares.
 * Four queues each declaring `localConcurrency: 1` would otherwise put four
 * generations in front of a single-slot runner at once — costing nothing at
 * Ollama, but deepening the line every request waits in, which is exactly
 * what `llm.firstResponseTimeoutMs` measures. One lane, one slot: at most one
 * background generation from this process is at the runner at a time, while
 * each queue keeps its own backlog and policy. The interactive `llm` queue is
 * deliberately NOT on it — chat must never wait behind a background job.
 */
export const OLLAMA_BACKGROUND_LANE = 'ollama-background';

/**
 * The INTERACTIVE model queue: one chat turn at a time, and nothing else.
 *
 * Thread titles and answer inference used to share this slot, on the theory
 * that `INTERACTIVE_JOB_PRIORITY` would let chat jump the line. Priority only
 * reorders the WAITING line — it cannot preempt a running job — so a hung
 * background inference held the slot for its full 900 s expiry while a
 * person's question sat behind it (measured 2026-09-11: nine minutes of
 * waiting before the chat turn even reached the model). Background work now
 * lives on {@link LLM_BACKGROUND_QUEUE}; the GPU-level contention between the
 * two is handled by that queue's yield gate, not by sharing a slot.
 *
 * `expireInSeconds: 900` is the crash backstop — the longest a turn may sit
 * `active` before pg-boss assumes the process died and retries it. It is not
 * the operating timeout: each request inside a turn is bounded by
 * `llm.firstResponseTimeoutMs` (see `firstResponseDeadline.ts`), so a request
 * the backend never answers fails in seconds, not in fifteen minutes.
 *
 * `policy: 'short'` is what makes the singletonKey its sender relies on
 * (`chat-generate:${threadId}`) actually refuse a duplicate — pg-boss's
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
 * The BACKGROUND model queue: thread titles and answer inference — work whose
 * output is parsed or filed, never watched. One slot, like {@link LLM_QUEUE},
 * so it cannot stampede the GPU either; and it stands aside for
 * {@link INTERACTIVE_CHAT_YIELD_GATE}, so a queued title or inference never
 * starts while a person is waiting on the model.
 *
 * `policy: 'short'` for the same reason as the interactive queue: the keys its
 * senders carry (`chat-summarize:${threadId}`, `infer:${userId}:${questionId}`)
 * are only enforced under it, and every send here must carry one.
 *
 * `expireInSeconds` is shorter than chat's: a title is one bounded call and an
 * inference is embed + query + one bounded generation, so ten minutes is
 * already several times what a healthy job needs.
 */
export const LLM_BACKGROUND_QUEUE = 'llm-background';

export const LLM_BACKGROUND_QUEUE_OPTIONS: QueueOptions = {
  policy: 'short',
  localConcurrency: 1,
  expireInSeconds: 600,
  retryLimit: 3,
  retryDelay: 10,
  yieldsTo: INTERACTIVE_CHAT_YIELD_GATE,
  lane: OLLAMA_BACKGROUND_LANE,
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
/**
 * The rendition a vision model is shown: the ORIGINAL, downscaled to fit this
 * square. Not the 300 px preview (too small — subjects vanish) and not the
 * raw original (unbounded — image tokens scale with pixels on some models,
 * and HEIC cannot be sent at all). See VisionRenditionService for the numbers.
 */
export const VISION_RENDITION_MAX_DIMENSION = 1500;
export const VISION_RENDITION_JPEG_QUALITY = 85;

export const IMAGE_DESCRIPTION_QUEUE = 'image-description';

/**
 * `yieldsTo` is what stops this queue starving chat. Measured 2026-09-11: with
 * descriptions dispatched back to back the runner never went idle, Ollama
 * could not swap in the chat model, and two consecutive turns ended in the
 * empty-answer fallback after five minutes each. The running description
 * still finishes (8–25 s); only the NEXT one waits.
 */
export const IMAGE_DESCRIPTION_QUEUE_OPTIONS: QueueOptions = {
  policy: 'short',
  localConcurrency: 1,
  yieldsTo: INTERACTIVE_CHAT_YIELD_GATE,
  lane: OLLAMA_BACKGROUND_LANE,
};

/**
 * Same 1-slot local-GPU discipline and the same yield gate as
 * IMAGE_DESCRIPTION_QUEUE, but deliberately NO `policy: 'short'`.
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
  yieldsTo: INTERACTIVE_CHAT_YIELD_GATE,
  lane: OLLAMA_BACKGROUND_LANE,
};

/**
 * Same 1-slot local-GPU discipline and yield gate, and deliberately NO
 * `policy: 'short'` — same reasoning as THING_VISION_QUEUE. This queue's only event is
 * `browseractivity.created`, whose sole producer (`BrowserActivityService.create`)
 * sends without a singletonKey, and that event already fans out to the
 * `search-index` queue under the same keyless send. Under `short`, every
 * keyless job collapses into one row and every page visit but the first
 * would lose its insight pass silently.
 */
export const BROWSER_ACTIVITY_INSIGHT_QUEUE = 'browser-activity-insight';

export const BROWSER_ACTIVITY_INSIGHT_QUEUE_OPTIONS: QueueOptions = {
  localConcurrency: 1,
  yieldsTo: INTERACTIVE_CHAT_YIELD_GATE,
  lane: OLLAMA_BACKGROUND_LANE,
};

export type ThreadGenerationStatus = 'idle' | 'queued' | 'running' | 'failed';

export const GENERATION_STATUSES = ['idle', 'queued', 'running', 'failed'] as const;

export function isActiveGenerationStatus(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}
