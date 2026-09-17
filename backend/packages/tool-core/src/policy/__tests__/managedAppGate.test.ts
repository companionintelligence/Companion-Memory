import type { DispatchableIntent } from '../dispatchPolicy';
import { resolveToolGate } from '../toolGate';

/**
 * An installed app is confirmed before anything irreversible — whatever the
 * owner's trust dial says, and whether or not the pending-actions flag is on.
 *
 * This is the compensating control that makes `capabilityForApp`'s `full` safe.
 * The two are a pair: `full` without this rule is unattended deletion by a
 * borrowed agent, and this rule without `full` is the flat `TOOL_FORBIDDEN` that
 * made approval cards unreachable in the first place (capabilityAllows refuses
 * destructive intents below `full` BEFORE the gate, and a deny is never
 * laundered into a queue).
 *
 * If someone reverts one half, these fail.
 */
const destructive: DispatchableIntent = {
  name: 'messaging.send',
  privacy: { access: 'write', sensitivity: 'personal', destructive: true, external: true },
  localCapable: false,
};

const harmless: DispatchableIntent = {
  name: 'knowledge.search',
  privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
  localCapable: true,
};

describe('managed-app principals are confirmed, not trusted', () => {
  it('queues a destructive intent even when the dial says auto', () => {
    // `balanced` is the DEFAULT trust mode and resolves to `auto`. Before this
    // rule that meant an installed app deleted unattended on a stock appliance.
    const ruling = resolveToolGate(destructive, {
      tier: 'appliance',
      capability: 'full',
      trust: 'auto',
      principal: 'managed-app',
    });

    expect(ruling.decision).toBe('queue');
    expect(ruling.reason).toBe('confirmation-required');
  });

  it('queues even when the dial was never consulted at all', () => {
    // `trust: null` is what PendingActionService passes when the pending-actions
    // FEATURE FLAG is off. The flag gates the dial-driven review; it must not
    // also gate this, or turning it off would silently restore unattended
    // destructive calls for every installed app.
    const ruling = resolveToolGate(destructive, {
      tier: 'appliance',
      capability: 'full',
      trust: null,
      principal: 'managed-app',
    });

    expect(ruling.decision).toBe('queue');
  });

  it('leaves the owner alone — same call, same dial, executes', () => {
    const ruling = resolveToolGate(destructive, {
      tier: 'appliance',
      capability: 'full',
      trust: 'auto',
      principal: 'owner',
    });

    expect(ruling.decision).toBe('execute');
  });

  it('defaults to owner when the principal is unset, so no existing caller moves', () => {
    const ruling = resolveToolGate(destructive, {
      tier: 'appliance',
      capability: 'full',
      trust: 'auto',
    });

    expect(ruling.decision).toBe('execute');
  });

  it('does not queue what needs no confirmation — a card per search would train the owner to click yes', () => {
    const ruling = resolveToolGate(harmless, {
      tier: 'appliance',
      capability: 'full',
      trust: null,
      principal: 'managed-app',
    });

    expect(ruling.decision).toBe('execute');
  });

  it('never launders a capability DENY into a card', () => {
    // The ordering `resolveDispatch` exists to protect: an unauthorized call must
    // stay refused, not become a pending action that succeeds after one extra tap.
    const ruling = resolveToolGate(destructive, {
      tier: 'appliance',
      capability: 'read',
      trust: null,
      principal: 'managed-app',
    });

    expect(ruling.decision).toBe('deny');
    expect(ruling.reason).toBe('capability-insufficient');
  });
});
