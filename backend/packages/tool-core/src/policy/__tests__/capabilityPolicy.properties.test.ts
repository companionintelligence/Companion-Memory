import { TOOL_CAPABILITIES, type ToolCapability } from '../../capability';
import type { IntentAccess } from '../../core/types';
import { capabilityAllows, capabilityRequiredFor, removesData, type GatedPrivacy } from '../capabilityPolicy';

/**
 * The `//@` contracts in capabilityPolicy.ts, checked against the real functions.
 *
 * LemmaScript proves them (spec/lemmascript) for the closed unions `IntentAccess` and
 * `ToolCapability`. The proved domain is small enough to run here in full. What the model leaves
 * out is a label or level that names nothing in those unions, which a caller can still hand over
 * at runtime; the last block runs those with a seeded generator and checks the safe direction.
 */

/** A small seeded PRNG (mulberry32) so a failure is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCESS: readonly IntentAccess[] = ['read', 'write', 'delete'];
const LABELS: GatedPrivacy[] = ACCESS.flatMap((access) => [
  { access, destructive: false },
  { access, destructive: true },
]);
const RANK: Record<ToolCapability, number> = { read: 0, write: 1, full: 2 };

describe('capabilityAllows and capabilityRequiredFor over every label and level', () => {
  it('lists the levels lowest first', () => {
    expect([...TOOL_CAPABILITIES].sort((a, b) => RANK[a] - RANK[b])).toEqual([...TOOL_CAPABILITIES]);
  });

  it('holds every contract clause', () => {
    for (const label of LABELS) {
      expect(removesData(label)).toBe(label.access === 'delete' || label.destructive);

      for (const capability of TOOL_CAPABILITIES) {
        const allowed = capabilityAllows(label, capability);

        if (capability === 'full') {
          expect(allowed).toBe(true);
        }

        if (removesData(label) && allowed) {
          expect(capability).toBe('full');
        }

        if (capability === 'write') {
          expect(allowed).toBe(!removesData(label));
        }

        if (capability === 'read') {
          expect(allowed).toBe(label.access === 'read' && !label.destructive);
        }
      }
    }
  });

  it('is monotone: a level never refuses what a lower one allows', () => {
    for (const label of LABELS) {
      for (const low of TOOL_CAPABILITIES) {
        for (const high of TOOL_CAPABILITIES.filter((level) => RANK[level] >= RANK[low])) {
          if (capabilityAllows(label, low)) {
            expect(capabilityAllows(label, high)).toBe(true);
          }
        }
      }
    }
  });

  it('names the lowest level that is allowed', () => {
    for (const label of LABELS) {
      const required = capabilityRequiredFor(label);

      for (const capability of TOOL_CAPABILITIES) {
        expect(capabilityAllows(label, capability)).toBe(RANK[capability] >= RANK[required]);
      }

      expect(required === 'full').toBe(removesData(label));
    }
  });
});

describe('outside the model: labels and levels that name nothing', () => {
  const STRINGS = ['', 'READ', 'deleted', 'admin', 'full ', 'Full', '__proto__', 'constructor'];

  /**
   * A level the unions do not name is not `full` and not `write`, so it falls to the last branch
   * and can do no more than `read`. A label whose access names nothing still needs full when it
   * is marked destructive.
   */
  it('never lets an unknown level do more than read, seed 7', () => {
    const random = prng(7);

    for (let i = 0; i < 2000; i++) {
      const label = {
        access:
          random() < 0.5 ? ACCESS[Math.floor(random() * 3)] : STRINGS[Math.floor(random() * STRINGS.length)],
        destructive: random() < 0.5,
      } as GatedPrivacy;
      const level = STRINGS[Math.floor(random() * STRINGS.length)] as ToolCapability;

      if (capabilityAllows(label, level)) {
        expect(capabilityAllows(label, 'read')).toBe(true);
      }

      if (label.destructive) {
        expect(capabilityAllows(label, level)).toBe(false);
        expect(capabilityRequiredFor(label)).toBe('full');
      }
    }
  });
});
