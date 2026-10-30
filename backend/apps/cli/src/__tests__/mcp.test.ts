import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ImportApiClient } from '../client';
import {
  fleetClaimCommand,
  fleetRegisterCommand,
  fleetReleaseCommand,
  fleetStatusCommand,
} from '../commands/fleet';
import { grantsParseCommand, parseGrantSentence } from '../commands/grants/parse';
import { extractJsonRpcPayloads, mcpInitHooksCommand, mcpServeCommand } from '../commands/mcp';
import { type CliContext, CliError } from '../context';
import { MemoryGraphQLClient } from '../graphqlClient';
import { buildProgram } from '../program';

function makeContext(baseUrl = 'http://localhost:3030', apiKey: string | null = 'ci_test_key') {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const ctx: CliContext = {
    client: new ImportApiClient({ baseUrl, apiKey }),
    graphql: new MemoryGraphQLClient({ baseUrl, apiKey }),
    term: {
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
      isTTY: false,
    },
  };

  return { ctx, outLines, errLines };
}

async function* linesFrom(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

describe('ci mcp serve --stdio', () => {
  it('throws CliError when --stdio is omitted', async () => {
    const { ctx } = makeContext();
    await expect(mcpServeCommand(ctx, {})).rejects.toThrow(CliError);
  });

  it('bridges JSON-RPC initialize, 204 notifications, SSE responses, session headers, and DELETE on EOF', async () => {
    const { ctx, outLines, errLines } = makeContext('http://localhost:3030/', 'ci_secret');
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> =
      [];

    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method: init?.method, headers, body });

      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }

      const parsed = JSON.parse(body!);
      if (parsed.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { protocolVersion: '2025-03-26', serverInfo: { name: 'ci-mcp', version: '1.0.0' } },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'mcp-session-id': 'sess-abc-123',
            },
          },
        );
      }

      if (parsed.method === 'notifications/initialized') {
        return new Response(null, { status: 204 });
      }

      if (parsed.method === 'tools/list') {
        const sse = [
          'event: message',
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: [{ name: 'memory.search' }] } })}`,
          '',
          '',
        ].join('\n');

        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;

    await mcpServeCommand(
      ctx,
      { stdio: true },
      {
        input: linesFrom([
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        ]),
        fetchImpl,
      },
    );

    expect(errLines).toEqual([]);
    expect(outLines).toHaveLength(2);
    expect(JSON.parse(outLines[0])).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'ci-mcp' } },
    });
    expect(JSON.parse(outLines[1])).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'memory.search' }] },
    });

    // Session ID captured on initialize and sent on subsequent POSTs + DELETE cleanup
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe('http://localhost:3030/mcp');
    expect(calls[0].headers?.['x-api-key']).toBe('ci_secret');
    expect(calls[1].headers?.['mcp-session-id']).toBe('sess-abc-123');
    expect(calls[2].headers?.['mcp-session-id']).toBe('sess-abc-123');
    expect(calls[3]).toMatchObject({
      url: 'http://localhost:3030/mcp',
      method: 'DELETE',
      headers: { 'mcp-session-id': 'sess-abc-123', 'x-api-key': 'ci_secret' },
    });
  });

  it('falls back to /api/mcp when /mcp returns 404 before a session is established', async () => {
    const { ctx, outLines } = makeContext('https://gateway.example', 'ci_key');

    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/mcp') && !url.endsWith('/api/mcp')) {
        return new Response('Not Found', { status: 404 });
      }

      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await mcpServeCommand(
      ctx,
      { stdio: true },
      {
        input: linesFrom([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })]),
        fetchImpl,
      },
    );

    expect(outLines).toHaveLength(1);
    expect(JSON.parse(outLines[0])).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('emits a JSON-RPC error frame when upstream returns non-2xx for a request with an id', async () => {
    const { ctx, outLines, errLines } = makeContext();
    const fetchImpl = vi.fn(
      async () => new Response('Unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    await mcpServeCommand(
      ctx,
      { stdio: true },
      {
        input: linesFrom([JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })]),
        fetchImpl,
      },
    );

    expect(errLines).toHaveLength(1);
    expect(outLines).toHaveLength(1);
    expect(JSON.parse(outLines[0])).toMatchObject({
      jsonrpc: '2.0',
      id: 99,
      error: { code: -32000, message: 'MCP upstream HTTP 401' },
    });
  });

  it('extractJsonRpcPayloads parses multi-frame SSE streams and ignores keepalive comments', () => {
    const sse = [
      ': keepalive',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":2,"result":{"b":2}}',
    ].join('\n');

    expect(extractJsonRpcPayloads(sse, 'text/event-stream')).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"a":1}}',
      '{"jsonrpc":"2.0","id":2,"result":{"b":2}}',
    ]);
  });

  it('registers `ci mcp serve --stdio` in the Commander program', () => {
    const { ctx } = makeContext();
    const program = buildProgram({ term: ctx.term });
    const mcpCmd = program.commands.find((c) => c.name() === 'mcp');
    expect(mcpCmd).toBeDefined();
    const serveCmd = mcpCmd?.commands.find((c) => c.name() === 'serve');
    expect(serveCmd).toBeDefined();
    const initHooksCmd = mcpCmd?.commands.find((c) => c.name() === 'init-hooks');
    expect(initHooksCmd).toBeDefined();
  });

  it('`ci mcp init-hooks` emits host MCP and lifecycle hook configs in JSON mode', async () => {
    const { ctx, outLines } = makeContext('http://localhost:3030', 'ci_key');
    await mcpInitHooksCommand(ctx, { host: 'claude-code', json: true });
    expect(outLines).toHaveLength(1);
    const parsed = JSON.parse(outLines[0]);
    expect(parsed.host).toBe('claude-code');
    expect(parsed.mcpConfig.mcpServers['companion-memory'].args).toEqual(['mcp', 'serve', '--stdio']);
    expect(parsed.lifecycleHooks.hooks.SessionStart).toBeDefined();
    expect(parsed.lifecycleHooks.hooks.Stop).toBeDefined();
  });
});

describe('ci fleet — multi-agent worktree coordination', () => {
  it('registers agent sessions, claims files, detects cross-agent collisions, and releases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-fleet-test-'));
    const stateFile = join(dir, 'fleet.json');

    try {
      const { ctx: ctx1, outLines: out1 } = makeContext();
      await fleetRegisterCommand(ctx1, 'agent-alpha', {
        worktree: '/repo/wt-alpha',
        branch: 'feat/alpha',
        task: 'Update ask policy',
        files: ['backend/apps/api/src/domains/asks/policy.ts'],
        stateFile,
        json: true,
      });

      const res1 = JSON.parse(out1[0]);
      expect(res1.session.agentId).toBe('agent-alpha');
      expect(res1.collisions).toEqual([]);

      // Second agent claims the same file -> collision detected!
      const { ctx: ctx2, outLines: out2 } = makeContext();
      await fleetClaimCommand(
        ctx2,
        'agent-beta',
        ['./backend/apps/api/src/domains/asks/policy.ts', 'README.md'],
        { stateFile, json: true },
      );

      const res2 = JSON.parse(out2[0]);
      expect(res2.collisions).toEqual([
        {
          file: 'backend/apps/api/src/domains/asks/policy.ts',
          agents: ['agent-alpha', 'agent-beta'],
        },
      ]);

      // Status lists both sessions and the collision
      const { ctx: ctx3, outLines: out3 } = makeContext();
      await fleetStatusCommand(ctx3, { stateFile, json: true });
      const status = JSON.parse(out3[0]);
      expect(status.sessions).toHaveLength(2);
      expect(status.collisions).toHaveLength(1);

      // Releasing agent-alpha clears the collision
      const { ctx: ctx4 } = makeContext();
      await fleetReleaseCommand(ctx4, 'agent-alpha', { stateFile, json: true });

      const { ctx: ctx5, outLines: out5 } = makeContext();
      await fleetStatusCommand(ctx5, { stateFile, json: true });
      const afterRelease = JSON.parse(out5[0]);
      expect(afterRelease.sessions).toHaveLength(1);
      expect(afterRelease.collisions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ci grants parse — natural-language standing grant parser', () => {
  it('parses natural-language consent instructions and outputs JSON', async () => {
    const fixed = new Date('2026-10-20T00:00:00.000Z');
    const parsed = parseGrantSentence(
      'allow alice@portal.example to ask about photos for 7 days at most summary',
      fixed,
    );
    expect(parsed).toEqual({
      grantee: 'alice@portal.example',
      queryType: 'content',
      dataClass: 'photos',
      mode: 'auto',
      maxDisclosure: 'summary',
      expiresAt: '2026-10-27T00:00:00.000Z',
    });

    const { ctx, outLines } = makeContext();
    await grantsParseCommand(ctx, 'block bob@portal.example from location', { json: true });
    expect(JSON.parse(outLines[0])).toEqual({
      grantee: 'bob@portal.example',
      queryType: 'attribute',
      dataClass: 'location',
      mode: 'block',
      maxDisclosure: 'none',
    });
  });
});
