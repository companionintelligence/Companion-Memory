import type { BaseClient, Connection } from '@ci/domains/connections';

import { MAX_DELTA_EVENTS_PER_RUN, syncOutlookCalendar } from '../SyncOutlookCalendar';

const CALENDAR_LIST = '/v1.0/me/calendars?top=50';
const GRAPH = 'https://graph.microsoft.com';

/** Links Graph hands back mid-round and at the end of a round; the code under test treats both as opaque. */
const pageLink = (calendarId: string, token: string) =>
  `${GRAPH}/v1.0/me/calendars/${calendarId}/calendarView/delta?$skiptoken=${token}`;
const roundEndLink = (calendarId: string, token: string) =>
  `${GRAPH}/v1.0/me/calendars/${calendarId}/calendarView/delta?$deltatoken=${token}`;

/** A round's first request embeds the current time, so routes match it by this prefix (`*` = prefix). */
const firstRequest = (calendarId: string) =>
  `/v1.0/me/calendars/${calendarId}/calendarView/delta?startDateTime=*`;

const event = (id: string, extra: Record<string, unknown> = {}) => ({ id, subject: id, ...extra });

/**
 * A Graph stand-in. `routes` answers by exact endpoint (a key ending in `*` is
 * a prefix match). A request no route answers throws, so a missing or stray
 * request fails the test instead of silently returning nothing.
 */
function createClient(routes: Record<string, unknown>) {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const request = jest.fn(async (_connection: Connection, endpoint: string) => {
    for (const [key, response] of Object.entries(routes)) {
      const hit = key.endsWith('*') ? endpoint.startsWith(key.slice(0, -1)) : endpoint === key;

      if (hit) {
        if (response instanceof Error) {
          throw response;
        }

        return response;
      }
    }

    throw new Error(`Unexpected request: ${endpoint}`);
  });

  return { client: { logger, request } as unknown as BaseClient, logger, request };
}

type SyncResult = Awaited<ReturnType<typeof syncOutlookCalendar>>;
type SyncedCalendar = {
  id: string;
  events: Array<{ id: string; attachments?: unknown }>;
  deltaWindow?: { startDateTime: string; endDateTime: string };
};

function incremental(client: BaseClient, nextCursor: Record<string, unknown> = {}): Promise<SyncResult> {
  return syncOutlookCalendar({
    connection: { id: 'connection-1' } as Connection,
    client,
    nextCursor,
    historical: false,
  });
}

const calendarsOf = (result: SyncResult) => result.data.calendars as SyncedCalendar[];
const idsOf = (calendar: SyncedCalendar) => calendar.events.map((e) => e.id);
const requested = (request: jest.Mock) => request.mock.calls.map(([, endpoint]) => endpoint as string);

/** The date range a fresh round was opened with, read back off its first request. */
function windowOf(request: jest.Mock, calendarId: string) {
  const first = requested(request).find((endpoint) =>
    endpoint.startsWith(`/v1.0/me/calendars/${calendarId}/calendarView/delta?startDateTime=`),
  );
  const params = new URL(first as string, GRAPH).searchParams;

  return { startDateTime: params.get('startDateTime'), endDateTime: params.get('endDateTime') };
}

/** A range recorded by an earlier run, stored beside that run's link. */
const STORED_WINDOW = { startDateTime: '2026-09-01T00:00:00.000Z', endDateTime: '2029-09-01T00:00:00.000Z' };

