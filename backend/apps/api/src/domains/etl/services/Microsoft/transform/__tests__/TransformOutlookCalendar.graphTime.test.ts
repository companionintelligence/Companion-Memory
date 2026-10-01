import type { CreateEventDto } from '@ci/domains/memory';

import { OutlookCalendarTransformService } from '../TransformOutlookCalendar';

/**
 * Event times exactly as Graph sends them: `dateTime` with NO offset, the zone in
 * `timeZone` (UTC unless a request asks otherwise, and none does). The sibling
 * specs write `…Z` fixtures, which Graph never sends and which `new Date` reads
 * identically in every zone; the transform read the real thing in the zone of
 * the process, so it passed them everywhere and stored real events hours off
 * wherever the process was not in UTC (a `make dev` api on a laptop, or a Hub
 * host that passes its own `TZ` to the container).
 *
 * Every expectation is a literal UTC instant. Each table below holds a UTC row
 * and a non-UTC row, so the old behaviour fails at least one of them whatever
 * zone the machine is in: a UTC machine fails the zoned row, a machine in that
 * zone fails the UTC row. Run it under another zone to see it hold:
 *
 *   TZ=America/Los_Angeles yarn workspace @ci/be-api jest TransformOutlookCalendar.graphTime
 */
function makeIngestService() {
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const eventService = { create: jest.fn().mockResolvedValue([]) };
  const promoteService = { processParticipants: jest.fn().mockResolvedValue([]) };

  const service = new OutlookCalendarTransformService(
    eventService as never,
    {} as never, // ConnectionService — unused by the transform
    promoteService as never,
    logger as never,
  );

  return { service, eventService, promoteService, logger };
}

function graphEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'AAMkAD-evt-1',
    iCalUId: 'uid-evt-1',
    subject: 'Standup',
    start: { dateTime: '2026-09-23T19:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-23T20:30:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    isCancelled: false,
    ...overrides,
  };
}

function runTransform(service: OutlookCalendarTransformService, events: unknown[]): Promise<void> {
  return service.transformOutlookCalendar({
    connection: { id: 'conn-1' } as never,
    syncJob: { id: 'job-1', userId: 'user-1', data: { calendars: [{ id: 'cal-1', events }] } } as never,
  });
}

/** One event through the real transform; the DTO CalendarEventService.create was handed. */
async function ingest(event: Record<string, unknown>) {
  const context = makeIngestService();

  await runTransform(context.service, [event]);

  return { ...context, dto: context.eventService.create.mock.calls[0]?.[1] as CreateEventDto | undefined };
}

const graphTime = (dateTime: string, timeZone: string) => ({ dateTime, timeZone });

describe('OutlookCalendarTransformService — event times as Graph sends them', () => {
  it.each([
    [
      'UTC, which Graph answers in unless asked otherwise',
      'UTC',
      '2026-09-23T19:00:00.0000000',
      '2026-09-23T20:30:00.0000000',
      '2026-09-23T19:00:00.000Z',
      '2026-09-23T20:30:00.000Z',
    ],
    [
      'America/Los_Angeles (UTC-7 in September)',
      'America/Los_Angeles',
      '2026-09-23T12:00:00.0000000',
      '2026-09-23T13:30:00.0000000',
      '2026-09-23T19:00:00.000Z',
      '2026-09-23T20:30:00.000Z',
    ],
    [
      'Asia/Kolkata (UTC+5:30)',
      'Asia/Kolkata',
      '2026-09-23T12:00:00.0000000',
      '2026-09-23T13:30:00.0000000',
      '2026-09-23T06:30:00.000Z',
      '2026-09-23T08:00:00.000Z',
    ],
  ])(
    'stores %s at the instant it names',
    async (_label, timeZone, start, end, expectedStart, expectedEnd) => {
      const { dto } = await ingest(
        graphEvent({ start: graphTime(start, timeZone), end: graphTime(end, timeZone) }),
      );

      expect(dto?.start_time.toISOString()).toBe(expectedStart);
      expect(dto?.end_time?.toISOString()).toBe(expectedEnd);
    },
  );

  it.each([
    // Graph: an all-day event "must be set to midnight and be in the same time zone".
    ['UTC', 'UTC', '2026-09-23T00:00:00.000Z', '2026-09-24T00:00:00.000Z'],
    ['America/Los_Angeles', 'America/Los_Angeles', '2026-09-23T07:00:00.000Z', '2026-09-24T07:00:00.000Z'],
  ])(
    'stores an all-day event in %s at midnight in that zone',
    async (_label, timeZone, expectedStart, expectedEnd) => {
      const { dto } = await ingest(
        graphEvent({
          isAllDay: true,
          start: graphTime('2026-09-23T00:00:00.0000000', timeZone),
          end: graphTime('2026-09-24T00:00:00.0000000', timeZone),
        }),
      );

      expect(dto?.is_all_day).toBe(true);
      expect(dto?.start_time.toISOString()).toBe(expectedStart);
      expect(dto?.end_time?.toISOString()).toBe(expectedEnd);
    },
  );

  it('still stamps an event with no start at ingest time, flagged as not a real time', async () => {
    const before = Date.now();
    const { dto } = await ingest(graphEvent({ start: undefined, end: undefined }));

    expect(dto?.time_source).toBe('ingest');
    expect(dto?.time_precision).toBe('unknown');
    expect(dto?.start_time.getTime()).toBeGreaterThanOrEqual(before);
    expect(dto?.end_time).toBeUndefined();
  });

  it('leaves an override identity alone: originalStart is a DateTimeOffset, not a wall clock', async () => {
    const { dto } = await ingest(
      graphEvent({ originalStart: '2026-09-23T19:00:00Z', seriesMasterId: 'master-1' }),
    );

    expect(dto?.source_id).toBe('uid-evt-1#20260923T190000Z');
  });
});

