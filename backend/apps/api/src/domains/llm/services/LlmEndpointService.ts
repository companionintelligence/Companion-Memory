import { join } from 'node:path';

import { Injectable, OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import {
  containerSharedConfigPath,
  readSharedConfig,
  sharedConfigPath,
  syncAppEnvLlmVars,
  writeSharedConfig,
  type LlmBackendKind,
  type PersistedLlmEndpointSettings,
} from './llmEndpointShared';
import { OpenAiCompatChatDriver } from './OpenAiCompatChatDriver';

export type { LlmBackendKind };

/** User-facing LLM endpoint settings (backend kind + port). */
export interface LlmEndpointSettings {
  backend: LlmBackendKind;
  port: number;
  apiKey?: string;
}

/** Settings accepted from the Settings screen and the appliance CLI. */
export interface LlmEndpointUpdate {
  backend: LlmBackendKind;
  port: number;
  /** Replaces the stored credential. It is deliberately write-only. */
  apiKey?: string;
  /** Removes a credential saved by this appliance and falls back to runtime config. */
  clearApiKey?: boolean;
}

/** Safe-to-return representation of an inference endpoint. */
export interface LlmEndpointView {
  backend: LlmBackendKind;
  port: number;
  /** Hostname the API container uses to reach an inference server on the host. */
  hostGateway: string;
  /** True when Hub/env injected LLM_* and settings cannot override. */
  locked: boolean;
  /** The normalized endpoint the API container will contact (never carries credentials). */
  endpoint: string;
  /** Whether a credential is available, without exposing its value. */
  apiKeyConfigured: boolean;
}

/** Result of a bounded reachability and model-discovery check. */
export interface LlmEndpointPreflight {
  backend: LlmBackendKind;
  endpoint: string;
  ok: boolean;
  /** Model ids/names returned by the backend when the check succeeds. */
  models: string[];
  /** A safe, actionable status for a person or CLI; never includes a credential. */
  message?: string;
  status?: number;
}

interface ResolvedLlmEndpoint {
  settings: LlmEndpointSettings;
  hostGateway: string;
  ollamaHost: string;
  apiBase?: string;
  apiKey: string;
  locked: boolean;
}

const DEFAULT_OLLAMA_PORT = 11434;
const DEFAULT_OPENAI_PORT = 8000;

function inferHostGateway(): string {
  for (const candidate of [config.services.ollama.host, config.llm.apiBase]) {
    if (!candidate) {
      continue;
    }

    try {
      return new URL(candidate).hostname;
    } catch {
      // keep trying
    }
  }

  return 'host.docker.internal';
}

function portFromUrl(url: string | undefined, fallback: number): number {
  if (!url) {
    return fallback;
  }

  try {
    const parsed = new URL(url);

    return parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return fallback;
  }
}

function envPointsToOpenAiCompat(): boolean {
  const apiBase = config.llm.apiBase?.trim();

  if (!apiBase) {
    return false;
  }

  const ollamaPort = portFromUrl(config.services.ollama.host, DEFAULT_OLLAMA_PORT);
  const apiPort = portFromUrl(apiBase, DEFAULT_OPENAI_PORT);

  return apiPort !== ollamaPort;
}

function settingsFromEnv(): {
  settings: LlmEndpointSettings;
  hostGateway: string;
  locked: boolean;
  /** Keep an injected gateway's scheme and path (for example Hub's /api/inference/v1). */
  apiBase?: string;
} {
  const hostGateway = inferHostGateway();
  const ollamaPort = portFromUrl(config.services.ollama.host, DEFAULT_OLLAMA_PORT);

  if (envPointsToOpenAiCompat()) {
    return {
      hostGateway,
      locked: true,
      settings: {
        backend: 'openai_compatible',
        port: portFromUrl(config.llm.apiBase, DEFAULT_OPENAI_PORT),
        apiKey: config.llm.apiKey,
      },
      apiBase: config.llm.apiBase?.trim(),
    };
  }

  return {
    hostGateway,
    locked: false,
    settings: {
      backend: 'ollama',
      port: ollamaPort,
      apiKey: config.llm.apiKey,
    },
  };
}

function isForeignApiBase(apiBase: string | undefined, ollamaHost: string): boolean {
  if (!apiBase) {
    return false;
  }

  try {
    return new URL(apiBase).host !== new URL(ollamaHost).host;
  } catch {
    return true;
  }
}

function safeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);

    // Configuration can be injected by an operator. Keep a malformed or
    // credential-bearing URL out of Settings, CLI output, logs and errors.
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return 'configured inference endpoint';
  }
}