describe('syncOutlookCalendar — incremental delta rounds', () => {
  it("drains every page of a calendar's round and keeps the deltaLink from the last one", async () => {
    const { client, request } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [firstRequest('cal-a')]: {
        value: [event('e1'), event('e2')],
        '@odata.nextLink': pageLink('cal-a', 'p2'),
      },
      // Graph may send an empty page mid-round: "even if the current response
      // contains an empty result" — it is not the end of the round.
      [pageLink('cal-a', 'p2')]: { value: [], '@odata.nextLink': pageLink('cal-a', 'p3') },
      [pageLink('cal-a', 'p3')]: { value: [event('e3')], '@odata.deltaLink': roundEndLink('cal-a', 'd1') },
    });

    const result = await incremental(client);

    expect(idsOf(calendarsOf(result)[0])).toEqual(['e1', 'e2', 'e3']);
    expect(result.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': roundEndLink('cal-a', 'd1') },
      deltaWindows: { 'cal-a': windowOf(request, 'cal-a') },
    });
    expect(requested(request)).toEqual([
      CALENDAR_LIST,
      expect.stringContaining('/v1.0/me/calendars/cal-a/calendarView/delta?startDateTime='),
      pageLink('cal-a', 'p2'),
      pageLink('cal-a', 'p3'),
    ]);
  });

  it('replays a stored deltaLink verbatim and carries forward the fresh one', async () => {
    const stored = roundEndLink('cal-a', 'd1');
    const { client, request } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [stored]: { value: [event('new')], '@odata.deltaLink': roundEndLink('cal-a', 'd2') },
    });

    const result = await incremental(client, {
      deltaLinks: { 'cal-a': stored },
      deltaWindows: { 'cal-a': STORED_WINDOW },
    });

    expect(idsOf(calendarsOf(result)[0])).toEqual(['new']);
    expect(result.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': roundEndLink('cal-a', 'd2') },
      deltaWindows: { 'cal-a': STORED_WINDOW },
    });
    // No fresh round is started when a cursor exists.
    expect(requested(request)).toEqual([CALENDAR_LIST, stored]);
  });

  it("keeps a cursor per calendar when only one calendar's round spans pages", async () => {
    const { client, request } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }, { id: 'cal-b' }] },
      [firstRequest('cal-a')]: { value: [event('a1')], '@odata.nextLink': pageLink('cal-a', 'p2') },
      [pageLink('cal-a', 'p2')]: { value: [event('a2')], '@odata.deltaLink': roundEndLink('cal-a', 'da') },
      [firstRequest('cal-b')]: { value: [event('b1')], '@odata.deltaLink': roundEndLink('cal-b', 'db') },
    });

    const result = await incremental(client);
    const [calA, calB] = calendarsOf(result);

    expect(idsOf(calA)).toEqual(['a1', 'a2']);
    expect(idsOf(calB)).toEqual(['b1']);
    expect(result.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': roundEndLink('cal-a', 'da'), 'cal-b': roundEndLink('cal-b', 'db') },
      deltaWindows: { 'cal-a': windowOf(request, 'cal-a'), 'cal-b': windowOf(request, 'cal-b') },
    });
  });

  it('fetches attachments for events on every page, not just the first', async () => {
    const attachmentsFor = (eventId: string) =>
      `/v1.0/me/calendars/cal-a/events/${eventId}/attachments?$select=id,lastModifiedDateTime,name,contentType,size,isInline&top=100`;
    const { client, request } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [firstRequest('cal-a')]: { value: [event('e1')], '@odata.nextLink': pageLink('cal-a', 'p2') },
      [pageLink('cal-a', 'p2')]: {
        value: [event('e2', { hasAttachments: true })],
        '@odata.deltaLink': roundEndLink('cal-a', 'd1'),
      },
      [attachmentsFor('e2')]: { value: [{ id: 'att-1' }] },
    });

    const result = await incremental(client);
    const [calendar] = calendarsOf(result);

    expect(calendar.events.find((e) => e.id === 'e2')?.attachments).toEqual([{ id: 'att-1' }]);
    expect(requested(request)).toContain(attachmentsFor('e2'));
  });
});

describe("syncOutlookCalendar — the date range a calendar's round covers", () => {
  // Graph reports `@removed` for an event deleted inside a round's range AND
  // for one added, edited or deleted outside it, and the round's links are
  // opaque. The transform can only tell the two apart by the range, so the
  // range is recorded beside the link and handed over with the events.
  it('records the range a fresh round is opened with, beside its link, and hands it over with the events', async () => {
    const { client, request } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [firstRequest('cal-a')]: { value: [event('e1')], '@odata.deltaLink': roundEndLink('cal-a', 'd1') },
    });

    const result = await incremental(client);
    const window = windowOf(request, 'cal-a');

    // Three years ahead of the moment the round opened, as initialDeltaRound asks.
    expect(Date.parse(window.endDateTime as string) - Date.parse(window.startDateTime as string)).toBe(
      3 * 365 * 24 * 60 * 60 * 1000,
    );
    expect(calendarsOf(result)[0].deltaWindow).toStrictEqual(window);
    expect(result.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': roundEndLink('cal-a', 'd1') },
      deltaWindows: { 'cal-a': window },
    });
  });

  it('carries a stored range forward with its link: the round, and so its range, is the same', async () => {
    const stored = roundEndLink('cal-a', 'd1');
    const { client } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [stored]: { value: [event('new')], '@odata.deltaLink': roundEndLink('cal-a', 'd2') },
    });

    const result = await incremental(client, {
      deltaLinks: { 'cal-a': stored },
      deltaWindows: { 'cal-a': STORED_WINDOW },
    });

    expect(calendarsOf(result)[0].deltaWindow).toStrictEqual(STORED_WINDOW);
    expect(result.nextCursor).toMatchObject({ deltaWindows: { 'cal-a': STORED_WINDOW } });
  });

  it('opens a fresh round for a link stored without its range, rather than follow a round of unknown range', async () => {
    const legacy = roundEndLink('cal-a', 'd1');
    const { client, request } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [firstRequest('cal-a')]: { value: [event('e1')], '@odata.deltaLink': roundEndLink('cal-a', 'fresh') },
    });

    const result = await incremental(client, { deltaLinks: { 'cal-a': legacy } });

    expect(requested(request)).not.toContain(legacy);
    expect(result.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': roundEndLink('cal-a', 'fresh') },
      deltaWindows: { 'cal-a': windowOf(request, 'cal-a') },
    });
  });
});

