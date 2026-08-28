/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpClientManagerService } from '../McpClientManagerService';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function makeService(rows: unknown[]) {
  const find = jest.fn(async () => rows);
  const service = new McpClientManagerService({ find } as any, {} as any, {} as any, makeLogger());

  return { service, find };
}

describe('McpClientManagerService.listAllDiscoveredTools', () => {
  /**
   * This sweep is deliberately not user-scoped — it runs once, outside any request, to load the
   * process-global tool registry. What it must NOT do is drop the owning user on the way, because
   * that id is the only thing the registry can later filter a per-request tool list by.
   */
  it('carries the owning user of each config through to every entry', async () => {
    const { service, find } = makeService([
      {
        id: 'cfg-a',
        userId: 'user-1',
        slug: 'github',
        discoveredTools: [
          { name: 'create_issue', inputSchema: {} },
          { name: 'list_issues', inputSchema: {} },
        ],
      },
      {
        id: 'cfg-b',
        userId: 'user-2',
        slug: 'linear',
        discoveredTools: [{ name: 'add_task', inputSchema: {} }],
      },
    ]);

    const entries = await service.listAllDiscoveredTools();

    expect(find).toHaveBeenCalledWith({ where: { enabled: true } });
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => [entry.configId, entry.userId, entry.tool.name])).toStrictEqual([
      ['cfg-a', 'user-1', 'create_issue'],
      ['cfg-a', 'user-1', 'list_issues'],
      ['cfg-b', 'user-2', 'add_task'],
    ]);
  });

  it('skips a config that has never completed a tools/list', async () => {
    const { service } = makeService([
      { id: 'cfg-a', userId: 'user-1', slug: 'github', discoveredTools: null },
    ]);

    await expect(service.listAllDiscoveredTools()).resolves.toStrictEqual([]);
  });
});
