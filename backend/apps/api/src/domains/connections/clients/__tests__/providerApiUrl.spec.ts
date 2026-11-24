import { providerApiUrl } from '../providerApiUrl';

describe('providerApiUrl', () => {
  it('puts a path on the base URL', () => {
    expect(providerApiUrl('https://slack.com/api', '/conversations.list')).toBe(
      'https://slack.com/api/conversations.list',
    );
    expect(providerApiUrl('https://graph.facebook.com', '/v21.0/me/photos?type=uploaded')).toBe(
      'https://graph.facebook.com/v21.0/me/photos?type=uploaded',
    );
  });

  it("follows a pagination link or cursor on the provider's own API", () => {
    expect(
      providerApiUrl('https://graph.facebook.com', 'https://graph.facebook.com/v21.0/me/photos?after=x'),
    ).toBe('https://graph.facebook.com/v21.0/me/photos?after=x');
    expect(
      providerApiUrl('https://api.dropboxapi.com', 'https://content.dropboxapi.com/2/files/download'),
    ).toBe('https://content.dropboxapi.com/2/files/download');
    expect(
      providerApiUrl('https://www.googleapis.com', 'https://gmail.googleapis.com/gmail/v1/users/me/messages'),
    ).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    expect(providerApiUrl('https://api.github.com', 'https://api.github.com/user/events?page=2')).toBe(
      'https://api.github.com/user/events?page=2',
    );
  });

  it.each([
    ['another host', 'https://attacker.example/collect'],
    ['a look-alike that only ends with the domain', 'https://evilgraph.facebook.com.attacker.example/x'],
    ['a host that merely ends in the same letters', 'https://notfacebook.com/x'],
    ['plain http on the right host', 'http://graph.facebook.com/x'],
    ['credentials in the URL', 'https://user:pass@graph.facebook.com/x'],
  ])('refuses %s, before any request is made', (_case, url) => {
    expect(() => providerApiUrl('https://graph.facebook.com', url)).toThrow(/Refusing to send/);
  });

  it('admits a host the client names outside its domain', () => {
    expect(providerApiUrl('https://api.example.com', 'https://cdn.partner.net/x', ['cdn.partner.net'])).toBe(
      'https://cdn.partner.net/x',
    );
  });
});
