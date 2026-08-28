import { EventListenerRegistry } from '@ci/domains/events';

import { probeQueuePolicyGuard } from '../../../__tests__/support/queuePolicyGuardProbe';
import { SMART_ROTATION_QUEUE } from '../../types';

// Side-effect import: `@OnEvent` registers the queue's options when the class is
// DECLARED, so importing the real listener is what puts `smart-rotation` in the
// registry the queue is later created from.
import '../SmartRotationListener';

describe('smart-rotation queue policy', () => {
  it('declares "short" policy so the per-user/workType singletonKey both senders carry is enforced', () => {
    expect(EventListenerRegistry.getQueueOptions(SMART_ROTATION_QUEUE)).toEqual({ policy: 'short' });
  });

  /**
   * `short` is queue-WIDE: pg-boss's unique index COALESCEs a missing
   * singleton_key to '', so a keyless send to `smart-rotation` is discarded
   * whenever another keyless job is already waiting — silently, because the
   * insert is `ON CONFLICT DO NOTHING` and `send()` merely resolves null. The
   * enqueue-side guard turns that into a logged error; this asserts it covers
   * this queue.
   */
  it('makes a keyless send to smart-rotation a loud error and a keyed send silent', async () => {
    const probe = await probeQueuePolicyGuard(SMART_ROTATION_QUEUE);

    expect(probe.keyless).toHaveLength(1);
    expect(probe.keyless[0]).toContain(SMART_ROTATION_QUEUE);
    expect(probe.keyless[0]).toContain('short');
    expect(probe.keyed).toEqual([]);
  });
});
