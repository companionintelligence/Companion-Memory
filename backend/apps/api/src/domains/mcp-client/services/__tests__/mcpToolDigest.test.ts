import type { McpApprovedTool, McpDiscoveredTool } from '../../types';
import {
  buildToolApprovals,
  canonicalizeSchema,
  computeSchemaDigest,
  grandfatherApprovals,
  isToolApproved,
} from '../mcpToolDigest';

const tool = (
  name: string,
  inputSchema: Record<string, unknown>,
  description?: string,
): McpDiscoveredTool => ({
  name,
  description,
  inputSchema,
});

describe('canonicalizeSchema', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalizeSchema({ b: 1, a: { d: 2, c: 3 } })).toStrictEqual({ a: { c: 3, d: 2 }, b: 1 });
  });

  it('strips prose keys at every depth but keeps the structure around them', () => {
    expect(
      canonicalizeSchema({
        description: 'top',
        title: 'T',
        properties: { path: { type: 'string', description: 'nested', $comment: 'x' } },
      }),
    ).toStrictEqual({ properties: { path: { type: 'string' } } });
  });

  it('preserves array order, because order is meaning in JSON Schema', () => {
    expect(canonicalizeSchema({ required: ['b', 'a'] })).toStrictEqual({ required: ['b', 'a'] });
  });

  it('normalises undefined to null so object and array holes agree', () => {
    expect(canonicalizeSchema([undefined, 1])).toStrictEqual([null, 1]);
  });
});

describe('computeSchemaDigest', () => {
  it('is stable across key reordering', () => {
    const a = tool('read', {
      type: 'object',
      properties: { path: { type: 'string' }, mode: { type: 'string' } },
    });
    const b = tool('read', {
      properties: { mode: { type: 'string' }, path: { type: 'string' } },
      type: 'object',
    });

    expect(computeSchemaDigest(a)).toBe(computeSchemaDigest(b));
  });

  it('ignores description churn — prose is not a capability change', () => {
    const before = tool('read', { type: 'object', description: 'Reads a file', properties: {} });
    const after = tool('read', {
      type: 'object',
      description: 'Reads a file from disk. v2!',
      properties: {},
    });

    expect(computeSchemaDigest(before)).toBe(computeSchemaDigest(after));
  });

  it('changes when a property is added — a widened schema IS a capability change', () => {
    const before = tool('read', { type: 'object', properties: { path: { type: 'string' } } });
    const after = tool('read', {
      type: 'object',
      properties: { path: { type: 'string' }, exfiltrateTo: { type: 'string' } },
    });

    expect(computeSchemaDigest(before)).not.toBe(computeSchemaDigest(after));
  });

  it('changes when a required array is reordered or extended', () => {
    const base = tool('read', { required: ['path'] });

    expect(computeSchemaDigest(base)).not.toBe(
      computeSchemaDigest(tool('read', { required: ['path', 'mode'] })),
    );
    expect(computeSchemaDigest(tool('read', { required: ['a', 'b'] }))).not.toBe(
      computeSchemaDigest(tool('read', { required: ['b', 'a'] })),
    );
  });

  it('treats a missing inputSchema as the empty schema rather than throwing', () => {
    expect(computeSchemaDigest({ inputSchema: undefined as unknown as Record<string, unknown> })).toBe(
      computeSchemaDigest(tool('x', {})),
    );
  });
});

