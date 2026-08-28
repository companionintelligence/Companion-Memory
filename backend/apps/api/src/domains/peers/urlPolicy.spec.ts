import type dns from 'node:dns';

import {
  checkEgressUrl,
  createEgressLookup,
  EgressBlockedError,
  isBlockedAddress,
  isEgressUrlAllowed,
  type AddressResolver,
} from './urlPolicy';

describe('checkEgressUrl', () => {
  it('allows an ordinary public https endpoint', () => {
    expect(checkEgressUrl('https://devon.example.com/agent/v1/ask')).toEqual({ ok: true });
    expect(checkEgressUrl('https://devon.example.com:443/agent/v1/ask').ok).toBe(true);
  });

  it('requires https — http would expose the token in transit', () => {
    expect(checkEgressUrl('http://devon.example.com/ask').ok).toBe(false);
  });

  it('refuses non-https schemes outright', () => {
    for (const url of ['file:///etc/passwd', 'ftp://host/x', 'gopher://host/x']) {
      expect(checkEgressUrl(url).ok).toBe(false);
    }
  });

  it('refuses embedded credentials', () => {
    expect(checkEgressUrl('https://user:pw@example.com/ask').ok).toBe(false);
  });

  it('refuses non-standard ports (an internal service scan)', () => {
    for (const port of [22, 5432, 6379, 8080, 9200]) {
      expect(checkEgressUrl(`https://example.com:${port}/ask`).ok).toBe(false);
    }
  });

  describe('SSRF address ranges', () => {
    it('refuses loopback', () => {
      for (const host of ['127.0.0.1', '127.1.2.3', '[::1]']) {
        expect(isEgressUrlAllowed(`https://${host}/ask`)).toBe(false);
      }
    });

    it('refuses cloud metadata (169.254.169.254)', () => {
      expect(isEgressUrlAllowed('https://169.254.169.254/latest/meta-data/')).toBe(false);
    });

    it('refuses RFC1918 private space', () => {
      for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
        expect(isEgressUrlAllowed(`https://${host}/ask`)).toBe(false);
      }
    });

    it('refuses CGNAT, benchmarking, multicast and "this network"', () => {
      for (const host of ['100.64.0.1', '198.18.0.1', '224.0.0.1', '0.0.0.0']) {
        expect(isEgressUrlAllowed(`https://${host}/ask`)).toBe(false);
      }
    });

    it('refuses IPv6 unique-local and link-local', () => {
      for (const host of ['[fc00::1]', '[fd12:3456::1]', '[fe80::1]']) {
        expect(isEgressUrlAllowed(`https://${host}/ask`)).toBe(false);
      }
    });

    it('refuses IPv4-mapped IPv6 that smuggles a private address', () => {
      expect(isEgressUrlAllowed('https://[::ffff:10.0.0.1]/ask')).toBe(false);
      expect(isEgressUrlAllowed('https://[::ffff:127.0.0.1]/ask')).toBe(false);
    });

    it('refuses local hostnames', () => {
      for (const host of ['localhost', 'db.localhost', 'printer.local']) {
        expect(isEgressUrlAllowed(`https://${host}/ask`)).toBe(false);
      }
    });

    it('still allows a public address that merely looks similar', () => {
      // 172.32.x is OUTSIDE RFC1918 (which ends at 172.31), 11.x is public.
      expect(isEgressUrlAllowed('https://172.32.0.1/ask')).toBe(true);
      expect(isEgressUrlAllowed('https://11.0.0.1/ask')).toBe(true);
    });
  });

  it('reports a reason rather than throwing, so callers can decline gracefully', () => {
    const result = checkEgressUrl('http://10.0.0.1/ask');
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(checkEgressUrl('not a url').ok).toBe(false);
  });

  describe('alternate spellings of the same address', () => {
    // WHATWG `URL` folds every IPv4 spelling into a dotted quad before the
    // policy ever sees it, so ONE check covers all of them — but only as long
    // as the check runs on `url.hostname` and not on the raw string. These pin
    // that: each of these is 127.0.0.1 or 10.0.0.1 wearing a different hat.
    it.each([
      ['decimal', 'https://2130706433/ask'],
      ['hex', 'https://0x7f000001/ask'],
      ['octal', 'https://0177.0.0.1/ask'],
      ['short form', 'https://127.1/ask'],
      ['mixed hex octet', 'https://127.0.0.0x1/ask'],
      ['ipv4-mapped, hex', 'https://[::ffff:7f00:1]/ask'],
      ['ipv4-mapped, dotted', 'https://[::ffff:127.0.0.1]/ask'],
      ['ipv4-mapped, long form', 'https://[0:0:0:0:0:ffff:127.0.0.1]/ask'],
      ['ipv4-mapped private, hex', 'https://[::ffff:a00:1]/ask'],
    ])('refuses loopback written as %s', (_label, url) => {
      expect(isEgressUrlAllowed(url)).toBe(false);
    });

    it('refuses the IPv6 shapes the first cut did not name', () => {
      for (const host of ['[::]', '[ff02::1]', '[2001:db8::1]', '[64:ff9b::7f00:1]']) {
        expect(isEgressUrlAllowed(`https://${host}/ask`)).toBe(false);
      }
    });

    it('refuses the special-use IPv4 ranges the first cut did not name', () => {
      for (const host of ['192.0.0.1', '192.0.2.5', '198.51.100.5', '203.0.113.5', '255.255.255.255']) {
        expect(isEgressUrlAllowed(`https://${host}/ask`)).toBe(false);
      }
    });

    it('refuses names that can only mean the inside', () => {
      for (const host of [
        'metadata.google.internal',
        'vault.internal',
        'nas.home',
        'printer.lan',
        '1.0.0.127.in-addr.arpa',
        'LOCALHOST',
        'db.LocalHost',
        // A bare label is a search-domain lookup and can hold no public
        // certificate, so it is never a peer.
        'intranet',
      ]) {
        expect(isEgressUrlAllowed(`https://${host}/ask`)).toBe(false);
      }
    });
  });
});

