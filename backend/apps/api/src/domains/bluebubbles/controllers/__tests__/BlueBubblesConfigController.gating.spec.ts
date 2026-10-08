import { FULL_CAPABILITY, REQUIRE_CAPABILITY_KEY } from '@ci/common/decorators';
import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { BlueBubblesConfigController } from '../BlueBubblesConfigController';

/**
 * Pins the administrator gate on routes that change something for EVERY user of
 * the appliance, read via Nest's decorator metadata like
 * `events/__tests__/jobsControllerGating.spec.ts`: the assertion is on what the
 * controller DECLARES, so a refactor that drops a `@UseGuards` fails here
 * without a running app. Kept per domain — the dependency rules forbid a spec
 * in one domain importing another domain's controller.
 */
const GUARDS_METADATA = '__guards__';
const PATH_METADATA = 'path';

function guardsOn(controller: abstract new (...args: never[]) => unknown, method: string): unknown[] {
  const handler = (controller.prototype as Record<string, unknown>)[method] as object;
  // Guards against asserting on a helper that is not a route at all.
  expect(Reflect.getMetadata(PATH_METADATA, handler)).toBeDefined();

  return (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
}

describe('BlueBubblesConfigController — writing the appliance-wide config is administrator-only', () => {
  it('every non-GET route carries the admin guard after the auth guard; GET is open but answers by role', () => {
    // The configuration is one row for the whole appliance, test-connection makes the appliance
    // dial an arbitrary host:port and report back, and rotating the webhook secret cuts off the
    // owner's live webhook. The GET stays reachable by everyone because the Connect page's card
    // needs on/off for every account; what it returns is decided per caller (see below).
    const prototype = BlueBubblesConfigController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(prototype).filter(
      (name) =>
        name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, prototype[name] as object) !== undefined,
    );
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes).toContain('rotateWebhookSecret');

    for (const method of routes) {
      // RequestMethod.GET === 0 in Nest's enum.
      const httpMethod = Reflect.getMetadata('method', prototype[method] as object) as number;
      const guards = guardsOn(BlueBubblesConfigController, method);
      expect(guards).toContain(JwtOrApiKeyAuthGuard);

      if (httpMethod === 0) {
        expect(guards).not.toContain(ApplianceAdminGuard);
      } else {
        expect(guards).toContain(ApplianceAdminGuard);
        expect(guards.indexOf(JwtOrApiKeyAuthGuard)).toBeLessThan(guards.indexOf(ApplianceAdminGuard));
      }
    }
  });

  it('rotating the webhook secret needs a full-capability key', () => {
    const handler = (BlueBubblesConfigController.prototype as unknown as Record<string, object>)
      .rotateWebhookSecret;

    expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, handler)).toBe(FULL_CAPABILITY);
  });
});

/**
 * GET /bluebubbles/config used to hand every account, and every read-only API key, the full
 * settings: the Mac's host and port, the last error (which quotes them) and the webhook path,
 * whose secret is the only credential on the webhook that files messages into the owner's
 * memory. Now an administrator gets that, and everyone else gets on/off and activity times.
 */
describe('BlueBubblesConfigController GET /bluebubbles/config', () => {
  const ROW = {
    id: 'cfg-1',
    host: 'mac.example.com',
    port: 1234,
    useHttps: false,
    password: 'bb-password',
    hasPrivateApi: true,
    enabled: true,
    webhookSecret: 'a'.repeat(64),
    ownerUserId: 'owner-1',
    connectionStatus: 'error' as const,
    lastError: 'connect ECONNREFUSED 192.168.1.50:1234',
    lastSyncCursor: new Date('2026-10-01T00:00:00Z'),
    lastWebhookReceivedAt: new Date('2026-10-02T00:00:00Z'),
  };

  function controllerFor(admin: boolean | 'throws') {
    const configService = {
      find: jest.fn(async () => ROW),
      getOrCreate: jest.fn(async () => ROW),
      rotateWebhookSecret: jest.fn(async () => ({ ...ROW, webhookSecret: 'b'.repeat(64) })),
    };
    const adminGuard = {
      admits: jest.fn(async () => {
        if (admin === 'throws') {
          throw new Error('probe failed');
        }

        return admin;
      }),
    };
    const logger = { setContext: jest.fn(), error: jest.fn() };
    const controller = new BlueBubblesConfigController(
      configService as never,
      {} as never,
      {} as never,
      adminGuard as never,
      logger as never,
    );

    return { controller, configService };
  }

  it.each([
    ['an account that is not an administrator', false],
    ['a caller whose admin check could not be answered', 'throws'],
  ] as const)('gives %s the status only, without minting the row', async (_label, admin) => {
    const { controller, configService } = controllerFor(admin);

    const view = await controller.getConfig({ user: { role: 'user' } });

    expect(view).toEqual({
      canEdit: false,
      enabled: true,
      connectionStatus: 'error',
      lastSyncCursor: ROW.lastSyncCursor,
      lastWebhookReceivedAt: ROW.lastWebhookReceivedAt,
    });
    expect(JSON.stringify(view)).not.toContain(ROW.webhookSecret);
    expect(JSON.stringify(view)).not.toContain('mac.example.com');
    expect(JSON.stringify(view)).not.toContain('192.168.1.50');
    expect(configService.getOrCreate).not.toHaveBeenCalled();
  });

  it('answers a non-administrator on an appliance with no row yet without creating one', async () => {
    const { controller, configService } = controllerFor(false);
    configService.find.mockResolvedValueOnce(null as never);

    await expect(controller.getConfig({ user: { role: 'user' } })).resolves.toMatchObject({
      canEdit: false,
      enabled: false,
      connectionStatus: 'unknown',
    });
    expect(configService.getOrCreate).not.toHaveBeenCalled();
  });

  it('gives an administrator the full settings, webhook path included, never the password', async () => {
    const { controller } = controllerFor(true);

    const view = await controller.getConfig({ user: { role: 'admin' } });

    expect(view).toMatchObject({
      canEdit: true,
      host: 'mac.example.com',
      port: 1234,
      hasPassword: true,
      webhookPath: `/api/bluebubbles/webhook/${ROW.webhookSecret}`,
      lastError: ROW.lastError,
    });
    expect(JSON.stringify(view)).not.toContain('bb-password');
  });

  it("gives an administrator's read-only API key the status only", async () => {
    // The webhook secret writes into the owner's memory; a read key may not.
    const { controller, configService } = controllerFor(true);

    const view = await controller.getConfig({
      user: { role: 'admin' },
      apiKeyScopes: [],
      apiKeyCapability: 'read',
    });

    expect(view).toMatchObject({ canEdit: false });
    expect(JSON.stringify(view)).not.toContain(ROW.webhookSecret);
    expect(configService.getOrCreate).not.toHaveBeenCalled();
  });

  it("gives an administrator's write key the full settings", async () => {
    const { controller } = controllerFor(true);

    await expect(
      controller.getConfig({ user: { role: 'admin' }, apiKeyScopes: [], apiKeyCapability: 'write' }),
    ).resolves.toMatchObject({ canEdit: true, webhookPath: `/api/bluebubbles/webhook/${ROW.webhookSecret}` });
  });

  it('rotating answers with the new webhook path', async () => {
    const { controller } = controllerFor(true);

    await expect(controller.rotateWebhookSecret()).resolves.toMatchObject({
      webhookPath: `/api/bluebubbles/webhook/${'b'.repeat(64)}`,
    });
  });
});
