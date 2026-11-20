import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';

import config from '@ci/configuration';

import { LlmEndpointService } from '../LlmEndpointService';

// The firewall hint reads the container's own address; each test says what it is.
jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), networkInterfaces: jest.fn(() => ({})) }));
// The rule names the address host.docker.internal resolves to in the container (host-gateway).
jest.mock('node:dns/promises', () => ({
  ...jest.requireActual('node:dns/promises'),
  lookup: jest.fn(async () => ({ address: '172.17.0.1', family: 4 })),
}));

jest.mock('../llmEndpointShared', () => {
  const actual = jest.requireActual('../llmEndpointShared');

  return {
    ...actual,
    readSharedConfig: jest.fn(() => null),
    writeSharedConfig: jest.fn(),
    // update() would otherwise rewrite $APP_DATA_DIR/app.env with the test's keys.
    syncAppEnvLlmVars: jest.fn(),
  };
});

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  LLM_API_KEY_PLACEHOLDER: 'ollama',
  default: {
    logging: { level: 'error' },
    services: { ollama: { host: 'http://localhost:11434' } },
    llm: { apiBase: undefined, apiKey: 'ollama', chatModel: 'gemma3:1b' },
  },
}));

describe('LlmEndpointService', () => {
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  beforeEach(() => {
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiBase = undefined;
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiKey = 'ollama';
    (config as { services: { ollama: { host: string } } }).services.ollama.host = 'http://localhost:11434';
  });

  it('defaults to Ollama on the inferred host gateway', () => {
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    expect(service.getView()).toEqual({
      backend: 'ollama',
      port: 11434,
      hostGateway: 'localhost',
      locked: false,
      endpoint: 'http://localhost:11434',
      // 'ollama' is the built-in stand-in for an empty LLM_API_KEY, not a key anyone set.
      apiKeyConfigured: false,
    });
    expect(service.usesOpenAiDriver()).toBe(false);
  });

  it('does not report the built-in placeholder as a credential on an OpenAI-compatible backend', async () => {
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    service.update({ backend: 'openai_compatible', port: 13305, basePath: '/api/v1' });

    expect(service.getView().apiKeyConfigured).toBe(false);

    // The placeholder is still what goes out, as before: some servers want a bearer of any value.
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await service.preflight(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:13305/api/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer ollama' } }),
    );

    service.update({ backend: 'openai_compatible', port: 13305, basePath: '/api/v1', apiKey: 'real-key' });

    expect(service.getView().apiKeyConfigured).toBe(true);
  });

  it('still counts a saved key that is the placeholder word, so Settings can remove it', () => {
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiKey = 'deployment-key';
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    // Saved in the appliance, it wins over LLM_API_KEY and is what goes out.
    service.update({ backend: 'openai_compatible', port: 13305, basePath: '/api/v1', apiKey: 'ollama' });

    expect(service.getView().apiKeyConfigured).toBe(true);

    service.update({ backend: 'openai_compatible', port: 13305, basePath: '/api/v1', clearApiKey: true });

    // Removed, the deployment key is the one in use, and it is a real one.
    expect(service.getView().apiKeyConfigured).toBe(true);

    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiKey = 'ollama';
    service.update({ backend: 'openai_compatible', port: 13305, basePath: '/api/v1' });

    expect(service.getView().apiKeyConfigured).toBe(false);
  });

  it('switches to an OpenAI-compatible driver when settings are updated', () => {
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    service.update({
      backend: 'openai_compatible',
      port: 8000,
      apiKey: 'vllm-local',
    });

    expect(service.getView()).toMatchObject({
      backend: 'openai_compatible',
      port: 8000,
      locked: false,
      endpoint: 'http://localhost:8000/v1',
      apiKeyConfigured: true,
    });
    expect(service.getView()).not.toHaveProperty('apiKey');
    expect(service.usesOpenAiDriver()).toBe(true);
    expect(service.getOllamaHost()).toBe('http://localhost:11434');
  });

  it('points at a Lemonade by its own API root, persists it, and reports it in the view', () => {
    const { writeSharedConfig } = jest.requireMock('../llmEndpointShared') as {
      writeSharedConfig: jest.Mock;
    };
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    // A trailing slash and a missing leading one are the same setting.
    service.update({ backend: 'openai_compatible', port: 13305, basePath: 'api/v1/' });

    expect(service.getView()).toMatchObject({
      backend: 'openai_compatible',
      port: 13305,
      basePath: '/api/v1',
      endpoint: 'http://localhost:13305/api/v1',
    });
    expect(service.getOpenAiDriver()?.baseUrl).toBe('http://localhost:13305/api/v1');
    expect(writeSharedConfig).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ backend: 'openai_compatible', port: 13305, basePath: '/api/v1' }),
    );

    // Back to Ollama: no path is stored or shown, since Ollama's native routes are fixed.
    service.update({ backend: 'ollama', port: 11434 });
    expect(service.getView()).not.toHaveProperty('basePath');
    expect(writeSharedConfig).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.not.objectContaining({ basePath: expect.anything() }),
    );
  });

  it("reports an injected LLM_API_BASE's own path, not an assumed /v1", () => {
    (config as { llm: { apiBase?: string } }).llm.apiBase = 'http://localhost:13305/api/v1';
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    expect(service.getView()).toMatchObject({
      backend: 'openai_compatible',
      port: 13305,
      basePath: '/api/v1',
      locked: true,
    });
  });

  it('treats a non-Ollama LLM_API_BASE port as locked Hub config', () => {
    (config as { llm: { apiBase?: string } }).llm.apiBase = 'http://host.docker.internal:8000/v1';

    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    expect(service.getView()).toMatchObject({
      backend: 'openai_compatible',
      port: 8000,
      locked: true,
    });
    expect(service.usesOpenAiDriver()).toBe(true);
  });

  it('preserves the full Hub gateway path when managed config is injected', async () => {
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiBase =
      'https://ci-os-hub:3443/api/inference/v1';
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiKey = 'hub-managed-key';
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'hub-qwen' }] })),
      ) as unknown as typeof fetch;

    expect(service.getView()).toMatchObject({
      endpoint: 'https://ci-os-hub:3443/api/inference/v1',
      locked: true,
    });
    await expect(service.preflight(fetchImpl)).resolves.toMatchObject({
      endpoint: 'https://ci-os-hub:3443/api/inference/v1',
      models: ['hub-qwen'],
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ci-os-hub:3443/api/inference/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer hub-managed-key' } }),
    );
  });

  it('sanitizes a deployment endpoint before showing or logging it', () => {
    (config as { llm: { apiBase?: string } }).llm.apiBase =
      'https://operator:deployment-secret@ci-os-hub:3443/api/inference/v1?token=query-secret#fragment';
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    expect(service.getView().endpoint).toBe('https://ci-os-hub:3443/api/inference/v1');
    expect(logger.log).toHaveBeenCalledWith(
      'LLM endpoint resolved',
      expect.objectContaining({ apiBase: 'https://ci-os-hub:3443/api/inference/v1' }),
    );
  });

  it('checks the native Ollama endpoint from the API network namespace', async () => {
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }] })),
      ) as unknown as typeof fetch;

    await expect(service.preflight(fetchImpl)).resolves.toEqual({
      backend: 'ollama',
      endpoint: 'http://localhost:11434',
      ok: true,
      models: ['qwen3:8b', 'nomic-embed-text'],
      message: 'Connected. 2 models reported.',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('does not expose a configured key when an endpoint is read', () => {
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiKey = 'deployment-key';
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    const view = service.getView() as unknown as Record<string, unknown>;

    expect(view.apiKey).toBeUndefined();
    expect(view.apiKeyConfigured).toBe(true);
  });
  describe('when the server cannot be reached', () => {
    /** What Node's fetch (undici) rejects with: a bare TypeError, the reason in `cause`. */
    const fetchFailed = (message: string, code: string) =>
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
    const rejecting = (error: unknown) => jest.fn().mockRejectedValue(error) as unknown as typeof fetch;
    const connectTimeout = () =>
      fetchFailed(
        'Connect Timeout Error (attempted address: host.docker.internal:11434, timeout: 10000ms)',
        'UND_ERR_CONNECT_TIMEOUT',
      );

    function containerAddress(address: string, prefix: number) {
      jest.mocked(networkInterfaces).mockReturnValue({
        lo: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
        eth0: [
          {
            address,
            netmask: '',
            family: 'IPv4',
            mac: '02:42:ac:12:00:05',
            internal: false,
            cidr: `${address}/${prefix}`,
          },
        ],
      });
    }

    /** Ollama on the Docker host, the way every compose file points at it. */
    function onTheHost(port = 11434) {
      (config as { services: { ollama: { host: string } } }).services.ollama.host =
        `http://host.docker.internal:${port}`;
      const service = new LlmEndpointService(logger as never);
      service.onModuleInit();

      return service;
    }

    beforeEach(() => {
      containerAddress('172.18.0.5', 16);
      jest.mocked(lookup).mockClear();
      logger.warn.mockClear();
    });

    it('says a refused connection was refused, at which address', async () => {
      const result = await onTheHost().preflight(
        rejecting(fetchFailed('connect ECONNREFUSED 172.17.0.1:11434', 'ECONNREFUSED')),
      );

      expect(result).toMatchObject({ ok: false, models: [], reason: 'refused' });
      expect(result.message).toBe(
        "host.docker.internal:11434 refused the connection. Check that the server is running on the computer Memory runs on and isn't listening on 127.0.0.1 only, which Memory's containers can't reach.",
      );
      expect(result).not.toHaveProperty('fixCommand');
    });

    it('gives a host-gateway timeout the ufw rule for the whole Docker pool and the configured port', async () => {
      const result = await onTheHost(11500).preflight(rejecting(connectTimeout()));

      expect(result).toMatchObject({
        ok: false,
        reason: 'timeout',
        fixCommand: 'sudo ufw allow from 172.16.0.0/12 to 172.17.0.1 port 11500 proto tcp',
      });
      expect(lookup).toHaveBeenCalledWith('host.docker.internal', { family: 4 });
      expect(result.message).toBe(
        "host.docker.internal:11500 did not answer in time. On the computer Memory runs on, that usually means a firewall is dropping connections from Memory's containers. If that computer runs Linux with ufw, this rule lets them through:",
      );
    });

    it('counts the preflight’s own abort as a timeout too', async () => {
      const result = await onTheHost().preflight(
        rejecting(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      );

      expect(result).toMatchObject({ reason: 'timeout', fixCommand: expect.stringContaining('port 11434') });
    });

    it('uses the container’s own network when it is outside Docker’s default pool', async () => {
      containerAddress('192.168.16.5', 20);

      const result = await onTheHost().preflight(rejecting(connectTimeout()));

      expect(result.fixCommand).toBe(
        'sudo ufw allow from 192.168.16.0/20 to 172.17.0.1 port 11434 proto tcp',
      );
    });

    it('says `to any` when the gateway name does not resolve in the container', async () => {
      jest
        .mocked(lookup)
        .mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));

      const result = await onTheHost().preflight(rejecting(connectTimeout()));

      expect(result.fixCommand).toBe('sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp');
    });

    it('uses a gateway set as an IP address as it is, without a lookup', async () => {
      const previous = process.env.CI_LLM_HOST_GATEWAY;
      process.env.CI_LLM_HOST_GATEWAY = '172.17.0.1';

      try {
        (config as { services: { ollama: { host: string } } }).services.ollama.host =
          'http://172.17.0.1:11434';
        const service = new LlmEndpointService(logger as never);
        service.onModuleInit();

        await expect(service.preflight(rejecting(connectTimeout()))).resolves.toHaveProperty(
          'fixCommand',
          'sudo ufw allow from 172.16.0.0/12 to 172.17.0.1 port 11434 proto tcp',
        );
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) {
          delete process.env.CI_LLM_HOST_GATEWAY;
        } else {
          process.env.CI_LLM_HOST_GATEWAY = previous;
        }
      }
    });

    it('leaves the rule out when the container has no IPv4 address to base it on', async () => {
      jest.mocked(networkInterfaces).mockReturnValue({});

      const result = await onTheHost().preflight(rejecting(connectTimeout()));

      expect(result.reason).toBe('timeout');
      expect(result).not.toHaveProperty('fixCommand');
      expect(result.message).not.toMatch(/ufw/);
    });

    it('treats a gateway named in CI_LLM_HOST_GATEWAY as the host', async () => {
      const previous = process.env.CI_LLM_HOST_GATEWAY;
      process.env.CI_LLM_HOST_GATEWAY = 'docker-host.internal';

      try {
        (config as { services: { ollama: { host: string } } }).services.ollama.host =
          'http://docker-host.internal:11434';
        const service = new LlmEndpointService(logger as never);
        service.onModuleInit();

        await expect(service.preflight(rejecting(connectTimeout()))).resolves.toHaveProperty('fixCommand');
      } finally {
        if (previous === undefined) {
          delete process.env.CI_LLM_HOST_GATEWAY;
        } else {
          process.env.CI_LLM_HOST_GATEWAY = previous;
        }
      }
    });

    it('gives a server elsewhere on the network a timeout message without the ufw rule', async () => {
      (config as { llm: { apiBase?: string } }).llm.apiBase = 'http://192.168.1.50:8000/v1';
      const service = new LlmEndpointService(logger as never);
      service.onModuleInit();

      const result = await service.preflight(rejecting(connectTimeout()));

      expect(result).toMatchObject({ reason: 'timeout', endpoint: 'http://192.168.1.50:8000/v1' });
      expect(lookup).not.toHaveBeenCalled();
      expect(result.message).toBe(
        '192.168.1.50:8000 did not answer in time. Check that the server is up and that no firewall on the way drops the connection.',
      );
      expect(result).not.toHaveProperty('fixCommand');
    });

    it('names a host that does not resolve', async () => {
      const result = await onTheHost().preflight(
        rejecting(fetchFailed('getaddrinfo ENOTFOUND host.docker.internal', 'ENOTFOUND')),
      );

      expect(result.reason).toBe('host_not_found');
      expect(result.message).toMatch(
        /^host\.docker\.internal does not resolve inside the Memory API container/,
      );
    });

    it('keeps the generic message for a failure it cannot place', async () => {
      const result = await onTheHost().preflight(rejecting(new TypeError('fetch failed')));

      expect(result).toEqual({
        backend: 'ollama',
        endpoint: 'http://host.docker.internal:11434',
        ok: false,
        models: [],
        message:
          'Could not reach this server from the Memory API. Verify the port is exposed to the API container.',
      });
    });

    it('logs the failure kind and the cause code, never the credential', async () => {
      (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiBase =
        'https://operator:url-secret@192.168.1.50:8443/v1';
      (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiKey = 'deployment-key';
      const service = new LlmEndpointService(logger as never);
      service.onModuleInit();

      await service.preflight(
        rejecting(fetchFailed('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT')),
      );

      expect(logger.warn).toHaveBeenCalledWith('LLM endpoint preflight failed', {
        backend: 'openai_compatible',
        endpoint: 'https://192.168.1.50:8443/v1',
        error: 'TypeError',
        reason: 'tls',
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/deployment-key|url-secret|operator/);
    });

    it('logs the code of a failure it cannot place', async () => {
      await onTheHost().preflight(rejecting(fetchFailed('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT')));

      expect(logger.warn).toHaveBeenCalledWith(
        'LLM endpoint preflight failed',
        expect.objectContaining({ reason: 'unknown', code: 'UND_ERR_HEADERS_TIMEOUT' }),
      );
    });

    it('describes a failure for other routes without the ufw sentence, and nothing for other errors', () => {
      const service = onTheHost();

      expect(service.describeConnectionFailure(connectTimeout())).toEqual({
        reason: 'timeout',
        code: 'UND_ERR_CONNECT_TIMEOUT',
        message:
          "host.docker.internal:11434 did not answer in time. On the computer Memory runs on, that usually means a firewall is dropping connections from Memory's containers.",
        fixCommand: 'sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp',
      });
      expect(service.describeConnectionFailure(new Error('model not found'))).toBeNull();
    });
  });
});
