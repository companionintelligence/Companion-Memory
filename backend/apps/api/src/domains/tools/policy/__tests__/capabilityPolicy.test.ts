import type { ApiKeyCapability } from '@ci/common/decorators';

import type { IntentPrivacy } from '../../core/types';
import { capabilityAllows, capabilityRequiredFor, removesData } from '../capabilityPolicy';

function privacy(overrides: Partial<IntentPrivacy> = {}): IntentPrivacy {
  return { access: 'read', sensitivity: 'personal', destructive: false, external: false, ...overrides };
}

const CAPABILITIES: ApiKeyCapability[] = ['read', 'write', 'full'];

describe('capabilityAllows', () => {
  it('lets full authority run anything', () => {
    const labels = [
      privacy(),
      privacy({ access: 'write' }),
      privacy({ access: 'delete', destructive: true }),
      privacy({ external: true }),
      privacy({ sensitivity: 'sensitive' }),
    ];

    for (const label of labels) {
      expect(capabilityAllows(label, 'full')).toBe(true);
    }
  });

  it('confines a read-only caller to reads', () => {
    expect(capabilityAllows(privacy(), 'read')).toBe(true);
    expect(capabilityAllows(privacy({ access: 'write' }), 'read')).toBe(false);
    expect(capabilityAllows(privacy({ access: 'delete' }), 'read')).toBe(false);
  });

  it('lets a write caller read and write but never lose data', () => {
    expect(capabilityAllows(privacy(), 'write')).toBe(true);
    expect(capabilityAllows(privacy({ access: 'write' }), 'write')).toBe(true);
    expect(capabilityAllows(privacy({ access: 'delete' }), 'write')).toBe(false);
    expect(capabilityAllows(privacy({ destructive: true }), 'write')).toBe(false);
  });

  /**
   * `destructive` is not a synonym for `access: 'delete'` — a "purge cache" or "revoke all
   * sessions" intent can be a write that still loses data. Below full, either one is enough to
   * refuse, or the label would be advisory again in exactly the case that matters.
   */
  it('refuses a destructive intent below full even when its access is only read or write', () => {
    expect(capabilityAllows(privacy({ access: 'read', destructive: true }), 'read')).toBe(false);
    expect(capabilityAllows(privacy({ access: 'read', destructive: true }), 'write')).toBe(false);
    expect(capabilityAllows(privacy({ access: 'write', destructive: true }), 'write')).toBe(false);
  });

  /**
   * `external` and `sensitivity` are real labels with real consequences — egress logging, the
   * local-tier queue rule, how a client renders a result — but they are not authority. Pinning
   * that here so a later "sensitive needs full" idea has to argue with a test rather than land as
   * a surprise for every read-only integration.
   */
  it('ignores external and sensitivity, which grade exposure rather than authority', () => {
    for (const capability of CAPABILITIES) {
      expect(capabilityAllows(privacy({ external: true }), capability)).toBe(true);
      expect(capabilityAllows(privacy({ sensitivity: 'sensitive' }), capability)).toBe(true);
      expect(capabilityAllows(privacy({ sensitivity: 'low' }), capability)).toBe(true);
    }
  });

  it('is monotonic: nothing a lower level may run is refused to a higher one', () => {
    const labels = [
      privacy(),
      privacy({ access: 'write' }),
      privacy({ access: 'delete', destructive: true }),
      privacy({ access: 'write', destructive: true }),
      privacy({ external: true, sensitivity: 'low' }),
    ];

    for (const label of labels) {
      const allowed = CAPABILITIES.map((capability) => capabilityAllows(label, capability));

      expect(allowed).toEqual([...allowed].sort((a, b) => Number(a) - Number(b)));
    }
  });
});

describe('removesData', () => {
  it('is true for a delete OR a destructive flag, and false otherwise', () => {
    expect(removesData(privacy())).toBe(false);
    expect(removesData(privacy({ access: 'write' }))).toBe(false);
    expect(removesData(privacy({ access: 'delete' }))).toBe(true);
    expect(removesData(privacy({ destructive: true }))).toBe(true);
  });
});

describe('capabilityRequiredFor', () => {
  it('names the lowest level that could run the tool', () => {
    expect(capabilityRequiredFor(privacy())).toBe('read');
    expect(capabilityRequiredFor(privacy({ access: 'write' }))).toBe('write');
    expect(capabilityRequiredFor(privacy({ access: 'delete', destructive: true }))).toBe('full');
    expect(capabilityRequiredFor(privacy({ destructive: true }))).toBe('full');
  });

  it('agrees with capabilityAllows for every label/level pair', () => {
    const labels = [
      privacy(),
      privacy({ access: 'write' }),
      privacy({ access: 'delete', destructive: true }),
      privacy({ access: 'read', destructive: true }),
    ];
    const rank: Record<ApiKeyCapability, number> = { read: 0, write: 1, full: 2 };

    for (const label of labels) {
      const required = capabilityRequiredFor(label);

      for (const capability of CAPABILITIES) {
        expect(capabilityAllows(label, capability)).toBe(rank[capability] >= rank[required]);
      }
    }
  });
});