function endpointRequestUrl(resolved: ResolvedLlmEndpoint): string {
  if (resolved.settings.backend === 'ollama') {
    return `${resolved.ollamaHost.replace(/\/$/, '')}/api/tags`;
  }

  return `${resolved.apiBase?.replace(/\/$/, '') ?? ''}/models`;
}

function modelsFromPreflightPayload(backend: LlmBackendKind, payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const rawModels = backend === 'ollama' ? record.models : record.data;

  if (!Array.isArray(rawModels)) {
    return [];
  }

  const key = backend === 'ollama' ? 'name' : 'id';

  return [
    ...new Set(
      rawModels
        .map((model) => (model && typeof model === 'object' ? (model as Record<string, unknown>)[key] : null))
        .filter((model): model is string => typeof model === 'string' && model.trim().length > 0),
    ),
  ];
}

export class LlmEndpointLockedError extends Error {
  constructor() {
    super('LLM endpoint is managed by Companion Hub or the host environment and cannot be changed here.');
    this.name = 'LlmEndpointLockedError';
  }
}

function buildResolved(
  settings: LlmEndpointSettings,
  hostGateway: string,
  locked: boolean,
  managedApiBase?: string,
): ResolvedLlmEndpoint {
  const ollamaHost = `http://${hostGateway}:${settings.backend === 'ollama' ? settings.port : DEFAULT_OLLAMA_PORT}`;
  const apiBase =
    settings.backend === 'openai_compatible'
      ? managedApiBase?.trim() || `http://${hostGateway}:${settings.port}/v1`
      : undefined;

  return {
    settings,
    hostGateway,
    ollamaHost: settings.backend === 'ollama' ? `http://${hostGateway}:${settings.port}` : ollamaHost,
    apiBase,
    apiKey: settings.apiKey?.trim() || config.llm.apiKey?.trim() || '',
    locked,
  };
}

@Injectable()
export class LlmEndpointService implements OnModuleInit {
  private resolved!: ResolvedLlmEndpoint;

  private openAiDriver: OpenAiCompatChatDriver | null = null;

