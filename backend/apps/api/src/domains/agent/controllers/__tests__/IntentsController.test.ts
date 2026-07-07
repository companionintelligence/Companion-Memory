import type { IntentCatalogService, IntentManifest, ToolRegistry, ToolSchema } from '@ci/domains/tools';

import { IntentsController } from '../IntentsController';

/**
 * The controller is a thin publisher over the tools-domain IntentCatalogService, so it's tested
 * against a stub catalog (public API only — no reach into tools internals). The end-to-end
 * "real tools broadcast their full schema" check lives with the catalog in the tools domain.
 * The generic executor is likewise tested against a stub ToolRegistry.
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
      consumes: [],
      produces: ['person'],
      phrases: ['Find $name'],
    },
  ],
};

const READ_SCHEMA: Partial<ToolSchema> = {
  name: 'people.find',
  domain: 'people',
  privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
};

const DESTRUCTIVE_SCHEMA: Partial<ToolSchema> = {
  name: 'memory.forget',
  domain: 'memory',
  privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
};

const EXTERNAL_SCHEMA: Partial<ToolSchema> = {
  name: 'media.streamingAvailability',
  domain: 'media',
  privacy: { access: 'read', sensitivity: 'low', destructive: false, external: true },
};

function makeRegistry(schemas: Partial<ToolSchema>[] = [READ_SCHEMA]) {
  const executeTool = jest
    .fn()
    .mockResolvedValue({ success: true, data: { hello: 'world' }, executionTimeMs: 1 });

  const registry = {
    getAgentFacingTools: jest.fn().mockReturnValue(schemas),
    executeTool,
  } as unknown as ToolRegistry;

  return { registry, executeTool };
}

function controllerWith(
  manifest: IntentManifest = MANIFEST,
  registry: ToolRegistry = makeRegistry().registry,
): IntentsController {
  const catalog = {
    getManifest: () => manifest,
    getDomains: () => manifest.domains,
    getEntities: () => manifest.entities,
  } as unknown as IntentCatalogService;

  return new IntentsController(catalog, registry);
}

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
});

describe('IntentsController — POST :name/execute (generic REST executor)', () => {
  const ctx = { userId: 'user-1' };

  it('executes a read-only intent through ToolRegistry with the caller context', async () => {
    const { registry, executeTool } = makeRegistry();
    const controller = controllerWith(MANIFEST, registry);

    const result = await controller.executeIntent('people.find', ctx, { query: 'ada' });

    expect(executeTool).toHaveBeenCalledWith('people_find', ctx, { query: 'ada' });
    expect(result).toEqual({ success: true, data: { hello: 'world' }, executionTimeMs: 1 });
  });

  it('accepts the executable (underscored) name as an alias for the dotted id', async () => {
    const { registry, executeTool } = makeRegistry();
    const controller = controllerWith(MANIFEST, registry);

    await controller.executeIntent('people_find', ctx, {});

    expect(executeTool).toHaveBeenCalledWith('people_find', ctx, {});
  });

  it('defaults a missing body to an empty input object', async () => {
    const { registry, executeTool } = makeRegistry();
    const controller = controllerWith(MANIFEST, registry);

    await controller.executeIntent('people.find', ctx, undefined);

    expect(executeTool).toHaveBeenCalledWith('people_find', ctx, {});
  });

  it('403s a destructive intent (inline policy gate until the dispatcher lands)', async () => {
    const { registry, executeTool } = makeRegistry([DESTRUCTIVE_SCHEMA]);
    const controller = controllerWith(MANIFEST, registry);

    await expect(controller.executeIntent('memory.forget', ctx, {})).rejects.toThrow(/destructive/);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('403s an external intent', async () => {
    const { registry, executeTool } = makeRegistry([EXTERNAL_SCHEMA]);
    const controller = controllerWith(MANIFEST, registry);

    await expect(controller.executeIntent('media.streamingAvailability', ctx, {})).rejects.toThrow(
      /external/,
    );
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('404s an unknown intent without executing anything', async () => {
    const { registry, executeTool } = makeRegistry();
    const controller = controllerWith(MANIFEST, registry);

    await expect(controller.executeIntent('nope.notReal', ctx, {})).rejects.toThrow(
      'Unknown intent: nope.notReal',
    );
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('round-trips suggestions.feedback — a write but non-destructive intent passes the gate', async () => {
    const feedbackSchema: Partial<ToolSchema> = {
      name: 'suggestions.feedback',
      domain: 'suggestions',
      privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    };
    const { registry, executeTool } = makeRegistry([feedbackSchema]);
    (executeTool as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        applied: true,
        id: 'a1',
        action: 'dismissed',
        suggestion: { id: 'a1', seen: false, dismissed: true },
      },
      executionTimeMs: 2,
    });
    const controller = controllerWith(MANIFEST, registry);

    const result = await controller.executeIntent('suggestions.feedback', ctx, {
      id: 'a1',
      action: 'dismissed',
    });

    expect(executeTool).toHaveBeenCalledWith('suggestions_feedback', ctx, {
      id: 'a1',
      action: 'dismissed',
    });
    expect(result.success).toBe(true);
    expect((result.data as { applied: boolean; suggestion: { dismissed: boolean } }).applied).toBe(true);
    expect(
      (result.data as { applied: boolean; suggestion: { dismissed: boolean } }).suggestion.dismissed,
    ).toBe(true);
  });
});
