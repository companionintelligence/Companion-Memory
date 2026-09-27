const connect = { hubOrigins: 'https://hub.example.com' };

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      auth: {
        ...actual.auth,
        get connect() {
          return connect;
        },
      },
    },
  };
});

import { ConnectService, capabilityForApp, scopesForApp } from '../services/ConnectService';

/**
 * Unit tests for ConnectService — the connect-flow orchestration and its
 * security-relevant invariants (session resolution, return-origin allowlisting,
 * scoped/expiring key minting, and app-scoped revoke).
 */
function makeDeps() {
  const authService = { validateSessionToken: jest.fn() };
  const userService = { findById: jest.fn() };
  const apiKeyService = {
    createOrRotate: jest.fn(),
    findByName: jest.fn(),
    removeByName: jest.fn(),
    findUserIdByName: jest.fn(),
  };
  const connectCodeService = { issue: jest.fn(), consume: jest.fn() };
  const logger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };

  const service = new ConnectService(
    authService as never,
    userService as never,
    apiKeyService as never,
    connectCodeService as never,
    logger as never,
  );

  return { service, authService, userService, apiKeyService, connectCodeService };
}

describe('ConnectService.resolveSessionUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when no session cookie is present', async () => {
    const { service } = makeDeps();
    expect(await service.resolveSessionUser(undefined)).toBeNull();
  });

  it('resolves the user when the session token is valid and the user exists', async () => {
    const { service, authService, userService } = makeDeps();
    authService.validateSessionToken.mockReturnValue({ sub: 'user-1' });
    userService.findById.mockResolvedValue({ id: 'user-1', email: 'owner@example.com' });

    expect(await service.resolveSessionUser('tok')).toEqual({ userId: 'user-1', email: 'owner@example.com' });
  });

  it('returns null when the session token fails verification', async () => {
    const { service, authService } = makeDeps();
    authService.validateSessionToken.mockImplementation(() => {
      throw new Error('bad token');
    });

    expect(await service.resolveSessionUser('tok')).toBeNull();
  });

  it('returns null when the token is valid but the user no longer exists', async () => {
    const { service, authService, userService } = makeDeps();
    authService.validateSessionToken.mockReturnValue({ sub: 'ghost' });
    userService.findById.mockResolvedValue(null);

    expect(await service.resolveSessionUser('tok')).toBeNull();
  });
});

describe('ConnectService.isReturnUrlAllowed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    connect.hubOrigins = 'https://hub.example.com';
  });

  it('allows a URL whose origin is on the allowlist', () => {
    const { service } = makeDeps();
    expect(service.isReturnUrlAllowed('https://hub.example.com/apps/x/callback?a=1')).toBe(true);
  });

  it('rejects a URL on a different origin', () => {
    const { service } = makeDeps();
    expect(service.isReturnUrlAllowed('https://evil.example.com/callback')).toBe(false);
  });

  it('rejects a malformed URL', () => {
    const { service } = makeDeps();
    expect(service.isReturnUrlAllowed('not a url')).toBe(false);
  });

  it('rejects everything when no origins are configured', () => {
    connect.hubOrigins = '';
    const { service } = makeDeps();
    expect(service.isReturnUrlAllowed('https://hub.example.com/x')).toBe(false);
  });

  it('supports multiple comma-separated origins', () => {
    connect.hubOrigins = 'https://a.example.com, https://b.example.com';
    const { service } = makeDeps();
    expect(service.isReturnUrlAllowed('https://b.example.com/x')).toBe(true);
  });
});

describe('ConnectService.approve', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues a one-time code WITHOUT minting a key (the mint is deferred to exchange)', async () => {
    const { service, apiKeyService, connectCodeService } = makeDeps();
    connectCodeService.issue.mockResolvedValue('one-time-code');

    const result = await service.approve('user-1', 'urn:app:x');

    expect(connectCodeService.issue).toHaveBeenCalledWith('user-1', 'urn:app:x');
    // No key is minted at consent time — an abandoned flow must not rotate away
    // (and destroy) an app's existing, still-injected key.
    expect(apiKeyService.createOrRotate).not.toHaveBeenCalled();
    expect(result).toEqual({ code: 'one-time-code' });
  });
});

