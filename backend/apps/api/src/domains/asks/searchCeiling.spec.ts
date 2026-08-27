import { DISCLOSURE_RUNGS } from './policy';
import {
  applySearchCeiling,
  ceilingForShare,
  SHARE_DISCLOSURE,
  type ClampableConnection,
  type ShareDisclosure,
} from './searchCeiling';
import type { DisclosureRung } from './types';

function connection(
  edgeCount: number,
  totalCount: number,
  tagCount = 2,
): ClampableConnection<string, string> {
  return {
    edges: Array.from({ length: edgeCount }, (_, i) => `edge-${i}`),
    pageInfo: {
      hasNextPage: true,
      hasPreviousPage: false,
      startCursor: 'start',
      endCursor: 'end',
    },
    totalCount,
    matchingTags: Array.from({ length: tagCount }, (_, i) => `tag-${i}`),
  };
}

/** Numeric rank of a magnitude, for the superset comparison. */
const MAGNITUDE_RANK: Record<ShareDisclosure['magnitude'], number> = {
  none: 0,
  existence: 1,
  exact: 2,
};

/** The axes, as comparable numbers, so "discloses at least as much" is decidable. */
function axes(permits: ShareDisclosure): number[] {
  return [
    permits.items ? 1 : 0,
    MAGNITUDE_RANK[permits.magnitude],
    permits.facets ? 1 : 0,
    permits.paging ? 1 : 0,
  ];
}

describe('SHARE_DISCLOSURE', () => {
  it('names every rung on the ladder, and only those', () => {
    expect(Object.keys(SHARE_DISCLOSURE).sort()).toEqual([...DISCLOSURE_RUNGS].sort());
  });

  /**
   * THE TEST THAT MAKES D2 UNREPEATABLE.
   *
   * `PeerAskService.clampAvailability` pointed `redacted` at the same branch as
   * `full`, so a ceiling the owner picked to restrict something restricted
   * nothing. That is invisible to a reviewer reading a `switch` and invisible to
   * a per-rung unit test, because each rung on its own looks reasonable — the
   * defect only exists in the RELATIONSHIP between two rungs.
   *
   * So the relationship is what is asserted. Walking the ladder from strictest
   * to loosest, each rung must disclose at least as much as its predecessor on
   * every axis, and strictly more on at least one. A rung that clamps nothing
   * new fails the second half; a rung that clamps something a stricter rung
   * disclosed fails the first.
   */
  it('discloses monotonically more at every step up the ladder', () => {
    for (let i = 1; i < DISCLOSURE_RUNGS.length; i += 1) {
      const lower = DISCLOSURE_RUNGS[i - 1];
      const higher = DISCLOSURE_RUNGS[i];
      const lowerAxes = axes(SHARE_DISCLOSURE[lower]);
      const higherAxes = axes(SHARE_DISCLOSURE[higher]);

      // Nothing the stricter rung disclosed is withheld by the looser one.
      lowerAxes.forEach((value, axis) => {
        // The rung pair is in the failure message so a break names itself.
        expect([`${lower}->${higher}`, axis, higherAxes[axis] >= value]).toEqual([
          `${lower}->${higher}`,
          axis,
          true,
        ]);
      });

      // And the looser rung is not a synonym for the stricter one. This is the
      // half D2 fails.
      expect(higherAxes).not.toEqual(lowerAxes);
    }
  });
});

describe('applySearchCeiling', () => {
  it('passes the connection through untouched when no ceiling is declared', () => {
    const input = connection(3, 40);

    expect(applySearchCeiling(input, undefined)).toBe(input);
  });

  it('discloses everything at `full`', () => {
    const result = applySearchCeiling(connection(3, 40), 'full');

    expect(result.edges).toHaveLength(3);
    expect(result.totalCount).toBe(40);
    expect(result.matchingTags).toHaveLength(2);
    expect(result.pageInfo.hasNextPage).toBe(true);
  });

  it('hands `redacted` the window but seals it — the D2 case', () => {
    const result = applySearchCeiling(connection(3, 40), 'redacted');

    expect(result.edges).toHaveLength(3);
    // The magnitude is still honest; what the reader loses is the ability to
    // walk past the window they were given.
    expect(result.totalCount).toBe(40);
    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(result.pageInfo.endCursor).toBeNull();
  });

  it('drops every item reference from `summary` down', () => {
    for (const rung of ['summary', 'count', 'boolean', 'none'] as const) {
      expect(applySearchCeiling(connection(3, 40), rung).edges).toEqual([]);
    }
  });

  it('keeps facets at `summary` and drops them at `count`', () => {
    expect(applySearchCeiling(connection(3, 40), 'summary').matchingTags).toHaveLength(2);
    expect(applySearchCeiling(connection(3, 40), 'count').matchingTags).toEqual([]);
    expect(applySearchCeiling(connection(3, 40), 'summary').totalCount).toBe(40);
  });

  it('reduces `boolean` to existence, not magnitude', () => {
    expect(applySearchCeiling(connection(3, 40), 'boolean').totalCount).toBe(1);
    expect(applySearchCeiling(connection(0, 0), 'boolean').totalCount).toBe(0);
  });

  it('discloses nothing at all at `none`', () => {
    const result = applySearchCeiling(connection(3, 40), 'none');

    expect(result).toEqual({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
      matchingTags: [],
    });
  });

  it('does not mutate its input', () => {
    const input = connection(3, 40);
    applySearchCeiling(input, 'none');

    expect(input.edges).toHaveLength(3);
    expect(input.totalCount).toBe(40);
  });
});

describe('ceilingForShare', () => {
  it('reads an absent ceiling as "this source declares none"', () => {
    expect(ceilingForShare(null)).toBeUndefined();
    expect(ceilingForShare(undefined)).toBeUndefined();
  });

  it('accepts every rung, and canonicalizes casing and padding', () => {
    for (const rung of DISCLOSURE_RUNGS) {
      expect(ceilingForShare(rung)).toBe(rung);
    }

    expect(ceilingForShare('  Full ')).toBe('full');
    expect(ceilingForShare('COUNT')).toBe('count');
  });

  it('fails CLOSED on a value that is present but names no rung', () => {
    // The `grantMatch.ceilingOf` rule: a typo in the owner's own restriction
    // must not be the loosest reading of it.
    for (const bogus of ['summry', '', 'everything', 42, true, {}, []] as unknown[]) {
      expect(ceilingForShare(bogus)).toBe<DisclosureRung>('none');
    }
  });
});
