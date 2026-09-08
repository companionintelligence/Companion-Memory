import type { ToolInvokedPayload } from '../../events';
import type { ToolGateRuling } from '../../policy/toolGate';
import type { ToolGate, ToolInvocationSink } from '../ports';

/**
 * A {@link ToolGate} double for tests that are not about the gate.
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
    double: { evaluate, propose } as unknown as ToolGate,
    evaluate,
    propose,
  };
}

/**
 * A {@link ToolInvocationSink} double.
 *
 * `record` stands where `EventService.send` used to: the registry hands over a finished
 * {@link ToolInvokedPayload} and the frontend decides what emitting means. The assertion that
 * *this appliance* turns that into `tool.invoked` on the `telemetry` queue is not gone — it moved
 * to where that decision is now made, `domains/tools/registry/__tests__/ToolRegistry.nest.test.ts`
 * in the API.
 */
export function recordingSink() {
  const record = jest.fn<Promise<unknown>, [ToolInvokedPayload]>().mockResolvedValue([]);

  return { double: { record } satisfies ToolInvocationSink, record };
}
