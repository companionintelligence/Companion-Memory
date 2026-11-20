import { createServer, type AddressInfo } from 'node:net';
import type { networkInterfaces } from 'node:os';

import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';

import {
  classifyConnectionError,
  connectionFailureMessage,
  containerSourceRange,
  firstErrorCode,
  hostIpv4,
  stalledServerMessage,
  tcpConnects,
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
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate', 'tls'],
    ['HOSTNAME_MISMATCH', 'hostname mismatch', 'tls'],
  ])('reads %s from the cause of a fetch failure', (code, message, reason) => {
    expect(classifyConnectionError(fetchFailed(withCode(message, code)))).toEqual({ reason, code });
  });

  it('treats the preflight’s own AbortSignal timeout as a timeout', () => {
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    expect(classifyConnectionError(error)).toEqual({ reason: 'timeout', code: 'TimeoutError' });
  });

  it('finds the code under the OpenAI SDK’s wrapper', () => {
    const wrapped = new APIConnectionError({
      cause: fetchFailed(withCode('connect ECONNREFUSED 172.17.0.1:8000', 'ECONNREFUSED')),
    });

    expect(classifyConnectionError(wrapped)).toEqual({ reason: 'refused', code: 'ECONNREFUSED' });
  });

  it('does not take the SDK’s first-response timeout or a bare abort for a connect timeout', () => {
    // The SDK's 90 second deadline around an abort: undici's 10 second connect timeout would have
    // fired first, so the server had accepted the connection.
    const sdkTimeout = Object.assign(new APIConnectionTimeoutError(), {
      cause: new DOMException('This operation was aborted', 'AbortError'),
    });

    expect(classifyConnectionError(sdkTimeout)).toBeNull();
    expect(classifyConnectionError(new DOMException('This operation was aborted', 'AbortError'))).toBeNull();
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

  it('reads the code under the OpenAI SDK’s timeout before trusting the timeout itself', () => {
    // What the SDK throws when Node's fetch gave up waiting for headers: a timeout around a stall.
    const headersTimeout = Object.assign(new APIConnectionTimeoutError(), {
      cause: fetchFailed(withCode('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT')),
    });
    const connectTimeout = Object.assign(new APIConnectionTimeoutError(), {
      cause: fetchFailed(withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT')),
    });

    expect(classifyConnectionError(headersTimeout)).toBeNull();
    expect(classifyConnectionError(connectTimeout)).toEqual({
      reason: 'timeout',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
  });

  it('leaves an HTTP answer alone, whatever `code` its body carried', () => {
    // A proxy reporting its own upstream: the OpenAI SDK copies the body's `code` onto the error.
    const proxied = APIError.generate(
      502,
      { error: { message: 'upstream refused', code: 'ECONNREFUSED' } },
      undefined,
      new Headers(),
    );

    expect(proxied.code).toBe('ECONNREFUSED');
    expect(classifyConnectionError(proxied)).toBeNull();
    // Ollama's own ResponseError carries `status_code`.
    expect(
      classifyConnectionError(Object.assign(new Error('x'), { status_code: 500, code: 'ECONNRESET' })),
    ).toBeNull();
  });

  it('returns null for errors that are not connection failures and survives a cause cycle', () => {
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
  it('allows the range to the host address and the configured port over TCP', () => {
    expect(ufwAllowCommand(11434, '172.16.0.0/12', '172.17.0.1')).toBe(
      'sudo ufw allow from 172.16.0.0/12 to 172.17.0.1 port 11434 proto tcp',
    );
  });
});

describe('tcpConnects', () => {
  it('says whether a bare TCP connection opens', async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(tcpConnects('127.0.0.1', port)).resolves.toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // Nothing listens there any more: refused, which is neither answer.
    await expect(tcpConnects('127.0.0.1', port)).resolves.toBeUndefined();
  });
});

describe('stalledServerMessage', () => {
  it('names the address and the wait, and blames no firewall', () => {
    const message = stalledServerMessage({ hostname: 'host.docker.internal', port: 11434, onHost: true }, 5);

    expect(message).toMatch(
      /^host\.docker\.internal:11434 accepted the connection but did not answer within 5 seconds\./,
    );
    expect(message).not.toMatch(/firewall/);
  });
});

describe('hostIpv4', () => {
  it('returns an IPv4 address as it is, without a lookup', async () => {
    const lookup = jest.fn();

    await expect(hostIpv4('172.17.0.1', lookup)).resolves.toBe('172.17.0.1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves a name to its IPv4 address', async () => {
    const lookup = jest.fn(async () => ({ address: '172.17.0.1' }));

    await expect(hostIpv4('host.docker.internal', lookup)).resolves.toBe('172.17.0.1');
    expect(lookup).toHaveBeenCalledWith('host.docker.internal', { family: 4 });
  });

  it('gives nothing for a name that does not resolve, or not in time', async () => {
    const failing = jest.fn(async () => Promise.reject(new Error('getaddrinfo ENOTFOUND')));
    const hanging = jest.fn(() => new Promise<{ address: string }>(() => undefined));

    await expect(hostIpv4('host.docker.internal', failing)).resolves.toBeUndefined();
    await expect(hostIpv4('host.docker.internal', hanging, 10)).resolves.toBeUndefined();
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

  it('blames a firewall for a timeout on the host and not for one elsewhere', () => {
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
