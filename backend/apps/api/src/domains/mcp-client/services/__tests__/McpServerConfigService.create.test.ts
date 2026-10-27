import type { Repository } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { McpServerConfigEntity } from '../../entities/McpServerConfigEntity';
import type { McpClientManagerService } from '../McpClientManagerService';
import type { McpSecretCodec } from '../McpSecretCodec';
import { McpServerConfigService } from '../McpServerConfigService';

function buildService(): McpServerConfigService {
  const repo = {
    exist: async () => false,
    create: (fields: Partial<McpServerConfigEntity>) => Object.assign(new McpServerConfigEntity(), fields),
    save: async (entity: McpServerConfigEntity) =>
      Object.assign(entity, {
        createdAt: new Date(0),
        updatedAt: new Date(0),
        lastConnectedAt: null,
        lastError: null,
      }),
  } as unknown as Repository<McpServerConfigEntity>;

  const secretCodec = {
    encryptEntries: (entries: unknown[]) => entries,
    encryptAuth: (auth: unknown) => auth,
  } as unknown as McpSecretCodec;

  const manager = { onConfigChanged: async () => {} } as unknown as McpClientManagerService;

  return new McpServerConfigService(repo, secretCodec, manager, {
    setContext: () => {},
    warn: () => {},
  } as unknown as LoggerService);
}

describe('McpServerConfigService.create source', () => {
  it('marks a server added with a catalogSlug as source "catalog"', async () => {
    const created = await buildService().create('user-1', {
      name: 'Context7',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      catalogSlug: 'context7',
    });

    expect(created.source).toBe('catalog');
    expect(created.catalogSlug).toBe('context7');
  });

  it('keeps a hand-added server as source "user_added"', async () => {
    const created = await buildService().create('user-1', {
      name: 'Mine',
      transport: 'http',
      url: 'https://example.test/mcp',
    });

    expect(created.source).toBe('user_added');
  });

  it('respects an explicit source', async () => {
    const created = await buildService().create('user-1', {
      name: 'Context7',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      catalogSlug: 'context7',
      source: 'user_added',
    });

    expect(created.source).toBe('user_added');
  });
});
