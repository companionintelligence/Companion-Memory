/* eslint-disable @typescript-eslint/no-explicit-any */
import { ToolRegistry } from '../ToolRegistry';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function fakeTool(name: string) {
  return { schema: { name, description: name, parameters: { type: 'object' } } } as any;
}

function fakeProvider(names: string[]) {
  const tools = new Map(names.map((n) => [n, fakeTool(n)]));

  return {
    name: 'fake',
    initialize: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
    getTools: () => [...tools.values()],
    getHealthStatus: jest.fn(async () => ({
      name: 'fake',
      status: 'healthy',
      toolCount: tools.size,
      lastCheck: new Date(),
    })),
  } as any;
}

async function registryWith(names: string[]): Promise<ToolRegistry> {
  const registry = new ToolRegistry(makeLogger());
  await registry.registerProvider(fakeProvider(names));

  return registry;
}

describe('ToolRegistry agent-facing demotion', () => {
  const ORIGINAL = process.env.CI_PREFER_INTENTS;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.CI_PREFER_INTENTS;
    } else {
      process.env.CI_PREFER_INTENTS = ORIGINAL;
    }
  });

  it('demotes tools a provider declares via getSupersededToolNames() at load time', async () => {
    delete process.env.CI_PREFER_INTENTS;
    const registry = new ToolRegistry(makeLogger());
    const provider = fakeProvider(['databaseSearch', 'memory_recall', 'somethingElse']);
    // A provider may declare the raw tools its curated tools supersede.
    provider.getSupersededToolNames = () => ['databaseSearch'];
    await registry.registerProvider(provider);

    expect(
      registry
        .getAgentFacingTools()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['memory_recall', 'somethingElse']);
    expect(registry.hasTool('databaseSearch')).toBe(true);
  });

  it('hides superseded tools from the agent-facing list but keeps them registered + executable', async () => {
    delete process.env.CI_PREFER_INTENTS;
    const registry = await registryWith(['databaseSearch', 'memory_recall', 'somethingElse']);
    registry.markSuperseded(['databaseSearch']);

    expect(
      registry
        .getAgentFacingTools()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['memory_recall', 'somethingElse']);
    // The raw tool is demoted from the advertised list, not removed.
    expect(registry.getAvailableTools().map((s) => s.name)).toContain('databaseSearch');
    expect(registry.hasTool('databaseSearch')).toBe(true);
  });

  it('advertises the raw tools when CI_PREFER_INTENTS=false', async () => {
    process.env.CI_PREFER_INTENTS = 'false';
    const registry = await registryWith(['databaseSearch', 'memory_recall']);
    registry.markSuperseded(['databaseSearch']);

    expect(registry.getAgentFacingTools().map((s) => s.name)).toContain('databaseSearch');
  });

  it('returns the full list when nothing is superseded', async () => {
    delete process.env.CI_PREFER_INTENTS;
    const registry = await registryWith(['a', 'b']);

    expect(
      registry
        .getAgentFacingTools()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('markSuperseded is additive and idempotent', async () => {
    delete process.env.CI_PREFER_INTENTS;
    const registry = await registryWith(['a', 'b', 'c']);
    registry.markSuperseded(['a']);
    registry.markSuperseded(['a', 'b']);

    expect(registry.getAgentFacingTools().map((s) => s.name)).toEqual(['c']);
  });
});
