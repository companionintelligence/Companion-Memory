import type { ErrorEvent } from '@sentry/nestjs';

import { scrubEvent, scrubString } from '../scrubEvent';
import { MAX_STRING_LENGTH, SCRUB_CASES } from '../scrubFixtures';

describe('scrubString', () => {
  it('redacts bearer tokens', () => {
    expect(scrubString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toContain('[Filtered]');
    expect(scrubString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).not.toContain(
      'eyJhbGciOiJIUzI1NiJ9',
    );
  });

  it('redacts labelled secrets', () => {
    expect(scrubString('api_key=sk-live-1234567890')).not.toContain('sk-live-1234567890');
    expect(scrubString('password: hunter2')).not.toContain('hunter2');
    expect(scrubString('{"token":"abcdef123456"}')).not.toContain('abcdef123456');
  });

  it('redacts tailscale auth keys', () => {
    expect(scrubString('tskey-auth-abc123-def456')).toBe('[Filtered]');
  });

  it('redacts credentials embedded in connection URLs', () => {
    const scrubbed = scrubString('postgres://ci:pgadmin_s3cure@db:5432/companion');

    expect(scrubbed).not.toContain('pgadmin_s3cure');
    expect(scrubbed).toContain('[Filtered]');
  });

  it('collapses home directories, which leak account names', () => {
    expect(scrubString('/Users/liam/devel/ci/file.ts')).toBe('~/devel/ci/file.ts');
    expect(scrubString('/home/ci/data/timeline.db')).toBe('~/data/timeline.db');
    expect(scrubString('C:\\Users\\liam\\app.log')).toBe('~\\app.log');
  });

  it('truncates oversized strings', () => {
    const scrubbed = scrubString('a'.repeat(9000));

    expect(scrubbed).toHaveLength(8000 + '… [truncated]'.length);
    expect(scrubbed.endsWith('… [truncated]')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(scrubString('Cannot read properties of undefined (reading "id")')).toBe(
      'Cannot read properties of undefined (reading "id")',
    );
  });
});

describe('scrubEvent', () => {
  it('scrubs the message and exception values', () => {
    const event = {
      message: 'failed for /Users/liam/notes',
      exception: { values: [{ value: 'Bearer secrettokenvalue rejected' }] },
    } as ErrorEvent;

    const scrubbed = scrubEvent(event)!;

    expect(scrubbed.message).toBe('failed for ~/notes');
    expect(scrubbed.exception!.values![0]!.value).not.toContain('secrettokenvalue');
  });

  it('filters sensitive keys in extra, at any depth', () => {
    const event = {
      extra: { outer: { password: 'hunter2', note: '/home/ci/x' }, dsn: 'https://k@o1.ingest.sentry.io/2' },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event)!;
    const extra = scrubbed.extra as { outer: { password: string; note: string }; dsn: string };

    expect(extra.outer.password).toBe('[Filtered]');
    expect(extra.outer.note).toBe('~/x');
    expect(extra.dsn).toBe('[Filtered]');
  });

  it('drops request cookies, body and query string', () => {
    const event = {
      request: {
        cookies: { sessionToken: 'abc' },
        data: { query: 'what did I do last summer' },
        query_string: 'q=private+search',
        headers: { authorization: 'Bearer abc', 'user-agent': 'curl/8' },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event)!;

    expect(scrubbed.request!.cookies).toBeUndefined();
    expect(scrubbed.request!.data).toBeUndefined();
    expect(scrubbed.request!.query_string).toBe('[Filtered]');
    expect(scrubbed.request!.headers!.authorization).toBe('[Filtered]');
    expect(scrubbed.request!.headers!['user-agent']).toBe('curl/8');
  });

  it('scrubs breadcrumb messages and data', () => {
    const event = {
      breadcrumbs: [{ message: 'GET /Users/liam', data: { token: 'abc123' } }],
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event)!;

    expect(scrubbed.breadcrumbs![0]!.message).toBe('GET ~');
    expect(scrubbed.breadcrumbs![0]!.data!.token).toBe('[Filtered]');
  });

  it('survives a cyclic extra payload', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => scrubEvent({ extra: cyclic } as unknown as ErrorEvent)).not.toThrow();
  });

  it('passes through an event with nothing to scrub', () => {
    const event = { message: 'plain failure' } as ErrorEvent;

    expect(scrubEvent(event)).toEqual({ message: 'plain failure' });
  });
});

describe('scrubEvent — leaks confirmed by adversarial review', () => {
  it('strips the query string from request.url, not just query_string', () => {
    // The SDK builds request.url from req.url, which on a Node server is
    // path+query — so filtering query_string alone redacted nothing.
    const event = {
      request: {
        url: 'https://memory.local/api/graph/search?query=oncologist&people=Dr.%20Chen',
        query_string: 'query=oncologist',
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event)!;

    expect(scrubbed.request!.url).toBe('https://memory.local/api/graph/search');
    expect(scrubbed.request!.query_string).toBe('[Filtered]');
  });

  it('strips the query string from the referer header', () => {
    const event = {
      request: { headers: { Referer: 'https://memory.local/memory?search=divorce%20lawyer' } },
    } as unknown as ErrorEvent;

    expect(scrubEvent(event)!.request!.headers!.Referer).toBe('https://memory.local/memory');
  });

  it('filters the hyphenated x-api-key header', () => {
    const event = { request: { headers: { 'x-api-key': 'ci_live_abcdef123456' } } } as unknown as ErrorEvent;

    expect(scrubEvent(event)!.request!.headers!['x-api-key']).toBe('[Filtered]');
  });

  it('removes the machine hostname', () => {
    const event = { server_name: 'MacBook-Pro-2.local' } as unknown as ErrorEvent;

    expect(scrubEvent(event)!.server_name).toBeUndefined();
  });

  it('scrubs stack frame paths and captured locals', () => {
    const event = {
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/liam/devel/ci/x.ts',
                  abs_path: '/Users/liam/devel/ci/x.ts',
                  vars: { noteText: '/home/ci/journal', password: 'hunter2' },
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const frame = scrubEvent(event)!.exception!.values![0]!.stacktrace!.frames![0]!;

    expect(frame.filename).toBe('~/devel/ci/x.ts');
    expect(frame.abs_path).toBe('~/devel/ci/x.ts');
    expect((frame.vars as Record<string, unknown>).noteText).toBe('~/journal');
    expect((frame.vars as Record<string, unknown>).password).toBe('[Filtered]');
  });

  it('collapses Windows home paths in both slash styles', () => {
    // Regression: the macOS pattern used to match inside `C:/Users/…` first,
    // leaving a stranded `C:~/…`.
    expect(scrubString('C:\\Users\\liam\\app.log')).toBe('~\\app.log');
    expect(scrubString('C:/Users/liam/AppData/ci')).toBe('~/AppData/ci');
  });
});

describe('scrubEvent — CI-Hub identity header', () => {
  it('filters x-ci-hub-user, which carries the household username', () => {
    const event = {
      request: {
        headers: {
          'x-ci-hub-user': 'liam',
          'x-ci-hub-user-signature': 'abc',
          'x-ci-hub-user-assertion': '2.nB7cS0fTq3kz1XyH9wA2eQ.abc',
        },
      },
    } as unknown as ErrorEvent;

    const headers = scrubEvent(event)!.request!.headers!;

    expect(headers['x-ci-hub-user']).toBe('[Filtered]');
    expect(headers['x-ci-hub-user-signature']).toBe('[Filtered]');
    expect(headers['x-ci-hub-user-assertion']).toBe('[Filtered]');
  });

  it('strips the query string from a location redirect header', () => {
    const event = { request: { headers: { location: '/memory?search=private' } } } as unknown as ErrorEvent;

    expect(scrubEvent(event)!.request!.headers!.location).toBe('/memory');
  });
});

describe('shared scrub fixtures', () => {
  // The same list is exercised by the web bundle's suite. If a rule is added
  // here but not there (or vice versa) the copies have drifted.
  it.each(SCRUB_CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const actual = scrubString(testCase.input);

    if (testCase.expected !== undefined) {
      expect(actual).toBe(testCase.expected);
    }

    for (const forbidden of testCase.mustNotContain ?? []) {
      expect(actual).not.toContain(forbidden);
    }
  });

  it('truncates at the shared limit', () => {
    expect(scrubString('a'.repeat(MAX_STRING_LENGTH + 1000))).toHaveLength(
      MAX_STRING_LENGTH + '… [truncated]'.length,
    );
  });
});

describe('scrubEvent — ContextLines source text', () => {
  // The ContextLines integration attaches the source around the throw site.
  // Found by the CI-OpenClaw port's live-envelope probe: a home path, an API
  // key and a gateway token survived here while filename/abs_path beside them
  // were already scrubbed.
  it('scrubs context_line, pre_context and post_context', () => {
    const event = {
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/liam/app.ts',
                  pre_context: ['const dir = "/Users/liam/notes";'],
                  context_line: 'const client = new Client({ api_key: "sk-live-9988776655" });',
                  post_context: ['await fetch(url, { headers: { authorization: "Bearer abcdefghij" } });'],
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const frame = scrubEvent(event)!.exception!.values![0]!.stacktrace!.frames![0]!;

    expect(frame.context_line).not.toContain('sk-live-9988776655');
    expect(frame.pre_context![0]).toBe('const dir = "~/notes";');
    expect(frame.post_context![0]).not.toContain('abcdefghij');
  });
});

describe('scrubEvent — identity-bearing keys', () => {
  // These name a PERSON; no value pattern can match a username. Found by the
  // Companion-Planning port: `x-ci-hub-user` was covered here but the class
  // wasn't, and CI-Server sits behind the same Traefik forward-auth, which
  // injects headers our code never references.
  it.each(['x-ci-hub-user', 'x-forwarded-user', 'x-ci-owner', 'x-test-owner', 'username', 'email'])(
    'filters %s',
    (key) => {
      const event = { request: { headers: { [key]: 'liam' } } } as unknown as ErrorEvent;

      expect(scrubEvent(event)!.request!.headers![key]).toBe('[Filtered]');
    },
  );

  it.each(['user-agent', 'user_id', 'owner_id'])('keeps %s as diagnostic signal', (key) => {
    const event = { request: { headers: { [key]: 'curl/8' } } } as unknown as ErrorEvent;

    expect(scrubEvent(event)!.request!.headers![key]).toBe('curl/8');
  });
});

describe('scrubEvent — outgoing-fetch breadcrumb query strings', () => {
  // nativeNodeFetchIntegration sanitises data.url and then attaches the raw
  // query and fragment beside it. Neither key nor value matches any pattern, so
  // they shipped verbatim — including the user's own address and the Maps key
  // from GoogleGeocodeProvider, whose bare `key=` the secret regex never caught.
  it('drops http.query and http.fragment', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'http',
          data: {
            url: 'https://maps.googleapis.com/maps/api/geocode/json',
            'http.query': '?address=1600+Amphitheatre+Pkwy&key=AIzaSyD-abc123',
            'http.fragment': '#section',
            'http.method': 'GET',
            status_code: 500,
          },
        },
      ],
    } as unknown as ErrorEvent;

    const data = scrubEvent(event)!.breadcrumbs![0]!.data!;

    expect(data['http.query']).toBeUndefined();
    expect(data['http.fragment']).toBeUndefined();
    // The diagnostic signal beside them must survive.
    expect(data.url).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(data['http.method']).toBe('GET');
    expect(data.status_code).toBe(500);
  });

  it('drops a query carrying a user_id the anchored identity rule spares by design', () => {
    const event = {
      breadcrumbs: [{ category: 'http', data: { 'http.query': '?horizon=7&user_id=0198779b-182c-716e' } }],
    } as unknown as ErrorEvent;

    expect(scrubEvent(event)!.breadcrumbs![0]!.data!['http.query']).toBeUndefined();
  });
});
