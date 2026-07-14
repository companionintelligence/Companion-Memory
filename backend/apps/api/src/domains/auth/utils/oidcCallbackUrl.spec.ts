import { OIDC_ORIGIN_BOUNCE_PARAM, resolveOidcCallbackUrl, resolveOidcOriginBounce } from './oidcCallbackUrl';

const CALLBACK_PATH = '/api/authenticate/oidc/callback';
const INITIATE_PATH = '/api/authenticate/oidc';

describe('resolveOidcCallbackUrl', () => {
  const localhostRequest = {
    host: 'ci-memory-core-2-hanz-corp.localhost',
    secure: false,
  };

  it('prefers the public base URL over the inbound request host', () => {
    expect(
      resolveOidcCallbackUrl(
        localhostRequest,
        'https://ci-memory-core-2-hanz-corp.companionintelligence.com',
      ),
    ).toBe(`https://ci-memory-core-2-hanz-corp.companionintelligence.com${CALLBACK_PATH}`);
  });

  it('strips trailing slashes and whitespace from the public base URL', () => {
    expect(resolveOidcCallbackUrl(localhostRequest, '  https://app.example.com//  ')).toBe(
      `https://app.example.com${CALLBACK_PATH}`,
    );
  });

  it('falls back to the request origin when no public base URL is configured', () => {
    expect(resolveOidcCallbackUrl(localhostRequest, '')).toBe(
      `http://ci-memory-core-2-hanz-corp.localhost${CALLBACK_PATH}`,
    );
    expect(resolveOidcCallbackUrl(localhostRequest, undefined)).toBe(
      `http://ci-memory-core-2-hanz-corp.localhost${CALLBACK_PATH}`,
    );
    expect(resolveOidcCallbackUrl(localhostRequest, '   ')).toBe(
      `http://ci-memory-core-2-hanz-corp.localhost${CALLBACK_PATH}`,
    );
  });

  it('honours forwarded proto/host from the reverse proxy in the fallback path', () => {
    expect(
      resolveOidcCallbackUrl({
        forwardedProto: 'https',
        forwardedHost: 'app.example.com',
        host: 'internal:3000',
        secure: false,
      }),
    ).toBe(`https://app.example.com${CALLBACK_PATH}`);
  });

  it('takes the first hop from comma-separated forwarded headers', () => {
    expect(
      resolveOidcCallbackUrl({
        forwardedProto: 'https, http',
        forwardedHost: 'app.example.com, internal:3000',
        secure: false,
      }),
    ).toBe(`https://app.example.com${CALLBACK_PATH}`);
  });

  it('takes the first entry from array-valued forwarded headers', () => {
    expect(
      resolveOidcCallbackUrl({
        forwardedProto: ['https', 'http'],
        forwardedHost: ['app.example.com', 'internal:3000'],
        secure: false,
      }),
    ).toBe(`https://app.example.com${CALLBACK_PATH}`);
  });

  it('uses https in the fallback path when the connection is secure', () => {
    expect(resolveOidcCallbackUrl({ host: 'app.example.com', secure: true })).toBe(
      `https://app.example.com${CALLBACK_PATH}`,
    );
  });

  it('defaults the host to localhost when none is available', () => {
    expect(resolveOidcCallbackUrl({ secure: false })).toBe(`http://localhost${CALLBACK_PATH}`);
  });
});

