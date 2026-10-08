import type { Breadcrumb, Log, NodeOptions } from '@sentry/nestjs';

import { isKeyInUrlRequest } from '../outgoingRequests';
import { scrubBreadcrumb, scrubLog, scrubSpan, scrubTransaction } from '../scrubEvent';

type TransactionEvent = Parameters<NonNullable<NodeOptions['beforeSendTransaction']>>[0];
type SpanJSON = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

const MAPS_KEY = 'AIzaSyD-abc123';
const GEOCODE_URL = `https://maps.googleapis.com/maps/api/geocode/json?address=12+Elm+St&key=${MAPS_KEY}`;

/** What the undici instrumentation records for an outbound fetch. */
function outboundFetchSpan(): SpanJSON {
  return {
    span_id: 'b1',
    trace_id: 't1',
    start_timestamp: 1,
    op: 'http.client',
    description: `GET ${GEOCODE_URL}`,
    data: {
      'http.request.method': 'GET',
      'url.full': GEOCODE_URL,
      'url.path': '/maps/api/geocode/json',
      'url.query': `?address=12+Elm+St&key=${MAPS_KEY}`,
      'server.address': 'maps.googleapis.com',
      'http.response.status_code': 200,
    },
  } as SpanJSON;
}

/** What the inbound server span records for a search request. */
function inboundServerSpanData(): Record<string, unknown> {
  return {
    'sentry.op': 'http.server',
    'url.full': 'https://memory.local/api/graph/search?query=oncologist',
    'http.url': 'https://memory.local/api/graph/search?query=oncologist',
    'http.target': '/api/graph/search?query=oncologist',
    'url.path': '/api/graph/search',
    'http.client_ip': '203.0.113.7',
    'net.peer.ip': '172.18.0.4',
    'http.route': '/api/graph/search',
    'http.status_code': 200,
  };
}

describe('scrubSpan (beforeSendSpan)', () => {
  it('strips the query from url.full and drops url.query on an outbound fetch span', () => {
    const data = scrubSpan(outboundFetchSpan()).data;

    expect(data['url.full']).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(data['url.query']).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(MAPS_KEY);
    expect(JSON.stringify(data)).not.toContain('Elm');
    // Diagnostic signal survives.
    expect(data['url.path']).toBe('/maps/api/geocode/json');
    expect(data['server.address']).toBe('maps.googleapis.com');
    expect(data['http.response.status_code']).toBe(200);
  });

  it('strips the query from an HTTP span description', () => {
    expect(scrubSpan(outboundFetchSpan()).description).toBe(
      'GET https://maps.googleapis.com/maps/api/geocode/json',
    );
  });

  it('strips the query from http.url and http.target and drops the client IPs on a server span', () => {
    const span = {
      span_id: 'a1',
      trace_id: 't1',
      start_timestamp: 1,
      op: 'http.server',
      data: inboundServerSpanData(),
    } as SpanJSON;

    const data = scrubSpan(span).data;

    expect(data['http.url']).toBe('https://memory.local/api/graph/search');
    expect(data['http.target']).toBe('/api/graph/search');
    expect(data['url.full']).toBe('https://memory.local/api/graph/search');
    expect(data['http.client_ip']).toBeUndefined();
    expect(data['net.peer.ip']).toBeUndefined();
    expect(data['http.route']).toBe('/api/graph/search');
  });

  it('strips the query from the Referer the server span copies into its header attributes', () => {
    // httpServerSpansIntegration records every request header its PII deny-list
    // lets through, and that list has no entry for Referer.
    const span = {
      span_id: 'a2',
      trace_id: 't1',
      start_timestamp: 1,
      op: 'http.server',
      data: {
        'http.request.header.referer': 'https://memory.local/memory?search=oncologist',
        'http.request.header.user_agent': 'Mozilla/5.0',
      },
    } as SpanJSON;

    const data = scrubSpan(span).data;

    expect(data['http.request.header.referer']).toBe('https://memory.local/memory');
    expect(data['http.request.header.user_agent']).toBe('Mozilla/5.0');
  });

  it('filters string values under sensitive keys but keeps numeric counters', () => {
    const span = {
      span_id: 'c1',
      trace_id: 't1',
      start_timestamp: 1,
      data: {
        'http.request.header.authorization': 'Bearer abcdefghij',
        'gen_ai.usage.input_tokens': 412,
        'db.statement': 'SELECT 1 -- /home/ci/notes',
      },
    } as SpanJSON;

    const data = scrubSpan(span).data;

    expect(data['http.request.header.authorization']).toBe('[Filtered]');
    expect(data['gen_ai.usage.input_tokens']).toBe(412);
    expect(data['db.statement']).toBe('SELECT 1 -- ~/notes');
  });

  it('leaves a non-HTTP description whole apart from the string rules', () => {
    const span = {
      span_id: 'd1',
      trace_id: 't1',
      start_timestamp: 1,
      op: 'db',
      description: "SELECT data->>'title' FROM ci.content WHERE data ? 'title'",
      data: {},
    } as SpanJSON;

    expect(scrubSpan(span).description).toBe("SELECT data->>'title' FROM ci.content WHERE data ? 'title'");
  });
});

