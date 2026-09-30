import { OutlookCalendarTransformService } from '../TransformOutlookCalendar';

/**
 * Every constructor dependency mocked; `transformToEventDto` (private) is
 * exercised directly via a cast, matching the convention used elsewhere for
 * services whose public entry point orchestrates work unrelated to the thing
 * under test (see ContextPromptPersistService.spec.ts).
 */
function makeService() {
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  return new OutlookCalendarTransformService(
    {} as never, // MemoryEventService — unused by transformToEventDto
    {} as never, // ConnectionService — unused by transformToEventDto
    {} as never, // PromoteService — unused by transformToEventDto
    logger as never,
  );
}

function outlookEvent(displayName: string | null) {
  return {
    id: 'evt-1',
    subject: 'Standup',
    start: { dateTime: '2026-08-18T10:00:00Z' },
    end: { dateTime: '2026-08-18T10:30:00Z' },
    location: displayName == null ? undefined : { displayName },
    isRecurring: false,
    isAllDay: false,
    isCancelled: false,
  };
}

/**
 * `transformToEventDto` is private; this is the one place that reaches past
 * that to call it directly, so the `any` cast it requires stays contained
 * here instead of repeated at every call site.
 */
function callTransformToEventDto(
  service: OutlookCalendarTransformService,
  event: ReturnType<typeof outlookEvent>,
  userId: string,
  connectionId: string,
): Promise<{ location_name?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).transformToEventDto(event, userId, connectionId);
}

describe('OutlookCalendarTransformService.transformToEventDto — location_name', () => {
  it('refuses a Teams join link pasted into location.displayName', async () => {
    const service = makeService();
    const dto = await callTransformToEventDto(
      service,
      outlookEvent('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc'),
      'user-1',
      'conn-1',
    );

    expect(dto.location_name).toBeUndefined();
  });

  it('refuses an AltspaceVR custom-scheme URI', async () => {
    const service = makeService();
    const dto = await callTransformToEventDto(
      service,
      outlookEvent('altspace://account.altvr.com/api/events/1629227784846967373'),
      'user-1',
      'conn-1',
    );

    expect(dto.location_name).toBeUndefined();
  });

  it('keeps a real venue name', async () => {
    const service = makeService();
    const dto = await callTransformToEventDto(
      service,
      outlookEvent('Conference Room 4B, HQ'),
      'user-1',
      'conn-1',
    );

    expect(dto.location_name).toBe('Conference Room 4B, HQ');
  });

  it('leaves location_name null when the event has no location at all', async () => {
    const service = makeService();
    const dto = await callTransformToEventDto(service, outlookEvent(null), 'user-1', 'conn-1');

    expect(dto.location_name).toBeUndefined();
  });
});

/**
 * The public entry point, fed a sync job shaped the way SyncOutlookCalendar
 * writes it: `{ calendars: [{ id, events: [...] }, ...] }`. Only the two
 * services `processCalendarEvent` writes through are stubbed.
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

  return { service, eventService, logger };
}

function graphEvent(subject: string) {
  return {
    id: `graph-${subject}`,
    iCalUId: `uid-${subject}`,
    subject,
    start: { dateTime: '2026-08-18T10:00:00Z' },
    end: { dateTime: '2026-08-18T10:30:00Z' },
  };
}

function runTransform(service: OutlookCalendarTransformService, data: unknown): Promise<void> {
  return service.transformOutlookCalendar({
    connection: { id: 'conn-1' } as never,
    syncJob: { id: 'job-1', userId: 'user-1', data } as never,
  });
}

/** Titles of every event handed to CalendarEventService.create, sorted. */
function createdTitles(eventService: { create: jest.Mock }): string[] {
  return eventService.create.mock.calls.map(([, dto]) => (dto as { title: string }).title).sort();
}

describe('OutlookCalendarTransformService.transformOutlookCalendar — every calendar', () => {
  it('imports the events of every calendar, not just the first', async () => {
    const { service, eventService } = makeIngestService();

    await runTransform(service, {
      calendars: [
        { id: 'cal-work', name: 'Calendar', events: [graphEvent('Standup'), graphEvent('Retro')] },
        { id: 'cal-family', name: 'Family', events: [graphEvent('Dentist')] },
      ],
    });

    expect(createdTitles(eventService)).toEqual(['Dentist', 'Retro', 'Standup']);
  });

  it('skips a calendar whose events are missing or not an array, and still imports the rest', async () => {
    const { service, eventService, logger } = makeIngestService();

    await runTransform(service, {
      calendars: [
        { id: 'cal-no-events' },
        { id: 'cal-null-events', events: null },
        { id: 'cal-object-events', events: { value: [graphEvent('Nested')] } },
        null,
        { id: 'cal-ok', events: [graphEvent('Dentist')] },
      ],
    });

    expect(createdTitles(eventService)).toEqual(['Dentist']);

    const skipped = logger.warn.mock.calls
      .filter(([message]) => message === 'Outlook calendar has no events array; skipping it')
      .map(([, meta]) => (meta as { calendarId?: unknown }).calendarId);

    expect(skipped).toEqual(['cal-no-events', 'cal-null-events', 'cal-object-events', undefined]);
  });

  it('bounds how many events are in flight at once, and still processes every one', async () => {
    const { service, eventService } = makeIngestService();
    let inFlight = 0;
    let maxInFlight = 0;

    eventService.create.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;

      return [];
    });

    const subjects = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => graphEvent(`${prefix}-${String(i).padStart(2, '0')}`));

    await runTransform(service, {
      calendars: [
        { id: 'cal-work', events: subjects('work', 13) },
        { id: 'cal-family', events: subjects('family', 12) },
      ],
    });

    expect(eventService.create).toHaveBeenCalledTimes(25);
    expect(new Set(createdTitles(eventService)).size).toBe(25);
    // Two full batches of ten, then five: never the whole payload at once.
    expect(maxInFlight).toBe(10);
  });

  it('skips a Graph delta tombstone instead of minting an "Untitled Event" for it', async () => {
    const { service, eventService } = makeIngestService();

    await runTransform(service, {
      calendars: [
        {
          id: 'cal-work',
          events: [
            // Verbatim shape from Graph's calendarView/delta docs: nothing but
            // the type, the id and the annotation.
            {
              '@odata.type': '#microsoft.graph.event',
              id: 'AAMkADk0MGFkODE3LWE4MmYtNDRhOS04OGQLkRkXbBznTvAADb6ytyAAA=',
              '@removed': { reason: 'deleted' },
            },
            graphEvent('Standup'),
          ],
        },
      ],
    });

    expect(createdTitles(eventService)).toEqual(['Standup']);
  });
});
