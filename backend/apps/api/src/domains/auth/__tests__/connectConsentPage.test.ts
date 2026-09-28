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

  it('names the capture grant in words for a capture-tier key, not as a raw scope id', () => {
    const html = render(['capture']);
    expect(html).toContain(
      'Add files and captured activity to your memory, and set file titles and descriptions',
    );
    expect(html).not.toContain('Access &quot;capture&quot;');
    // A capture key opens no memory, intents or MCP route, so none is claimed.
    expect(html).not.toContain('Read and write your long-term memory');
    expect(html).not.toContain('Full access');
  });

  it('discloses FULL access for an empty-scope key (only an app on the reviewed allowlist gets one)', () => {
    const html = render([]);
    expect(html).toContain('Full access to your Companion data');
    // It must not understate the grant as memory-only.
    expect(html).not.toContain('Read your intent catalog');
  });
});

/**
 * This page runs under a strict, nonce-only CSP specifically because it
 * interpolates values that ride in on CI-Hub's redirect (appName, state) or
 * are otherwise not hard-coded (returnUrl/denyUrl, csrfToken, userEmail).
 * Every other test in this file only ever feeds clean fixture strings, so the
 * escaping contract itself — the thing standing between an app-supplied
 * string and HTML/attribute injection — has never actually been exercised.
 */
describe('renderConnectConsentPage HTML escaping', () => {
  // Covers all five characters escapeHtml() rewrites: & < > " '
  const RAW = `<script>alert('pwned')</script>&"quote`;
  const ESCAPED = '&lt;script&gt;alert(&#39;pwned&#39;)&lt;/script&gt;&amp;&quot;quote';

  function renderWith(overrides: Partial<ConnectConsentParams>): string {
    const params: ConnectConsentParams = {
      appUrn: 'ci-openclaw:ci-marketplace',
      appName: 'OpenClaw',
      state: 's',
      returnUrl: 'https://hub.example.com/cb',
      denyUrl: 'https://hub.example.com/cb?error=access_denied&state=s',
      csrfToken: 'csrf',
      scopes: ['memory'],
      userEmail: 'owner@example.com',
      nonce: 'test-nonce',
      ...overrides,
    };

    return renderConnectConsentPage(params);
  }

  it('escapes appName both in the visible heading and the hidden app_name field', () => {
    const html = renderWith({ appName: RAW });

    expect(html).not.toContain(RAW);
    // Visible: <span class="app">…</span>
    expect(html).toContain(`<span class="app">${ESCAPED}</span>`);
    // Hidden field carried through the CSRF self-heal round-trip.
    expect(html).toContain(`<input type="hidden" name="app_name" value="${ESCAPED}" />`);
  });

  it('escapes state in the hidden state field', () => {
    const html = renderWith({ state: RAW });

    expect(html).not.toContain(RAW);
    expect(html).toContain(`<input type="hidden" name="state" value="${ESCAPED}" />`);
  });

  it('escapes returnUrl in the hidden return field', () => {
    const html = renderWith({ returnUrl: `https://hub.example.com/cb?x=${RAW}` });

    expect(html).not.toContain(RAW);
    expect(html).toContain(
      `<input type="hidden" name="return" value="https://hub.example.com/cb?x=${ESCAPED}" />`,
    );
  });

  it('escapes denyUrl in the "Not now" link href', () => {
    const html = renderWith({ denyUrl: `https://hub.example.com/cb?error=access_denied&x=${RAW}` });

    expect(html).not.toContain(RAW);
    expect(html).toContain(
      `<a class="btn secondary" href="https://hub.example.com/cb?error=access_denied&amp;x=${ESCAPED}">Not now</a>`,
    );
  });

  it('escapes csrfToken in the hidden csrf field', () => {
    const html = renderWith({ csrfToken: RAW });

    expect(html).not.toContain(RAW);
    expect(html).toContain(`<input type="hidden" name="csrf" value="${ESCAPED}" />`);
  });

  it('escapes userEmail in the "Signed in as" line', () => {
    const html = renderWith({ userEmail: RAW });

    expect(html).not.toContain(RAW);
    expect(html).toContain(`<strong><!--email_off-->${ESCAPED}<!--/email_off--></strong>`);
  });

  it('escapes an unrecognized scope name in the fallback capability line', () => {
    // capabilityLinesForScopes falls back to `Access "${scope}"` for any scope
    // outside the known set (memory/intents/mcp/capture) — that interpolation must be
    // escaped like every other rendered field.
    const html = renderWith({ scopes: [RAW] });

    expect(html).not.toContain(RAW);
    expect(html).toContain(`<li>Access &quot;${ESCAPED}&quot;</li>`);
  });
});
