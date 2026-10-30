import { Injectable } from '@nestjs/common';
import exifr from 'exifr';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { GeocodeService } from '@ci/domains/geocode';
import { CalendarEventService, PlaceService } from '@ci/domains/memory';
import { PositionService } from '@ci/domains/position';

/**
 * Where and when a photo was taken, as one short sentence a vision model can
 * lean on — built from what the APPLIANCE knows, never from what the model
 * guesses.
 *
 * Why this exists, measured 2026-09-16 on qwen3.8:27b: a 200 MP shot of
 * Palermo Cathedral (no GPS in its EXIF, only a capture date) was titled
 * "Cuenca Cathedral", "Toledo Cathedral", "Granada Cathedral", "León
 * Cathedral" and — by the live pipeline — "Barcelona Cathedral" across six
 * runs, at every resolution and prompt length. The 21 other photos from the
 * same day carried titles naming five different cities. The model does not
 * know and guesses anyway, and a wrong city in a searchable title is worse
 * than none. The appliance, meanwhile, had a dinner reservation in Palermo
 * two days later and a week of messages about being there. Handed one line
 * of that ("the owner's calendar and messages place them in Palermo, Sicily
 * that week"), the same model said "Palermo Cathedral" four times out of
 * four, for ~100 extra prompt tokens.
 *
 * Source ladder, most to least direct — the first rung that yields a place
 * wins, and nothing is invented to fill a gap:
 *
 *  1. EXIF GPS on the photo itself → the nearest of the user's own Place
 *     entities within {@link PLACE_MATCH_RADIUS_METERS} (free, and it is the
 *     name the user already uses for the spot), else a reverse geocode
 *     through {@link GeocodeService} (cache-aware, provider-metered — the
 *     same path `enrich.position.reverse` already takes for track points).
 *  2. No GPS but an EXIF capture time → the user's nearest position fix
 *     within ±{@link POSITION_WINDOW_HOURS}: its geocoded city/region/country
 *     columns when the reverse stage has filled them, else the same
 *     place-then-geocode lookup on the fix's coordinates.
 *  3. Still nothing but a capture time → calendar events with a location
 *     name within ±{@link EVENT_WINDOW_DAYS}, nearest first, up to
 *     {@link MAX_EVENT_HINTS}. Weaker: it says where the owner had plans,
 *     not where they stood — which is why the prompt marks the whole context
 *     as "where the owner was, not what the photo shows".
 *
 * The same hint given to an UNRELATED photo (a goat pasture, with the Palermo
 * line attached on purpose) made the long-form description write "likely in
 * Italy" once. So the context is only ever built from THIS photo's own EXIF
 * date and coordinates — never inherited from a sibling, an album or the
 * import batch — and a photo with neither gets no context at all.
 */
export interface CaptureContext {
  /** The prompt paragraph, without a trailing newline. */
  text: string;
  /** Which rung produced the place, for the job log. */
  source: 'exif-gps' | 'position' | 'events' | 'date-only';
}

/** What the context line calls the file: fixes "taken" vs "recorded" and "photo" vs "video". */
export type CaptureSubject = 'photo' | 'video';

/**
 * Parsed from the photo's own EXIF — or, for a video, mapped from its
 * container tags by the caller; every field is absent when the tag is.
 */
export interface CaptureExif {
  /** The camera's wall-clock instant, resolved to UTC when an offset tag was present. */
  takenAt: Date | null;
  /** True when an OffsetTime* tag fixed the zone; false means `takenAt` assumed UTC. */
  zoneKnown: boolean;
  /** `YYYY-MM-DD` as the camera's clock read it — the day the owner would say the photo is from. */
  takenOn: string | null;
  latitude: number | null;
  longitude: number | null;
}

