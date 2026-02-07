import {
  getOAuthEnvVarNames,
  getProviderCatalogByProviderId,
  listProviderCatalog,
  resolveOAuthCredentials,
} from '../catalog';

describe('ProviderCatalog', () => {
  it('includes implemented providers with persisted provider ids', () => {
    const activeProviders = listProviderCatalog('active');
    const activeKeys = activeProviders.map((provider) => provider.key);

    expect(activeKeys).toEqual(expect.arrayContaining(['google', 'microsoft', 'facebook']));
    expect(activeProviders.every((provider) => provider.providerId)).toBe(true);
  });

  it('includes planned integrations currently listed on the connect page', () => {
    const plannedProviders = listProviderCatalog('planned');
    const plannedKeys = plannedProviders.map((provider) => provider.key);

    expect(plannedKeys).toEqual(
      expect.arrayContaining([
        'discord',
        'github',
        'instagram',
        'shopify',
        'signal',
        'slack',
        'spotify',
        'steam',
        'x',
        'linkedin',
        'notion',
        'twitch',
        'reddit',
        'dropbox',
        'evernote',
        'garmin',
        'whoop',
        'fitbit',
        'monday',
        'hubspot',
        'jira',
        'xero',
        'quickbooks',
        'box',
        'plaid',
      ]),
    );
  });

  it('tracks legacy backlog providers from LifeScope fixtures', () => {
    const plannedProviders = listProviderCatalog('planned');
    const plannedKeys = plannedProviders.map((provider) => provider.key);

    expect(plannedKeys).toEqual(expect.arrayContaining(['pinterest', 'lyft', 'uber']));
  });

  it('returns provider entry by persisted provider id', () => {
    const google = getProviderCatalogByProviderId('0198779b-182c-716e-9275-b81d99a47fdb');

    expect(google?.key).toBe('google');
    expect(google?.streams.some((stream) => stream.key === 'Gmail')).toBe(true);
  });

  it('includes Facebook profile stream used by current sync responses', () => {
    const facebook = listProviderCatalog('active').find((provider) => provider.key === 'facebook');

    expect(facebook?.streams.some((stream) => stream.key === 'Profile')).toBe(true);
    expect(facebook?.streams.some((stream) => stream.scopeAliases?.includes('facebook profile'))).toBe(true);
  });

  it('assigns stable provider ids for every catalog connector entry', () => {
    const entries = listProviderCatalog();

    expect(entries.every((entry) => !!entry.providerId)).toBe(true);
  });

  it('builds oauth environment variable candidates using new and legacy conventions', () => {
    const names = getOAuthEnvVarNames('0198779b-182c-716e-9275-b81d99a47fdb', 'Google');

    expect(names.clientIdVars).toEqual(
      expect.arrayContaining(['PROVIDER_GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID']),
    );
    expect(names.clientSecretVars).toEqual(
      expect.arrayContaining(['PROVIDER_GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET']),
    );
  });

  it('resolves oauth credentials from the first available configured variables', () => {
    const resolution = resolveOAuthCredentials('0198779b-182c-716e-9275-b81d99a47fdb', 'Google', {
      PROVIDER_GOOGLE_CLIENT_ID: 'provider-google-client-id',
      PROVIDER_GOOGLE_CLIENT_SECRET: 'provider-google-client-secret',
    });

    expect(resolution.clientId).toBe('provider-google-client-id');
    expect(resolution.clientSecret).toBe('provider-google-client-secret');
  });

  it('defines mock and test token env conventions for every provider', () => {
    const entries = listProviderCatalog();

    for (const entry of entries) {
      expect(entry.auth.env.modeVar).toBe(`PROVIDER_${entry.key.toUpperCase()}_MODE`);
      expect(entry.auth.env.mockBaseUrlVar).toBe(`PROVIDER_${entry.key.toUpperCase()}_MOCK_BASE_URL`);
      expect(entry.auth.env.testAccessTokenVar).toBe(`PROVIDER_${entry.key.toUpperCase()}_TEST_ACCESS_TOKEN`);
      expect(entry.auth.env.testRefreshTokenVar).toBe(
        `PROVIDER_${entry.key.toUpperCase()}_TEST_REFRESH_TOKEN`,
      );
    }
  });
});
