import type { LookupFunction } from 'node:net';

import {
  type CdnFetch,
  downloadFacebookCdnFile,
  FacebookCdnDownloadError,
  isAllowedFacebookCdnUrl,
} from '../facebookCdnDownload';

/**
 * The Facebook media download takes its URL from a sync payload, so it is an SSRF primitive
 * unless every URL it requests, the first and each redirect target, is on Facebook's CDN over
 * https, and every connection goes through the shared address guard.
 */

// The connect-time address guard, observed: the production hop must dial through it. The fake
// refuses like the real one does for a private answer, so no test here touches the network.
const lookupCalls: string[] = [];

jest.mock('@ci/domains/embed', () => {
  const actual = jest.requireActual('@ci/domains/embed');

  const refusingLookup: LookupFunction = (hostname, _options, callback) => {
    lookupCalls.push(hostname);
    callback(new actual.BlockedAddressError(hostname), '', 4);
  };

  return { ...actual, guardedLookup: refusingLookup };
});

const CDN = 'https://scontent-lax3-1.xx.fbcdn.net/v/t39.30808-6/x.jpg?oe=6A94EAE4';
const VIDEO_CDN = 'https://video-lax3-1.xx.fbcdn.net/o1/v/t2/f2/m69/x.mp4';

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function ok(bytes: number, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

/** A hop that answers in order and records what it was asked for. */
function hops(...responses: Response[]): CdnFetch & jest.Mock {
  const fetchImpl = jest.fn();

  for (const response of responses) {
    fetchImpl.mockResolvedValueOnce(response);
  }

  return fetchImpl as CdnFetch & jest.Mock;
}

beforeEach(() => {
  lookupCalls.length = 0;
});

describe('isAllowedFacebookCdnUrl', () => {
  it.each([
    CDN,
    VIDEO_CDN,
    'https://scontent.xx.fbcdn.net:443/x.jpg',
    'https://SCONTENT.XX.FBCDN.NET./x.jpg',
  ])('allows %s', (url) => {
    expect(isAllowedFacebookCdnUrl(new URL(url))).toBe(true);
  });

  it.each([
    ['http on the CDN', 'http://scontent.xx.fbcdn.net/x.jpg'],
    ['another port', 'https://scontent.xx.fbcdn.net:8443/x.jpg'],
    ['credentials in the URL', 'https://user:pass@scontent.xx.fbcdn.net/x.jpg'],
    ['the bare domain', 'https://fbcdn.net/x.jpg'],
    ['a look-alike suffix', 'https://scontent.xx.fbcdn.net.example.com/x.jpg'],
    ['a look-alike label', 'https://evilfbcdn.net/x.jpg'],
    ['link-local metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['loopback', 'https://127.0.0.1/x.jpg'],
    ['a LAN name', 'https://nas.local/x.jpg'],
    ['facebook.com itself', 'https://www.facebook.com/photo.php?fbid=1'],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedFacebookCdnUrl(new URL(url))).toBe(false);
  });
});

describe('downloadFacebookCdnFile', () => {
  it('downloads a CDN file', async () => {
    const fetchImpl = hops(ok(64, { 'content-length': '64' }));

    const buffer = await downloadFacebookCdnFile(CDN, { maxBytes: 1024, fetchImpl });

    expect(buffer).toHaveLength(64);
    expect(fetchImpl).toHaveBeenCalledWith(new URL(CDN), { signal: expect.any(AbortSignal) });
  });

  it('follows a redirect that stays on the CDN, checking the new host first', async () => {
    const fetchImpl = hops(redirect(VIDEO_CDN), ok(8));

    const buffer = await downloadFacebookCdnFile(CDN, { maxBytes: 1024, fetchImpl });

    expect(buffer).toHaveLength(8);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([CDN, VIDEO_CDN]);
  });

  it.each([
    ['link-local metadata', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['a LAN host over https', 'https://192.168.1.1/admin'],
    ['a host off the CDN', 'https://example.com/x.jpg'],
    ['a downgrade to http on the CDN', 'http://scontent.xx.fbcdn.net/x.jpg'],
  ])('refuses a redirect to %s without requesting it', async (_label, target) => {
    const fetchImpl = hops(redirect(target), ok(8));

    await expect(downloadFacebookCdnFile(CDN, { maxBytes: 1024, fetchImpl })).rejects.toBeInstanceOf(
      FacebookCdnDownloadError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative redirect against the hop it came from', async () => {
    const fetchImpl = hops(redirect('/v/other.jpg'), ok(4));

    await downloadFacebookCdnFile(CDN, { maxBytes: 1024, fetchImpl });

    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://scontent-lax3-1.xx.fbcdn.net/v/other.jpg');
  });

  it('stops after three redirects', async () => {
    const fetchImpl = hops(redirect(CDN), redirect(CDN), redirect(CDN), redirect(CDN), ok(4));

    await expect(downloadFacebookCdnFile(CDN, { maxBytes: 1024, fetchImpl })).rejects.toThrow(
      'more than 3 redirects',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('refuses a declared size over the cap without reading the body', async () => {
    const fetchImpl = hops(ok(4, { 'content-length': '2048' }));

    await expect(downloadFacebookCdnFile(CDN, { maxBytes: 1024, fetchImpl })).rejects.toThrow(
      'over the 1024-byte limit',
    );
  });

  it('stops reading a body that grows past the cap with no declared size', async () => {
    const fetchImpl = hops(ok(2048));

    await expect(downloadFacebookCdnFile(CDN, { maxBytes: 1024, fetchImpl })).rejects.toThrow(
      'over the 1024-byte limit',
    );
  });

  it('reports a non-2xx answer as a failure', async () => {
    const fetchImpl = hops(new Response(null, { status: 403 }));

    await expect(downloadFacebookCdnFile(CDN, { maxBytes: 1024, fetchImpl })).rejects.toThrow(
      'CDN responded 403',
    );
  });

  it('dials through the shared address guard when no hop is injected', async () => {
    // The production path. The fake guard above refuses every name, as the real one refuses a
    // name that resolves to a private, loopback, link-local or CGNAT address. Reaching it at all
    // is the point: a hop that resolved names some other way would skip the check.
    await expect(downloadFacebookCdnFile(CDN, { maxBytes: 1024 })).rejects.toThrow(
      'refusing to connect to a blocked address for scontent-lax3-1.xx.fbcdn.net',
    );
    expect(lookupCalls).toContain('scontent-lax3-1.xx.fbcdn.net');
  });

  it('never dials a URL that fails the allow-list, even on the production path', async () => {
    await expect(
      downloadFacebookCdnFile('http://169.254.169.254/latest/meta-data/', { maxBytes: 1024 }),
    ).rejects.toThrow('refusing to download from http://169.254.169.254');
    expect(lookupCalls).toEqual([]);
  });
});
