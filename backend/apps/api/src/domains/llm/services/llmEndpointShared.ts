import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LlmBackendKind = 'ollama' | 'openai_compatible';

export interface PersistedLlmEndpointSettings {
  backend: LlmBackendKind;
  port: number;
  apiKey?: string;
  hostGateway?: string;
}

export interface ResolvedLlmEndpointEnv {
  backend: LlmBackendKind;
  hostGateway: string;
  port: number;
  apiKey: string;
}

const DEFAULT_OLLAMA_PORT = 11434;

/** Host path shared between API and summary-service when APP_DATA_DIR is mounted at /app-data. */
export function sharedConfigPath(): string | null {
  const appDataDir = process.env.APP_DATA_DIR?.trim();

  if (!appDataDir) {
    return null;
  }

  return join(appDataDir, 'data', 'llm-endpoint.json');
}

export function containerSharedConfigPath(): string {
  return process.env.LLM_ENDPOINT_CONFIG_PATH?.trim() || '/app-data/data/llm-endpoint.json';
}

export function llmApiBaseFromSettings(settings: ResolvedLlmEndpointEnv): string {
  if (settings.backend === 'openai_compatible') {
    return `http://${settings.hostGateway}:${settings.port}/v1`;
  }

  return `http://${settings.hostGateway}:${settings.port}/v1`;
}

export function writeSharedConfig(path: string, settings: PersistedLlmEndpointSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
  // `mode` only applies to new files. Tighten an existing file too, because it
  // can carry an OpenAI-compatible bearer credential.
  chmodSync(path, 0o600);
}

export function readSharedConfig(path: string): PersistedLlmEndpointSettings | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedLlmEndpointSettings;

    if (parsed.backend !== 'ollama' && parsed.backend !== 'openai_compatible') {
      return null;
    }

    if (!Number.isFinite(parsed.port) || parsed.port <= 0 || parsed.port > 65535) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** Keep app.env LLM_* in sync so summary-service picks up Settings changes on restart. */
export function syncAppEnvLlmVars(settings: ResolvedLlmEndpointEnv): void {
  const appDataDir = process.env.APP_DATA_DIR?.trim();

  if (!appDataDir) {
    return;
  }

  const appEnvPath = join(appDataDir, 'app.env');

  if (!existsSync(appEnvPath)) {
    return;
  }

  const llmVars: Record<string, string> = {
    LLM_API_BASE: llmApiBaseFromSettings(settings),
    LLM_API_KEY: settings.apiKey,
  };

  const lines = readFileSync(appEnvPath, 'utf8').split('\n');
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);

    if (!match) {
      return line;
    }

    const key = match[1];
    const value = llmVars[key];

    if (value === undefined) {
      return line;
    }

    seen.add(key);

    return `${key}=${value}`;
  });

  for (const [key, value] of Object.entries(llmVars)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  writeFileSync(appEnvPath, nextLines.join('\n'));
}

export function inferHostGatewayFromEnv(): string {
  for (const candidate of [
    process.env.OLLAMA_HOST,
    process.env.LLM_API_BASE,
    process.env.CI_OLLAMA_EMBED_HOST,
  ]) {
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

export function portFromUrl(url: string | undefined, fallback: number): number {
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

/**
 * Hostname a container uses to reach a service on the Docker host. Docker
 * injects it into the container's /etc/hosts; it exists in no real DNS zone.
 */
export const DEFAULT_HOST_GATEWAY = 'host.docker.internal';

/** Hostnames that name "this network namespace" — different thing on each side. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** The two names Docker injects. Neither resolves outside a container. */
const GATEWAY_HOSTS = new Set([DEFAULT_HOST_GATEWAY, 'gateway.docker.internal']);

export function hostGateway(env: NodeJS.ProcessEnv = process.env): string {
  return env.CI_LLM_HOST_GATEWAY?.trim() || DEFAULT_HOST_GATEWAY;
}

export function llmHostRewriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CI_LLM_HOST_REWRITE?.trim().toLowerCase() ?? '';

  return !['off', '0', 'false', 'no'].includes(value);
}

/**
 * Is this process inside a container?
 *
 * /.dockerenv is Docker's marker and /run/.containerenv is Podman's; the cgroup
 * scan catches runtimes that write neither. Any one of the three can be missing
 * on a normal container, so all three are tried before concluding "host".
 */
export function runtimeIsContainer(): boolean {
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
    return true;
  }

  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');

    return ['docker', 'containerd', 'kubepods', 'lxc'].some((marker) => cgroup.includes(marker));
  } catch {
    return false;
  }
}

/**
 * Does this name resolve from here?
 *
 * Reads /etc/hosts rather than DNS because config is assembled synchronously at
 * import and node has no synchronous resolver — and because the only names this
 * is ever asked about are the ones Docker writes into exactly that file. An
 * operator-supplied CI_LLM_HOST_GATEWAY may well be a real DNS name that never
 * appears there, so callers trust an override rather than asking. (The python
 * sidecars ask getaddrinfo, which needs no such carve-out; same answers for the
 * cases that matter.)
 */
