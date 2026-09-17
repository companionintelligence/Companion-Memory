// A doorbell that CAN ring is now part of "ready", so the mock has to carry
// both keys — an appliance with no way to reach Hub is not dispatch-ready
// however healthy OpenClaw itself is.
const connect = { hubOrigins: 'https://hub.example.com', hubInternalUrl: 'http://hub.test:5002' };
const hubForwardAuth = { secret: 'a-secret' };

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
        get hubForwardAuth() {
          return hubForwardAuth;
        },
      },
    },
  };
});

import type { LoggerService } from '@ci/common/logging';
import type { ApiKeyService } from '@ci/domains/auth';
import type { CloudOAuthProxyService } from '@ci/domains/connections';

import { AgentHarnessService } from '../AgentHarnessService';

describe('AgentHarnessService', () => {
  const apiKeyService = {
    findAllByUser: jest.fn(),
  } as unknown as ApiKeyService;

  const cloudOAuthProxyService = {
    getDeviceApplications: jest.fn(),
  } as unknown as CloudOAuthProxyService;

  const logger = {
    setContext: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;

  let service: AgentHarnessService;

  beforeEach(() => {
    jest.clearAllMocks();
    connect.hubOrigins = 'https://hub.example.com';
    service = new AgentHarnessService(apiKeyService, cloudOAuthProxyService, logger);
  });

  it('marks harnesses accessible only when the open URL responds', async () => {
    apiKeyService.findAllByUser = jest.fn().mockResolvedValue([
      {
        name: 'app:ci-hermes:ci-marketplace',
        managed_by: 'connect',
      },
    ]);

    cloudOAuthProxyService.getDeviceApplications = jest.fn().mockResolvedValue([
      {
        id: '1',
        name: 'ci-hermes',
        slug: 'ci-hermes-official',
        port: 18790,
        publicDomain: 'companionintelligence.com',
        openUrl: 'https://ci-hermes-official-device-org.companionintelligence.com',
      },
      {
        id: '2',
        name: 'ci-openclaw',
        slug: 'ci-openclaw-official',
        port: 18789,
        publicDomain: 'companionintelligence.com',
        openUrl: 'https://ci-openclaw-official-device-org.companionintelligence.com',
      },
    ]);

    jest.spyOn(global, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://ci-hermes-official-device-org.companionintelligence.com')) {
        return new Response(null, { status: 200 });
      }

      return new Response(null, { status: 503 });
    });

    const harnesses = await service.getHarnesses({ userId: 'user-1' } as never);

    expect(harnesses).toEqual([
      expect.objectContaining({
        id: 'hermes',
        connectedToMemory: true,
        installed: true,
        running: true,
        openUrl: 'https://ci-hermes-official-device-org.companionintelligence.com',
        accessible: true,
        wakeable: false,
        dispatchReady: false,
        dispatchBlocker: 'chat_only',
      }),
      expect.objectContaining({
        id: 'openclaw',
        connectedToMemory: false,
        installed: true,
        running: false,
        openUrl: 'https://ci-openclaw-official-device-org.companionintelligence.com',
        accessible: false,
        wakeable: false,
        dispatchReady: false,
        dispatchBlocker: 'not_connected',
        connectUrl: 'https://hub.example.com/api/memory-connect/start?app=ci-openclaw%3Aci-marketplace',
      }),
    ]);
  });

  it('marks OpenClaw dispatchReady only when installed, connected, running — and reachable', async () => {
    apiKeyService.findAllByUser = jest.fn().mockResolvedValue([
      {
        name: 'app:ci-openclaw:ci-marketplace',
        managed_by: 'connect',
      },
    ]);
    cloudOAuthProxyService.getDeviceApplications = jest.fn().mockResolvedValue([
      {
        id: '2',
        name: 'ci-openclaw',
        slug: 'ci-openclaw-official',
        port: 18789,
        publicDomain: 'companionintelligence.com',
        openUrl: 'https://ci-openclaw-official-device-org.companionintelligence.com',
      },
    ]);
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const harnesses = await service.getHarnesses({ userId: 'user-1' } as never);
    const openclaw = harnesses.find((harness) => harness.id === 'openclaw');

    expect(openclaw).toMatchObject({
      connectedToMemory: true,
      installed: true,
      running: true,
      wakeable: true,
      dispatchReady: true,
      dispatchBlocker: null,
    });
  });

  it('treats a connect key as installed when Portal lists nothing', async () => {
    connect.hubOrigins = 'https://hub-core3-bc.companionintelligence.com';
    apiKeyService.findAllByUser = jest.fn().mockResolvedValue([
      {
        name: 'app:ci-openclaw:ci-marketplace',
        managed_by: 'connect',
      },
    ]);
    cloudOAuthProxyService.getDeviceApplications = jest.fn().mockResolvedValue([]);
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const harnesses = await service.getHarnesses({ userId: 'user-1' } as never);
    const openclaw = harnesses.find((harness) => harness.id === 'openclaw');

    expect(openclaw).toMatchObject({
      connectedToMemory: true,
      installed: true,
      running: true,
      openUrl: 'https://ci-openclaw-core3-bc.companionintelligence.com',
      wakeable: true,
      dispatchReady: true,
      dispatchBlocker: null,
    });
  });

  it('returns no open URL when portal app has no resolvable URL', async () => {
    apiKeyService.findAllByUser = jest.fn().mockResolvedValue([]);
    cloudOAuthProxyService.getDeviceApplications = jest.fn().mockResolvedValue([
      {
        id: '1',
        name: 'ci-hermes',
        slug: 'ci-hermes-official',
        port: 18790,
        publicDomain: null,
        openUrl: null,
      },
    ]);

    jest.spyOn(global, 'fetch').mockImplementation(jest.fn());

    const harnesses = await service.getHarnesses({ userId: 'user-1' } as never);

    expect(harnesses[0]).toMatchObject({
      id: 'hermes',
      openUrl: null,
      accessible: false,
      running: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * The lie a dev stack told.
   *
   * `resolveReadiness` used to answer purely from the harness's own health, so
   * an appliance with no `CI_HUB_INTERNAL_URL` and no
   * `CI_HUB_FORWARD_AUTH_SECRET` reported `dispatchReady: true` while
   * `wakeOpenClaw` returned false on its first line. The user got a button that
   * created a job, woke nothing, and died two minutes later blaming OpenClaw
   * for not checking in.
   */
  describe('when this appliance cannot ring Hub', () => {
    function healthyOpenClaw() {
      apiKeyService.findAllByUser = jest
        .fn()
        .mockResolvedValue([{ name: 'app:ci-openclaw:ci-marketplace', managed_by: 'connect' }]);
      cloudOAuthProxyService.getDeviceApplications = jest.fn().mockResolvedValue([
        {
          id: '2',
          name: 'ci-openclaw',
          slug: 'ci-openclaw-official',
          port: 18789,
          publicDomain: 'companionintelligence.com',
          openUrl: 'https://ci-openclaw-official-device-org.companionintelligence.com',
        },
      ]);
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    }

    afterEach(() => {
      connect.hubInternalUrl = 'http://hub.test:5002';
      hubForwardAuth.secret = 'a-secret';
    });

    it.each([
      ['no Hub URL', () => (connect.hubInternalUrl = '')],
      ['no shared secret', () => (hubForwardAuth.secret = '')],
    ])('refuses dispatch with %s, even though OpenClaw itself is healthy', async (_label, break_) => {
      healthyOpenClaw();
      break_();

      const openclaw = (await service.getHarnesses({ userId: 'user-1' } as never)).find(
        (harness) => harness.id === 'openclaw',
      );

      // Everything about the HARNESS is still true and still reported. Only the
      // verdict changes, and the blocker names the appliance rather than the app
      // — sending someone to check OpenClaw would point them at the one part of
      // the chain that is working.
      expect(openclaw).toMatchObject({
        installed: true,
        connectedToMemory: true,
        running: true,
        wakeable: true,
        dispatchReady: false,
        dispatchBlocker: 'doorbell_unconfigured',
      });
    });

    it('still names the more specific problem when OpenClaw is the one at fault', async () => {
      // Order matters. "This appliance cannot ring Hub" is true whenever the
      // config is missing, but if OpenClaw is not even installed it is a red
      // herring — the actionable answer is the one about the app.
      apiKeyService.findAllByUser = jest.fn().mockResolvedValue([]);
      cloudOAuthProxyService.getDeviceApplications = jest.fn().mockResolvedValue([]);
      connect.hubInternalUrl = '';

      const openclaw = (await service.getHarnesses({ userId: 'user-1' } as never)).find(
        (harness) => harness.id === 'openclaw',
      );

      expect(openclaw?.dispatchBlocker).toBe('not_installed');
    });
  });
});
