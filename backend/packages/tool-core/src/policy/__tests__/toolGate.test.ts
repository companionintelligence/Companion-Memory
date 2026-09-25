import { FULL_CAPABILITY, READ_CAPABILITY, WRITE_CAPABILITY } from '../../capability';
import type { IntentPrivacy } from '../../core/types';
import type { DispatchableIntent } from '../dispatchPolicy';
import { needsConfirmation, resolveToolGate, type TrustDecision } from '../toolGate';

function intent(name: string, privacy: Partial<IntentPrivacy>, localCapable = true): DispatchableIntent {
  return {
    name,
    localCapable,
    privacy: {
      access: 'read',
      sensitivity: 'personal',
      destructive: false,
      external: false,
      ...privacy,
    },
  };
}

const READ_ONLY = intent('memory.recall', {});
const DESTRUCTIVE = intent('memory.forget', { access: 'delete', destructive: true });
const EXTERNAL = intent('messaging.send', { access: 'write', external: true }, false);

describe('needsConfirmation', () => {
  it('flags the two properties the product already promised to confirm, and nothing else', () => {
    expect(needsConfirmation(DESTRUCTIVE)).toBe(true);
    expect(needsConfirmation(EXTERNAL)).toBe(true);
    expect(needsConfirmation(READ_ONLY)).toBe(false);
    expect(needsConfirmation(intent('memory.remember', { access: 'write' }))).toBe(false);
  });
});

describe('resolveToolGate — a denial is never laundered into a queue', () => {
  // THE security rule this whole feature is built around. dispatchPolicy.ts
  // orders capability before tier so a refusal cannot become "allowed after one
  // extra tap"; resolveToolGate must preserve that ordering, in BOTH tiers and
  // under EVERY trust mode.
  const trustModes: (TrustDecision | null)[] = ['auto', 'review', 'skip', null];

  it.each(trustModes)('refuses a read-only key a delete on the appliance (trust=%s)', (trust) => {
    const ruling = resolveToolGate(DESTRUCTIVE, {
      tier: 'appliance',
      capability: READ_CAPABILITY,
      trust,
    });

    expect(ruling.decision).toBe('deny');
    expect(ruling.reason).toBe('capability-insufficient');
  });

  it.each(trustModes)('refuses a read-only key a delete on-device too (trust=%s)', (trust) => {
    const ruling = resolveToolGate(DESTRUCTIVE, { tier: 'local', capability: READ_CAPABILITY, trust });

    expect(ruling.decision).toBe('deny');
    expect(ruling.reason).toBe('capability-insufficient');
  });

  it('refuses a write key a destructive intent rather than queueing it', () => {
    const ruling = resolveToolGate(DESTRUCTIVE, {
      tier: 'appliance',
      capability: WRITE_CAPABILITY,
      trust: 'review',
    });

    expect(ruling.decision).toBe('deny');
  });
});

describe('resolveToolGate — the local tier', () => {
  it('queues a destructive intent with the reason a prompt can show', () => {
    const ruling = resolveToolGate(DESTRUCTIVE, {
      tier: 'local',
      capability: FULL_CAPABILITY,
      trust: null,
    });

    expect(ruling.decision).toBe('queue');
    expect(ruling.reason).toBe('destructive-requires-confirmation');
  });

  it('queues an external intent', () => {
    const ruling = resolveToolGate(EXTERNAL, { tier: 'local', capability: FULL_CAPABILITY, trust: null });

    expect(ruling.decision).toBe('queue');
    expect(ruling.reason).toBe('external-leaves-appliance');
  });

  it('queues an intent the device cannot serve', () => {
    const ruling = resolveToolGate(intent('persona.compose', { access: 'write' }, false), {
      tier: 'local',
      capability: FULL_CAPABILITY,
      trust: null,
    });

    expect(ruling.decision).toBe('queue');
    expect(ruling.reason).toBe('not-local-capable');
  });

  it('runs a plain local-capable read on-device', () => {
    const ruling = resolveToolGate(READ_ONLY, { tier: 'local', capability: READ_CAPABILITY, trust: null });

    expect(ruling.decision).toBe('execute');
  });
});

describe('resolveToolGate — the appliance-tier trust dial', () => {
  it('is not consulted at all for ordinary reads and writes', () => {
    for (const trust of ['review', 'skip'] as TrustDecision[]) {
      expect(
        resolveToolGate(READ_ONLY, { tier: 'appliance', capability: FULL_CAPABILITY, trust }).decision,
      ).toBe('execute');
      expect(
        resolveToolGate(intent('memory.remember', { access: 'write' }), {
          tier: 'appliance',
          capability: FULL_CAPABILITY,
          trust,
        }).decision,
      ).toBe('execute');
    }
  });

  it('executes destructive and external work when the dial says auto — hands_off', () => {
    expect(
      resolveToolGate(DESTRUCTIVE, { tier: 'appliance', capability: FULL_CAPABILITY, trust: 'auto' })
        .decision,
    ).toBe('execute');
    expect(
      resolveToolGate(EXTERNAL, { tier: 'appliance', capability: FULL_CAPABILITY, trust: 'auto' }).decision,
    ).toBe('execute');
  });

  it('executes when the dial was not consulted at all (flag off)', () => {
    expect(
      resolveToolGate(DESTRUCTIVE, { tier: 'appliance', capability: FULL_CAPABILITY, trust: null }).decision,
    ).toBe('execute');
  });

  it('queues destructive and external work when the dial says review', () => {
    const destructive = resolveToolGate(DESTRUCTIVE, {
      tier: 'appliance',
      capability: FULL_CAPABILITY,
      trust: 'review',
    });

    expect(destructive.decision).toBe('queue');
    expect(destructive.reason).toBe('confirmation-required');
    expect(destructive.explanation).toContain('removes data');

    const external = resolveToolGate(EXTERNAL, {
      tier: 'appliance',
      capability: FULL_CAPABILITY,
      trust: 'review',
    });

    expect(external.decision).toBe('queue');
    expect(external.explanation).toContain('third-party');
  });

  it('asks rather than silently dropping when the dial says skip', () => {
    expect(
      resolveToolGate(DESTRUCTIVE, { tier: 'appliance', capability: FULL_CAPABILITY, trust: 'skip' })
        .decision,
    ).toBe('queue');
  });

  it('keeps the local tier’s reason when both the tier and the dial would queue', () => {
    // The tier's reason is the more specific of the two and is what the device
    // needs to hear; the dial can only ever ADD a queue, never re-label one.
    const ruling = resolveToolGate(DESTRUCTIVE, {
      tier: 'local',
      capability: FULL_CAPABILITY,
      trust: 'review',
    });

    expect(ruling.reason).toBe('destructive-requires-confirmation');
  });
});
