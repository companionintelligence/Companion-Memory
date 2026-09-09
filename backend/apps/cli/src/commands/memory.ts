import type { LlmEndpointConfig, LlmEndpointPreflight, LlmEndpointUpdate } from '../client';
import { CliError, type CliContext } from '../context';
import { json } from '../output';

export interface MemoryStatusOptions {
  json?: boolean;
}

export interface MemoryCheckOptions {
  json?: boolean;
}

export interface MemoryConfigureOptions {
  backend?: string;
  port?: string;
  backendApiKey?: string;
  clearApiKey?: boolean;
  json?: boolean;
}

/** Print the endpoint Memory is using without asking the backend to do work. */
export async function memoryStatusCommand(ctx: CliContext, options: MemoryStatusOptions = {}): Promise<void> {
  const endpoint = await ctx.client.getLlmEndpoint();

  if (options.json) {
    json(ctx.term, endpoint);

    return;
  }

  renderEndpoint(ctx, endpoint);
}

/**
 * Check from the API container, not the shell that launched this command.
 * That distinction catches the common first-run state where Ollama works at
 * host localhost but is not exposed to the container running CI-Server.
 */
export async function memoryCheckCommand(ctx: CliContext, options: MemoryCheckOptions = {}): Promise<void> {
  const result = await ctx.client.preflightLlmEndpoint();

  if (options.json) {
    json(ctx.term, result);
  } else {
    renderPreflight(ctx, result);
  }

  if (!result.ok) {
    throw new CliError(result.message ?? 'Memory could not reach its inference server.', 2);
  }
}

/** Configure the appliance-owned endpoint; Hub-managed endpoints remain read-only. */
export async function memoryConfigureCommand(
  ctx: CliContext,
  options: MemoryConfigureOptions,
): Promise<void> {
  const settings = parseSettings(options);
  const endpoint = await ctx.client.updateLlmEndpoint(settings);

  if (options.json) {
    json(ctx.term, endpoint);

    return;
  }

  ctx.term.out('Memory inference endpoint updated.');
  renderEndpoint(ctx, endpoint);
  ctx.term.out('Run `ci-import memory check` before choosing a model.');
}

function parseSettings(options: MemoryConfigureOptions): LlmEndpointUpdate {
  if (!options.backend) {
    throw new CliError('--backend is required (ollama or openai-compatible).');
  }

  const backend = parseBackend(options.backend);
  const port = Number.parseInt(options.port ?? '', 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CliError('--port must be an integer between 1 and 65535.');
  }

  const apiKey = options.backendApiKey?.trim();

  if (apiKey && options.clearApiKey) {
    throw new CliError('--backend-api-key and --clear-api-key cannot be used together.');
  }

  return {
    backend,
    port,
    ...(apiKey ? { apiKey } : {}),
    ...(options.clearApiKey ? { clearApiKey: true } : {}),
  };
}

function parseBackend(value: string): LlmEndpointUpdate['backend'] {
  if (value === 'ollama') {
    return 'ollama';
  }

  if (value === 'openai-compatible' || value === 'openai_compatible') {
    return 'openai_compatible';
  }

  throw new CliError('--backend must be `ollama` or `openai-compatible`.');
}

function renderEndpoint(ctx: CliContext, endpoint: LlmEndpointConfig): void {
  ctx.term.out(`backend     ${displayBackend(endpoint.backend)}`);
  ctx.term.out(`endpoint    ${endpoint.endpoint}`);
  ctx.term.out(`credential  ${endpoint.apiKeyConfigured ? 'configured (write-only)' : 'none'}`);
  ctx.term.out(
    `managed     ${endpoint.locked ? 'by Companion Hub / host environment' : 'by this appliance'}`,
  );
}

function renderPreflight(ctx: CliContext, result: LlmEndpointPreflight): void {
  ctx.term.out(`${result.ok ? 'Connected' : 'Not connected'}  ${result.endpoint}`);
  ctx.term.out(result.message ?? (result.ok ? 'The backend answered.' : 'The backend did not answer.'));

  if (result.models.length > 0) {
    ctx.term.out(`models      ${result.models.join(', ')}`);
  }
}

function displayBackend(backend: LlmEndpointConfig['backend']): string {
  return backend === 'openai_compatible' ? 'OpenAI-compatible' : 'Ollama';
}
