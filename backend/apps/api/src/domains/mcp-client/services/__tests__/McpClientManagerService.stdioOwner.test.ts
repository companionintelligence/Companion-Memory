/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpClientManagerService, STDIO_NEEDS_ADMIN_OWNER } from '../McpClientManagerService';

/**
 * A stdio config is a command this process spawns. The controller that writes configs is admin
 * only, but the boot sweep reads every enabled row of every user, and a row can arrive without
 * that controller (an account import used to restore it as-is). So `connect` itself must refuse
 * to spawn for an owner who is not an administrator.
 */
function makeService(config: Record<string, unknown>, ownerRole: string | null) {
  const update = jest.fn(async () => undefined);
  const query = jest.fn(async () => (ownerRole === null ? [] : [{ role: ownerRole }]));
  const repo = {
    findOne: jest.fn(async () => config),
    find: jest.fn(async () => [config]),
    update,
    manager: { query },
  };
  const logger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const secretCodec = { decryptEntries: jest.fn(() => []), decryptAuth: jest.fn(() => null) };
  const service = new McpClientManagerService(repo as any, secretCodec as any, {} as any, logger as any);
  // Stands in for the spawn: if this is reached, a process would have started.
  const openConnection = jest
    .spyOn(service as any, 'openConnection')
    .mockRejectedValue(new Error('spawn reached in test'));

  return { service, update, query, openConnection };
}

const STDIO = {
  id: 'cfg-1',
  userId: 'member-1',
  slug: 'local-tool',
  name: 'Local tool',
  transport: 'stdio',
  command: '/usr/bin/true',
  args: [],
  env: [],
  enabled: true,
};

describe('McpClientManagerService.connect: who may have a stdio server started', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not spawn a stdio server for an owner who is not an administrator, and says why', async () => {
    const { service, update, query, openConnection } = makeService(STDIO, 'user');

    await service.connect('cfg-1');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM ci.users'), ['member-1']);
    expect(openConnection).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('cfg-1', {
      connectionStatus: 'error',
      lastError: STDIO_NEEDS_ADMIN_OWNER,
    });
  });

  it('does not spawn for an owner whose account is gone', async () => {
    const { service, openConnection } = makeService(STDIO, null);

    await service.connect('cfg-1');

    expect(openConnection).not.toHaveBeenCalled();
  });

  it('the boot sweep goes through the same check', async () => {
    const { service, openConnection } = makeService(STDIO, 'user');

    await service.connectAllEnabled();

    expect(openConnection).not.toHaveBeenCalled();
  });

  it('retries, rather than throwing, when the owner lookup itself fails', async () => {
    // The reconnect timer calls connect() with `void`; a rejection there is unhandled and
    // the process's unhandledRejection handler exits.
    jest.useFakeTimers();
    const { service, update, query, openConnection } = makeService(STDIO, 'admin');

    query.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(service.connect('cfg-1')).resolves.toBeUndefined();

    expect(openConnection).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('cfg-1', {
      connectionStatus: 'error',
      lastError: 'connection terminated',
    });
    expect((service as any).reconnectTimers.has('cfg-1')).toBe(true);
  });

  it("starts an administrator's stdio server", async () => {
    jest.useFakeTimers();
    const { service, openConnection } = makeService(STDIO, 'admin');

    await service.connect('cfg-1');

    expect(openConnection).toHaveBeenCalledTimes(1);
  });

  it('does not ask about the owner of an http server, which spawns nothing', async () => {
    jest.useFakeTimers();
    const { service, query, openConnection } = makeService(
      { ...STDIO, transport: 'http', command: null, url: 'https://mcp.example.com/' },
      'user',
    );

    await service.connect('cfg-1');

    expect(query).not.toHaveBeenCalled();
    expect(openConnection).toHaveBeenCalledTimes(1);
  });
});
