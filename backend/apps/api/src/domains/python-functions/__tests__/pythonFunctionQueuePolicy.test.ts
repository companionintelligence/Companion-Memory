import { EventListenerRegistry } from '@ci/domains/events';

import { probeQueuePolicyGuard } from '../../__tests__/support/queuePolicyGuardProbe';
import { PYTHON_FUNCTION_QUEUE_OPTIONS, PYTHON_FUNCTION_QUEUES } from '../types';

// Side-effect import: `@OnEvent` registers queue options when the class is
// DECLARED, so importing the real listener is what puts `py-fn-summary` and
// `py-fn-hbpe` in the registry the queues are later created from.
import '../listeners/PythonFunctionDispatchListener';

describe('python-functions queue policy', () => {
  it.each(['summary', 'hbpe'] as const)(
    'declares the py-fn-%s queue exactly as PYTHON_FUNCTION_QUEUE_OPTIONS states it',
    (target) => {
      expect(EventListenerRegistry.getQueueOptions(PYTHON_FUNCTION_QUEUES[target])).toEqual(
        PYTHON_FUNCTION_QUEUE_OPTIONS[target],
      );
      expect(PYTHON_FUNCTION_QUEUE_OPTIONS[target].policy).toBe('short');
    },
  );

  /**
   * `short` is queue-WIDE: pg-boss's unique index COALESCEs a missing
   * singleton_key to '', so a keyless dispatch is discarded whenever another
   * keyless job is already waiting — silently, because the insert is `ON
   * CONFLICT DO NOTHING` and `send()` merely resolves null. That is the exact
   * hole PythonFunctionService leaves open ("only omits the key when a caller
   * doesn't pass one"); the enqueue-side guard is what makes such a caller
   * visible instead of lossy.
   */
  it.each(['summary', 'hbpe'] as const)(
    'makes a keyless dispatch to py-fn-%s a loud error and a keyed one silent',
    async (target) => {
      const queue = PYTHON_FUNCTION_QUEUES[target];
      const probe = await probeQueuePolicyGuard(queue);

      expect(probe.keyless).toHaveLength(1);
      expect(probe.keyless[0]).toContain(queue);
      expect(probe.keyless[0]).toContain('short');
      expect(probe.keyed).toEqual([]);
    },
  );
});
