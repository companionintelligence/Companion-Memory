import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Event, EventService } from '@ci/domains/memory';
import {
  EventCreatedEvent,
  EventRemovedEvent,
  EventUpdatedEvent,
  type EventCreatedPayload,
  type EventDeletedPayload,
  type EventUpdatedPayload,
} from '@ci/domains/memory/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class EventSearchIndexListener {
  constructor(
    private readonly eventService: EventService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EventSearchIndexListener.name);
  }

  @OnEvent(EventCreatedEvent, { queue: 'search-index' })
  async indexEvent(payload: EventCreatedPayload | EventUpdatedPayload) {
    this.logger.log('Adding new event to search index', {
      eventId: payload.eventId,
    });

    await this.upsertEvent(payload);
  }

  @OnEvent(EventUpdatedEvent, { queue: 'search-index' })
  async updateEvent(payload: EventCreatedPayload | EventUpdatedPayload) {
    this.logger.log('Updating event in search index', {
      eventId: payload.eventId,
    });

    await this.upsertEvent(payload);
  }

  @OnEvent(EventRemovedEvent, { queue: 'search-index' })
  async unindexEvent(payload: EventDeletedPayload) {
    this.logger.log('Removing event in search index', {
      eventId: payload.eventId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'event',
      entityId: payload.eventId,
    });

    this.logger.log('Removed embedding for event');

    await this.vectorService.remove(context, {
      entityType: 'event',
      entityId: payload.eventId,
    });

    this.logger.log('Removed tsvector for event');
  }

  private async upsertEvent(payload: EventCreatedPayload | EventUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const event = await this.eventService.findById(context, payload.eventId);

    if (event == null) {
      this.logger.warn('Event not found, skipping indexing');

      return;
    }

    if (event.userId == null) {
      this.logger.warn('Event has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(event);
    const skipReason = searchDocument == null ? 'empty' : embedSkipReason(searchDocument);

    if (!shouldEmbedType('event')) {
      this.logger.log('Event type not in embed allowlist, skipping embedding');
    } else if (skipReason != null) {
      this.logger.log('Skipping low-value event embedding', {
        eventId: event.id,
        skipReason,
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument!);

      await this.embeddingService.upsert(
        {
          userId: event.userId,
        },
        {
          entityType: 'event',
          entityId: event.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for event');
    }

    const searchEvent = this.getSearchEvent(event);

    if (searchEvent.length === 0) {
      this.logger.log('Event has no search event, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: event.userId,
        },
        {
          entityType: 'event',
          entityId: event.id,
          searchableText: searchEvent,
        },
      );

      this.logger.log('Generated tsvector for event');
    }
  }

  private getSearchEvent(event: Event): WeightedText[] {
    const parts: WeightedText[] = [];
    const displayTitle = eventDisplayTitle(event);

    if (displayTitle) {
      parts.push({ text: displayTitle, weight: 10 });
    } else if (event.title) {
      parts.push({ text: event.title, weight: 10 });
    }

    if (event.description) {
      parts.push({ text: event.description, weight: 5 });
    }

    if (event.category) {
      parts.push({ text: event.category, weight: 3 });
    }

    if (event.eventType) {
      parts.push({ text: event.eventType, weight: 3 });
    }

    if (event.locationName) {
      parts.push({ text: event.locationName, weight: 4 });
    }

    const cameraTokens = cameraSearchTokens(event);

    if (cameraTokens.length > 0) {
      parts.push({ text: cameraTokens.join(' '), weight: 4 });
    }

    const sourceTokens = sourceSystemSearchTokens(event.sourceSystem);

    if (sourceTokens.length > 0) {
      parts.push({ text: sourceTokens.join(' '), weight: 2 });
    }

    return parts;
  }

  private getSearchDocument(event: Event): string | null {
    const parts = new Set<string>();

    const push = (value: unknown) => {
      if (typeof value !== 'string') {
        return;
      }

      const normalized = value.trim();

      if (normalized.length === 0) {
        return;
      }

      parts.add(normalized);
    };

    // For media events (imported photos/videos) the raw title is a filename
    // ("DSC00838.jpg") with no semantic signal — the embedding ends up
    // representing nothing a user would search for. Substitute the human-friendly
    // "Photo · Topanga, CA · Jun 17, 2026" derived from capture time + place,
    // mirroring the frontend's eventDisplayTitle. Non-media events fall through
    // to the original title.
    push(eventDisplayTitle(event) ?? event.title ?? null);
    push(event.description ?? null);
    push(event.category ?? null);
    push(event.eventType ?? null);

    // Reverse-geocoded place name lets "photos at Topanga" hit media events that
    // would otherwise only carry a filename.
    push(event.locationName ?? null);

    // Date-fuzzy queries — "photos from June 2026", "summer 2024 photos" — need
    // the calendar names in the doc; the raw timestamp won't tokenize.
    for (const token of captureDateTokens(event.startTime)) {
      push(token);
    }

    // Source provenance expanded into searchable words so "apple photos library"
    // matches events whose sourceSystem is the snake_case importer id.
    for (const token of sourceSystemSearchTokens(event.sourceSystem)) {
      push(token);
    }

    // High-signal structured fields that capture sources (notably CI-Import-Tools)
    // record in event metadata. Without these, semantically-searchable content for
    // imported events would be limited to title/description; pulling the subject,
    // message text, track/artist, product name, camera/lens etc. makes the
    // imported memory recallable. There is no metadata schema yet, so this is a
    // curated allowlist of keys observed across importers — extend as new sources
    // land. The camera-tier keys (Make/Model/Lens/LensModel/Camera) light up
    // queries like "photos shot on the X100V" once the EXIF-capture chip lands.
    const metadata = (event.metadata ?? {}) as Record<string, unknown>;
    const candidateKeys = [
      'Subject',
      'Text',
      'Track',
      'Artist',
      'Album',
      'Product',
      'Sender',
      'Book',
      'Author',
      'Title',
      'Name',
      'Notes',
      'Make',
      'Model',
      'Lens',
      'LensModel',
      'Camera',
    ];

    for (const key of candidateKeys) {
      push(metadata[key]);
    }

    const aliases = metadata['aliases'];

    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        push(alias);
      }
    }

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}

// ---------------------------------------------------------------------------
// Search-doc enrichment helpers
//
// Exported for tests; intentionally a thin port of the frontend's
// eventDisplayTitle (frontend/apps/web/src/pages/MemoryPage/Components/utils.tsx)
// so what the UI shows and what semantic search indexes line up.
// ---------------------------------------------------------------------------

const MEDIA_FILENAME_RE =
  /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|dng|raw|cr2|nef|mp4|mov|m4v|avi|mkv|webm|3gp|mpe?g|wmv)$/i;
const VIDEO_FILENAME_RE = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mpe?g|wmv)$/i;