describe('ConnectService.exchange', () => {
  beforeEach(() => jest.clearAllMocks());

  it("mints a per-app-scoped, ~90d-expiring key named app:<urn> under the code's bound user on redemption", async () => {
    const { service, apiKeyService, connectCodeService } = makeDeps();
    connectCodeService.consume.mockResolvedValue({ userId: 'user-1', appUrn: 'ci-openclaw:ci-marketplace' });
    apiKeyService.createOrRotate.mockResolvedValue({ key: 'raw-key' });

    const result = await service.exchange('one-time-code');

    const [ctx, data] = apiKeyService.createOrRotate.mock.calls[0];
    expect(ctx).toEqual({ userId: 'user-1' });
    expect(data.name).toBe('app:ci-openclaw:ci-marketplace');
    // Scopes come from scopesForApp (the same source the consent page reads).
    expect(data.scopes).toEqual(['memory', 'intents', 'mcp']);
    // Capability is CHOSEN at mint time, not inherited from the api-key default.
    // `full` for the two paired harnesses, not because they are trusted with
    // deletion but because the managed-app rule in `resolveToolGate` turns their
    // destructive attempts into approval cards. `write` refused those calls
    // BEFORE the gate could queue them, so the card was unreachable and a
    // refusal the owner could not answer is an outage, not a policy.
    expect(data.capability).toBe('full');
    const ttlDays = (new Date(data.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(ttlDays).toBeGreaterThan(89);
    expect(ttlDays).toBeLessThan(91);
    // The returned expiry is the same instant handed to the key mint.
    expect(result).toEqual({
      appUrn: 'ci-openclaw:ci-marketplace',
      key: 'raw-key',
      expiresAt: data.expires_at,
    });
  });

  it('mints an empty-scope (full-access) key for the bulk importer', async () => {
    const { service, apiKeyService, connectCodeService } = makeDeps();
    connectCodeService.consume.mockResolvedValue({
      userId: 'user-1',
      appUrn: 'ci-import-tools:ci-marketplace',
    });
    apiKeyService.createOrRotate.mockResolvedValue({ key: 'raw-key' });

    await service.exchange('one-time-code');

    const [, data] = apiKeyService.createOrRotate.mock.calls[0];
    expect(data.scopes).toEqual([]);
    // Full SURFACE (empty scopes) still does not mean full authority — the
    // importer is minted `write`, so it can never delete.
    expect(data.capability).toBe('write');
  });

  it('mints an explicitly-stated capability for an app nobody enumerated', async () => {
    const { service, apiKeyService, connectCodeService } = makeDeps();
    connectCodeService.consume.mockResolvedValue({
      userId: 'user-1',
      appUrn: 'some-third-party-app:ci-marketplace',
    });
    apiKeyService.createOrRotate.mockResolvedValue({ key: 'raw-key' });

    await service.exchange('one-time-code');

    const [, data] = apiKeyService.createOrRotate.mock.calls[0];
    // Not `undefined` — the whole point is that the mint states a level rather
    // than letting ApiKeyService fall back to DEFAULT_API_KEY_CAPABILITY.
    expect(data.capability).toBe('write');
  });

  it('mints a memory-only, write-capability key for the ci-mentra glasses bridge', async () => {
    const { service, apiKeyService, connectCodeService } = makeDeps();
    connectCodeService.consume.mockResolvedValue({ userId: 'user-1', appUrn: 'ci-mentra:ci-marketplace' });
    apiKeyService.createOrRotate.mockResolvedValue({ key: 'raw-key' });

    await service.exchange('one-time-code');

    const [, data] = apiKeyService.createOrRotate.mock.calls[0];
    expect(data.name).toBe('app:ci-mentra:ci-marketplace');
    // NOT the empty (full-surface) default — the bridge only touches /memory/*.
    expect(data.scopes).toEqual(['memory']);
    expect(data.capability).toBe('write');
  });

  it('returns null for an invalid/expired/used code without minting', async () => {
    const { service, apiKeyService, connectCodeService } = makeDeps();
    connectCodeService.consume.mockResolvedValue(null);

    expect(await service.exchange('bad-code')).toBeNull();
    expect(apiKeyService.createOrRotate).not.toHaveBeenCalled();
  });
});

describe('ConnectService.buildReturnUrl', () => {
  it('carries the one-time code and state back to the Hub', () => {
    const { service } = makeDeps();
    const url = new URL(service.buildReturnUrl('https://hub.example.com/cb', 'the-code', 'the-state'));

    expect(url.searchParams.get('code')).toBe('the-code');
    expect(url.searchParams.get('state')).toBe('the-state');
  });
});

describe('ConnectService.revokeByApp', () => {
  beforeEach(() => jest.clearAllMocks());

  it('revokes by the stable app:<urn> key name and returns the count', async () => {
    const { service, apiKeyService } = makeDeps();
    apiKeyService.removeByName.mockResolvedValue(1);

    const removed = await service.revokeByApp('urn:app:x');

    expect(apiKeyService.removeByName).toHaveBeenCalledWith('app:urn:app:x');
    expect(removed).toBe(1);
  });
});

describe('ConnectService.rotateByApp', () => {
  beforeEach(() => jest.clearAllMocks());

  it('re-mints under the same owner with freshly-derived per-app scopes', async () => {
    const { service, apiKeyService } = makeDeps();
    apiKeyService.findUserIdByName.mockResolvedValue('user-1');
    apiKeyService.createOrRotate.mockResolvedValue({ key: 'rotated-key' });

    const result = await service.rotateByApp('ci-openclaw:ci-marketplace');

    expect(apiKeyService.findUserIdByName).toHaveBeenCalledWith('app:ci-openclaw:ci-marketplace');
    const [ctx, data] = apiKeyService.createOrRotate.mock.calls[0];
    expect(ctx).toEqual({ userId: 'user-1' });
    // A rotate re-derives scopes AND capability, so it also heals a key minted
    // under an older policy (including one minted before capability was chosen).
    expect(data.scopes).toEqual(['memory', 'intents', 'mcp']);
    expect(data.capability).toBe('full');
    expect(result?.key).toBe('rotated-key');
  });

  it('returns null (no rotate) when the owner is unresolvable (unknown or multi-owner)', async () => {
    const { service, apiKeyService } = makeDeps();
    apiKeyService.findUserIdByName.mockResolvedValue(null);

    expect(await service.rotateByApp('ci-hermes:ci-marketplace')).toBeNull();
    expect(apiKeyService.createOrRotate).not.toHaveBeenCalled();
  });
});

describe('capabilityForApp (authority chosen per app, never inherited)', () => {
  /**
   * The two harnesses whose destructive calls are queued as approval cards by
   * `resolveToolGate`'s `managed-app` rule. Their `full` is only defensible
   * BECAUSE of that rule, so this list and that rule must move together — see
   * the invariant test at the bottom of this block.
   */
  const GATED_HARNESSES = ['ci-openclaw:ci-marketplace', 'ci-hermes:ci-marketplace'];

  it('gives the gated harnesses full — the card is the control, not the capability', () => {
    // This assertion was `write` until the managed-app gate landed, and the two
    // changed together on purpose. `write` looked like the safer number and was
    // strictly worse: `capabilityAllows` refuses a destructive intent below
    // `full` BEFORE the gate runs, and a deny is never laundered into a queue —
    // so the harness got a flat 403 and the owner never saw a card. The
    // authority is wider; the reachable behaviour is narrower, because now the
    // owner is asked instead of the agent being stonewalled.
    for (const appUrn of GATED_HARNESSES) {
      expect(capabilityForApp(appUrn)).toBe('full');
    }
  });

  it('gives the bulk importer write, not full — full surface is not full authority', () => {
    expect(capabilityForApp('ci-import-tools:ci-marketplace')).toBe('write');
  });

  it('gives the ci-mentra glasses bridge write — it records turns but is not gated', () => {
    expect(capabilityForApp('ci-mentra:ci-marketplace')).toBe('write');
    expect(capabilityForApp('ci-mentra:some-other-store')).toBe('write');
  });

  it('defaults an unknown app to the narrow write level', () => {
    expect(capabilityForApp('some-third-party-app:ci-marketplace')).toBe('write');
  });

  it('mints full ONLY for an app paired with the confirmation gate', () => {
    // The surviving half of the old "never mints a destructive key for any app
    // URN". That blanket claim is gone deliberately, but the narrow one is what
    // actually protected anything and it is now load-bearing: an app added to
    // this switch without a matching entry in the gate would hold real
    // destructive authority with nothing asking the owner first.
    for (const appUrn of [
      'ci-import-tools:ci-marketplace',
      'some-third-party-app:some-other-store',
      'ci-openclaw-lookalike:ci-marketplace',
      'not-ci-hermes:ci-marketplace',
      'ci-mentra:ci-marketplace',
    ]) {
      expect(capabilityForApp(appUrn)).not.toBe('full');
    }
  });

  it('keys on the app name segment, ignoring the store', () => {
    // Which also means a harness keeps its gated capability from any store —
    // the pairing is with the APP, not with where it was installed from.
    expect(capabilityForApp('ci-openclaw:some-other-store')).toBe('full');
    expect(capabilityForApp('ci-import-tools:some-other-store')).toBe('write');
  });
});

describe('scopesForApp (two-tier least-privilege)', () => {
  it('confines the chat agents to the memory/intents/mcp tier', () => {
    expect(scopesForApp('ci-openclaw:ci-marketplace')).toEqual(['memory', 'intents', 'mcp']);
    expect(scopesForApp('ci-hermes:ci-marketplace')).toEqual(['memory', 'intents', 'mcp']);
  });

  it('confines the ci-mentra glasses bridge to the memory scope only', () => {
    expect(scopesForApp('ci-mentra:ci-marketplace')).toEqual(['memory']);
    expect(scopesForApp('ci-mentra:some-other-store')).toEqual(['memory']);
    // Must never fall through to the empty (full-access) default.
    expect(scopesForApp('ci-mentra:ci-marketplace')).not.toEqual([]);
  });

  it('gives the bulk importer full access (empty scopes)', () => {
    expect(scopesForApp('ci-import-tools:ci-marketplace')).toEqual([]);
  });

  it('defaults any unknown app to full access (never breaks an un-analyzed app)', () => {
    expect(scopesForApp('some-third-party-app:ci-marketplace')).toEqual([]);
  });

  it('keys on the app name segment, ignoring the store', () => {
    expect(scopesForApp('ci-openclaw:some-other-store')).toEqual(['memory', 'intents', 'mcp']);
  });
});
