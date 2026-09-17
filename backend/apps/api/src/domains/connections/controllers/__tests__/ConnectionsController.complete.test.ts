import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { type CompleteConnectionDto, completeConnectionSchema } from '../../types';
import { ConnectionsController } from '../ConnectionsController';

/*
 * CI-Server#2676: a connection proxied through CI Portal used to be stored with the
 * provider access token the BROWSER carried back in the URL fragment. With a proxy
 * refresh token the server now fetches the access token from CI Portal over the
 * device-authenticated channel, and stores the refresh token CI Portal rotated.
 */

// `accountLabel` is set so completion does not go on to call a provider client —
// the label lookup is not what these cases are about.
const CONNECTION = {
  id: 'conn-1',
  providerId: 'prov-google',
  provider: { id: 'prov-google' },
  accountLabel: 'someone@example.com',
};

const ctx = { userId: 'user-1' } as RequestContext;

function makeController() {
  const clientFactory = { getClientByProviderId: jest.fn() };
  const cloudOAuthProxyService = { refreshAccessToken: jest.fn() };
  const connectionService = {
    findById: jest.fn().mockResolvedValue(CONNECTION),
    search: jest.fn().mockResolvedValue([]),
    remove: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(CONNECTION),
  };
  const eventService = {};
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const controller = new ConnectionsController(
    clientFactory as never,
    cloudOAuthProxyService as never,
    connectionService as never,
    eventService as never,
    logger as never,
  );

  return { controller, clientFactory, cloudOAuthProxyService, connectionService, logger };
}

const proxyBody = (
  overrides: Partial<Extract<CompleteConnectionDto, { flow: 'proxy' }>> = {},
): CompleteConnectionDto => ({
  flow: 'proxy',
  state: 'conn-1',
  userProviderId: 'up-1',
  ...overrides,
});

/** The token fields the connection was stored with, from the one update that carries them. */
function storedTokens(connectionService: ReturnType<typeof makeController>['connectionService']) {
  const call = connectionService.update.mock.calls.find(([, , input]) => input && 'accessToken' in input);

  expect(call).toBeDefined();

  return call![2] as {
    accessToken: string;
    refreshToken: string | null;
    tokenExpiry: Date | null;
    active: boolean;
  };
}

