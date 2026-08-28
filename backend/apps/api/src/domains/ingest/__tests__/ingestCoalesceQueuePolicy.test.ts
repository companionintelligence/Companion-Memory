import { EventListenerRegistry } from '@ci/domains/events';

import { probeQueuePolicyGuard } from '../../__tests__/support/queuePolicyGuardProbe';
// `@OnEvent` registers the queue's options when the class is DECLARED, so this
// import is what puts `ingest-coalesce` in the registry the queue is later
// created from — the constant alone would not.
import { INGEST_COALESCE_QUEUE } from '../services/IngestCoalesceService';

describe('ingest-coalesce queue policy', () => {
  it('declares "short" policy so the per-user singletonKey enqueue() sends is enforced', () => {
    expect(EventListenerRegistry.getQueueOptions(INGEST_COALESCE_QUEUE)).toEqual({
      policy: 'short',
      expireInSeconds: 3600,
      retryLimit: 3,
      retryDelay: 60,
    });
  });

  /**
   * `short` is queue-WIDE: pg-boss's unique index COALESCEs a missing
   * singleton_key to '', so a keyless send to `ingest-coalesce` is discarded
   * whenever another keyless job is already waiting — silently, because the
   * insert is `ON CONFLICT DO NOTHING` and `send()` merely resolves null. The
   * enqueue-side guard turns that into a logged error; this asserts it covers
   * this queue.
   */
  it('makes a keyless send to ingest-coalesce a loud error and a keyed send silent', async () => {
    const probe = await probeQueuePolicyGuard(INGEST_COALESCE_QUEUE);

    expect(probe.keyless).toHaveLength(1);
    expect(probe.keyless[0]).toContain(INGEST_COALESCE_QUEUE);
    expect(probe.keyless[0]).toContain('short');
    expect(probe.keyed).toEqual([]);
  });
});
