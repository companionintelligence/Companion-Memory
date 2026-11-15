import type { Request } from 'express';

import type { ApiKeyScopedRequest } from '@ci/common/guards';
import config from '@ci/configuration';

import type { GraphQLToolAdapter } from '../GraphQLToolAdapter';
import type { McpExecutorService } from '../McpExecutorService';
import { McpToolService } from '../McpToolService';

/**
 * Search hits carry site-relative links (`/content/<id>`). An MCP client on
 * another origin completes them with its own host, so it gets them absolute on
 * the app's public origin, except a signed-in app: the phone's on-device model
 * calls intents over MCP, never shows a link, and fits results into 1k-4k tokens.
 */
describe('McpToolService — hit links', () => {
  const PUBLIC_ORIGIN = 'https://ci-memory-box.example';
  let original: string;

  beforeEach(() => {
    original = config.auth.oidc.publicBaseUrl;
    config.auth.oidc.publicBaseUrl = PUBLIC_ORIGIN;
  });

  afterEach(() => {
    config.auth.oidc.publicBaseUrl = original;
  });

  const searchIntent = {
    name: 'media.findPhotos',
    description: 'Find photos',
    parameters: { type: 'object' as const, properties: { query: { type: 'string' } } },
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
  };

  const buildService = () => {
    const registry = {
      getOutboundCatalogToolsForEveryOwner: () => [searchIntent],
      isToolVisibleTo: () => true,
      getRegisteredToolNames: () => [searchIntent.name],
      executeTool: jest.fn().mockResolvedValue({
        success: true,
        data: { summary: 'Found 1', items: [{ type: 'file', title: 'Cat', link: '/content/c1' }] },
      }),
      recordInvocation: jest.fn().mockResolvedValue(undefined),
    };

    const service = new McpToolService(
      { getTools: () => [], getSchemaSDL: () => '' } as unknown as GraphQLToolAdapter,
      registry as never,
      { executeTool: jest.fn() } as unknown as McpExecutorService,
      { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() } as never,
      { evaluate: async () => ({ decision: 'execute', reason: 'allowed', explanation: 'open' }) } as never,
      { register: () => undefined } as never,
    );

    service.onModuleInit();

    return service;
  };

  const request = (managedBy: ApiKeyScopedRequest['apiKeyManagedBy']) =>
    ({ apiKeyScopes: [], apiKeyCapability: 'full', apiKeyManagedBy: managedBy }) as unknown as Request;

  const linkFor = async (managedBy: ApiKeyScopedRequest['apiKeyManagedBy']) => {
    const data = (await buildService().executeTool(
      'media_findPhotos',
      { query: 'cat' },
      { req: request(managedBy) },
    )) as {
      items: Array<{ link: string }>;
    };

    return data.items[0].link;
  };

  it("gives a hand-made key's client the link on the app's public origin", async () => {
    await expect(linkFor(null)).resolves.toBe(`${PUBLIC_ORIGIN}/content/c1`);
  });

  it('gives a Hub-installed harness (connect key) the link on the public origin', async () => {
    await expect(linkFor('connect')).resolves.toBe(`${PUBLIC_ORIGIN}/content/c1`);
  });

  it("leaves a signed-in app's link site-relative", async () => {
    await expect(linkFor('sign_in')).resolves.toBe('/content/c1');
  });
});
