import {
  CaptureContextService,
  type CaptureExif,
  parseOffsetMinutes,
  wallClockToInstant,
} from '../CaptureContextService';

const USER = { userId: 'user-1' };
const FILE_ID = 'file-1';
const BYTES = Buffer.from('jpeg');

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** The service with its EXIF read replaced by a fixed bag — no crafted JPEGs. */
function makeService(
  exif: CaptureExif | null,
  deps: {
    places?: Array<{ name: string | null }>;
    positions?: Array<Record<string, unknown>>;
    events?: Array<{ startTime: Date; locationName: string | null }>;
    geocode?: { status: string; placeName: string | null };
    failing?: Array<'places' | 'positions' | 'events' | 'geocode'>;
  } = {},
) {
  const failing = new Set(deps.failing ?? []);
  const reject = (name: string) => jest.fn(async () => Promise.reject(new Error(`${name} down`)));
  const placeService = {
    placesNear: failing.has('places') ? reject('places') : jest.fn(async () => deps.places ?? []),
  };
  const positionService = {
    findByDateRange: failing.has('positions')
      ? reject('positions')
      : jest.fn(async () => deps.positions ?? []),
  };
  const calendarEventService = {
    findInRange: failing.has('events') ? reject('events') : jest.fn(async () => deps.events ?? []),
  };
  const geocodeService = {
    reverseGeocode: failing.has('geocode')
      ? reject('geocode')
      : jest.fn(async () => deps.geocode ?? { status: 'ZERO_RESULTS', placeName: null }),
  };
  const logger = makeLogger();

  class Stubbed extends CaptureContextService {
    protected override async readExif(): Promise<CaptureExif | null> {
      return exif;
    }
  }

  const service = new Stubbed(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    placeService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    positionService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    calendarEventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    geocodeService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, placeService, positionService, calendarEventService, geocodeService, logger };
}

const TAKEN_AT = new Date('2024-05-05T08:12:55.000Z');
const DATED: CaptureExif = {
  takenAt: TAKEN_AT,
  zoneKnown: true,
  takenOn: '2024-05-05',
  latitude: null,
  longitude: null,
};
const LOCATED: CaptureExif = { ...DATED, latitude: 38.1146, longitude: 13.3562 };

