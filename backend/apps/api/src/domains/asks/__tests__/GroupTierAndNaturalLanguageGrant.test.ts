import { BadRequestException } from '@nestjs/common';

import { parseNaturalLanguageGrant } from '../askInput';
import { groupDisclosureCeiling, minTrustTier, resolveGroupTier } from '../policy';

describe('Group-thread trust-tier floor clamping & natural-language grants (open-instinct pattern)', () => {
  describe('minTrustTier & resolveGroupTier', () => {
    it('returns the stricter (lower-trust) of two trust tiers', () => {
      expect(minTrustTier('household', 'family')).toBe('family');
      expect(minTrustTier('family', 'trusted')).toBe('trusted');
      expect(minTrustTier('trusted', 'peer')).toBe('peer');
      expect(minTrustTier('peer', 'stranger')).toBe('stranger');
    });

    it('clamps multi-party / group threads to the strictest participant tier', () => {
      expect(resolveGroupTier(['household', 'family', 'peer'])).toBe('peer');
      expect(resolveGroupTier(['family', 'trusted', 'stranger'])).toBe('stranger');
      expect(resolveGroupTier(['household', 'family'])).toBe('family');
      expect(resolveGroupTier([])).toBe('stranger');
    });

    it('groupDisclosureCeiling prevents family/household disclosures when a lower-tier participant is in the thread', () => {
      // A family member alone can receive 'redacted' on location, but adding a 'peer' clamps to 'none' (sensitive class below family)
      expect(groupDisclosureCeiling(['family'], 'location')).toBe('redacted');
      expect(groupDisclosureCeiling(['family', 'peer'], 'location')).toBe('none');
      // For photos, family + peer clamps to peer's ceiling ('summary')
      expect(groupDisclosureCeiling(['family', 'peer'], 'photos')).toBe('summary');
    });
  });

  describe('parseNaturalLanguageGrant', () => {
    const fixedNow = new Date('2026-10-20T12:00:00.000Z');

    it('parses an allow instruction with peer handle, photos dataClass, and day duration', () => {
      const parsed = parseNaturalLanguageGrant(
        'Allow alice@portal.example to ask about photos for 7 days',
        fixedNow,
      );

      expect(parsed).toEqual({
        grantee: 'alice@portal.example',
        queryType: 'content',
        dataClass: 'photos',
        mode: 'auto',
        expiresAt: '2026-10-27T12:00:00.000Z',
      });
    });

    it('parses an availability grant with "this week" relative expiry and explicit disclosure rung', () => {
      const parsed = parseNaturalLanguageGrant(
        'Let bob check my availability this week with boolean disclosure',
        fixedNow,
      );

      expect(parsed).toEqual({
        grantee: 'bob',
        queryType: 'availability',
        dataClass: 'calendar',
        mode: 'auto',
        maxDisclosure: 'boolean',
        expiresAt: '2026-10-27T12:00:00.000Z',
      });
    });

    it('parses a block instruction and forces maxDisclosure to none', () => {
      const parsed = parseNaturalLanguageGrant('Block mallory@portal.example from location', fixedNow);

      expect(parsed).toEqual({
        grantee: 'mallory@portal.example',
        queryType: 'attribute',
        dataClass: 'location',
        mode: 'block',
        maxDisclosure: 'none',
      });
    });

    it('parses a review instruction with hour duration', () => {
      const parsed = parseNaturalLanguageGrant(
        'Review charlie on contacts at most summary for 24 hours',
        fixedNow,
      );

      expect(parsed).toEqual({
        grantee: 'charlie',
        queryType: 'relationship',
        dataClass: 'contacts',
        mode: 'review',
        maxDisclosure: 'summary',
        expiresAt: '2026-10-21T12:00:00.000Z',
      });
    });

    it('rejects empty or unparseable grant strings', () => {
      expect(() => parseNaturalLanguageGrant('')).toThrow(BadRequestException);
      expect(() => parseNaturalLanguageGrant('   ')).toThrow(BadRequestException);
    });
  });
});
