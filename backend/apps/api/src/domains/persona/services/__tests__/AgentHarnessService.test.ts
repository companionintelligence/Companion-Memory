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

  it('marks OpenClaw dispatchReady only when installed, connected, and running', async () => {
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
});