/**
 * Compact "City, ST" from a reverse-geocoded address, mirroring the frontend
 * `shortPlace` helper. Returns null when the address can't be confidently
 * parsed; in that case the caller falls back to the raw locationName, which is
 * still useful tokens for the embedding even if it's a full address.
 */
function shortPlace(locationName?: string | null): string | null {
  const name = locationName?.trim();

  if (!name) {
    return null;
  }

  const parts = name
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return name.length <= 28 ? name : null;
  }

  const withoutCountry = /^(usa|united states|us)$/i.test(parts[parts.length - 1])
    ? parts.slice(0, -1)
    : parts;

  const region = withoutCountry[withoutCountry.length - 1]?.replace(/\s*\d{4,}.*$/, '').trim();
  const city = withoutCountry.length >= 2 ? withoutCountry[withoutCountry.length - 2] : withoutCountry[0];

  const result = [city, region].filter(Boolean).join(', ');

  return result.length > 0 && result.length <= 28 ? result : null;
}

/**
 * Backend port of the frontend's `eventDisplayTitle`: rewrite a bare media
 * filename into "Photo · Topanga, CA · Jun 17, 2026" using capture time + place.
 * Authored titles (anything with whitespace that isn't a filename) pass
 * through. Returns null when neither path produces useful text, so the caller
 * can fall back to the raw title.
 */
