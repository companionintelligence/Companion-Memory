import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { extractMediaMetadata, type MediaMetadata } from '@ci/common/media/exif';
import { OnEvent } from '@ci/domains/events';
import {
  FileService as FileStorageService,
  FileUploadedEvent,
  type FileUploadedPayload,
  type SignedFile as StoredFile,
} from '@ci/domains/files';
// The same EXIF / container reader the archive importers use. It lives in
// common rather than the import domain because this domain needs it too and
// the import barrel depends on memory — importing it from there would cycle.

import type { Content } from '../entities/ContentEntity';
import { FEDERATED_SYSTEMS, fileIdentity, platformIdentity, type SourceIdentity } from '../identity';
import { CalendarEventService } from '../services/CalendarEventService';
import { ContentService } from '../services/ContentService';
import type { CreateContentDto, CreateEventDto } from '../types';

/** Where the content/event writes for a memory capture run, off the shared default queue. */
export const MEMORY_CAPTURE_CONTENT_QUEUE = 'memory-capture-content';

/**
 * The `source_type` (the MECHANISM — see SourceSystemService) of a row the
 * user captured on a device and saved to Memory themselves, as opposed to one
 * an import or a connection delivered.
 */
export const CAPTURE_SOURCE_TYPE = 'capture';

/** The event shape imported photos use (`event_type` / `category`), so a capture lands beside them. */
export const CAPTURE_EVENT_TYPE = 'media';
export const CAPTURE_EVENT_CATEGORY = 'capture';

/** Mimetypes whose content row is `media` (a picture, a clip, a recording); everything else is `file`. */
const MEDIA_MIME_RE = /^(image|video|audio)\//i;

/** Where the taken-at came from. Recorded on the event's metadata as `Timestamp Source`, as the importers do. */
export type CaptureTimestampSource = 'EXIF' | 'Container' | 'Device';

/** When the media was made, and how that is known. */
export interface CaptureTakenAt {
  at: Date;
  source: CaptureTimestampSource;
}

/**
 * Catalogues a phone capture: a `ci.content` row, and a `media` event when
 * there is an honest date to put it at.
 *
 * An upload creates a `ci.files` row and the graph File node that shadows it
 * (memory/services/FileService). Nothing on that path makes content or an
 * event: every file-backed content row the appliance holds was minted by the
 * import pipeline's media stage, and every `media` event by the import push,
 * so a photo, clip or recording saved through the phone's Capture sheet
 * landed as a bare File — browsable only when the What picker includes
 * Files, absent from the Content library, and nowhere on the timeline. The
 * user who just tapped "Save to Memory" expected a memory, not a storage row.
 *
 * Only a deliberate capture is catalogued (`memoryCapture` on the event). A
 * chat attachment is a question's exhibit, not a memory; a CI-Capture
 * screenshot already hangs off its event through `captureTickId`.
 *
 * ── The date rule ──
 *
 * A `media` event asserts when the media was MADE, and that is the only date
 * it may carry (the Facebook post-time events were removed for exactly this).
 * In order of trust:
 *
 *   1. The bytes themselves — EXIF `DateTimeOriginal` for a photo, the
 *      container's creation time for a clip — read by the same
 *      `extractMediaMetadata` the archive importers use. GPS comes along.
 *   2. The device's own capture moment (`capturedAt`), which the phone sends
 *      ONLY for media its camera or recorder just produced. For those the
 *      upload moment and the taken-at are the same fact. A recording has no
 *      embedded date, so this is how audio is dated at all.
 *   3. Neither — a library pick of an old, stripped file. Content only, no
 *      event, exactly as the importers treat an archive file with no date:
 *      a row on the timeline at the wrong day is worse than none.
 *
 * Identity is the bytes: `fileIdentity(sha256)`, the same federated `file`
 * kind the media stage stamps, so a photo captured here and later delivered
 * by a connection or an export converges on one row instead of forking.
 * Both services find-or-create on that triple, which is also what makes a
 * re-fired event (a dedup hit on a second upload of the same bytes) a no-op
 * rather than a duplicate.
 */
