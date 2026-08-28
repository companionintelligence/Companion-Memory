import { PEER_TRUST_TIERS, isPeerTrustTier } from './PeerLinkEntity';

/**
 * `ci.peer_links.trust_tier` CHECKs four values while `TrustTier` has five. The
 * extra one is `household` — a member of the owner's OWN box, carrying the
 * widest ceiling in `TIER_CEILINGS` (`{'*': 'full'}`, the only tier exempt from
 * the sensitive-class floor). Widening the CHECK would have made that writable
 * for a REMOTE box, so the TYPE is what narrows.
 */
describe('PEER_TRUST_TIERS', () => {
  it('is exactly the trust tiers, minus the local-only one', () => {
    expect([...PEER_TRUST_TIERS]).toEqual(['family', 'trusted', 'peer', 'stranger']);
    expect(isPeerTrustTier('household')).toBe(false);
  });

  it('matches the CHECK on ci.peer_links.trust_tier, value for value', () => {
    // The CHECK is `IN ('family','trusted','peer','stranger')`. Anything this
    // guard admits that the CHECK does not lands as a `23514` the driver raises
    // after the statement — surfaced to a caller as a bare 500.
    for (const tier of ['family', 'trusted', 'peer', 'stranger']) {
      expect(isPeerTrustTier(tier)).toBe(true);
    }
  });

  it('refuses the things a JSON boundary actually hands you', () => {
    for (const value of [undefined, null, '', 'FAMILY', 'admin', 42, {}]) {
      expect(isPeerTrustTier(value)).toBe(false);
    }
  });
});