describe('ConnectionsController.completeCallback — CI Portal proxy flow', () => {
  it('stores the access token CI Portal returns, not the one the browser carried', async () => {
    const { controller, cloudOAuthProxyService, connectionService } = makeController();
    cloudOAuthProxyService.refreshAccessToken.mockResolvedValue({
      access_token: 'portal-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: 1800,
      token_type: 'Bearer',
    });
    const before = Date.now();

    await controller.completeCallback(
      ctx,
      proxyBody({
        accessToken: 'browser-access-token',
        refreshToken: 'fragment-refresh-token',
        expiresIn: 3600,
      }),
    );

    // Bounded: CI Portal waits on the provider in turn, and neither hop times out on its own.
    expect(cloudOAuthProxyService.refreshAccessToken).toHaveBeenCalledWith('fragment-refresh-token', {
      signal: expect.any(AbortSignal),
    });

    const stored = storedTokens(connectionService);

    expect(stored.accessToken).toBe('portal-access-token');
    // CI Portal rotates the proxy refresh token on use: the one in the request is spent.
    expect(stored.refreshToken).toBe('rotated-refresh-token');
    expect(stored.active).toBe(true);
    // The expiry is CI Portal's, not the browser's `expiresIn`.
    expect(stored.tokenExpiry!.getTime()).toBeGreaterThanOrEqual(before + 1800 * 1000);
    expect(stored.tokenExpiry!.getTime()).toBeLessThan(before + 3600 * 1000);
  });

  it('completes with no access token from the browser at all', async () => {
    const { controller, cloudOAuthProxyService, connectionService } = makeController();
    cloudOAuthProxyService.refreshAccessToken.mockResolvedValue({
      access_token: 'portal-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
    });

    await controller.completeCallback(ctx, proxyBody({ refreshToken: 'fragment-refresh-token' }));

    expect(storedTokens(connectionService)).toMatchObject({
      accessToken: 'portal-access-token',
      refreshToken: 'rotated-refresh-token',
      active: true,
    });
  });

  it('uses the browser access token only when there is no refresh token (e.g. Facebook)', async () => {
    const { controller, cloudOAuthProxyService, connectionService } = makeController();
    const before = Date.now();

    await controller.completeCallback(
      ctx,
      proxyBody({ accessToken: 'browser-access-token', expiresIn: 3600 }),
    );

    expect(cloudOAuthProxyService.refreshAccessToken).not.toHaveBeenCalled();

    const stored = storedTokens(connectionService);

    expect(stored).toMatchObject({
      accessToken: 'browser-access-token',
      refreshToken: null,
      active: true,
    });
    // With no refresh token the expiry is all that keeps the connection scheduled:
    // findActiveConnections only picks one up while its tokenExpiry is in the future.
    expect(stored.tokenExpiry!.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(stored.tokenExpiry!.getTime()).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it('refuses a proxy completion that carries neither token before looking anything up', async () => {
    const { controller, cloudOAuthProxyService, connectionService } = makeController();
    // An active connection to the same account must not be the reason anything is
    // removed for a body that has nothing to store.
    connectionService.search.mockResolvedValue([{ id: 'conn-already-there' }]);

    await expect(controller.completeCallback(ctx, proxyBody())).rejects.toBeInstanceOf(BadRequestException);
    expect(connectionService.findById).not.toHaveBeenCalled();
    expect(connectionService.search).not.toHaveBeenCalled();
    expect(connectionService.remove).not.toHaveBeenCalled();
    expect(cloudOAuthProxyService.refreshAccessToken).not.toHaveBeenCalled();
    expect(connectionService.update).not.toHaveBeenCalled();
  });

  describe('an account that is already connected', () => {
    it('refuses the new connection and hands its proxy grant to the existing one', async () => {
      // CI Portal keeps one credential per (device, provider, account), and its callback
      // has already replaced the existing connection's proxy refresh token with the one
      // in this request. Dropping it with the refused connection would leave the
      // existing one unable to ever refresh again.
      const { controller, clientFactory, cloudOAuthProxyService, connectionService } = makeController();
      const getAccountIdentifier = jest.fn().mockResolvedValue('up-1');
      clientFactory.getClientByProviderId.mockReturnValue({ getAccountIdentifier });
      connectionService.search.mockResolvedValue([{ id: 'conn-already-there', externalId: 'up-1' }]);
      cloudOAuthProxyService.refreshAccessToken.mockResolvedValue({
        access_token: 'portal-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });

      await expect(
        controller.completeCallback(ctx, proxyBody({ refreshToken: 'fragment-refresh-token' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(cloudOAuthProxyService.refreshAccessToken).toHaveBeenCalledWith('fragment-refresh-token', {
        signal: expect.any(AbortSignal),
      });
      // The account is confirmed with the provider using the refreshed token.
      expect(getAccountIdentifier).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'conn-already-there', accessToken: 'portal-access-token' }),
      );
      expect(connectionService.update).toHaveBeenCalledTimes(1);
      expect(connectionService.update).toHaveBeenCalledWith(expect.anything(), 'conn-already-there', {
        accessToken: 'portal-access-token',
        refreshToken: 'rotated-refresh-token',
        tokenExpiry: expect.any(Date),
      });
      expect(connectionService.remove).toHaveBeenCalledWith(expect.anything(), 'conn-1');
    });

    it.each([
      ['the grant is for a different account', 'someone-else'],
      ['the provider returns no account id', ''],
    ])('leaves the existing connection alone when %s', async (_label, accountId) => {
      // `userProviderId` is browser-supplied and not tied to the refresh token: a body
      // pairing one account's grant with another connection's id must not overwrite it.
      const { controller, clientFactory, cloudOAuthProxyService, connectionService, logger } =
        makeController();
      clientFactory.getClientByProviderId.mockReturnValue({
        getAccountIdentifier: jest.fn().mockResolvedValue(accountId),
      });
      connectionService.search.mockResolvedValue([{ id: 'conn-already-there', externalId: 'up-1' }]);
      cloudOAuthProxyService.refreshAccessToken.mockResolvedValue({
        access_token: 'portal-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });

      await expect(
        controller.completeCallback(ctx, proxyBody({ refreshToken: 'fragment-refresh-token' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(connectionService.update).not.toHaveBeenCalled();
      expect(connectionService.remove).toHaveBeenCalledWith(expect.anything(), 'conn-1');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('still refuses it, and leaves the existing connection alone, when CI Portal cannot refresh', async () => {
      const { controller, cloudOAuthProxyService, connectionService, logger } = makeController();
      connectionService.search.mockResolvedValue([{ id: 'conn-already-there' }]);
      cloudOAuthProxyService.refreshAccessToken.mockRejectedValue(new Error('No stored tokens'));

      await expect(
        controller.completeCallback(ctx, proxyBody({ refreshToken: 'fragment-refresh-token' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(connectionService.update).not.toHaveBeenCalled();
      expect(connectionService.remove).toHaveBeenCalledWith(expect.anything(), 'conn-1');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('refuses it without calling CI Portal when there is no proxy grant to hand over', async () => {
      const { controller, cloudOAuthProxyService, connectionService } = makeController();
      connectionService.search.mockResolvedValue([{ id: 'conn-already-there' }]);

      await expect(
        controller.completeCallback(ctx, proxyBody({ accessToken: 'browser-access-token' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(cloudOAuthProxyService.refreshAccessToken).not.toHaveBeenCalled();
      expect(connectionService.update).not.toHaveBeenCalled();
      expect(connectionService.remove).toHaveBeenCalledWith(expect.anything(), 'conn-1');
    });
  });

  it.each([
    [
      'CI Portal refuses the refresh',
      (refresh: jest.Mock) => refresh.mockRejectedValue(new Error('No stored tokens')),
    ],
    [
      'CI Portal answers with no access token',
      (refresh: jest.Mock) => refresh.mockResolvedValue({ expires_in: 3600 }),
    ],
  ])('does not activate the connection when %s', async (_label, arrange) => {
    const { controller, cloudOAuthProxyService, connectionService } = makeController();
    arrange(cloudOAuthProxyService.refreshAccessToken);

    await expect(
      controller.completeCallback(
        ctx,
        proxyBody({ accessToken: 'browser-access-token', refreshToken: 'rt' }),
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(connectionService.update).not.toHaveBeenCalled();
  });

  it('keeps the reason CI Portal could not be reached', async () => {
    // Node's fetch rejects with only "fetch failed" and puts the reason in `cause`.
    const { controller, cloudOAuthProxyService, logger } = makeController();
    const unreachable = Object.assign(new TypeError('fetch failed'), {
      cause: new Error('getaddrinfo ENOTFOUND hub.ci.computer'),
    });
    cloudOAuthProxyService.refreshAccessToken.mockRejectedValue(unreachable);

    const failure = await controller
      .completeCallback(ctx, proxyBody({ refreshToken: 'rt' }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadGatewayException);
    expect((failure as BadGatewayException).cause).toBe(unreachable);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ err: unreachable }),
    );
  });

  it('stores no refresh token rather than the spent one when CI Portal returns none', async () => {
    const { controller, cloudOAuthProxyService, connectionService } = makeController();
    cloudOAuthProxyService.refreshAccessToken.mockResolvedValue({
      access_token: 'portal-access-token',
      expires_in: 3600,
    });

    await controller.completeCallback(ctx, proxyBody({ refreshToken: 'fragment-refresh-token' }));

    expect(storedTokens(connectionService).refreshToken).toBeNull();
  });

  it('reads an expires_in CI Portal passed through as a numeric string', async () => {
    // CI Portal forwards the provider's `expires_in` as it came; the refresh path in
    // BaseOAuth2Client already accepts a string there.
    const { controller, cloudOAuthProxyService, connectionService } = makeController();
    cloudOAuthProxyService.refreshAccessToken.mockResolvedValue({
      access_token: 'portal-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: '3599',
    });
    const before = Date.now();

    await controller.completeCallback(ctx, proxyBody({ refreshToken: 'fragment-refresh-token' }));

    const { tokenExpiry } = storedTokens(connectionService);

    expect(tokenExpiry!.getTime()).toBeGreaterThanOrEqual(before + 3599 * 1000);
    expect(tokenExpiry!.getTime()).toBeLessThanOrEqual(Date.now() + 3599 * 1000);
  });

  it.each([
    ['a word', 'soon'],
    ['zero', 0],
    ['negative', -5],
    ['null', null],
    ['beyond any date', 1e300],
  ])('stores no expiry when the expires_in CI Portal returns is %s', async (_label, expiresIn) => {
    const { controller, cloudOAuthProxyService, connectionService } = makeController();
    cloudOAuthProxyService.refreshAccessToken.mockResolvedValue({
      access_token: 'portal-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: expiresIn,
    });

    await controller.completeCallback(ctx, proxyBody({ refreshToken: 'fragment-refresh-token' }));

    expect(storedTokens(connectionService).tokenExpiry).toBeNull();
  });
});

describe('completeConnectionSchema', () => {
  it('accepts a proxy completion with a refresh token and no access token', () => {
    expect(
      completeConnectionSchema.safeParse({
        flow: 'proxy',
        state: 'conn-1',
        refreshToken: 'rt',
        userProviderId: 'up-1',
      }).success,
    ).toBe(true);
  });

  it('still requires the direct flow to carry a code', () => {
    expect(completeConnectionSchema.safeParse({ flow: 'direct', state: 'conn-1' }).success).toBe(false);
  });
});
