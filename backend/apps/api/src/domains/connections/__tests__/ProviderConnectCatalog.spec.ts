import { listProviderConnectCatalog } from '../catalog';

describe('ProviderConnectCatalog', () => {
  it('includes all requested connector cards with provider ids', () => {
    const entries = listProviderConnectCatalog(() => false);
    const keys = entries.map((entry) => entry.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        'google',
        'microsoft',
        'facebook',
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
        'reddit',
        'notion',
        'evernote',
        'garmin',
        'whoop',
        'fitbit',
        'monday',
        'dropbox',
        'hubspot',
        'jira',
        'xero',
        'quickbooks',
        'box',
        'plaid',
      ]),
    );

    expect(entries.every((entry) => entry.providerId.length > 0)).toBe(true);
  });

  it('marks providers connectable based on runtime callback', () => {
    const entries = listProviderConnectCatalog((providerId) =>
      ['0198779b-182c-716e-9275-b81d99a47fdb', '0198779b-3c33-73da-84e5-82e0df145260'].includes(providerId),
    );

    const google = entries.find((entry) => entry.key === 'google');
    const microsoft = entries.find((entry) => entry.key === 'microsoft');
    const discord = entries.find((entry) => entry.key === 'discord');

    expect(google?.connectable).toBe(true);
    expect(microsoft?.connectable).toBe(true);
    expect(discord?.connectable).toBe(false);
  });
});
