import { join } from 'node:path';

import { Injectable, OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config, { LLM_API_KEY_PLACEHOLDER } from '@ci/configuration';

import {
  classifyConnectionError,
  connectionFailureMessage,
  containerSourceRange,
  firstErrorCode,
  hostIpv4,
  ufwAllowCommand,
  type ConnectionTarget,
  type LlmConnectionFailureReason,
  type LookupIpv4,
} from './llmConnectionFailure';
import {
  containerSharedConfigPath,
  DEFAULT_OPENAI_BASE_PATH,
  isHostGatewayName,
  normalizeBasePath,
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
  /** OpenAI-compatible only: the server's API root, `/v1` unless the server mounts it elsewhere (Lemonade: `/api/v1`). */
  basePath?: string;
  apiKey?: string;
}

/** Settings accepted from the Settings screen and the appliance CLI. */
export interface LlmEndpointUpdate {
  backend: LlmBackendKind;
  port: number;
  basePath?: string;
  /** Replaces the stored credential. It is deliberately write-only. */
  apiKey?: string;
  /** Removes a credential saved by this appliance and falls back to runtime config. */
  clearApiKey?: boolean;
}

/** Safe-to-return representation of an inference endpoint. */
export interface LlmEndpointView {
  backend: LlmBackendKind;
  port: number;
  /** The API root in use on an OpenAI-compatible backend; absent on Ollama. */
  basePath?: string;
  /** Hostname the API container uses to reach an inference server on the host. */
  hostGateway: string;
  /** True when Hub/env injected LLM_* and settings cannot override. */
  locked: boolean;
  /** The normalized endpoint the API container will contact (never carries credentials). */
  endpoint: string;
  /**
   * Whether someone set a credential, without exposing its value. False for the built-in
   * placeholder ({@link LLM_API_KEY_PLACEHOLDER}), which is still sent as the bearer.
   */
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
  /** Set when the request got no HTTP answer at all: what went wrong on the way. */
  reason?: LlmConnectionFailureReason;
  /**
   * A command for the person to run on the computer the containers run on, shown as code after
   * {@link message}. Only for a server on that computer that did not answer in time: a ufw rule that
   * lets Memory's containers through. Memory never runs it.
   */
  fixCommand?: string;
}

/** A request to the endpoint that got no HTTP answer, described for a person. */
export interface LlmEndpointConnectionFailure {
  reason: LlmConnectionFailureReason;
  /** The error code that decided {@link reason}, for logs. */
  code: string;
  /** The address tried, what happened and the likely cause. Carries no credential and no command. */
  message: string;
  /** See {@link LlmEndpointPreflight.fixCommand}. */
  fixCommand?: string;
}

/** Ends a preflight message that has a {@link LlmEndpointPreflight.fixCommand} to show after it. */
const UFW_HINT = 'If that computer runs Linux with ufw, this rule lets them through:';

const GENERIC_UNREACHABLE_MESSAGE =
  'Could not reach this server from the Memory API. Verify the port is exposed to the API container.';

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
        basePath: basePathFromUrl(config.llm.apiBase),
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

/** The path of an injected `LLM_API_BASE`, so the view reports Lemonade's `/api/v1` rather than assuming `/v1`. */
function basePathFromUrl(url: string | undefined): string {
  try {
    return normalizeBasePath(url ? new URL(url).pathname : undefined);
  } catch {
    return DEFAULT_OPENAI_BASE_PATH;
  }
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

function connectionTarget(url: string): ConnectionTarget | null {
  try {
    const { hostname } = new URL(url);

    return { hostname, port: portFromUrl(url, 80), onHost: isHostGatewayName(hostname) };
  } catch {
    return null;
  }
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
      ? managedApiBase?.trim() ||
        `http://${hostGateway}:${settings.port}${normalizeBasePath(settings.basePath)}`
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
      ...(this.resolved.settings.backend === 'openai_compatible' && {
        basePath: normalizeBasePath(this.resolved.settings.basePath),
      }),
      hostGateway: this.resolved.hostGateway,
      locked: this.resolved.locked,
      endpoint: safeEndpoint(this.resolved.apiBase ?? this.resolved.ollamaHost),
      // A key saved here always counts, even the placeholder's own word (Ollama's docs say to
      // type it, and Settings saved it back for a while): it overrides LLM_API_KEY, so Settings
      // must keep offering to remove it.
      apiKeyConfigured:
        this.persistedApiKey != null ||
        (this.resolved.apiKey.length > 0 && this.resolved.apiKey !== LLM_API_KEY_PLACEHOLDER),
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
      ...(settings.backend === 'openai_compatible' && { basePath: normalizeBasePath(settings.basePath) }),
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
  async preflight(fetchImpl: typeof fetch = fetch, lookupImpl?: LookupIpv4): Promise<LlmEndpointPreflight> {
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
      let failure = this.describeConnectionFailure(error);

      // The rule names the address the containers connect to, so it opens the port to them and
      // not to a LAN that happens to share 172.16.0.0/12. It falls back to `to any` when the name
      // does not resolve here.
      if (failure?.fixCommand) {
        const hostname = connectionTarget(requestUrl)?.hostname;
        const address = hostname ? await hostIpv4(hostname, lookupImpl) : undefined;

        failure = address ? this.describeConnectionFailure(error, address) : failure;
      }

      this.logger.warn('LLM endpoint preflight failed', {
        backend: this.resolved.settings.backend,
        endpoint,
        error: error instanceof Error ? error.name : String(error),
        reason: failure?.reason ?? 'unknown',
        code: failure?.code ?? firstErrorCode(error) ?? null,
      });

      if (!failure) {
        return {
          backend: this.resolved.settings.backend,
          endpoint,
          ok: false,
          models: [],
          message: GENERIC_UNREACHABLE_MESSAGE,
        };
      }

      return {
        backend: this.resolved.settings.backend,
        endpoint,
        ok: false,
        models: [],
        message: failure.fixCommand ? `${failure.message} ${UFW_HINT}` : failure.message,
        reason: failure.reason,
        ...(failure.fixCommand && { fixCommand: failure.fixCommand }),
      };
    }
  }

  /**
   * Why a request to the endpoint got no HTTP answer, in words that name the address it tried and
   * the likely cause. Null when `error` is something else (an HTTP error, a bad payload), which the
   * caller reports its own way.
   *
   * A timeout to a server on the containers' own host gets a ufw rule as well. Docker's iptables
   * rules cover traffic into containers, not from a container to its host, so a host firewall that
   * drops incoming connections silently eats every one of those. `hostAddress` narrows the rule to
   * the address the containers connect to; without it the rule says `to any`.
   */
  describeConnectionFailure(error: unknown, hostAddress?: string): LlmEndpointConnectionFailure | null {
    const kind = classifyConnectionError(error);
    const target = kind ? connectionTarget(endpointRequestUrl(this.resolved)) : null;

    if (!kind || !target) {
      return null;
    }

    const range = kind.reason === 'timeout' && target.onHost ? containerSourceRange() : undefined;

    return {
      ...kind,
      message: connectionFailureMessage(kind, target),
      ...(range && { fixCommand: ufwAllowCommand(target.port, range, hostAddress) }),
    };
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
          basePath: resolved.settings.basePath,
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
          basePath: parsed.basePath,
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
