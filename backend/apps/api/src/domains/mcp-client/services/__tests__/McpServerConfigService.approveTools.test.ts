import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { McpServerConfigEntity } from '../../entities/McpServerConfigEntity';
import type { McpApprovedTool, McpDiscoveredTool } from '../../types';
import type { McpClientManagerService } from '../McpClientManagerService';
import type { McpSecretCodec } from '../McpSecretCodec';
import { McpServerConfigService } from '../McpServerConfigService';
import { computeSchemaDigest } from '../mcpToolDigest';

const readTool: McpDiscoveredTool = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

const writeTool: McpDiscoveredTool = {
  name: 'write_file',
  description: 'Write a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, body: { type: 'string' } } },
};

interface Harness {
  service: McpServerConfigService;
  row: McpServerConfigEntity;
  refreshCalls: number[];
  onConfigChangedCalls: string[];
}

function buildHarness(
  discoveredTools: McpDiscoveredTool[],
  approvedTools: McpApprovedTool[] | null,
): Harness {
  const row = Object.assign(new McpServerConfigEntity(), {
    id: 'config-1',
    userId: 'user-1',
    name: 'Files',
    slug: 'files',
    transport: 'stdio' as const,
    command: 'files-mcp',
    args: [],
    env: [],
    url: null,
    auth: null,
    enabled: true,
    source: 'user_added' as const,
    catalogSlug: null,
    discoveredTools,
    approvedTools,
    connectionStatus: 'connected' as const,
    lastConnectedAt: null,
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const refreshCalls: number[] = [];
  const onConfigChangedCalls: string[] = [];

  const repo = {
    findOne: async ({ where }: { where: { id: string; userId: string } }) =>
      where.id === row.id && where.userId === row.userId ? row : null,
    update: async (_id: string, patch: Partial<McpServerConfigEntity>) => {
      Object.assign(row, patch);
    },
  } as unknown as Repository<McpServerConfigEntity>;

  const manager = {
    onToolApprovalsChanged: async () => {
      refreshCalls.push(1);
    },
    onConfigChanged: async (id: string) => {
      onConfigChangedCalls.push(id);
    },
  } as unknown as McpClientManagerService;

  const service = new McpServerConfigService(repo, {} as unknown as McpSecretCodec, manager, {
    setContext: () => {},
    warn: () => {},
  } as unknown as LoggerService);

  return { service, row, refreshCalls, onConfigChangedCalls };
}

describe('McpServerConfigService.approveTools', () => {
  it('approves a named tool at the digest the client says it reviewed', async () => {
    const { service, row, refreshCalls } = buildHarness([readTool, writeTool], []);

    const egress = await service.approveTools('user-1', 'config-1', {
      tools: [{ name: 'read_file', schemaDigest: computeSchemaDigest(readTool) }],
    });

    expect(row.approvedTools).toHaveLength(1);
    expect(row.approvedTools![0]!.name).toBe('read_file');
    expect(row.approvedTools![0]!.approvedBy).toBe('user-1');
    expect(egress.toolApprovals.map((entry) => [entry.name, entry.state])).toStrictEqual([
      ['read_file', 'approved'],
      ['write_file', 'new'],
    ]);
    // Rebuilt the assistant's tool set WITHOUT tearing down the live stdio subprocess.
    expect(refreshCalls).toHaveLength(1);
  });

  it('rejects an approval whose digest no longer matches the offered schema', async () => {
    const { service, row } = buildHarness([readTool], []);

    await expect(
      service.approveTools('user-1', 'config-1', {
        tools: [{ name: 'read_file', schemaDigest: computeSchemaDigest(writeTool) }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(row.approvedTools).toStrictEqual([]);
  });

  it('rejects approving a tool the server does not currently offer', async () => {
    const { service } = buildHarness([readTool], []);

    await expect(
      service.approveTools('user-1', 'config-1', { tools: [{ name: 'ghost', schemaDigest: 'anything' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('merges rather than replaces — approving one tool does not revoke the others', async () => {
    const existing: McpApprovedTool[] = [
      {
        name: 'write_file',
        schemaDigest: computeSchemaDigest(writeTool),
        approvedAt: 'OLD',
        approvedBy: 'alice',
      },
    ];
    const { service, row } = buildHarness([readTool, writeTool], existing);

    await service.approveTools('user-1', 'config-1', {
      tools: [{ name: 'read_file', schemaDigest: computeSchemaDigest(readTool) }],
    });

    expect(row.approvedTools).toHaveLength(2);
    expect(row.approvedTools!.map((entry) => entry.name).sort()).toStrictEqual(['read_file', 'write_file']);
    expect(row.approvedTools!.find((entry) => entry.name === 'write_file')!.approvedAt).toBe('OLD');
  });

  it('approveAll re-blesses the whole offered set while preserving unchanged provenance', async () => {
    const existing: McpApprovedTool[] = [
      {
        name: 'read_file',
        schemaDigest: computeSchemaDigest(readTool),
        approvedAt: 'OLD',
        approvedBy: 'alice',
      },
      { name: 'write_file', schemaDigest: 'stale', approvedAt: 'OLD', approvedBy: 'alice' },
    ];
    const { service, row } = buildHarness([readTool, writeTool], existing);

    const egress = await service.approveTools('user-1', 'config-1', { approveAll: true });

    expect(row.approvedTools).toHaveLength(2);
    expect(row.approvedTools![0]!.approvedAt).toBe('OLD');
    expect(row.approvedTools![0]!.approvedBy).toBe('alice');
    expect(row.approvedTools![1]!.approvedBy).toBe('user-1');
    expect(row.approvedTools![1]!.schemaDigest).toBe(computeSchemaDigest(writeTool));
    expect(egress.toolApprovals.every((entry) => entry.state === 'approved')).toBe(true);
  });

  it('approveAll converts a pre-gate row (null) into an explicit grant', async () => {
    const { service, row } = buildHarness([readTool], null);

    expect(McpServerConfigEntity.toEgressType(row).toolApprovals[0]!.state).toBe('legacy');

    const egress = await service.approveTools('user-1', 'config-1', { approveAll: true });

    expect(row.approvedTools).toStrictEqual([
      {
        name: 'read_file',
        schemaDigest: computeSchemaDigest(readTool),
        approvedAt: expect.any(String),
        approvedBy: 'user-1',
      },
    ]);
    expect(egress.toolApprovals[0]!.state).toBe('approved');
  });

  it('revokes a named tool', async () => {
    const existing: McpApprovedTool[] = [
      {
        name: 'read_file',
        schemaDigest: computeSchemaDigest(readTool),
        approvedAt: 'OLD',
        approvedBy: 'alice',
      },
      {
        name: 'write_file',
        schemaDigest: computeSchemaDigest(writeTool),
        approvedAt: 'OLD',
        approvedBy: 'alice',
      },
    ];
    const { service, row } = buildHarness([readTool, writeTool], existing);

    await service.approveTools('user-1', 'config-1', { revoke: ['write_file'] });

    expect(row.approvedTools).toHaveLength(1);
    expect(row.approvedTools![0]!.name).toBe('read_file');
  });
});
