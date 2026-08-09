import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import plimit, { type LimitFunction } from 'p-limit';
import { In, Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The files domain's PUBLIC barrel, not its internals: `no-cross-domain-internals`
// in `.dependency-cruiser.mjs` allows exactly `index.ts` and `events.ts` across a
// domain boundary. Everything this stage needs — the entity, the object-storage
// reader and the probe — is already exported there.
import {
  FileEntity,
  FileService,
  FileVariant,
  type MediaDimensions,
  MediaDimensionsService,
} from '@ci/domains/files';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { stageVersion } from '../../versions';

/**
 * Files probed at once. Each probe is an object-storage read plus a sharp /
 * ffprobe decode (video spools to a temp file), so keep the fan-out modest.
 *
 * Carried over unchanged from `MediaDimensionsBackfillListener`, which this
 * stage replaces. It is deliberately NOT the slice size: a slice is ~200 ids and
 * bounds RESUMABILITY, this bounds how much of the appliance's CPU and object
 * storage one slice may consume at any instant.
 */
const MAX_PROBE_CONCURRENCY = 4;

const IMAGE_MIME_PREFIX = 'image/';
const VIDEO_MIME_PREFIX = 'video/';

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * Read the predicate against what it replaced, because the difference is the
 * entire point of the conversion. `MediaDimensionsBackfillListener` selected on:
 *
 * ```sql
 *   file.variant = 'ORIGINAL' AND file.key IS NOT NULL AND file.width IS NULL
 *   AND (file.content_type LIKE 'image/%' OR file.content_type LIKE 'video/%')
 * ```
 *
 * `width IS NULL` is the defect. It conflates three different facts into one
 * column: "never probed", "probed and unreadable", and "probed successfully".
 * Two consequences follow and neither is fixable at the call site:
 *
 *  - **An unreadable file is retried forever.** A corrupt JPEG or a HEIC variant
 *    the bundled libheif cannot parse stays NULL, so every future run re-fetches
 *    it from object storage and re-decodes it, at ~18 % of the HEIC corpus, for
 *    as long as the appliance exists.
 *  - **A better probe cannot repair history.** The moment a row gets a width it
 *    leaves the candidate set permanently — so adding HEIC support, or fixing
 *    the EXIF-orientation swap, applies only to files that arrive afterwards.
 *
 * The predicate below therefore states only what a row IS — an original,
 * still-live, locally-stored image or video — and says nothing about whether the
 * stage has run. Whether it has run lives in `ci.pipeline_state`, where a probe
 * that legitimately produced nothing is recorded as `skipped: probe_failed` and
 * a bumped {@link STAGE_VERSIONS} entry brings the whole corpus back.
 *
 * `deleted_at IS NULL` is applicability, not completion: `ci.files` is
 * soft-deleted, and spending an object-storage read on a tombstone to record a
 * dimension nothing will ever display is pure cost.
 */
export const MEDIA_DIMENSIONS_SOURCE: StageSource = {
  schema: 'ci',
  table: 'files',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate:
    `s.variant = '${FileVariant.ORIGINAL}' ` +
    `AND s.deleted_at IS NULL ` +
    `AND s.key IS NOT NULL ` +
    `AND (s.content_type LIKE '${IMAGE_MIME_PREFIX}%' OR s.content_type LIKE '${VIDEO_MIME_PREFIX}%')`,
};

/**
 * The columns a probe needs. Narrowed explicitly because `ci.files` carries ~25
 * columns including parser output and EXIF-ish text blobs, and a slice loads 200
 * rows at a time.
 */
type CandidateRow = Pick<FileEntity, 'id' | 'key' | 'contentType'>;

/**
 * Records `ci.files.width` / `height` for ORIGINAL image and video files.
 *
 * The first leg converted onto the ledger, chosen because it is the smallest
 * one that still demonstrates the whole mechanism: no external provider, one
 * source table, and a failure mode (`width IS NULL`) that is the canonical
 * example of the defect the pipeline exists to delete. See
 * {@link MEDIA_DIMENSIONS_SOURCE} for what changed in candidate selection.
 *
 * ── What this class is, and is not ─────────────────────────────────────────
 *
 * It is the probing logic, lifted verbatim out of
 * `MediaDimensionsBackfillListener` and nothing else. There is no candidate
 * query here, no keyset cursor, no page loop, no batch counters, no pg-boss, no
 * retry policy and no `catch { log; continue }`. All of that moved to
 * `PipelineDispatchService` / `PipelineSliceListener` / `PipelineStateService`,
 * once, for every stage — which is what stops the fifteenth enricher from
 * inventing a fifteenth pagination strategy.
 *
 * ── Every id gets an answer ────────────────────────────────────────────────
 *
 * `run()` returns exactly one {@link StageResult} per id it was given, and every
 * non-`done` outcome carries a stable, greppable reason. That is the second
 * half of the fix. The listener's counters (`resolved` / `skipped` / `failed`)
 * were local variables that vanished with the job: nothing recorded WHICH file
 * was skipped or WHY, so "18.8k files, 2.1k still NULL" was the most anyone
 * could ever say. Now `GET /api/pipeline/state` groups by reason and the answer
 * is "1,940 probe_failed, 160 object_storage_read_failed", with the ids
 * attached.
 *
 * Reasons this stage emits:
 *
 *  - `source_row_missing` — the row vanished (or changed owner) between the
 *    sweep and the slice. Skipped, not failed: there is nothing to retry.
 *  - `no_object_key` — the row has no object-storage key, so there are no bytes
 *    to probe. The applicability predicate excludes these, so seeing one means
 *    the key was cleared mid-flight.
 *  - `unsupported_content_type` — not an image or a video. Same story: the
 *    predicate excludes it, so this only fires on a mid-flight mime change or a
 *    replayed dead letter carrying stale ids.
 *  - `probe_failed` — the bytes were read and the decoder produced no usable
 *    dimensions (corrupt file, unsupported codec, a HEIF box variant libheif
 *    cannot parse). **This is the row that used to stay NULL forever.** It is a
 *    skip, not a failure, because retrying the same bytes with the same decoder
 *    cannot produce a different answer — only a better decoder can, and that is
 *    a version bump.
 *  - `object_storage_read_failed` — Minio/S3 threw. A genuine FAILURE: the retry
 *    gate applies, the attempt count climbs, and a persistently unreachable
 *    object store shows up as a rising failure count instead of a flat one.
 *  - `dimension_write_failed` — the probe succeeded but the UPDATE did not.
 *    Failed, so it is retried; recorded separately from a read failure because
 *    the two have completely different causes.
 */
@Injectable()
export class MediaDimensionsStage implements Stage {
  readonly id = STAGE_IDS.ENRICH_MEDIA_DIMENSIONS;

  /**
   * Read from `STAGE_VERSIONS`, never hardcoded — `StageRegistry` rejects a
   * stage whose version disagrees with the declaration, because a hardcoded
   * version would make bumping the constant (the one re-processing lever this
   * subsystem provides) a silent no-op.
   */
  readonly version = stageVersion(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS);

  /**
   * `pipeline-enrich`: mixed local CPU (sharp/ffprobe) plus object-storage
   * reads. Isolated from `pipeline-embed` so a full-corpus re-probe cannot take
   * the worker slots Ollama-bound work needs.
   */
  readonly queue = PIPELINE_QUEUES.ENRICH;

  readonly entityTypes = ['file'] as const;

  readonly source = MEDIA_DIMENSIONS_SOURCE;

  private readonly limiter: LimitFunction = plimit(MAX_PROBE_CONCURRENCY);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly fileService: FileService,
    private readonly mediaDimensionsService: MediaDimensionsService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MediaDimensionsStage.name);
  }

  /**
   * Probe one slice of files.
   *
   * Idempotent, as the stage contract requires: probing twice reads the same
   * bytes and writes the same width/height, so two dispatchers racing over the
   * same id cost a duplicate object-storage read and nothing else.
   *
   * One load for the whole slice, then bounded-concurrency probes. The
   * per-id-load version of this is what made the old listener's cost scale with
   * round trips rather than with bytes.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    // Scoped to the slice's user even though the sweep already was. A slice can
    // arrive from a replayed dead letter written weeks ago, and re-scoping here
    // is the difference between "this id is not yours" and probing someone
    // else's file.
    const rows: CandidateRow[] = await this.fileRepository.find({
      where: { id: In(ids), userId: ctx.userId },
      select: { id: true, key: true, contentType: true },
    });

    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for the ids that came back with no row FIRST, so the map is
    // complete even if a probe throws in a way `probeOne` does not model.
    // `PipelineSliceListener` records anything missing as
    // `failed: stage_returned_no_result`, which is correct but uninformative —
    // this says what actually happened.
    for (const id of ids) {
      if (!byId.has(id)) {
        results.set(id, {
          outcome: 'skipped',
          reason: 'source_row_missing',
          detail: { stage: this.id },
        });
      }
    }

    await Promise.all(
      rows.map((row) =>
        this.limiter(async () => {
          results.set(row.id, await this.probeOne(ctx, row));
        }),
      ),
    );

    return results;
  }

  /**
   * One file: read its bytes, decode its dimensions, write them back.
   *
   * Never throws. Every path returns a {@link StageResult}, because a throw
   * would take the whole slice down with it — `PipelineSliceListener` fails
   * every claimed id with one shared reason — and one corrupt file must not
   * charge 199 healthy ones an attempt.
   */
  private async probeOne(ctx: UserServiceContext, row: CandidateRow): Promise<StageResult> {
    if (row.key == null) {
      return { outcome: 'skipped', reason: 'no_object_key' };
    }

    const isImage = row.contentType.startsWith(IMAGE_MIME_PREFIX);
    const isVideo = row.contentType.startsWith(VIDEO_MIME_PREFIX);

    if (!isImage && !isVideo) {
      return {
        outcome: 'skipped',
        reason: 'unsupported_content_type',
        detail: { contentType: row.contentType },
      };
    }

    let dimensions: MediaDimensions | null;

    try {
      dimensions = await this.probe(ctx, row.key, isImage);
    } catch (err: unknown) {
      // The decoders swallow their own errors and return null (see
      // MediaDimensionsService), so a throw that reaches here came from the
      // object-storage read. That is transient and worth retrying, which is
      // exactly what `failed` buys: a backoff gate on the row, an attempt
      // count, and quarantine once the budget is spent.
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn('Object storage read failed during dimension probe', {
        fileId: row.id,
        error: message,
      });

      return {
        outcome: 'failed',
        reason: 'object_storage_read_failed',
        detail: { message },
      };
    }

    if (dimensions == null) {
      // THE FIX, in five lines. Before the ledger this file was left with a NULL
      // width, which is indistinguishable from "not probed yet", so it came back
      // on every single run forever. Recorded as a skip WITH a reason it stops
      // costing anything — and a version bump (HEIC support, a new container)
      // re-selects it deliberately, which `width IS NULL` could never express.
      return { outcome: 'skipped', reason: 'probe_failed' };
    }

    try {
      await this.fileService.setDimensions(ctx, row.id, dimensions);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn('Failed to persist probed dimensions', { fileId: row.id, error: message });

      return {
        outcome: 'failed',
        reason: 'dimension_write_failed',
        detail: { message },
      };
    }

    // No `confidence`. A pixel dimension read from a file header is a
    // measurement, not an estimate, and fabricating a number here would teach
    // promotion to prefer it over something genuinely measured.
    return { outcome: 'done', detail: { width: dimensions.width, height: dimensions.height } };
  }

  /**
   * Read the original's bytes and probe its dimensions by media type.
   *
   * Images are decoded from a buffer (a header read is enough); videos are
   * streamed, because ffprobe needs a seekable local file and
   * {@link MediaDimensionsService.fromVideoStream} spools one rather than
   * holding a multi-gigabyte original in memory.
   */
  private probe(ctx: UserServiceContext, key: string, isImage: boolean): Promise<MediaDimensions | null> {
    if (isImage) {
      return this.fileService
        .getFileContent(ctx, key)
        .then((content) => this.mediaDimensionsService.fromImageBuffer(Buffer.from(content)));
    }

    return this.fileService
      .getFileStream(ctx, key)
      .then((stream) => this.mediaDimensionsService.fromVideoStream(stream));
  }
}
