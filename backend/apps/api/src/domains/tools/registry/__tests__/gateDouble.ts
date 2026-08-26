import type { ToolGateRuling } from '../../policy/toolGate';
import type { PendingActionService } from '../../services/PendingActionService';

/**
 * A {@link PendingActionService} double for tests that are not about the gate.
 *
 * Defaults to the flag-off answer — `execute`, which is what every one of these
 * tests asserted before the gate existed — and records `propose` calls so a test
 * can assert that NOTHING was queued (the shape most of the security assertions
 * take).
 */
export function openGate(ruling?: Partial<ToolGateRuling>) {
  const propose = jest.fn();
  const evaluate = jest.fn(
    async (): Promise<ToolGateRuling> => ({
      decision: 'execute',
      reason: 'allowed',
      explanation: 'open',
      ...ruling,
    }),
  );

  return {
    double: { evaluate, propose } as unknown as PendingActionService,
    evaluate,
    propose,
  };
}
