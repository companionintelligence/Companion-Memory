/* eslint-disable @typescript-eslint/no-explicit-any */
import { ToolRegistry } from '@ci/domains/tools';

import { IntentRegistry } from '../services/IntentRegistry';
import { IntentToolProvider } from '../services/IntentToolProvider';

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

/** A minimal provider that just supplies the named raw tools (they carry their schema). */
function rawProvider(names: string[]) {
  const tools = new Map(names.map((n) => [n, fakeTool(n)]));

  return {
    name: 'native',
    initialize: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
    getTools: () => [...tools.values()],
    getHealthStatus: jest.fn(async () => ({
      name: 'native',
      status: 'healthy',
      toolCount: tools.size,
      lastCheck: new Date(),
    })),
  } as any;
}

async function bootedRegistry(): Promise<{ registry: ToolRegistry; superseded: string[] }> {
  const registry = new ToolRegistry(makeLogger());
  const intentRegistry = new IntentRegistry();
  const superseded = intentRegistry.getSupersededToolNames();

  // The raw tools the intents wrap must exist for demotion to be observable.
  await registry.registerProvider(rawProvider(superseded));

  const provider = new IntentToolProvider(
    intentRegistry,
    registry,
    { donate: jest.fn() } as any,
    makeLogger(),
  );
  await provider.onModuleInit();

  return { registry, superseded };
}

describe('IntentToolProvider self-registration + demotion', () => {
  const ORIGINAL = process.env.CI_PREFER_INTENTS;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.CI_PREFER_INTENTS;
    } else {
      process.env.CI_PREFER_INTENTS = ORIGINAL;
    }
  });

  it('onModuleInit registers the intent tools into the shared registry', async () => {
    delete process.env.CI_PREFER_INTENTS;
    const { registry } = await bootedRegistry();

    const registered = registry.getRegisteredToolNames();
    expect(registered).toContain('memory_recall');
    expect(registered).toContain('people_find');
  });

  it('demotes the raw tools the intents wrap from the agent-facing list', async () => {
    delete process.env.CI_PREFER_INTENTS;
    const { registry, superseded } = await bootedRegistry();

    const agentFacing = registry.getAgentFacingTools().map((s) => s.name);
    // Curated intent is advertised…
    expect(agentFacing).toContain('memory_recall');
    // …but every raw tool it wraps is hidden.
    for (const raw of superseded) {
      expect(agentFacing).not.toContain(raw);
    }

    // The raw tools stay registered + executable, just not advertised.
    for (const raw of superseded) {
      expect(registry.hasTool(raw)).toBe(true);
    }
  });

  it('advertises the raw tools too when CI_PREFER_INTENTS=false', async () => {
    process.env.CI_PREFER_INTENTS = 'false';
    const { registry, superseded } = await bootedRegistry();

    const agentFacing = registry.getAgentFacingTools().map((s) => s.name);
    expect(agentFacing).toContain(superseded[0]);
  });
});