describe('CaptureContextService', () => {
  it('yields nothing for a photo with neither a capture time nor coordinates', async () => {
    const { service, positionService } = makeService(null);

    await expect(service.build(USER, BYTES, FILE_ID)).resolves.toBeNull();
    expect(positionService.findByDateRange).not.toHaveBeenCalled();
  });

  it('names the spot from the photo’s own GPS via the user’s nearest place first', async () => {
    const { service, geocodeService } = makeService(LOCATED, { places: [{ name: 'Cattedrale di Palermo' }] });

    const context = await service.build(USER, BYTES, FILE_ID);

    expect(context).toMatchObject({ source: 'exif-gps' });
    expect(context?.text).toContain('taken on 2024-05-05');
    expect(context?.text).toContain("The photo's GPS places it at Cattedrale di Palermo.");
    expect(context?.text).toContain('it says where the owner was, not what the photo shows');
    // The metered provider is never asked when the user's own places answer.
    expect(geocodeService.reverseGeocode).not.toHaveBeenCalled();
  });

  it('falls back to a reverse geocode when no place of the user’s is near the GPS point', async () => {
    const { service, geocodeService } = makeService(LOCATED, {
      geocode: { status: 'OK', placeName: 'Palermo, Sicily, Italy' },
    });

    const context = await service.build(USER, BYTES, FILE_ID);

    expect(context?.source).toBe('exif-gps');
    expect(context?.text).toContain('GPS places it at Palermo, Sicily, Italy');
    expect(geocodeService.reverseGeocode).toHaveBeenCalledWith(38.1146, 13.3562);
  });

  it('uses the nearest position fix around the shutter time, preferring its geocoded columns', async () => {
    const far = { time: new Date(TAKEN_AT.getTime() - 3 * 60 * 60 * 1000), city: 'Cefalù', country: 'Italy' };
    const near = {
      time: new Date(TAKEN_AT.getTime() + 25 * 60 * 1000),
      city: 'Palermo',
      region: 'Sicily',
      country: 'Italy',
    };
    const { service, positionService } = makeService(DATED, { positions: [far, near] });

    const context = await service.build(USER, BYTES, FILE_ID);

    expect(context?.source).toBe('position');
    expect(context?.text).toContain(
      'location history puts them at Palermo, Sicily, Italy within about 25 minutes of the shutter time',
    );
    const [, from, to] = positionService.findByDateRange.mock.calls[0] as unknown as [unknown, Date, Date];
    expect(to.getTime() - from.getTime()).toBe(12 * 60 * 60 * 1000);
  });

  it('names an un-geocoded position fix through the same place-then-geocode lookup', async () => {
    const fix = { time: TAKEN_AT, location: { type: 'Point', coordinates: [13.3562, 38.1146] } };
    const { service, placeService } = makeService(DATED, {
      positions: [fix],
      places: [{ name: 'Palermo Cathedral' }],
    });

    const context = await service.build(USER, BYTES, FILE_ID);

    expect(context?.source).toBe('position');
    expect(context?.text).toContain('puts them at Palermo Cathedral at that moment');
    expect(placeService.placesNear).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ lat: 38.1146, lng: 13.3562 }),
    );
  });

  it('falls back to nearby calendar locations, nearest first and de-duplicated, capped at three', async () => {
    const day = 24 * 60 * 60 * 1000;
    const events = [
      {
        startTime: new Date(TAKEN_AT.getTime() + 2 * day),
        locationName: 'Beccafico, Via Polara, 24, 90138 Palermo',
      },
      { startTime: new Date(TAKEN_AT.getTime() - 3 * day), locationName: 'Ristorante Vomero, Naples' },
      {
        startTime: new Date(TAKEN_AT.getTime() + 2 * day + 1000),
        locationName: 'Beccafico, Via Polara, 24, 90138 Palermo',
      },
      { startTime: new Date(TAKEN_AT.getTime() - 1 * day), locationName: null },
      { startTime: new Date(TAKEN_AT.getTime() - 2 * day), locationName: 'Hotel, Cefalù' },
      { startTime: new Date(TAKEN_AT.getTime() + 3 * day), locationName: 'Airport, Catania' },
    ];
    const { service } = makeService(DATED, { events });

    const context = await service.build(USER, BYTES, FILE_ID);

    expect(context?.source).toBe('events');
    expect(context?.text).toContain(
      '2024-05-07: Beccafico, Via Polara, 24, 90138 Palermo; 2024-05-03: Hotel, Cefalù; 2024-05-02: Ristorante Vomero, Naples',
    );
    expect(context?.text).not.toContain('Catania');
  });

  it('keeps the date when no source can place the photo', async () => {
    const { service } = makeService(DATED);

    await expect(service.build(USER, BYTES, FILE_ID)).resolves.toEqual({
      text: 'Context: the photo was taken on 2024-05-05.',
      source: 'date-only',
    });
  });

  it('degrades rung by rung when a lookup throws, and never fails the description', async () => {
    const { service, logger } = makeService(LOCATED, {
      failing: ['places', 'geocode', 'positions'],
      events: [{ startTime: TAKEN_AT, locationName: 'Palermo' }],
    });

    const context = await service.build(USER, BYTES, FILE_ID);

    expect(context?.source).toBe('events');
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});

describe('EXIF clock helpers', () => {
  it('parses camera zone offsets', () => {
    expect(parseOffsetMinutes('+02:00')).toBe(120);
    expect(parseOffsetMinutes('-0700')).toBe(-420);
    expect(parseOffsetMinutes('Z')).toBe(0);
    expect(parseOffsetMinutes('+15:00')).toBeNull();
    expect(parseOffsetMinutes(undefined)).toBeNull();
  });

  it('turns exifr’s local-zone wall clock into the camera’s instant', () => {
    // exifr revives "2024:05:05 10:12:55" as local 10:12:55; with the camera in +02:00 that is 08:12:55Z.
    const wallClock = new Date(2024, 4, 5, 10, 12, 55);
    expect(wallClockToInstant(wallClock, 120).toISOString()).toBe('2024-05-05T08:12:55.000Z');
    // No offset tag: assumed UTC, which the lookup windows tolerate.
    expect(wallClockToInstant(wallClock, null).toISOString()).toBe('2024-05-05T10:12:55.000Z');
  });
});
