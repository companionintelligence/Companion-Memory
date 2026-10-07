import type { ApiKeyScopedRequest } from '@ci/common/guards';
import type { IntentCatalogService, IntentManifest, ToolRegistry, ToolResult } from '@ci/domains/tools';

import { IntentsController } from '../IntentsController';

/**
 * The controller is a thin publisher over the tools-domain IntentCatalogService, so it's tested
 * against a stub catalog (public API only — no reach into tools internals). The end-to-end
 * "real tools broadcast their full schema" check lives with the catalog in the tools domain.
 */
const MANIFEST: IntentManifest = {
  version: '1.0.0',
  generatedAt: '2026-06-30T00:00:00.000Z',
  domains: [{ key: 'people', title: 'People', description: 'People and relationships.' }],
  entities: [{ type: 'person', title: 'Person', description: 'A person.', idKind: 'global-uid' }],
  intents: [
    {
      name: 'people.find',
      tool: 'people_find',
      domain: 'people',
      title: 'Find people',
      description: 'Find people in the social graph.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
      localCapable: true,
      consumes: [],
      produces: ['person'],
      phrases: ['Find $name'],
    },
  ],
};

const OK_RESULT: ToolResult = { success: true, data: { people: [] } };

function stubCatalog(manifest: IntentManifest = MANIFEST): IntentCatalogService {
  return {
    getManifest: () => manifest,
    getDomains: () => manifest.domains,
    getEntities: () => manifest.entities,
  } as unknown as IntentCatalogService;
}

function stubRegistry(
  overrides: Partial<Pick<ToolRegistry, 'isToolVisibleTo' | 'executeTool'>> = {},
): ToolRegistry & { executeTool: jest.Mock } {
  const executeTool = jest.fn().mockResolvedValue(OK_RESULT);
  const registry = {
    isToolVisibleTo: (name: string) => name === 'people_find',
    executeTool,
    ...overrides,
  } as unknown as ToolRegistry & { executeTool: jest.Mock };

  return registry;
}

function controllerWith(
  manifest: IntentManifest = MANIFEST,
  registry: ToolRegistry = stubRegistry(),
): IntentsController {
  return new IntentsController(stubCatalog(manifest), registry);
}

/** Captures what the controller forwarded to the catalog, which is the whole contract of `?tier=`. */
function controllerSpy(): { controller: IntentsController; calls: unknown[] } {
  const calls: unknown[] = [];
  const catalog = {
    getManifest: (options: unknown) => {
      calls.push(options);

      return MANIFEST;
    },
    getDomains: () => MANIFEST.domains,
    getEntities: () => MANIFEST.entities,
  } as unknown as IntentCatalogService;

  return { controller: new IntentsController(catalog, stubRegistry()), calls };
}

const CONTEXT = { userId: 'user-1' };
const REQ = { apiKeyScopes: ['intents'], apiKeyCapability: 'write' } as ApiKeyScopedRequest;

