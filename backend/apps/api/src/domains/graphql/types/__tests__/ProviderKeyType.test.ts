import type { ProviderKey } from '@ci/domains/connections';

import { ProviderKeyType } from '../ProviderKeyType';

const key = (clientSecret: string): ProviderKey =>
  ({
    id: '019e2b55-a4c1-7f02-b8d4-0c3e5a8f6b07',
    providerId: '019e2b55-a4c1-7f02-b8d4-0c3e5a8f6b08',
    userId: '019e2b55-a4c1-7f02-b8d4-0c3e5a8f6b09',
    clientId: 'client-id',
    clientSecret,
    createdAt: new Date('2026-09-09T00:00:00Z'),
    updatedAt: new Date('2026-09-09T00:00:00Z'),
  }) as ProviderKey;

describe('ProviderKeyType', () => {
  it('never carries the client secret, only whether one is stored and a short hint', () => {
    const type = ProviderKeyType.toType(key('abcdefghijklmnop-secret'));

    // `__source` is the raw entity kept for resolvers and loaders; it is not a
    // GraphQL field and never reaches a client. Everything else on the type is.
    const { __source, ...exposed } = type;

    expect(__source.clientSecret).toBe('abcdefghijklmnop-secret');
    expect(exposed).not.toHaveProperty('clientSecret');
    expect(exposed.hasClientSecret).toBe(true);
    expect(exposed.clientSecretHint).toBe('cret');
    expect(JSON.stringify(exposed)).not.toContain('abcdefghijklmnop');
  });

  it('offers no hint for a short secret, where four characters would give too much away', () => {
    expect(ProviderKeyType.hintFor('short')).toBeNull();
    expect(ProviderKeyType.hintFor('')).toBeNull();
    expect(ProviderKeyType.hintFor(null)).toBeNull();
    expect(ProviderKeyType.toType(key('')).hasClientSecret).toBe(false);
  });
});