/**
 * The address table, pinned on its own.
 *
 * `checkEgressUrl` only ever sees a hostname; the CONNECT-TIME guard sees a
 * resolved address, and it is the same table. Both sides need it to be right,
 * so it is exercised directly rather than only through a URL.
 *
 * The corpus is deliberately the same one `domains/embed`'s
 * `UnfurlFetcher.ssrf.test.ts` uses. That file cannot be imported here
 * (`no-cross-domain-internals`), so this is what keeps the two tables from
 * drifting: if this list stops matching that one, the peer path — the more
 * sensitive of the two — has silently become the weaker.
 */
describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.8.8.8',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1', // Tailscale CGNAT
    '100.127.255.254',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '2001:db8::1',
    '64:ff9b::7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.5',
    '::ffff:100.64.1.1',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '11.0.0.1',
    '172.32.0.1',
    '172.15.255.255',
    '100.63.255.255',
    '100.128.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('blocks anything that is not a parseable address at all', () => {
    // This predicate runs against a RESOLVED answer. An answer it cannot read
    // is not one to give the benefit of the doubt to.
    for (const value of ['', 'not-an-ip', '999.1.1.1', '127.0.0.1:80']) {
      expect(isBlockedAddress(value)).toBe(true);
    }
  });
});

/**
 * The connect-time guard — the half that closes DNS rebinding.
 *
 * A URL check answers "may we ask for this?"; this answers "is the address we
 * are about to dial one we approved?". The resolver is injected so the answer
 * is deterministic and no test here depends on what the network says today.
 */
describe('createEgressLookup', () => {
  function resolverReturning(...addresses: dns.LookupAddress[]): {
    resolve: AddressResolver;
    calls: string[];
  } {
    const calls: string[] = [];
    const resolve: AddressResolver = (hostname, _options, callback) => {
      calls.push(hostname);
      setImmediate(() => callback(null, addresses));
    };

    return { resolve, calls };
  }

  it('refuses a blocked name WITHOUT asking the resolver', (done) => {
    const { resolve, calls } = resolverReturning({ address: '8.8.8.8', family: 4 });
    createEgressLookup(resolve)('localhost', {}, (error) => {
      expect(error).toBeInstanceOf(EgressBlockedError);
      expect(calls).toEqual([]);
      done();
    });
  });

  it('refuses a PUBLIC-LOOKING name that resolves inside — the rebind shape', (done) => {
    // Nothing about `peer.example.com` fails the URL policy. The only thing
    // that can catch this is checking the answer, at connect time.
    const { resolve } = resolverReturning({ address: '127.0.0.1', family: 4 });
    createEgressLookup(resolve)('peer.example.com', {}, (error) => {
      expect(error).toBeInstanceOf(EgressBlockedError);
      expect((error as EgressBlockedError).reason).toContain('peer.example.com');
      done();
    });
  });

  it('refuses a MIXED answer: one blocked address poisons the whole set', (done) => {
    // Picking the public one and connecting would just mean losing the race
    // later, when the TTL expires and the private answer is the only one left.
    const { resolve } = resolverReturning(
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    );
    createEgressLookup(resolve)('peer.example.com', {}, (error) => {
      expect(error).toBeInstanceOf(EgressBlockedError);
      done();
    });
  });

  it('refuses an IPv6 answer inside the tailnet or the link-local range', (done) => {
    const { resolve } = resolverReturning({ address: 'fd00::1', family: 6 });
    createEgressLookup(resolve)('peer.example.com', {}, (error) => {
      expect(error).toBeInstanceOf(EgressBlockedError);
      done();
    });
  });

  it('passes an all-public answer through, in the shape the caller asked for', (done) => {
    const { resolve } = resolverReturning(
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    );
    const lookup = createEgressLookup(resolve);

    lookup('peer.example.com', { all: true }, (error, addresses) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ]);

      lookup('peer.example.com', {}, (err, address, family) => {
        expect(err).toBeNull();
        expect(address).toBe('93.184.216.34');
        expect(family).toBe(4);
        done();
      });
    });
  });

  it('passes a resolver failure through unchanged, so a real DNS error is not reported as a refusal', (done) => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const resolve: AddressResolver = (_hostname, _options, callback) => {
      setImmediate(() => callback(failure, []));
    };

    createEgressLookup(resolve)('peer.example.com', {}, (error) => {
      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(EgressBlockedError);
      done();
    });
  });

  it('refuses an EMPTY answer rather than treating "nothing blocked" as "allowed"', (done) => {
    const { resolve } = resolverReturning();
    createEgressLookup(resolve)('peer.example.com', {}, (error) => {
      expect(error).toBeInstanceOf(EgressBlockedError);
      done();
    });
  });
});
