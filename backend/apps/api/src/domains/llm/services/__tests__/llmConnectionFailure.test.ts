import type { networkInterfaces } from 'node:os';

import { APIConnectionError, APIConnectionTimeoutError } from 'openai';

import {
  classifyConnectionError,
  connectionFailureMessage,
  containerSourceRange,
  firstErrorCode,
  ufwAllowCommand,
} from '../llmConnectionFailure';

/** What Node's fetch (undici) rejects with: a bare TypeError, the reason in `cause`. */
function fetchFailed(cause: Error): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause });
}

function withCode(message: string, code: string, name = 'Error'): Error {
  return Object.assign(new Error(message), { code, name });
}

type Interfaces = ReturnType<typeof networkInterfaces>;

function ipv4(address: string, prefix: number, internal = false): Interfaces[string] {
  return [
    {
      address,
      netmask: '',
      family: 'IPv4',
      mac: '02:42:ac:11:00:02',
      internal,
      cidr: `${address}/${prefix}`,
    },
  ];
}

describe('classifyConnectionError', () => {
  it.each([
    ['ECONNREFUSED', 'connect ECONNREFUSED 172.17.0.1:11434', 'refused'],
    [
      'UND_ERR_CONNECT_TIMEOUT',
      'Connect Timeout Error (attempted address: host.docker.internal:11434, timeout: 10000ms)',
      'timeout',
    ],
    ['ETIMEDOUT', 'connect ETIMEDOUT 172.17.0.1:11434', 'timeout'],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND host.docker.internal', 'host_not_found'],
    ['EAI_AGAIN', 'getaddrinfo EAI_AGAIN ollama.lan', 'host_not_found'],
    ['EHOSTUNREACH', 'connect EHOSTUNREACH 172.17.0.1:11434', 'no_route'],
    ['ECONNRESET', 'read ECONNRESET', 'reset'],
    ['UND_ERR_SOCKET', 'other side closed', 'reset'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames", 'tls'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'wrong version number', 'tls'],
  ])('reads %s from the cause of a fetch failure', (code, message, reason) => {
    expect(classifyConnectionError(fetchFailed(withCode(message, code)))).toEqual({ reason, code });
  });

  it('treats the preflight’s own AbortSignal timeout as a timeout', () => {
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    expect(classifyConnectionError(error)).toEqual({ reason: 'timeout', code: 'TimeoutError' });
  });

  it('finds the code under the OpenAI SDK’s wrapper, and its own timeout', () => {
    const wrapped = new APIConnectionError({
      cause: fetchFailed(withCode('connect ECONNREFUSED 172.17.0.1:8000', 'ECONNREFUSED')),
    });

    expect(classifyConnectionError(wrapped)).toEqual({ reason: 'refused', code: 'ECONNREFUSED' });
    expect(classifyConnectionError(new APIConnectionTimeoutError())).toEqual({
      reason: 'timeout',
      code: 'APIConnectionTimeoutError',
    });
  });

  it('looks inside an AggregateError from a connection that tried several addresses', () => {
    const aggregate = new AggregateError([
      withCode('connect ECONNREFUSED ::1:11434', 'ECONNREFUSED'),
      withCode('connect ECONNREFUSED 127.0.0.1:11434', 'ECONNREFUSED'),
    ]);

    expect(classifyConnectionError(fetchFailed(aggregate))).toEqual({
      reason: 'refused',
      code: 'ECONNREFUSED',
    });
  });

  it('leaves a server that accepted and then stalled unclassified, so it gets no firewall advice', () => {
    const stalled = fetchFailed(withCode('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT'));

    expect(classifyConnectionError(stalled)).toBeNull();
    expect(firstErrorCode(stalled)).toBe('UND_ERR_HEADERS_TIMEOUT');
  });

  it('returns null for errors that are not connection failures, and survives a cause cycle', () => {
    const cyclic = new Error('loop') as Error & { cause?: unknown };
    cyclic.cause = cyclic;

    expect(classifyConnectionError(new TypeError('fetch failed'))).toBeNull();
    expect(classifyConnectionError(new SyntaxError('Unexpected token'))).toBeNull();
    expect(classifyConnectionError(cyclic)).toBeNull();
    expect(classifyConnectionError('boom')).toBeNull();
    expect(firstErrorCode(cyclic)).toBeUndefined();
  });
});

describe('containerSourceRange', () => {
  it('uses the whole Docker default pool when the container sits in it', () => {
    expect(containerSourceRange({ lo: ipv4('127.0.0.1', 8, true), eth0: ipv4('172.18.0.5', 16) })).toBe(
      '172.16.0.0/12',
    );
  });

  it('falls back to the container’s own network outside the default pool', () => {
    expect(containerSourceRange({ lo: ipv4('127.0.0.1', 8, true), eth0: ipv4('192.168.16.5', 20) })).toBe(
      '192.168.16.0/20',
    );
    expect(containerSourceRange({ eth0: ipv4('10.42.7.9', 24) })).toBe('10.42.7.0/24');
  });

  it('prefers the default pool when the container is on several networks', () => {
    expect(containerSourceRange({ eth0: ipv4('192.168.16.5', 20), eth1: ipv4('172.20.0.3', 16) })).toBe(
      '172.16.0.0/12',
    );
  });

  it('gives nothing when there is no external IPv4 address to go by', () => {
    expect(containerSourceRange({ lo: ipv4('127.0.0.1', 8, true) })).toBeUndefined();
    expect(
      containerSourceRange({
        eth0: [
          {
            address: 'fd00::5',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '02:42:ac:11:00:02',
            internal: false,
            cidr: 'fd00::5/64',
            scopeid: 0,
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('ufwAllowCommand', () => {
  it('allows the range to the configured port over TCP', () => {
    expect(ufwAllowCommand(11434, '172.16.0.0/12')).toBe(
      'sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp',
    );
  });
});

describe('connectionFailureMessage', () => {
  const onHost = { hostname: 'host.docker.internal', port: 11434, onHost: true };
  const onLan = { hostname: '192.168.1.50', port: 8000, onHost: false };

  it('names the address it tried in every case', () => {
    for (const reason of ['refused', 'timeout', 'no_route', 'reset', 'tls'] as const) {
      expect(connectionFailureMessage({ reason, code: 'X' }, onHost)).toContain('host.docker.internal:11434');
      expect(connectionFailureMessage({ reason, code: 'X' }, onLan)).toContain('192.168.1.50:8000');
    }

    expect(connectionFailureMessage({ reason: 'host_not_found', code: 'ENOTFOUND' }, onHost)).toContain(
      'host.docker.internal',
    );
  });

  it('blames a firewall for a timeout on the host, and not for one elsewhere', () => {
    expect(connectionFailureMessage({ reason: 'timeout', code: 'UND_ERR_CONNECT_TIMEOUT' }, onHost)).toBe(
      "host.docker.internal:11434 did not answer in time. On the computer Memory runs on, that usually means a firewall is dropping connections from Memory's containers.",
    );
    expect(
      connectionFailureMessage({ reason: 'timeout', code: 'UND_ERR_CONNECT_TIMEOUT' }, onLan),
    ).not.toMatch(/computer Memory runs on/);
  });

  it('points a refusal on the host at a server bound to loopback only', () => {
    expect(connectionFailureMessage({ reason: 'refused', code: 'ECONNREFUSED' }, onHost)).toMatch(
      /isn't listening on 127\.0\.0\.1 only/,
    );
    expect(connectionFailureMessage({ reason: 'refused', code: 'ECONNREFUSED' }, onLan)).toBe(
      '192.168.1.50:8000 refused the connection. Check that the server is running and listening on port 8000.',
    );
  });
});
