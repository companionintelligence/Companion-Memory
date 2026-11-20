import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/**
 * Why a request to the inference server got no HTTP answer at all.
 *
 * - `refused`: nothing accepted the connection on that port.
 * - `timeout`: no answer in time, which is what a firewall that drops packets looks like.
 * - `host_not_found`: the name did not resolve.
 * - `no_route`: the network said there is no way to that address.
 * - `reset`: the connection opened and was closed without an answer.
 * - `tls`: the secure connection could not be set up.
 */
export type LlmConnectionFailureReason =
  'refused' | 'timeout' | 'host_not_found' | 'no_route' | 'reset' | 'tls';

export interface LlmConnectionFailureKind {
  reason: LlmConnectionFailureReason;
  /** The code that decided it (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, `TimeoutError`), for logs. */
  code: string;
}

/** Docker gives its bridge networks 172.17.0.0/16 to 172.31.0.0/16 first, all inside this block. */
const DOCKER_DEFAULT_POOL = { network: 0xac100000, prefix: 12, text: '172.16.0.0/12' };

function reasonForCode(code: string): LlmConnectionFailureReason | null {
  switch (code) {
    case 'ECONNREFUSED':
      return 'refused';
    // Only connect timeouts. UND_ERR_HEADERS_TIMEOUT and UND_ERR_BODY_TIMEOUT mean the server
    // accepted the connection and then stalled, which no firewall advice would fix.
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
      return 'timeout';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
    case 'EAI_FAIL':
      return 'host_not_found';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
    case 'ENETDOWN':
      return 'no_route';
    case 'ECONNRESET':
    case 'ECONNABORTED':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return 'reset';
    default:
      return /^ERR_(TLS|SSL)_/.test(code) || /CERT/.test(code) || code === 'EPROTO' ? 'tls' : null;
  }
}

/**
 * The error and everything under it: its `cause` chain, and the per-address errors of an
 * `AggregateError`. Bounded, and safe against a cause that points back up the chain.
 */
function* errorChain(error: unknown): Generator<object> {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0 && seen.size < 16) {
    const current = queue.shift();

    if (current == null || typeof current !== 'object' || seen.has(current)) {
      continue;
    }

    seen.add(current);
    yield current;

    const { cause, errors } = current as { cause?: unknown; errors?: unknown };

    queue.push(cause);

    if (Array.isArray(errors)) {
      queue.push(...errors);
    }
  }
}

/**
 * What kind of connection failure `error` is, found on the error or anywhere down its `cause` chain.
 *
 * Node's fetch (undici) rejects with a bare `TypeError: fetch failed` and puts the reason in `cause`:
 * an `Error` with `code: 'ECONNREFUSED'`, a `ConnectTimeoutError` with `code: 'UND_ERR_CONNECT_TIMEOUT'`,
 * and so on. The OpenAI SDK wraps that again in its `APIConnectionError`, and a connection that tried
 * several addresses fails with an `AggregateError` holding one error per address. An abort from
 * `AbortSignal.timeout()` arrives as a `TimeoutError` with no cause. Null when nothing in the chain is
 * a connection failure (an HTTP error, a bad payload, a redirect).
 */
export function classifyConnectionError(error: unknown): LlmConnectionFailureKind | null {
  for (const current of errorChain(error)) {
    const { code, name } = current as { code?: unknown; name?: unknown };
    const reason = typeof code === 'string' ? reasonForCode(code) : null;

    if (reason && typeof code === 'string') {
      return { reason, code };
    }

    if (name === 'TimeoutError' || name === 'AbortError') {
      return { reason: 'timeout', code: name };
    }

    // The OpenAI SDK's own timeout. Its error classes keep the default `name`, so ask the class.
    if (current.constructor?.name === 'APIConnectionTimeoutError') {
      return { reason: 'timeout', code: 'APIConnectionTimeoutError' };
    }
  }

  return null;
}