describe('scrubTransaction (beforeSendTransaction)', () => {
  function searchTransaction(): TransactionEvent {
    return {
      type: 'transaction',
      transaction: 'GET /api/graph/search?query=oncologist',
      server_name: 'MacBook-Pro-2.local',
      contexts: {
        trace: { trace_id: 't1', span_id: 'a1', op: 'http.server', data: inboundServerSpanData() },
      },
      spans: [outboundFetchSpan()],
      request: {
        url: 'https://memory.local/api/graph/search?query=oncologist',
        query_string: 'query=oncologist',
        cookies: { sessionToken: 'abc' },
        headers: {
          'x-api-key': 'ci_live_abcdef123456',
          referer: 'https://memory.local/memory?search=oncologist',
        },
      },
      breadcrumbs: [{ category: 'http', data: { url: GEOCODE_URL, 'http.query': '?address=12+Elm+St' } }],
    } as TransactionEvent;
  }

  it('scrubs the request block the same way error events are', () => {
    const request = scrubTransaction(searchTransaction()).request!;

    expect(request.url).toBe('https://memory.local/api/graph/search');
    expect(request.query_string).toBe('[Filtered]');
    expect(request.cookies).toBeUndefined();
    expect(request.headers!['x-api-key']).toBe('[Filtered]');
    expect(request.headers!.referer).toBe('https://memory.local/memory');
  });

  it('scrubs the root span attributes and the transaction name', () => {
    const event = scrubTransaction(searchTransaction());

    expect(event.transaction).toBe('GET /api/graph/search');
    expect(event.contexts!.trace!.data!['http.target']).toBe('/api/graph/search');
    expect(event.contexts!.trace!.data!['http.client_ip']).toBeUndefined();
  });

  it('scrubs child spans and breadcrumbs and removes the hostname', () => {
    const event = scrubTransaction(searchTransaction());
    const serialized = JSON.stringify(event);

    expect(serialized).not.toContain(MAPS_KEY);
    expect(serialized).not.toContain('oncologist');
    expect(serialized).not.toContain('Elm');
    expect(event.server_name).toBeUndefined();
    expect(event.spans![0]!.data['url.query']).toBeUndefined();
    expect(event.breadcrumbs![0]!.data!.url).toBe('https://maps.googleapis.com/maps/api/geocode/json');
  });
});

describe('scrubLog (beforeSendLog)', () => {
  it('scrubs the body and the attributes, parameters included', () => {
    const log = {
      level: 'warn',
      message: 'geocode failed for /home/ci/import with api_key=sk-live-1234567890',
      attributes: {
        'sentry.message.parameter.0': '/Users/liam/notes/visit.md',
        'url.full': GEOCODE_URL,
        'url.query': `?key=${MAPS_KEY}`,
        'http.request.header.cookie': 'session=abc',
        attempt: 3,
      },
    } as Log;

    const scrubbed = scrubLog(log);

    expect(scrubbed.message).toBe('geocode failed for ~/import with [Filtered]');
    expect(scrubbed.attributes!['url.full']).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(scrubbed.attributes!['url.query']).toBeUndefined();
    expect(scrubbed.attributes!['http.request.header.cookie']).toBe('[Filtered]');
    expect(scrubbed.attributes!.attempt).toBe(3);
    expect(scrubbed.attributes!['sentry.message.parameter.0']).toBe('~/notes/visit.md');
  });
});

describe('scrubBreadcrumb (beforeBreadcrumb)', () => {
  it('drops the query keys and strips the query from url-valued data', () => {
    const crumb = {
      category: 'http',
      message: 'GET /Users/liam/notes',
      data: {
        url: 'https://memory.local/api/graph/search?query=oncologist',
        'http.query': '?query=oncologist',
        'http.fragment': '#top',
        token: 'abc123',
        status_code: 200,
      },
    } as Breadcrumb;

    const scrubbed = scrubBreadcrumb(crumb);

    expect(scrubbed.message).toBe('GET ~/notes');
    expect(scrubbed.data!.url).toBe('https://memory.local/api/graph/search');
    expect(scrubbed.data!['http.query']).toBeUndefined();
    expect(scrubbed.data!['http.fragment']).toBeUndefined();
    expect(scrubbed.data!.token).toBe('[Filtered]');
    expect(scrubbed.data!.status_code).toBe(200);
  });
});

describe('isKeyInUrlRequest (ignoreOutgoingRequests)', () => {
  it.each([
    GEOCODE_URL,
    'https://MAPS.googleapis.com/maps/api/geocode/json',
    'https://api.themoviedb.org/3/trending/movie/week?api_key=k',
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?steamid=1&key=k',
  ])('ignores %s', (url) => {
    expect(isKeyInUrlRequest(url)).toBe(true);
  });

  it.each(['https://memory.local/api/health', 'https://www.googleapis.com/calendar/v3/events', 'not a url'])(
    'records %s',
    (url) => {
      expect(isKeyInUrlRequest(url)).toBe(false);
    },
  );
});
