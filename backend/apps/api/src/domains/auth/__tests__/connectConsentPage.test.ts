import { renderConnectConsentPage, type ConnectConsentParams } from '../utils/connectConsentPage';

/**
 * The consent page must disclose exactly what the minted key will grant, so
 * consent matches the key (both read `scopesForApp`). Especially: a full-access
 * (empty-scope) key must be shown as full access, not mislabeled "memory only".
 */
function render(scopes: string[]): string {
  const params: ConnectConsentParams = {
    appUrn: 'ci-openclaw:ci-marketplace',
    appName: 'OpenClaw',
    state: 's',
    returnUrl: 'https://hub.example.com/cb',
    denyUrl: 'https://hub.example.com/cb?error=access_denied&state=s',
    csrfToken: 'csrf',
    scopes,
    userEmail: 'owner@example.com',
    nonce: 'test-nonce',
  };

  return renderConnectConsentPage(params);
}

describe('renderConnectConsentPage capability disclosure', () => {
  it('lists memory + intents + MCP for a chat-agent-tier key', () => {
    const html = render(['memory', 'intents', 'mcp']);
    expect(html).toContain('<ul class="caps">');
    expect(html).toContain('Read and write your long-term memory');
    expect(html).toContain('Read your intent catalog');
    expect(html).toContain('Use your memory tools (MCP)');
    expect(html).not.toContain('Full access');
  });

  it('discloses FULL access for an empty-scope (bulk importer) key', () => {
    const html = render([]);
    expect(html).toContain('Full access to your Companion data');
    // It must not understate the grant as memory-only.
    expect(html).not.toContain('Read your intent catalog');
  });
});
