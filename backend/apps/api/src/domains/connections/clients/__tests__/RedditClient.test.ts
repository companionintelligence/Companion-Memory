import { getRedditScopesFromActiveEndpoints } from '@ci/domains/connections/clients/RedditClient';

describe('getRedditScopesFromActiveEndpoints', () => {
  const endpointScopeMap = {
    Posts: ['history', 'read', 'identity'],
    Comments: ['history', 'read', 'identity'],
    Saved: ['history', 'read', 'save', 'identity'],
    default: ['identity', 'read'],
  };

  it('returns default scopes when no endpoints are active', () => {
    expect(getRedditScopesFromActiveEndpoints([], endpointScopeMap)).toBe('identity read');
  });

  it('merges scopes for posts and comments', () => {
    const scopes = getRedditScopesFromActiveEndpoints(['Posts', 'Comments'], endpointScopeMap).split(' ');

    expect(scopes).toEqual(expect.arrayContaining(['identity', 'read', 'history']));
    expect(scopes).not.toContain('save');
  });

  it('includes save scope when saved endpoint is active', () => {
    const scopes = getRedditScopesFromActiveEndpoints(['Saved'], endpointScopeMap).split(' ');

    expect(scopes).toEqual(expect.arrayContaining(['save', 'history', 'read', 'identity']));
  });
});