export const PLACE_MATCH_RADIUS_METERS = 250;
export const POSITION_WINDOW_HOURS = 6;
export const EVENT_WINDOW_DAYS = 3;
export const MAX_EVENT_HINTS = 3;
/** exifr on a corrupt file can spin; the description job must not hang on metadata. */
const EXIF_TIMEOUT_MS = 5_000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const EXIF_TAGS = [
  'DateTimeOriginal',
  'CreateDate',
  'OffsetTimeOriginal',
  'OffsetTimeDigitized',
  'GPSLatitude',
  'GPSLongitude',
  'GPSLatitudeRef',
  'GPSLongitudeRef',
];

@Injectable()
export class CaptureContextService {
  constructor(
    private readonly placeService: PlaceService,
    private readonly positionService: PositionService,
    private readonly calendarEventService: CalendarEventService,
    private readonly geocodeService: GeocodeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CaptureContextService.name);
  }

  /**
   * The context paragraph for one photo, or null when its EXIF carries neither
   * a capture time nor coordinates (a screenshot, a stripped download, a
   * preview-only file). Every lookup failure degrades to the next rung and is
   * logged at warn, never thrown: a missing hint costs a possibly-wrong city
   * name, a thrown one costs the whole description.
   */
  async build(
    context: UserServiceContext,
    originalBytes: Buffer,
    fileId: string,
  ): Promise<CaptureContext | null> {
    const exif = await this.readExif(originalBytes);

    if (exif == null) {
      return null;
    }

    return this.buildFromCapture(context, exif, fileId, 'photo');
  }

  /**
   * The same paragraph from capture facts the caller already has — a video's
   * container tags, which are not EXIF and are read by the frame sampler
   * alongside the frames. Same rungs, same guard against a file that says
   * neither when nor where; only the wording changes with `subject`.
   */
  async buildFromCapture(
    context: UserServiceContext,
    exif: CaptureExif,
    fileId: string,
    subject: CaptureSubject = 'photo',
  ): Promise<CaptureContext | null> {
    if (exif.takenAt == null && exif.latitude == null) {
      return null;
    }

    const verb = subject === 'video' ? 'recorded' : 'taken';
    const when = describeWhen(exif);
    const where = await this.describeWhere(context, exif, fileId, subject);

    if (where == null) {
      if (when == null) {
        return null;
      }

      return { text: `Context: the ${subject} was ${verb} ${when}.`, source: 'date-only' };
    }

    const text =
      `Context: the ${subject} was ${verb} ${when ?? 'on an unknown date'}. ${where.sentence} ` +
      `Use this only if it fits what is visible; it says where the owner was, not what the ${subject} shows.`;

    return { text, source: where.source };
  }

  private async describeWhere(
    context: UserServiceContext,
    exif: CaptureExif,
    fileId: string,
    subject: CaptureSubject,
  ): Promise<{ sentence: string; source: CaptureContext['source'] } | null> {
    // Rung 1: the file's own coordinates.
    if (exif.latitude != null && exif.longitude != null) {
      const name = await this.placeNameFor(context, exif.latitude, exif.longitude, fileId);

      if (name != null) {
        return { sentence: `The ${subject}'s GPS places it at ${name}.`, source: 'exif-gps' };
      }
    }

    if (exif.takenAt == null) {
      return null;
    }

    // Rung 2: where the owner's device was around the shutter time.
    const fix = await this.nearestPositionFix(context, exif.takenAt, fileId);

    if (fix != null) {
      const gap = describeGap(fix.gapMs);
      const fromColumns = joinPresent([fix.name, fix.city, fix.region, fix.country]);
      const name =
        fromColumns ??
        (fix.latitude != null && fix.longitude != null
          ? await this.placeNameFor(context, fix.latitude, fix.longitude, fileId)
          : null);

      if (name != null) {
        return {
          sentence: `The owner's location history puts them at ${name} ${gap}.`,
          source: 'position',
        };
      }
    }

    // Rung 3: calendar entries with a location, around the same days.
    const hints = await this.eventHints(context, exif.takenAt, fileId);

    if (hints.length > 0) {
      const list = hints.map((hint) => `${hint.on}: ${hint.location}`).join('; ');

      return {
        sentence: `The owner's calendar has entries nearby in time at these locations — ${list}.`,
        source: 'events',
      };
    }

    return null;
  }

  /**
   * A human name for a coordinate: the user's own nearest Place entity first
   * (free, already the name they know it by), then a reverse geocode. A
   * provider outage or a missing provider reads as "no name", not an error.
   */
  private async placeNameFor(
    context: UserServiceContext,
    latitude: number,
    longitude: number,
    fileId: string,
  ): Promise<string | null> {
    try {
      const [nearest] = await this.placeService.placesNear(context, {
        lat: latitude,
        lng: longitude,
        radiusMeters: PLACE_MATCH_RADIUS_METERS,
        limit: 1,
      });

      if (nearest?.name) {
        return nearest.name;
      }
    } catch (error: unknown) {
      this.logger.warn('Capture context: place lookup failed; trying reverse geocode', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const outcome = await this.geocodeService.reverseGeocode(latitude, longitude);

      if (outcome.status === 'OK' && outcome.placeName) {
        return outcome.placeName;
      }
    } catch (error: unknown) {
      this.logger.warn('Capture context: reverse geocode failed; continuing without a place name', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  private async nearestPositionFix(
    context: UserServiceContext,
    takenAt: Date,
    fileId: string,
  ): Promise<{
    gapMs: number;
    latitude: number | null;
    longitude: number | null;
    name: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
  } | null> {
    try {
      const window = POSITION_WINDOW_HOURS * HOUR_MS;
      const fixes = await this.positionService.findByDateRange(
        context,
        new Date(takenAt.getTime() - window),
        new Date(takenAt.getTime() + window),
      );

      let best: (typeof fixes)[number] | null = null;
      let bestGap = Number.POSITIVE_INFINITY;

      for (const fix of fixes) {
        const gap = Math.abs(new Date(fix.time).getTime() - takenAt.getTime());

        if (gap < bestGap) {
          best = fix;
          bestGap = gap;
        }
      }

      if (best == null) {
        return null;
      }

      const coordinates = best.location?.coordinates;

      return {
        gapMs: bestGap,
        longitude: typeof coordinates?.[0] === 'number' ? coordinates[0] : null,
        latitude: typeof coordinates?.[1] === 'number' ? coordinates[1] : null,
        name: best.name ?? null,
        city: best.city ?? null,
        region: best.region ?? null,
        country: best.country ?? null,
      };
    } catch (error: unknown) {
      this.logger.warn('Capture context: position lookup failed; trying calendar events', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
  }

  private async eventHints(
    context: UserServiceContext,
    takenAt: Date,
    fileId: string,
  ): Promise<Array<{ on: string; location: string }>> {
    try {
      const window = EVENT_WINDOW_DAYS * DAY_MS;
      const events = await this.calendarEventService.findInRange(
        context,
        new Date(takenAt.getTime() - window),
        new Date(takenAt.getTime() + window),
      );

      const located = events
        .filter((event) => typeof event.locationName === 'string' && event.locationName.trim() !== '')
        .map((event) => ({
          gap: Math.abs(new Date(event.startTime).getTime() - takenAt.getTime()),
          on: isoDate(new Date(event.startTime)),
          location: event.locationName!.trim(),
        }))
        .sort((a, b) => a.gap - b.gap);

      const seen = new Set<string>();
      const hints: Array<{ on: string; location: string }> = [];

      for (const candidate of located) {
        if (seen.has(candidate.location)) {
          continue;
        }

        seen.add(candidate.location);
        hints.push({ on: candidate.on, location: candidate.location });

        if (hints.length >= MAX_EVENT_HINTS) {
          break;
        }
      }

      return hints;
    } catch (error: unknown) {
      this.logger.warn('Capture context: calendar lookup failed; continuing without a place', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }

  /**
   * The photo's own EXIF, or null when there is none worth reading. Kept as a
   * method so tests hand in a parsed bag instead of a crafted JPEG.
   *
   * exifr revives the zone-less EXIF wall-clock as a Date in this process's
   * local zone (the same quirk `common/media/exif.ts` documents), so the
   * calendar day is read back through the local getters, and the instant is
   * rebuilt from those components against the OffsetTime* tag when the camera
   * recorded one — otherwise UTC is assumed, which the ±6 h position window
   * and ±3 day event window both tolerate.
   */
  protected async readExif(bytes: Buffer): Promise<CaptureExif | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const parsed: unknown = await Promise.race([
        exifr.parse(bytes, { pick: EXIF_TAGS, gps: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('exif-timeout')), EXIF_TIMEOUT_MS);
        }),
      ]);

      if (parsed == null || typeof parsed !== 'object') {
        return null;
      }

      const bag = parsed as Record<string, unknown>;
      const wallClock = firstDate(bag.DateTimeOriginal, bag.CreateDate);
      const offsetMinutes = parseOffsetMinutes(
        bag.DateTimeOriginal instanceof Date ? bag.OffsetTimeOriginal : bag.OffsetTimeDigitized,
      );
      const latitude = finiteOrNull(bag.latitude);
      const longitude = finiteOrNull(bag.longitude);

      if (wallClock == null && latitude == null) {
        return null;
      }

      return {
        takenAt: wallClock == null ? null : wallClockToInstant(wallClock, offsetMinutes),
        zoneKnown: offsetMinutes != null,
        takenOn: wallClock == null ? null : localIsoDate(wallClock),
        latitude,
        longitude,
      };
    } catch (error: unknown) {
      this.logger.debug('Capture context: EXIF unreadable; describing without context', {
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

function describeWhen(exif: CaptureExif): string | null {
  return exif.takenOn == null ? null : `on ${exif.takenOn}`;
}

function describeGap(gapMs: number): string {
  const minutes = Math.round(gapMs / 60_000);

  if (minutes < 2) {
    return 'at that moment';
  }

  if (minutes < 90) {
    return `within about ${minutes} minutes of the shutter time`;
  }

  return `within about ${Math.round(minutes / 60)} hours of the shutter time`;
}

function joinPresent(parts: Array<string | null | undefined>): string | null {
  const present: string[] = [];

  for (const part of parts) {
    const trimmed = part?.trim();

    if (trimmed && !present.includes(trimmed)) {
      present.push(trimmed);
    }
  }

  return present.length === 0 ? null : present.join(', ');
}

function firstDate(...candidates: unknown[]): Date | null {
  for (const candidate of candidates) {
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
      return candidate;
    }
  }

  return null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `+02:00` / `-0700` / `Z` → minutes east of UTC; anything else → null. */
export function parseOffsetMinutes(offset: unknown): number | null {
  if (typeof offset !== 'string') {
    return null;
  }

  const trimmed = offset.trim();

  if (trimmed === 'Z') {
    return 0;
  }

  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(trimmed);

  if (match == null) {
    return null;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);

  if (hours > 14 || minutes > 59) {
    return null;
  }

  return sign * (hours * 60 + minutes);
}

/** The instant for a wall clock exifr revived in local time, given the camera's zone offset (or none). */
export function wallClockToInstant(wallClock: Date, offsetMinutes: number | null): Date {
  const asUtc = Date.UTC(
    wallClock.getFullYear(),
    wallClock.getMonth(),
    wallClock.getDate(),
    wallClock.getHours(),
    wallClock.getMinutes(),
    wallClock.getSeconds(),
  );

  return new Date(asUtc - (offsetMinutes ?? 0) * 60_000);
}

function localIsoDate(wallClock: Date): string {
  const month = String(wallClock.getMonth() + 1).padStart(2, '0');
  const day = String(wallClock.getDate()).padStart(2, '0');

  return `${wallClock.getFullYear()}-${month}-${day}`;
}

function isoDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
