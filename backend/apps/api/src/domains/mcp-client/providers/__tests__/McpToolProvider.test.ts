/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpDiscoveredTool } from '../../types';
import { McpToolProvider } from '../McpToolProvider';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

const CREATE_ISSUE: McpDiscoveredTool = {
  name: 'create_issue',
  description: 'Open an issue',
  inputSchema: { type: 'object', properties: {} },
};

function makeManager(
  entries: Array<{ configId: string; userId: string; slug: string; tool: McpDiscoveredTool }>,
) {
  return {
    listAllDiscoveredTools: jest.fn(async () => entries),
    callTool: jest.fn(async () => ({ ok: true })),
  } as any;
}

describe('McpToolProvider', () => {
  /**
   * The tool this provider builds is not a capability of the appliance — it is a bound call into
   * ONE user's configured server, sent with the secrets that user saved. The registry it loads
   * into is process-global, so the owning user has to travel on the schema or the tool belongs to
   * whoever asks first. Without `ownerUserId` the registry has nothing to filter on and every
   * account sees (and can run) every other account's servers.
   */
  it('stamps the owning user onto every synthesized intent', async () => {
    const provider = new McpToolProvider(
      makeManager([
        { configId: 'cfg-a', userId: 'user-1', slug: 'github', tool: CREATE_ISSUE },
        { configId: 'cfg-b', userId: 'user-2', slug: 'linear', tool: { ...CREATE_ISSUE, name: 'add_task' } },
      ]),
      makeLogger(),
    );

    const schemas = await provider.getAvailableTools();

    expect(schemas).toHaveLength(2);
    expect(schemas.map((schema) => [schema.name, schema.ownerUserId])).toStrictEqual([
      ['mcp.github.create_issue', 'user-1'],
      ['mcp.linear.add_task', 'user-2'],
    ]);
    expect(provider.getTool('mcp.github.create_issue')?.schema.ownerUserId).toBe('user-1');
  });

  it('routes an executed tool back through the config it was discovered from', async () => {
    const manager = makeManager([
      { configId: 'cfg-a', userId: 'user-1', slug: 'github', tool: CREATE_ISSUE },
    ]);
    const provider = new McpToolProvider(manager, makeLogger());

    await provider.getAvailableTools();
    await provider.getTool('mcp.github.create_issue')!.execute({ userId: 'user-1' }, { title: 'hi' });

    expect(manager.callTool).toHaveBeenCalledWith('cfg-a', 'create_issue', { title: 'hi' });
  });
});
