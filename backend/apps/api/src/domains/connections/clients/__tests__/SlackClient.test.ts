import { getSlackScopesFromActiveEndpoints } from '@ci/domains/connections/clients/SlackClient';

describe('getSlackScopesFromActiveEndpoints', () => {
  const endpointScopeMap = {
    Messages: [
      'channels:history',
      'groups:history',
      'im:history',
      'mpim:history',
      'channels:read',
      'groups:read',
      'im:read',
      'mpim:read',
      'users:read',
    ],
    Channels: ['channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'],
    default: ['users:read'],
  };

  it('returns default scopes when no endpoints are active', () => {
    expect(getSlackScopesFromActiveEndpoints([], endpointScopeMap)).toBe('users:read');
  });

  it('includes history scopes for messages endpoint', () => {
    const scopes = getSlackScopesFromActiveEndpoints(['Messages'], endpointScopeMap).split(',');

    expect(scopes).toEqual(expect.arrayContaining(['channels:history', 'im:history', 'users:read']));
  });

  it('merges scopes for messages and channels endpoints', () => {
    const scopes = getSlackScopesFromActiveEndpoints(['Messages', 'Channels'], endpointScopeMap).split(',');

    expect(scopes).toEqual(expect.arrayContaining(['channels:read', 'channels:history']));
  });
});