describe('OutlookCalendarTransformService — the times its participants are linked at', () => {
  const organizer = { emailAddress: { name: 'Samantha Booth', address: 'samanthab@contoso.com' } };
  const attendees = [
    { emailAddress: { name: 'Ana', address: 'ana@contoso.com' }, status: { response: 'accepted' } },
  ];

  it.each([
    ['UTC', 'UTC', '2026-09-23T19:00:00.0000000', '2026-09-23T20:30:00.0000000'],
    [
      'America/Los_Angeles',
      'America/Los_Angeles',
      '2026-09-23T12:00:00.0000000',
      '2026-09-23T13:30:00.0000000',
    ],
  ])('links them at the same instants as the event itself, for %s', async (_label, timeZone, start, end) => {
    const { dto, promoteService } = await ingest(
      graphEvent({ organizer, attendees, start: graphTime(start, timeZone), end: graphTime(end, timeZone) }),
    );

    const calls = promoteService.processParticipants.mock.calls;

    expect(calls.map((call) => call[4])).toEqual(['ORGANIZED_EVENT_WITH', 'MET_WITH']);

    for (const call of calls) {
      expect(call[5]).toEqual(dto?.start_time);
      expect(call[6]).toEqual(dto?.end_time);
      expect((call[5] as Date).toISOString()).toBe('2026-09-23T19:00:00.000Z');
      expect((call[6] as Date).toISOString()).toBe('2026-09-23T20:30:00.000Z');
    }
  });

  it('links them at no time when the event has none, rather than at the ingest stamp', async () => {
    const { promoteService } = await ingest(
      graphEvent({ organizer, attendees, start: undefined, end: undefined }),
    );

    expect(promoteService.processParticipants).toHaveBeenCalledTimes(2);

    for (const [, , , , , startDate, endDate] of promoteService.processParticipants.mock.calls) {
      expect(startDate).toBeUndefined();
      expect(endDate).toBeUndefined();
    }
  });
});

describe('OutlookCalendarTransformService — a time zone it cannot resolve', () => {
  const inZone = (id: string, timeZone: string) =>
    graphEvent({
      id,
      iCalUId: `uid-${id}`,
      start: graphTime('2026-09-23T12:00:00.0000000', timeZone),
      end: graphTime('2026-09-23T13:00:00.0000000', timeZone),
    });

  it('reads the wall clock as UTC and warns once per zone, not once per event', async () => {
    const { service, eventService, logger } = makeIngestService();

    await runTransform(service, [
      inZone('a', 'Pacific Standard Time'),
      inZone('b', 'Pacific Standard Time'),
      inZone('c', 'Mountain Standard Time'),
    ]);

    expect(eventService.create).toHaveBeenCalledTimes(3);

    for (const [, dto] of eventService.create.mock.calls) {
      expect((dto as CreateEventDto).start_time.toISOString()).toBe('2026-09-23T12:00:00.000Z');
      expect((dto as CreateEventDto).end_time?.toISOString()).toBe('2026-09-23T13:00:00.000Z');
    }

    const warnedZones = logger.warn.mock.calls
      .filter(([message]) =>
        String(message).startsWith('Outlook event time zone is not one this runtime knows'),
      )
      .map(([, meta]) => (meta as { timeZone: string }).timeZone);

    expect(warnedZones).toEqual(['Pacific Standard Time', 'Mountain Standard Time']);
  });

  it('does not warn about a zone it resolves', async () => {
    const { service, logger } = makeIngestService();

    await runTransform(service, [inZone('a', 'America/Denver'), inZone('b', 'UTC')]);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('OutlookCalendarTransformService — a dateTime that is not a date-time', () => {
  it('skips that event with an error that says why, and still imports the rest', async () => {
    const { service, eventService, logger } = makeIngestService();

    await runTransform(service, [
      graphEvent({ id: 'bad', iCalUId: 'uid-bad', start: graphTime('next tuesday', 'UTC') }),
      graphEvent({ id: 'good', iCalUId: 'uid-good' }),
    ]);

    expect(eventService.create).toHaveBeenCalledTimes(1);

    const [[, created]] = eventService.create.mock.calls;

    expect((created as CreateEventDto).source_id).toBe('uid-good');
    expect(logger.error).toHaveBeenCalledWith(
      'Error processing individual Outlook Calendar event',
      expect.objectContaining({
        eventId: 'bad',
        error: expect.stringContaining('Unparseable Graph dateTime'),
      }),
    );
  });
});
