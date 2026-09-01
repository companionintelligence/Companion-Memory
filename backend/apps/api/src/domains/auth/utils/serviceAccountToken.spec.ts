import {
  extractServiceClientId,
  parseAllowedServiceClients,
  parseScopes,
  resolveServiceAccount,
} from './serviceAccountToken';

const ALLOWED = ['hbpe-sidecar', 'summary-sidecar'] as const;

describe('parseAllowedServiceClients', () => {
  it('splits, trims and de-duplicates a comma-separated list', () => {
    expect(parseAllowedServiceClients(' hbpe-sidecar , summary-sidecar , hbpe-sidecar ')).toEqual([
      'hbpe-sidecar',
      'summary-sidecar',
    ]);
  });

  it('returns an empty list for empty / nullish input', () => {
    expect(parseAllowedServiceClients('')).toEqual([]);
    expect(parseAllowedServiceClients(undefined)).toEqual([]);
    expect(parseAllowedServiceClients(null)).toEqual([]);
    expect(parseAllowedServiceClients('  ,  , ')).toEqual([]);
  });
});

describe('parseScopes', () => {
  it('splits a space-delimited scope claim and de-duplicates', () => {
    expect(parseScopes('memory:read memory:write memory:read')).toEqual(['memory:read', 'memory:write']);
  });

  it('collapses arbitrary whitespace and ignores non-strings', () => {
    expect(parseScopes('  memory:read\tmemory:write  ')).toEqual(['memory:read', 'memory:write']);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes(42)).toEqual([]);
  });
});

describe('extractServiceClientId', () => {
  it('prefers the RFC 8693 act.sub actor claim', () => {
    expect(
      extractServiceClientId({ act: { sub: 'hbpe-sidecar' }, client_id: 'ignored', azp: 'ignored' }),
    ).toBe('hbpe-sidecar');
  });

  it('falls back to client_id, then azp', () => {
    expect(extractServiceClientId({ client_id: 'hbpe-sidecar' })).toBe('hbpe-sidecar');
    expect(extractServiceClientId({ azp: 'summary-sidecar' })).toBe('summary-sidecar');
  });

  it('trims whitespace and rejects blank / non-string values', () => {
    expect(extractServiceClientId({ client_id: '  hbpe-sidecar  ' })).toBe('hbpe-sidecar');
    expect(extractServiceClientId({ client_id: '   ' })).toBeNull();
    expect(extractServiceClientId({ client_id: 123 })).toBeNull();
    expect(extractServiceClientId({})).toBeNull();
    expect(extractServiceClientId({ act: { sub: '' }, client_id: 'hbpe-sidecar' })).toBe('hbpe-sidecar');
  });
});

describe('resolveServiceAccount', () => {
  it('resolves an allow-listed service token acting on behalf of a user', () => {
    expect(
      resolveServiceAccount(
        { sub: 'user-123', client_id: 'hbpe-sidecar', scope: 'memory:read memory:write' },
        ALLOWED,
      ),
    ).toEqual({
      clientId: 'hbpe-sidecar',
      onBehalfOfUserId: 'user-123',
      scopes: ['memory:read', 'memory:write'],
    });
  });

  it('resolves via the act.sub actor claim from token exchange', () => {
    expect(resolveServiceAccount({ sub: 'user-9', act: { sub: 'summary-sidecar' } }, ALLOWED)).toEqual({
      clientId: 'summary-sidecar',
      onBehalfOfUserId: 'user-9',
      scopes: [],
    });
  });

  it('returns null for a client id that is not allow-listed (a human login)', () => {
    expect(resolveServiceAccount({ sub: 'user-1', client_id: 'ci-browser-extension' }, ALLOWED)).toBeNull();
    expect(resolveServiceAccount({ sub: 'user-1', email: 'a@b.com' }, ALLOWED)).toBeNull();
  });

  it('rejects a service token with no sub — a service must never be user-less', () => {
    expect(resolveServiceAccount({ client_id: 'hbpe-sidecar' }, ALLOWED)).toBeNull();
    expect(resolveServiceAccount({ sub: '   ', client_id: 'hbpe-sidecar' }, ALLOWED)).toBeNull();
  });

  it('returns null when the allow-list is empty (feature disabled)', () => {
    expect(resolveServiceAccount({ sub: 'user-1', client_id: 'hbpe-sidecar' }, [])).toBeNull();
  });

  it('trims the resolved on-behalf-of user id', () => {
    expect(resolveServiceAccount({ sub: '  user-123  ', client_id: 'hbpe-sidecar' }, ALLOWED)).toEqual({
      clientId: 'hbpe-sidecar',
      onBehalfOfUserId: 'user-123',
      scopes: [],
    });
  });
});