export function eventDisplayTitle(event: {
  title?: string | null;
  startTime?: Date | string | null;
  locationName?: string | null;
  metadata?: Record<string, unknown> | null;
}): string | null {
  const title = event.title?.trim() ?? '';

  const mediaType = (event.metadata ?? {})['Media Type'];
  const mediaTypeStr = typeof mediaType === 'string' ? mediaType : null;

  const isMediaEvent =
    mediaTypeStr?.startsWith('image/') === true ||
    mediaTypeStr?.startsWith('video/') === true ||
    MEDIA_FILENAME_RE.test(title);

  const looksAuthored = /\s/.test(title) && !MEDIA_FILENAME_RE.test(title);

  if (title && (looksAuthored || !isMediaEvent)) {
    return title;
  }

  if (!isMediaEvent) {
    return title || null;
  }

  const isVideo = mediaTypeStr?.startsWith('video/') === true || VIDEO_FILENAME_RE.test(title);
  const noun = isVideo ? 'Video' : 'Photo';

  const place = shortPlace(event.locationName);

  const start =
    event.startTime instanceof Date ? event.startTime : event.startTime ? new Date(event.startTime) : null;
  const datePart =
    start && !isNaN(start.getTime())
      ? start.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : null;

  const derived = [noun, place, datePart].filter((part): part is string => Boolean(part)).join(' · ');

  return derived || title || noun;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Calendar tokens for the capture time — "June 2026", "summer 2026" — so
 * date-fuzzy queries match. The raw timestamp on its own won't tokenize into
 * anything a user would type. Northern-hemisphere seasons; the user corpus is
 * Pacific/US for now, and "summer" still narrows the year either way.
 */
function captureDateTokens(startTime: Date | string | null | undefined): string[] {
  if (startTime == null) {
    return [];
  }

  const date = startTime instanceof Date ? startTime : new Date(startTime);

  if (isNaN(date.getTime())) {
    return [];
  }

  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  const monthName = MONTH_NAMES[month];

  const season =
    month >= 2 && month <= 4
      ? 'spring'
      : month >= 5 && month <= 7
        ? 'summer'
        : month >= 8 && month <= 10
          ? 'autumn fall'
          : 'winter';

  return [`${monthName} ${year}`, `${season} ${year}`];
}

/** Importer-name → searchable words. "apple_photos" → "apple photos library". */
const SOURCE_SYSTEM_EXPANSIONS: Record<string, string> = {
  apple_photos: 'apple photos library',
  google_photos: 'google photos library',
  google_takeout: 'google takeout',
  gmail: 'gmail email',
  imessage: 'imessage messages',
  whatsapp: 'whatsapp messages',
  chromium: 'chrome browser history',
  chrome: 'chrome browser history',
  safari: 'safari browser history',
  firefox: 'firefox browser history',
  gpx: 'gpx location track',
  amazon: 'amazon order',
  paypal: 'paypal payment',
  venmo: 'venmo payment',
};

function sourceSystemSearchTokens(sourceSystem: string | null | undefined): string[] {
  if (!sourceSystem) {
    return [];
  }

  const key = sourceSystem.toLowerCase();
  const expansion = SOURCE_SYSTEM_EXPANSIONS[key];

  if (expansion) {
    return [expansion];
  }

  const humanized = key.replace(/[_-]+/g, ' ').trim();

  return humanized.length > 0 ? [humanized] : [];
}

function cameraSearchTokens(event: { metadata?: Record<string, unknown> | null }): string[] {
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const tokens: string[] = [];

  for (const key of ['Make', 'Model', 'Lens', 'LensModel', 'Camera']) {
    const value = metadata[key];

    if (typeof value === 'string' && value.trim().length > 0) {
      tokens.push(value.trim());
    }
  }

  return tokens;
}
