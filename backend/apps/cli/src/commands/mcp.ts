import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

import { type CliContext, CliError } from '../context';
import { json } from '../output';

export interface McpServeOptions {
  stdio?: boolean;
}

export interface McpInitHooksOptions {
  host?: string;
  json?: boolean;
}

export interface HostHookBundle {
  host: 'claude-code' | 'cursor' | 'gemini';
  mcpConfig: Record<string, unknown>;
  lifecycleHooks: Record<string, unknown>;
}

export interface McpInitHooksIO {
  /** HTTP implementation for the API-root probe; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-probe timeout. */
  probeTimeoutMs?: number;
}

/** Where the API's own routes are, and how that was decided. */
export interface ApiRoot {
  url: string;
  /** `assumed`: neither probe answered like the API, so `url` is `--server` unchanged. */
  via: 'api' | 'gateway' | 'assumed';
}

const PROBE_TIMEOUT_MS = 3000;

/**
 * Find the API's routes from the URL the CLI was given.
 *
 * Every other command treats `--server` as the API itself (`localhost:3030`
 * by default). A hook config is different: it is pasted into an agent host and
 * runs later, and a production appliance publishes only its gateway (`:8642`
 * or a public hostname). The gateway serves the API under `/api/` and the web
 * app everywhere else, so an unprefixed `GET /memory/context` there is
 * answered by the SPA with `index.html` and a 200. A SessionStart hook does
 * `curl -f` on it, injects the page into the agent's context, and reports
 * success.
 *
 * `GET /health` tells the two apart without a key. The API answers JSON with
 * `status: "ok"` (it is the liveness probe, so it does not fail when a
 * dependency is down); the gateway's SPA answers HTML.
 */
export async function resolveApiRoot(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ApiRoot> {
  const base = baseUrl.replace(/\/+$/, '');

  if (await answersAsApi(`${base}/health`, fetchImpl, timeoutMs)) {
    return { url: base, via: 'api' };
  }

  if (await answersAsApi(`${base}/api/health`, fetchImpl, timeoutMs)) {
    return { url: `${base}/api`, via: 'gateway' };
  }

  return { url: base, via: 'assumed' };
}

async function answersAsApi(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as { status?: unknown } | null;

    return body?.status === 'ok';
  } catch {
    // Unreachable, timed out, or not JSON (the SPA's index.html): not the API.
    return false;
  }
}

/**
 * `ci mcp init-hooks` — emit ready-to-paste MCP server + lifecycle hook
 * configurations (`knowl` zero-touch lifecycle pattern) for Claude Code,
 * Cursor, and Gemini / Antigravity.
 *
 * The hook URLs are built on {@link resolveApiRoot}, not on `--server` as
 * given, so they carry `/api` exactly when the URL is the gateway.
 */
export async function mcpInitHooksCommand(
  ctx: CliContext,
  options: McpInitHooksOptions = {},
  io: McpInitHooksIO = {},
): Promise<void> {
  const hostFilter = (options.host ?? 'all').trim().toLowerCase();
  if (!['all', 'claude-code', 'cursor', 'gemini'].includes(hostFilter)) {
    throw new CliError('--host must be one of: all, claude-code, cursor, gemini');
  }

  const baseUrl = ctx.client.baseUrl.replace(/\/+$/, '');
  const apiRoot = await resolveApiRoot(baseUrl, io.fetchImpl ?? fetch, io.probeTimeoutMs ?? PROBE_TIMEOUT_MS);

  if (apiRoot.via === 'assumed') {
    // stderr, so `--json` stays one parseable document on stdout.
    ctx.term.err(
      `[ci mcp] Neither ${baseUrl}/health nor ${baseUrl}/api/health answered like the API, so the hook URLs ` +
        `assume ${baseUrl} is the API itself. Behind the gateway they need /api: re-run with the appliance up.`,
    );
  }

  const memoryUrl = `${apiRoot.url}/memory`;
  const envBlock = {
    CI_SERVER_URL: baseUrl,
    CI_API_KEY: ctx.client.apiKey ?? '${CI_API_KEY}',
  };

  const stdioServerEntry = {
    command: 'ci',
    args: ['mcp', 'serve', '--stdio'],
    env: envBlock,
  };

  const bundles: HostHookBundle[] = [
    {
      host: 'claude-code',
      mcpConfig: {
        mcpServers: {
          'companion-memory': stdioServerEntry,
        },
      },
      lifecycleHooks: {
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: `curl -fsSL -H "x-api-key: \${CI_API_KEY}" "${memoryUrl}/context"`,
                },
              ],
            },
          ],
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: `git diff --name-only HEAD | jq -R -s '{changedPaths: (split("\\n") | map(select(length > 0)))}' | curl -fsSL -X POST -H "content-type: application/json" -H "x-api-key: \${CI_API_KEY}" -d @- "${memoryUrl}/drift"`,
                },
              ],
            },
          ],
        },
      },
    },
    {
      host: 'cursor',
      mcpConfig: {
        mcpServers: {
          'companion-memory': stdioServerEntry,
        },
      },
      lifecycleHooks: {
        version: 1,
        hooks: {
          afterFileEdit: [
            {
              command: `ci fleet status --json`,
            },
          ],
        },
      },
    },
    {
      host: 'gemini',
      mcpConfig: {
        mcpServers: {
          'companion-memory': stdioServerEntry,
        },
      },
      lifecycleHooks: {
        sessionStart: `${memoryUrl}/context`,
        preTurnRecall: `${memoryUrl}/recall`,
        postTurnWrite: `${memoryUrl}/turn`,
        postCommitDrift: `${memoryUrl}/drift`,
      },
    },
  ];

  const selected = hostFilter === 'all' ? bundles : bundles.filter((b) => b.host === hostFilter);

  if (options.json) {
    json(ctx.term, selected.length === 1 ? selected[0] : { hosts: selected });

    return;
  }

  for (const bundle of selected) {
    ctx.term.out(`# ${bundle.host} — MCP & Lifecycle Hooks`);
    ctx.term.out(JSON.stringify({ ...bundle.mcpConfig, ...bundle.lifecycleHooks }, null, 2));
  }
}