describe('IntentsController', () => {
  it('publishes the full manifest', () => {
    expect(controllerWith().getManifest()).toEqual(MANIFEST);
  });

  it('exposes the domain and entity vocabularies', () => {
    expect(controllerWith().getDomains()).toEqual({ domains: MANIFEST.domains });
    expect(controllerWith().getEntities()).toEqual({ entities: MANIFEST.entities });
  });

  it('serves a single intent by its dotted name', () => {
    expect(controllerWith().getIntent('people.find').tool).toBe('people_find');
  });

  it('404s an unknown intent', () => {
    expect(() => controllerWith().getIntent('nope.notReal')).toThrow('Unknown intent: nope.notReal');
  });

  describe('POST :name/execute', () => {
    it('runs a dotted OpenClaw-shaped name through the registry', async () => {
      const registry = stubRegistry();
      const result = await controllerWith(MANIFEST, registry).execute(
        'people.find',
        { query: 'Ada' },
        CONTEXT,
        REQ,
      );

      expect(registry.executeTool).toHaveBeenCalledWith(
        'people_find',
        expect.objectContaining({ userId: 'user-1', capability: 'write' }),
        { query: 'Ada' },
      );
      expect(result).toEqual(OK_RESULT);
    });

    it('runs an underscored Hermes-shaped name through the registry', async () => {
      const registry = stubRegistry();
      await controllerWith(MANIFEST, registry).execute('people_find', {}, CONTEXT, REQ);

      expect(registry.executeTool).toHaveBeenCalledWith(
        'people_find',
        expect.objectContaining({ capability: 'write' }),
        {},
      );
    });

    it('404s an unknown intent instead of returning TOOL_NOT_FOUND JSON', async () => {
      const registry = stubRegistry();
      await expect(
        controllerWith(MANIFEST, registry).execute('insights.explain', {}, CONTEXT, REQ),
      ).rejects.toThrow('Unknown intent: insights.explain');
      expect(registry.executeTool).not.toHaveBeenCalled();
    });

    it('404s an intent another account owns, asking the registry about this caller', async () => {
      const isToolVisibleTo = jest.fn(() => false);
      const registry = stubRegistry({ isToolVisibleTo });

      await expect(
        controllerWith(MANIFEST, registry).execute('messaging.send', {}, CONTEXT, REQ),
      ).rejects.toThrow('Unknown intent: messaging.send');
      expect(isToolVisibleTo).toHaveBeenCalledWith('messaging_send', 'user-1');
      expect(registry.executeTool).not.toHaveBeenCalled();
    });

    it('returns a failed ToolResult as HTTP 200 payload', async () => {
      const failed: ToolResult = {
        success: false,
        error: { code: 'TOOL_FORBIDDEN', message: 'needs write', retryable: false },
      };
      const registry = stubRegistry({ executeTool: jest.fn().mockResolvedValue(failed) });
      const result = await controllerWith(MANIFEST, registry).execute('people.find', {}, CONTEXT, REQ);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TOOL_FORBIDDEN');
    });
  });

  describe('?tier=', () => {
    it('asks the catalog for no tier when the param is absent or empty', () => {
      const { controller, calls } = controllerSpy();

      controller.getManifest();
      controller.getManifest('');

      expect(calls).toEqual([{ tier: undefined }, { tier: undefined }]);
    });

    it('forwards a recognized tier', () => {
      const { controller, calls } = controllerSpy();

      controller.getManifest('local');
      controller.getManifest('appliance');

      expect(calls).toEqual([{ tier: 'local' }, { tier: 'appliance' }]);
    });

    it('rejects an unrecognized tier instead of silently ignoring it', () => {
      // Load-bearing: a client that asked for rulings and silently got none would read every
      // `dispatch` as undefined and — depending on how it defaults — either refuse everything or,
      // far worse, run everything.
      expect(() => controllerWith().getManifest('locale')).toThrow('Unknown dispatch tier: locale');
      expect(() => controllerWith().getManifest('LOCAL')).toThrow('Unknown dispatch tier: LOCAL');
    });

    it('names the caller, so an intent owned by one account is listed to that account only', () => {
      // The `messaging.*` intents belong to whoever the BlueBubbles connector was set up for.
      const { controller, calls } = controllerSpy();

      controller.getManifest(undefined, { userId: 'user-1' });
      controller.getIntent('people.find', undefined, { userId: 'user-2' });

      expect(calls).toEqual([
        { tier: undefined, userId: 'user-1' },
        { tier: undefined, userId: 'user-2' },
      ]);
    });

    it('honours the tier on the single-intent route too', () => {
      const { controller, calls } = controllerSpy();

      controller.getIntent('people.find', 'local');

      expect(calls).toEqual([{ tier: 'local' }]);
      expect(() => controllerWith().getIntent('people.find', 'nope')).toThrow('Unknown dispatch tier: nope');
    });
  });
});
