import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import plimit from 'p-limit';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import { FileEntity } from '../entities/FileEntity';
import { MediaDimensionsBackfillRequestEvent, type MediaDimensionsBackfillRequestPayload } from '../events';
import { FileService } from '../services/FileService';
import { MediaDimensions, MediaDimensionsService } from '../services/MediaDimensionsService';
import { FileVariant } from '../types';

/** Dedicated PGBoss queue so the dimensions backfill doesn't block the default queue. */
export const MEDIA_DIMENSIONS_QUEUE = 'media-dimensions';

const IMAGE_MIME_PREFIX = 'image/';

/**
 * Files probed at once. Each probe is an object-storage read plus a sharp /
 * ffprobe decode (video spools to a temp file), so keep the fan-out modest.
 */
const MAX_CONCURRENCY = 4;

/** Rows pulled per keyset page; bounds the in-memory working set. */
const PAGE_SIZE = 100;

/** Files processed per enqueue when the request omits an explicit limit. */
const DEFAULT_LIMIT = 500;

interface CandidateRow {
  id: string;
  key: string;
  content_type: string;
}

/**
 * Consumes {@link MediaDimensionsBackfillRequestEvent}: records
 * `ci.files.width`/`height` for ORIGINAL image/video files that still lack them.
 *
 * Dimensions weren't captured at ingest for the existing corpus (~18.8k files),
 * so {@link EventMediaLoader} / `EventType.mediaWidth`/`mediaHeight` resolve null
 * for every media event. This streams each original from object storage, probes
 * its dimensions via {@link MediaDimensionsService} (image header / ffprobe), and
 * writes them back through {@link FileService.setDimensions} (a targeted write —
 * no re-index fan-out).
 *
 * Batched + resumable, mirroring the geocode backfill: it keyset-pages over the
 * candidate set (`width IS NULL`) up to `limit` files per run, with bounded
 * concurrency. A populated row drops out of the candidate filter, so re-running
 * only picks up what's still missing. Files whose dimensions can't be read
 * (corrupt / unsupported codec) stay NULL and are counted as `skipped`.
 */
@Injectable()
export class MediaDimensionsBackfillListener {
  private readonly limiter = plimit(MAX_CONCURRENCY);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly fileService: FileService,
    private readonly mediaDimensionsService: MediaDimensionsService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MediaDimensionsBackfillListener.name);
  }

  @OnEvent(MediaDimensionsBackfillRequestEvent, { queue: MEDIA_DIMENSIONS_QUEUE })
  async handleBatch(payload: MediaDimensionsBackfillRequestPayload): Promise<void> {
    const { userId } = payload;
    const context: UserServiceContext = { userId };
    const cap = payload.limit ?? DEFAULT_LIMIT;

    this.logger.log('Starting media-dimensions backfill batch', { userId, limit: cap });

    let after: string | null = null;
    let processed = 0;
    let resolved = 0;
    let skipped = 0;
    let failed = 0;

    while (processed < cap) {
      const pageSize = Math.min(PAGE_SIZE, cap - processed);
      const rows = await this.selectCandidates(userId, after, pageSize);

      if (rows.length === 0) {
        break;
      }

      await Promise.all(
        rows.map((row) =>
          this.limiter(async () => {
            try {
              const dimensions = await this.probe(context, row);

              if (dimensions == null) {
                // Unreadable header / unsupported codec — left NULL for a future
                // pass (e.g. once HEIC support lands) rather than written as 0.
                skipped++;

                return;
              }

              await this.fileService.setDimensions(context, row.id, dimensions);
              resolved++;
            } catch (err) {
              failed++;
              this.logger.warn('Failed to backfill dimensions for file', {
                fileId: row.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        ),
      );

      processed += rows.length;
      // Advance the keyset cursor past this page. Resolved rows drop out of the
      // candidate filter; advancing the cursor steps over rows left NULL this
      // run (corrupt files) so they don't stall progress within the batch.
      after = rows[rows.length - 1].id;
    }

    this.logger.log('Completed media-dimensions backfill batch', {
      userId,
      processed,
      resolved,
      skipped,
      failed,
    });
  }

  /** Read the original's bytes and probe its dimensions by media type. */
  private probe(context: UserServiceContext, row: CandidateRow): Promise<MediaDimensions | null> {
    if (row.content_type.startsWith(IMAGE_MIME_PREFIX)) {
      return this.fileService
        .getFileContent(context, row.key)
        .then((content) => this.mediaDimensionsService.fromImageBuffer(Buffer.from(content)));
    }

    return this.fileService
      .getFileStream(context, row.key)
      .then((stream) => this.mediaDimensionsService.fromVideoStream(stream));
  }

  /**
   * The next page of this user's locally-stored ORIGINAL image/video files that
   * have no recorded dimensions, after the keyset cursor. Ordered by id (cast to
   * text to match the keyset comparison) so paging is stable.
   */
  private selectCandidates(userId: string, after: string | null, pageSize: number): Promise<CandidateRow[]> {
    const query = this.fileRepository
      .createQueryBuilder('file')
      .select('CAST(file.id AS text)', 'id')
      .addSelect('file.key', 'key')
      .addSelect('file.contentType', 'content_type')
      .where('file.userId = :userId', { userId })
      .andWhere('file.variant = :variant', { variant: FileVariant.ORIGINAL })
      .andWhere('file.key IS NOT NULL')
      .andWhere('file.width IS NULL')
      .andWhere("(file.contentType LIKE 'image/%' OR file.contentType LIKE 'video/%')");

    if (after != null) {
      query.andWhere('CAST(file.id AS text) > :after', { after });
    }

    return query.orderBy('CAST(file.id AS text)', 'ASC').limit(pageSize).getRawMany<CandidateRow>();
  }
}