/** The first string `code` on the error or its causes, for a log line about a failure nothing classified. */
export function firstErrorCode(error: unknown): string | undefined {
  for (const current of errorChain(error)) {
    const { code } = current as { code?: unknown };

    if (typeof code === 'string') {
      return code;
    }
  }

  return undefined;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.').map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** `172.18.0.5/16` to `172.18.0.0/16`; undefined for anything that isn't an IPv4 CIDR. */
function networkOf(cidr: string | null): string | undefined {
  const [address, prefixText] = (cidr ?? '').split('/');
  const value = ipv4ToInt(address);
  const prefix = Number(prefixText);

  if (value == null || prefixText === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return undefined;
  }

  return `${intToIpv4((value & maskOf(prefix)) >>> 0)}/${prefix}`;
}

function inDockerDefaultPool(address: string): boolean {
  const value = ipv4ToInt(address);

  return value != null && (value & maskOf(DOCKER_DEFAULT_POOL.prefix)) >>> 0 === DOCKER_DEFAULT_POOL.network;
}

/**
 * The source range a host firewall sees for connections from this container.
 *
 * `172.16.0.0/12` when this container has an address in it. Docker hands out its default bridge
 * networks from there, so a rule for the whole block keeps working when compose re-creates the
 * network with another /16. Otherwise (a daemon with its own `default-address-pools`, or Docker
 * having moved on to 192.168.x.x) the container's own network. Undefined when this process has no
 * IPv4 address to go by.
 */
export function containerSourceRange(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | undefined {
  const ipv4 = Object.values(interfaces)
    .flat()
    .filter(
      (entry): entry is NetworkInterfaceInfo => entry != null && !entry.internal && entry.family === 'IPv4',
    );

  if (ipv4.some((entry) => inDockerDefaultPool(entry.address))) {
    return DOCKER_DEFAULT_POOL.text;
  }

  return ipv4.map((entry) => networkOf(entry.cidr)).find((network) => network != null);
}

/** A ufw rule that lets this container's connections through to `port` on the host. */
export function ufwAllowCommand(port: number, range: string): string {
  return `sudo ufw allow from ${range} to any port ${port} proto tcp`;
}

/** Where a failed request was going, as the person configured it. */
export interface ConnectionTarget {
  hostname: string;
  port: number;
  /** The server runs on the machine the containers run on (see `isHostGatewayName`). */
  onHost: boolean;
}

/**
 * Plain words for a connection failure: what was tried, what happened and the likely cause. Names the
 * address but never the URL, which can carry a credential. Says "the computer Memory runs on" rather
 * than "this computer", since the person reading it may be on a phone.
 */
export function connectionFailureMessage(kind: LlmConnectionFailureKind, target: ConnectionTarget): string {
  const address = `${target.hostname}:${target.port}`;

  switch (kind.reason) {
    case 'refused':
      return target.onHost
        ? `${address} refused the connection. Check that the server is running on the computer Memory runs on and isn't listening on 127.0.0.1 only, which Memory's containers can't reach.`
        : `${address} refused the connection. Check that the server is running and listening on port ${target.port}.`;
    case 'timeout':
      return target.onHost
        ? `${address} did not answer in time. On the computer Memory runs on, that usually means a firewall is dropping connections from Memory's containers.`
        : `${address} did not answer in time. Check that the server is up and that no firewall on the way drops the connection.`;
    case 'host_not_found':
      return target.onHost
        ? `${target.hostname} does not resolve inside the Memory API container, so it can't reach the computer it runs on. Its compose service needs extra_hosts: ${target.hostname}:host-gateway.`
        : `${target.hostname} could not be found from the Memory API. Check the server name, or use its IP address.`;
    case 'no_route':
      return target.onHost
        ? `There is no network route from the Memory API container to ${address}. A firewall on the computer Memory runs on that rejects connections from its containers can cause this.`
        : `There is no network route from the Memory API to ${address}. Check that the computer Memory runs on can reach the server's network.`;
    case 'reset':
      return `${address} closed the connection without answering. Check that port ${target.port} belongs to the inference server.`;
    case 'tls':
      return `The secure connection to ${address} failed (${kind.code}). Check the server's certificate.`;
  }
}
