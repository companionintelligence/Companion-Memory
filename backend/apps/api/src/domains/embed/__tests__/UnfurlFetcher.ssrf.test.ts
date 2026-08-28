import {
  guardedLookup,
  isBlockedAddress,
  isBlockedHostname,
  rateBucketFor,
  RateBuckets,
} from '../services/UnfurlFetcher';

describe('UnfurlFetcher SSRF guards', () => {
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
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
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
    '172.32.0.1',
    '172.15.255.255',
    '100.63.255.255',
    '100.128.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('blocks hostnames that can only mean the inside', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'printer.local',
      'db.internal',
      'api.localhost',
      'intranet',
      'metadata.google.internal',
      '[::1]',
      '127.0.0.1',
      '10.0.0.1',
    ]) {
      expect(isBlockedHostname(host)).toBe(true);
    }

    for (const host of ['youtube.com', 'open.spotify.com', 'api.themoviedb.org', 'i.ytimg.com']) {
      expect(isBlockedHostname(host)).toBe(false);
    }
  });

  it('refuses a lookup before resolving a blocked hostname', (done) => {
    guardedLookup('localhost', {}, (err) => {
      expect(err?.name).toBe('BlockedAddressError');
      done();
    });
  });

  it('refuses a resolved private answer even behind a public-looking name', (done) => {
    // Every resolver answers this with a loopback address, which is exactly the
    // rebind shape: public name, private answer.
    guardedLookup('localtest.me', {}, (err, address) => {
      if (err) {
        expect(
          err.name === 'BlockedAddressError' || (err as NodeJS.ErrnoException).code === 'ENOTFOUND',
        ).toBe(true);
      } else {
        // If the resolver returned something public (unexpected), it must not be loopback.
        expect(String(address).startsWith('127.')).toBe(false);
      }

      done();
    });
  });
});

describe('rate buckets', () => {
  it("folds one operator's hosts into one budget", () => {
    expect(rateBucketFor('en.wikipedia.org')).toBe('wikimedia');
    expect(rateBucketFor('www.wikidata.org')).toBe('wikimedia');
    expect(rateBucketFor('upload.wikimedia.org')).toBe('wikimedia');
    expect(rateBucketFor('commons.wikimedia.org')).toBe('wikimedia');
    expect(rateBucketFor('i.ytimg.com')).toBe('youtube');
    expect(rateBucketFor('open.spotify.com')).toBe('spotify');
    expect(rateBucketFor('example.com')).toBe('example.com');
    expect(rateBucketFor('notwikipedia.org')).toBe('notwikipedia.org');
  });

  it('spaces requests in a bucket by the minimum interval and honours a pause', async () => {
    const buckets = new RateBuckets(50);
    const t0 = Date.now();
    await buckets.acquire('a');
    await buckets.acquire('a');
    await buckets.acquire('a');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(95);

    const t1 = Date.now();
    await buckets.acquire('b'); // other bucket: no wait
    expect(Date.now() - t1).toBeLessThan(40);

    buckets.pause('b', 120);
    const t2 = Date.now();
    await buckets.acquire('b');
    expect(Date.now() - t2).toBeGreaterThanOrEqual(110);
  });
});