export function gatewayHostIsPresent(host: string): boolean {
  try {
    return readFileSync('/etc/hosts', 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .some((line) => line.trim().split(/\s+/).slice(1).includes(host));
  } catch {
    return false;
  }
}

/**
 * Swap the host inside the authority, leaving the rest of the string byte for
 * byte alone.
 *
 * Deliberately textual rather than `new URL(...).hostname = x`: URL#toString
 * normalizes, and it would turn `http://localhost:11434` into a trailing-slashed
 * `http://host.docker.internal:11434/`. Callers concatenate onto these values
 * (`${host}/api/tags`), so an added slash is a broken path, not a cosmetic
 * difference.
 */
function withHost(raw: string, nextHost: string): string {
  const schemeEnd = raw.indexOf('://');

  if (schemeEnd < 0) {
    return raw;
  }

  const start = schemeEnd + 3;
  const rest = raw.slice(start);
  const boundary = rest.search(/[/?#]/);
  const authority = boundary === -1 ? rest : rest.slice(0, boundary);
  const tail = boundary === -1 ? '' : rest.slice(boundary);
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? '' : authority.slice(0, at + 1);
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  // A colon after the last `]` is a port; one before it belongs to an IPv6 host.
  const colon = hostPort.lastIndexOf(':');
  const port = colon > hostPort.lastIndexOf(']') ? hostPort.slice(colon) : '';

  return `${raw.slice(0, start)}${userinfo}${nextHost}${port}${tail}`;
}

export interface ResolvedLlmUrl {
  url: string;
  /** Set when something was changed, or is known broken. Log it; never swallow. */
  note?: string;
}

/**
 * Correct an inference URL for the network namespace this process is in.
 *
 * `LLM_API_BASE` is written once, in .env, and read from both sides of a
 * container boundary: this API runs on the host under `make dev` and in a
 * container under staging/production compose, while the two python sidecars are
 * always containers. `localhost` names the container itself once you are inside
 * one, and `host.docker.internal` resolves nowhere on a macOS or linux host — so
 * whichever one .env picks, the other side is silently pointed at nothing, and
 * `${LLM_API_BASE:-<good default>}` means a set-but-wrong value beats the
 * correct default compose ships.
 *
 * The hostname is therefore advisory, and each consumer corrects it for where it
 * actually is. Only the host changes: scheme, port, path and query survive, so a
 * `/v1` suffix or a vLLM port is preserved. Mirrors `llm_host.py` in both python
 * sidecars — change all three together.
 */
export function resolveLlmUrlForRuntime(
  raw: string | undefined,
  options: {
    inContainer?: boolean;
    gatewayPresent?: (host: string) => boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): ResolvedLlmUrl {
  const value = raw?.trim() ?? '';
  const env = options.env ?? process.env;

  if (!value || !llmHostRewriteEnabled(env)) {
    return { url: value };
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return { url: value };
  }

  const gateway = hostGateway(env);
  const present = options.gatewayPresent ?? gatewayHostIsPresent;
  const inContainer = options.inContainer ?? runtimeIsContainer();
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // An operator who named a gateway of their own is taken at their word: it may
  // be a real DNS name, which /etc/hosts would never list.
  const gatewayReachable = gateway !== DEFAULT_HOST_GATEWAY || present(gateway);

  if (LOOPBACK_HOSTS.has(host)) {
    // Correct as written when we are the host — the common `make dev` case.
    if (!inContainer) {
      return { url: value };
    }

    if (gatewayReachable) {
      const fixed = withHost(value, gateway);

      return {
        url: fixed,
        note:
          `${value} names this container, not the machine running the model; using ${fixed} ` +
          `instead. Set CI_LLM_HOST_REWRITE=off to keep the URL exactly as configured.`,
      };
    }

    return {
      url: value,
      note:
        `${value} names this container, and ${gateway} does not resolve here, so there is no ` +
        `host address to substitute. An inference server on the docker host is unreachable ` +
        `until this container gets a route to it (compose: extra_hosts: ${gateway}:host-gateway).`,
    };
  }

  if (GATEWAY_HOSTS.has(host) && !present(host)) {
    if (inContainer) {
      return {
        url: value,
        note:
          `${value} does not resolve in this container. Give it a route to the docker host ` +
          `(compose: extra_hosts: ${host}:host-gateway).`,
      };
    }

    const fixed = withHost(value, 'localhost');

    return {
      url: fixed,
      note:
        `${value} does not resolve outside a container; using ${fixed} instead. ` +
        `Set CI_LLM_HOST_REWRITE=off to keep the URL exactly as configured.`,
    };
  }

  return { url: value };
}

export { DEFAULT_OLLAMA_PORT };