describe('resolveOidcOriginBounce', () => {
  const PUBLIC_BASE = 'https://ci-memory-core-2-hanz-corp.companionintelligence.com';

  it('bounces to the public origin when the app was opened on its LAN address', () => {
    // The default exposure mode is `local`, so CI-Hub sends the browser to the LAN
    // address while APP_BASE_URL still names the public origin. Without the bounce
    // the state/PKCE cookies land here and the callback lands there.
    expect(resolveOidcOriginBounce({ host: '192.168.1.50:8642', secure: false }, PUBLIC_BASE)).toBe(
      `${PUBLIC_BASE}${INITIATE_PATH}?${OIDC_ORIGIN_BOUNCE_PARAM}=1`,
    );
  });

  it('bounces from the *.localhost route too', () => {
    expect(
      resolveOidcOriginBounce({ host: 'ci-memory-core-2-hanz-corp.localhost', secure: false }, PUBLIC_BASE),
    ).toBe(`${PUBLIC_BASE}${INITIATE_PATH}?${OIDC_ORIGIN_BOUNCE_PARAM}=1`);
  });

  it('carries the redirect destination across the bounce', () => {
    expect(
      resolveOidcOriginBounce(
        { host: '192.168.1.50:8642', secure: false },
        PUBLIC_BASE,
        '/api/connect?app=x',
      ),
    ).toBe(
      `${PUBLIC_BASE}${INITIATE_PATH}?redirect=%2Fapi%2Fconnect%3Fapp%3Dx&${OIDC_ORIGIN_BOUNCE_PARAM}=1`,
    );
  });

  it('does not bounce when the browser is already on the public origin', () => {
    expect(
      resolveOidcOriginBounce(
        {
          forwardedProto: 'https',
          forwardedHost: 'ci-memory-core-2-hanz-corp.companionintelligence.com',
          secure: false,
        },
        PUBLIC_BASE,
      ),
    ).toBeNull();
  });

  it('does not loop when the gateway rewrites X-Forwarded-Proto to http on an https request', () => {
    // The ci-memory gateway sets `X-Forwarded-Proto $scheme`, clobbering Traefik's
    // `https` with its own internal `http`. Comparing the full ORIGIN would never
    // match the https public base and would bounce the browser to it on every hop —
    // an infinite redirect loop on the sign-in path. Only the host may be compared.
    expect(
      resolveOidcOriginBounce(
        {
          forwardedProto: 'http',
          forwardedHost: 'ci-memory-core-2-hanz-corp.companionintelligence.com',
          secure: false,
        },
        PUBLIC_BASE,
      ),
    ).toBeNull();
  });

  it('does not bounce on a host that differs only by case', () => {
    expect(
      resolveOidcOriginBounce(
        { host: 'CI-Memory-Core-2-Hanz-Corp.CompanionIntelligence.com', secure: true },
        PUBLIC_BASE,
      ),
    ).toBeNull();
  });

  it('compares the port too, so a LAN host on the app port still bounces', () => {
    expect(
      resolveOidcOriginBounce({ host: '192.168.1.50:8642', secure: false }, 'http://192.168.1.50:9999'),
    ).toBe(`http://192.168.1.50:9999${INITIATE_PATH}?${OIDC_ORIGIN_BOUNCE_PARAM}=1`);
  });

  it('never bounces twice — the marker breaks any residual loop', () => {
    // Backstop: if some host shape we failed to normalize still reads as a
    // mismatch, one hop is spent and the flow proceeds rather than looping forever.
    expect(
      resolveOidcOriginBounce({ host: '192.168.1.50:8642', secure: false }, PUBLIC_BASE, undefined, true),
    ).toBeNull();
  });

  it('treats an explicit default port as the same host (would otherwise loop)', () => {
    expect(
      resolveOidcOriginBounce(
        { forwardedHost: 'ci-memory-core-2-hanz-corp.companionintelligence.com:443', secure: true },
        PUBLIC_BASE,
      ),
    ).toBeNull();
  });

  it('treats a trailing-dot FQDN as the same host (would otherwise loop)', () => {
    expect(
      resolveOidcOriginBounce(
        { forwardedHost: 'ci-memory-core-2-hanz-corp.companionintelligence.com.', secure: true },
        PUBLIC_BASE,
      ),
    ).toBeNull();
  });

  it('does not bounce when no public base URL is configured (local/dev install)', () => {
    expect(resolveOidcOriginBounce({ host: 'localhost:3030', secure: false }, undefined)).toBeNull();
    expect(resolveOidcOriginBounce({ host: 'localhost:3030', secure: false }, '   ')).toBeNull();
  });

  it('does not bounce when the public base URL is unparseable', () => {
    expect(resolveOidcOriginBounce({ host: 'localhost:3030', secure: false }, 'not a url')).toBeNull();
  });
});
