import { EventListenerRegistry } from '@ci/domains/events';

import { probeQueuePolicyGuard } from '../../../__tests__/support/queuePolicyGuardProbe';

// Side-effect import: `@OnEvent` registers queue options when the class is
// DECLARED, so importing the real listener is what puts `planning` in the
// registry — with all five of its registrations, which
// `EventListenerRegistry.register` would reject at import time if they
// disagreed.
import '../PlanningJobsListener';

const PLANNING_QUEUE = 'planning';

describe('planning queue policy', () => {
  it('declares "short" policy on the planning queue so PlanningJobsCron\'s per-user keys are enforced', () => {
    expect(EventListenerRegistry.getQueueOptions(PLANNING_QUEUE)).toMatchObject({ policy: 'short' });
  });

  /**
   * TodoScan, InboxScan and TodoProcess call OllamaService in-process from this
   * queue and never enter `llm`, so `INTERACTIVE_JOB_PRIORITY` cannot make them
   * yield to a chat turn. Without a ceiling the per-queue default (six) let six
   * background requests sit on the GPU at once. One at a time per process is
   * the same shape `llm` uses for the same reason.
   */
  it('runs one planning job at a time per process, since each one holds an Ollama request', () => {
    expect(EventListenerRegistry.getQueueOptions(PLANNING_QUEUE)).toMatchObject({ localConcurrency: 1 });
  });

  /**
   * `short` is queue-WIDE: pg-boss's unique index COALESCEs a missing
   * singleton_key to '', so a keyless send to `planning` is discarded whenever
   * another keyless job is already waiting — silently, because the insert is
   * `ON CONFLICT DO NOTHING` and `send()` merely resolves null. The enqueue-side
   * guard turns that into a logged error; this asserts it covers this queue.
   */
  it('makes a keyless send to planning a loud error and a keyed send silent', async () => {
    const probe = await probeQueuePolicyGuard(PLANNING_QUEUE);

    expect(probe.keyless).toHaveLength(1);
    expect(probe.keyless[0]).toContain(PLANNING_QUEUE);
    expect(probe.keyless[0]).toContain('short');
    expect(probe.keyed).toEqual([]);
  });
});
