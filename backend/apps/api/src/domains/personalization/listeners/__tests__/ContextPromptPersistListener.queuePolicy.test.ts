import { EventListenerRegistry } from '@ci/domains/events';

import { probeQueuePolicyGuard } from '../../../__tests__/support/queuePolicyGuardProbe';
import { CONTEXT_PROMPT_PERSIST_QUEUE } from '../../events';

// Side-effect import: `@OnEvent` registers the queue's options when the class is
// DECLARED, so importing the real listener is what puts
// `context-prompt-persist` in the registry the queue is later created from.
import '../ContextPromptPersistListener';

describe('context-prompt-persist queue policy', () => {
  it('declares "short" policy so respond()\'s per-prompt singletonKey is enforced', () => {
    expect(EventListenerRegistry.getQueueOptions(CONTEXT_PROMPT_PERSIST_QUEUE)).toEqual({ policy: 'short' });
  });

  /**
   * `short` is queue-WIDE: pg-boss's unique index COALESCEs a missing
   * singleton_key to '', so a keyless send to `context-prompt-persist` is
   * discarded whenever another keyless job is already waiting — silently,
   * because the insert is `ON CONFLICT DO NOTHING` and `send()` merely resolves
   * null. The enqueue-side guard turns that into a logged error; this asserts it
   * covers this queue.
   */
  it('makes a keyless send to context-prompt-persist a loud error and a keyed send silent', async () => {
    const probe = await probeQueuePolicyGuard(CONTEXT_PROMPT_PERSIST_QUEUE);

    expect(probe.keyless).toHaveLength(1);
    expect(probe.keyless[0]).toContain(CONTEXT_PROMPT_PERSIST_QUEUE);
    expect(probe.keyless[0]).toContain('short');
    expect(probe.keyed).toEqual([]);
  });
});
