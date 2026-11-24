import { EventListenerRegistry } from '@ci/domains/events';

import { probeQueuePolicyGuard } from '../../../__tests__/support/queuePolicyGuardProbe';
import {
  INTERACTIVE_CHAT_YIELD_GATE,
  LLM_BACKGROUND_QUEUE,
  LLM_BACKGROUND_QUEUE_OPTIONS,
  LLM_QUEUE,
  LLM_QUEUE_OPTIONS,
  OLLAMA_BACKGROUND_LANE,
} from '../../constants';

// Side-effect imports: `@OnEvent` registers its queue options when the class is
// DECLARED, so importing the real listeners is what puts both queues in the
// registry. `llm-background` is declared from two files (ChatGenerateListener
// for titles, AnswerInferenceListener for inference) and
// `EventListenerRegistry.register` throws at import time if two registrants
// disagree on any option — so importing both is what proves they share one
// constant rather than two separately-written literals.
import '../../../smart-rotation/listeners/AnswerInferenceListener';
import '../ChatGenerateListener';

describe('llm queue policy', () => {
  it('declares "short" policy and a 1-slot local ceiling on llm', () => {
    expect(EventListenerRegistry.getQueueOptions(LLM_QUEUE)).toEqual(LLM_QUEUE_OPTIONS);
    expect(LLM_QUEUE_OPTIONS.policy).toBe('short');
    expect(LLM_QUEUE_OPTIONS.localConcurrency).toBe(1);
  });

  it('keeps llm for chat turns alone — no background event is registered there', () => {
    // Priority cannot preempt a running job, so anything else on this slot
    // is something a person can end up waiting behind (measured: nine
    // minutes behind a hung inference retry).
    const onInteractive = [...EventListenerRegistry.getListeners()].filter(
      ([, registration]) => registration.queue === LLM_QUEUE,
    );

    expect(onInteractive.map(([, registration]) => registration.className)).toEqual(['ChatGenerateListener']);
  });

  it('declares "short", 1 slot and the interactive-chat yield gate on llm-background, agreed by both registrants', () => {
    expect(EventListenerRegistry.getQueueOptions(LLM_BACKGROUND_QUEUE)).toEqual(LLM_BACKGROUND_QUEUE_OPTIONS);
    expect(LLM_BACKGROUND_QUEUE_OPTIONS.policy).toBe('short');
    expect(LLM_BACKGROUND_QUEUE_OPTIONS.localConcurrency).toBe(1);
    expect(LLM_BACKGROUND_QUEUE_OPTIONS.yieldsTo).toBe(INTERACTIVE_CHAT_YIELD_GATE);
    // A crash backstop, not the operating timeout — and shorter than chat's,
    // since nothing here legitimately runs for a quarter of an hour.
    expect(LLM_BACKGROUND_QUEUE_OPTIONS.expireInSeconds).toBeLessThan(LLM_QUEUE_OPTIONS.expireInSeconds!);
  });

  /**
   * Neither llm-background listener swallows its failures any more (a title that failed once used to be marked done
   * and never retried), so a failing job is retried — and the retries have to stay BOUNDED, or a dead model would
   * spin the one slot this queue shares with everything else on its lane. pg-boss spaces them by `retryDelay`
   * doubled each time (the appliance-wide retryBackoff: ~10-20 s, ~20-40 s, ~40-80 s) and dead-letters the job
   * once the limit is spent.
   */
  it('bounds retries on llm-background, so a failing title or inference cannot spin the shared slot', () => {
    const { retryLimit, retryDelay } = LLM_BACKGROUND_QUEUE_OPTIONS;

    expect(retryLimit).toBeGreaterThan(0);
    expect(retryLimit).toBeLessThanOrEqual(3);
    expect(retryDelay).toBeGreaterThanOrEqual(10);
  });

  it('puts llm-background on the shared ollama-background lane, and keeps llm off it', () => {
    // Chat must never wait behind a background generation for a slot.
    expect(LLM_BACKGROUND_QUEUE_OPTIONS.lane).toBe(OLLAMA_BACKGROUND_LANE);
    expect(LLM_QUEUE_OPTIONS.lane).toBeUndefined();
  });

  /**
   * `short` is queue-WIDE: pg-boss's unique index COALESCEs a missing
   * singleton_key to '', so a keyless send to `llm` is discarded whenever
   * another keyless job is already waiting — silently, because the insert is
   * `ON CONFLICT DO NOTHING` and `send()` merely resolves null. The enqueue-side
   * guard turns that into a logged error; this asserts it covers this queue.
   */
  it.each([LLM_QUEUE, LLM_BACKGROUND_QUEUE])(
    'makes a keyless send to %s a loud error and a keyed send silent',
    async (queue) => {
      const probe = await probeQueuePolicyGuard(queue);

      expect(probe.keyless).toHaveLength(1);
      expect(probe.keyless[0]).toContain(queue);
      expect(probe.keyless[0]).toContain('short');
      expect(probe.keyed).toEqual([]);
    },
  );
});
