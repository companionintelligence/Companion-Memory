import { memoryCheckCommand, memoryConfigureCommand, memoryStatusCommand } from '../commands/memory';
import { CliError } from '../context';

import { harness } from './support/harness';

const endpoint = {
  backend: 'openai_compatible' as const,
  port: 8000,
  hostGateway: 'host.docker.internal',
  locked: false,
  endpoint: 'http://host.docker.internal:8000/v1',
  apiKeyConfigured: true,
};

describe('ci-import memory', () => {
  it('shows a safe endpoint state without ever asking for a credential value', async () => {
    const ctx = harness({ getLlmEndpoint: async () => endpoint });

    await memoryStatusCommand(ctx);

    expect(ctx.term.text()).toContain('OpenAI-compatible');
    expect(ctx.term.text()).toContain('configured (write-only)');
    expect(ctx.term.text()).toContain('http://host.docker.internal:8000/v1');
  });

  it('reports the models that the API container can actually reach', async () => {
    const ctx = harness({
      preflightLlmEndpoint: async () => ({
        ...endpoint,
        ok: true,
        models: ['qwen3:8b', 'nomic-embed-text'],
        message: 'Connected. 2 models reported.',
      }),
    });

    await memoryCheckCommand(ctx);

    expect(ctx.term.text()).toContain('Connected');
    expect(ctx.term.text()).toContain('qwen3:8b, nomic-embed-text');
  });

  it('keeps JSON parseable when a preflight fails', async () => {
    const ctx = harness({
      preflightLlmEndpoint: async () => ({
        ...endpoint,
        ok: false,
        models: [],
        message: 'Could not reach this server from the Memory API.',
      }),
    });

    await expect(memoryCheckCommand(ctx, { json: true })).rejects.toBeInstanceOf(CliError);
    expect(JSON.parse(ctx.term.text())).toMatchObject({ ok: false, models: [] });
  });

  it('prints the firewall rule a failed check suggests, on its own line and in the error', async () => {
    const fixCommand = 'sudo ufw allow from 172.16.0.0/12 to 172.17.0.1 port 11434 proto tcp';
    const ctx = harness({
      preflightLlmEndpoint: async () => ({
        ...endpoint,
        ok: false,
        models: [],
        reason: 'timeout',
        message:
          'host.docker.internal:11434 did not answer in time. If that computer runs Linux with ufw, this rule lets them through:',
        fixCommand,
      }),
    });

    const error = await memoryCheckCommand(ctx).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/lets them through: sudo ufw allow from 172\.16\.0\.0\/12/);
    expect(ctx.term.lines).toContain(`  ${fixCommand}`);
  });

  it('maps the friendly backend spelling and keeps the backend credential write-only', async () => {
    const seen: unknown[] = [];
    const ctx = harness({
      updateLlmEndpoint: async (settings) => {
        seen.push(settings);

        return endpoint;
      },
    });

    await memoryConfigureCommand(ctx, {
      backend: 'openai-compatible',
      port: '8000',
      backendApiKey: 'local-token',
    });

    expect(seen).toEqual([{ backend: 'openai_compatible', port: 8000, apiKey: 'local-token' }]);
    expect(ctx.term.text()).not.toContain('local-token');
  });

  it('passes a Lemonade API root through, and refuses one for Ollama', async () => {
    const seen: unknown[] = [];
    const ctx = harness({
      async updateLlmEndpoint(settings) {
        seen.push(settings);

        return {
          backend: 'openai_compatible',
          port: 13305,
          basePath: '/api/v1',
          hostGateway: 'h',
          locked: false,
          endpoint: 'http://h:13305/api/v1',
          apiKeyConfigured: false,
        };
      },
    });

    await memoryConfigureCommand(ctx, { backend: 'openai-compatible', port: '13305', basePath: '/api/v1' });

    expect(seen).toEqual([{ backend: 'openai_compatible', port: 13305, basePath: '/api/v1' }]);
    expect(ctx.term.text()).toContain('api root    /api/v1');

    await expect(
      memoryConfigureCommand(ctx, { backend: 'ollama', port: '11434', basePath: '/api/v1' }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('--base-path'),
    });
  });

  it('rejects a malformed port before changing an endpoint', async () => {
    const ctx = harness({});

    await expect(
      memoryConfigureCommand(ctx, { backend: 'ollama', port: 'not-a-port' }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--port') });
  });

  it.each(['80abc', '11434.5', '1e3', ''])(
    'rejects --port %j instead of saving the digits it starts with',
    async (port) => {
      const ctx = harness({});

      await expect(memoryConfigureCommand(ctx, { backend: 'ollama', port })).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining('--port'),
      });
    },
  );
});
