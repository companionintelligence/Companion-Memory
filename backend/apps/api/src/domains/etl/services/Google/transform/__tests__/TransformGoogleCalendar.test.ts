import { GoogleCalendarTransformService } from '../TransformGoogleCalendar';

/**
 * Every constructor dependency mocked; `transformToEventDto` (private) is
 * exercised directly via a cast, matching the convention used elsewhere for
 * services whose public entry point orchestrates work unrelated to the thing
 * under test (see ContextPromptPersistService.spec.ts).
 */
function makeService(geocodeStatus: 'OK' | 'ZERO_RESULTS' = 'ZERO_RESULTS') {
  const geocodeService = {
    geocode: jest
      .fn()
      .mockResolvedValue(
        geocodeStatus === 'OK'
          ? { status: 'OK', point: { type: 'Point', coordinates: [1, 2] }, confidence: 0.8 }
          : { status: 'ZERO_RESULTS', point: null, confidence: null, cached: false, retryable: false },
      ),
  };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const service = new GoogleCalendarTransformService(
    {} as never, // MemoryEventService — unused by transformToEventDto
    {} as never, // ConnectionService — unused by transformToEventDto
    {} as never, // PromoteService — unused by transformToEventDto
    geocodeService as never,
    logger as never,
  );

  return { service, geocodeService };
}

function eventDetails(location: string | null) {
  return {
    id: 'evt-1',
    summary: 'Standup',
    description: null,
    startTime: '2026-08-18T10:00:00Z',
    endTime: '2026-08-18T10:30:00Z',
    location,
    organizerEmail: 'unknown',
    organizerName: 'unknown',
    participants: [],
    isRecurring: false,
    status: 'confirmed',
    created: null,
    updated: null,
  };
}

/**
 * `transformToEventDto` is private; this is the one place that reaches past
 * that to call it directly, so the `any` cast it requires stays contained
 * here instead of repeated at every call site.
 */
function callTransformToEventDto(
  service: GoogleCalendarTransformService,
  details: ReturnType<typeof eventDetails>,
  rawEvent: { id: string; summary: string; status: string; recurrence?: string[] },
  userId: string,
  connectionId: string,
): Promise<{ location_name?: string; metadata?: Record<string, unknown> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).transformToEventDto(details, rawEvent, userId, connectionId);
}

describe('GoogleCalendarTransformService.transformToEventDto — location_name', () => {
  it('refuses a Zoom join link as the location name', async () => {
    const { service, geocodeService } = makeService();
    const dto = await callTransformToEventDto(
      service,
      eventDetails('https://khronosgroup.zoom.us/w/99353948195?tk=oBjpnuWTonC0SQZ_XX0y'),
      { id: 'evt-1', summary: 'Standup', status: 'confirmed' },
      'user-1',
      'conn-1',
    );

    expect(dto.location_name).toBeUndefined();
    // The geocoder is still asked (it has its own, broader virtual-location
    // guard) — this test only asserts location_name, not geocode gating.
    expect(geocodeService.geocode).toHaveBeenCalledWith(
      'https://khronosgroup.zoom.us/w/99353948195?tk=oBjpnuWTonC0SQZ_XX0y',
    );
  });

  it('refuses an AltspaceVR custom-scheme URI as the location name', async () => {
    const { service } = makeService();
    const dto = await callTransformToEventDto(
      service,
      eventDetails('altspace://account.altvr.com/api/events/1629227784846967373'),
      { id: 'evt-1', summary: 'VR meetup', status: 'confirmed' },
      'user-1',
      'conn-1',
    );

    expect(dto.location_name).toBeUndefined();
  });

  it('keeps a real venue name', async () => {
    const { service } = makeService('OK');
    const dto = await callTransformToEventDto(
      service,
      eventDetails('Golden Gate Park, San Francisco, CA'),
      { id: 'evt-1', summary: 'Picnic', status: 'confirmed' },
      'user-1',
      'conn-1',
    );

    expect(dto.location_name).toBe('Golden Gate Park, San Francisco, CA');
  });

  it('leaves location_name undefined when the event has no location at all', async () => {
    const { service } = makeService();
    const dto = await callTransformToEventDto(
      service,
      eventDetails(null),
      { id: 'evt-1', summary: 'No location', status: 'confirmed' },
      'user-1',
      'conn-1',
    );

    expect(dto.location_name).toBeUndefined();
  });
});

describe('GoogleCalendarTransformService.transformToEventDto — recurrence', () => {
  it('persists the RRULE on metadata.recurrenceRule for a recurring series master (singleEvents=false)', async () => {
    const { service } = makeService();
    const dto = await callTransformToEventDto(
      service,
      { ...eventDetails(null), isRecurring: true },
      {
        id: 'evt-1',
        summary: 'Weekly sync',
        status: 'confirmed',
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10'],
      },
      'user-1',
      'conn-1',
    );

    // Nothing in this codebase expands an RRULE yet (see SyncCalendar.ts), so
    // the rule must survive losslessly on the stored row instead of being
    // discarded — `recurrence_pattern` is silently dropped by
    // CalendarEventService on create(), so `metadata` (a plain pass-through
    // column) is where it has to live.
    expect(dto.metadata?.recurrenceRule).toEqual(['RRULE:FREQ=WEEKLY;COUNT=10']);
  });

  it('omits recurrenceRule for a non-recurring event', async () => {
    const { service } = makeService();
    const dto = await callTransformToEventDto(
      service,
      eventDetails(null),
      { id: 'evt-1', summary: 'One-off', status: 'confirmed' },
      'user-1',
      'conn-1',
    );

    expect(dto.metadata?.recurrenceRule).toBeUndefined();
  });
});
