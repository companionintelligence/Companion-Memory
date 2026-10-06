/**
 * Proves instrument.ts hands every Sentry hook the scrubber, not just
 * `beforeSend`. The scrubbers have their own suites; this one fails if a hook
 * is unregistered, pointed at the opt-out gate alone, or if the outbound
 * integrations lose their ignore list.
 */
import type { Breadcrumb, Log, NodeOptions } from '@sentry/nestjs';

type TransactionEvent = Parameters<NonNullable<NodeOptions['beforeSendTransaction']>>[0];
type SpanJSON = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];
type Integration = { name: string; options?: { ignoreOutgoingRequests?: (url: string) => boolean } };

const MAPS_KEY = 'AIzaSyD-abc123';
const GEOCODE_URL = `https://maps.googleapis.com/maps/api/geocode/json?address=12+Elm+St&key=${MAPS_KEY}`;

let options: NodeOptions;
let setCrashReportsUserEnabled: (enabled: boolean) => void;
const savedEnv = process.env;

beforeAll(async () => {
  // Defined-but-empty kill switches: dotenv never overrides a key that is
  // already present, so a developer's .env cannot turn this suite into a no-op.
  process.env = {
    ...savedEnv,
    SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
    CI_TELEMETRY: '',
    CI_LOCAL_ONLY: '',
  };

  await jest.isolateModulesAsync(async () => {
    jest.doMock('@sentry/nestjs', () => ({
      init: jest.fn((received: NodeOptions) => {
        options = received;
      }),
      setTag: jest.fn(),
      makeNodeTransport: jest.fn(),
      close: jest.fn(),
      httpIntegration: jest.fn((integrationOptions: unknown) => ({
        name: 'Http',
        options: integrationOptions,
      })),
      nativeNodeFetchIntegration: jest.fn((integrationOptions: unknown) => ({
        name: 'NodeFetch',
        options: integrationOptions,
      })),
    }));

    await import('@ci/instrument');
    // The same module instance instrument.ts closed over.
    ({ setCrashReportsUserEnabled } = await import('@ci/common/telemetry'));
  });
});

afterAll(() => {
  process.env = savedEnv;
  jest.dontMock('@sentry/nestjs');
});

afterEach(() => {
  setCrashReportsUserEnabled(true);
});

function geocodeSpan(): SpanJSON {
  return {
    span_id: 'b1',
    trace_id: 't1',
    start_timestamp: 1,
    op: 'http.client',
    description: `GET ${GEOCODE_URL}`,
    data: { 'url.full': GEOCODE_URL, 'url.query': `?address=12+Elm+St&key=${MAPS_KEY}` },
  } as SpanJSON;
}

describe('instrument.ts Sentry hooks', () => {
  it('initialised Sentry', () => {
    expect(options).toBeDefined();
  });

  it('beforeSendTransaction scrubs the request and the spans', async () => {
    const event = {
      type: 'transaction',
      transaction: 'GET /api/graph/search',
      contexts: { trace: { trace_id: 't1', span_id: 'a1', op: 'http.server', data: {} } },
      request: {
        url: 'https://memory.local/api/graph/search?query=oncologist',
        query_string: 'query=oncologist',
      },
      spans: [geocodeSpan()],
    } as TransactionEvent;

    const result = await options.beforeSendTransaction!(event, {});
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('oncologist');
    expect(serialized).not.toContain(MAPS_KEY);
  });

  it('beforeSendTransaction still drops everything when the user opted out', async () => {
    setCrashReportsUserEnabled(false);

    expect(await options.beforeSendTransaction!({ type: 'transaction' } as TransactionEvent, {})).toBeNull();
  });

  it('beforeSendSpan strips url.full and drops url.query', () => {
    const span = options.beforeSendSpan!(geocodeSpan());

    expect(span.data['url.full']).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(span.data['url.query']).toBeUndefined();
  });

  it('beforeSendLog scrubs the body and attributes', () => {
    const log = options.beforeSendLog!({
      level: 'info',
      message: 'sync used token=abcdef123456',
      attributes: { 'url.full': GEOCODE_URL },
    } as Log);

    expect(log!.message).not.toContain('abcdef123456');
    expect(log!.attributes!['url.full']).toBe('https://maps.googleapis.com/maps/api/geocode/json');
  });

  it('beforeSendLog still drops everything when the user opted out', () => {
    setCrashReportsUserEnabled(false);

    expect(options.beforeSendLog!({ level: 'info', message: 'x' } as Log)).toBeNull();
  });

  it('beforeBreadcrumb drops the raw query keys', () => {
    const crumb = options.beforeBreadcrumb!({
      category: 'http',
      data: { url: 'https://maps.googleapis.com/maps/api/geocode/json', 'http.query': `?key=${MAPS_KEY}` },
    } as Breadcrumb);

    expect(crumb!.data!['http.query']).toBeUndefined();
  });

  it('rebuilds Http and NodeFetch so requests carrying a key in the URL are not instrumented', () => {
    const integrationsFn = options.integrations as (defaults: Integration[]) => Integration[];
    const result = integrationsFn([
      { name: 'Http' },
      { name: 'NodeFetch' },
      { name: 'ContextLines' },
      { name: 'Console' },
    ]);

    expect(result.map((integration) => integration.name)).toEqual(['Http', 'NodeFetch', 'Console']);

    for (const integration of result.slice(0, 2)) {
      const ignore = integration.options!.ignoreOutgoingRequests!;

      expect(ignore(GEOCODE_URL)).toBe(true);
      expect(ignore('https://memory.local/api/health')).toBe(false);
    }
  });
});