export interface McpStdioIO {
  /** Line source; defaults to `process.stdin`. */
  input?: NodeJS.ReadableStream | AsyncIterable<string>;
  /** HTTP implementation; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * `ci mcp serve --stdio` — stdio-to-Streamable-HTTP bridge for MCP hosts
 * (Claude Desktop, Cursor, Goose, OpenClaw, MCP Inspector) that launch a local
 * subprocess rather than speaking Streamable HTTP directly.
 *
 * Reads newline-delimited JSON-RPC 2.0 messages from stdin, forwards each to
 * the appliance's `/mcp` endpoint (with automatic `/api/mcp` fallback when
 * behind a gateway prefix), preserves the `Mcp-Session-Id` header across the
 * session lifecycle, and writes JSON-RPC responses to stdout (`ctx.term.out`).
 * Diagnostics go exclusively to stderr (`ctx.term.err`) so stdout remains a
 * clean JSON-RPC wire.
 */
export async function mcpServeCommand(
  ctx: CliContext,
  options: McpServeOptions,
  io: McpStdioIO = {},
): Promise<void> {
  if (!options.stdio) {
    throw new CliError('Pass --stdio to run the MCP stdio bridge (`ci mcp serve --stdio`).');
  }

  const fetchImpl = io.fetchImpl ?? fetch;
  const baseUrl = ctx.client.baseUrl.replace(/\/+$/, '');
  const apiKey = ctx.client.apiKey ?? process.env.CI_API_KEY ?? process.env.CI_SERVER_API_KEY ?? null;

  let endpoint = `${baseUrl}/mcp`;
  let sessionId: string | null = null;

  const lines = toLineIterable(io.input ?? process.stdin);

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsed: { id?: string | number | null; method?: string };
    try {
      parsed = JSON.parse(line) as { id?: string | number | null; method?: string };
    } catch {
      ctx.term.err(`[ci mcp] Dropping malformed JSON-RPC line on stdin`);
      continue;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    if (sessionId) {
      headers['mcp-session-id'] = sessionId;
    }

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: line,
      });

      // The gateway serves the SPA at `/mcp`, and nginx answers a POST to a
      // static file with 405, not 404. Both mean "not the API: try /api/mcp".
      if (
        (response.status === 404 || response.status === 405) &&
        !sessionId &&
        endpoint === `${baseUrl}/mcp`
      ) {
        const fallbackEndpoint = `${baseUrl}/api/mcp`;
        const fallbackResponse = await fetchImpl(fallbackEndpoint, {
          method: 'POST',
          headers,
          body: line,
        });
        if (fallbackResponse.status !== 404) {
          endpoint = fallbackEndpoint;
          response = fallbackResponse;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.term.err(`[ci mcp] Failed to reach ${endpoint}: ${message}`);
      if (parsed && parsed.id !== undefined) {
        ctx.term.out(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            error: { code: -32000, message: `MCP upstream unreachable: ${message}` },
          }),
        );
      }

      continue;
    }

    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) {
      sessionId = returnedSession;
    }

    // 202 Accepted / 204 No Content (notifications such as notifications/initialized)
    if (response.status === 202 || response.status === 204) {
      continue;
    }

    const bodyText = await response.text();
    if (!response.ok) {
      ctx.term.err(`[ci mcp] Upstream HTTP ${response.status}: ${bodyText}`);
      if (parsed && parsed.id !== undefined) {
        ctx.term.out(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: -32000,
              message: `MCP upstream HTTP ${response.status}`,
              data: bodyText || undefined,
            },
          }),
        );
      }

      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    for (const payload of extractJsonRpcPayloads(bodyText, contentType)) {
      ctx.term.out(payload);
    }
  }

  if (sessionId) {
    const headers: Record<string, string> = { 'mcp-session-id': sessionId };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }

    try {
      await fetchImpl(endpoint, { method: 'DELETE', headers });
    } catch {
      // Best-effort session cleanup on stdin EOF.
    }
  }
}

/**
 * Extract one or more single-line JSON-RPC messages from either an
 * `application/json` body or a `text/event-stream` SSE body.
 */
export function extractJsonRpcPayloads(bodyText: string, contentType: string): string[] {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return [];
  }

  if (
    contentType.includes('text/event-stream') ||
    trimmed.startsWith('event:') ||
    trimmed.startsWith('data:')
  ) {
    const payloads: string[] = [];
    const blocks = trimmed.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const dataLines: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart());
        }
      }

      const joined = dataLines.join('\n').trim();
      if (!joined) {
        continue;
      }

      try {
        payloads.push(JSON.stringify(JSON.parse(joined)));
      } catch {
        // Ignore non-JSON keepalive comments/frames.
      }
    }

    return payloads;
  }

  try {
    return [JSON.stringify(JSON.parse(trimmed))];
  } catch {
    return [trimmed];
  }
}

function toLineIterable(source: NodeJS.ReadableStream | AsyncIterable<string>): AsyncIterable<string> {
  if (isReadableStream(source)) {
    return createInterface({ input: source, crlfDelay: Infinity });
  }

  return source;
}

function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return value instanceof Readable || (typeof value === 'object' && value !== null && 'pipe' in value);
}
