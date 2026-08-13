import type { IntentPrivacy } from '../../core/types';
import { DISPATCH_TIERS, resolveDispatch, type DispatchableIntent } from '../dispatchPolicy';

function privacy(overrides: Partial<IntentPrivacy> = {}): IntentPrivacy {
  return { access: 'read', sensitivity: 'personal', destructive: false, external: false, ...overrides };
}

function intent(overrides: Partial<DispatchableIntent> = {}): DispatchableIntent {
  return { name: 'memory.recall', privacy: privacy(), localCapable: true, ...overrides };
}

describe('resolveDispatch — appliance tier', () => {
  it('executes anything the caller is entitled to, local-capable or not', () => {
    const cases = [
      intent(),
      intent({ localCapable: false }),
      intent({
        name: 'media.streamingAvailability',
        privacy: privacy({ external: true }),
        localCapable: false,
      }),
      intent({
        name: 'memory.forget',
        privacy: privacy({ access: 'delete', destructive: true }),
        localCapable: false,
      }),
    ];

    for (const candidate of cases) {
      expect(resolveDispatch(candidate, { tier: 'appliance' })).toMatchObject({
        decision: 'execute',
        reason: 'allowed',
      });
    }
  });
});

describe('resolveDispatch — local tier', () => {
  it('executes a local-capable, non-destructive, non-external read', () => {
    expect(resolveDispatch(intent(), { tier: 'local' })).toMatchObject({
      decision: 'execute',
      reason: 'allowed',
    });
  });

  it('executes a local-capable write — recording on-device and syncing up is the offline case', () => {
    const write = intent({ name: 'memory.remember', privacy: privacy({ access: 'write' }) });

    expect(resolveDispatch(write, { tier: 'local' })).toMatchObject({ decision: 'execute' });
  });

  /** The product rule, stated four ways because there are four ways an intent can trip it. */
  it('queues a destructive intent rather than executing it', () => {
    const forget = intent({
      name: 'memory.forget',
      privacy: privacy({ access: 'delete', destructive: true }),
      localCapable: false,
    });

    const ruling = resolveDispatch(forget, { tier: 'local' });

    expect(ruling.decision).toBe('queue');
    expect(ruling.reason).toBe('destructive-requires-confirmation');
    expect(ruling.explanation).toContain('confirmed against the appliance');
  });

  it('queues a destructive intent even when it claims to be local-capable', () => {
    const mislabelled = intent({ privacy: privacy({ destructive: true }), localCapable: true });

    expect(resolveDispatch(mislabelled, { tier: 'local' })).toMatchObject({
      decision: 'queue',
      reason: 'destructive-requires-confirmation',
    });
  });

  it('queues an external intent — nothing leaves the appliance from a device unasked', () => {
    const streaming = intent({
      name: 'media.streamingAvailability',
      privacy: privacy({ external: true, sensitivity: 'low' }),
      localCapable: false,
    });

    expect(resolveDispatch(streaming, { tier: 'local' })).toMatchObject({
      decision: 'queue',
      reason: 'external-leaves-appliance',
    });
  });

  it('queues an intent the device simply cannot serve', () => {
    const compose = intent({ name: 'persona.compose', localCapable: false });

    expect(resolveDispatch(compose, { tier: 'local' })).toMatchObject({
      decision: 'queue',
      reason: 'not-local-capable',
    });
  });

  it('reports the most alarming reason when several apply, since the reason is what the prompt shows', () => {
    const worst = intent({
      privacy: privacy({ access: 'delete', destructive: true, external: true }),
      localCapable: false,
    });

    expect(resolveDispatch(worst, { tier: 'local' }).reason).toBe('destructive-requires-confirmation');
  });

  /**
   * Sensitivity is the fourth privacy dimension and the one that deliberately does nothing here:
   * the device is the MORE private place to run something, so routing 'sensitive' work to the
   * appliance would send data further from the user, not closer.
   */
  it('does not let sensitivity change the ruling', () => {
    for (const sensitivity of ['low', 'personal', 'sensitive'] as const) {
      expect(resolveDispatch(intent({ privacy: privacy({ sensitivity }) }), { tier: 'local' })).toMatchObject(
        { decision: 'execute' },
      );
    }
  });
});

describe('resolveDispatch — capability', () => {
  const forget = intent({
    name: 'memory.forget',
    privacy: privacy({ access: 'delete', destructive: true }),
    localCapable: false,
  });

  it('denies (not queues) when the caller lacks authority, in EITHER tier', () => {
    for (const tier of DISPATCH_TIERS) {
      const ruling = resolveDispatch(forget, { tier, capability: 'read' });

      // Queuing here would be the bug: it converts "you may not do this" into "this will happen
      // once someone taps confirm".
      expect(ruling.decision).toBe('deny');
      expect(ruling.reason).toBe('capability-insufficient');
      expect(ruling.explanation).toContain('"full"');
      expect(ruling.explanation).toContain('"read"');
    }
  });

  it('denies a write to a read-only caller before considering the tier', () => {
    const write = intent({ privacy: privacy({ access: 'write' }) });

    expect(resolveDispatch(write, { tier: 'local', capability: 'read' }).decision).toBe('deny');
    expect(resolveDispatch(write, { tier: 'local', capability: 'write' }).decision).toBe('execute');
  });

  it('defaults to full authority — the device owner acting as themselves', () => {
    expect(resolveDispatch(forget, { tier: 'appliance' }).decision).toBe('execute');
    expect(resolveDispatch(forget, { tier: 'local' }).decision).toBe('queue');
  });
});