@Injectable()
export class CaptureContentListener {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: CalendarEventService,
    private readonly fileStorageService: FileStorageService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CaptureContentListener.name);
  }

  @OnEvent(FileUploadedEvent, { queue: MEMORY_CAPTURE_CONTENT_QUEUE })
  async handleFileUploaded(payload: FileUploadedPayload): Promise<void> {
    if (!payload.memoryCapture) {
      return;
    }

    await this.catalogue(payload);
  }

  /** Public so a test, or a backfill, can catalogue one upload without an event. */
  async catalogue(
    payload: Pick<FileUploadedPayload, 'fileId' | 'userId' | 'capturedAt'>,
  ): Promise<{ content: Content; eventId: string | null } | null> {
    const context = { userId: payload.userId };
    const file = await this.fileStorageService.findById(context, payload.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping content row for capture', { fileId: payload.fileId });

      return null;
    }

    const media = await this.readMediaMetadata(context, file);
    const takenAt = resolveTakenAt(media, payload.capturedAt);
    let eventId: string | null = null;

    if (takenAt) {
      const [event] = await this.eventService.create(context, captureEventInput(file, takenAt, media));

      eventId = event?.id ?? null;
    } else {
      // Loud enough to see in a dev log: a recording with no capturedAt is the
      // phone not sending its moment, which is a client bug, not a dateless file.
      this.logger.log('Capture has no taken-at; content only', {
        fileId: file.id,
        contentType: file.contentType,
        capturedAt: payload.capturedAt ?? null,
      });
    }

    const [content] = await this.contentService.create(context, captureContentInput(file, eventId));

    return content ? { content, eventId } : null;
  }

  /**
   * The taken-at and GPS embedded in the stored bytes, for a photo or a clip.
   * Spooled to a temp file because the container probe (ffprobe) needs to
   * seek. Anything else (a recording, a document) has no reader and returns
   * null without touching the store; a read or parse failure also returns
   * null, logged — a capture must still be catalogued when its EXIF is odd.
   */
  private async readMediaMetadata(
    context: { userId: string },
    file: StoredFile,
  ): Promise<MediaMetadata | null> {
    const contentType = file.contentType || '';

    if (!file.key || !/^(image|video)\//i.test(contentType)) {
      return null;
    }

    const tempInput = join(tmpdir(), `ci-capture-${randomUUID()}`);

    try {
      const stream = await this.fileStorageService.getFileStream(context, file.key);

      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(tempInput);
        stream.pipe(ws);
        stream.on('error', reject);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });

      return await extractMediaMetadata(tempInput, contentType);
    } catch (err: unknown) {
      this.logger.warn('Could not read capture metadata; dating from the device instead', {
        fileId: file.id,
        error: err instanceof Error ? err.message : String(err),
      });

      return null;
    } finally {
      await fs.unlink(tempInput).catch(() => {});
    }
  }
}

/** The date rule in the class doc, as a function. Exported for tests. */
export function resolveTakenAt(
  media: MediaMetadata | null,
  capturedAt: string | undefined,
): CaptureTakenAt | null {
  const embedded = media?.timestamp;

  if (embedded instanceof Date && !Number.isNaN(embedded.getTime())) {
    const isContainer = 'Duration' in (media?.metadata ?? {}) || 'Codec' in (media?.metadata ?? {});

    return { at: embedded, source: isContainer ? 'Container' : 'EXIF' };
  }

  if (capturedAt) {
    const parsed = new Date(capturedAt);

    if (!Number.isNaN(parsed.getTime())) {
      return { at: parsed, source: 'Device' };
    }
  }

  return null;
}

/**
 * The identity a captured file's rows key on. The bytes' SHA-256 when the
 * store recorded one (always, for an upload that went through
 * `FileService.getFileHash`); the file's own id under the same kind otherwise,
 * so the rows are still stable across a re-fired event rather than duplicated.
 */
function captureIdentity(file: StoredFile): SourceIdentity {
  if (file.hash) {
    return fileIdentity(file.hash);
  }

  return platformIdentity(FEDERATED_SYSTEMS.file, 'id', file.id);
}

/** `capture.photo` / `capture.video` / `capture.audio` / `capture.file` — the importers' kind vocabulary. */
export function captureKind(contentType: string | null | undefined): string {
  const type = (contentType ?? '').split('/')[0].toLowerCase();

  return `capture.${type === 'image' ? 'photo' : type === 'video' || type === 'audio' ? type : 'file'}`;
}

/** The `media` event that dates one captured file. Exported for tests. */
export function captureEventInput(
  file: StoredFile,
  takenAt: CaptureTakenAt,
  media: MediaMetadata | null,
): CreateEventDto {
  const identity = captureIdentity(file);
  const kind = captureKind(file.contentType);
  const metadata: Record<string, unknown> = {
    ...(media?.metadata ?? {}),
    kind,
    FileId: file.id,
    'Timestamp Source': takenAt.source,
  };

  if (file.filename) {
    metadata.Title = file.filename;
  }

  if (file.hash) {
    metadata.contentHash = file.hash;
  }

  const input: CreateEventDto = {
    title: file.filename ?? kind,
    start_time: takenAt.at,
    event_type: CAPTURE_EVENT_TYPE,
    category: CAPTURE_EVENT_CATEGORY,
    metadata,
    source_type: CAPTURE_SOURCE_TYPE,
    source_system: identity.system,
    source_id: identity.id,
  };

  if (media?.location) {
    input.location_coordinates = {
      type: 'Point',
      coordinates: [media.location.longitude, media.location.latitude],
    };
    metadata.locationSource = 'exif';

    if (media.accuracyMeters != null) {
      metadata.accuracyMeters = media.accuracyMeters;
    }
  }

  return input;
}

/** The `ci.content` row that catalogues one captured file. Exported for tests. */
export function captureContentInput(file: StoredFile, eventId: string | null = null): CreateContentDto {
  const identity = captureIdentity(file);
  const mimetype = file.contentType || undefined;
  const input: CreateContentDto = {
    type: mimetype && MEDIA_MIME_RE.test(mimetype) ? 'media' : 'file',
    external_id: file.id,
    external_id_kind: 'file',
    source_type: CAPTURE_SOURCE_TYPE,
    source_system: identity.system,
    source_id: identity.id,
  };

  if (file.filename) {
    input.title = file.filename;
  }

  if (mimetype) {
    input.mimetype = mimetype;
  }

  if (eventId) {
    input.event = { id: eventId };
  }

  return input;
}