  /**
   * The credential saved in llm-endpoint.json, as distinct from a deployment
   * default in LLM_API_KEY. This distinction lets an empty Settings form keep
   * an operator-provided key from being copied into the appliance config.
   */
  private persistedApiKey: string | undefined;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(LlmEndpointService.name);
  }

  onModuleInit(): void {
    this.reload();
  }

  getView(): LlmEndpointView {
    return {
      backend: this.resolved.settings.backend,
      port: this.resolved.settings.port,
      hostGateway: this.resolved.hostGateway,
      locked: this.resolved.locked,
      endpoint: safeEndpoint(this.resolved.apiBase ?? this.resolved.ollamaHost),
      apiKeyConfigured: this.resolved.apiKey.length > 0,
    };
  }

  getOllamaHost(): string {
    return this.resolved.ollamaHost;
  }

  getOpenAiDriver(): OpenAiCompatChatDriver | null {
    return this.openAiDriver;
  }

  usesOpenAiDriver(): boolean {
    return this.openAiDriver != null;
  }

  update(settings: LlmEndpointUpdate): LlmEndpointView {
    if (this.resolved.locked) {
      throw new LlmEndpointLockedError();
    }

    const hostGateway = this.resolved.hostGateway;
    const changingBackend = settings.backend !== this.resolved.settings.backend;
    const apiKey = settings.clearApiKey
      ? undefined
      : settings.apiKey?.trim() || (changingBackend ? undefined : this.persistedApiKey);
    const persisted = {
      backend: settings.backend,
      port: settings.port,
      ...(apiKey ? { apiKey } : {}),
      hostGateway,
    };

    this.persistedApiKey = apiKey;
    this.apply(buildResolved(persisted, hostGateway, false));
    this.persist(persisted);

    return this.getView();
  }

  /**
   * Test from the API process's network namespace, which is the only path that
   * matters to Memory. A browser or host-side curl can reach localhost while a
   * containerized API cannot, so the check intentionally runs here.
   */
  async preflight(fetchImpl: typeof fetch = fetch): Promise<LlmEndpointPreflight> {
    const endpoint = safeEndpoint(this.resolved.apiBase ?? this.resolved.ollamaHost);
    const requestUrl = endpointRequestUrl(this.resolved);
    const headers =
      this.resolved.settings.backend === 'openai_compatible' && this.resolved.apiKey
        ? { authorization: `Bearer ${this.resolved.apiKey}` }
        : undefined;

    try {
      const response = await fetchImpl(requestUrl, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        return {
          backend: this.resolved.settings.backend,
          endpoint,
          ok: false,
          models: [],
          status: response.status,
          message: `The server answered with HTTP ${response.status}. Check its port and credential.`,
        };
      }

      let payload: unknown;

      try {
        payload = await response.json();
      } catch {
        return {
          backend: this.resolved.settings.backend,
          endpoint,
          ok: false,
          models: [],
          message: 'The server responded, but did not return a valid model list.',
        };
      }

      const models = modelsFromPreflightPayload(this.resolved.settings.backend, payload);

      return {
        backend: this.resolved.settings.backend,
        endpoint,
        ok: true,
        models,
        message:
          models.length === 0
            ? 'Connected, but no models were reported. Install or expose a model before using chat.'
            : `Connected. ${models.length} model${models.length === 1 ? '' : 's'} reported.`,
      };
    } catch (error) {
      this.logger.warn('LLM endpoint preflight failed', {
        backend: this.resolved.settings.backend,
        endpoint,
        error: error instanceof Error ? error.name : String(error),
      });

      return {
        backend: this.resolved.settings.backend,
        endpoint,
        ok: false,
        models: [],
        message:
          'Could not reach this server from the Memory API. Verify the port is exposed to the API container.',
      };
    }
  }

  private reload(): void {
    const fromFile = this.readPersisted();
    const fromEnv = settingsFromEnv();

    if (fromEnv.locked) {
      this.persistedApiKey = undefined;
      this.apply(buildResolved(fromEnv.settings, fromEnv.hostGateway, true, fromEnv.apiBase));

      return;
    }

    if (fromFile) {
      this.persistedApiKey = fromFile.settings.apiKey?.trim() || undefined;
      this.apply(buildResolved(fromFile.settings, fromFile.hostGateway, false), { syncAppEnv: false });

      return;
    }

    this.persistedApiKey = undefined;
    this.apply(buildResolved(fromEnv.settings, fromEnv.hostGateway, false), { syncAppEnv: false });
  }

  private apply(resolved: ResolvedLlmEndpoint, options: { syncAppEnv?: boolean } = {}): void {
    this.resolved = resolved;
    this.openAiDriver =
      resolved.apiBase && isForeignApiBase(resolved.apiBase, resolved.ollamaHost)
        ? new OpenAiCompatChatDriver(resolved.apiBase, resolved.apiKey)
        : null;

    this.logger.log('LLM endpoint resolved', {
      backend: resolved.settings.backend,
      port: resolved.settings.port,
      ollamaHost: resolved.ollamaHost,
      apiBase: resolved.apiBase ? safeEndpoint(resolved.apiBase) : null,
      locked: resolved.locked,
    });

    if (options.syncAppEnv !== false && !resolved.locked) {
      try {
        syncAppEnvLlmVars({
          backend: resolved.settings.backend,
          hostGateway: resolved.hostGateway,
          port: resolved.settings.port,
          apiKey: resolved.apiKey,
        });
      } catch (error) {
        this.logger.warn('Failed to sync LLM vars to app.env', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private configPaths(): string[] {
    const paths = [containerSharedConfigPath(), join(process.cwd(), '.llm-endpoint.json')];
    const hostShared = sharedConfigPath();

    if (hostShared) {
      paths.unshift(hostShared);
    }

    return [...new Set(paths)];
  }

  private readPersisted(): { settings: LlmEndpointSettings; hostGateway: string } | null {
    for (const path of this.configPaths()) {
      const parsed = readSharedConfig(path);

      if (!parsed) {
        continue;
      }

      return {
        settings: {
          backend: parsed.backend,
          port: parsed.port,
          apiKey: parsed.apiKey,
        },
        hostGateway: parsed.hostGateway?.trim() || inferHostGateway(),
      };
    }

    return null;
  }

  private persist(settings: PersistedLlmEndpointSettings): void {
    const paths = this.configPaths();

    for (const path of paths) {
      try {
        writeSharedConfig(path, settings);
      } catch (error) {
        this.logger.warn('Failed to persist LLM endpoint settings', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
