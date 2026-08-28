import { EventListenerRegistry } from '@ci/domains/events';

import { probeQueuePolicyGuard } from '../../../__tests__/support/queuePolicyGuardProbe';
import { LLM_QUEUE, LLM_QUEUE_OPTIONS } from '../../constants';

// Side-effect imports: `@OnEvent` registers its queue options when the class is
// DECLARED, so importing the real listeners is what puts `llm` in the registry.
// `llm` is declared from two files (ChatGenerateListener for two events,
// AnswerInferenceListener for a third) and `EventListenerRegistry.register`
// throws at import time if two registrants disagree on any option — so
// importing both is what proves they share one constant rather than two
// separately-written literals.
import '../../../smart-rotation/listeners/AnswerInferenceListener';
import '../ChatGenerateListener';

describe('llm queue policy', () => {
  it('declares "short" policy and a 1-slot local ceiling on llm, agreed by both registrants', () => {
    expect(EventListenerRegistry.getQueueOptions(LLM_QUEUE)).toEqual(LLM_QUEUE_OPTIONS);
    expect(LLM_QUEUE_OPTIONS.policy).toBe('short');
    expect(LLM_QUEUE_OPTIONS.localConcurrency).toBe(1);
  });

  /**
   * `short` is queue-WIDE: pg-boss's unique index COALESCEs a missing
   * singleton_key to '', so a keyless send to `llm` is discarded whenever
   * another keyless job is already waiting — silently, because the insert is
   * `ON CONFLICT DO NOTHING` and `send()` merely resolves null. The enqueue-side
   * guard turns that into a logged error; this asserts it covers this queue.
   */
  it('makes a keyless send to llm a loud error and a keyed send silent', async () => {
    const probe = await probeQueuePolicyGuard(LLM_QUEUE);

    expect(probe.keyless).toHaveLength(1);
    expect(probe.keyless[0]).toContain(LLM_QUEUE);
    expect(probe.keyless[0]).toContain('short');
    expect(probe.keyed).toEqual([]);
  });
});
