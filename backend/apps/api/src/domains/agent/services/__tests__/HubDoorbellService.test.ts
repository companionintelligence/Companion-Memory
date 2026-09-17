// The house pattern for this (see ConnectService.test.ts): a getter over a
// mutable local, because `@ci/configuration`'s default export is not safe to
// assign to directly.
const connect = {
  hubInternalUrl: 'http://hub.test:5002',
  devDirectWakeUrl: '',
  devDirectWakeToken: '',
};
const hubForwardAuth = { secret: 'a-secret' };

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      auth: {
        ...actual.auth,
        get connect() {
          return connect;
        },
        get hubForwardAuth() {
          return hubForwardAuth;
        },
      },
    },
  };
});

import { HubDoorbellService } from '../HubDoorbellService';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as never;
}

/** A `fetch` stand-in returning one canned response. */
function stubFetch(response: { ok: boolean; status: number; json?: () => Promise<unknown> }) {
  // The parameters are declared even though the body ignores them: without
  // them `mock.calls` types as an empty tuple, and the assertions below read
  // the URL and init off it.
  const spy = jest.fn(async (_url: string, _init?: RequestInit) => ({
    ok: response.ok,
    status: response.status,
    json: response.json ?? (async () => ({})),
  }));

  (globalThis as { fetch: unknown }).fetch = spy;

  return spy;
}

describe('HubDoorbellService.wakeOpenClaw', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    connect.hubInternalUrl = 'http://hub.test:5002';
    connect.devDirectWakeUrl = '';
    connect.devDirectWakeToken = '';
    hubForwardAuth.secret = 'a-secret';
  });

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('reports a delivered wake when Hub says it delivered one', async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({ ok: true }) });

    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(true);
  });

  it('does NOT report success for a 2xx carrying {ok:false}', async () => {
    // This is the whole point. Hub's notify controller returns `{ ok }` from a
    // plain @Post, and `wakeApp` returns FALSE — it never throws — when the app
    // has no registered webhook target, when the app is down, and when the wake
    // is throttled. All three arrive as a 2xx.
    //
    // Reading only the status reported every undeliverable wake as delivered:
    // the listener `ack.defer()`s, pg-boss's retry never engages, and two
    // minutes later the reaper closes the job saying "OpenClaw did not check
    // in" — when nobody had ever asked it to.
    stubFetch({ ok: true, status: 200, json: async () => ({ ok: false }) });

    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);
  });

  it('does not accept a body with no ok field, or one that is not JSON', async () => {
    // Fail closed. A body this service cannot read is not evidence of delivery,
    // and treating it as success recreates exactly the bug above.
    stubFetch({ ok: true, status: 200, json: async () => ({ delivered: 'yes' }) });
    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);

    stubFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });
    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);
  });

  it('rejects a truthy-but-not-true ok, rather than coercing it', async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({ ok: 'yes' }) });

    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);
  });

  it('still reports failure on a non-2xx without reading the body', async () => {
    stubFetch({ ok: false, status: 503 });

    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);
  });

  it('refuses to ring at all when the Hub address or the shared secret is missing', async () => {
    // Both are the live misconfiguration: CI_HUB_INTERNAL_URL is not injected
    // into this app by Hub today, and on a dev stack the forward-auth secret is
    // empty. A `false` here is what makes the listener retry rather than the
    // job dying silently two minutes later.
    const fetchSpy = stubFetch({ ok: true, status: 200, json: async () => ({ ok: true }) });

    connect.hubInternalUrl = '';
    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);

    connect.hubInternalUrl = 'http://hub.test:5002';
    hubForwardAuth.secret = '';
    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * The dev-only direct wake exists so a local stack can exercise dispatch without
 * a full Hub install. Its safety rests entirely on WHEN it fires, so that is
 * what these test — not that it can POST.
 */
describe('HubDoorbellService dev direct wake', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    connect.hubInternalUrl = '';
    hubForwardAuth.secret = '';
    connect.devDirectWakeUrl = 'http://127.0.0.1:18789';
    connect.devDirectWakeToken = 'wake-token';
  });

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    connect.hubInternalUrl = 'http://hub.test:5002';
    connect.devDirectWakeUrl = '';
    connect.devDirectWakeToken = '';
    hubForwardAuth.secret = 'a-secret';
  });

  it('rings OpenClaw the way Hub would — same path, bearer and body', async () => {
    // Same contract as Hub's far leg on purpose. A dev path that exercised a
    // DIFFERENT contract would prove nothing about the real one — and the wake
    // text matters too: CI-OpenClaw reads the job id back out of that sentence.
    const spy = stubFetch({ ok: true, status: 200 });

    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(true);

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/hooks/wake');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer wake-token');
    expect(JSON.parse(String(init!.body))).toEqual({
      text: 'Memory dispatch job job-1. Fetch the packet from Memory.',
      mode: 'now',
    });
  });

  it('NEVER fires when Hub is configured, however the Hub call goes', async () => {
    // The load-bearing safety property. If the dev path could run after a Hub
    // FAILURE, a configured appliance would silently fall back to the unsigned
    // route the first time Hub had a bad minute. The branch is on whether Hub
    // is CONFIGURED, never on whether Hub worked.
    connect.hubInternalUrl = 'http://hub.test:5002';
    hubForwardAuth.secret = 'a-secret';

    const spy = stubFetch({ ok: false, status: 503 });

    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);

    // One call, and it went to HUB. No retry against the direct URL.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain('hub.test:5002');
  });

  it('will not fire with a URL but no bearer — that is a silent miss, not a path', async () => {
    connect.devDirectWakeToken = '';

    const spy = stubFetch({ ok: true, status: 200 });

    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('says so, loudly, every time it is used', async () => {
    // Warned on every wake rather than once at boot: this must never be running
    // unnoticed on a box someone later promotes.
    stubFetch({ ok: true, status: 200 });
    const logger = makeLogger() as unknown as { warn: jest.Mock };

    await new HubDoorbellService(logger as never).wakeOpenClaw('job-1');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('DIRECTLY'),
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('reports a failed direct wake as a miss, so pg-boss retries it', async () => {
    stubFetch({ ok: false, status: 500 });

    expect(await new HubDoorbellService(makeLogger()).wakeOpenClaw('job-1')).toBe(false);
  });
});