describe('isToolApproved', () => {
  const readTool = tool('read', { type: 'object', properties: { path: { type: 'string' } } });

  const approval = (name: string, schemaDigest: string): McpApprovedTool => ({
    name,
    schemaDigest,
    approvedAt: '2026-08-26T00:00:00.000Z',
    approvedBy: 'user-1',
  });

  it('admits a tool approved at its current digest', () => {
    expect(isToolApproved(readTool, [approval('read', computeSchemaDigest(readTool))])).toBe(true);
  });

  it('rejects a tool that was never approved', () => {
    expect(isToolApproved(readTool, [])).toBe(false);
  });

  it('rejects a tool whose schema drifted from what was approved', () => {
    const drifted = tool('read', {
      type: 'object',
      properties: { path: { type: 'string' }, andAlsoDeleteEverything: { type: 'boolean' } },
    });

    expect(isToolApproved(drifted, [approval('read', computeSchemaDigest(readTool))])).toBe(false);
  });

  it('rejects a same-named approval carrying a different tool digest', () => {
    expect(isToolApproved(readTool, [approval('read', 'deadbeef')])).toBe(false);
  });

  it('passes a pre-gate row through (null), but not an explicitly empty grant', () => {
    expect(isToolApproved(readTool, null)).toBe(true);
    expect(isToolApproved(readTool, undefined)).toBe(true);
    expect(isToolApproved(readTool, [])).toBe(false);
  });
});

describe('buildToolApprovals', () => {
  const readTool = tool('read', { type: 'object', properties: { path: { type: 'string' } } });
  const writeTool = tool('write', { type: 'object', properties: { path: { type: 'string' } } });

  it('labels approved / new / schema_changed over the discovered set', () => {
    const approved: McpApprovedTool[] = [
      { name: 'read', schemaDigest: computeSchemaDigest(readTool), approvedAt: 'A', approvedBy: 'u' },
      { name: 'write', schemaDigest: 'stale-digest', approvedAt: 'B', approvedBy: 'u' },
    ];

    const result = buildToolApprovals([readTool, writeTool, tool('exec', {})], approved);

    expect(result).toHaveLength(3);
    expect(result.map((entry) => [entry.name, entry.state])).toStrictEqual([
      ['read', 'approved'],
      ['write', 'schema_changed'],
      ['exec', 'new'],
    ]);
    expect(result[1]!.approvedDigest).toBe('stale-digest');
    expect(result[1]!.schemaDigest).toBe(computeSchemaDigest(writeTool));
  });

  it('surfaces an approval the server no longer offers as unavailable', () => {
    const result = buildToolApprovals(
      [readTool],
      [
        { name: 'read', schemaDigest: computeSchemaDigest(readTool), approvedAt: 'A', approvedBy: 'u' },
        { name: 'gone', schemaDigest: 'd', approvedAt: 'B', approvedBy: 'u' },
      ],
    );

    expect(result).toHaveLength(2);
    expect(result[1]).toStrictEqual({
      name: 'gone',
      schemaDigest: null,
      state: 'unavailable',
      approvedAt: 'B',
      approvedDigest: 'd',
    });
  });

  it('labels every tool on a pre-gate row as legacy', () => {
    const result = buildToolApprovals([readTool, writeTool], null);

    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.state === 'legacy')).toBe(true);
  });
});

describe('grandfatherApprovals', () => {
  const readTool = tool('read', { type: 'object', properties: { path: { type: 'string' } } });
  const writeTool = tool('write', { type: 'object', properties: { path: { type: 'string' } } });

  it('preserves provenance of entries whose digest did not move', () => {
    const prior: McpApprovedTool[] = [
      { name: 'read', schemaDigest: computeSchemaDigest(readTool), approvedAt: 'OLD', approvedBy: 'alice' },
      { name: 'write', schemaDigest: 'stale', approvedAt: 'OLD', approvedBy: 'alice' },
    ];

    const result = grandfatherApprovals([readTool, writeTool], prior, 'bob', 'NEW');

    expect(result).toHaveLength(2);
    expect(result[0]).toStrictEqual(prior[0]);
    expect(result[1]).toStrictEqual({
      name: 'write',
      schemaDigest: computeSchemaDigest(writeTool),
      approvedAt: 'NEW',
      approvedBy: 'bob',
    });
  });

  it('drops approvals for tools the server no longer offers', () => {
    const result = grandfatherApprovals(
      [readTool],
      [{ name: 'gone', schemaDigest: 'd', approvedAt: 'OLD', approvedBy: 'alice' }],
      'bob',
      'NEW',
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('read');
  });
});
