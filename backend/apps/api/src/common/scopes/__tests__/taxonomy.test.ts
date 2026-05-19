import { matchScope, matchScopes, missingScopes, SCOPES } from '../taxonomy';

describe('scope matching', () => {
  describe('matchScope', () => {
    it('returns true on exact match', () => {
      expect(matchScope(['memory:read'], 'memory:read')).toBe(true);
    });

    it('returns false when nothing matches', () => {
      expect(matchScope(['memory:read'], 'memory:write')).toBe(false);
      expect(matchScope([], 'memory:read')).toBe(false);
    });

    it('respects the global * wildcard', () => {
      expect(matchScope(['*'], 'memory:read')).toBe(true);
      expect(matchScope(['*'], 'admin:write')).toBe(true);
    });

    it('respects family wildcards (memory:*)', () => {
      expect(matchScope(['memory:*'], 'memory:read')).toBe(true);
      expect(matchScope(['memory:*'], 'memory:write:semantic')).toBe(true);
      expect(matchScope(['memory:*'], 'profile:read')).toBe(false);
    });

    it('respects nested wildcards (tools:invoke:*)', () => {
      expect(matchScope(['tools:invoke:*'], 'tools:invoke:web-search')).toBe(true);
      expect(matchScope(['tools:invoke:*'], 'tools:write')).toBe(false);
    });

    it('respects verb wildcards (*:read)', () => {
      expect(matchScope(['*:read'], 'memory:read')).toBe(true);
      expect(matchScope(['*:read'], 'profile:read')).toBe(true);
      expect(matchScope(['*:read'], 'memory:write')).toBe(false);
    });
  });

  describe('matchScopes', () => {
    it('passes when no scopes are required', () => {
      expect(matchScopes([], [])).toBe(true);
      expect(matchScopes(['anything'], [])).toBe(true);
    });

    it('requires every required scope to be matched', () => {
      expect(matchScopes(['memory:read', 'profile:read'], ['memory:read', 'profile:read'])).toBe(true);
      expect(matchScopes(['memory:read'], ['memory:read', 'profile:read'])).toBe(false);
    });

    it('admin wildcard covers any required scope', () => {
      expect(matchScopes(['*'], ['memory:write', 'admin:write', 'devices:ingest'])).toBe(true);
    });
  });

  describe('missingScopes', () => {
    it('lists only the unmatched required scopes', () => {
      expect(missingScopes(['memory:read'], ['memory:read', 'memory:write'])).toEqual(['memory:write']);
      expect(missingScopes(['memory:*'], ['memory:read', 'memory:write'])).toEqual([]);
    });
  });

  describe('SCOPES taxonomy', () => {
    it('has no duplicate string values', () => {
      const values = Object.values(SCOPES);
      expect(new Set(values).size).toBe(values.length);
    });
  });
});