describe('syncOutlookCalendar — the per-run event cap', () => {
  const filler = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => event(`${prefix}${i}`));

  it('stops at the cap and stores the nextLink it stopped on, and the next run finishes the round from it', async () => {
    const stopsOn = pageLink('cal-a', 'p3');
    const first = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      // One short of the cap: the walk must go on to page two...
      [firstRequest('cal-a')]: {
        value: filler(MAX_DELTA_EVENTS_PER_RUN - 1, 'a'),
        '@odata.nextLink': pageLink('cal-a', 'p2'),
      },
      // ...which tips it over, so page three is left for the next run.
      [pageLink('cal-a', 'p2')]: { value: [event('b0'), event('b1')], '@odata.nextLink': stopsOn },
    });

    const firstRun = await incremental(first.client);

    expect(calendarsOf(firstRun)[0].events).toHaveLength(MAX_DELTA_EVENTS_PER_RUN + 1);
    expect(requested(first.request)).not.toContain(stopsOn);
    expect(firstRun.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': stopsOn },
      deltaWindows: { 'cal-a': windowOf(first.request, 'cal-a') },
    });

    const second = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [stopsOn]: { value: [event('last')], '@odata.deltaLink': roundEndLink('cal-a', 'd1') },
    });

    const secondRun = await incremental(second.client, firstRun.nextCursor);

    expect(requested(second.request)).toEqual([CALENDAR_LIST, stopsOn]);
    expect(idsOf(calendarsOf(secondRun)[0])).toEqual(['last']);
    // Still the range the round was opened with, a run ago.
    expect(secondRun.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': roundEndLink('cal-a', 'd1') },
      deltaWindows: { 'cal-a': windowOf(first.request, 'cal-a') },
    });
  });

  it('records the deltaLink, not a nextLink, when the page that reaches the cap is the last one', async () => {
    const { client, request } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [firstRequest('cal-a')]: {
        value: filler(MAX_DELTA_EVENTS_PER_RUN, 'a'),
        '@odata.deltaLink': roundEndLink('cal-a', 'd1'),
      },
    });

    const result = await incremental(client);

    expect(result.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': roundEndLink('cal-a', 'd1') },
      deltaWindows: { 'cal-a': windowOf(request, 'cal-a') },
    });
  });
});

describe('syncOutlookCalendar — malformed and failing delta responses', () => {
  it('keeps the link it started from when a response carries neither link', async () => {
    const stored = roundEndLink('cal-a', 'd1');
    const { client, logger } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [stored]: { value: [event('x')] },
    });

    const result = await incremental(client, {
      deltaLinks: { 'cal-a': stored },
      deltaWindows: { 'cal-a': STORED_WINDOW },
    });

    expect(result.nextCursor).toStrictEqual({
      deltaLinks: { 'cal-a': stored },
      deltaWindows: { 'cal-a': STORED_WINDOW },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Outlook Calendar delta response carried neither a nextLink nor a deltaLink',
      expect.objectContaining({ calendarId: 'cal-a' }),
    );
  });

  it('writes no cursor entry at all, rather than an undefined one, when there is no link to keep', async () => {
    const { client } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [firstRequest('cal-a')]: { value: [event('x')] },
    });

    const result = await incremental(client);

    // toStrictEqual distinguishes a missing key from one set to undefined. A
    // range is kept only beside a link: with no link there is no round to resume.
    expect(result.nextCursor).toStrictEqual({ deltaLinks: {}, deltaWindows: {} });
  });

  it('rethrows a failing page, and logs the Graph error code the client attached', async () => {
    const stored = roundEndLink('cal-a', 'd1');
    const failure = Object.assign(new Error('The sync state generation is not found.'), {
      details: { code: 'syncStateNotFound' },
    });
    const { client, logger } = createClient({
      [CALENDAR_LIST]: { value: [{ id: 'cal-a' }] },
      [stored]: failure,
    });

    await expect(
      incremental(client, { deltaLinks: { 'cal-a': stored }, deltaWindows: { 'cal-a': STORED_WINDOW } }),
    ).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledWith(
      'Error fetching Outlook Calendar delta page',
      expect.objectContaining({ calendarId: 'cal-a', details: { code: 'syncStateNotFound' } }),
    );
  });
});
